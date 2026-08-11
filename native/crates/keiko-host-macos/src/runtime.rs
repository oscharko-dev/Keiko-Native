use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::sha256::sha256_copy;
#[cfg(test)]
use crate::sha256::{sha256_file, sha256_reader};
use crate::workspace::WorkspaceRuntimeBinding;
use crate::{AcceptedRequest, HostLifecycle, SenderContext};
use keiko_application::runtime::{
    CODEX_RUNTIME_SHA256, RuntimeReadinessState, RuntimeReadinessView,
};
use keiko_application::turn::{MAX_AGENT_TEXT_BYTES, TurnReason, TurnState};
use keiko_ui_port::{Operation, ReasonCode, encode_error, request_metadata, request_operation};
use serde_json::{Value, json};

const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_QUEUE_BYTES: usize = 4 * 1024 * 1024;
const MAX_QUEUE_FRAMES: usize = 256;
const MAX_STDERR_BYTES: usize = 1024 * 1024;
const MAX_QUARANTINED_EVENTS: u16 = 64;
const P_PID: i32 = 1;
const PROC_PIDTBSDINFO: i32 = 3;
const PROCESS_STATUS_ZOMBIE: u32 = 5;
const RLIMIT_NPROC: i32 = 7;
const SIGKILL: i32 = 9;
const SIGTERM: i32 = 15;
const WEXITED: i32 = 0x0000_0004;
const WNOHANG: i32 = 0x0000_0001;
const WNOWAIT: i32 = 0x0000_0020;
const MACOS_ECHILD: i32 = 10;
const MACOS_ESRCH: i32 = 3;
#[cfg(not(test))]
const PT_TRACE_ME: i32 = 0;
#[cfg(not(test))]
const PT_KILL: i32 = 8;
#[cfg(not(test))]
const PT_DETACH: i32 = 11;
#[cfg(not(test))]
const WUNTRACED: i32 = 0x0000_0002;
#[cfg(not(test))]
const CS_OPS_CDHASH: u32 = 5;
const SIGTRAP: i32 = 5;
// Kernel-reported CodeDirectory identity for the exact SHA-256-bound official
// @openai/codex 0.145.0 macOS arm64 artifact.
const CODEX_RUNTIME_CDHASH: [u8; 20] = [
    0xc9, 0xda, 0x02, 0x8e, 0x20, 0x80, 0xa6, 0x84, 0xd2, 0xc3, 0x55, 0xe6, 0xf4, 0x0f, 0xfc, 0x53,
    0xc2, 0x1f, 0xf7, 0xee,
];

const BINARY_ENV: &str = "KEIKO_CODEX_0_145_0_BINARY";
const HOME_ENV: &str = "KEIKO_CODEX_0_145_0_HOME";
const WORK_ROOT_ENV: &str = "KEIKO_CODEX_0_145_0_WORK_ROOT";
#[cfg(test)]
const CODEX_INSTALLATION_ID: &str = "installation_id";
const RUNTIME_OWNER_RECORD: &str = ".keiko-runtime-owner";
const RUNTIME_PROCESS_RECORD: &str = ".keiko-runtime-process";
const ORPHANED_RUNTIME_CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);
const STDIN_EOF_GRACE: Duration = Duration::from_millis(100);
const CANCEL_TERM_GRACE: Duration = Duration::from_millis(500);
const DESCENDANT_REAP_GRACE: Duration = Duration::from_millis(100);
// Preserve a bounded TERM/KILL window without starving macOS first-execution
// validation after the verified runtime has been staged.
const READINESS_CLEANUP_RESERVE: Duration = Duration::from_millis(300);
const READINESS_MAX_TERM_GRACE: Duration = Duration::from_millis(100);
const TURN_CLEANUP_RESERVE: Duration = Duration::from_secs(5);
const CODEX_CONTAINMENT_ARGUMENTS: &[&str] = &[
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.multi_agent_v2=false",
    "-c",
    "tools.experimental_request_user_input.enabled=false",
    "-c",
    "cli_auth_credentials_store=\"keyring\"",
    "-c",
    "model_provider=\"openai\"",
    "-c",
    "openai_base_url=\"\"",
    "-c",
    "history.persistence=\"none\"",
    "-c",
    "features.apps=false",
    "-c",
    "features.plugins=false",
    "-c",
    "features.remote_plugin=false",
    "-c",
    "features.plugin_sharing=false",
    "-c",
    "features.skill_search=false",
    "-c",
    "features.skill_mcp_dependency_install=false",
    "-c",
    "features.hooks=false",
    "-c",
    "features.browser_use=false",
    "-c",
    "features.browser_use_external=false",
    "-c",
    "features.browser_use_full_cdp_access=false",
    "-c",
    "features.in_app_browser=false",
    "-c",
    "features.computer_use=false",
    "-c",
    "features.image_generation=false",
    "-c",
    "features.workspace_dependencies=false",
    "-c",
    "features.tool_suggest=false",
    "app-server",
    "--listen",
    "stdio://",
];

unsafe extern "C" {
    #[link_name = "geteuid"]
    fn keiko_geteuid() -> u32;
    #[link_name = "kill"]
    fn keiko_kill(process_or_group: i32, signal: i32) -> i32;
    #[link_name = "proc_listpgrppids"]
    fn keiko_proc_listpgrppids(process_group: i32, buffer: *mut c_void, buffer_size: i32) -> i32;
    #[link_name = "proc_listchildpids"]
    fn keiko_proc_listchildpids(parent: i32, buffer: *mut c_void, buffer_size: i32) -> i32;
    #[link_name = "proc_pidinfo"]
    fn keiko_proc_pidinfo(
        process: i32,
        flavor: i32,
        argument: u64,
        buffer: *mut c_void,
        buffer_size: i32,
    ) -> i32;
    #[link_name = "waitid"]
    fn keiko_waitid(id_type: i32, id: u32, information: *mut WaitInformation, options: i32) -> i32;
    #[link_name = "setrlimit"]
    fn keiko_setrlimit(resource: i32, limit: *const ResourceLimit) -> i32;
    #[cfg(not(test))]
    #[link_name = "ptrace"]
    fn keiko_ptrace(request: i32, process: i32, address: *mut c_void, data: i32) -> i32;
    #[cfg(not(test))]
    #[link_name = "waitpid"]
    fn keiko_waitpid(process: i32, status: *mut i32, options: i32) -> i32;
    #[cfg(not(test))]
    #[link_name = "csops"]
    fn keiko_csops(process: i32, operation: u32, data: *mut c_void, size: usize) -> i32;
}

#[repr(C)]
#[derive(Default)]
struct WaitInformation {
    signal: i32,
    error: i32,
    code: i32,
    process_id: i32,
    reserved: [usize; 14],
}

#[repr(C)]
#[derive(Default)]
struct ProcessBsdInformation {
    flags: u32,
    status: u32,
    exit_status: u32,
    process_id: u32,
    parent_process_id: u32,
    user_id: u32,
    group_id: u32,
    real_user_id: u32,
    real_group_id: u32,
    saved_user_id: u32,
    saved_group_id: u32,
    reserved: u32,
    command: [i8; 16],
    name: [i8; 32],
    open_files: u32,
    process_group: u32,
    job_control_count: u32,
    controlling_device: u32,
    terminal_process_group: u32,
    nice: i32,
    started_seconds: u64,
    started_microseconds: u64,
}

#[repr(C)]
struct ResourceLimit {
    current: u64,
    maximum: u64,
}

#[derive(Clone, Debug)]
struct RuntimeConfiguration {
    binary: PathBuf,
    codex_home: PathBuf,
    work_root: PathBuf,
    expected_sha256: String,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct ProcessIdentity {
    process_id: i32,
    started_microseconds: u64,
    started_seconds: u64,
}

#[derive(Debug, Default)]
struct ActiveRuntime {
    process_group: Mutex<Option<ProcessIdentity>>,
    #[cfg(test)]
    process_group_observer: Mutex<Option<SyncSender<ProcessIdentity>>>,
    owned_processes: Mutex<HashSet<ProcessIdentity>>,
    retained_work_directories: Mutex<HashSet<PathBuf>>,
    control: Mutex<RuntimeControl>,
    finished: Condvar,
    #[cfg(test)]
    idle_waiting: AtomicBool,
    running: AtomicBool,
}

#[derive(Debug, Default)]
struct RuntimeControl {
    request_id: Option<String>,
    pending_request_id: Option<String>,
    cancellation: Option<RuntimeCancellation>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
enum RuntimeCancellation {
    User = 1,
    RendererLost = 2,
    AppShutdown = 3,
    ContainmentFailure = 4,
    WorkspaceChanged = 5,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RetainedProcessIdentityStatus {
    Current,
    Reused,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum KnownOwnedProcessStatus {
    Alive,
    Stopped,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessPresenceStatus {
    Present,
    Absent,
    Unavailable,
}

impl RuntimeCancellation {
    fn readiness_state(self) -> RuntimeReadinessState {
        match self {
            Self::ContainmentFailure => RuntimeReadinessState::ContainmentFailed,
            Self::User | Self::RendererLost | Self::AppShutdown | Self::WorkspaceChanged => {
                RuntimeReadinessState::Cancelled
            }
        }
    }

    fn turn_state(self) -> TurnState {
        match self {
            Self::ContainmentFailure => TurnState::ContainmentFailed,
            Self::WorkspaceChanged => TurnState::Failed,
            Self::User | Self::RendererLost | Self::AppShutdown => TurnState::Cancelled,
        }
    }

    fn turn_reason(self) -> TurnReason {
        match self {
            Self::User => TurnReason::UserCancelled,
            Self::RendererLost => TurnReason::RendererLost,
            Self::AppShutdown => TurnReason::AppShutdown,
            Self::ContainmentFailure => TurnReason::InternalFailure,
            Self::WorkspaceChanged => TurnReason::StaleWorkspace,
        }
    }
}

impl ActiveRuntime {
    #[cfg(test)]
    fn observe_next_process_group(&self) -> mpsc::Receiver<ProcessIdentity> {
        let (sender, receiver) = mpsc::sync_channel(1);
        *self
            .process_group_observer
            .lock()
            .expect("process-group observer") = Some(sender);
        receiver
    }

    #[cfg(test)]
    fn notify_process_group_observer(&self) {
        let identity = self.process_group.lock().ok().and_then(|group| *group);
        if let Some(identity) = identity
            && let Ok(mut observer) = self.process_group_observer.lock()
            && let Some(observer) = observer.take()
        {
            let _ = observer.send(identity);
        }
    }

    fn claim_request(&self, request_id: &str) -> bool {
        let Ok(process_group) = self.process_group.lock() else {
            return false;
        };
        if process_group.is_some()
            || self
                .running
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return false;
        }
        drop(process_group);
        if !reconcile_retained_work_directories(self) {
            self.running.store(false, Ordering::Release);
            self.finished.notify_all();
            return false;
        }
        self.begin_request(request_id)
    }

    fn begin_request(&self, request_id: &str) -> bool {
        let Ok(mut control) = self.control.lock() else {
            self.running.store(false, Ordering::Release);
            self.finished.notify_all();
            return false;
        };
        if control
            .pending_request_id
            .as_deref()
            .is_some_and(|pending| pending != request_id)
        {
            control.cancellation = None;
        }
        control.pending_request_id = None;
        control.request_id = Some(request_id.to_owned());
        true
    }

    fn finish_request(&self) {
        if let Ok(mut control) = self.control.lock() {
            *control = RuntimeControl::default();
            self.running.store(false, Ordering::Release);
        } else {
            self.running.store(false, Ordering::Release);
        }
        self.finished.notify_all();
    }

    fn cancel(&self, reason: RuntimeCancellation) {
        let Ok(mut control) = self.control.lock() else {
            return;
        };
        if self.running.load(Ordering::Acquire) && control.cancellation.is_none() {
            control.cancellation = Some(reason);
        }
    }

    fn cancellation(&self) -> Option<RuntimeCancellation> {
        self.control
            .lock()
            .map_or(Some(RuntimeCancellation::ContainmentFailure), |control| {
                control.cancellation
            })
    }

    fn cancellation_state(&self) -> Option<RuntimeReadinessState> {
        self.cancellation()
            .map(RuntimeCancellation::readiness_state)
    }

    fn wait_for_idle(&self, timeout: Duration) -> bool {
        let Ok(control) = self.control.lock() else {
            return false;
        };
        #[cfg(test)]
        self.idle_waiting.store(true, Ordering::Release);
        let wait = self
            .finished
            .wait_timeout_while(control, timeout, |_| self.running.load(Ordering::Acquire));
        #[cfg(test)]
        self.idle_waiting.store(false, Ordering::Release);
        let Ok((_control, _wait)) = wait else {
            return false;
        };
        !self.running.load(Ordering::Acquire)
    }
}

#[derive(Clone, Debug)]
pub struct RuntimeHost {
    configuration: Option<RuntimeConfiguration>,
    active: Arc<ActiveRuntime>,
    work_generation: Arc<AtomicU64>,
    invalidated_workspace_generation: Arc<AtomicU64>,
}

impl RuntimeHost {
    pub fn from_environment() -> Self {
        let configuration = match (
            std::env::var_os(BINARY_ENV),
            std::env::var_os(HOME_ENV),
            std::env::var_os(WORK_ROOT_ENV),
        ) {
            (Some(binary), Some(codex_home), Some(work_root)) => Some(RuntimeConfiguration {
                binary: binary.into(),
                codex_home: codex_home.into(),
                work_root: work_root.into(),
                expected_sha256: CODEX_RUNTIME_SHA256.to_owned(),
            }),
            _ => None,
        };
        Self::from_configuration(configuration)
    }

    fn from_configuration(configuration: Option<RuntimeConfiguration>) -> Self {
        let configuration = configuration.filter(reconcile_startup_configuration);
        Self {
            configuration,
            active: Arc::new(ActiveRuntime::default()),
            work_generation: Arc::new(AtomicU64::new(0)),
            invalidated_workspace_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn check(
        &self,
        request_id: &str,
        selected_workspace: Option<&Path>,
    ) -> RuntimeReadinessView {
        self.check_with_timeout(request_id, selected_workspace, DEFAULT_REQUEST_TIMEOUT)
    }

    fn check_with_timeout(
        &self,
        request_id: &str,
        selected_workspace: Option<&Path>,
        timeout: Duration,
    ) -> RuntimeReadinessView {
        let deadline = Instant::now() + timeout;
        if !self.active.claim_request(request_id) {
            return RuntimeReadinessView::terminal(RuntimeReadinessState::ContainmentFailed, 0);
        }
        let result = self.configuration.as_ref().map_or_else(
            || RuntimeReadinessView::terminal(RuntimeReadinessState::Unavailable, 0),
            |configuration| {
                perform_check(
                    configuration,
                    selected_workspace,
                    &self.active,
                    &self.work_generation,
                    deadline,
                )
            },
        );
        self.active.finish_request();
        result
    }

    pub fn cancel_request(&self, request_id: &str) {
        let mut accepted = false;
        if let Ok(mut control) = self.active.control.lock() {
            if self.active.running.load(Ordering::Acquire)
                && control.request_id.as_deref() == Some(request_id)
            {
                control
                    .cancellation
                    .get_or_insert(RuntimeCancellation::User);
                accepted = true;
            } else if control.request_id.is_none()
                && control
                    .pending_request_id
                    .as_deref()
                    .is_none_or(|pending| pending == request_id)
            {
                control.pending_request_id = Some(request_id.to_owned());
                control
                    .cancellation
                    .get_or_insert(RuntimeCancellation::User);
                accepted = true;
            }
        }
        if accepted {
            self.signal_active_process();
        }
    }

    pub fn cancel_for_renderer_loss(&self) {
        self.cancel_with_reason(RuntimeCancellation::RendererLost);
    }

    pub fn cancel_for_containment_failure(&self) {
        self.cancel_with_reason(RuntimeCancellation::ContainmentFailure);
    }

    pub fn cancel_for_app_shutdown(&self) {
        self.cancel_with_reason(RuntimeCancellation::AppShutdown);
    }

    pub fn cancel_for_app_shutdown_and_wait(&self) -> bool {
        self.cancel_and_wait(RuntimeCancellation::AppShutdown)
    }

    pub fn cancel_for_workspace_change_and_wait(&self, workspace_generation: u64) -> bool {
        self.invalidated_workspace_generation
            .fetch_max(workspace_generation, Ordering::AcqRel);
        self.cancel_and_wait(RuntimeCancellation::WorkspaceChanged)
    }

    fn cancel_and_wait(&self, reason: RuntimeCancellation) -> bool {
        let deadline = Instant::now() + TURN_CLEANUP_RESERVE;
        self.cancel_with_reason(reason);
        if !self
            .active
            .wait_for_idle(deadline.saturating_duration_since(Instant::now()))
        {
            return false;
        }
        reconcile_retained_process_group(&self.active, deadline)
            && reconcile_retained_work_directories(&self.active)
    }

    fn cancel_with_reason(&self, reason: RuntimeCancellation) {
        self.active.cancel(reason);
        self.signal_active_process();
    }

    fn signal_active_process(&self) {
        let process_group = self
            .active
            .process_group
            .lock()
            .ok()
            .and_then(|active| active.map(|identity| identity.process_id));
        if let Some(process_group) = process_group {
            signal_active_process_group(&self.active, process_group, SIGTERM);
        }
    }

    pub(crate) fn run_turn(
        &self,
        request_id: &str,
        workspace_generation: u64,
        selected_workspace: &WorkspaceRuntimeBinding,
        task: &str,
        timeout: Duration,
        mut update: impl FnMut(TurnRuntimeUpdate),
    ) -> TurnRuntimeOutcome {
        let deadline = Instant::now() + timeout;
        if !self.active.claim_request(request_id) {
            return TurnRuntimeOutcome::terminal(
                TurnState::ContainmentFailed,
                TurnReason::InternalFailure,
            );
        }
        if workspace_generation == 0
            || workspace_generation
                <= self
                    .invalidated_workspace_generation
                    .load(Ordering::Acquire)
        {
            self.active.finish_request();
            return TurnRuntimeOutcome::terminal(TurnState::Failed, TurnReason::StaleWorkspace);
        }
        if !selected_workspace.remains_current() {
            self.active.finish_request();
            return TurnRuntimeOutcome::terminal(TurnState::Failed, TurnReason::StaleWorkspace);
        }
        let result = self.configuration.as_ref().map_or_else(
            || TurnRuntimeOutcome::terminal(TurnState::Failed, TurnReason::RuntimeUnavailable),
            |configuration| {
                perform_turn(
                    configuration,
                    selected_workspace,
                    task,
                    &self.active,
                    &self.work_generation,
                    deadline,
                    &mut update,
                )
            },
        );
        self.active.finish_request();
        result
    }

    #[cfg(test)]
    fn for_test(
        binary: PathBuf,
        codex_home: PathBuf,
        work_root: PathBuf,
        expected_sha256: String,
    ) -> Self {
        Self {
            configuration: Some(RuntimeConfiguration {
                binary,
                codex_home,
                work_root,
                expected_sha256,
            }),
            active: Arc::new(ActiveRuntime::default()),
            work_generation: Arc::new(AtomicU64::new(0)),
            invalidated_workspace_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    #[cfg(test)]
    pub(crate) fn unavailable_for_test() -> Self {
        Self {
            configuration: None,
            active: Arc::new(ActiveRuntime::default()),
            work_generation: Arc::new(AtomicU64::new(0)),
            invalidated_workspace_generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TurnRuntimeUpdate {
    Stopping(TurnReason),
    StreamingStarted,
    AgentDelta(String),
    ProviderEventQuarantined,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnRuntimeOutcome {
    pub state: TurnState,
    pub reason: Option<TurnReason>,
    pub agent_text: String,
    pub provider_thread_established: bool,
    pub provider_turn_established: bool,
    pub quarantined_events: u16,
    pub repository_context_bytes_to_runtime: u64,
    pub cleaned: bool,
}

impl TurnRuntimeOutcome {
    fn terminal(state: TurnState, reason: TurnReason) -> Self {
        Self {
            state,
            reason: Some(reason),
            agent_text: String::new(),
            provider_thread_established: false,
            provider_turn_established: false,
            quarantined_events: 0,
            repository_context_bytes_to_runtime: 0,
            cleaned: true,
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct RuntimeRequestOutput {
    pub encoded: String,
}

pub fn runtime_request(
    lifecycle: &Mutex<HostLifecycle>,
    runtime: &RuntimeHost,
    sender: &SenderContext,
    selected_workspace: Option<&Path>,
    request: &str,
) -> RuntimeRequestOutput {
    let accepted = {
        let mut lifecycle = match lifecycle.lock() {
            Ok(lifecycle) => lifecycle,
            Err(_) => return failed("unknown-request", ReasonCode::InternalFailure),
        };
        match lifecycle.begin_application_request(sender, request.as_bytes()) {
            Ok(accepted) => accepted,
            Err((request_id, reason)) => return failed(&request_id, reason),
        }
    };
    if request_operation(&accepted.request) != &Operation::RuntimeReadiness {
        return finish_encoded(
            lifecycle,
            accepted,
            encode_error("unknown-request", ReasonCode::UnknownOperation),
        );
    }
    let (request_id, _, timeout_ms) = request_metadata(&accepted.request);
    let view = runtime.check_with_timeout(
        request_id,
        selected_workspace,
        Duration::from_millis(u64::from(timeout_ms)),
    );
    let encoded = lifecycle.lock().map_or_else(
        |_| encode_error("unknown-request", ReasonCode::InternalFailure),
        |mut lifecycle| lifecycle.complete_runtime_request(accepted, view),
    );
    RuntimeRequestOutput { encoded }
}

fn finish_encoded(
    lifecycle: &Mutex<HostLifecycle>,
    accepted: AcceptedRequest,
    encoded: String,
) -> RuntimeRequestOutput {
    let encoded = lifecycle.lock().map_or_else(
        |_| encode_error("unknown-request", ReasonCode::InternalFailure),
        |mut lifecycle| {
            lifecycle
                .complete_foundation_request(accepted, encoded, false)
                .encoded
        },
    );
    RuntimeRequestOutput { encoded }
}

fn failed(request_id: &str, reason: ReasonCode) -> RuntimeRequestOutput {
    RuntimeRequestOutput {
        encoded: encode_error(request_id, reason),
    }
}

fn perform_check(
    configuration: &RuntimeConfiguration,
    selected_workspace: Option<&Path>,
    active: &ActiveRuntime,
    work_generation: &AtomicU64,
    deadline: Instant,
) -> RuntimeReadinessView {
    let mut verified = match bind_configuration(configuration, selected_workspace) {
        Ok(verified) => verified,
        Err(state) => return RuntimeReadinessView::terminal(state, 0),
    };
    if let Some(state) = active.cancellation_state() {
        return RuntimeReadinessView::terminal(state, 0);
    }
    if Instant::now() >= deadline {
        return RuntimeReadinessView::terminal(RuntimeReadinessState::TimedOut, 0);
    }
    let Some(owner) = process_identity(std::process::id() as i32) else {
        return RuntimeReadinessView::terminal(RuntimeReadinessState::ContainmentFailed, 0);
    };
    let generation = work_generation.fetch_add(1, Ordering::AcqRel) + 1;
    let work_directory =
        verified
            .work_root
            .join(runtime_work_directory_name("readiness", owner, generation));
    if let Err(state) =
        create_private_readiness_directory(active, &work_directory, owner, generation)
    {
        return RuntimeReadinessView::terminal(state, 0);
    }
    let outcome = run_protocol(&mut verified, &work_directory, active, deadline);
    let work_cleaned = finalize_readiness_work(active, &work_directory, &outcome);
    if !outcome.cleaned || !work_cleaned {
        RuntimeReadinessView::terminal(
            RuntimeReadinessState::CleanupFailed,
            outcome.quarantined_events,
        )
    } else {
        RuntimeReadinessView::terminal(outcome.state, outcome.quarantined_events)
    }
}

fn finalize_readiness_work(
    active: &ActiveRuntime,
    work_directory: &Path,
    outcome: &ProtocolOutcome,
) -> bool {
    if outcome.cleaned {
        cleanup_or_retain_work_directory(active, work_directory)
    } else {
        retain_work_directory(active, work_directory);
        false
    }
}

fn perform_turn(
    configuration: &RuntimeConfiguration,
    selected_workspace: &WorkspaceRuntimeBinding,
    task: &str,
    active: &ActiveRuntime,
    work_generation: &AtomicU64,
    deadline: Instant,
    update: &mut dyn FnMut(TurnRuntimeUpdate),
) -> TurnRuntimeOutcome {
    if let Some(cancellation) = active.cancellation() {
        let state = cancellation.turn_state();
        let reason = cancellation.turn_reason();
        if state == TurnState::Cancelled {
            update(TurnRuntimeUpdate::Stopping(reason));
        }
        return TurnRuntimeOutcome::terminal(state, reason);
    }
    if Instant::now() >= deadline {
        return TurnRuntimeOutcome::terminal(TurnState::TimedOut, TurnReason::TimedOut);
    }
    if !selected_workspace.remains_current() {
        return TurnRuntimeOutcome::terminal(TurnState::Failed, TurnReason::StaleWorkspace);
    }
    let mut verified = match bind_configuration(configuration, Some(selected_workspace.path())) {
        Ok(verified) => verified,
        Err(RuntimeReadinessState::Unavailable) => {
            return TurnRuntimeOutcome::terminal(TurnState::Failed, TurnReason::RuntimeUnavailable);
        }
        Err(RuntimeReadinessState::Incompatible) => {
            return TurnRuntimeOutcome::terminal(
                TurnState::Failed,
                TurnReason::RuntimeIncompatible,
            );
        }
        Err(_) => {
            return TurnRuntimeOutcome::terminal(
                TurnState::ContainmentFailed,
                TurnReason::ProtocolRejected,
            );
        }
    };
    if !selected_workspace.remains_current() {
        return TurnRuntimeOutcome::terminal(TurnState::Failed, TurnReason::StaleWorkspace);
    }
    let Some(owner) = process_identity(std::process::id() as i32) else {
        return TurnRuntimeOutcome::terminal(
            TurnState::ContainmentFailed,
            TurnReason::ProtocolRejected,
        );
    };
    let generation = work_generation.fetch_add(1, Ordering::AcqRel) + 1;
    let work_directory = verified
        .work_root
        .join(runtime_work_directory_name("turn", owner, generation));
    if let Err(outcome) = create_private_turn_directory(active, &work_directory, owner, generation)
    {
        return outcome;
    }
    // Codex 0.145.0 derives its keyring account from the canonical CODEX_HOME
    // path. Keep the dedicated, human-provisioned profile path stable; transient
    // SQLite and turn state stay in the private work directory below.
    let mut outcome = run_turn_protocol(
        &mut verified,
        &work_directory,
        selected_workspace,
        task,
        active,
        deadline,
        update,
    );
    let work_cleaned = if outcome.cleaned {
        cleanup_or_retain_work_directory(active, &work_directory)
    } else {
        retain_work_directory(active, &work_directory);
        false
    };
    outcome.cleaned = outcome.cleaned && work_cleaned;
    if !outcome.cleaned {
        outcome.state = TurnState::CleanupFailed;
        outcome.reason = Some(TurnReason::CleanupFailed);
    }
    outcome
}

fn cleanup_or_retain_work_directory(active: &ActiveRuntime, path: &Path) -> bool {
    if fs::remove_dir_all(path).is_ok() {
        return true;
    }
    retain_work_directory(active, path);
    false
}

fn retain_work_directory(active: &ActiveRuntime, path: &Path) {
    let mut retained = active
        .retained_work_directories
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    retained.insert(path.to_path_buf());
}

fn reconcile_retained_work_directories(active: &ActiveRuntime) -> bool {
    let mut retained = active
        .retained_work_directories
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    retained.retain(|path| match fs::symlink_metadata(path) {
        Ok(_) => fs::remove_dir_all(path).is_err(),
        Err(error) => error.kind() != io::ErrorKind::NotFound,
    });
    retained.is_empty()
}

fn run_turn_protocol(
    configuration: &mut VerifiedConfiguration,
    work_directory: &Path,
    selected_workspace: &WorkspaceRuntimeBinding,
    task: &str,
    active: &ActiveRuntime,
    deadline: Instant,
    update: &mut dyn FnMut(TurnRuntimeUpdate),
) -> TurnRuntimeOutcome {
    let executable = match configuration.stage_verified_binary(work_directory) {
        Ok(executable) => executable,
        Err(RuntimeReadinessState::Unavailable | RuntimeReadinessState::Incompatible) => {
            return TurnRuntimeOutcome::terminal(
                TurnState::ContainmentFailed,
                TurnReason::RuntimeIncompatible,
            );
        }
        Err(_) => {
            return TurnRuntimeOutcome::terminal(
                TurnState::ContainmentFailed,
                TurnReason::ProtocolRejected,
            );
        }
    };
    let mut command = Command::new(executable.path());
    command
        .args(CODEX_CONTAINMENT_ARGUMENTS)
        .current_dir(work_directory)
        .env_clear()
        .env("CODEX_HOME", &configuration.codex_home)
        .env("CODEX_SQLITE_HOME", work_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = match spawn_verified_runtime(&mut command, work_directory) {
        Ok(child) => child,
        Err(error) => {
            return if error.kind() == io::ErrorKind::PermissionDenied {
                TurnRuntimeOutcome::terminal(
                    TurnState::ContainmentFailed,
                    TurnReason::ProtocolRejected,
                )
            } else {
                TurnRuntimeOutcome::terminal(TurnState::Failed, TurnReason::RuntimeUnavailable)
            };
        }
    };
    let process_group = child.id() as i32;
    if !publish_active_process_group(active, process_group) {
        let _ = child.kill();
        let _ = child.wait();
        return TurnRuntimeOutcome::terminal(
            TurnState::ContainmentFailed,
            TurnReason::ProtocolRejected,
        );
    }
    register_owned_process(active, process_group);
    let Some(((mut stdin, stdout), stderr)) = child
        .stdin
        .take()
        .zip(child.stdout.take())
        .zip(child.stderr.take())
    else {
        return cleanup_turn(
            child,
            process_group,
            TurnRuntimeOutcome::terminal(
                TurnState::ContainmentFailed,
                TurnReason::ProtocolRejected,
            ),
            active,
            deadline,
        );
    };
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let stderr_saturated = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = mpsc::sync_channel(MAX_QUEUE_FRAMES);
    spawn_stdout_reader(stdout, sender, Arc::clone(&queued_bytes));
    spawn_stderr_reader(stderr, Arc::clone(&stderr_saturated));
    let mut boundary_audit = RuntimeBoundaryAudit::new(selected_workspace.path());
    if boundary_audit
        .write_json_line(
            &mut stdin,
            &json!({
                "method": "initialize",
                "id": 1,
                "params": {
                    "clientInfo": {
                        "name": "keiko_native",
                        "title": "Keiko Native",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {"experimentalApi": true}
                }
            }),
        )
        .is_err()
    {
        return cleanup_turn(
            child,
            process_group,
            TurnRuntimeOutcome::terminal(
                TurnState::ContainmentFailed,
                TurnReason::ProtocolRejected,
            ),
            active,
            deadline,
        );
    }
    let mut projection = TurnProtocolProjection::new(&configuration.codex_home, work_directory);
    let remaining = deadline.saturating_duration_since(Instant::now());
    let cleanup_reserve = TURN_CLEANUP_RESERVE.min(remaining / 5);
    let protocol_deadline = deadline.checked_sub(cleanup_reserve).unwrap_or(deadline);
    let (state, reason) = loop {
        if !refresh_owned_processes(active) {
            break (TurnState::ContainmentFailed, TurnReason::InternalFailure);
        }
        if let Some(cancellation) = active.cancellation() {
            let state = cancellation.turn_state();
            let reason = cancellation.turn_reason();
            if state == TurnState::Cancelled {
                update(TurnRuntimeUpdate::Stopping(reason));
            }
            break (state, reason);
        }
        if stderr_saturated.load(Ordering::Acquire) {
            break (TurnState::ContainmentFailed, TurnReason::BufferLimit);
        }
        let now = Instant::now();
        if now >= protocol_deadline {
            break (TurnState::TimedOut, TurnReason::TimedOut);
        }
        match receiver.recv_timeout((protocol_deadline - now).min(Duration::from_millis(20))) {
            Ok(FrameEvent::Frame(frame)) => {
                queued_bytes.fetch_sub(frame.len(), Ordering::AcqRel);
                match projection.accept(&frame) {
                    TurnProjectionAction::Quarantine => {
                        update(TurnRuntimeUpdate::ProviderEventQuarantined);
                    }
                    TurnProjectionAction::SendAccountRead => {
                        if boundary_audit
                            .write_json_line(&mut stdin, &json!({"method":"initialized"}))
                            .is_err()
                            || boundary_audit
                                .write_json_line(
                                    &mut stdin,
                                    &json!({
                                        "method": "account/read",
                                        "id": 2,
                                        "params": {"refreshToken": false}
                                    }),
                                )
                                .is_err()
                        {
                            break (TurnState::ContainmentFailed, TurnReason::ProtocolRejected);
                        }
                        #[cfg(test)]
                        active.notify_process_group_observer();
                    }
                    TurnProjectionAction::SendThreadStart => {
                        let work = work_directory.to_string_lossy();
                        if boundary_audit
                            .write_json_line(
                                &mut stdin,
                                &json!({
                                    "method": "thread/start",
                                    "id": 3,
                                    "params": {
                                        "cwd": work,
                                        "runtimeWorkspaceRoots": [],
                                        "approvalPolicy": "never",
                                        "approvalsReviewer": "user",
                                        "sandbox": "read-only",
                                        "ephemeral": true,
                                        "environments": [],
                                        "dynamicTools": [],
                                        "selectedCapabilityRoots": [],
                                        "experimentalRawEvents": false
                                    }
                                }),
                            )
                            .is_err()
                        {
                            break (TurnState::ContainmentFailed, TurnReason::ProtocolRejected);
                        }
                    }
                    TurnProjectionAction::SendTurnStart(thread_id) => {
                        if !selected_workspace.remains_current() {
                            break (TurnState::Failed, TurnReason::StaleWorkspace);
                        }
                        if boundary_audit
                            .write_json_line(
                                &mut stdin,
                                &json!({
                                    "method": "turn/start",
                                    "id": 4,
                                    "params": {
                                        "threadId": thread_id,
                                        "input": [{
                                            "type": "text",
                                            "text": task,
                                            "text_elements": []
                                        }],
                                        "environments": [],
                                        "runtimeWorkspaceRoots": [],
                                        "approvalPolicy": "never",
                                        "approvalsReviewer": "user",
                                        "sandboxPolicy": {
                                            "type": "readOnly",
                                            "networkAccess": false
                                        }
                                    }
                                }),
                            )
                            .is_err()
                        {
                            break (TurnState::ContainmentFailed, TurnReason::ProtocolRejected);
                        }
                    }
                    TurnProjectionAction::StreamingStarted => {
                        update(TurnRuntimeUpdate::StreamingStarted);
                    }
                    TurnProjectionAction::AgentDelta(delta) => {
                        update(TurnRuntimeUpdate::AgentDelta(delta));
                    }
                    TurnProjectionAction::Complete => {
                        break (TurnState::Completed, TurnReason::InternalFailure);
                    }
                    TurnProjectionAction::Terminal(state, reason) => break (state, reason),
                }
            }
            Ok(FrameEvent::Rejected) => {
                break (TurnState::ContainmentFailed, TurnReason::BufferLimit);
            }
            Ok(FrameEvent::Eof) | Err(RecvTimeoutError::Disconnected) => {
                break if let Some(cancellation) = active.cancellation() {
                    let state = cancellation.turn_state();
                    let reason = cancellation.turn_reason();
                    if state == TurnState::Cancelled {
                        update(TurnRuntimeUpdate::Stopping(reason));
                    }
                    (state, reason)
                } else {
                    (TurnState::Failed, TurnReason::ProviderFailed)
                };
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    };
    drop(stdin);
    let mut outcome = TurnRuntimeOutcome {
        state,
        reason: (state != TurnState::Completed).then_some(reason),
        agent_text: projection.agent_text,
        provider_thread_established: projection.thread_id.is_some(),
        provider_turn_established: projection.turn_id.is_some(),
        quarantined_events: projection.quarantined_events,
        repository_context_bytes_to_runtime: boundary_audit.repository_context_bytes_to_runtime,
        cleaned: true,
    };
    if outcome.state == TurnState::Completed && outcome.agent_text.is_empty() {
        outcome.state = TurnState::ContainmentFailed;
        outcome.reason = Some(TurnReason::ProtocolRejected);
    }
    cleanup_turn(child, process_group, outcome, active, deadline)
}

fn cleanup_turn(
    mut child: Child,
    process_group: i32,
    mut outcome: TurnRuntimeOutcome,
    active: &ActiveRuntime,
    deadline: Instant,
) -> TurnRuntimeOutcome {
    let cleanup_deadline = deadline.min(Instant::now() + TURN_CLEANUP_RESERVE);
    outcome.cleaned = stop_process_group_with_term_grace(
        &mut child,
        process_group,
        active,
        cleanup_deadline,
        Some(CANCEL_TERM_GRACE),
        CleanupPhasePolicy::AllowParentReap,
    );
    outcome
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
    mode: u32,
    modified_nanoseconds: i64,
    modified_seconds: i64,
    size: u64,
}

impl FileIdentity {
    fn from_metadata(metadata: &Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            mode: metadata.mode(),
            modified_nanoseconds: metadata.mtime_nsec(),
            modified_seconds: metadata.mtime(),
            size: metadata.size(),
        }
    }
}

#[derive(Debug)]
struct VerifiedConfiguration {
    binary: PathBuf,
    binary_file: File,
    binary_identity: FileIdentity,
    codex_home: PathBuf,
    expected_sha256: String,
    work_root: PathBuf,
}

#[derive(Debug)]
struct VerifiedExecutable {
    path: PathBuf,
}

impl VerifiedExecutable {
    fn path(&self) -> &Path {
        &self.path
    }
}

impl VerifiedConfiguration {
    fn revalidate_binary_identity(&self) -> Result<(), RuntimeReadinessState> {
        let descriptor_metadata = self
            .binary_file
            .metadata()
            .map_err(|_| RuntimeReadinessState::Incompatible)?;
        if FileIdentity::from_metadata(&descriptor_metadata) != self.binary_identity
            || !descriptor_metadata.is_file()
            || descriptor_metadata.permissions().mode() & 0o111 == 0
        {
            return Err(RuntimeReadinessState::Incompatible);
        }
        let path_metadata =
            fs::symlink_metadata(&self.binary).map_err(|_| RuntimeReadinessState::Incompatible)?;
        if path_metadata.file_type().is_symlink()
            || FileIdentity::from_metadata(&path_metadata) != self.binary_identity
        {
            return Err(RuntimeReadinessState::Incompatible);
        }
        Ok(())
    }

    #[cfg(test)]
    fn revalidate_binary(&mut self) -> Result<(), RuntimeReadinessState> {
        self.revalidate_binary_identity()?;
        self.binary_file
            .seek(SeekFrom::Start(0))
            .map_err(|_| RuntimeReadinessState::Incompatible)?;
        let digest = sha256_reader(&mut self.binary_file)
            .map_err(|_| RuntimeReadinessState::Incompatible)?;
        if digest != self.expected_sha256 {
            return Err(RuntimeReadinessState::Incompatible);
        }
        Ok(())
    }

    fn stage_verified_binary(
        &mut self,
        work_directory: &Path,
    ) -> Result<VerifiedExecutable, RuntimeReadinessState> {
        self.revalidate_binary_identity()?;
        self.binary_file
            .seek(SeekFrom::Start(0))
            .map_err(|_| RuntimeReadinessState::Incompatible)?;
        let staged = work_directory.join("verified-codex-runtime");
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o500)
            .open(&staged)
            .map_err(|_| RuntimeReadinessState::ContainmentFailed)?;
        let staged_sha256 = sha256_copy(&mut self.binary_file, &mut output)
            .map_err(|_| RuntimeReadinessState::ContainmentFailed)?;
        output
            .sync_all()
            .map_err(|_| RuntimeReadinessState::ContainmentFailed)?;
        fs::set_permissions(&staged, fs::Permissions::from_mode(0o500))
            .map_err(|_| RuntimeReadinessState::ContainmentFailed)?;
        let staged_metadata = output
            .metadata()
            .map_err(|_| RuntimeReadinessState::ContainmentFailed)?;
        if staged_sha256 != self.expected_sha256 {
            return Err(RuntimeReadinessState::Incompatible);
        }
        if !staged_file_valid(&staged_metadata, &staged_sha256, &self.expected_sha256) {
            return Err(RuntimeReadinessState::ContainmentFailed);
        }
        Ok(VerifiedExecutable { path: staged })
    }
}

fn create_private_turn_directory(
    active: &ActiveRuntime,
    work_directory: &Path,
    owner: ProcessIdentity,
    generation: u64,
) -> Result<(), TurnRuntimeOutcome> {
    create_private_turn_directory_with(active, work_directory, owner, generation, |_| Ok(()))
}

fn create_private_turn_directory_with(
    active: &ActiveRuntime,
    work_directory: &Path,
    owner: ProcessIdentity,
    generation: u64,
    harden: fn(&Path) -> io::Result<()>,
) -> Result<(), TurnRuntimeOutcome> {
    match create_private_runtime_directory_with(work_directory, owner, generation, harden) {
        Ok(()) => Ok(()),
        Err(PrivateDirectoryFailure::Unavailable) => Err(TurnRuntimeOutcome::terminal(
            TurnState::Failed,
            TurnReason::RuntimeUnavailable,
        )),
        Err(PrivateDirectoryFailure::CleanupFailed) => {
            retain_work_directory(active, work_directory);
            let mut outcome =
                TurnRuntimeOutcome::terminal(TurnState::CleanupFailed, TurnReason::CleanupFailed);
            outcome.cleaned = false;
            Err(outcome)
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PrivateDirectoryFailure {
    Unavailable,
    CleanupFailed,
}

fn create_private_readiness_directory(
    active: &ActiveRuntime,
    work_directory: &Path,
    owner: ProcessIdentity,
    generation: u64,
) -> Result<(), RuntimeReadinessState> {
    match create_private_runtime_directory_with(work_directory, owner, generation, |_| Ok(())) {
        Ok(()) => Ok(()),
        Err(PrivateDirectoryFailure::Unavailable) => Err(RuntimeReadinessState::Unavailable),
        Err(PrivateDirectoryFailure::CleanupFailed) => {
            retain_work_directory(active, work_directory);
            Err(RuntimeReadinessState::CleanupFailed)
        }
    }
}

fn create_private_runtime_directory_with(
    work_directory: &Path,
    owner: ProcessIdentity,
    generation: u64,
    harden: fn(&Path) -> io::Result<()>,
) -> Result<(), PrivateDirectoryFailure> {
    create_private_directory_with(work_directory, harden)?;
    if write_runtime_owner_record(work_directory, owner, generation).is_ok() {
        return Ok(());
    }
    if fs::remove_dir_all(work_directory).is_ok() {
        Err(PrivateDirectoryFailure::Unavailable)
    } else {
        Err(PrivateDirectoryFailure::CleanupFailed)
    }
}

fn create_private_directory_with(
    work_directory: &Path,
    harden: fn(&Path) -> io::Result<()>,
) -> Result<(), PrivateDirectoryFailure> {
    let mut builder = fs::DirBuilder::new();
    builder.mode(0o700);
    if builder.create(work_directory).is_err() {
        return Err(PrivateDirectoryFailure::Unavailable);
    }
    if harden(work_directory).is_ok() && private_directory_is_owned(work_directory) {
        return Ok(());
    }
    if fs::remove_dir_all(work_directory).is_ok() {
        Err(PrivateDirectoryFailure::Unavailable)
    } else {
        Err(PrivateDirectoryFailure::CleanupFailed)
    }
}

fn private_directory_is_owned(work_directory: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(work_directory) else {
        return false;
    };
    metadata.is_dir()
        && metadata.permissions().mode() & 0o777 == 0o700
        // SAFETY: geteuid has no arguments or mutable memory effects.
        && metadata.uid() == unsafe { keiko_geteuid() }
}

#[cfg(test)]
fn spawn_verified_runtime(command: &mut Command, work_directory: &Path) -> io::Result<Child> {
    let mut child = command.spawn()?;
    if write_runtime_process_record(work_directory, child.id() as i32).is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runtime process ownership",
        ));
    }
    Ok(child)
}

#[cfg(not(test))]
fn spawn_verified_runtime(command: &mut Command, work_directory: &Path) -> io::Result<Child> {
    // SAFETY: the child makes only the async-signal-safe PT_TRACE_ME syscall
    // before exec. The kernel then stops it at the exec boundary, before the
    // selected image can execute its first instruction.
    unsafe {
        command.pre_exec(|| {
            deny_runtime_forks()?;
            if keiko_ptrace(PT_TRACE_ME, 0, std::ptr::null_mut(), 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    let process = child.id() as i32;
    let mut status = 0_i32;
    // SAFETY: waitpid observes only the direct child returned above and keeps
    // it stopped for validation rather than reaping it.
    let waited = unsafe { keiko_waitpid(process, &mut status, WUNTRACED) };
    let mut actual_cdhash = [0_u8; CODEX_RUNTIME_CDHASH.len()];
    let validated = waited == process
        && wait_status_is_exec_stop(status)
        // SAFETY: csops writes exactly the fixed CDHash buffer for the stopped
        // direct child. No provider code has run yet.
        && unsafe {
            keiko_csops(
                process,
                CS_OPS_CDHASH,
                actual_cdhash.as_mut_ptr().cast::<c_void>(),
                actual_cdhash.len(),
            )
        } == 0
        && actual_cdhash == CODEX_RUNTIME_CDHASH;
    if !validated {
        // SAFETY: PT_KILL applies only to the stopped direct child.
        unsafe {
            keiko_ptrace(PT_KILL, process, std::ptr::null_mut(), 0);
        }
        let _ = child.wait();
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runtime executable identity",
        ));
    }
    if write_runtime_process_record(work_directory, process).is_err() {
        // SAFETY: the exact direct child is still stopped at its authenticated
        // exec boundary, so it cannot outlive a failed ownership publication.
        unsafe {
            keiko_ptrace(PT_KILL, process, std::ptr::null_mut(), 0);
        }
        let _ = child.wait();
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runtime process ownership",
        ));
    }
    // SAFETY: address 1 requests continuation from the current instruction;
    // detaching releases only the validated direct child.
    if unsafe { keiko_ptrace(PT_DETACH, process, std::ptr::dangling_mut::<c_void>(), 0) } != 0 {
        unsafe {
            keiko_ptrace(PT_KILL, process, std::ptr::null_mut(), 0);
        }
        let _ = child.wait();
        return Err(io::Error::last_os_error());
    }
    Ok(child)
}

fn deny_runtime_forks() -> io::Result<()> {
    let limit = ResourceLimit {
        current: 0,
        maximum: 0,
    };
    // SAFETY: setrlimit reads the fixed local structure and applies the
    // irreversible per-process maximum only to this child before exec.
    if unsafe { keiko_setrlimit(RLIMIT_NPROC, &limit) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn wait_status_is_exec_stop(status: i32) -> bool {
    status & 0x7f == 0x7f && (status >> 8) & 0xff == SIGTRAP
}

fn staged_file_valid(metadata: &Metadata, digest: &str, expected_digest: &str) -> bool {
    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0 && digest == expected_digest
}

fn bind_configuration(
    configuration: &RuntimeConfiguration,
    selected_workspace: Option<&Path>,
) -> Result<VerifiedConfiguration, RuntimeReadinessState> {
    let binary = canonical_existing(&configuration.binary, false)?;
    let work_root = canonical_existing(&configuration.work_root, true)?;
    if !private_owned_directory(&work_root) || !protected_directory_chain(&work_root) {
        return Err(RuntimeReadinessState::ContainmentFailed);
    }
    recover_orphaned_runtime_directories(&work_root)?;
    let codex_home = canonical_existing(&configuration.codex_home, true)?;
    if !private_owned_directory(&codex_home) || !protected_directory_chain(&codex_home) {
        return Err(RuntimeReadinessState::ContainmentFailed);
    }
    if roots_overlap(&codex_home, &work_root)
        || selected_workspace.is_some_and(|workspace| {
            fs::canonicalize(workspace).ok().is_none_or(|workspace| {
                roots_overlap(&workspace, &binary)
                    || roots_overlap(&workspace, &codex_home)
                    || roots_overlap(&workspace, &work_root)
            })
        })
    {
        return Err(RuntimeReadinessState::ContainmentFailed);
    }
    let binary_file = File::open(&binary).map_err(|_| RuntimeReadinessState::Unavailable)?;
    let metadata = binary_file
        .metadata()
        .map_err(|_| RuntimeReadinessState::Unavailable)?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err(RuntimeReadinessState::Unavailable);
    }
    let verified = VerifiedConfiguration {
        binary,
        binary_file,
        binary_identity: FileIdentity::from_metadata(&metadata),
        codex_home,
        expected_sha256: configuration.expected_sha256.clone(),
        work_root,
    };
    Ok(verified)
}

fn reconcile_startup_configuration(configuration: &RuntimeConfiguration) -> bool {
    let Ok(work_root) = canonical_existing(&configuration.work_root, true) else {
        return false;
    };
    private_owned_directory(&work_root)
        && protected_directory_chain(&work_root)
        && recover_orphaned_runtime_directories(&work_root).is_ok()
}

fn effective_user_id() -> u32 {
    // SAFETY: geteuid has no arguments and no memory-safety preconditions.
    unsafe { keiko_geteuid() }
}

fn private_owned_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| private_owned_directory_metadata(&metadata, effective_user_id()))
}

fn private_owned_directory_metadata(metadata: &fs::Metadata, owner: u32) -> bool {
    metadata.is_dir() && metadata.uid() == owner && metadata.permissions().mode() & 0o777 == 0o700
}

fn recover_orphaned_runtime_directories(work_root: &Path) -> Result<(), RuntimeReadinessState> {
    for entry in fs::read_dir(work_root).map_err(|_| RuntimeReadinessState::ContainmentFailed)? {
        let entry = entry.map_err(|_| RuntimeReadinessState::ContainmentFailed)?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let owner = if name.starts_with("readiness-") {
            runtime_work_directory_identity(&entry.path(), "readiness")
        } else if name.starts_with("turn-") {
            runtime_work_directory_identity(&entry.path(), "turn")
        } else {
            continue;
        };
        let Some((owner, _generation)) = owner else {
            return Err(RuntimeReadinessState::ContainmentFailed);
        };
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|_| RuntimeReadinessState::ContainmentFailed)?;
        if !private_owned_directory_metadata(&metadata, effective_user_id()) {
            return Err(RuntimeReadinessState::ContainmentFailed);
        }
        if process_identity(owner.process_id) != Some(owner) {
            match fs::symlink_metadata(entry.path().join(RUNTIME_PROCESS_RECORD)) {
                Ok(_) => {
                    let Some(runtime) = runtime_process_record(&entry.path()) else {
                        return Err(RuntimeReadinessState::ContainmentFailed);
                    };
                    if process_identity(runtime.process_id) == Some(runtime)
                        && !reconcile_orphaned_runtime_process_group(runtime)
                    {
                        return Err(RuntimeReadinessState::ContainmentFailed);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => return Err(RuntimeReadinessState::ContainmentFailed),
            }
            if fs::remove_dir_all(entry.path()).is_err() {
                return Err(RuntimeReadinessState::ContainmentFailed);
            }
        }
    }
    Ok(())
}

fn runtime_work_directory_name(prefix: &str, owner: ProcessIdentity, generation: u64) -> String {
    // Keep the provider-facing work path short; the owned sidecar binds the full start identity.
    format!("{prefix}-{}-{generation}", owner.process_id)
}

fn runtime_work_directory_coordinates(name: &str, prefix: &str) -> Option<(i32, u64)> {
    let mut fields = name.strip_prefix(&format!("{prefix}-"))?.split('-');
    let process_id = fields.next()?.parse::<i32>().ok()?;
    let generation = fields.next()?.parse::<u64>().ok()?;
    if fields.next().is_some() || process_id <= 0 || generation == 0 {
        return None;
    }
    Some((process_id, generation))
}

fn write_runtime_owner_record(
    work_directory: &Path,
    owner: ProcessIdentity,
    generation: u64,
) -> io::Result<()> {
    let name = work_directory
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "runtime directory name"))?;
    let prefix = if name.starts_with("readiness-") {
        "readiness"
    } else if name.starts_with("turn-") {
        "turn"
    } else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime directory prefix",
        ));
    };
    if runtime_work_directory_coordinates(name, prefix) != Some((owner.process_id, generation)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime directory identity",
        ));
    }
    let record = format!(
        "{}:{}:{}:{generation}\n",
        owner.process_id, owner.started_seconds, owner.started_microseconds
    );
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(work_directory.join(RUNTIME_OWNER_RECORD))?;
    file.write_all(record.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

fn write_runtime_process_record(work_directory: &Path, process: i32) -> io::Result<()> {
    let information =
        process_information(process).ok_or_else(|| io::Error::other("runtime process identity"))?;
    let identity = identity_from_information(process, &information)
        .ok_or_else(|| io::Error::other("runtime process identity"))?;
    if information.process_group != process as u32 {
        return Err(io::Error::other("runtime process group"));
    }
    let record = format!(
        "{}:{}:{}\n",
        identity.process_id, identity.started_seconds, identity.started_microseconds
    );
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(work_directory.join(RUNTIME_PROCESS_RECORD))?;
    file.write_all(record.as_bytes())?;
    file.sync_all()
}

fn runtime_process_record(work_directory: &Path) -> Option<ProcessIdentity> {
    let record_path = work_directory.join(RUNTIME_PROCESS_RECORD);
    let path_metadata = fs::symlink_metadata(&record_path).ok()?;
    if !valid_runtime_owner_record_metadata(&path_metadata, effective_user_id()) {
        return None;
    }
    let mut file = File::open(record_path).ok()?;
    let file_metadata = file.metadata().ok()?;
    if FileIdentity::from_metadata(&path_metadata) != FileIdentity::from_metadata(&file_metadata) {
        return None;
    }
    let mut record = String::new();
    file.read_to_string(&mut record).ok()?;
    let mut fields = record.strip_suffix('\n')?.split(':');
    let process_id = fields.next()?.parse::<i32>().ok()?;
    let started_seconds = fields.next()?.parse::<u64>().ok()?;
    let started_microseconds = fields.next()?.parse::<u64>().ok()?;
    if fields.next().is_some()
        || process_id <= 0
        || started_seconds == 0
        || started_microseconds >= 1_000_000
    {
        return None;
    }
    Some(ProcessIdentity {
        process_id,
        started_microseconds,
        started_seconds,
    })
}

fn reconcile_orphaned_runtime_process_group(runtime: ProcessIdentity) -> bool {
    let Some(information) = process_information(runtime.process_id) else {
        return true;
    };
    if identity_from_information(runtime.process_id, &information) != Some(runtime)
        || information.process_group != runtime.process_id as u32
    {
        return false;
    }
    signal_process_group(runtime.process_id, SIGKILL);
    let deadline = Instant::now() + ORPHANED_RUNTIME_CLEANUP_TIMEOUT;
    while Instant::now() < deadline {
        if recovered_process_group_stopped(runtime) {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    recovered_process_group_stopped(runtime)
}

fn recovered_process_group_stopped(runtime: ProcessIdentity) -> bool {
    if process_identity(runtime.process_id) == Some(runtime) {
        return false;
    }
    !process_group_has_live_descendants(runtime.process_id, runtime.process_id)
        .unwrap_or_else(|_| process_group_exists(runtime.process_id))
}

fn valid_runtime_owner_record_metadata(metadata: &fs::Metadata, owner: u32) -> bool {
    metadata.is_file()
        && metadata.uid() == owner
        && metadata.permissions().mode() & 0o777 == 0o600
        && metadata.len() > 0
        && metadata.len() <= 128
}

fn runtime_work_directory_identity(
    work_directory: &Path,
    prefix: &str,
) -> Option<(ProcessIdentity, u64)> {
    let name = work_directory.file_name()?.to_str()?;
    let (named_process, named_generation) = runtime_work_directory_coordinates(name, prefix)?;
    let record_path = work_directory.join(RUNTIME_OWNER_RECORD);
    let path_metadata = fs::symlink_metadata(&record_path).ok()?;
    if !valid_runtime_owner_record_metadata(&path_metadata, effective_user_id()) {
        return None;
    }
    let mut file = File::open(record_path).ok()?;
    let file_metadata = file.metadata().ok()?;
    if FileIdentity::from_metadata(&path_metadata) != FileIdentity::from_metadata(&file_metadata) {
        return None;
    }
    let mut record = String::new();
    file.read_to_string(&mut record).ok()?;
    let record = record.strip_suffix('\n')?;
    let mut fields = record.split(':');
    let process_id = fields.next()?.parse::<i32>().ok()?;
    let started_seconds = fields.next()?.parse::<u64>().ok()?;
    let started_microseconds = fields.next()?.parse::<u64>().ok()?;
    let generation = fields.next()?.parse::<u64>().ok()?;
    if fields.next().is_some()
        || process_id != named_process
        || generation != named_generation
        || started_seconds == 0
        || started_microseconds >= 1_000_000
    {
        return None;
    }
    Some((
        ProcessIdentity {
            process_id,
            started_microseconds,
            started_seconds,
        },
        generation,
    ))
}

fn protected_directory_component(mode: u32, owner: u32, effective_user: u32) -> bool {
    mode & 0o022 == 0 || mode & 0o1000 != 0 && (owner == 0 || owner == effective_user)
}

fn protected_directory_chain(path: &Path) -> bool {
    let effective_user = effective_user_id();
    path.ancestors().all(|ancestor| {
        fs::symlink_metadata(ancestor).is_ok_and(|metadata| {
            let mode = metadata.permissions().mode();
            metadata.is_dir() && protected_directory_component(mode, metadata.uid(), effective_user)
        })
    })
}

fn canonical_existing(path: &Path, directory: bool) -> Result<PathBuf, RuntimeReadinessState> {
    if !path.is_absolute() {
        return Err(RuntimeReadinessState::ContainmentFailed);
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => RuntimeReadinessState::Unavailable,
        _ => RuntimeReadinessState::ContainmentFailed,
    })?;
    if metadata.file_type().is_symlink() || (directory && !metadata.is_dir()) {
        return Err(RuntimeReadinessState::ContainmentFailed);
    }
    let canonical = fs::canonicalize(path).map_err(|_| RuntimeReadinessState::Unavailable)?;
    if canonical != path {
        return Err(RuntimeReadinessState::ContainmentFailed);
    }
    Ok(canonical)
}

fn roots_overlap(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

#[derive(Debug)]
struct ProtocolOutcome {
    state: RuntimeReadinessState,
    quarantined_events: u16,
    cleaned: bool,
}

fn run_protocol(
    configuration: &mut VerifiedConfiguration,
    work_directory: &Path,
    active: &ActiveRuntime,
    deadline: Instant,
) -> ProtocolOutcome {
    let executable = match configuration.stage_verified_binary(work_directory) {
        Ok(executable) => executable,
        Err(state) => {
            return ProtocolOutcome {
                state,
                quarantined_events: 0,
                cleaned: true,
            };
        }
    };
    let mut command = Command::new(executable.path());
    command
        .args(CODEX_CONTAINMENT_ARGUMENTS)
        .current_dir(work_directory)
        .env_clear()
        .env("CODEX_HOME", &configuration.codex_home)
        .env("CODEX_SQLITE_HOME", work_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = match spawn_verified_runtime(&mut command, work_directory) {
        Ok(child) => child,
        Err(error) => {
            return ProtocolOutcome {
                state: if error.kind() == io::ErrorKind::PermissionDenied {
                    RuntimeReadinessState::ContainmentFailed
                } else {
                    RuntimeReadinessState::Unavailable
                },
                quarantined_events: 0,
                cleaned: true,
            };
        }
    };
    let process_group = child.id() as i32;
    if !publish_active_process_group(active, process_group) {
        let _ = child.kill();
        let _ = child.wait();
        return ProtocolOutcome {
            state: RuntimeReadinessState::ContainmentFailed,
            quarantined_events: 0,
            cleaned: true,
        };
    }
    register_owned_process(active, process_group);
    let Some(((mut stdin, stdout), stderr)) = child
        .stdin
        .take()
        .zip(child.stdout.take())
        .zip(child.stderr.take())
    else {
        return cleanup_after(
            child,
            process_group,
            RuntimeReadinessState::ContainmentFailed,
            0,
            active,
            deadline,
        );
    };
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let stderr_saturated = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = mpsc::sync_channel(MAX_QUEUE_FRAMES);
    spawn_stdout_reader(stdout, sender, Arc::clone(&queued_bytes));
    spawn_stderr_reader(stderr, Arc::clone(&stderr_saturated));
    if write_json_line(
        &mut stdin,
        &json!({
            "method": "initialize",
            "id": 1,
            "params": {
                "clientInfo": {
                    "name": "keiko_native",
                    "title": "Keiko Native",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {
                    "experimentalApi": true
                }
            }
        }),
    )
    .is_err()
    {
        return cleanup_after(
            child,
            process_group,
            RuntimeReadinessState::Incompatible,
            0,
            active,
            deadline,
        );
    }
    let mut projection = ProtocolProjection::new(&configuration.codex_home);
    let protocol_deadline = readiness_protocol_deadline(deadline, Instant::now());
    let state = loop {
        if !refresh_owned_processes(active) {
            break RuntimeReadinessState::ContainmentFailed;
        }
        if let Some(state) = active.cancellation_state() {
            break state;
        }
        if stderr_saturated.load(Ordering::Acquire) {
            break RuntimeReadinessState::ContainmentFailed;
        }
        let now = Instant::now();
        if now >= protocol_deadline {
            break RuntimeReadinessState::TimedOut;
        }
        match receiver.recv_timeout((protocol_deadline - now).min(Duration::from_millis(20))) {
            Ok(FrameEvent::Frame(frame)) => {
                queued_bytes.fetch_sub(frame.len(), Ordering::AcqRel);
                match projection.accept(&frame) {
                    ProjectionAction::Continue => {}
                    ProjectionAction::SendAccountRead => {
                        if write_json_line(&mut stdin, &json!({"method":"initialized"})).is_err()
                            || write_json_line(
                                &mut stdin,
                                &json!({
                                    "method": "account/read",
                                    "id": 2,
                                    "params": {"refreshToken": false}
                                }),
                            )
                            .is_err()
                        {
                            break RuntimeReadinessState::Incompatible;
                        }
                        #[cfg(test)]
                        active.notify_process_group_observer();
                    }
                    ProjectionAction::Terminal(state) => break state,
                }
            }
            Ok(FrameEvent::Rejected) => break RuntimeReadinessState::ContainmentFailed,
            Ok(FrameEvent::Eof) => {
                break active
                    .cancellation_state()
                    .unwrap_or(RuntimeReadinessState::Incompatible);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                break active
                    .cancellation_state()
                    .unwrap_or(RuntimeReadinessState::Incompatible);
            }
        }
    };
    drop(stdin);
    cleanup_after(
        child,
        process_group,
        state,
        projection.quarantined_events,
        active,
        deadline,
    )
}

fn readiness_protocol_deadline(deadline: Instant, protocol_started: Instant) -> Instant {
    let remaining = deadline.saturating_duration_since(protocol_started);
    let cleanup_reserve = READINESS_CLEANUP_RESERVE.min(remaining / 5);
    deadline.checked_sub(cleanup_reserve).unwrap_or(deadline)
}

fn readiness_term_grace(cleanup_remaining: Duration) -> Duration {
    READINESS_MAX_TERM_GRACE.min(cleanup_remaining / 3)
}

fn write_json_line(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

#[derive(Debug)]
struct RuntimeBoundaryAudit {
    repository_path_marker: Option<Vec<u8>>,
    repository_context_bytes_to_runtime: u64,
}

impl RuntimeBoundaryAudit {
    fn new(selected_workspace: &Path) -> Self {
        let repository_path_marker = selected_workspace
            .is_absolute()
            .then(|| selected_workspace.to_string_lossy().as_bytes().to_vec())
            .filter(|marker| !marker.is_empty());
        Self {
            repository_path_marker,
            repository_context_bytes_to_runtime: 0,
        }
    }

    fn write_json_line(&mut self, writer: &mut impl Write, value: &Value) -> io::Result<()> {
        let mut structural_value = value.clone();
        if structural_value.get("method").and_then(Value::as_str) == Some("turn/start")
            && let Some(inputs) = structural_value
                .pointer_mut("/params/input")
                .and_then(Value::as_array_mut)
        {
            for input in inputs {
                if let Some(text) = input.get_mut("text") {
                    *text = Value::String(String::new());
                }
            }
        }
        let leaked_bytes = repository_context_occurrences(
            &structural_value,
            self.repository_path_marker.as_deref(),
        ) as u64;
        if leaked_bytes > 0 {
            self.repository_context_bytes_to_runtime = self
                .repository_context_bytes_to_runtime
                .saturating_add(leaked_bytes);
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "repository context rejected at runtime boundary",
            ));
        }
        write_json_line(writer, value)
    }
}

fn repository_context_occurrences(value: &Value, path_marker: Option<&[u8]>) -> usize {
    match value {
        Value::String(text) => {
            let bytes = text.as_bytes();
            path_marker
                .map(|marker| count_byte_occurrences(bytes, marker) * marker.len())
                .unwrap_or_default()
        }
        Value::Array(values) => values
            .iter()
            .map(|entry| repository_context_occurrences(entry, path_marker))
            .sum(),
        Value::Object(object) => object
            .values()
            .map(|entry| repository_context_occurrences(entry, path_marker))
            .sum(),
        _ => 0,
    }
}

fn count_byte_occurrences(haystack: &[u8], needle: &[u8]) -> usize {
    if needle.is_empty() || needle.len() > haystack.len() {
        return 0;
    }
    haystack
        .windows(needle.len())
        .filter(|window| *window == needle)
        .count()
}

#[derive(Debug)]
enum FrameEvent {
    Frame(Vec<u8>),
    Rejected,
    Eof,
}

fn spawn_stdout_reader(
    stdout: impl Read + Send + 'static,
    sender: SyncSender<FrameEvent>,
    queued_bytes: Arc<AtomicUsize>,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_bounded_line(&mut reader) {
                Ok(Some(frame)) => {
                    let frame_bytes = frame.len();
                    let previous = queued_bytes.fetch_add(frame_bytes, Ordering::AcqRel);
                    if previous.saturating_add(frame_bytes) > MAX_QUEUE_BYTES {
                        queued_bytes.fetch_sub(frame_bytes, Ordering::AcqRel);
                        let _ = sender.send(FrameEvent::Rejected);
                        return;
                    }
                    if sender.send(FrameEvent::Frame(frame)).is_err() {
                        return;
                    }
                }
                Ok(None) => {
                    let _ = sender.send(FrameEvent::Eof);
                    return;
                }
                Err(_) => {
                    let _ = sender.send(FrameEvent::Rejected);
                    return;
                }
            }
        }
    });
}

fn read_bounded_line(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "unterminated protocol frame",
                ))
            };
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if frame.len().saturating_add(take) > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "protocol frame too large",
            ));
        }
        frame.extend_from_slice(&available[..take]);
        reader.consume(take);
        if frame.last() == Some(&b'\n') {
            frame.pop();
            if frame.last() == Some(&b'\r') {
                frame.pop();
            }
            return Ok(Some(frame));
        }
    }
}

fn spawn_stderr_reader(stderr: impl Read + Send + 'static, saturated: Arc<AtomicBool>) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut total = 0_usize;
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(read) => {
                    total = total.saturating_add(read);
                    if total > MAX_STDERR_BYTES {
                        saturated.store(true, Ordering::Release);
                    }
                }
            }
        }
    });
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProjectionStage {
    Initialize,
    Account,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProjectionAction {
    Continue,
    SendAccountRead,
    Terminal(RuntimeReadinessState),
}

struct ProtocolProjection<'a> {
    stage: ProjectionStage,
    codex_home: &'a Path,
    quarantined_events: u16,
}

impl<'a> ProtocolProjection<'a> {
    fn new(codex_home: &'a Path) -> Self {
        Self {
            stage: ProjectionStage::Initialize,
            codex_home,
            quarantined_events: 0,
        }
    }

    fn accept(&mut self, frame: &[u8]) -> ProjectionAction {
        let Ok(value) = serde_json::from_slice::<Value>(frame) else {
            return ProjectionAction::Terminal(RuntimeReadinessState::Incompatible);
        };
        let Some(object) = value.as_object() else {
            return ProjectionAction::Terminal(RuntimeReadinessState::Incompatible);
        };
        if object.contains_key("method") {
            return self.accept_provider_event(object);
        }
        match self.stage {
            ProjectionStage::Initialize => {
                if valid_initialize_response(object, self.codex_home) {
                    self.stage = ProjectionStage::Account;
                    ProjectionAction::SendAccountRead
                } else {
                    ProjectionAction::Terminal(RuntimeReadinessState::Incompatible)
                }
            }
            ProjectionStage::Account => account_state(object),
        }
    }

    fn accept_provider_event(
        &mut self,
        object: &serde_json::Map<String, Value>,
    ) -> ProjectionAction {
        if object.contains_key("id")
            || object
                .keys()
                .any(|key| !matches!(key.as_str(), "emittedAtMs" | "method" | "params"))
            || object
                .get("emittedAtMs")
                .is_some_and(|emitted_at| emitted_at.as_i64().is_none())
        {
            return ProjectionAction::Terminal(RuntimeReadinessState::ContainmentFailed);
        }
        let Some(method) = object.get("method").and_then(Value::as_str) else {
            return ProjectionAction::Terminal(RuntimeReadinessState::ContainmentFailed);
        };
        let inert_provider_state = matches!(
            method,
            "turn/plan/updated"
                | "thread/status/changed"
                | "item/agentMessage/delta"
                | "account/updated"
        ) || (method == "remoteControl/status/changed"
            && remote_control_is_disabled(object.get("params")));
        if !inert_provider_state || self.quarantined_events == MAX_QUARANTINED_EVENTS {
            return ProjectionAction::Terminal(RuntimeReadinessState::ContainmentFailed);
        }
        self.quarantined_events += 1;
        ProjectionAction::Continue
    }
}

fn remote_control_is_disabled(params: Option<&Value>) -> bool {
    let Some(params) = params.and_then(Value::as_object) else {
        return false;
    };
    if !matches!(params.len(), 3 | 4)
        || !params.contains_key("installationId")
        || !params.contains_key("serverName")
        || !params.contains_key("status")
        || params.keys().any(|key| {
            !matches!(
                key.as_str(),
                "environmentId" | "installationId" | "serverName" | "status"
            )
        })
    {
        return false;
    }
    params.get("installationId").is_some_and(Value::is_string)
        && params.get("serverName").is_some_and(Value::is_string)
        && params.get("status").and_then(Value::as_str) == Some("disabled")
        && params
            .get("environmentId")
            .is_none_or(|environment| environment.is_null() || environment.is_string())
}

fn valid_initialize_response(object: &serde_json::Map<String, Value>, codex_home: &Path) -> bool {
    if !has_exact_keys(object, &["id", "result"]) || object.get("id") != Some(&json!(1)) {
        return false;
    }
    let Some(result) = object.get("result").and_then(Value::as_object) else {
        return false;
    };
    has_exact_keys(
        result,
        &["codexHome", "platformFamily", "platformOs", "userAgent"],
    ) && result.get("codexHome").and_then(Value::as_str) == codex_home.to_str()
        && result.get("platformFamily").and_then(Value::as_str) == Some("unix")
        && result.get("platformOs").and_then(Value::as_str) == Some("macos")
        && result
            .get("userAgent")
            .and_then(Value::as_str)
            .is_some_and(|user_agent| !user_agent.is_empty() && user_agent.len() <= 256)
}

fn account_state(object: &serde_json::Map<String, Value>) -> ProjectionAction {
    if !has_exact_keys(object, &["id", "result"]) || object.get("id") != Some(&json!(2)) {
        return ProjectionAction::Terminal(RuntimeReadinessState::Incompatible);
    }
    let Some(result) = object.get("result").and_then(Value::as_object) else {
        return ProjectionAction::Terminal(RuntimeReadinessState::Incompatible);
    };
    if !has_exact_keys(result, &["account", "requiresOpenaiAuth"])
        || result.get("requiresOpenaiAuth") != Some(&Value::Bool(true))
    {
        return ProjectionAction::Terminal(RuntimeReadinessState::Incompatible);
    }
    let account = &result["account"];
    if account.is_null() {
        return ProjectionAction::Terminal(RuntimeReadinessState::AuthenticationRequired);
    }
    let Some(account) = account.as_object() else {
        return ProjectionAction::Terminal(RuntimeReadinessState::Incompatible);
    };
    if has_exact_keys(account, &["email", "planType", "type"])
        && account.get("type").and_then(Value::as_str) == Some("chatgpt")
        && account.get("email").is_some_and(Value::is_string)
        && account.get("planType").is_some_and(Value::is_string)
    {
        ProjectionAction::Terminal(RuntimeReadinessState::Ready)
    } else {
        ProjectionAction::Terminal(RuntimeReadinessState::Incompatible)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InertItemKind {
    UserMessage,
    AgentMessage,
    Reasoning,
    Plan,
}

impl InertItemKind {
    fn parse(value: Option<&Value>) -> Option<Self> {
        match value.and_then(Value::as_str) {
            Some("userMessage") => Some(Self::UserMessage),
            Some("agentMessage") => Some(Self::AgentMessage),
            Some("reasoning") => Some(Self::Reasoning),
            Some("plan") => Some(Self::Plan),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TurnProjectionStage {
    Initialize,
    Account,
    Thread,
    Turn,
    Active,
    Terminal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum TurnProjectionAction {
    Quarantine,
    SendAccountRead,
    SendThreadStart,
    SendTurnStart(String),
    StreamingStarted,
    AgentDelta(String),
    Complete,
    Terminal(TurnState, TurnReason),
}

struct TurnProtocolProjection<'a> {
    stage: TurnProjectionStage,
    codex_home: &'a Path,
    work_directory: &'a Path,
    thread_id: Option<String>,
    turn_id: Option<String>,
    streaming_announced: bool,
    agent_text: String,
    projected_agent_deltas: usize,
    quarantined_events: u16,
    started_items: HashMap<String, InertItemKind>,
    agent_message_text: HashMap<String, String>,
    completed_items: HashSet<String>,
}

impl<'a> TurnProtocolProjection<'a> {
    fn new(codex_home: &'a Path, work_directory: &'a Path) -> Self {
        Self {
            stage: TurnProjectionStage::Initialize,
            codex_home,
            work_directory,
            thread_id: None,
            turn_id: None,
            streaming_announced: false,
            agent_text: String::new(),
            projected_agent_deltas: 0,
            quarantined_events: 0,
            started_items: HashMap::new(),
            agent_message_text: HashMap::new(),
            completed_items: HashSet::new(),
        }
    }

    fn accept(&mut self, frame: &[u8]) -> TurnProjectionAction {
        let Ok(value) = serde_json::from_slice::<Value>(frame) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        let Some(object) = value.as_object() else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        if object.contains_key("method") {
            return self.accept_event(object);
        }
        match self.stage {
            TurnProjectionStage::Initialize => {
                if valid_initialize_response(object, self.codex_home) {
                    self.stage = TurnProjectionStage::Account;
                    TurnProjectionAction::SendAccountRead
                } else {
                    self.containment(TurnReason::ProtocolRejected)
                }
            }
            TurnProjectionStage::Account => match account_state(object) {
                ProjectionAction::Terminal(RuntimeReadinessState::Ready) => {
                    self.stage = TurnProjectionStage::Thread;
                    TurnProjectionAction::SendThreadStart
                }
                ProjectionAction::Terminal(RuntimeReadinessState::AuthenticationRequired) => {
                    TurnProjectionAction::Terminal(
                        TurnState::Failed,
                        TurnReason::AuthenticationRequired,
                    )
                }
                _ => self.containment(TurnReason::ProtocolRejected),
            },
            TurnProjectionStage::Thread => self.accept_thread_response(object),
            TurnProjectionStage::Turn => self.accept_turn_response(object),
            TurnProjectionStage::Active | TurnProjectionStage::Terminal => {
                self.containment(TurnReason::ProtocolRejected)
            }
        }
    }

    fn accept_thread_response(
        &mut self,
        object: &serde_json::Map<String, Value>,
    ) -> TurnProjectionAction {
        if !has_exact_keys(object, &["id", "result"]) || object.get("id") != Some(&json!(3)) {
            return self.containment(TurnReason::ProtocolRejected);
        }
        let Some(result) = object.get("result").and_then(Value::as_object) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        let Some(thread) = result.get("thread").and_then(Value::as_object) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        let Some(thread_id) = thread.get("id").and_then(Value::as_str) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        let work = self.work_directory.to_str();
        let safe = !thread_id.is_empty()
            && thread_id.len() <= 128
            && result
                .get("runtimeWorkspaceRoots")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
            && result
                .get("instructionSources")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
            && result.get("approvalPolicy").and_then(Value::as_str) == Some("never")
            && result.get("approvalsReviewer").and_then(Value::as_str) == Some("user")
            && result
                .get("activePermissionProfile")
                .is_some_and(Value::is_null)
            && result.get("multiAgentMode").and_then(Value::as_str) == Some("explicitRequestOnly")
            && result.get("cwd").and_then(Value::as_str) == work
            && thread.get("ephemeral") == Some(&Value::Bool(true))
            && thread.get("path").is_some_and(Value::is_null)
            && thread.get("gitInfo").is_some_and(Value::is_null)
            && thread.get("parentThreadId").is_some_and(Value::is_null)
            && thread.get("cwd").and_then(Value::as_str) == work
            && thread.get("canAcceptDirectInput") == Some(&Value::Bool(true));
        if !safe {
            return self.containment(TurnReason::EffectDenied);
        }
        self.thread_id = Some(thread_id.to_owned());
        self.stage = TurnProjectionStage::Turn;
        TurnProjectionAction::SendTurnStart(thread_id.to_owned())
    }

    fn accept_turn_response(
        &mut self,
        object: &serde_json::Map<String, Value>,
    ) -> TurnProjectionAction {
        if !has_exact_keys(object, &["id", "result"]) || object.get("id") != Some(&json!(4)) {
            return self.containment(TurnReason::ProtocolRejected);
        }
        let Some(turn) = object
            .get("result")
            .and_then(|result| result.get("turn"))
            .and_then(Value::as_object)
        else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        let Some(turn_id) = turn.get("id").and_then(Value::as_str) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        if turn_id.is_empty()
            || turn_id.len() > 128
            || turn.get("status").and_then(Value::as_str) != Some("inProgress")
            || self
                .turn_id
                .as_deref()
                .is_some_and(|known| known != turn_id)
        {
            return self.containment(TurnReason::ProtocolRejected);
        }
        self.turn_id = Some(turn_id.to_owned());
        self.stage = TurnProjectionStage::Active;
        self.streaming_action()
    }

    fn accept_event(&mut self, object: &serde_json::Map<String, Value>) -> TurnProjectionAction {
        if object.contains_key("id")
            || object
                .keys()
                .any(|key| !matches!(key.as_str(), "emittedAtMs" | "method" | "params"))
            || object
                .get("emittedAtMs")
                .is_some_and(|value| !value.is_i64() && !value.is_u64())
        {
            return self.containment(TurnReason::EffectDenied);
        }
        let Some(method) = object.get("method").and_then(Value::as_str) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        if matches!(
            method,
            "turn/started"
                | "item/started"
                | "item/completed"
                | "item/agentMessage/delta"
                | "turn/completed"
        ) && self.stage != TurnProjectionStage::Active
        {
            return self.containment(TurnReason::ProtocolRejected);
        }
        let params = object.get("params");
        match method {
            "remoteControl/status/changed" if remote_control_is_disabled(params) => {
                self.quarantine()
            }
            "thread/started" => self.quarantine_thread_event(params),
            "thread/status/changed" => self.quarantine_correlated_thread(params),
            "thread/tokenUsage/updated" => self.quarantine_correlated_turn(params),
            "account/rateLimits/updated" => self.quarantine(),
            "turn/started" => self.accept_turn_started(params),
            "item/started" => self.accept_item_event(params, true),
            "item/completed" => self.accept_item_event(params, false),
            "item/agentMessage/delta" => self.accept_delta(params),
            "turn/completed" => self.accept_turn_completed(params),
            _ => self.containment(TurnReason::EffectDenied),
        }
    }

    fn quarantine_thread_event(&mut self, params: Option<&Value>) -> TurnProjectionAction {
        let Some(thread_id) = self.thread_id.as_deref() else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        let Some(thread) = params
            .and_then(|params| params.get("thread"))
            .and_then(Value::as_object)
        else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        if Some(thread_id) == thread.get("id").and_then(Value::as_str) {
            self.quarantine()
        } else {
            self.containment(TurnReason::ProtocolRejected)
        }
    }

    fn quarantine_correlated_thread(&mut self, params: Option<&Value>) -> TurnProjectionAction {
        let Some(thread_id) = self.thread_id.as_deref() else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        if Some(thread_id)
            == params
                .and_then(|params| params.get("threadId"))
                .and_then(Value::as_str)
        {
            self.quarantine()
        } else {
            self.containment(TurnReason::ProtocolRejected)
        }
    }

    fn quarantine_correlated_turn(&mut self, params: Option<&Value>) -> TurnProjectionAction {
        let Some(params) = params.and_then(Value::as_object) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        if has_exact_keys(params, &["threadId", "turnId", "tokenUsage"])
            && token_usage_is_bounded(params.get("tokenUsage"))
            && self.correlations_match(params)
        {
            self.quarantine()
        } else {
            self.containment(TurnReason::ProtocolRejected)
        }
    }

    fn accept_turn_started(&mut self, params: Option<&Value>) -> TurnProjectionAction {
        let Some(params) = params.and_then(Value::as_object) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        let Some(turn) = params.get("turn").and_then(Value::as_object) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        let Some(turn_id) = turn.get("id").and_then(Value::as_str) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        if self.thread_id.as_deref() != params.get("threadId").and_then(Value::as_str)
            || turn.get("status").and_then(Value::as_str) != Some("inProgress")
            || self.turn_id.as_deref() != Some(turn_id)
        {
            return self.containment(TurnReason::ProtocolRejected);
        }
        self.turn_id = Some(turn_id.to_owned());
        self.streaming_action()
    }

    fn accept_item_event(&mut self, params: Option<&Value>, started: bool) -> TurnProjectionAction {
        let Some(params) = params.and_then(Value::as_object) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        if !self.correlations_match(params) {
            return self.containment(TurnReason::ProtocolRejected);
        }
        let Some(item) = params.get("item").and_then(Value::as_object) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        let Some(item_id) = item.get("id").and_then(Value::as_str) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        let Some(item_kind) = InertItemKind::parse(item.get("type")) else {
            return self.containment(TurnReason::EffectDenied);
        };
        if item_id.is_empty() || item_id.len() > 128 {
            return self.containment(TurnReason::EffectDenied);
        }
        if started {
            if self
                .started_items
                .insert(item_id.to_owned(), item_kind)
                .is_some()
            {
                return self.containment(TurnReason::ProtocolRejected);
            }
            if item_kind == InertItemKind::AgentMessage {
                self.agent_message_text
                    .insert(item_id.to_owned(), String::new());
            }
        } else if self.started_items.get(item_id) != Some(&item_kind)
            || (item_kind == InertItemKind::AgentMessage
                && item.get("text").and_then(Value::as_str)
                    != self.agent_message_text.get(item_id).map(String::as_str))
            || !self.completed_items.insert(item_id.to_owned())
        {
            return self.containment(TurnReason::ProtocolRejected);
        }
        self.quarantine()
    }

    fn accept_delta(&mut self, params: Option<&Value>) -> TurnProjectionAction {
        let Some(params) = params.and_then(Value::as_object) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        if !self.correlations_match(params) {
            return self.containment(TurnReason::ProtocolRejected);
        }
        let Some(item_id) = params.get("itemId").and_then(Value::as_str) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        let Some(delta) = params.get("delta").and_then(Value::as_str) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        if delta.is_empty()
            || self.started_items.get(item_id) != Some(&InertItemKind::AgentMessage)
            || self.completed_items.contains(item_id)
            || self.projected_agent_deltas >= MAX_QUEUE_FRAMES
            || self.agent_text.len().saturating_add(delta.len()) > MAX_AGENT_TEXT_BYTES
        {
            return self.containment(TurnReason::BufferLimit);
        }
        let Some(item_text) = self.agent_message_text.get_mut(item_id) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        item_text.push_str(delta);
        self.agent_text.push_str(delta);
        self.projected_agent_deltas += 1;
        TurnProjectionAction::AgentDelta(delta.to_owned())
    }

    fn accept_turn_completed(&mut self, params: Option<&Value>) -> TurnProjectionAction {
        let Some(params) = params.and_then(Value::as_object) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        let Some(turn) = params.get("turn").and_then(Value::as_object) else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        if self.thread_id.as_deref() != params.get("threadId").and_then(Value::as_str)
            || self.turn_id.as_deref() != turn.get("id").and_then(Value::as_str)
        {
            return self.containment(TurnReason::ProtocolRejected);
        }
        match turn.get("status").and_then(Value::as_str) {
            Some("completed")
                if turn.get("error").is_none_or(Value::is_null)
                    && self.started_items.len() == self.completed_items.len() =>
            {
                self.stage = TurnProjectionStage::Terminal;
                TurnProjectionAction::Complete
            }
            Some("failed" | "interrupted") => {
                TurnProjectionAction::Terminal(TurnState::Failed, TurnReason::ProviderFailed)
            }
            _ => self.containment(TurnReason::ProtocolRejected),
        }
    }

    fn correlations_match(&self, params: &serde_json::Map<String, Value>) -> bool {
        let (Some(thread_id), Some(turn_id)) = (self.thread_id.as_deref(), self.turn_id.as_deref())
        else {
            return false;
        };
        Some(thread_id) == params.get("threadId").and_then(Value::as_str)
            && Some(turn_id) == params.get("turnId").and_then(Value::as_str)
    }

    fn streaming_action(&mut self) -> TurnProjectionAction {
        if self.streaming_announced {
            self.quarantine()
        } else {
            self.streaming_announced = true;
            TurnProjectionAction::StreamingStarted
        }
    }

    fn quarantine(&mut self) -> TurnProjectionAction {
        let Some(count) = self.quarantined_events.checked_add(1) else {
            return self.containment(TurnReason::BufferLimit);
        };
        if count > MAX_QUARANTINED_EVENTS {
            return self.containment(TurnReason::BufferLimit);
        }
        self.quarantined_events = count;
        TurnProjectionAction::Quarantine
    }

    fn containment(&mut self, reason: TurnReason) -> TurnProjectionAction {
        self.stage = TurnProjectionStage::Terminal;
        TurnProjectionAction::Terminal(TurnState::ContainmentFailed, reason)
    }
}

fn has_exact_keys(object: &serde_json::Map<String, Value>, keys: &[&str]) -> bool {
    object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
}

fn token_usage_is_bounded(value: Option<&Value>) -> bool {
    let Some(usage) = value.and_then(Value::as_object) else {
        return false;
    };
    let valid_keys = usage
        .keys()
        .all(|key| matches!(key.as_str(), "last" | "modelContextWindow" | "total"));
    let valid_context_window = usage.get("modelContextWindow").is_none_or(|value| {
        value.is_null() || value.as_u64().is_some_and(|count| count <= i64::MAX as u64)
    });
    valid_keys
        && valid_context_window
        && token_usage_breakdown_is_bounded(usage.get("last"))
        && token_usage_breakdown_is_bounded(usage.get("total"))
}

fn token_usage_breakdown_is_bounded(value: Option<&Value>) -> bool {
    const REQUIRED: [&str; 5] = [
        "cachedInputTokens",
        "inputTokens",
        "outputTokens",
        "reasoningOutputTokens",
        "totalTokens",
    ];
    let Some(breakdown) = value.and_then(Value::as_object) else {
        return false;
    };
    let valid_keys = breakdown
        .keys()
        .all(|key| REQUIRED.contains(&key.as_str()) || key == "cacheWriteInputTokens");
    valid_keys
        && REQUIRED.iter().all(|key| {
            breakdown
                .get(*key)
                .and_then(Value::as_u64)
                .is_some_and(|count| count <= i64::MAX as u64)
        })
        && breakdown
            .get("cacheWriteInputTokens")
            .is_none_or(|value| value.as_u64().is_some_and(|count| count <= i64::MAX as u64))
}

fn cleanup_after(
    mut child: Child,
    process_group: i32,
    state: RuntimeReadinessState,
    quarantined_events: u16,
    active: &ActiveRuntime,
    deadline: Instant,
) -> ProtocolOutcome {
    let cleanup_remaining = deadline.saturating_duration_since(Instant::now());
    let cleaned = stop_process_group_with_term_grace(
        &mut child,
        process_group,
        active,
        deadline,
        Some(readiness_term_grace(cleanup_remaining)),
        CleanupPhasePolicy::PreserveFinalReconciliation,
    );
    ProtocolOutcome {
        state,
        quarantined_events,
        cleaned,
    }
}

#[cfg(test)]
fn stop_process_group(
    child: &mut Child,
    process_group: i32,
    active: &ActiveRuntime,
    deadline: Instant,
) -> bool {
    stop_process_group_with_term_grace(
        child,
        process_group,
        active,
        deadline,
        None,
        CleanupPhasePolicy::AllowParentReap,
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CleanupPhasePolicy {
    PreserveFinalReconciliation,
    AllowParentReap,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CleanupTerminal {
    Cleaned,
    Retained,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CleanupCommand {
    ObserveActiveIdentity {
        guard: Option<Instant>,
    },
    ObserveActiveIdentityStatus {
        guard: Option<Instant>,
        identity: ProcessIdentity,
    },
    ObserveChildExit {
        guard: Option<Instant>,
    },
    ObserveDescendants {
        guard: Option<Instant>,
    },
    ObserveOwnedDescendants {
        guard: Option<Instant>,
    },
    WaitChild {
        guard: Option<Instant>,
    },
    ObserveGroupPresence {
        guard: Option<Instant>,
    },
    ObserveOwnedStopped {
        guard: Option<Instant>,
    },
    RetireOwnership {
        guard: Option<Instant>,
        identity: ProcessIdentity,
    },
    Sleep {
        guard: Option<Instant>,
        duration: Duration,
    },
    SignalProcessGroup {
        guard: Option<Instant>,
        signal: i32,
    },
    RefreshOwned {
        guard: Option<Instant>,
    },
    SignalDescendants {
        guard: Option<Instant>,
        signal: i32,
    },
}

impl CleanupCommand {
    fn guard(self) -> Option<Instant> {
        match self {
            Self::ObserveActiveIdentity { guard }
            | Self::ObserveActiveIdentityStatus { guard, .. }
            | Self::ObserveChildExit { guard }
            | Self::ObserveDescendants { guard }
            | Self::ObserveOwnedDescendants { guard }
            | Self::WaitChild { guard }
            | Self::ObserveGroupPresence { guard }
            | Self::ObserveOwnedStopped { guard }
            | Self::RetireOwnership { guard, .. }
            | Self::Sleep { guard, .. }
            | Self::SignalProcessGroup { guard, .. }
            | Self::RefreshOwned { guard }
            | Self::SignalDescendants { guard, .. } => guard,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CleanupObservation {
    Begin {
        observed_at: Instant,
    },
    ActiveIdentity {
        started_at: Instant,
        completed_at: Instant,
        identity: Option<ProcessIdentity>,
    },
    ActiveIdentityStatus {
        started_at: Instant,
        completed_at: Instant,
        status: RetainedProcessIdentityStatus,
    },
    ChildExit {
        started_at: Instant,
        completed_at: Instant,
        exited: Option<bool>,
    },
    Descendants {
        started_at: Instant,
        completed_at: Instant,
        alive: Option<bool>,
    },
    OwnedDescendants {
        started_at: Instant,
        completed_at: Instant,
        alive: Option<bool>,
    },
    ChildWaited {
        started_at: Instant,
        completed_at: Instant,
        reaped: bool,
    },
    GroupPresence {
        started_at: Instant,
        completed_at: Instant,
        status: ProcessPresenceStatus,
    },
    OwnedStopped {
        started_at: Instant,
        completed_at: Instant,
        stopped: Option<bool>,
    },
    OwnershipRetired {
        started_at: Instant,
        completed_at: Instant,
        retired: bool,
    },
    Slept {
        started_at: Instant,
        completed_at: Instant,
    },
    ProcessGroupSignalled {
        started_at: Instant,
        completed_at: Instant,
        signal: i32,
    },
    OwnedRefreshed {
        started_at: Instant,
        completed_at: Instant,
        refreshed: bool,
    },
    DescendantsSignalled {
        started_at: Instant,
        completed_at: Instant,
        signal: i32,
        signalled: bool,
    },
    DeadlineClosed {
        closed_at: Instant,
    },
}

impl CleanupObservation {
    fn started_at(self) -> Instant {
        match self {
            Self::Begin { observed_at } => observed_at,
            Self::ActiveIdentity { started_at, .. }
            | Self::ActiveIdentityStatus { started_at, .. }
            | Self::ChildExit { started_at, .. }
            | Self::Descendants { started_at, .. }
            | Self::OwnedDescendants { started_at, .. }
            | Self::ChildWaited { started_at, .. }
            | Self::GroupPresence { started_at, .. }
            | Self::OwnedStopped { started_at, .. }
            | Self::OwnershipRetired { started_at, .. }
            | Self::Slept { started_at, .. }
            | Self::ProcessGroupSignalled { started_at, .. }
            | Self::OwnedRefreshed { started_at, .. }
            | Self::DescendantsSignalled { started_at, .. }
            | Self::DeadlineClosed {
                closed_at: started_at,
            } => started_at,
        }
    }

    fn completed_at(self) -> Instant {
        match self {
            Self::Begin { observed_at } => observed_at,
            Self::ActiveIdentity { completed_at, .. }
            | Self::ActiveIdentityStatus { completed_at, .. }
            | Self::ChildExit { completed_at, .. }
            | Self::Descendants { completed_at, .. }
            | Self::OwnedDescendants { completed_at, .. }
            | Self::ChildWaited { completed_at, .. }
            | Self::GroupPresence { completed_at, .. }
            | Self::OwnedStopped { completed_at, .. }
            | Self::OwnershipRetired { completed_at, .. }
            | Self::Slept { completed_at, .. }
            | Self::ProcessGroupSignalled { completed_at, .. }
            | Self::OwnedRefreshed { completed_at, .. }
            | Self::DescendantsSignalled { completed_at, .. }
            | Self::DeadlineClosed {
                closed_at: completed_at,
            } => completed_at,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CleanupProofStep {
    ActiveIdentity,
    ActiveIdentityStatus,
    ChildExit,
    Descendants,
    OwnedDescendants,
    WaitChild,
    GroupPresence,
    OwnedStopped,
    RetireOwnership,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct CleanupProof {
    identity: Option<ProcessIdentity>,
    child_exited: Option<bool>,
    descendants_alive: Option<bool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CleanupAfterPoll {
    SignalTerm,
    RefreshOwned,
    SignalGroupKill,
    FinalReconciliation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CleanupContinuation {
    Initial,
    Poll {
        phase_deadline: Instant,
        after: CleanupAfterPoll,
    },
    Final,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CleanupEffect {
    Sleep {
        phase_deadline: Instant,
        after: CleanupAfterPoll,
    },
    SignalTerm,
    RefreshOwned,
    SignalDescendants,
    SignalGroupKill,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CleanupController {
    policy: CleanupPhasePolicy,
    process_group: i32,
    deadline: Instant,
    cleanup_started: Instant,
    eof_grace: Duration,
    term_grace: Duration,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CleanupState {
    Initial {
        policy: CleanupPhasePolicy,
        process_group: i32,
        deadline: Instant,
        requested_term_grace: Option<Duration>,
    },
    Reconciling {
        controller: CleanupController,
        continuation: CleanupContinuation,
        step: CleanupProofStep,
        proof: CleanupProof,
    },
    AwaitingEffect {
        controller: CleanupController,
        effect: CleanupEffect,
    },
}

impl CleanupState {
    fn new(
        policy: CleanupPhasePolicy,
        process_group: i32,
        deadline: Instant,
        requested_term_grace: Option<Duration>,
    ) -> Self {
        Self::Initial {
            policy,
            process_group,
            deadline,
            requested_term_grace,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CleanupResult {
    Command {
        state: CleanupState,
        command: CleanupCommand,
    },
    Terminal(CleanupTerminal),
}

fn cleanup_guard(controller: CleanupController) -> Option<Instant> {
    (controller.policy == CleanupPhasePolicy::PreserveFinalReconciliation)
        .then_some(controller.deadline)
}

fn cleanup_observation_open(controller: CleanupController, observed_at: Instant) -> bool {
    controller.policy == CleanupPhasePolicy::AllowParentReap || observed_at < controller.deadline
}

fn cleanup_proof_command(
    controller: CleanupController,
    continuation: CleanupContinuation,
    step: CleanupProofStep,
    proof: CleanupProof,
) -> CleanupResult {
    let guard = cleanup_guard(controller);
    let command = match step {
        CleanupProofStep::ActiveIdentity => CleanupCommand::ObserveActiveIdentity { guard },
        CleanupProofStep::ActiveIdentityStatus => CleanupCommand::ObserveActiveIdentityStatus {
            guard,
            identity: proof
                .identity
                .expect("identity proof step requires an identity"),
        },
        CleanupProofStep::ChildExit => CleanupCommand::ObserveChildExit { guard },
        CleanupProofStep::Descendants => CleanupCommand::ObserveDescendants { guard },
        CleanupProofStep::OwnedDescendants => CleanupCommand::ObserveOwnedDescendants { guard },
        CleanupProofStep::WaitChild => CleanupCommand::WaitChild { guard },
        CleanupProofStep::GroupPresence => CleanupCommand::ObserveGroupPresence { guard },
        CleanupProofStep::OwnedStopped => CleanupCommand::ObserveOwnedStopped { guard },
        CleanupProofStep::RetireOwnership => CleanupCommand::RetireOwnership {
            guard,
            identity: proof.identity.expect("retirement requires an identity"),
        },
    };
    CleanupResult::Command {
        state: CleanupState::Reconciling {
            controller,
            continuation,
            step,
            proof,
        },
        command,
    }
}

fn start_cleanup_reconciliation(
    controller: CleanupController,
    continuation: CleanupContinuation,
    observed_at: Instant,
) -> CleanupResult {
    if !cleanup_observation_open(controller, observed_at) {
        return CleanupResult::Terminal(CleanupTerminal::Retained);
    }
    cleanup_proof_command(
        controller,
        continuation,
        CleanupProofStep::ActiveIdentity,
        CleanupProof::default(),
    )
}

fn cleanup_effect_command(
    controller: CleanupController,
    effect: CleanupEffect,
    observed_at: Instant,
) -> CleanupResult {
    if !cleanup_observation_open(controller, observed_at) {
        return CleanupResult::Terminal(CleanupTerminal::Retained);
    }
    let guard = match effect {
        CleanupEffect::Sleep { phase_deadline, .. }
            if controller.policy == CleanupPhasePolicy::PreserveFinalReconciliation =>
        {
            Some(controller.deadline.min(phase_deadline))
        }
        _ => cleanup_guard(controller),
    };
    let command = match effect {
        CleanupEffect::Sleep { .. } => CleanupCommand::Sleep {
            guard,
            duration: Duration::from_millis(10),
        },
        CleanupEffect::SignalTerm => CleanupCommand::SignalProcessGroup {
            guard,
            signal: SIGTERM,
        },
        CleanupEffect::RefreshOwned => CleanupCommand::RefreshOwned { guard },
        CleanupEffect::SignalDescendants => CleanupCommand::SignalDescendants {
            guard,
            signal: SIGKILL,
        },
        CleanupEffect::SignalGroupKill => CleanupCommand::SignalProcessGroup {
            guard,
            signal: SIGKILL,
        },
    };
    CleanupResult::Command {
        state: CleanupState::AwaitingEffect { controller, effect },
        command,
    }
}

fn cleanup_after_poll(
    controller: CleanupController,
    after: CleanupAfterPoll,
    observed_at: Instant,
) -> CleanupResult {
    match after {
        CleanupAfterPoll::SignalTerm => {
            cleanup_effect_command(controller, CleanupEffect::SignalTerm, observed_at)
        }
        CleanupAfterPoll::RefreshOwned => {
            cleanup_effect_command(controller, CleanupEffect::RefreshOwned, observed_at)
        }
        CleanupAfterPoll::SignalGroupKill => {
            cleanup_effect_command(controller, CleanupEffect::SignalGroupKill, observed_at)
        }
        CleanupAfterPoll::FinalReconciliation => {
            start_cleanup_reconciliation(controller, CleanupContinuation::Final, observed_at)
        }
    }
}

fn start_cleanup_poll(
    controller: CleanupController,
    phase_deadline: Instant,
    after: CleanupAfterPoll,
    observed_at: Instant,
) -> CleanupResult {
    if observed_at < phase_deadline {
        start_cleanup_reconciliation(
            controller,
            CleanupContinuation::Poll {
                phase_deadline,
                after,
            },
            observed_at,
        )
    } else {
        cleanup_after_poll(controller, after, observed_at)
    }
}

fn cleanup_reconciliation_failed(
    controller: CleanupController,
    continuation: CleanupContinuation,
    observed_at: Instant,
) -> CleanupResult {
    match continuation {
        CleanupContinuation::Initial => {
            let graceful_deadline = controller
                .deadline
                .min(controller.cleanup_started + controller.eof_grace);
            start_cleanup_poll(
                controller,
                graceful_deadline,
                CleanupAfterPoll::SignalTerm,
                observed_at,
            )
        }
        CleanupContinuation::Poll {
            phase_deadline,
            after,
        } if observed_at < phase_deadline
            || controller.policy == CleanupPhasePolicy::AllowParentReap =>
        {
            cleanup_effect_command(
                controller,
                CleanupEffect::Sleep {
                    phase_deadline,
                    after,
                },
                observed_at,
            )
        }
        CleanupContinuation::Poll { after, .. } => {
            cleanup_after_poll(controller, after, observed_at)
        }
        CleanupContinuation::Final => CleanupResult::Terminal(CleanupTerminal::Retained),
    }
}

fn reduce_cleanup_reconciliation(
    controller: CleanupController,
    continuation: CleanupContinuation,
    step: CleanupProofStep,
    mut proof: CleanupProof,
    observation: CleanupObservation,
) -> CleanupResult {
    if matches!(observation, CleanupObservation::DeadlineClosed { .. })
        || !cleanup_observation_open(controller, observation.started_at())
    {
        return CleanupResult::Terminal(CleanupTerminal::Retained);
    }
    if let (
        CleanupProofStep::RetireOwnership,
        CleanupObservation::OwnershipRetired { retired: true, .. },
    ) = (step, observation)
    {
        return CleanupResult::Terminal(CleanupTerminal::Cleaned);
    }
    if !cleanup_observation_open(controller, observation.completed_at()) {
        return CleanupResult::Terminal(CleanupTerminal::Retained);
    }
    let failed =
        || cleanup_reconciliation_failed(controller, continuation, observation.completed_at());
    let next = match (step, observation) {
        (
            CleanupProofStep::ActiveIdentity,
            CleanupObservation::ActiveIdentity {
                identity: Some(active_identity),
                ..
            },
        ) if active_identity.process_id == controller.process_group => {
            return cleanup_proof_command(
                controller,
                continuation,
                CleanupProofStep::ActiveIdentityStatus,
                CleanupProof {
                    identity: Some(active_identity),
                    ..CleanupProof::default()
                },
            );
        }
        (CleanupProofStep::ActiveIdentity, CleanupObservation::ActiveIdentity { .. }) => {
            return failed();
        }
        (
            CleanupProofStep::ActiveIdentityStatus,
            CleanupObservation::ActiveIdentityStatus {
                status: RetainedProcessIdentityStatus::Current,
                ..
            },
        ) => CleanupProofStep::ChildExit,
        (
            CleanupProofStep::ActiveIdentityStatus,
            CleanupObservation::ActiveIdentityStatus { .. },
        ) => return failed(),
        (CleanupProofStep::ChildExit, CleanupObservation::ChildExit { exited, .. }) => {
            proof.child_exited = exited;
            CleanupProofStep::Descendants
        }
        (CleanupProofStep::Descendants, CleanupObservation::Descendants { alive, .. }) => {
            proof.descendants_alive = alive;
            CleanupProofStep::OwnedDescendants
        }
        (
            CleanupProofStep::OwnedDescendants,
            CleanupObservation::OwnedDescendants {
                alive: Some(false), ..
            },
        ) if proof.child_exited == Some(true) && proof.descendants_alive == Some(false) => {
            CleanupProofStep::WaitChild
        }
        (CleanupProofStep::OwnedDescendants, CleanupObservation::OwnedDescendants { .. }) => {
            return failed();
        }
        (CleanupProofStep::WaitChild, CleanupObservation::ChildWaited { reaped: true, .. }) => {
            CleanupProofStep::GroupPresence
        }
        (CleanupProofStep::WaitChild, CleanupObservation::ChildWaited { .. }) => return failed(),
        (
            CleanupProofStep::GroupPresence,
            CleanupObservation::GroupPresence {
                status: ProcessPresenceStatus::Absent,
                ..
            },
        ) => CleanupProofStep::OwnedStopped,
        (CleanupProofStep::GroupPresence, CleanupObservation::GroupPresence { .. }) => {
            return failed();
        }
        (
            CleanupProofStep::OwnedStopped,
            CleanupObservation::OwnedStopped {
                stopped: Some(true),
                ..
            },
        ) => CleanupProofStep::RetireOwnership,
        (CleanupProofStep::OwnedStopped, CleanupObservation::OwnedStopped { .. }) => {
            return failed();
        }
        (CleanupProofStep::RetireOwnership, CleanupObservation::OwnershipRetired { .. }) => {
            return failed();
        }
        _ => return CleanupResult::Terminal(CleanupTerminal::Retained),
    };
    cleanup_proof_command(controller, continuation, next, proof)
}

fn reduce_cleanup_effect(
    controller: CleanupController,
    effect: CleanupEffect,
    observation: CleanupObservation,
) -> CleanupResult {
    if matches!(observation, CleanupObservation::DeadlineClosed { .. })
        || !cleanup_observation_open(controller, observation.started_at())
        || !cleanup_observation_open(controller, observation.completed_at())
    {
        return CleanupResult::Terminal(CleanupTerminal::Retained);
    }
    match (effect, observation) {
        (
            CleanupEffect::Sleep {
                phase_deadline,
                after,
            },
            CleanupObservation::Slept { completed_at, .. },
        ) => start_cleanup_poll(controller, phase_deadline, after, completed_at),
        (
            CleanupEffect::SignalTerm,
            CleanupObservation::ProcessGroupSignalled {
                completed_at,
                signal: SIGTERM,
                ..
            },
        ) => {
            let term_deadline = cleanup_term_deadline(
                controller.policy,
                controller.cleanup_started,
                completed_at,
                controller.deadline,
                controller.eof_grace,
                controller.term_grace,
            );
            start_cleanup_poll(
                controller,
                term_deadline,
                CleanupAfterPoll::RefreshOwned,
                completed_at,
            )
        }
        (CleanupEffect::RefreshOwned, CleanupObservation::OwnedRefreshed { completed_at, .. }) => {
            cleanup_effect_command(controller, CleanupEffect::SignalDescendants, completed_at)
        }
        (
            CleanupEffect::SignalDescendants,
            CleanupObservation::DescendantsSignalled {
                completed_at,
                signal: SIGKILL,
                signalled,
                ..
            },
        ) => {
            if signalled {
                let descendant_deadline =
                    descendant_reap_deadline(controller.policy, completed_at, controller.deadline);
                start_cleanup_poll(
                    controller,
                    descendant_deadline,
                    CleanupAfterPoll::SignalGroupKill,
                    completed_at,
                )
            } else {
                cleanup_effect_command(controller, CleanupEffect::SignalGroupKill, completed_at)
            }
        }
        (
            CleanupEffect::SignalGroupKill,
            CleanupObservation::ProcessGroupSignalled {
                completed_at,
                signal: SIGKILL,
                ..
            },
        ) => start_cleanup_poll(
            controller,
            controller.deadline,
            CleanupAfterPoll::FinalReconciliation,
            completed_at,
        ),
        _ => CleanupResult::Terminal(CleanupTerminal::Retained),
    }
}

fn cleanup_reduce(state: CleanupState, observation: CleanupObservation) -> CleanupResult {
    match state {
        CleanupState::Initial {
            policy,
            process_group,
            deadline,
            requested_term_grace,
        } => {
            let CleanupObservation::Begin { observed_at } = observation else {
                return CleanupResult::Terminal(CleanupTerminal::Retained);
            };
            let remaining = deadline.saturating_duration_since(observed_at);
            let controller = CleanupController {
                policy,
                process_group,
                deadline,
                cleanup_started: observed_at,
                eof_grace: STDIN_EOF_GRACE.min(remaining / 3),
                term_grace: cleanup_term_grace(policy, requested_term_grace, remaining),
            };
            start_cleanup_reconciliation(controller, CleanupContinuation::Initial, observed_at)
        }
        CleanupState::Reconciling {
            controller,
            continuation,
            step,
            proof,
        } => reduce_cleanup_reconciliation(controller, continuation, step, proof, observation),
        CleanupState::AwaitingEffect { controller, effect } => {
            reduce_cleanup_effect(controller, effect, observation)
        }
    }
}

fn descendant_reap_deadline(
    policy: CleanupPhasePolicy,
    descendant_started: Instant,
    deadline: Instant,
) -> Instant {
    match policy {
        CleanupPhasePolicy::PreserveFinalReconciliation => descendant_started,
        CleanupPhasePolicy::AllowParentReap => {
            let descendant_grace = DESCENDANT_REAP_GRACE
                .min(deadline.saturating_duration_since(descendant_started) / 2);
            deadline.min(descendant_started + descendant_grace)
        }
    }
}

fn cleanup_term_deadline(
    policy: CleanupPhasePolicy,
    cleanup_started: Instant,
    observed_after_eof: Instant,
    deadline: Instant,
    eof_grace: Duration,
    term_grace: Duration,
) -> Instant {
    match policy {
        CleanupPhasePolicy::PreserveFinalReconciliation => {
            deadline.min(cleanup_started + eof_grace + term_grace)
        }
        CleanupPhasePolicy::AllowParentReap => deadline.min(observed_after_eof + term_grace),
    }
}

fn cleanup_term_grace(
    policy: CleanupPhasePolicy,
    requested: Option<Duration>,
    remaining: Duration,
) -> Duration {
    let proportional_grace = remaining / 3;
    match policy {
        CleanupPhasePolicy::PreserveFinalReconciliation => requested
            .unwrap_or(proportional_grace)
            .min(proportional_grace),
        CleanupPhasePolicy::AllowParentReap => requested.unwrap_or(proportional_grace),
    }
}

struct RealCleanupExecutor<'a> {
    child: &'a mut Child,
    process_group: i32,
    active: &'a ActiveRuntime,
}

impl RealCleanupExecutor<'_> {
    fn execute(&mut self, command: CleanupCommand) -> CleanupObservation {
        let started_at = Instant::now();
        if command
            .guard()
            .is_some_and(|deadline| started_at >= deadline)
        {
            return CleanupObservation::DeadlineClosed {
                closed_at: started_at,
            };
        }
        match command {
            CleanupCommand::ObserveActiveIdentity { .. } => {
                let identity = self
                    .active
                    .process_group
                    .lock()
                    .ok()
                    .and_then(|group| *group);
                CleanupObservation::ActiveIdentity {
                    started_at,
                    completed_at: Instant::now(),
                    identity,
                }
            }
            CleanupCommand::ObserveActiveIdentityStatus { identity, .. } => {
                let status = retained_process_identity_status(identity);
                CleanupObservation::ActiveIdentityStatus {
                    started_at,
                    completed_at: Instant::now(),
                    status,
                }
            }
            CleanupCommand::ObserveChildExit { .. } => {
                let exited = child_exited_without_reaping(self.child.id() as i32).ok();
                CleanupObservation::ChildExit {
                    started_at,
                    completed_at: Instant::now(),
                    exited,
                }
            }
            CleanupCommand::ObserveDescendants { .. } => {
                let alive =
                    process_group_has_descendants(self.process_group, self.child.id() as i32).ok();
                CleanupObservation::Descendants {
                    started_at,
                    completed_at: Instant::now(),
                    alive,
                }
            }
            CleanupCommand::ObserveOwnedDescendants { .. } => {
                let alive = owned_descendants_alive(self.active, self.child.id() as i32);
                CleanupObservation::OwnedDescendants {
                    started_at,
                    completed_at: Instant::now(),
                    alive,
                }
            }
            CleanupCommand::WaitChild { .. } => {
                let reaped = self.child.wait().is_ok();
                CleanupObservation::ChildWaited {
                    started_at,
                    completed_at: Instant::now(),
                    reaped,
                }
            }
            CleanupCommand::ObserveGroupPresence { .. } => {
                let status = process_group_presence(self.process_group);
                CleanupObservation::GroupPresence {
                    started_at,
                    completed_at: Instant::now(),
                    status,
                }
            }
            CleanupCommand::ObserveOwnedStopped { .. } => {
                let stopped = authenticated_owned_processes_status(self.active);
                CleanupObservation::OwnedStopped {
                    started_at,
                    completed_at: Instant::now(),
                    stopped,
                }
            }
            CleanupCommand::RetireOwnership { identity, .. } => {
                let retired = retire_active_process_group(self.active, identity);
                CleanupObservation::OwnershipRetired {
                    started_at,
                    completed_at: Instant::now(),
                    retired,
                }
            }
            CleanupCommand::Sleep { duration, .. } => {
                thread::sleep(duration);
                CleanupObservation::Slept {
                    started_at,
                    completed_at: Instant::now(),
                }
            }
            CleanupCommand::SignalProcessGroup { signal, .. } => {
                let _ = signal_active_process_group(self.active, self.process_group, signal);
                CleanupObservation::ProcessGroupSignalled {
                    started_at,
                    completed_at: Instant::now(),
                    signal,
                }
            }
            CleanupCommand::RefreshOwned { .. } => {
                let refreshed = refresh_owned_processes(self.active);
                CleanupObservation::OwnedRefreshed {
                    started_at,
                    completed_at: Instant::now(),
                    refreshed,
                }
            }
            CleanupCommand::SignalDescendants { signal, .. } => {
                let signalled = signal_active_descendants(self.active, self.process_group, signal);
                CleanupObservation::DescendantsSignalled {
                    started_at,
                    completed_at: Instant::now(),
                    signal,
                    signalled,
                }
            }
        }
    }
}

fn drive_real_cleanup(executor: &mut RealCleanupExecutor<'_>, mut result: CleanupResult) -> bool {
    loop {
        result = match result {
            CleanupResult::Command { state, command } => {
                cleanup_reduce(state, executor.execute(command))
            }
            CleanupResult::Terminal(terminal) => return terminal == CleanupTerminal::Cleaned,
        };
    }
}

fn stop_process_group_with_term_grace(
    child: &mut Child,
    process_group: i32,
    active: &ActiveRuntime,
    deadline: Instant,
    term_grace: Option<Duration>,
    cleanup_phase_policy: CleanupPhasePolicy,
) -> bool {
    let mut executor = RealCleanupExecutor {
        child,
        process_group,
        active,
    };
    let state = CleanupState::new(cleanup_phase_policy, process_group, deadline, term_grace);
    drive_real_cleanup(
        &mut executor,
        cleanup_reduce(
            state,
            CleanupObservation::Begin {
                observed_at: Instant::now(),
            },
        ),
    )
}

fn authenticated_owned_processes_stopped(active: &ActiveRuntime) -> bool {
    authenticated_owned_processes_status(active) == Some(true)
}

fn authenticated_owned_processes_status(active: &ActiveRuntime) -> Option<bool> {
    let mut owned = active.owned_processes.lock().ok()?;
    retain_unstopped_known_owned_processes(&mut owned).then_some(owned.is_empty())
}

fn retain_unstopped_known_owned_processes(owned: &mut HashSet<ProcessIdentity>) -> bool {
    let mut observations_available = true;
    owned.retain(|identity| match known_owned_process_status(*identity) {
        KnownOwnedProcessStatus::Alive => true,
        KnownOwnedProcessStatus::Stopped => false,
        KnownOwnedProcessStatus::Unavailable => {
            observations_available = false;
            true
        }
    });
    observations_available
}

fn reconcile_retained_process_group(active: &ActiveRuntime, deadline: Instant) -> bool {
    let Some(process_group) = active
        .process_group
        .lock()
        .ok()
        .and_then(|group| group.map(|identity| identity.process_id))
    else {
        return true;
    };
    let _ = refresh_owned_processes(active);
    signal_active_process_group(active, process_group, SIGTERM);
    let term_deadline = deadline.min(Instant::now() + CANCEL_TERM_GRACE);
    while Instant::now() < term_deadline {
        if retire_retained_process_group_if_stopped(active, process_group) {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    signal_active_process_group(active, process_group, SIGKILL);
    while Instant::now() < deadline {
        if retire_retained_process_group_if_stopped(active, process_group) {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    retire_retained_process_group_if_stopped(active, process_group)
}

fn retire_retained_process_group_if_stopped(active: &ActiveRuntime, process_group: i32) -> bool {
    let active_identity = active.process_group.lock().ok().and_then(|group| *group);
    let Some(active_identity) = active_identity else {
        return true;
    };
    if active_identity.process_id != process_group {
        return true;
    }
    let _ = refresh_owned_processes(active);
    let owned_alive = !authenticated_owned_processes_stopped(active);
    let Ok(descendants_alive) = process_group_has_descendants(process_group, process_group) else {
        return false;
    };
    let child_state = retained_child_reap_state(process_group);
    if owned_alive || descendants_alive {
        return false;
    }
    match child_state {
        RetainedChildReapState::ExitedNeedsReap if !reap_child(process_group) => return false,
        RetainedChildReapState::ExitedNeedsReap | RetainedChildReapState::AlreadyReaped => {}
        RetainedChildReapState::Live | RetainedChildReapState::Unavailable => return false,
    }
    if process_group_presence(process_group) != ProcessPresenceStatus::Absent
        || !authenticated_owned_processes_stopped(active)
    {
        return false;
    }
    retire_active_process_group(active, active_identity)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RetainedChildReapState {
    ExitedNeedsReap,
    AlreadyReaped,
    Live,
    Unavailable,
}

fn retained_child_reap_state(child: i32) -> RetainedChildReapState {
    classify_retained_child_reap_state(child_exited_without_reaping(child))
}

fn classify_retained_child_reap_state(observation: io::Result<bool>) -> RetainedChildReapState {
    match observation {
        Ok(true) => RetainedChildReapState::ExitedNeedsReap,
        Ok(false) => RetainedChildReapState::Live,
        Err(error) if error.raw_os_error() == Some(MACOS_ECHILD) => {
            RetainedChildReapState::AlreadyReaped
        }
        Err(_) => RetainedChildReapState::Unavailable,
    }
}

fn reap_child(child: i32) -> bool {
    let mut information = WaitInformation::default();
    // SAFETY: waitid receives the retained positive child PID owned by this
    // supervisor and reaps it only after all live descendants are absent.
    let result = unsafe { keiko_waitid(P_PID, child as u32, &mut information, WEXITED) };
    result == 0 && information.process_id == child
}

fn signal_active_process_group(active: &ActiveRuntime, process_group: i32, signal: i32) -> bool {
    let Ok(active_group) = active.process_group.lock() else {
        return false;
    };
    let Some(identity) = *active_group else {
        return false;
    };
    if identity.process_id != process_group {
        return false;
    }
    match retained_process_identity_status(identity) {
        RetainedProcessIdentityStatus::Current => {}
        RetainedProcessIdentityStatus::Reused => {
            drop(active_group);
            retire_active_process_group(active, identity);
            return false;
        }
        RetainedProcessIdentityStatus::Unavailable => return false,
    }
    signal_process_group(process_group, signal);
    if let Ok(owned) = active.owned_processes.lock() {
        for identity in owned
            .iter()
            .copied()
            .filter(|identity| process_identity(identity.process_id) == Some(*identity))
        {
            signal_process(identity.process_id, signal);
        }
    }
    true
}

fn signal_active_descendants(active: &ActiveRuntime, process_group: i32, signal: i32) -> bool {
    let Ok(active_group) = active.process_group.lock() else {
        return false;
    };
    let Some(identity) = *active_group else {
        return false;
    };
    if identity.process_id != process_group {
        return false;
    }
    match retained_process_identity_status(identity) {
        RetainedProcessIdentityStatus::Current => {}
        RetainedProcessIdentityStatus::Reused => {
            drop(active_group);
            retire_active_process_group(active, identity);
            return false;
        }
        RetainedProcessIdentityStatus::Unavailable => return false,
    }
    let Ok(owned) = active.owned_processes.lock() else {
        return false;
    };
    let mut signalled = false;
    for identity in owned
        .iter()
        .copied()
        .filter(|identity| process_identity(identity.process_id) == Some(*identity))
    {
        signal_process(identity.process_id, signal);
        signalled = true;
    }
    signalled
}

fn retire_active_process_group(active: &ActiveRuntime, identity: ProcessIdentity) -> bool {
    let Ok(mut active_group) = active.process_group.lock() else {
        return false;
    };
    if *active_group != Some(identity) {
        return false;
    }
    let Ok(mut owned) = active.owned_processes.lock() else {
        return false;
    };
    *active_group = None;
    owned.clear();
    true
}

#[cfg(test)]
fn reconcile_stopped_process_group(
    child: &mut Child,
    process_group: i32,
    active: &ActiveRuntime,
) -> bool {
    let mut executor = RealCleanupExecutor {
        child,
        process_group,
        active,
    };
    let started_at = Instant::now();
    let controller = CleanupController {
        policy: CleanupPhasePolicy::AllowParentReap,
        process_group,
        deadline: started_at,
        cleanup_started: started_at,
        eof_grace: Duration::ZERO,
        term_grace: Duration::ZERO,
    };
    drive_real_cleanup(
        &mut executor,
        start_cleanup_reconciliation(controller, CleanupContinuation::Final, started_at),
    )
}

fn register_owned_process(active: &ActiveRuntime, process: i32) {
    debug_assert_eq!(
        active
            .process_group
            .lock()
            .ok()
            .and_then(|group| group.map(|identity| identity.process_id)),
        Some(process)
    );
    let _ = refresh_owned_processes(active);
}

fn publish_active_process_group(active: &ActiveRuntime, process: i32) -> bool {
    let Some(identity) = process_identity(process) else {
        return false;
    };
    let Ok(mut active_group) = active.process_group.lock() else {
        return false;
    };
    *active_group = Some(identity);
    true
}

fn refresh_owned_processes(active: &ActiveRuntime) -> bool {
    let Some(leader_identity) = active.process_group.lock().ok().and_then(|group| *group) else {
        return false;
    };
    if retained_process_identity_status(leader_identity) != RetainedProcessIdentityStatus::Current {
        return false;
    }
    let leader = leader_identity.process_id;
    let Ok(mut owned) = active.owned_processes.lock() else {
        return false;
    };
    if !retain_unstopped_known_owned_processes(&mut owned) {
        return false;
    }
    let mut pending = owned.iter().copied().collect::<Vec<_>>();
    let mut parent_processes = vec![leader];
    let mut inspected = HashSet::from([leader]);
    while let Some(identity) = pending.pop() {
        if inspected.insert(identity.process_id) {
            parent_processes.push(identity.process_id);
        }
    }
    while let Some(parent) = parent_processes.pop() {
        let Ok(children) = child_processes(parent) else {
            return false;
        };
        for child in children {
            let Some(identity) = process_identity(child) else {
                continue;
            };
            owned.insert(identity);
            if inspected.insert(child) {
                parent_processes.push(child);
            }
        }
    }
    true
}

fn process_identity(process: i32) -> Option<ProcessIdentity> {
    let information = process_information(process)?;
    identity_from_information(process, &information)
}

fn process_start_identity(process: i32) -> Option<ProcessIdentity> {
    let information = process_information(process)?;
    Some(ProcessIdentity {
        process_id: process,
        started_microseconds: information.started_microseconds,
        started_seconds: information.started_seconds,
    })
}

fn retained_process_identity_status(identity: ProcessIdentity) -> RetainedProcessIdentityStatus {
    match process_start_identity(identity.process_id) {
        Some(current) if current == identity => RetainedProcessIdentityStatus::Current,
        Some(_) => RetainedProcessIdentityStatus::Reused,
        None if child_exited_without_reaping(identity.process_id).unwrap_or(false) => {
            RetainedProcessIdentityStatus::Current
        }
        None => RetainedProcessIdentityStatus::Unavailable,
    }
}

fn classify_known_owned_process<F>(
    identity_status: RetainedProcessIdentityStatus,
    presence: F,
) -> KnownOwnedProcessStatus
where
    F: FnOnce() -> io::Result<bool>,
{
    match identity_status {
        RetainedProcessIdentityStatus::Current => KnownOwnedProcessStatus::Alive,
        RetainedProcessIdentityStatus::Reused => KnownOwnedProcessStatus::Stopped,
        RetainedProcessIdentityStatus::Unavailable => match presence() {
            Ok(false) => KnownOwnedProcessStatus::Stopped,
            Ok(true) | Err(_) => KnownOwnedProcessStatus::Unavailable,
        },
    }
}

fn known_owned_process_status(identity: ProcessIdentity) -> KnownOwnedProcessStatus {
    classify_known_owned_process(retained_process_identity_status(identity), || {
        process_presence(identity.process_id)
    })
}

fn process_presence(process: i32) -> io::Result<bool> {
    if process <= 0 {
        return Err(io::Error::other("process presence"));
    }
    // SAFETY: signal 0 performs existence/permission checking only for a PID
    // previously authenticated as part of the owned runtime ancestry.
    let result = unsafe { keiko_kill(process, 0) };
    let error = (result != 0).then(io::Error::last_os_error);
    match classify_process_presence(result, error.as_ref().and_then(io::Error::raw_os_error)) {
        ProcessPresenceStatus::Present => Ok(true),
        ProcessPresenceStatus::Absent => Ok(false),
        ProcessPresenceStatus::Unavailable => {
            Err(error.unwrap_or_else(|| io::Error::other("process presence")))
        }
    }
}

fn identity_from_information(
    process: i32,
    information: &ProcessBsdInformation,
) -> Option<ProcessIdentity> {
    if information.status == PROCESS_STATUS_ZOMBIE {
        return None;
    }
    Some(ProcessIdentity {
        process_id: process,
        started_microseconds: information.started_microseconds,
        started_seconds: information.started_seconds,
    })
}

fn process_information(process: i32) -> Option<ProcessBsdInformation> {
    if process <= 0 {
        return None;
    }
    let mut information = ProcessBsdInformation::default();
    let buffer_size = i32::try_from(std::mem::size_of::<ProcessBsdInformation>()).ok()?;
    // SAFETY: proc_pidinfo receives a positive PID discovered below the owned
    // runtime leader and a correctly sized writable BSD-information buffer.
    let result = unsafe {
        keiko_proc_pidinfo(
            process,
            PROC_PIDTBSDINFO,
            0,
            (&mut information as *mut ProcessBsdInformation).cast::<c_void>(),
            buffer_size,
        )
    };
    validated_process_information(process, result, buffer_size, information)
}

fn validated_process_information(
    process: i32,
    result: i32,
    buffer_size: i32,
    information: ProcessBsdInformation,
) -> Option<ProcessBsdInformation> {
    if result != buffer_size || information.process_id != process as u32 {
        None
    } else {
        Some(information)
    }
}

fn child_processes(parent: i32) -> io::Result<Vec<i32>> {
    if parent <= 0 {
        return Err(io::Error::other("child process parent"));
    }
    let mut children = [0_i32; 512];
    let buffer_size = i32::try_from(std::mem::size_of_val(&children))
        .map_err(|_| io::Error::other("child process buffer"))?;
    // SAFETY: proc_listchildpids receives a positive observed process ID and
    // a writable fixed-size PID buffer owned by this call.
    let child_count = unsafe {
        keiko_proc_listchildpids(parent, children.as_mut_ptr().cast::<c_void>(), buffer_size)
    };
    let child_count = validated_child_count(child_count, children.len())?;
    Ok(children[..child_count]
        .iter()
        .copied()
        .filter(|process| *process > 0)
        .collect())
}

fn validated_child_count(child_count: i32, capacity: usize) -> io::Result<usize> {
    if child_count < 0 {
        return Err(io::Error::last_os_error());
    }
    let child_count = child_count as usize;
    if child_count >= capacity {
        return Err(io::Error::other("child process result"));
    }
    Ok(child_count)
}

fn owned_descendants_alive(active: &ActiveRuntime, _leader: i32) -> Option<bool> {
    if !refresh_owned_processes(active) {
        return None;
    }
    let Ok(owned) = active.owned_processes.lock() else {
        return None;
    };
    Some(!owned.is_empty())
}

fn child_exited_without_reaping(child: i32) -> io::Result<bool> {
    let mut information = WaitInformation::default();
    // SAFETY: waitid receives this supervisor's positive child PID and a
    // correctly sized writable siginfo-compatible buffer. WNOWAIT preserves
    // the child identity until the active process group is retired.
    let result = unsafe {
        keiko_waitid(
            P_PID,
            child as u32,
            &mut information,
            WEXITED | WNOHANG | WNOWAIT,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(information.process_id == child)
}

fn process_group_has_descendants(process_group: i32, leader: i32) -> io::Result<bool> {
    Ok(process_group_members(process_group)?
        .into_iter()
        .any(|process| process != leader))
}

fn process_group_has_live_descendants(process_group: i32, leader: i32) -> io::Result<bool> {
    Ok(process_group_members(process_group)?
        .into_iter()
        .any(|process| process != leader && process_identity(process).is_some()))
}

fn process_group_members(process_group: i32) -> io::Result<Vec<i32>> {
    let mut members = [0_i32; 512];
    let buffer_size = i32::try_from(std::mem::size_of_val(&members))
        .map_err(|_| io::Error::other("process group buffer"))?;
    // SAFETY: proc_listpgrppids receives a positive group ID and a writable
    // fixed-size PID buffer owned by this call.
    let member_count = unsafe {
        keiko_proc_listpgrppids(
            process_group,
            members.as_mut_ptr().cast::<c_void>(),
            buffer_size,
        )
    };
    if member_count < 0 {
        return Err(io::Error::last_os_error());
    }
    let member_count =
        usize::try_from(member_count).map_err(|_| io::Error::other("process group size"))?;
    if member_count > members.len() {
        return Err(io::Error::other("process group result"));
    }
    if member_count == members.len() {
        return Err(io::Error::other("process group result"));
    }
    Ok(members[..member_count]
        .iter()
        .copied()
        .filter(|process| *process > 0)
        .collect())
}

fn signal_process_group(process_group: i32, signal: i32) {
    // SAFETY: kill is called with a positive, host-owned process group ID and a
    // fixed signal. A negative PID targets only that group, never an arbitrary
    // shell command or caller-selected process.
    unsafe {
        keiko_kill(-process_group, signal);
    }
}

fn signal_process(process: i32, signal: i32) {
    // SAFETY: the positive PID was discovered in the owned runtime ancestry;
    // no caller- or model-supplied process identity reaches this function.
    unsafe {
        keiko_kill(process, signal);
    }
}

fn process_group_exists(process_group: i32) -> bool {
    process_group_presence(process_group) == ProcessPresenceStatus::Present
}

fn process_group_presence(process_group: i32) -> ProcessPresenceStatus {
    // SAFETY: signal 0 performs existence/permission checking only. The process
    // group ID came directly from the child created by this supervisor.
    let result = unsafe { keiko_kill(-process_group, 0) };
    let raw_os_error = (result != 0)
        .then(io::Error::last_os_error)
        .and_then(|error| error.raw_os_error());
    classify_process_presence(result, raw_os_error)
}

fn classify_process_presence(
    signal_zero_result: i32,
    raw_os_error: Option<i32>,
) -> ProcessPresenceStatus {
    if signal_zero_result == 0 {
        ProcessPresenceStatus::Present
    } else if raw_os_error == Some(MACOS_ESRCH) {
        ProcessPresenceStatus::Absent
    } else {
        ProcessPresenceStatus::Unavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::os::unix::fs::symlink;

    static PROCESS_TEST_LOCK: Mutex<()> = Mutex::new(());
    static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn unavailable_process_identity(process_id: i32) -> ProcessIdentity {
        ProcessIdentity {
            process_id,
            started_microseconds: 0,
            started_seconds: 1,
        }
    }

    fn bounded_owned_child_exit(child: &mut Child) -> bool {
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            if child.try_wait().is_ok_and(|status| status.is_some()) {
                return true;
            }
            thread::yield_now();
        }
        false
    }

    struct AuthenticatedDirectChild(ProcessIdentity);

    enum DirectChildFinalization {
        Settled,
        StillDirectlyOwned(AuthenticatedDirectChild),
        OwnershipLostOrUnavailable,
    }

    const DIRECT_CHILD_TERMINAL_INTERRUPTS: usize = 16;
    const TEST_MACOS_EINTR: i32 = 4;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum DirectChildState {
        Waiting(bool),
        Reaping,
        Verifying,
        Settled,
        Lost,
    }

    fn reduce_direct_child(
        state: DirectChildState,
        result: io::Result<bool>,
        group: ProcessPresenceStatus,
    ) -> DirectChildState {
        use DirectChildState as State;
        match (state, result) {
            (state, Err(error)) if error.raw_os_error() == Some(TEST_MACOS_EINTR) => state,
            (State::Waiting(_), Ok(false)) => State::Waiting(true),
            (State::Waiting(_), Ok(true)) => State::Reaping,
            (State::Reaping, Ok(true)) => State::Verifying,
            (State::Waiting(_) | State::Verifying, Err(error))
                if error.raw_os_error() == Some(MACOS_ECHILD)
                    && group == ProcessPresenceStatus::Absent =>
            {
                State::Settled
            }
            _ => State::Lost,
        }
    }

    fn authenticated_direct_child(
        child: &Child,
        process_group: i32,
        identity: ProcessIdentity,
    ) -> Option<AuthenticatedDirectChild> {
        (child.id() as i32 == process_group
            && process_group == identity.process_id
            && process_start_identity(identity.process_id) == Some(identity))
        .then_some(AuthenticatedDirectChild(identity))
    }

    fn reap_exact_child(child: i32) -> io::Result<bool> {
        let mut information = WaitInformation::default();
        // SAFETY: the authenticated PID belongs to this serialized test's direct child.
        let result = unsafe { keiko_waitid(P_PID, child as u32, &mut information, WEXITED) };
        if result == 0 {
            Ok(information.process_id == child)
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn observe_direct_child(
        state: DirectChildState,
        process: i32,
    ) -> (io::Result<bool>, ProcessPresenceStatus) {
        let result = match state {
            DirectChildState::Waiting(_) | DirectChildState::Verifying => {
                child_exited_without_reaping(process)
            }
            DirectChildState::Reaping => reap_exact_child(process),
            DirectChildState::Settled | DirectChildState::Lost => unreachable!("terminal state"),
        };
        let group = match &result {
            Err(error) if error.raw_os_error() == Some(MACOS_ECHILD) => {
                process_group_presence(process)
            }
            _ => ProcessPresenceStatus::Unavailable,
        };
        (result, group)
    }

    fn continue_direct_child(
        state: DirectChildState,
        waiting_deadline_open: bool,
        terminal_interruptions: usize,
    ) -> bool {
        match state {
            DirectChildState::Waiting(_) => waiting_deadline_open,
            DirectChildState::Reaping | DirectChildState::Verifying => {
                terminal_interruptions < DIRECT_CHILD_TERMINAL_INTERRUPTS
            }
            DirectChildState::Settled | DirectChildState::Lost => false,
        }
    }

    fn finalize_exact_child_after_eof(child: AuthenticatedDirectChild) -> DirectChildFinalization {
        let process = child.0.process_id;
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut state = DirectChildState::Waiting(false);
        let mut interruptions = 0;
        while continue_direct_child(state, Instant::now() < deadline, interruptions) {
            let terminal = matches!(
                state,
                DirectChildState::Reaping | DirectChildState::Verifying
            );
            let (result, group) = observe_direct_child(state, process);
            if terminal
                && result
                    .as_ref()
                    .is_err_and(|error| error.raw_os_error() == Some(TEST_MACOS_EINTR))
            {
                interruptions += 1;
            }
            state = reduce_direct_child(state, result, group);
            if matches!(state, DirectChildState::Waiting(_)) {
                thread::yield_now();
            }
        }
        match state {
            DirectChildState::Settled => DirectChildFinalization::Settled,
            DirectChildState::Waiting(true) => DirectChildFinalization::StillDirectlyOwned(child),
            _ => DirectChildFinalization::OwnershipLostOrUnavailable,
        }
    }

    fn finish_owned_child_outcome(
        outcome: DirectChildFinalization,
        child: &mut Child,
        process_group: i32,
        active: &ActiveRuntime,
    ) -> bool {
        match outcome {
            DirectChildFinalization::Settled => true,
            DirectChildFinalization::StillDirectlyOwned(token)
                if token.0.process_id == child.id() as i32
                    && token.0.process_id == process_group =>
            {
                settle_unpublished_fixture(child, process_group, active)
            }
            DirectChildFinalization::StillDirectlyOwned(_)
            | DirectChildFinalization::OwnershipLostOrUnavailable => false,
        }
    }

    fn finish_owned_child(
        token: AuthenticatedDirectChild,
        child: &mut Child,
        process_group: i32,
        active: &ActiveRuntime,
    ) -> bool {
        let outcome = finalize_exact_child_after_eof(token);
        finish_owned_child_outcome(outcome, child, process_group, active)
    }

    fn publish_blocked_fixture(
        child: &Child,
        process_group: i32,
        active: &ActiveRuntime,
    ) -> Option<AuthenticatedDirectChild> {
        let captured_identity = process_identity(process_group);
        if !publish_active_process_group(active, process_group) {
            return None;
        }
        let stored_identity = active.process_group.lock().ok().and_then(|group| *group);
        stored_identity
            .filter(|identity| {
                Some(*identity) == captured_identity
                    && retained_process_identity_status(*identity)
                        == RetainedProcessIdentityStatus::Current
            })
            .and_then(|identity| authenticated_direct_child(child, process_group, identity))
    }
    fn stop_published_fixture_group(
        child: &mut Child,
        process_group: i32,
        active: &ActiveRuntime,
    ) -> bool {
        let Some(identity) = active.process_group.lock().ok().and_then(|group| *group) else {
            return false;
        };
        if identity.process_id != process_group
            || retained_process_identity_status(identity) != RetainedProcessIdentityStatus::Current
        {
            return false;
        }
        stop_process_group(
            child,
            process_group,
            active,
            Instant::now() + Duration::from_secs(5),
        )
    }

    fn settle_owned_fixture_process(
        child: &mut Child,
        process_group: i32,
        active: &ActiveRuntime,
    ) -> bool {
        drop(child.stdin.take());
        let _ = child.kill();
        if bounded_owned_child_exit(child)
            && process_group_presence(process_group) == ProcessPresenceStatus::Absent
        {
            return true;
        }
        let _ = stop_published_fixture_group(child, process_group, active);
        child_exited_without_reaping(process_group)
            .is_err_and(|error| error.raw_os_error() == Some(MACOS_ECHILD))
            && process_group_presence(process_group) == ProcessPresenceStatus::Absent
    }

    fn retire_settled_fixture(active: &ActiveRuntime) -> bool {
        let stored_identity = active.process_group.lock().ok().and_then(|group| *group);
        let retired =
            stored_identity.is_none_or(|identity| retire_active_process_group(active, identity));
        retired
            && active
                .process_group
                .lock()
                .is_ok_and(|group| group.is_none())
            && active
                .owned_processes
                .lock()
                .is_ok_and(|owned| owned.is_empty())
    }

    fn settle_unpublished_fixture(
        child: &mut Child,
        process_group: i32,
        active: &ActiveRuntime,
    ) -> bool {
        child.id() as i32 == process_group
            && settle_owned_fixture_process(child, process_group, active)
            && retire_settled_fixture(active)
    }

    #[test]
    fn runtime_boundary_counts_and_rejects_structural_repository_context() {
        let workspace = Path::new("/private/KeikoRepositoryCanary");
        let mut audit = RuntimeBoundaryAudit::new(workspace);
        let mut writer = Vec::new();
        let result = audit.write_json_line(
            &mut writer,
            &json!({
                "method": "thread/start",
                "params": {"cwd": workspace, "runtimeWorkspaceRoots": []}
            }),
        );
        assert_eq!(
            result.expect_err("repository context must fail").kind(),
            io::ErrorKind::PermissionDenied
        );
        assert!(
            writer.is_empty(),
            "rejected bytes must not cross the boundary"
        );
        assert!(audit.repository_context_bytes_to_runtime > 0);
    }

    #[test]
    fn runtime_boundary_allows_exact_user_task_without_treating_it_as_product_context() {
        let workspace = Path::new("/private/KeikoRepositoryCanary");
        let mut audit = RuntimeBoundaryAudit::new(workspace);
        let mut writer = Vec::new();
        audit
            .write_json_line(
                &mut writer,
                &json!({
                    "method": "turn/start",
                    "params": {
                        "input": [{
                            "type": "text",
                            "text": "Explain /private/KeikoRepositoryCanary exactly.",
                            "text_elements": []
                        }],
                        "runtimeWorkspaceRoots": []
                    }
                }),
            )
            .expect("exact user input is authorized");
        assert!(!writer.is_empty());
        assert_eq!(audit.repository_context_bytes_to_runtime, 0);

        let mut missing_input = RuntimeBoundaryAudit::new(Path::new("repository"));
        missing_input
            .write_json_line(
                &mut Vec::new(),
                &json!({"method": "turn/start", "params": {"input": {}}}),
            )
            .expect("missing input array contains no product context");
        missing_input
            .write_json_line(
                &mut Vec::new(),
                &json!({"method": "turn/start", "params": {"input": [{}]}}),
            )
            .expect("missing text contains no product context");

        let empty_workspace = RuntimeBoundaryAudit::new(Path::new(""));
        assert!(empty_workspace.repository_path_marker.is_none());
        assert!(
            RuntimeBoundaryAudit::new(Path::new("repository"))
                .repository_path_marker
                .is_none()
        );
        assert_eq!(count_byte_occurrences(b"", b""), 0);
        assert_eq!(count_byte_occurrences(b"a", b"long"), 0);
        assert_eq!(count_byte_occurrences(b"abab", b"ab"), 2);
    }

    #[test]
    fn runtime_boundary_ignores_protocol_tokens_that_match_repository_names() {
        for repository_name in ["method", "params", "text"] {
            let mut audit = RuntimeBoundaryAudit::new(Path::new(repository_name));
            let mut writer = Vec::new();
            audit
                .write_json_line(
                    &mut writer,
                    &json!({
                        "method": "turn/start",
                        "id": 4,
                        "params": {
                            "threadId": "thread-1",
                            "input": [{
                                "type": "text",
                                "text": "repository-independent task",
                                "text_elements": []
                            }],
                            "runtimeWorkspaceRoots": []
                        }
                    }),
                )
                .expect("protocol vocabulary is not repository context");
            assert!(!writer.is_empty());
            assert_eq!(audit.repository_context_bytes_to_runtime, 0);
        }
    }

    #[test]
    fn runtime_boundary_does_not_match_a_basename_inside_an_unrelated_path() {
        let mut audit = RuntimeBoundaryAudit::new(Path::new("/private/var/selected-workspace"));
        let mut writer = Vec::new();
        audit
            .write_json_line(
                &mut writer,
                &json!({
                    "method": "thread/start",
                    "params": {"cwd": "/private/tmp/selected-workspace"}
                }),
            )
            .expect("unrelated path is not repository provenance");
        assert!(!writer.is_empty());
        assert_eq!(audit.repository_context_bytes_to_runtime, 0);
    }

    #[test]
    fn writable_sticky_ancestors_require_a_trusted_owner() {
        let effective_user = 501;
        assert!(protected_directory_component(0o755, 900, effective_user));
        assert!(protected_directory_component(0o1777, 0, effective_user));
        assert!(protected_directory_component(
            0o1777,
            effective_user,
            effective_user
        ));
        assert!(!protected_directory_component(0o1777, 900, effective_user));
        assert!(!protected_directory_component(0o0777, 0, effective_user));
    }

    #[test]
    fn turn_and_readiness_share_the_closed_no_effect_runtime_arguments() {
        let joined = CODEX_CONTAINMENT_ARGUMENTS.join(" ");
        for provider_binding in ["model_provider=\"openai\"", "openai_base_url=\"\""] {
            assert!(joined.contains(provider_binding), "{provider_binding}");
        }
        for disabled in [
            "features.multi_agent=false",
            "features.multi_agent_v2=false",
            "tools.experimental_request_user_input.enabled=false",
            "features.apps=false",
            "features.plugins=false",
            "features.remote_plugin=false",
            "features.hooks=false",
            "features.browser_use=false",
            "features.computer_use=false",
            "features.image_generation=false",
            "features.workspace_dependencies=false",
            "features.tool_suggest=false",
        ] {
            assert!(joined.contains(disabled), "{disabled}");
        }
        assert!(joined.contains("history.persistence=\"none\""));
        assert_eq!(
            &CODEX_CONTAINMENT_ARGUMENTS[CODEX_CONTAINMENT_ARGUMENTS.len() - 3..],
            &["app-server", "--listen", "stdio://"]
        );
    }

    #[test]
    fn protocol_requires_exact_initialize_then_chatgpt_account() {
        let home = Path::new("/private/tmp/codex-home");
        let mut projection = ProtocolProjection::new(home);
        assert_eq!(
            projection.accept(
                br#"{"id":1,"result":{"userAgent":"codex_cli_rs/0.145.0","codexHome":"/private/tmp/codex-home","platformFamily":"unix","platformOs":"macos"}}"#
            ),
            ProjectionAction::SendAccountRead
        );
        assert_eq!(
            projection.accept(
                br#"{"id":2,"result":{"account":{"type":"chatgpt","email":"redacted","planType":"plus"},"requiresOpenaiAuth":true}}"#
            ),
            ProjectionAction::Terminal(RuntimeReadinessState::Ready)
        );
        assert_eq!(projection.quarantined_events, 0);
    }

    #[test]
    fn missing_auth_is_distinct_and_provider_requests_fail_containment() {
        let mut projection = ProtocolProjection::new(Path::new("/private/tmp/codex-home"));
        assert_eq!(
            projection
                .accept(br#"{"method":"item/tool/call","id":99,"params":{"path":"/secret"}}"#),
            ProjectionAction::Terminal(RuntimeReadinessState::ContainmentFailed)
        );

        let mut projection = ProtocolProjection::new(Path::new("/private/tmp/codex-home"));
        projection.stage = ProjectionStage::Account;
        assert_eq!(
            projection.accept(br#"{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}"#),
            ProjectionAction::Terminal(RuntimeReadinessState::AuthenticationRequired)
        );
    }

    #[test]
    fn inert_provider_state_is_bounded_quarantine_not_product_state() {
        let mut projection = ProtocolProjection::new(Path::new("/private/tmp/codex-home"));
        assert_eq!(
            projection
                .accept(br#"{"method":"turn/plan/updated","params":{"plan":[{"step":"secret"}]}}"#),
            ProjectionAction::Continue
        );
        assert_eq!(projection.quarantined_events, 1);
        assert_eq!(projection.stage, ProjectionStage::Initialize);
    }

    #[test]
    fn disabled_remote_control_state_is_bounded_quarantine_not_product_state() {
        let mut projection = ProtocolProjection::new(Path::new("/private/tmp/codex-home"));
        assert_eq!(
            projection.accept(
                br#"{"method":"remoteControl/status/changed","params":{"environmentId":null,"installationId":"redacted","serverName":"redacted","status":"disabled"},"emittedAtMs":1}"#
            ),
            ProjectionAction::Continue
        );
        assert_eq!(projection.quarantined_events, 1);
        assert_eq!(projection.stage, ProjectionStage::Initialize);
    }

    #[test]
    fn remote_control_schema_rejects_missing_and_wrong_typed_fields() {
        for params in [
            json!({"environmentId": null, "serverName": "redacted", "status": "disabled"}),
            json!({"environmentId": null, "installationId": "redacted", "status": "disabled"}),
            json!({"environmentId": null, "installationId": "redacted", "serverName": "redacted"}),
            json!({"installationId": 7, "serverName": "redacted", "status": "disabled"}),
            json!({"installationId": "redacted", "serverName": 7, "status": "disabled"}),
        ] {
            assert!(!remote_control_is_disabled(Some(&params)), "{params}");
        }
        assert!(!remote_control_is_disabled(Some(&json!({
            "installationId": "redacted",
            "serverName": "redacted",
            "status": 7
        }))));
    }

    #[test]
    fn remote_control_projection_rejects_effectful_or_malformed_state() {
        let valid_identity = json!({
            "environmentId": null,
            "installationId": "redacted",
            "serverName": "redacted"
        });
        for status in ["connecting", "connected", "errored"] {
            let mut params = valid_identity.clone();
            params["status"] = json!(status);
            assert_eq!(
                ProtocolProjection::new(Path::new("/private/tmp/codex-home")).accept(
                    &serde_json::to_vec(&json!({
                        "method": "remoteControl/status/changed",
                        "params": params,
                        "emittedAtMs": 1
                    }))
                    .expect("remote control event")
                ),
                ProjectionAction::Terminal(RuntimeReadinessState::ContainmentFailed)
            );
        }

        for event in [
            json!({
                "method": "remoteControl/status/changed",
                "emittedAtMs": 1
            }),
            json!({
                "method": "remoteControl/status/changed",
                "params": [],
                "emittedAtMs": 1
            }),
            json!({
                "method": "remoteControl/status/changed",
                "params": {"installationId": "redacted", "status": "disabled"},
                "emittedAtMs": 1
            }),
            json!({
                "method": "remoteControl/status/changed",
                "params": {
                    "environmentId": 7,
                    "installationId": "redacted",
                    "serverName": "redacted",
                    "status": "disabled"
                },
                "emittedAtMs": 1
            }),
            json!({
                "method": "remoteControl/status/changed",
                "params": {
                    "installationId": "redacted",
                    "serverName": "redacted",
                    "status": "disabled",
                    "unexpected": true
                },
                "emittedAtMs": 1
            }),
            json!({
                "method": "remoteControl/status/changed",
                "params": {
                    "installationId": "redacted",
                    "serverName": "redacted",
                    "status": "disabled"
                },
                "emittedAtMs": "1"
            }),
            json!({
                "method": "remoteControl/status/changed",
                "id": 9,
                "params": {
                    "installationId": "redacted",
                    "serverName": "redacted",
                    "status": "disabled"
                },
                "emittedAtMs": 1
            }),
        ] {
            assert_eq!(
                ProtocolProjection::new(Path::new("/private/tmp/codex-home"))
                    .accept(&serde_json::to_vec(&event).expect("remote control event")),
                ProjectionAction::Terminal(RuntimeReadinessState::ContainmentFailed)
            );
        }
    }

    #[test]
    fn initialize_projection_rejects_malformed_and_drifted_responses() {
        let home = Path::new("/private/tmp/codex-home");
        let valid_result = json!({
            "codexHome": home,
            "platformFamily": "unix",
            "platformOs": "macos",
            "userAgent": "codex_cli_rs/0.145.0"
        });
        let cases = [
            b"{".to_vec(),
            serde_json::to_vec(&json!([])).expect("array"),
            serde_json::to_vec(&json!({"id": 9, "result": valid_result})).expect("wrong id"),
            serde_json::to_vec(&json!({"id": 1})).expect("missing result"),
            serde_json::to_vec(&json!({"id": 1, "result": valid_result, "extra": true}))
                .expect("extra response field"),
            serde_json::to_vec(&json!({"id": 1, "result": []})).expect("non-object result"),
            serde_json::to_vec(&json!({
                "id": 1,
                "result": {
                    "codexHome": home,
                    "platformFamily": "unix",
                    "platformOs": "macos"
                }
            }))
            .expect("missing user agent"),
            serde_json::to_vec(&json!({
                "id": 1,
                "result": {
                    "codexHome": home,
                    "platformFamily": "unix",
                    "platformOs": "macos",
                    "userAgent": "codex_cli_rs/0.145.0",
                    "extra": true
                }
            }))
            .expect("extra result field"),
            serde_json::to_vec(&json!({
                "id": 1,
                "result": {
                    "codexHome": "/private/tmp/other-home",
                    "platformFamily": "unix",
                    "platformOs": "macos",
                    "userAgent": "codex_cli_rs/0.145.0"
                }
            }))
            .expect("wrong home"),
            serde_json::to_vec(&json!({
                "id": 1,
                "result": {
                    "codexHome": home,
                    "platformFamily": "windows",
                    "platformOs": "macos",
                    "userAgent": "codex_cli_rs/0.145.0"
                }
            }))
            .expect("wrong family"),
            serde_json::to_vec(&json!({
                "id": 1,
                "result": {
                    "codexHome": home,
                    "platformFamily": "unix",
                    "platformOs": "linux",
                    "userAgent": "codex_cli_rs/0.145.0"
                }
            }))
            .expect("wrong operating system"),
            serde_json::to_vec(&json!({
                "id": 1,
                "result": {
                    "codexHome": home,
                    "platformFamily": "unix",
                    "platformOs": "macos",
                    "userAgent": ""
                }
            }))
            .expect("empty user agent"),
            serde_json::to_vec(&json!({
                "id": 1,
                "result": {
                    "codexHome": home,
                    "platformFamily": "unix",
                    "platformOs": "macos",
                    "userAgent": "x".repeat(257)
                }
            }))
            .expect("oversized user agent"),
        ];

        for case in cases {
            assert_eq!(
                ProtocolProjection::new(home).accept(&case),
                ProjectionAction::Terminal(RuntimeReadinessState::Incompatible)
            );
        }
    }

    #[test]
    fn account_projection_rejects_schema_and_profile_drift() {
        let home = Path::new("/private/tmp/codex-home");
        let incompatible = [
            json!({"id": 9, "result": {"account": null, "requiresOpenaiAuth": true}}),
            json!({"id": 2}),
            json!({"id": 2, "result": {}, "extra": true}),
            json!({"id": 2, "result": []}),
            json!({"id": 2, "result": {"account": null}}),
            json!({"id": 2, "result": {"account": null, "requiresOpenaiAuth": true, "extra": true}}),
            json!({"id": 2, "result": {"account": null, "requiresOpenaiAuth": false}}),
            json!({"id": 2, "result": {"account": null, "requiresOpenaiAuth": "true"}}),
            json!({"id": 2, "result": {"account": 7, "requiresOpenaiAuth": true}}),
        ];
        for response in incompatible {
            let mut projection = ProtocolProjection::new(home);
            projection.stage = ProjectionStage::Account;
            assert_eq!(
                projection.accept(&serde_json::to_vec(&response).expect("response")),
                ProjectionAction::Terminal(RuntimeReadinessState::Incompatible)
            );
        }

        let malformed_or_unsupported = [
            json!({"id": 2, "result": {"account": {}, "requiresOpenaiAuth": true}}),
            json!({"id": 2, "result": {"account": {"type": "chatgpt", "email": "redacted", "planType": "plus", "extra": true}, "requiresOpenaiAuth": true}}),
            json!({"id": 2, "result": {"account": {"type": "apiKey", "email": "redacted", "planType": "plus"}, "requiresOpenaiAuth": true}}),
            json!({"id": 2, "result": {"account": {"type": "chatgpt", "email": 7, "planType": "plus"}, "requiresOpenaiAuth": true}}),
            json!({"id": 2, "result": {"account": {"type": "chatgpt", "email": "redacted", "planType": 7}, "requiresOpenaiAuth": true}}),
        ];
        for response in malformed_or_unsupported {
            let mut projection = ProtocolProjection::new(home);
            projection.stage = ProjectionStage::Account;
            assert_eq!(
                projection.accept(&serde_json::to_vec(&response).expect("response")),
                ProjectionAction::Terminal(RuntimeReadinessState::Incompatible)
            );
        }
    }

    #[test]
    fn provider_projection_contains_unknown_malformed_and_unbounded_events() {
        let home = Path::new("/private/tmp/codex-home");
        for response in [
            json!({"method": 7}),
            json!({"method": "unknown/event"}),
            json!({"method": "account/updated", "extra": true}),
        ] {
            assert_eq!(
                ProtocolProjection::new(home)
                    .accept(&serde_json::to_vec(&response).expect("event")),
                ProjectionAction::Terminal(RuntimeReadinessState::ContainmentFailed)
            );
        }

        for method in [
            "turn/plan/updated",
            "thread/status/changed",
            "item/agentMessage/delta",
            "account/updated",
        ] {
            let mut projection = ProtocolProjection::new(home);
            assert_eq!(
                projection.accept(
                    &serde_json::to_vec(&json!({"method": method, "params": {}})).expect("event")
                ),
                ProjectionAction::Continue
            );
        }

        let mut saturated = ProtocolProjection::new(home);
        saturated.quarantined_events = MAX_QUARANTINED_EVENTS;
        assert_eq!(
            saturated.accept(br#"{"method":"account/updated","params":{}}"#),
            ProjectionAction::Terminal(RuntimeReadinessState::ContainmentFailed)
        );
    }

    #[test]
    fn bounded_reader_rejects_oversized_and_unterminated_frames() {
        let oversized = vec![b'x'; MAX_FRAME_BYTES + 1];
        assert!(read_bounded_line(&mut BufReader::new(oversized.as_slice())).is_err());
        assert!(read_bounded_line(&mut BufReader::new(b"{}".as_slice())).is_err());
        assert_eq!(
            read_bounded_line(&mut BufReader::new(b"".as_slice())).expect("empty input"),
            None
        );
        assert_eq!(
            read_bounded_line(&mut BufReader::new(b"{}\n".as_slice())).expect("line"),
            Some(b"{}".to_vec())
        );
        assert_eq!(
            read_bounded_line(&mut BufReader::new(b"{}\r\n".as_slice())).expect("CRLF line"),
            Some(b"{}".to_vec())
        );
    }

    #[test]
    fn bounded_line_handles_empty_partial_exact_oversize_lf_and_crlf() {
        let read = |input: Vec<u8>| {
            let mut reader = BufReader::new(Cursor::new(input));
            read_bounded_line(&mut reader)
        };

        assert_eq!(read(Vec::new()).expect("empty EOF"), None);
        assert_eq!(
            read(b"partial".to_vec())
                .expect_err("partial EOF must be rejected")
                .kind(),
            io::ErrorKind::InvalidData
        );

        let mut exact = vec![b'x'; MAX_FRAME_BYTES - 1];
        exact.push(b'\n');
        assert_eq!(
            read(exact).expect("exact frame boundary"),
            Some(vec![b'x'; MAX_FRAME_BYTES - 1])
        );

        let mut oversized = vec![b'x'; MAX_FRAME_BYTES];
        oversized.push(b'\n');
        assert_eq!(
            read(oversized)
                .expect_err("oversized frame must be rejected")
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            read(b"line\n".to_vec()).expect("LF frame"),
            Some(b"line".to_vec())
        );
        assert_eq!(
            read(b"line\r\n".to_vec()).expect("CRLF frame"),
            Some(b"line".to_vec())
        );
    }

    #[test]
    fn asynchronous_readers_enforce_queue_and_stderr_budgets() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let queued_bytes = Arc::new(AtomicUsize::new(MAX_QUEUE_BYTES));
        spawn_stdout_reader(
            Cursor::new(b"{}\n".to_vec()),
            sender,
            Arc::clone(&queued_bytes),
        );
        assert!(matches!(
            receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("rejection"),
            FrameEvent::Rejected
        ));
        assert_eq!(queued_bytes.load(Ordering::Acquire), MAX_QUEUE_BYTES);

        let (sender, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        spawn_stdout_reader(
            Cursor::new(b"{}\n".to_vec()),
            sender,
            Arc::new(AtomicUsize::new(0)),
        );

        let saturated = Arc::new(AtomicBool::new(false));
        spawn_stderr_reader(
            Cursor::new(vec![b'x'; MAX_STDERR_BYTES + 1]),
            Arc::clone(&saturated),
        );
        let deadline = Instant::now() + Duration::from_secs(1);
        while !saturated.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(saturated.load(Ordering::Acquire));
    }

    #[test]
    fn configuration_rejects_substitution_symlinks_and_overlapping_roots() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let host = RuntimeHost::for_test(
            fixture.binary.clone(),
            fixture.home.clone(),
            fixture.work.clone(),
            "0".repeat(64),
        );
        assert_eq!(
            host.check("request", None).state,
            RuntimeReadinessState::Incompatible
        );
        let overlapping = RuntimeHost::for_test(
            fixture.binary.clone(),
            fixture.home.clone(),
            fixture.home.clone(),
            sha256_file(&fixture.binary).expect("digest"),
        );
        assert_eq!(
            overlapping.check("request", None).state,
            RuntimeReadinessState::ContainmentFailed
        );
    }

    #[test]
    fn configuration_rejects_writable_work_roots_and_unprotected_ancestors() {
        let fixture = Fixture::new();
        let valid = RuntimeConfiguration {
            binary: fixture.binary.clone(),
            codex_home: fixture.home.clone(),
            work_root: fixture.work.clone(),
            expected_sha256: sha256_file(&fixture.binary).expect("digest"),
        };
        fs::set_permissions(&fixture.work, fs::Permissions::from_mode(0o777))
            .expect("writable work root");
        assert_eq!(
            bind_configuration(&valid, None).expect_err("writable work root"),
            RuntimeReadinessState::ContainmentFailed
        );

        fs::set_permissions(&fixture.work, fs::Permissions::from_mode(0o700))
            .expect("restore private work root");
        let writable_parent = fixture.root.join("writable-parent");
        let nested_work = writable_parent.join("work");
        fs::create_dir_all(&nested_work).expect("nested work root");
        fs::set_permissions(&writable_parent, fs::Permissions::from_mode(0o777))
            .expect("writable parent");
        fs::set_permissions(&nested_work, fs::Permissions::from_mode(0o700))
            .expect("private nested work root");
        let nested = RuntimeConfiguration {
            work_root: nested_work,
            ..valid
        };
        assert_eq!(
            bind_configuration(&nested, None).expect_err("unprotected work parent"),
            RuntimeReadinessState::ContainmentFailed
        );
        fs::set_permissions(&writable_parent, fs::Permissions::from_mode(0o700))
            .expect("restore parent for fixture cleanup");

        fs::set_permissions(&fixture.home, fs::Permissions::from_mode(0o777))
            .expect("writable home");
        assert_eq!(
            bind_configuration(&nested, None).expect_err("writable Codex home"),
            RuntimeReadinessState::ContainmentFailed
        );
        fs::set_permissions(&fixture.home, fs::Permissions::from_mode(0o700))
            .expect("restore private home");

        let writable_home_parent = fixture.root.join("writable-home-parent");
        let nested_home = writable_home_parent.join("home");
        fs::create_dir_all(&nested_home).expect("nested home");
        fs::write(nested_home.join(CODEX_INSTALLATION_ID), b"installation")
            .expect("nested installation identity");
        fs::set_permissions(&writable_home_parent, fs::Permissions::from_mode(0o777))
            .expect("writable home parent");
        fs::set_permissions(&nested_home, fs::Permissions::from_mode(0o700))
            .expect("private nested home");
        let unprotected_home = RuntimeConfiguration {
            codex_home: nested_home,
            work_root: fixture.work.clone(),
            ..nested
        };
        assert_eq!(
            bind_configuration(&unprotected_home, None).expect_err("unprotected Codex home parent"),
            RuntimeReadinessState::ContainmentFailed
        );
        fs::set_permissions(&writable_home_parent, fs::Permissions::from_mode(0o700))
            .expect("restore home parent for fixture cleanup");
    }

    #[test]
    fn runtime_directory_recovery_uses_exact_process_start_identity() {
        let fixture = Fixture::new();
        let active = ActiveRuntime::default();
        let owner = process_identity(std::process::id() as i32).expect("test process identity");
        let reused_pid = ProcessIdentity {
            started_seconds: owner.started_seconds.saturating_add(1),
            ..owner
        };
        let dead = ProcessIdentity {
            process_id: i32::MAX,
            started_seconds: 1,
            started_microseconds: 0,
        };

        let live = fixture
            .work
            .join(runtime_work_directory_name("readiness", owner, 1));
        let reused = fixture
            .work
            .join(runtime_work_directory_name("readiness", reused_pid, 2));
        let orphaned_turn = fixture
            .work
            .join(runtime_work_directory_name("turn", dead, 3));
        create_private_readiness_directory(&active, &live, owner, 1)
            .expect("live runtime directory");
        create_private_readiness_directory(&active, &reused, reused_pid, 2)
            .expect("reused runtime directory");
        create_private_turn_directory(&active, &orphaned_turn, dead, 3)
            .expect("orphaned runtime directory");
        let unrelated = fixture.work.join("unrelated");
        fs::create_dir(&unrelated).expect("unrelated directory");
        recover_orphaned_runtime_directories(&fixture.work).expect("recover stale runtime work");
        assert!(live.exists());
        assert!(
            !reused.exists(),
            "same PID with a different start must be stale"
        );
        assert!(!orphaned_turn.exists());
        assert!(unrelated.exists());
        fs::remove_dir_all(&live).expect("remove live fixture");

        for invalid in [
            "other-1-1",
            "turn-",
            "turn-x-1",
            "turn-1-x",
            "turn-1-1-extra",
            "turn-0-1",
            "turn-1-0",
        ] {
            assert!(
                runtime_work_directory_coordinates(invalid, "turn").is_none(),
                "{invalid}"
            );
        }
        assert_eq!(
            runtime_work_directory_coordinates("turn-1-1", "turn").map(|value| value.1),
            Some(1)
        );
        assert!(
            runtime_work_directory_name("readiness", owner, 1).len() <= 32,
            "runtime-owned names must leave room for staged runtime state"
        );

        let malformed = fixture.work.join("readiness-invalid");
        fs::create_dir(&malformed).expect("malformed runtime directory");
        fs::set_permissions(&malformed, fs::Permissions::from_mode(0o700))
            .expect("private malformed directory");
        assert_eq!(
            recover_orphaned_runtime_directories(&fixture.work),
            Err(RuntimeReadinessState::ContainmentFailed)
        );
        fs::remove_dir(&malformed).expect("remove malformed fixture");

        let unsafe_directory = fixture
            .work
            .join(runtime_work_directory_name("turn", dead, 4));
        create_private_turn_directory(&active, &unsafe_directory, dead, 4)
            .expect("unsafe runtime directory");
        fs::set_permissions(&unsafe_directory, fs::Permissions::from_mode(0o755))
            .expect("unsafe runtime permissions");
        assert_eq!(
            recover_orphaned_runtime_directories(&fixture.work),
            Err(RuntimeReadinessState::ContainmentFailed)
        );
        fs::set_permissions(&unsafe_directory, fs::Permissions::from_mode(0o700))
            .expect("restore unsafe fixture permissions");
        fs::remove_dir_all(&unsafe_directory).expect("remove unsafe fixture");

        let removal_blocked = fixture
            .work
            .join(runtime_work_directory_name("turn", dead, 5));
        create_private_turn_directory(&active, &removal_blocked, dead, 5)
            .expect("removal-blocked runtime directory");
        fs::set_permissions(&fixture.work, fs::Permissions::from_mode(0o500))
            .expect("block work removal");
        let blocked = recover_orphaned_runtime_directories(&fixture.work);
        fs::set_permissions(&fixture.work, fs::Permissions::from_mode(0o700))
            .expect("restore work permissions");
        assert_eq!(blocked, Err(RuntimeReadinessState::ContainmentFailed));
    }

    #[test]
    fn runtime_directory_recovery_stops_an_exact_crash_survivor_before_removal() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let active = ActiveRuntime::default();
        let dead_owner = ProcessIdentity {
            process_id: i32::MAX,
            started_seconds: 1,
            started_microseconds: 0,
        };
        let work_directory = fixture
            .work
            .join(runtime_work_directory_name("turn", dead_owner, 1));
        create_private_turn_directory(&active, &work_directory, dead_owner, 1)
            .expect("crashed host work directory");
        let mut survivor = Command::new("/bin/sh")
            .arg("-c")
            .arg("trap '' TERM; /bin/sleep 30 & printf 'ready\\n'; wait")
            .process_group(0)
            .stdout(Stdio::piped())
            .spawn()
            .expect("crash-surviving runtime");
        let survivor_pid = survivor.id() as i32;
        let mut ready = String::new();
        BufReader::new(survivor.stdout.take().expect("survivor stdout"))
            .read_line(&mut ready)
            .expect("survivor readiness");
        assert_eq!(ready, "ready\n");
        assert!(
            process_group_has_live_descendants(survivor_pid, survivor_pid)
                .expect("live runtime descendants")
        );
        write_runtime_process_record(&work_directory, survivor_pid)
            .expect("persist runtime identity");
        let survivor_identity =
            runtime_process_record(&work_directory).expect("persisted runtime process identity");

        recover_orphaned_runtime_directories(&fixture.work)
            .expect("reconcile crash-surviving runtime");

        assert!(!work_directory.exists());
        assert_ne!(
            process_identity(survivor_pid),
            Some(survivor_identity),
            "the persisted runtime identity must no longer be live"
        );
        let _ = survivor.wait();
    }

    #[test]
    fn startup_reconciles_a_crash_survivor_before_constructing_the_host() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let active = ActiveRuntime::default();
        let dead_owner = ProcessIdentity {
            process_id: i32::MAX,
            started_seconds: 1,
            started_microseconds: 0,
        };
        let work_directory = fixture
            .work
            .join(runtime_work_directory_name("turn", dead_owner, 1));
        create_private_turn_directory(&active, &work_directory, dead_owner, 1)
            .expect("crashed host work directory");
        let mut survivor = Command::new("/bin/sh")
            .arg("-c")
            .arg("trap '' TERM; /bin/sleep 30 & printf 'ready\\n'; wait")
            .process_group(0)
            .stdout(Stdio::piped())
            .spawn()
            .expect("crash-surviving runtime");
        let survivor_pid = survivor.id() as i32;
        let mut ready = String::new();
        BufReader::new(survivor.stdout.take().expect("survivor stdout"))
            .read_line(&mut ready)
            .expect("survivor readiness");
        assert_eq!(ready, "ready\n");
        write_runtime_process_record(&work_directory, survivor_pid)
            .expect("persist runtime identity");
        let survivor_identity =
            runtime_process_record(&work_directory).expect("persisted runtime process identity");

        let host = RuntimeHost::from_configuration(Some(RuntimeConfiguration {
            binary: fixture.binary.clone(),
            codex_home: fixture.home.clone(),
            work_root: fixture.work.clone(),
            expected_sha256: sha256_file(&fixture.binary).expect("runtime digest"),
        }));

        assert!(host.configuration.is_some());
        assert!(!work_directory.exists());
        assert_ne!(process_identity(survivor_pid), Some(survivor_identity));
        let _ = survivor.wait();
    }

    #[test]
    fn startup_reconciliation_rejects_missing_and_non_private_work_roots() {
        let fixture = Fixture::new();
        let configuration = |work_root| RuntimeConfiguration {
            binary: fixture.binary.clone(),
            codex_home: fixture.home.clone(),
            work_root,
            expected_sha256: sha256_file(&fixture.binary).expect("runtime digest"),
        };

        assert!(!reconcile_startup_configuration(&configuration(
            fixture.root.join("missing-work-root"),
        )));

        fs::set_permissions(&fixture.work, fs::Permissions::from_mode(0o755))
            .expect("make work root non-private");
        assert!(!reconcile_startup_configuration(&configuration(
            fixture.work.clone(),
        )));
    }

    #[test]
    fn startup_reconciliation_rejects_missing_or_unprotected_work_roots() {
        let fixture = Fixture::new();
        let missing = fixture.root.join("missing-owned-directory");
        let missing_is_owned = private_directory_is_owned(&missing);

        let writable_parent = fixture.root.join("startup-writable-parent");
        let nested_work = writable_parent.join("work");
        fs::create_dir_all(&nested_work).expect("nested work root");
        fs::set_permissions(&writable_parent, fs::Permissions::from_mode(0o777))
            .expect("unprotected parent");
        fs::set_permissions(&nested_work, fs::Permissions::from_mode(0o700))
            .expect("private nested work root");
        let configuration = RuntimeConfiguration {
            binary: fixture.binary.clone(),
            codex_home: fixture.home.clone(),
            work_root: nested_work.clone(),
            expected_sha256: sha256_file(&fixture.binary).expect("runtime digest"),
        };
        let reconciled = reconcile_startup_configuration(&configuration);
        let nested_private = private_directory_is_owned(&nested_work);
        fs::set_permissions(&writable_parent, fs::Permissions::from_mode(0o700))
            .expect("restore parent before assertions");

        assert!(!missing_is_owned);
        assert!(nested_private);
        assert!(!reconciled);
        assert_eq!(
            fs::metadata(&writable_parent)
                .expect("restored parent")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }

    #[test]
    fn private_directory_metadata_rejects_files_and_wrong_owner() {
        let fixture = Fixture::new();
        let file_metadata = fs::metadata(&fixture.binary).expect("regular-file metadata");
        let directory_metadata = fs::metadata(&fixture.work).expect("private-directory metadata");
        let owner = effective_user_id();
        let wrong_owner = owner.wrapping_add(1);

        assert!(!private_owned_directory_metadata(&file_metadata, owner));
        assert_ne!(wrong_owner, directory_metadata.uid());
        assert!(!private_owned_directory_metadata(
            &directory_metadata,
            wrong_owner
        ));
    }

    #[test]
    fn runtime_owner_record_mismatch_is_removed_without_residue() {
        let fixture = Fixture::new();
        let owner = process_identity(std::process::id() as i32).expect("test process identity");
        let work_directory = fixture
            .work
            .join(runtime_work_directory_name("readiness", owner, 1));

        let outcome = create_private_runtime_directory_with(&work_directory, owner, 2, |_| Ok(()));

        assert_eq!(outcome, Err(PrivateDirectoryFailure::Unavailable));
        assert!(!work_directory.exists());
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
    }

    #[test]
    fn runtime_directory_recovery_rejects_malformed_and_ignores_reused_process_records() {
        let fixture = Fixture::new();
        let active = ActiveRuntime::default();
        let dead_owner = ProcessIdentity {
            process_id: i32::MAX,
            started_seconds: 1,
            started_microseconds: 0,
        };
        let reused_directory = fixture
            .work
            .join(runtime_work_directory_name("turn", dead_owner, 1));
        create_private_turn_directory(&active, &reused_directory, dead_owner, 1)
            .expect("reused process directory");
        let current = process_identity(std::process::id() as i32).expect("current identity");
        fs::write(
            reused_directory.join(RUNTIME_PROCESS_RECORD),
            format!(
                "{}:{}:{}\n",
                current.process_id,
                current.started_seconds.saturating_add(1),
                current.started_microseconds
            ),
        )
        .expect("reused process record");
        fs::set_permissions(
            reused_directory.join(RUNTIME_PROCESS_RECORD),
            fs::Permissions::from_mode(0o600),
        )
        .expect("private reused record");
        recover_orphaned_runtime_directories(&fixture.work)
            .expect("ignore reused process identity");
        assert!(!reused_directory.exists());

        let malformed_directory =
            fixture
                .work
                .join(runtime_work_directory_name("readiness", dead_owner, 2));
        create_private_readiness_directory(&active, &malformed_directory, dead_owner, 2)
            .expect("malformed process directory");
        fs::write(
            malformed_directory.join(RUNTIME_PROCESS_RECORD),
            b"malformed\n",
        )
        .expect("malformed process record");
        fs::set_permissions(
            malformed_directory.join(RUNTIME_PROCESS_RECORD),
            fs::Permissions::from_mode(0o600),
        )
        .expect("private malformed record");
        assert_eq!(
            recover_orphaned_runtime_directories(&fixture.work),
            Err(RuntimeReadinessState::ContainmentFailed)
        );
    }

    #[test]
    fn runtime_process_publication_rejects_a_nonleader_and_dead_identity_is_already_reconciled() {
        let fixture = Fixture::new();
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("nonleader runtime");
        let child_identity =
            process_identity(child.id() as i32).expect("nonleader runtime identity");
        assert!(
            write_runtime_process_record(&fixture.work, child.id() as i32).is_err(),
            "a process outside its own group cannot become runtime ownership"
        );
        assert!(!reconcile_orphaned_runtime_process_group(child_identity));
        assert!(!reconcile_orphaned_runtime_process_group(ProcessIdentity {
            started_microseconds: child_identity.started_microseconds.wrapping_add(1),
            ..child_identity
        }));
        let _ = child.kill();
        let _ = child.wait();
        assert!(reconcile_orphaned_runtime_process_group(ProcessIdentity {
            process_id: i32::MAX,
            started_seconds: 1,
            started_microseconds: 0,
        }));
    }

    #[test]
    fn configuration_fails_closed_for_each_path_boundary() {
        let fixture = Fixture::new();
        let valid = RuntimeConfiguration {
            binary: fixture.binary.clone(),
            codex_home: fixture.home.clone(),
            work_root: fixture.work.clone(),
            expected_sha256: sha256_file(&fixture.binary).expect("digest"),
        };

        let mut relative = valid.clone();
        relative.binary = PathBuf::from("codex");
        assert_eq!(
            bind_configuration(&relative, None).expect_err("relative binary"),
            RuntimeReadinessState::ContainmentFailed
        );

        let mut missing = valid.clone();
        missing.binary = fixture.root.join("missing");
        assert_eq!(
            bind_configuration(&missing, None).expect_err("missing binary"),
            RuntimeReadinessState::Unavailable
        );

        let binary_link = fixture.root.join("codex-link");
        symlink(&fixture.binary, &binary_link).expect("binary symlink");
        let mut linked = valid.clone();
        linked.binary = binary_link;
        assert_eq!(
            bind_configuration(&linked, None).expect_err("linked binary"),
            RuntimeReadinessState::ContainmentFailed
        );

        let mut home_is_file = valid.clone();
        home_is_file.codex_home = fixture.binary.clone();
        assert_eq!(
            bind_configuration(&home_is_file, None).expect_err("file home"),
            RuntimeReadinessState::ContainmentFailed
        );

        let mut aliased = valid.clone();
        aliased.codex_home = fixture.home.join("..").join("home");
        assert_eq!(
            bind_configuration(&aliased, None).expect_err("non-canonical alias"),
            RuntimeReadinessState::ContainmentFailed
        );

        let non_executable = fixture.root.join("not-executable");
        fs::write(&non_executable, b"runtime").expect("non-executable");
        let mut not_executable = valid.clone();
        not_executable.binary = non_executable;
        assert_eq!(
            bind_configuration(&not_executable, None).expect_err("non-executable binary"),
            RuntimeReadinessState::Unavailable
        );

        let mut directory_binary = valid.clone();
        directory_binary.binary = fixture.root.join("other-directory");
        fs::create_dir(&directory_binary.binary).expect("directory binary");
        assert_eq!(
            bind_configuration(&directory_binary, None).expect_err("directory binary"),
            RuntimeReadinessState::Unavailable
        );

        for selected_workspace in [&fixture.binary, &fixture.home, &fixture.work] {
            assert_eq!(
                bind_configuration(&valid, Some(selected_workspace))
                    .expect_err("overlapping workspace"),
                RuntimeReadinessState::ContainmentFailed
            );
        }
        assert_eq!(
            bind_configuration(&valid, Some(&fixture.root.join("missing-workspace")))
                .expect_err("missing workspace"),
            RuntimeReadinessState::ContainmentFailed
        );
    }

    #[test]
    fn verified_binary_descriptor_rejects_path_replacement_before_launch() {
        let fixture = Fixture::new();
        let configuration = RuntimeConfiguration {
            binary: fixture.binary.clone(),
            codex_home: fixture.home.clone(),
            work_root: fixture.work.clone(),
            expected_sha256: sha256_file(&fixture.binary).expect("digest"),
        };
        let mut verified = bind_configuration(&configuration, None).expect("bound");
        let original = fixture.root.join("original-codex");
        fs::rename(&fixture.binary, &original).expect("retain original inode");
        fs::write(&fixture.binary, b"replacement runtime").expect("replacement");
        let mut permissions = fs::metadata(&fixture.binary)
            .expect("replacement metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&fixture.binary, permissions).expect("replacement permissions");

        assert_eq!(
            verified.revalidate_binary(),
            Err(RuntimeReadinessState::Incompatible)
        );
    }

    #[test]
    fn verified_binary_revalidation_detects_drift_and_substitution() {
        let valid_fixture = Fixture::new();
        let valid_configuration = RuntimeConfiguration {
            binary: valid_fixture.binary.clone(),
            codex_home: valid_fixture.home.clone(),
            work_root: valid_fixture.work.clone(),
            expected_sha256: sha256_file(&valid_fixture.binary).expect("valid digest"),
        };
        let mut valid = bind_configuration(&valid_configuration, None).expect("valid binding");
        assert_eq!(valid.revalidate_binary(), Ok(()));
        let wrong_digest_configuration = RuntimeConfiguration {
            expected_sha256: "0".repeat(64),
            ..valid_configuration
        };
        let mut wrong_digest =
            bind_configuration(&wrong_digest_configuration, None).expect("wrong digest binding");
        assert_eq!(
            wrong_digest.revalidate_binary(),
            Err(RuntimeReadinessState::Incompatible)
        );

        let drift_fixture = Fixture::new();
        let drift_configuration = RuntimeConfiguration {
            binary: drift_fixture.binary.clone(),
            codex_home: drift_fixture.home.clone(),
            work_root: drift_fixture.work.clone(),
            expected_sha256: sha256_file(&drift_fixture.binary).expect("drift digest"),
        };
        let drifted = bind_configuration(&drift_configuration, None).expect("drift binding");
        fs::write(&drift_fixture.binary, b"changed runtime content")
            .expect("change verified descriptor content");
        assert_eq!(
            drifted.revalidate_binary_identity(),
            Err(RuntimeReadinessState::Incompatible)
        );

        let symlink_fixture = Fixture::new();
        let symlink_configuration = RuntimeConfiguration {
            binary: symlink_fixture.binary.clone(),
            codex_home: symlink_fixture.home.clone(),
            work_root: symlink_fixture.work.clone(),
            expected_sha256: sha256_file(&symlink_fixture.binary).expect("symlink digest"),
        };
        let substituted =
            bind_configuration(&symlink_configuration, None).expect("symlink binding");
        let original = symlink_fixture.root.join("verified-codex");
        fs::rename(&symlink_fixture.binary, &original).expect("retain verified binary");
        symlink(&original, &symlink_fixture.binary).expect("substitute binary symlink");
        assert_eq!(
            substituted.revalidate_binary_identity(),
            Err(RuntimeReadinessState::Incompatible)
        );
    }

    #[test]
    fn staged_runtime_is_copied_from_the_verified_descriptor() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let _host = fixture.scripted_host("#!/bin/sh\nprintf 'verified\\n'\n");
        let expected = sha256_file(&fixture.binary).expect("approved digest");
        let configuration = RuntimeConfiguration {
            binary: fixture.binary.clone(),
            codex_home: fixture.home.clone(),
            work_root: fixture.work.clone(),
            expected_sha256: expected.clone(),
        };
        let mut verified = bind_configuration(&configuration, None).expect("bound");
        let stage_root = fixture.work.join("stage-test");
        fs::create_dir(&stage_root).expect("stage root");
        let executable = verified
            .stage_verified_binary(&stage_root)
            .expect("verified staged executable");

        fs::write(&fixture.binary, "#!/bin/sh\nprintf 'replacement\\n'\n")
            .expect("replace installation path");
        fs::set_permissions(&fixture.binary, fs::Permissions::from_mode(0o700))
            .expect("replacement mode");
        let output = Command::new(executable.path())
            .output()
            .expect("execute staged runtime");
        assert_eq!(output.stdout, b"verified\n");
    }

    #[test]
    fn suspended_exec_validation_requires_the_exact_runtime_cdhash() {
        assert_eq!(CODEX_RUNTIME_CDHASH.len(), 20);
        assert!(wait_status_is_exec_stop((SIGTRAP << 8) | 0x7f));
        assert!(!wait_status_is_exec_stop(0));
        let mut substituted = CODEX_RUNTIME_CDHASH;
        substituted[0] ^= 0xff;
        assert_ne!(substituted, CODEX_RUNTIME_CDHASH);
    }

    #[test]
    fn staged_runtime_validation_rejects_each_artifact_drift_class() {
        let fixture = Fixture::new();
        let executable = fs::metadata(&fixture.binary).expect("executable metadata");
        let non_executable_path = fixture.root.join("non-executable-stage");
        fs::write(&non_executable_path, b"stage").expect("non-executable stage");
        let non_executable = fs::metadata(non_executable_path).expect("non-executable metadata");
        let directory = fs::metadata(&fixture.home).expect("directory metadata");

        assert!(!staged_file_valid(&directory, "digest", "digest"));
        assert!(!staged_file_valid(&non_executable, "digest", "digest"));
        assert!(!staged_file_valid(&executable, "wrong", "digest"));
        assert!(staged_file_valid(&executable, "digest", "digest"));
    }

    #[test]
    fn host_rejects_concurrency_honours_pre_cancel_and_preserves_collisions() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let host = fixture.scripted_host("#!/bin/sh\nexit 0\n");
        host.active.running.store(true, Ordering::Release);
        assert_eq!(
            host.check("concurrent", None).state,
            RuntimeReadinessState::ContainmentFailed
        );
        host.active.running.store(false, Ordering::Release);
        host.cancel_request("different-request");
        *host
            .active
            .process_group
            .lock()
            .expect("process-group state") = Some(unavailable_process_identity(i32::MAX));
        host.cancel_for_renderer_loss();
        *host
            .active
            .process_group
            .lock()
            .expect("process-group state") = None;

        let configuration = host.configuration.as_ref().expect("configuration");
        let active = ActiveRuntime::default();
        active.running.store(true, Ordering::Release);
        active.cancel(RuntimeCancellation::RendererLost);
        assert_eq!(
            perform_check(
                configuration,
                None,
                &active,
                &AtomicU64::new(0),
                Instant::now() + DEFAULT_REQUEST_TIMEOUT,
            )
            .state,
            RuntimeReadinessState::Cancelled
        );

        let owner = process_identity(std::process::id() as i32).expect("test process identity");
        let collision = fixture
            .work
            .join(runtime_work_directory_name("readiness", owner, 1));
        create_private_readiness_directory(&active, &collision, owner, 1).expect("collision");
        assert_eq!(
            host.check("collision", None).state,
            RuntimeReadinessState::Unavailable
        );
    }

    #[test]
    fn request_scoped_cancel_survives_registration_gap_without_leaking_to_retry() {
        let host = RuntimeHost {
            configuration: None,
            active: Arc::new(ActiveRuntime::default()),
            work_generation: Arc::new(AtomicU64::new(0)),
            invalidated_workspace_generation: Arc::new(AtomicU64::new(0)),
        };
        host.active.running.store(true, Ordering::Release);
        host.cancel_request("request-in-registration");
        assert!(host.active.begin_request("request-in-registration"));
        assert_eq!(host.active.cancellation(), Some(RuntimeCancellation::User));
        host.active.finish_request();
        host.active.running.store(false, Ordering::Release);

        host.active.running.store(true, Ordering::Release);
        assert!(host.active.begin_request("fresh-retry"));
        assert_eq!(host.active.cancellation(), None);
        host.cancel_request("wrong-request");
        assert_eq!(host.active.cancellation(), None);
        host.active.finish_request();
        host.active.running.store(false, Ordering::Release);
    }

    #[test]
    fn inactive_cancel_preserves_the_first_pending_request() {
        let host = RuntimeHost {
            configuration: None,
            active: Arc::new(ActiveRuntime::default()),
            work_generation: Arc::new(AtomicU64::new(0)),
            invalidated_workspace_generation: Arc::new(AtomicU64::new(0)),
        };

        host.cancel_request("pending-a");
        let first = host.active.control.lock().expect("first pending cancel");
        let first_pending = first.pending_request_id.clone();
        let first_cancellation = first.cancellation;
        drop(first);

        host.cancel_request("inactive-b");
        let second = host
            .active
            .control
            .lock()
            .expect("preserved pending cancel");
        let second_pending = second.pending_request_id.clone();
        let second_cancellation = second.cancellation;
        drop(second);

        assert_eq!(first_pending.as_deref(), Some("pending-a"));
        assert_eq!(first_cancellation, Some(RuntimeCancellation::User));
        assert_eq!(second_pending, first_pending);
        assert_eq!(second_cancellation, first_cancellation);
        assert!(!host.active.running.load(Ordering::Acquire));
        assert_eq!(
            *host.active.process_group.lock().expect("process group"),
            None
        );
    }

    #[test]
    fn runtime_request_rejects_application_health_and_reports_unavailable_runtime() {
        let mut lifecycle = HostLifecycle::default();
        let document_nonce = "a".repeat(64);
        let generation = lifecycle
            .begin_renderer_session(document_nonce.clone())
            .expect("renderer generation");
        let sender =
            lifecycle.sender_for_document("main", "tauri://localhost", generation, &document_nonce);
        let lifecycle = Mutex::new(lifecycle);
        let runtime = RuntimeHost {
            configuration: None,
            active: Arc::new(ActiveRuntime::default()),
            work_generation: Arc::new(AtomicU64::new(0)),
            invalidated_workspace_generation: Arc::new(AtomicU64::new(0)),
        };
        let health = r#"{"schemaVersion":1,"requestId":"request-0000000000000001-0000000000000001","sequence":1,"timeoutMs":1000,"operation":{"kind":"application-health"}}"#;
        let readiness = r#"{"schemaVersion":1,"requestId":"request-0000000000000001-0000000000000002","sequence":2,"timeoutMs":1000,"operation":{"kind":"runtime-readiness"}}"#;

        let health_output = runtime_request(&lifecycle, &runtime, &sender, None, health);
        let health_value: Value =
            serde_json::from_str(&health_output.encoded).expect("health rejection");
        let generation_after_health = runtime.work_generation.load(Ordering::Acquire);
        let running_after_health = runtime.active.running.load(Ordering::Acquire);
        let control_after_health = runtime.active.control.lock().expect("runtime control");
        let request_after_health = control_after_health.request_id.clone();
        let pending_after_health = control_after_health.pending_request_id.clone();
        drop(control_after_health);

        let readiness_output = runtime_request(&lifecycle, &runtime, &sender, None, readiness);
        let readiness_value: Value =
            serde_json::from_str(&readiness_output.encoded).expect("readiness response");

        assert_eq!(
            health_value.pointer("/error/code"),
            Some(&json!("unknown-operation"))
        );
        assert_eq!(
            health_value.get("requestId"),
            Some(&json!("unknown-request"))
        );
        assert_eq!(generation_after_health, 0);
        assert!(!running_after_health);
        assert_eq!(request_after_health, None);
        assert_eq!(pending_after_health, None);
        assert_eq!(
            readiness_value.get("requestId"),
            Some(&json!("request-0000000000000001-0000000000000002"))
        );
        assert_eq!(
            readiness_value.pointer("/result/kind"),
            Some(&json!("runtime-readiness"))
        );
        assert_eq!(
            readiness_value.pointer("/result/state/state"),
            Some(&json!("unavailable"))
        );
        assert_eq!(runtime.work_generation.load(Ordering::Acquire), 0);
        assert!(!runtime.active.running.load(Ordering::Acquire));
    }

    #[test]
    fn first_observed_shutdown_reason_wins_for_the_active_request() {
        let active = ActiveRuntime::default();
        active.running.store(true, Ordering::Release);
        active.cancel(RuntimeCancellation::AppShutdown);
        assert!(active.begin_request("request"));
        active.cancel(RuntimeCancellation::RendererLost);
        active.cancel(RuntimeCancellation::User);
        assert_eq!(
            active.cancellation(),
            Some(RuntimeCancellation::AppShutdown)
        );
    }

    #[test]
    fn retired_process_group_refuses_every_late_signal() {
        let active = ActiveRuntime::default();
        let unavailable = unavailable_process_identity(i32::MAX);
        *active.process_group.lock().expect("process-group state") = Some(unavailable);
        let mismatched = ProcessIdentity {
            started_seconds: unavailable.started_seconds.wrapping_add(1),
            ..unavailable
        };
        assert!(!retire_active_process_group(&active, mismatched));
        assert_eq!(
            *active.process_group.lock().expect("process-group state"),
            Some(unavailable)
        );
        assert!(retire_active_process_group(&active, unavailable));
        assert!(!signal_active_process_group(&active, i32::MAX, SIGTERM));
        assert!(!signal_active_process_group(&active, i32::MAX, SIGKILL));
        assert!(!signal_active_descendants(&active, i32::MAX, SIGKILL));

        let poisoned = Arc::new(ActiveRuntime::default());
        let poison_target = Arc::clone(&poisoned);
        let _ = thread::spawn(move || {
            let _guard = poison_target
                .process_group
                .lock()
                .expect("process group before poisoning");
            panic!("poison process group");
        })
        .join();
        assert!(!signal_active_process_group(&poisoned, i32::MAX, SIGTERM));
        assert!(!signal_active_descendants(&poisoned, i32::MAX, SIGKILL));
        assert!(!refresh_owned_processes(&poisoned));
        assert_eq!(owned_descendants_alive(&poisoned, i32::MAX), None);
        assert!(!retire_active_process_group(&poisoned, unavailable));

        let poisoned_owned = Arc::new(ActiveRuntime::default());
        *poisoned_owned
            .process_group
            .lock()
            .expect("process group before owned poisoning") =
            Some(unavailable_process_identity(i32::MAX));
        let poison_target = Arc::clone(&poisoned_owned);
        let _ = thread::spawn(move || {
            let _guard = poison_target
                .owned_processes
                .lock()
                .expect("owned process state before poisoning");
            panic!("poison owned process state");
        })
        .join();
        assert!(!refresh_owned_processes(&poisoned_owned));
        assert!(!signal_active_descendants(
            &poisoned_owned,
            i32::MAX,
            SIGKILL
        ));
    }

    #[test]
    fn reused_retained_process_group_identity_is_retired_without_signalling() {
        let active = ActiveRuntime::default();
        let current = process_identity(std::process::id() as i32).expect("current identity");
        let reused = ProcessIdentity {
            started_microseconds: current.started_microseconds.wrapping_add(1),
            ..current
        };
        *active.process_group.lock().expect("process-group state") = Some(reused);

        assert!(!signal_active_process_group(
            &active,
            current.process_id,
            SIGTERM
        ));
        assert_eq!(
            *active.process_group.lock().expect("process-group state"),
            None
        );
    }

    #[test]
    fn authenticated_signal_refuses_another_owned_process_group() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut first = Command::new("/bin/sh")
            .arg("-c")
            .arg("trap 'exit 0' TERM INT; printf 'ready\\n'; read -r line")
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("first owned process group");
        let second_spawn = Command::new("/bin/sh")
            .arg("-c")
            .arg("trap 'exit 0' TERM INT; printf 'ready\\n'; read -r line")
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn();
        let second_spawned = second_spawn.is_ok();
        let mut second = second_spawn.ok();
        let first_group = first.id() as i32;
        let second_group = second.as_ref().map(|child| child.id() as i32);
        let first_stdin = first.stdin.take();
        let second_stdin = second.as_mut().and_then(|child| child.stdin.take());
        let mut first_stdout = first.stdout.take().map(BufReader::new);
        let mut second_stdout = second
            .as_mut()
            .and_then(|child| child.stdout.take())
            .map(BufReader::new);
        let mut first_ready = String::new();
        let mut second_ready = String::new();
        let first_handshake = first_stdout
            .as_mut()
            .map(|stdout| stdout.read_line(&mut first_ready));
        let second_handshake = second_stdout
            .as_mut()
            .map(|stdout| stdout.read_line(&mut second_ready));

        let first_active = ActiveRuntime::default();
        let second_active = ActiveRuntime::default();
        let first_published = publish_active_process_group(&first_active, first_group);
        let second_published =
            second_group.is_some_and(|group| publish_active_process_group(&second_active, group));
        let first_identity = first_active
            .process_group
            .lock()
            .ok()
            .and_then(|group| *group);
        let second_identity = second_active
            .process_group
            .lock()
            .ok()
            .and_then(|group| *group);
        let group_refused = second_group
            .is_some_and(|group| !signal_active_process_group(&first_active, group, SIGTERM));
        let descendants_refused = second_group
            .is_some_and(|group| !signal_active_descendants(&first_active, group, SIGKILL));
        let first_retained = first_active
            .process_group
            .lock()
            .ok()
            .and_then(|group| *group);
        let second_retained = second_active
            .process_group
            .lock()
            .ok()
            .and_then(|group| *group);
        let first_still_current = first_identity.is_some_and(|identity| {
            retained_process_identity_status(identity) == RetainedProcessIdentityStatus::Current
        });
        let second_still_current = second_identity.is_some_and(|identity| {
            retained_process_identity_status(identity) == RetainedProcessIdentityStatus::Current
        });

        let first_signalled = signal_active_process_group(&first_active, first_group, SIGTERM);
        let second_signalled = second_group
            .is_some_and(|group| signal_active_process_group(&second_active, group, SIGTERM));
        drop(first_stdin);
        drop(second_stdin);
        let first_graceful_exit = bounded_owned_child_exit(&mut first);
        let second_graceful_exit = second.as_mut().map(bounded_owned_child_exit);
        let _ = first.kill();
        let _ = second.as_mut().map(Child::kill);
        let first_waited = first_graceful_exit | bounded_owned_child_exit(&mut first);
        let second_waited = second_graceful_exit
            .zip(second.as_mut().map(bounded_owned_child_exit))
            .map(|(graceful, killed)| graceful | killed);
        let first_absent = !process_group_exists(first_group);
        let second_absent = second_group.map(|group| !process_group_exists(group));
        let first_cleanup_retired = first_identity
            .is_some_and(|identity| retire_active_process_group(&first_active, identity));
        let second_cleanup_retired = second_identity
            .is_some_and(|identity| retire_active_process_group(&second_active, identity));
        let first_group_cleared = first_active
            .process_group
            .lock()
            .is_ok_and(|group| group.is_none());
        let first_owned_cleared = first_active
            .owned_processes
            .lock()
            .is_ok_and(|owned| owned.is_empty());
        let second_group_cleared = second_active
            .process_group
            .lock()
            .is_ok_and(|group| group.is_none());
        let second_owned_cleared = second_active
            .owned_processes
            .lock()
            .is_ok_and(|owned| owned.is_empty());

        assert!(second_spawned);
        assert_eq!(
            first_handshake
                .expect("first readiness pipe")
                .expect("first readiness handshake"),
            6
        );
        assert_eq!(
            second_handshake
                .expect("second readiness pipe")
                .expect("second readiness handshake"),
            6
        );
        assert_eq!(first_ready, "ready\n");
        assert_eq!(second_ready, "ready\n");
        assert_ne!(Some(first_group), second_group);
        assert!(first_published);
        assert!(second_published);
        assert!(first_identity.is_some());
        assert!(second_identity.is_some());
        assert!(group_refused);
        assert!(descendants_refused);
        assert_eq!(first_retained, first_identity);
        assert_eq!(second_retained, second_identity);
        assert!(first_still_current);
        assert!(second_still_current);
        assert!(first_signalled);
        assert!(second_signalled);
        assert!(first_waited);
        assert_eq!(second_waited, Some(true));
        assert!(first_absent);
        assert_eq!(second_absent, Some(true));
        assert!(first_cleanup_retired);
        assert!(second_cleanup_retired);
        assert!(first_group_cleared);
        assert!(first_owned_cleared);
        assert!(second_group_cleared);
        assert!(second_owned_cleared);
    }

    #[test]
    fn process_identity_and_child_count_validation_fail_closed() {
        let process = 41;
        let buffer_size = std::mem::size_of::<ProcessBsdInformation>() as i32;
        let valid = ProcessBsdInformation {
            process_id: process as u32,
            started_microseconds: 7,
            started_seconds: 11,
            ..ProcessBsdInformation::default()
        };
        assert!(identity_from_information(process, &valid).is_some());
        let zombie = ProcessBsdInformation {
            status: PROCESS_STATUS_ZOMBIE,
            ..valid
        };
        assert_eq!(identity_from_information(process, &zombie), None);

        let mismatched = ProcessBsdInformation {
            process_id: (process + 1) as u32,
            ..ProcessBsdInformation::default()
        };
        assert!(
            validated_process_information(process, buffer_size, buffer_size, mismatched).is_none()
        );
        assert!(
            validated_process_information(
                process,
                buffer_size - 1,
                buffer_size,
                ProcessBsdInformation::default(),
            )
            .is_none()
        );
        assert!(process_information(0).is_none());
        assert!(child_processes(0).is_err());
        assert!(validated_child_count(-1, 512).is_err());
        assert!(validated_child_count(512, 512).is_err());
        assert_eq!(validated_child_count(0, 512).expect("empty child list"), 0);
    }

    #[test]
    fn known_owned_process_status_requires_positive_absence_proof() {
        assert_eq!(
            classify_known_owned_process(RetainedProcessIdentityStatus::Current, || Ok(false)),
            KnownOwnedProcessStatus::Alive
        );
        assert_eq!(
            classify_known_owned_process(RetainedProcessIdentityStatus::Reused, || Ok(true)),
            KnownOwnedProcessStatus::Stopped
        );
        assert_eq!(
            classify_known_owned_process(RetainedProcessIdentityStatus::Unavailable, || Ok(false)),
            KnownOwnedProcessStatus::Stopped
        );
        assert_eq!(
            classify_known_owned_process(RetainedProcessIdentityStatus::Unavailable, || Ok(true)),
            KnownOwnedProcessStatus::Unavailable
        );
        assert_eq!(
            classify_known_owned_process(RetainedProcessIdentityStatus::Unavailable, || {
                Err(io::Error::from_raw_os_error(1))
            }),
            KnownOwnedProcessStatus::Unavailable
        );
    }

    #[test]
    fn process_presence_status_requires_exact_esrch_for_absence() {
        assert_eq!(
            classify_process_presence(0, None),
            ProcessPresenceStatus::Present
        );
        assert_eq!(
            classify_process_presence(-1, Some(MACOS_ESRCH)),
            ProcessPresenceStatus::Absent
        );
        assert_eq!(
            classify_process_presence(-1, Some(1)),
            ProcessPresenceStatus::Unavailable
        );
        assert_eq!(
            classify_process_presence(-1, None),
            ProcessPresenceStatus::Unavailable
        );
    }

    #[test]
    fn unavailable_known_owned_identity_is_retained_fail_closed() {
        let active = ActiveRuntime::default();
        let unavailable = ProcessIdentity {
            process_id: 0,
            started_microseconds: 7,
            started_seconds: 11,
        };
        active
            .owned_processes
            .lock()
            .expect("owned process state")
            .insert(unavailable);

        assert!(!authenticated_owned_processes_stopped(&active));
        assert!(
            active
                .owned_processes
                .lock()
                .expect("retained owned process state")
                .contains(&unavailable)
        );
        assert!(process_presence(unavailable.process_id).is_err());
    }

    #[test]
    fn unavailable_host_and_unspawnable_runtime_are_distinct() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let unavailable = RuntimeHost {
            configuration: None,
            active: Arc::new(ActiveRuntime::default()),
            work_generation: Arc::new(AtomicU64::new(0)),
            invalidated_workspace_generation: Arc::new(AtomicU64::new(0)),
        };
        assert_eq!(
            unavailable.check("unconfigured", None).state,
            RuntimeReadinessState::Unavailable
        );
        unavailable.cancel_for_renderer_loss();

        let fixture = Fixture::new();
        let unspawnable = RuntimeHost::for_test(
            fixture.binary.clone(),
            fixture.home.clone(),
            fixture.work.clone(),
            sha256_file(&fixture.binary).expect("digest"),
        );
        assert_eq!(
            unspawnable.check("unspawnable", None).state,
            RuntimeReadinessState::Incompatible
        );
    }

    #[test]
    fn retained_runtime_ownership_blocks_every_new_request() {
        let host = RuntimeHost::unavailable_for_test();
        *host
            .active
            .process_group
            .lock()
            .expect("process-group state") = Some(unavailable_process_identity(i32::MAX));

        assert_eq!(
            host.check("blocked-readiness", None).state,
            RuntimeReadinessState::ContainmentFailed
        );
        let turn = host.run_turn(
            "blocked-turn",
            1,
            &WorkspaceRuntimeBinding::for_test(Path::new("/private/tmp/unused-workspace")),
            "Bounded task.",
            Duration::from_millis(10),
            |_| {},
        );
        assert_eq!(turn.state, TurnState::ContainmentFailed);
        assert_eq!(
            *host
                .active
                .process_group
                .lock()
                .expect("process-group state"),
            Some(unavailable_process_identity(i32::MAX))
        );
        assert!(!host.active.running.load(Ordering::Acquire));
    }

    #[test]
    fn retained_work_directories_are_retried_before_the_next_request() {
        let fixture = Fixture::new();
        let retained = fixture.work.join("turn-42-1");
        fs::create_dir(&retained).expect("retained work directory");
        let active = ActiveRuntime::default();
        fs::set_permissions(&fixture.work, fs::Permissions::from_mode(0o500))
            .expect("block retained work removal");
        assert!(!cleanup_or_retain_work_directory(&active, &retained));
        fs::set_permissions(&fixture.work, fs::Permissions::from_mode(0o700))
            .expect("restore work permissions");

        assert!(
            active
                .retained_work_directories
                .lock()
                .expect("retained work set")
                .contains(&retained)
        );
        assert!(active.claim_request("retry-cleanup"));
        assert!(!retained.exists());
        active.finish_request();
    }

    #[test]
    fn poisoned_runtime_ownership_gate_fails_closed() {
        let active = Arc::new(ActiveRuntime::default());
        let poison_target = Arc::clone(&active);
        let _ = thread::spawn(move || {
            let _guard = poison_target
                .process_group
                .lock()
                .expect("process-group state before poisoning");
            panic!("poison process-group ownership");
        })
        .join();

        assert!(!active.claim_request("blocked-by-poison"));
        assert!(!active.running.load(Ordering::Acquire));
    }

    #[test]
    fn runtime_child_limit_denies_forks_before_exec() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("/usr/bin/true & wait")
            .stderr(Stdio::null());
        // SAFETY: the child applies only the fixed process limit before exec.
        unsafe {
            command.pre_exec(deny_runtime_forks);
        }
        let status = command.status().expect("limited child started");
        assert!(!status.success(), "runtime child unexpectedly forked");
    }

    #[test]
    fn poisoned_request_bookkeeping_still_fails_closed() {
        let host = RuntimeHost {
            configuration: None,
            active: Arc::new(ActiveRuntime::default()),
            work_generation: Arc::new(AtomicU64::new(0)),
            invalidated_workspace_generation: Arc::new(AtomicU64::new(0)),
        };
        let active = Arc::clone(&host.active);
        let _ = thread::spawn(move || {
            let _guard = active.control.lock().expect("request bookkeeping");
            panic!("poison request bookkeeping");
        })
        .join();

        assert_eq!(
            host.check("poisoned-bookkeeping", None).state,
            RuntimeReadinessState::ContainmentFailed
        );
        assert_eq!(
            host.active
                .cancellation()
                .map(RuntimeCancellation::turn_reason),
            Some(TurnReason::InternalFailure),
            "poisoned runtime control must not masquerade as renderer loss"
        );
        host.cancel_request("poisoned-bookkeeping");
        assert!(!host.cancel_for_app_shutdown_and_wait());
        host.active.running.store(true, Ordering::Release);
        host.active.finish_request();
        assert!(!host.active.running.load(Ordering::Acquire));
    }

    #[test]
    fn poisoned_runtime_control_is_containment_failure_for_readiness_and_turns() {
        let fixture = Fixture::new();
        let host = fixture.scripted_host("#!/bin/sh\nexit 0\n");
        let active = Arc::new(ActiveRuntime::default());
        let poison_target = Arc::clone(&active);
        let _ = thread::spawn(move || {
            let _guard = poison_target
                .control
                .lock()
                .expect("runtime control before poisoning");
            panic!("poison runtime control");
        })
        .join();
        let configuration = host.configuration.as_ref().expect("configuration");

        let readiness = perform_check(
            configuration,
            None,
            &active,
            &AtomicU64::new(0),
            Instant::now() + DEFAULT_REQUEST_TIMEOUT,
        );
        assert_eq!(readiness.state, RuntimeReadinessState::ContainmentFailed);

        let mut updates = Vec::new();
        let turn = perform_turn(
            configuration,
            &WorkspaceRuntimeBinding::for_test(&fixture.root),
            "Bounded task.",
            &active,
            &AtomicU64::new(0),
            Instant::now() + DEFAULT_REQUEST_TIMEOUT,
            &mut |update| updates.push(update),
        );
        assert_eq!(turn.state, TurnState::ContainmentFailed);
        assert_eq!(turn.reason, Some(TurnReason::InternalFailure));
        assert!(updates.is_empty());
    }

    #[test]
    fn fake_runtime_proves_ready_only_after_cleanup_and_exports_no_live_state() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let home = fixture.home.to_string_lossy();
        let host = fixture.scripted_host(&format!(
            r#"#!/bin/sh
read -r initialize
printf '%s\n' '{{"id":1,"result":{{"userAgent":"codex_cli_rs/0.145.0","codexHome":"{home}","platformFamily":"unix","platformOs":"macos"}}}}'
read -r initialized
read -r account
/bin/sleep 30 &
printf '%s\n' '{{"id":2,"result":{{"account":{{"type":"chatgpt","email":"redacted","planType":"plus"}},"requiresOpenaiAuth":true}}}}'
wait
"#
        ));
        let result = host.check("request-ready", None);
        assert_eq!(result.state, RuntimeReadinessState::Ready);
        assert!(result.descriptor.is_some());
        let encoded = serde_json::to_string(&result).expect("view");
        for prohibited in [
            fixture.root.to_string_lossy().as_ref(),
            "redacted-account-value",
            "process",
            "pid",
        ] {
            assert!(!encoded.contains(prohibited), "{prohibited}");
        }
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
        assert!(!host.active.running.load(Ordering::Acquire));
        assert_eq!(
            *host.active.process_group.lock().expect("process group"),
            None
        );
    }

    #[test]
    fn fake_runtime_distinguishes_auth_and_rejects_provider_effect_requests() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let home = fixture.home.to_string_lossy();
        let missing_auth = fixture.scripted_host(&format!(
            r#"#!/bin/sh
read -r initialize
printf '%s\n' '{{"id":1,"result":{{"userAgent":"codex_cli_rs/0.145.0","codexHome":"{home}","platformFamily":"unix","platformOs":"macos"}}}}'
read -r initialized
read -r account
printf '%s\n' '{{"id":2,"result":{{"account":null,"requiresOpenaiAuth":true}}}}'
"#
        ));
        assert_eq!(
            missing_auth.check("request-auth", None).state,
            RuntimeReadinessState::AuthenticationRequired
        );

        let effect_request = fixture.scripted_host(
            r#"#!/bin/sh
read -r initialize
printf '%s\n' '{"method":"item/tool/call","id":7,"params":{"path":"/private/secret"}}'
"#,
        );
        assert_eq!(
            effect_request.check("request-effect", None).state,
            RuntimeReadinessState::ContainmentFailed
        );
    }

    fn valid_turn_thread_response() -> Value {
        json!({
            "id": 3,
            "result": {
                "thread": {
                    "id": "thread-1",
                    "ephemeral": true,
                    "path": null,
                    "gitInfo": null,
                    "parentThreadId": null,
                    "cwd": "/private/tmp/codex-work",
                    "canAcceptDirectInput": true
                },
                "runtimeWorkspaceRoots": [],
                "instructionSources": [],
                "approvalPolicy": "never",
                "approvalsReviewer": "user",
                "activePermissionProfile": null,
                "multiAgentMode": "explicitRequestOnly",
                "cwd": "/private/tmp/codex-work"
            }
        })
    }

    fn active_turn_projection<'a>(home: &'a Path, work: &'a Path) -> TurnProtocolProjection<'a> {
        let mut projection = TurnProtocolProjection::new(home, work);
        projection.stage = TurnProjectionStage::Active;
        projection.thread_id = Some("thread-1".to_owned());
        projection.turn_id = Some("turn-1".to_owned());
        projection.streaming_announced = true;
        projection
    }

    #[test]
    fn token_usage_and_non_agent_items_fail_closed() {
        let breakdown = json!({
            "cachedInputTokens": 0,
            "inputTokens": 12,
            "outputTokens": 3,
            "reasoningOutputTokens": 0,
            "totalTokens": 15
        });
        for usage in [
            json!({"last": breakdown, "modelContextWindow": null, "total": breakdown}),
            json!({"last": breakdown, "modelContextWindow": 128_000, "total": breakdown}),
        ] {
            assert!(token_usage_is_bounded(Some(&usage)), "{usage}");
        }
        for usage in [
            json!({"last": breakdown, "modelContextWindow": 128_000, "total": breakdown, "unknown": true}),
            json!({"last": breakdown, "modelContextWindow": (i64::MAX as u64) + 1, "total": breakdown}),
            json!({"last": breakdown, "modelContextWindow": "unknown", "total": breakdown}),
        ] {
            assert!(!token_usage_is_bounded(Some(&usage)), "{usage}");
        }

        let home = Path::new("/private/tmp/codex-home");
        let work = Path::new("/private/tmp/codex-work");
        let started = json!({
            "method": "item/started",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {"id": "reasoning-1", "type": "reasoning"}
            }
        });
        let completed = json!({
            "method": "item/completed",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {"id": "reasoning-1", "type": "reasoning"}
            }
        });
        let mut valid = active_turn_projection(home, work);
        assert_eq!(
            valid.accept(&serde_json::to_vec(&started).expect("started item")),
            TurnProjectionAction::Quarantine
        );
        assert_eq!(
            valid.accept(&serde_json::to_vec(&completed).expect("completed item")),
            TurnProjectionAction::Quarantine
        );
        assert_eq!(
            valid.started_items.get("reasoning-1"),
            Some(&InertItemKind::Reasoning)
        );
        assert!(valid.completed_items.contains("reasoning-1"));

        let mut mismatched = active_turn_projection(home, work);
        assert_eq!(
            mismatched.accept(&serde_json::to_vec(&started).expect("mismatch start")),
            TurnProjectionAction::Quarantine
        );
        let mut wrong_completion = completed;
        wrong_completion["params"]["item"]["type"] = json!("plan");
        assert_turn_containment(
            mismatched
                .accept(&serde_json::to_vec(&wrong_completion).expect("mismatched completion")),
            TurnReason::ProtocolRejected,
        );
    }

    fn assert_turn_containment(action: TurnProjectionAction, reason: TurnReason) {
        assert_eq!(
            action,
            TurnProjectionAction::Terminal(TurnState::ContainmentFailed, reason)
        );
    }

    #[test]
    fn turn_projection_rejects_malformed_stage_and_thread_contract_drift() {
        let home = Path::new("/private/tmp/codex-home");
        let work = Path::new("/private/tmp/codex-work");
        for frame in [b"{".as_slice(), b"[]".as_slice()] {
            assert_turn_containment(
                TurnProtocolProjection::new(home, work).accept(frame),
                TurnReason::ProtocolRejected,
            );
        }

        let mut invalid_initialize = TurnProtocolProjection::new(home, work);
        assert_turn_containment(
            invalid_initialize.accept(br#"{"id":1,"result":{}}"#),
            TurnReason::ProtocolRejected,
        );

        let mut unauthenticated = TurnProtocolProjection::new(home, work);
        unauthenticated.stage = TurnProjectionStage::Account;
        assert_eq!(
            unauthenticated
                .accept(br#"{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}"#),
            TurnProjectionAction::Terminal(TurnState::Failed, TurnReason::AuthenticationRequired)
        );
        let mut invalid_account = TurnProtocolProjection::new(home, work);
        invalid_account.stage = TurnProjectionStage::Account;
        assert_turn_containment(
            invalid_account.accept(br#"{"id":2,"result":{}}"#),
            TurnReason::ProtocolRejected,
        );

        for stage in [TurnProjectionStage::Active, TurnProjectionStage::Terminal] {
            let mut projection = TurnProtocolProjection::new(home, work);
            projection.stage = stage;
            assert_turn_containment(
                projection.accept(br#"{"id":9,"result":{}}"#),
                TurnReason::ProtocolRejected,
            );
        }

        let protocol_drift = [
            json!({"id": 9, "result": {}}),
            json!({"id": 3}),
            json!({"id": 3, "result": {}, "extra": true}),
            json!({"id": 3, "result": []}),
            json!({"id": 3, "result": {}}),
            json!({"id": 3, "result": {"thread": []}}),
            json!({"id": 3, "result": {"thread": {}}}),
        ];
        for response in protocol_drift {
            let mut projection = TurnProtocolProjection::new(home, work);
            projection.stage = TurnProjectionStage::Thread;
            assert_turn_containment(
                projection.accept(&serde_json::to_vec(&response).unwrap()),
                TurnReason::ProtocolRejected,
            );
        }

        let mut unsafe_responses = Vec::new();
        for (pointer, replacement) in [
            ("/result/thread/id", json!("")),
            ("/result/thread/id", json!("x".repeat(129))),
            ("/result/runtimeWorkspaceRoots", json!(["/private/secret"])),
            ("/result/instructionSources", json!(["AGENTS.md"])),
            ("/result/approvalPolicy", json!("on-request")),
            ("/result/approvalsReviewer", json!("model")),
            (
                "/result/activePermissionProfile",
                json!("danger-full-access"),
            ),
            ("/result/multiAgentMode", json!("auto")),
            ("/result/cwd", json!("/private/other")),
            ("/result/thread/ephemeral", json!(false)),
            ("/result/thread/path", json!("/private/thread.jsonl")),
            ("/result/thread/gitInfo", json!({})),
            ("/result/thread/parentThreadId", json!("parent")),
            ("/result/thread/cwd", json!("/private/other")),
            ("/result/thread/canAcceptDirectInput", json!(false)),
        ] {
            let mut response = valid_turn_thread_response();
            *response
                .pointer_mut(pointer)
                .expect("valid response pointer") = replacement;
            unsafe_responses.push(response);
        }
        for response in unsafe_responses {
            let mut projection = TurnProtocolProjection::new(home, work);
            projection.stage = TurnProjectionStage::Thread;
            assert_turn_containment(
                projection.accept(&serde_json::to_vec(&response).unwrap()),
                TurnReason::EffectDenied,
            );
        }
    }

    #[test]
    fn turn_projection_rejects_turn_and_event_envelope_drift() {
        let home = Path::new("/private/tmp/codex-home");
        let work = Path::new("/private/tmp/codex-work");
        for response in [
            json!({"id": 9, "result": {}}),
            json!({"id": 4}),
            json!({"id": 4, "result": {}, "extra": true}),
            json!({"id": 4, "result": {}}),
            json!({"id": 4, "result": {"turn": []}}),
            json!({"id": 4, "result": {"turn": {}}}),
            json!({"id": 4, "result": {"turn": {"id": "", "status": "inProgress"}}}),
            json!({"id": 4, "result": {"turn": {"id": "x".repeat(129), "status": "inProgress"}}}),
            json!({"id": 4, "result": {"turn": {"id": "turn-1", "status": "pending"}}}),
        ] {
            let mut projection = TurnProtocolProjection::new(home, work);
            projection.stage = TurnProjectionStage::Turn;
            assert_turn_containment(
                projection.accept(&serde_json::to_vec(&response).unwrap()),
                TurnReason::ProtocolRejected,
            );
        }
        let mut mismatched = TurnProtocolProjection::new(home, work);
        mismatched.stage = TurnProjectionStage::Turn;
        mismatched.turn_id = Some("other-turn".to_owned());
        assert_turn_containment(
            mismatched
                .accept(br#"{"id":4,"result":{"turn":{"id":"turn-1","status":"inProgress"}}}"#),
            TurnReason::ProtocolRejected,
        );

        for event in [
            json!({"method": "account/rateLimits/updated", "id": 1}),
            json!({"method": "account/rateLimits/updated", "extra": true}),
            json!({"method": "account/rateLimits/updated", "emittedAtMs": "now"}),
            json!({"method": 7}),
            json!({"method": "remoteControl/status/changed", "params": {"status": "enabled"}}),
        ] {
            assert_turn_containment(
                active_turn_projection(home, work).accept(&serde_json::to_vec(&event).unwrap()),
                if event.get("method") == Some(&json!(7)) {
                    TurnReason::ProtocolRejected
                } else {
                    TurnReason::EffectDenied
                },
            );
        }
        assert_eq!(
            active_turn_projection(home, work)
                .accept(br#"{"method":"account/rateLimits/updated","params":{},"emittedAtMs":1}"#),
            TurnProjectionAction::Quarantine
        );
    }

    #[test]
    fn turn_projection_rejects_uncorrelated_lifecycle_items_and_deltas() {
        let home = Path::new("/private/tmp/codex-home");
        let work = Path::new("/private/tmp/codex-work");

        for event in [
            br#"{"method":"thread/started","params":{"thread":{}}}"#.as_slice(),
            br#"{"method":"thread/status/changed","params":{"threadId":"thread-1"}}"#.as_slice(),
        ] {
            assert_turn_containment(
                TurnProtocolProjection::new(home, work).accept(event),
                TurnReason::ProtocolRejected,
            );
        }

        let mut correlated_thread = active_turn_projection(home, work);
        assert_eq!(
            correlated_thread
                .accept(br#"{"method":"thread/status/changed","params":{"threadId":"thread-1"}}"#,),
            TurnProjectionAction::Quarantine
        );
        assert_eq!(
            correlated_thread.accept(
                br#"{"method":"remoteControl/status/changed","params":{"environmentId":null,"installationId":"redacted","serverName":"redacted","status":"disabled"}}"#,
            ),
            TurnProjectionAction::Quarantine
        );
        assert_turn_containment(
            correlated_thread.accept(
                br#"{"method":"thread/tokenUsage/updated","params":{"threadId":"other","turnId":"turn-1","tokenUsage":{"total":{"inputTokens":12,"cachedInputTokens":0,"outputTokens":3,"reasoningOutputTokens":0,"totalTokens":15},"last":{"inputTokens":12,"cachedInputTokens":0,"outputTokens":3,"reasoningOutputTokens":0,"totalTokens":15},"modelContextWindow":128000}}}"#,
            ),
            TurnReason::ProtocolRejected,
        );

        let mut active_without_correlation = TurnProtocolProjection::new(home, work);
        active_without_correlation.stage = TurnProjectionStage::Active;
        assert_turn_containment(
            active_without_correlation.accept(
                br#"{"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":"item-1","type":"agentMessage"}}}"#,
            ),
            TurnReason::ProtocolRejected,
        );

        for event in [
            json!({"method": "turn/started", "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "inProgress"}}}),
            json!({"method": "item/started", "params": {"threadId": "thread-1", "turnId": "turn-1", "item": {"id": "item-1", "type": "agentMessage"}}}),
            json!({"method": "item/agentMessage/delta", "params": {"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-1", "delta": "unsafe"}}),
            json!({"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed"}}}),
        ] {
            let mut pre_active = TurnProtocolProjection::new(home, work);
            pre_active.thread_id = Some("thread-1".to_owned());
            pre_active.turn_id = Some("turn-1".to_owned());
            assert_turn_containment(
                pre_active.accept(&serde_json::to_vec(&event).unwrap()),
                TurnReason::ProtocolRejected,
            );
        }

        for event in [
            json!({"method": "thread/started"}),
            json!({"method": "thread/started", "params": {}}),
            json!({"method": "thread/started", "params": {"thread": {"id": "other"}}}),
            json!({"method": "thread/status/changed"}),
            json!({"method": "thread/status/changed", "params": {"threadId": "other"}}),
            json!({"method": "turn/started"}),
            json!({"method": "turn/started", "params": {}}),
            json!({"method": "turn/started", "params": {"turn": {}}}),
            json!({"method": "turn/started", "params": {"threadId": "other", "turn": {"id": "turn-1", "status": "inProgress"}}}),
            json!({"method": "turn/started", "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "pending"}}}),
            json!({"method": "turn/started", "params": {"threadId": "thread-1", "turn": {"id": "other", "status": "inProgress"}}}),
        ] {
            assert_turn_containment(
                active_turn_projection(home, work).accept(&serde_json::to_vec(&event).unwrap()),
                TurnReason::ProtocolRejected,
            );
        }

        for event in [
            json!({"method": "item/started"}),
            json!({"method": "item/started", "params": {"threadId": "other", "turnId": "turn-1"}}),
            json!({"method": "item/started", "params": {"threadId": "thread-1", "turnId": "turn-1"}}),
            json!({"method": "item/started", "params": {"threadId": "thread-1", "turnId": "turn-1", "item": {}}}),
        ] {
            assert_turn_containment(
                active_turn_projection(home, work).accept(&serde_json::to_vec(&event).unwrap()),
                TurnReason::ProtocolRejected,
            );
        }
        for item in [
            json!({"id": "item-1", "type": "commandExecution"}),
            json!({"id": "", "type": "agentMessage"}),
            json!({"id": "x".repeat(129), "type": "agentMessage"}),
        ] {
            assert_turn_containment(
                active_turn_projection(home, work).accept(
                    &serde_json::to_vec(&json!({
                        "method": "item/started",
                        "params": {
                            "threadId": "thread-1",
                            "turnId": "turn-1",
                            "item": item
                        }
                    }))
                    .unwrap(),
                ),
                TurnReason::EffectDenied,
            );
        }

        let completed = json!({
            "method": "item/completed",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {"id": "item-1", "type": "agentMessage", "text": ""}
            }
        });
        assert_turn_containment(
            active_turn_projection(home, work).accept(&serde_json::to_vec(&completed).unwrap()),
            TurnReason::ProtocolRejected,
        );
        let mut duplicate_completion = active_turn_projection(home, work);
        duplicate_completion
            .started_items
            .insert("item-1".to_owned(), InertItemKind::AgentMessage);
        duplicate_completion
            .agent_message_text
            .insert("item-1".to_owned(), String::new());
        assert_eq!(
            duplicate_completion.accept(&serde_json::to_vec(&completed).unwrap()),
            TurnProjectionAction::Quarantine
        );
        assert_turn_containment(
            duplicate_completion.accept(&serde_json::to_vec(&completed).unwrap()),
            TurnReason::ProtocolRejected,
        );

        let mut mismatched_completion = active_turn_projection(home, work);
        for event in [
            json!({"method": "item/started", "params": {"threadId": "thread-1", "turnId": "turn-1", "item": {"id": "item-mismatch", "type": "agentMessage"}}}),
            json!({"method": "item/agentMessage/delta", "params": {"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-mismatch", "delta": "visible"}}),
        ] {
            assert!(matches!(
                mismatched_completion.accept(&serde_json::to_vec(&event).unwrap()),
                TurnProjectionAction::Quarantine | TurnProjectionAction::AgentDelta(_)
            ));
        }
        assert_turn_containment(
            mismatched_completion.accept(
                &serde_json::to_vec(&json!({"method": "item/completed", "params": {"threadId": "thread-1", "turnId": "turn-1", "item": {"id": "item-mismatch", "type": "agentMessage", "text": "different"}}})).unwrap(),
            ),
            TurnReason::ProtocolRejected,
        );

        let mut missing_item_buffer = active_turn_projection(home, work);
        missing_item_buffer
            .started_items
            .insert("item-1".to_owned(), InertItemKind::AgentMessage);
        assert_turn_containment(
            missing_item_buffer.accept(
                br#"{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","delta":"visible"}}"#,
            ),
            TurnReason::ProtocolRejected,
        );

        for event in [
            json!({"method": "item/agentMessage/delta"}),
            json!({"method": "item/agentMessage/delta", "params": {"threadId": "other", "turnId": "turn-1"}}),
            json!({"method": "item/agentMessage/delta", "params": {"threadId": "thread-1", "turnId": "turn-1"}}),
            json!({"method": "item/agentMessage/delta", "params": {"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-1"}}),
        ] {
            assert_turn_containment(
                active_turn_projection(home, work).accept(&serde_json::to_vec(&event).unwrap()),
                TurnReason::ProtocolRejected,
            );
        }
        for (started, completed, delta) in
            [(true, false, ""), (false, false, "x"), (true, true, "x")]
        {
            let mut projection = active_turn_projection(home, work);
            if started {
                projection
                    .started_items
                    .insert("item-1".to_owned(), InertItemKind::AgentMessage);
            }
            if completed {
                projection.completed_items.insert("item-1".to_owned());
            }
            assert_turn_containment(
                projection.accept(
                    &serde_json::to_vec(&json!({
                        "method": "item/agentMessage/delta",
                        "params": {
                            "threadId": "thread-1",
                            "turnId": "turn-1",
                            "itemId": "item-1",
                            "delta": delta
                        }
                    }))
                    .unwrap(),
                ),
                TurnReason::BufferLimit,
            );
        }
    }

    #[test]
    fn turn_projection_rejects_invalid_completion_and_quarantine_overflow() {
        let home = Path::new("/private/tmp/codex-home");
        let work = Path::new("/private/tmp/codex-work");
        for event in [
            json!({"method": "turn/completed"}),
            json!({"method": "turn/completed", "params": {}}),
            json!({"method": "turn/completed", "params": {"threadId": "other", "turn": {"id": "turn-1", "status": "completed"}}}),
            json!({"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "other", "status": "completed"}}}),
            json!({"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed", "error": {"message": "redacted"}}}}),
            json!({"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "pending"}}}),
        ] {
            assert_turn_containment(
                active_turn_projection(home, work).accept(&serde_json::to_vec(&event).unwrap()),
                TurnReason::ProtocolRejected,
            );
        }
        let mut unfinished = active_turn_projection(home, work);
        unfinished
            .started_items
            .insert("item-1".to_owned(), InertItemKind::AgentMessage);
        assert_turn_containment(
            unfinished.accept(
                br#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","error":null}}}"#,
            ),
            TurnReason::ProtocolRejected,
        );

        let mut reasoning_delta = active_turn_projection(home, work);
        reasoning_delta
            .started_items
            .insert("item-1".to_owned(), InertItemKind::Reasoning);
        assert_turn_containment(
            reasoning_delta.accept(
                br#"{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","delta":"hidden reasoning"}}"#,
            ),
            TurnReason::BufferLimit,
        );
        for status in ["failed", "interrupted"] {
            assert_eq!(
                active_turn_projection(home, work).accept(
                    &serde_json::to_vec(&json!({
                        "method": "turn/completed",
                        "params": {
                            "threadId": "thread-1",
                            "turn": {"id": "turn-1", "status": status}
                        }
                    }))
                    .unwrap()
                ),
                TurnProjectionAction::Terminal(TurnState::Failed, TurnReason::ProviderFailed)
            );
        }

        let mut saturated = active_turn_projection(home, work);
        saturated.quarantined_events = MAX_QUARANTINED_EVENTS;
        assert_turn_containment(
            saturated.accept(br#"{"method":"account/rateLimits/updated","params":{}}"#),
            TurnReason::BufferLimit,
        );
        let mut overflowed = active_turn_projection(home, work);
        overflowed.quarantined_events = u16::MAX;
        assert_turn_containment(
            overflowed.accept(br#"{"method":"account/rateLimits/updated","params":{}}"#),
            TurnReason::BufferLimit,
        );
    }

    #[test]
    fn turn_projection_streams_only_correlated_agent_text_and_quarantines_inert_items() {
        let home = Path::new("/private/tmp/codex-home");
        let work = Path::new("/private/tmp/codex-work");
        let mut projection = TurnProtocolProjection::new(home, work);
        assert_eq!(
            projection.accept(
                br#"{"id":1,"result":{"userAgent":"codex_cli_rs/0.145.0","codexHome":"/private/tmp/codex-home","platformFamily":"unix","platformOs":"macos"}}"#
            ),
            TurnProjectionAction::SendAccountRead
        );
        assert_eq!(
            projection.accept(
                br#"{"id":2,"result":{"account":{"type":"chatgpt","email":"redacted","planType":"plus"},"requiresOpenaiAuth":true}}"#
            ),
            TurnProjectionAction::SendThreadStart
        );
        let thread = json!({
            "id": "thread-1",
            "ephemeral": true,
            "path": null,
            "gitInfo": null,
            "parentThreadId": null,
            "cwd": "/private/tmp/codex-work",
            "canAcceptDirectInput": true
        });
        let thread_response = json!({
            "id": 3,
            "result": {
                "thread": thread,
                "runtimeWorkspaceRoots": [],
                "instructionSources": [],
                "approvalPolicy": "never",
                "approvalsReviewer": "user",
                "activePermissionProfile": null,
                "multiAgentMode": "explicitRequestOnly",
                "cwd": "/private/tmp/codex-work"
            }
        });
        assert_eq!(
            projection.accept(&serde_json::to_vec(&thread_response).unwrap()),
            TurnProjectionAction::SendTurnStart("thread-1".to_owned())
        );
        assert_eq!(
            projection
                .accept(br#"{"id":4,"result":{"turn":{"id":"turn-1","status":"inProgress"}}}"#),
            TurnProjectionAction::StreamingStarted
        );
        assert_eq!(
            projection.accept(
                br#"{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"inProgress"}}}"#
            ),
            TurnProjectionAction::Quarantine
        );
        assert_eq!(
            projection.accept(
                br#"{"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1","startedAtMs":1,"item":{"type":"agentMessage","id":"item-1","text":"","phase":null,"memoryCitation":null}}}"#
            ),
            TurnProjectionAction::Quarantine
        );
        assert_eq!(
            projection.accept(
                br#"{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","delta":"Bounded answer."}}"#
            ),
            TurnProjectionAction::AgentDelta("Bounded answer.".to_owned())
        );
        assert_eq!(projection.agent_text, "Bounded answer.");
        assert_eq!(
            projection.accept(
                br#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":2,"item":{"type":"agentMessage","id":"item-1","text":"Bounded answer.","phase":null,"memoryCitation":null}}}"#
            ),
            TurnProjectionAction::Quarantine
        );
        assert_eq!(
            projection.accept(
                br#"{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"inputTokens":12,"cachedInputTokens":0,"outputTokens":3,"reasoningOutputTokens":0,"totalTokens":15},"last":{"inputTokens":12,"cachedInputTokens":0,"outputTokens":3,"reasoningOutputTokens":0,"totalTokens":15},"modelContextWindow":128000}}}"#
            ),
            TurnProjectionAction::Quarantine
        );
        assert_eq!(
            projection.accept(
                br#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","error":null}}}"#
            ),
            TurnProjectionAction::Complete
        );
    }

    #[test]
    fn turn_projection_rejects_effects_duplicates_wrong_correlations_and_floods() {
        let home = Path::new("/private/tmp/codex-home");
        let work = Path::new("/private/tmp/codex-work");
        let active = || {
            let mut projection = TurnProtocolProjection::new(home, work);
            projection.stage = TurnProjectionStage::Active;
            projection.thread_id = Some("thread-1".to_owned());
            projection.turn_id = Some("turn-1".to_owned());
            projection.streaming_announced = true;
            projection
        };
        for event in [
            json!({"method":"item/commandExecution/outputDelta","params":{}}),
            json!({"method":"fs/changed","params":{}}),
            json!({"method":"item/started","id":9,"params":{}}),
            json!({"method":"unknown/event","params":{}}),
        ] {
            assert!(matches!(
                active().accept(&serde_json::to_vec(&event).unwrap()),
                TurnProjectionAction::Terminal(
                    TurnState::ContainmentFailed,
                    TurnReason::EffectDenied
                )
            ));
        }

        for event in [
            json!({"method":"thread/tokenUsage/updated"}),
            json!({"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1"}}),
            json!({"method":"thread/tokenUsage/updated","params":{"threadId":"other","turnId":"turn-1","tokenUsage":{}}}),
            json!({"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"other","tokenUsage":{}}}),
            json!({"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":0}}),
            json!({"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{}}}),
            json!({"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"last":{"inputTokens":-1,"cachedInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0,"totalTokens":0},"total":{"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0,"totalTokens":0}}}}),
            json!({"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"last":{"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0,"totalTokens":0,"content":"forbidden"},"total":{"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0,"totalTokens":0}}}}),
            json!({"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{},"unexpected":true}}),
        ] {
            assert!(matches!(
                active().accept(&serde_json::to_vec(&event).unwrap()),
                TurnProjectionAction::Terminal(
                    TurnState::ContainmentFailed,
                    TurnReason::ProtocolRejected
                )
            ));
        }

        let mut duplicate = active();
        let started = br#"{"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1","startedAtMs":1,"item":{"type":"agentMessage","id":"item-1"}}}"#;
        assert_eq!(duplicate.accept(started), TurnProjectionAction::Quarantine);
        assert!(matches!(
            duplicate.accept(started),
            TurnProjectionAction::Terminal(
                TurnState::ContainmentFailed,
                TurnReason::ProtocolRejected
            )
        ));

        let mut wrong = active();
        assert!(matches!(
            wrong.accept(
                br#"{"method":"item/agentMessage/delta","params":{"threadId":"other","turnId":"turn-1","itemId":"item-1","delta":"x"}}"#
            ),
            TurnProjectionAction::Terminal(
                TurnState::ContainmentFailed,
                TurnReason::ProtocolRejected
            )
        ));

        let mut flooded = active();
        flooded
            .started_items
            .insert("item-1".to_owned(), InertItemKind::AgentMessage);
        flooded.agent_text = "x".repeat(MAX_AGENT_TEXT_BYTES);
        assert!(matches!(
            flooded.accept(
                br#"{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","delta":"x"}}"#
            ),
            TurnProjectionAction::Terminal(
                TurnState::ContainmentFailed,
                TurnReason::BufferLimit
            )
        ));

        let mut update_flood = active();
        update_flood
            .started_items
            .insert("item-1".to_owned(), InertItemKind::AgentMessage);
        update_flood
            .agent_message_text
            .insert("item-1".to_owned(), String::new());
        let one_byte_delta = br#"{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","delta":"x"}}"#;
        for _ in 0..MAX_QUEUE_FRAMES {
            assert_eq!(
                update_flood.accept(one_byte_delta),
                TurnProjectionAction::AgentDelta("x".to_owned())
            );
        }
        assert!(matches!(
            update_flood.accept(one_byte_delta),
            TurnProjectionAction::Terminal(TurnState::ContainmentFailed, TurnReason::BufferLimit)
        ));
        assert_eq!(update_flood.agent_text.len(), MAX_QUEUE_FRAMES);
    }

    #[test]
    fn fake_turn_preserves_authenticated_home_uses_disposable_sqlite_and_cleans_descendants() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository identity");
        fs::write(
            fixture.home.join("retained-only"),
            b"must not enter provider home",
        )
        .expect("retained-only home state");
        let codex_home = r#"'"$CODEX_HOME"'"#;
        let script = format!(
            r#"#!/bin/sh
set -eu
work=$(/bin/pwd -P)
test "$CODEX_SQLITE_HOME" = "$work"
test "$(/usr/bin/stat -f '%Lp' "$work")" = "700"
test -f "$CODEX_HOME/installation_id"
test -e "$CODEX_HOME/retained-only"
printf 'transient provider state' > "$CODEX_SQLITE_HOME/logs_2.sqlite"
read -r initialize
printf '%s\n' '{{"id":1,"result":{{"userAgent":"codex_cli_rs/0.145.0","codexHome":"{codex_home}","platformFamily":"unix","platformOs":"macos"}}}}'
read -r initialized
read -r account
printf '%s\n' '{{"id":2,"result":{{"account":{{"type":"chatgpt","email":"redacted","planType":"plus"}},"requiresOpenaiAuth":true}}}}'
read -r thread
printf '%s\n' '{{"id":3,"result":{{"thread":{{"id":"thread-1","ephemeral":true,"path":null,"gitInfo":null,"parentThreadId":null,"cwd":"'"$work"'","canAcceptDirectInput":true}},"runtimeWorkspaceRoots":[],"instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","activePermissionProfile":null,"multiAgentMode":"explicitRequestOnly","cwd":"'"$work"'"}}}}'
printf '%s\n' '{{"method":"thread/started","params":{{"thread":{{"id":"thread-1"}}}}}}'
read -r turn
printf '%s\n' '{{"id":4,"result":{{"turn":{{"id":"turn-1","status":"inProgress"}}}}}}'
printf '%s\n' '{{"method":"turn/started","params":{{"threadId":"thread-1","turn":{{"id":"turn-1","status":"inProgress"}}}}}}'
printf '%s\n' '{{"method":"item/started","params":{{"threadId":"thread-1","turnId":"turn-1","startedAtMs":1,"item":{{"type":"agentMessage","id":"item-1"}}}}}}'
printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","delta":"Bounded answer."}}}}'
printf '%s\n' '{{"method":"item/completed","params":{{"threadId":"thread-1","turnId":"turn-1","completedAtMs":2,"item":{{"type":"agentMessage","id":"item-1","text":"Bounded answer."}}}}}}'
printf '%s\n' '{{"method":"thread/tokenUsage/updated","params":{{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{{"total":{{"inputTokens":12,"cachedInputTokens":0,"outputTokens":3,"reasoningOutputTokens":0,"totalTokens":15}},"last":{{"inputTokens":12,"cachedInputTokens":0,"outputTokens":3,"reasoningOutputTokens":0,"totalTokens":15}},"modelContextWindow":128000}}}}}}'
/bin/sleep 30 &
printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"thread-1","turn":{{"id":"turn-1","status":"completed","error":null}}}}}}'
wait
"#
        );
        let host = fixture.scripted_host(&script);
        let mut updates = Vec::new();
        let outcome = host.run_turn(
            "request-turn",
            1,
            &WorkspaceRuntimeBinding::for_test(&repository),
            "Repository-independent prompt.",
            Duration::from_secs(5),
            |update| updates.push(update),
        );
        assert_eq!(outcome.state, TurnState::Completed, "{outcome:?}");
        assert_eq!(outcome.agent_text, "Bounded answer.");
        assert!(outcome.cleaned);
        assert!(outcome.provider_thread_established);
        assert!(outcome.provider_turn_established);
        assert_eq!(
            fs::read(fixture.home.join("retained-only")).expect("profile state preserved"),
            b"must not enter provider home"
        );
        assert!(updates.contains(&TurnRuntimeUpdate::StreamingStarted));
        assert!(updates.contains(&TurnRuntimeUpdate::AgentDelta("Bounded answer.".to_owned())));
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
        assert!(!fixture.home.join("logs_2.sqlite").exists());
        assert!(!host.active.running.load(Ordering::Acquire));
        assert_eq!(*host.active.process_group.lock().unwrap(), None);
    }

    #[test]
    fn protocol_containment_failure_uses_the_bounded_turn_cleanup_window() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository identity");
        let host = fixture.scripted_host(
            r#"#!/bin/sh
trap '' TERM
read -r initialize
printf '%s\n' '{"method":"effect/requested","params":{}}'
/bin/sleep 30
"#,
        );
        let started = Instant::now();
        let outcome = host.run_turn(
            "request-containment-cleanup",
            1,
            &WorkspaceRuntimeBinding::for_test(&repository),
            "Repository-independent prompt.",
            Duration::from_secs(8),
            |_| {},
        );
        assert_eq!(outcome.state, TurnState::ContainmentFailed, "{outcome:?}");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn cancellation_accepted_before_runtime_start_prevents_process_launch() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository identity");
        let launched = fixture.root.join("runtime-started");
        let host = fixture.scripted_host(&format!(
            "#!/bin/sh\n: > '{}'\nexit 0\n",
            launched.to_string_lossy()
        ));

        host.cancel_request("request-cancel-before-start");
        let mut updates = Vec::new();
        let outcome = host.run_turn(
            "request-cancel-before-start",
            1,
            &WorkspaceRuntimeBinding::for_test(&repository),
            "Bounded task.",
            Duration::from_secs(1),
            |update| updates.push(update),
        );

        assert_eq!(outcome.state, TurnState::Cancelled);
        assert_eq!(outcome.reason, Some(TurnReason::UserCancelled));
        assert!(outcome.cleaned);
        assert_eq!(
            updates,
            vec![TurnRuntimeUpdate::Stopping(TurnReason::UserCancelled)]
        );
        assert!(!launched.exists(), "cancelled runtime must not start");
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
    }

    #[test]
    fn workspace_change_fence_rejects_a_stale_turn_that_registers_after_cleanup() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository identity");
        let launched = fixture.root.join("workspace-fenced-runtime-started");
        let host = fixture.scripted_host(&format!(
            "#!/bin/sh\n: > '{}'\nexit 0\n",
            launched.to_string_lossy()
        ));
        let test_deadline = Duration::from_secs(5);

        assert!(host.cancel_for_workspace_change_and_wait(7));
        let stale = host.run_turn(
            "request-stale-after-cleanup",
            7,
            &WorkspaceRuntimeBinding::for_test(&repository),
            "Bounded task.",
            test_deadline,
            |_| {},
        );
        assert_eq!(stale.state, TurnState::Failed);
        assert_eq!(stale.reason, Some(TurnReason::StaleWorkspace));
        assert!(stale.cleaned);
        assert!(!launched.exists(), "stale workspace runtime must not start");

        let fresh = host.run_turn(
            "request-fresh-after-cleanup",
            8,
            &WorkspaceRuntimeBinding::for_test(&repository),
            "Fresh bounded task.",
            test_deadline,
            |_| {},
        );
        assert!(
            launched.exists(),
            "fresh workspace generation did not start"
        );
        assert_ne!(fresh.reason, Some(TurnReason::StaleWorkspace));
        assert!(fresh.cleaned);
    }

    #[test]
    fn cancellation_terminates_the_owned_process_group_and_retry_starts_fresh() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let host = fixture.scripted_host(
            r#"#!/bin/sh
trap '' TERM
read -r initialize
printf '%s\n' '{"id":1,"result":{"userAgent":"codex_cli_rs/0.145.0","codexHome":"'"$CODEX_HOME"'","platformFamily":"unix","platformOs":"macos"}}'
while :; do /bin/sleep 1; done
"#,
        );
        let published = host.active.observe_next_process_group();
        let checking_host = host.clone();
        let pending = thread::spawn(move || checking_host.check("request-cancel", None));
        let process_group = published
            .recv_timeout(Duration::from_secs(10))
            .expect("active process group");
        assert!(process_group_exists(process_group.process_id));
        host.cancel_request("request-cancel");
        let cancelled = pending.join().expect("check thread");
        assert_eq!(cancelled.state, RuntimeReadinessState::Cancelled);
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);

        let retry = host.check("request-retry", Some(&fixture.work));
        assert_eq!(retry.state, RuntimeReadinessState::ContainmentFailed);
    }

    #[test]
    fn user_cancel_turn_reports_stopping_then_cancelled_and_cleans_the_tree() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository identity");
        let host = fixture.scripted_host(
            r#"#!/bin/sh
trap '' TERM
read -r initialize
printf '%s\n' '{"id":1,"result":{"userAgent":"codex_cli_rs/0.145.0","codexHome":"'"$CODEX_HOME"'","platformFamily":"unix","platformOs":"macos"}}'
while :; do /bin/sleep 1; done
"#,
        );
        let published = host.active.observe_next_process_group();
        let running_host = host.clone();
        let pending = thread::spawn(move || {
            let mut updates = Vec::new();
            let outcome = running_host.run_turn(
                "request-cancel-turn",
                1,
                &WorkspaceRuntimeBinding::for_test(&repository),
                "Bounded task.",
                Duration::from_secs(5),
                |update| updates.push(update),
            );
            (outcome, updates)
        });
        published
            .recv_timeout(Duration::from_secs(10))
            .expect("active turn process group");

        let stopping_started = Instant::now();
        host.cancel_request("request-cancel-turn");
        let (cancelled, updates) = pending.join().expect("turn thread");
        assert!(
            stopping_started.elapsed() < Duration::from_secs(2),
            "cancel escalation exceeded its bounded grace: {:?}",
            stopping_started.elapsed()
        );
        assert_eq!(cancelled.state, TurnState::Cancelled);
        assert_eq!(cancelled.reason, Some(TurnReason::UserCancelled));
        assert!(cancelled.cleaned);
        assert_eq!(
            updates,
            vec![TurnRuntimeUpdate::Stopping(TurnReason::UserCancelled)]
        );
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
        assert!(!host.active.running.load(Ordering::Acquire));
        assert_eq!(*host.active.process_group.lock().unwrap(), None);
    }

    #[test]
    fn app_shutdown_waits_for_turn_cleanup_before_returning() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository identity");
        let host = fixture.scripted_host(
            r#"#!/bin/sh
trap '' TERM
read -r initialize
printf '%s\n' '{"id":1,"result":{"userAgent":"codex_cli_rs/0.145.0","codexHome":"'"$CODEX_HOME"'","platformFamily":"unix","platformOs":"macos"}}'
while :; do /bin/sleep 1; done
"#,
        );
        let published = host.active.observe_next_process_group();
        let running_host = host.clone();
        let pending = thread::spawn(move || {
            running_host.run_turn(
                "request-app-shutdown",
                1,
                &WorkspaceRuntimeBinding::for_test(&repository),
                "Bounded task.",
                Duration::from_secs(5),
                |_| {},
            )
        });
        published
            .recv_timeout(Duration::from_secs(10))
            .expect("shutdown process group");

        assert!(host.cancel_for_app_shutdown_and_wait());
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
        let cancelled = pending.join().expect("turn thread");
        assert_eq!(cancelled.state, TurnState::Cancelled);
        assert_eq!(cancelled.reason, Some(TurnReason::AppShutdown));
        assert!(cancelled.cleaned);
    }

    #[test]
    fn retained_child_reaping_requires_an_exited_owned_child() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(!reap_child(i32::MAX));

        let mut child = Command::new("/usr/bin/true")
            .spawn()
            .expect("short-lived child fixture");
        let process = child.id() as i32;
        let wait_deadline = Instant::now() + Duration::from_secs(1);
        while !child_exited_without_reaping(process).is_ok_and(|exited| exited)
            && Instant::now() < wait_deadline
        {
            thread::yield_now();
        }
        assert!(child_exited_without_reaping(process).is_ok_and(|exited| exited));
        assert!(reap_child(process));
        let _ = child.wait();
    }

    #[test]
    fn turn_directory_permission_failure_reports_proven_cleanup() {
        let fixture = Fixture::new();
        let active = ActiveRuntime::default();
        let work_directory = fixture.work.join("partial-turn");
        let owner = process_identity(std::process::id() as i32).expect("test process identity");
        let outcome =
            create_private_turn_directory_with(&active, &work_directory, owner, 1, |path| {
                fs::write(path.join("owned"), b"partial").expect("partial owned entry");
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "fixture"))
            })
            .expect_err("permission failure");

        assert_eq!(outcome.state, TurnState::Failed);
        assert_eq!(outcome.reason, Some(TurnReason::RuntimeUnavailable));
        assert!(outcome.cleaned);
        assert!(!work_directory.exists());
    }

    #[test]
    fn readiness_directory_is_created_private_and_owned() {
        let fixture = Fixture::new();
        let active = ActiveRuntime::default();
        let owner = process_identity(std::process::id() as i32).expect("test process identity");
        let work_directory = fixture
            .work
            .join(runtime_work_directory_name("readiness", owner, 1));

        create_private_readiness_directory(&active, &work_directory, owner, 1)
            .expect("private readiness directory");

        let metadata = fs::symlink_metadata(&work_directory).expect("readiness metadata");
        assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
        // SAFETY: geteuid has no arguments or mutable memory effects.
        assert_eq!(metadata.uid(), unsafe { keiko_geteuid() });
        assert_eq!(
            runtime_work_directory_identity(&work_directory, "readiness"),
            Some((owner, 1))
        );
        fs::remove_dir_all(&work_directory).expect("remove readiness fixture");
    }

    #[test]
    fn runtime_owner_record_rejects_each_metadata_and_identity_drift() {
        let fixture = Fixture::new();
        let owner = process_identity(std::process::id() as i32).expect("test process identity");
        let raw_record = |generation: u64, contents: &[u8], mode: u32| {
            let directory = fixture
                .work
                .join(runtime_work_directory_name("turn", owner, generation));
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&directory)
                .expect("raw runtime directory");
            let record = directory.join(RUNTIME_OWNER_RECORD);
            fs::write(&record, contents).expect("raw owner record");
            fs::set_permissions(&record, fs::Permissions::from_mode(mode))
                .expect("raw owner record mode");
            directory
        };

        let invalid_prefix = fixture.work.join("other-1-1");
        fs::create_dir(&invalid_prefix).expect("invalid prefix directory");
        assert!(write_runtime_owner_record(&invalid_prefix, owner, 1).is_err());

        let mismatched_name = fixture
            .work
            .join(runtime_work_directory_name("turn", owner, 40));
        fs::create_dir(&mismatched_name).expect("mismatched name directory");
        assert!(write_runtime_owner_record(&mismatched_name, owner, 41).is_err());

        let valid_contents = format!(
            "{}:{}:{}:42\n",
            owner.process_id, owner.started_seconds, owner.started_microseconds
        );
        let wrong_owner = raw_record(42, valid_contents.as_bytes(), 0o600);
        let metadata = fs::symlink_metadata(wrong_owner.join(RUNTIME_OWNER_RECORD))
            .expect("owner record metadata");
        assert!(valid_runtime_owner_record_metadata(
            &metadata,
            effective_user_id()
        ));
        assert!(!valid_runtime_owner_record_metadata(
            &metadata,
            effective_user_id().wrapping_add(1)
        ));

        let directory_record = fixture
            .work
            .join(runtime_work_directory_name("turn", owner, 43));
        fs::create_dir(&directory_record).expect("directory owner fixture");
        fs::create_dir(directory_record.join(RUNTIME_OWNER_RECORD))
            .expect("directory owner record");
        assert!(runtime_work_directory_identity(&directory_record, "turn").is_none());

        for (generation, contents, mode) in [
            (
                44,
                valid_contents.replace(":42\n", ":44\n").into_bytes(),
                0o644,
            ),
            (45, Vec::new(), 0o600),
            (46, vec![b'x'; 129], 0o600),
            (
                47,
                format!(
                    "{}:{}:{}:47:extra\n",
                    owner.process_id, owner.started_seconds, owner.started_microseconds
                )
                .into_bytes(),
                0o600,
            ),
            (
                48,
                format!(
                    "{}:{}:{}:48\n",
                    owner.process_id.saturating_add(1),
                    owner.started_seconds,
                    owner.started_microseconds
                )
                .into_bytes(),
                0o600,
            ),
            (
                49,
                format!(
                    "{}:{}:{}:50\n",
                    owner.process_id, owner.started_seconds, owner.started_microseconds
                )
                .into_bytes(),
                0o600,
            ),
            (
                50,
                format!("{}:0:{}:50\n", owner.process_id, owner.started_microseconds).into_bytes(),
                0o600,
            ),
            (
                51,
                format!(
                    "{}:{}:1000000:51\n",
                    owner.process_id, owner.started_seconds
                )
                .into_bytes(),
                0o600,
            ),
        ] {
            let directory = raw_record(generation, &contents, mode);
            assert!(
                runtime_work_directory_identity(&directory, "turn").is_none(),
                "generation {generation}"
            );
        }
    }

    #[test]
    fn runtime_process_record_rejects_each_metadata_and_field_drift() {
        let fixture = Fixture::new();
        let raw_record = |name: &str, contents: &[u8], mode: u32| {
            let directory = fixture.work.join(name);
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&directory)
                .expect("raw process-record directory");
            let record = directory.join(RUNTIME_PROCESS_RECORD);
            fs::write(&record, contents).expect("raw process record");
            fs::set_permissions(&record, fs::Permissions::from_mode(mode))
                .expect("raw process-record mode");
            directory
        };
        let valid = raw_record("process-valid", b"41:2:3\n", 0o600);
        assert_eq!(
            runtime_process_record(&valid),
            Some(ProcessIdentity {
                process_id: 41,
                started_seconds: 2,
                started_microseconds: 3,
            })
        );

        for (name, contents, mode) in [
            ("process-public", b"41:2:3\n".as_slice(), 0o644),
            ("process-empty", b"".as_slice(), 0o600),
            ("process-no-newline", b"41:2:3".as_slice(), 0o600),
            ("process-zero-pid", b"0:2:3\n".as_slice(), 0o600),
            ("process-zero-start", b"41:0:3\n".as_slice(), 0o600),
            ("process-microseconds", b"41:2:1000000\n".as_slice(), 0o600),
            ("process-extra", b"41:2:3:4\n".as_slice(), 0o600),
            ("process-malformed", b"x:y:z\n".as_slice(), 0o600),
        ] {
            let directory = raw_record(name, contents, mode);
            assert!(runtime_process_record(&directory).is_none(), "{name}");
        }

        let oversized = raw_record("process-oversized", &[b'x'; 129], 0o600);
        assert!(runtime_process_record(&oversized).is_none());
        let directory_record = fixture.work.join("process-directory-record");
        fs::create_dir(&directory_record).expect("process-record fixture");
        fs::create_dir(directory_record.join(RUNTIME_PROCESS_RECORD))
            .expect("directory process record");
        assert!(runtime_process_record(&directory_record).is_none());
    }

    #[test]
    fn private_directory_rejects_post_creation_permission_drift() {
        let fixture = Fixture::new();
        let work_directory = fixture.work.join("permission-drift");

        let outcome = create_private_directory_with(&work_directory, |path| {
            fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        });

        assert_eq!(outcome, Err(PrivateDirectoryFailure::Unavailable));
        assert!(!work_directory.exists());
    }

    #[test]
    fn turn_directory_creation_collision_is_cleanly_unavailable() {
        let fixture = Fixture::new();
        let active = ActiveRuntime::default();
        let work_directory = fixture.work.join("existing-turn");
        fs::create_dir(&work_directory).expect("existing turn collision");
        let owner = process_identity(std::process::id() as i32).expect("test process identity");

        let outcome = create_private_turn_directory(&active, &work_directory, owner, 1)
            .expect_err("collision");

        assert_eq!(outcome.state, TurnState::Failed);
        assert_eq!(outcome.reason, Some(TurnReason::RuntimeUnavailable));
        assert!(outcome.cleaned);
        assert!(work_directory.is_dir());
    }

    #[test]
    fn turn_directory_substitution_never_claims_unproven_cleanup() {
        let fixture = Fixture::new();
        let active = ActiveRuntime::default();
        let work_directory = fixture.work.join("replaced-partial-turn");
        let owner = process_identity(std::process::id() as i32).expect("test process identity");
        let outcome =
            create_private_turn_directory_with(&active, &work_directory, owner, 1, |path| {
                fs::remove_dir(path).expect("remove partial directory");
                fs::write(path, b"replacement").expect("replace directory with file");
                Ok(())
            })
            .expect_err("substitution failure");

        assert_eq!(outcome.state, TurnState::CleanupFailed);
        assert_eq!(outcome.reason, Some(TurnReason::CleanupFailed));
        assert!(!outcome.cleaned);
        assert!(
            active
                .retained_work_directories
                .lock()
                .expect("retained work")
                .contains(&work_directory)
        );
        fs::remove_file(work_directory).expect("remove replacement fixture");
        assert!(reconcile_retained_work_directories(&active));
    }

    #[test]
    fn workspace_change_fails_the_active_turn_then_allows_a_fresh_retry() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository identity");
        let retry_started = fixture.root.join("workspace-change-retry-started");
        let host = fixture.scripted_host(&format!(
            r#"#!/bin/sh
case "$PWD" in
*-1)
trap '' TERM
read -r initialize
printf '%s\n' '{{"id":1,"result":{{"userAgent":"codex_cli_rs/0.145.0","codexHome":"'"$CODEX_HOME"'","platformFamily":"unix","platformOs":"macos"}}}}'
while :; do /bin/sleep 1; done
;;
esac
: > '{retry_started}'
exit 0
"#,
            retry_started = retry_started.to_string_lossy(),
        ));
        let published = host.active.observe_next_process_group();
        let running_host = host.clone();
        let pending = thread::spawn(move || {
            running_host.run_turn(
                "request-workspace-change",
                1,
                &WorkspaceRuntimeBinding::for_test(&repository),
                "Bounded task.",
                Duration::from_secs(5),
                |_| {},
            )
        });
        published
            .recv_timeout(Duration::from_secs(10))
            .expect("workspace-change process group");

        let cancellation_started = Instant::now();
        assert!(host.cancel_for_workspace_change_and_wait(1));
        assert!(
            cancellation_started.elapsed() < Duration::from_secs(2),
            "workspace cleanup did not use the bounded cancellation grace: {:?}",
            cancellation_started.elapsed()
        );
        let invalidated = pending.join().expect("turn thread");
        assert_eq!(invalidated.state, TurnState::Failed);
        assert_eq!(invalidated.reason, Some(TurnReason::StaleWorkspace));
        assert!(invalidated.cleaned);
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);

        let fresh_repository = fixture.root.join("fresh-repository");
        fs::create_dir(&fresh_repository).expect("fresh repository identity");
        let retry = host.run_turn(
            "request-fresh-workspace",
            2,
            &WorkspaceRuntimeBinding::for_test(&fresh_repository),
            "Fresh bounded task.",
            Duration::from_secs(1),
            |_| {},
        );
        assert!(
            retry_started.exists(),
            "fresh retry did not reach the runtime"
        );
        assert_ne!(retry.reason, Some(TurnReason::StaleWorkspace));
        assert!(retry.cleaned);
        assert!(!host.active.running.load(Ordering::Acquire));
    }

    #[test]
    fn workspace_identity_replacement_before_runtime_bind_fails_stale() {
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository identity");
        fs::create_dir(repository.join(".git")).expect("repository marker");
        let binding = WorkspaceRuntimeBinding::inspect(&repository).expect("workspace binding");
        let replaced = fixture.root.join("replaced-repository");
        fs::rename(&repository, &replaced).expect("replace selected repository");
        fs::create_dir(&repository).expect("replacement repository");
        fs::create_dir(repository.join(".git")).expect("replacement marker");
        let host = fixture.scripted_host("#!/bin/sh\nexit 0\n");

        let outcome = host.run_turn(
            "request-replaced-workspace",
            1,
            &binding,
            "Bounded task.",
            Duration::from_secs(1),
            |_| {},
        );

        assert_eq!(outcome.state, TurnState::Failed);
        assert_eq!(outcome.reason, Some(TurnReason::StaleWorkspace));
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
    }

    #[test]
    fn workspace_identity_is_revalidated_immediately_before_turn_submission() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository identity");
        fs::create_dir(repository.join(".git")).expect("repository marker");
        let binding = WorkspaceRuntimeBinding::inspect(&repository).expect("workspace binding");
        let replaced = fixture.root.join("replaced-at-submission");
        let turn_received = fixture.root.join("turn-start-received");
        let script = format!(
            r#"#!/bin/sh
set -eu
read -r initialize
printf '%s\n' '{{"id":1,"result":{{"userAgent":"codex_cli_rs/0.145.0","codexHome":"'"$CODEX_HOME"'","platformFamily":"unix","platformOs":"macos"}}}}'
read -r initialized
read -r account
printf '%s\n' '{{"id":2,"result":{{"account":{{"type":"chatgpt","email":"redacted","planType":"plus"}},"requiresOpenaiAuth":true}}}}'
read -r thread
/bin/mv '{repository}' '{replaced}'
/bin/mkdir '{repository}'
/bin/mkdir '{repository}/.git'
printf '%s\n' '{{"id":3,"result":{{"thread":{{"id":"thread-1","ephemeral":true,"path":null,"gitInfo":null,"parentThreadId":null,"cwd":"'"$PWD"'","canAcceptDirectInput":true}},"runtimeWorkspaceRoots":[],"instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","activePermissionProfile":null,"multiAgentMode":"explicitRequestOnly","cwd":"'"$PWD"'"}}}}'
printf '%s\n' '{{"method":"thread/started","params":{{"thread":{{"id":"thread-1"}}}}}}'
if read -r turn; then : > '{turn_received}'; fi
"#,
            repository = repository.to_string_lossy(),
            replaced = replaced.to_string_lossy(),
            turn_received = turn_received.to_string_lossy(),
        );
        let host = fixture.scripted_host(&script);

        let outcome = host.run_turn(
            "request-final-workspace-fence",
            1,
            &binding,
            "Bounded task.",
            Duration::from_secs(3),
            |_| {},
        );

        assert_eq!(outcome.state, TurnState::Failed);
        assert_eq!(outcome.reason, Some(TurnReason::StaleWorkspace));
        assert!(outcome.cleaned);
        assert!(
            !turn_received.exists(),
            "turn/start crossed the stale fence"
        );
    }

    #[test]
    fn wait_for_idle_times_out_when_request_never_finishes() {
        let never_idle = ActiveRuntime::default();
        never_idle.running.store(true, Ordering::Release);
        assert!(never_idle.begin_request("never-idle"));
        assert!(!never_idle.wait_for_idle(Duration::from_millis(1)));
        never_idle.finish_request();
    }

    #[test]
    fn wait_for_idle_rejects_already_poisoned_control() {
        let poisoned = Arc::new(ActiveRuntime::default());
        let poison_target = Arc::clone(&poisoned);
        let _ = thread::spawn(move || {
            let _guard = poison_target
                .control
                .lock()
                .expect("control before poisoning");
            panic!("poison runtime control");
        })
        .join();
        assert!(!poisoned.wait_for_idle(Duration::from_millis(1)));
    }

    #[test]
    fn wait_for_idle_rejects_control_poisoned_while_waiting() {
        let poisoned_while_waiting = Arc::new(ActiveRuntime::default());
        poisoned_while_waiting
            .running
            .store(true, Ordering::Release);
        assert!(poisoned_while_waiting.begin_request("poisoned-wait"));
        let waiting_target = Arc::clone(&poisoned_while_waiting);
        let waiting = thread::spawn(move || waiting_target.wait_for_idle(Duration::from_secs(1)));
        while !poisoned_while_waiting.idle_waiting.load(Ordering::Acquire) {
            thread::yield_now();
        }
        let poison_target = Arc::clone(&poisoned_while_waiting);
        let _ = thread::spawn(move || {
            let _guard = poison_target
                .control
                .lock()
                .expect("control while waiter sleeps");
            panic!("poison sleeping runtime waiter");
        })
        .join();
        poisoned_while_waiting.finished.notify_all();
        assert!(!waiting.join().expect("idle waiter"));
    }

    #[test]
    fn provider_crash_is_terminal_and_retry_repeats_fresh_preflight() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository identity");
        let host = fixture.scripted_host(
            r#"#!/bin/sh
read -r initialize
exit 9
"#,
        );

        for request_id in ["crashed-attempt", "fresh-retry"] {
            let outcome = host.run_turn(
                request_id,
                1,
                &WorkspaceRuntimeBinding::for_test(&repository),
                "Bounded task.",
                Duration::from_secs(2),
                |_| {},
            );
            assert_eq!(outcome.state, TurnState::Failed);
            assert_eq!(outcome.reason, Some(TurnReason::ProviderFailed));
            assert!(outcome.cleaned);
            assert_eq!(fs::read_dir(&fixture.work).unwrap().count(), 0);
        }
        assert_eq!(host.work_generation.load(Ordering::Acquire), 2);
        assert!(!host.active.running.load(Ordering::Acquire));
        assert_eq!(*host.active.process_group.lock().unwrap(), None);
    }

    #[test]
    fn request_timeout_is_one_end_to_end_initialization_and_cleanup_deadline() {
        let request_started = Instant::now();
        let request_timeout = Duration::from_secs(2);
        let request_deadline = request_started + request_timeout;
        let protocol_started = request_started + Duration::from_millis(500);
        let protocol_deadline = readiness_protocol_deadline(request_deadline, protocol_started);
        let cleanup_remaining = request_deadline.duration_since(protocol_deadline);
        let identity = ProcessIdentity {
            process_id: 41,
            started_microseconds: 7,
            started_seconds: 11,
        };
        let result = cleanup_reduce(
            CleanupState::new(
                CleanupPhasePolicy::PreserveFinalReconciliation,
                identity.process_id,
                request_deadline,
                Some(readiness_term_grace(cleanup_remaining)),
            ),
            CleanupObservation::Begin {
                observed_at: protocol_deadline,
            },
        );
        let (state, command) = expect_cleanup_command(result);

        assert_eq!(READINESS_CLEANUP_RESERVE, Duration::from_millis(300));
        assert_eq!(READINESS_MAX_TERM_GRACE, Duration::from_millis(100));
        assert_eq!(cleanup_remaining, READINESS_CLEANUP_RESERVE);
        assert_eq!(
            command,
            CleanupCommand::ObserveActiveIdentity {
                guard: Some(request_deadline)
            }
        );
        let controller = match state {
            CleanupState::Reconciling {
                controller,
                continuation: CleanupContinuation::Initial,
                step: CleanupProofStep::ActiveIdentity,
                ..
            } => controller,
            other => panic!("unexpected initial cleanup state: {other:?}"),
        };
        assert_eq!(controller.deadline, request_deadline);
        assert_eq!(controller.cleanup_started, protocol_deadline);
        assert_eq!(controller.eof_grace, Duration::from_millis(100));
        assert_eq!(controller.term_grace, Duration::from_millis(100));
        assert_eq!(
            cleanup_reduce(
                state,
                CleanupObservation::Slept {
                    started_at: protocol_deadline,
                    completed_at: protocol_deadline,
                },
            ),
            CleanupResult::Terminal(CleanupTerminal::Retained),
            "a typed mismatch must fail closed"
        );
        assert_eq!(
            cleanup_reduce(
                state,
                CleanupObservation::DeadlineClosed {
                    closed_at: request_deadline,
                },
            ),
            CleanupResult::Terminal(CleanupTerminal::Retained),
            "no guarded primitive may start at the absolute request deadline"
        );
    }

    #[test]
    fn readiness_cleanup_reserve_is_capped_after_staging_and_proportional_for_short_budgets() {
        let request_started = Instant::now();
        let deadline = request_started + DEFAULT_REQUEST_TIMEOUT;
        let protocol_started = request_started + Duration::from_millis(500);
        let protocol_deadline = readiness_protocol_deadline(deadline, protocol_started);

        assert_eq!(
            protocol_deadline.duration_since(protocol_started),
            Duration::from_millis(4_200)
        );
        assert_eq!(
            deadline.duration_since(protocol_deadline),
            READINESS_CLEANUP_RESERVE
        );

        let short_deadline = request_started + Duration::from_secs(1);
        let short_protocol_started = request_started + Duration::from_millis(500);
        let short_protocol_deadline =
            readiness_protocol_deadline(short_deadline, short_protocol_started);
        assert_eq!(
            short_protocol_deadline.duration_since(short_protocol_started),
            Duration::from_millis(400)
        );
        assert_eq!(
            short_deadline.duration_since(short_protocol_deadline),
            Duration::from_millis(100)
        );
        assert_eq!(
            readiness_term_grace(READINESS_CLEANUP_RESERVE),
            Duration::from_millis(100)
        );
        assert_eq!(
            readiness_term_grace(Duration::from_millis(100)),
            Duration::from_nanos(33_333_333)
        );
    }

    #[test]
    fn readiness_descendant_phase_preserves_final_reconciliation_budget() {
        let descendant_started = Instant::now();
        let deadline = descendant_started + Duration::from_millis(50);

        assert_eq!(
            descendant_reap_deadline(
                CleanupPhasePolicy::PreserveFinalReconciliation,
                descendant_started,
                deadline,
            ),
            descendant_started
        );
        assert_eq!(
            descendant_reap_deadline(
                CleanupPhasePolicy::AllowParentReap,
                descendant_started,
                deadline,
            ),
            descendant_started + Duration::from_millis(25)
        );
        assert_eq!(
            descendant_reap_deadline(
                CleanupPhasePolicy::AllowParentReap,
                descendant_started,
                descendant_started + Duration::from_secs(1),
            ),
            descendant_started + DESCENDANT_REAP_GRACE
        );
    }

    fn expect_cleanup_command(result: CleanupResult) -> (CleanupState, CleanupCommand) {
        match result {
            CleanupResult::Command { state, command } => (state, command),
            CleanupResult::Terminal(terminal) => {
                panic!("expected cleanup command, got terminal {terminal:?}")
            }
        }
    }

    #[test]
    fn cleanup_reducer_golden_trace_reaps_and_retires_only_after_strict_proof() {
        let started_at = Instant::now();
        let deadline = started_at + READINESS_CLEANUP_RESERVE;
        let identity = ProcessIdentity {
            process_id: 41,
            started_microseconds: 7,
            started_seconds: 11,
        };
        let guard = Some(deadline);
        let mut trace = Vec::new();
        let mut result = cleanup_reduce(
            CleanupState::new(
                CleanupPhasePolicy::PreserveFinalReconciliation,
                identity.process_id,
                deadline,
                Some(Duration::from_millis(100)),
            ),
            CleanupObservation::Begin {
                observed_at: started_at,
            },
        );
        let steps = [
            (
                CleanupCommand::ObserveActiveIdentity { guard },
                CleanupObservation::ActiveIdentity {
                    started_at,
                    completed_at: started_at,
                    identity: Some(identity),
                },
            ),
            (
                CleanupCommand::ObserveActiveIdentityStatus { guard, identity },
                CleanupObservation::ActiveIdentityStatus {
                    started_at,
                    completed_at: started_at,
                    status: RetainedProcessIdentityStatus::Current,
                },
            ),
            (
                CleanupCommand::ObserveChildExit { guard },
                CleanupObservation::ChildExit {
                    started_at,
                    completed_at: started_at,
                    exited: Some(true),
                },
            ),
            (
                CleanupCommand::ObserveDescendants { guard },
                CleanupObservation::Descendants {
                    started_at,
                    completed_at: started_at,
                    alive: Some(false),
                },
            ),
            (
                CleanupCommand::ObserveOwnedDescendants { guard },
                CleanupObservation::OwnedDescendants {
                    started_at,
                    completed_at: started_at,
                    alive: Some(false),
                },
            ),
            (
                CleanupCommand::WaitChild { guard },
                CleanupObservation::ChildWaited {
                    started_at,
                    completed_at: started_at,
                    reaped: true,
                },
            ),
            (
                CleanupCommand::ObserveGroupPresence { guard },
                CleanupObservation::GroupPresence {
                    started_at,
                    completed_at: started_at,
                    status: ProcessPresenceStatus::Absent,
                },
            ),
            (
                CleanupCommand::ObserveOwnedStopped { guard },
                CleanupObservation::OwnedStopped {
                    started_at,
                    completed_at: started_at,
                    stopped: Some(true),
                },
            ),
            (
                CleanupCommand::RetireOwnership { guard, identity },
                CleanupObservation::OwnershipRetired {
                    started_at,
                    completed_at: started_at,
                    retired: true,
                },
            ),
        ];

        for (expected, observation) in steps.iter().copied() {
            let (state, command) = expect_cleanup_command(result);
            assert_eq!(command, expected);
            trace.push(command);
            result = cleanup_reduce(state, observation);
        }

        assert_eq!(result, CleanupResult::Terminal(CleanupTerminal::Cleaned));
        assert_eq!(trace, steps.map(|(command, _)| command));
    }

    fn reduce_expected_command(
        result: CleanupResult,
        expected: CleanupCommand,
        observation: CleanupObservation,
    ) -> CleanupResult {
        let (state, command) = expect_cleanup_command(result);
        assert_eq!(command, expected);
        cleanup_reduce(state, observation)
    }

    fn live_child_reconciliation(
        mut result: CleanupResult,
        at: Instant,
        guard: Option<Instant>,
        identity: ProcessIdentity,
    ) -> CleanupResult {
        result = reduce_expected_command(
            result,
            CleanupCommand::ObserveActiveIdentity { guard },
            CleanupObservation::ActiveIdentity {
                started_at: at,
                completed_at: at,
                identity: Some(identity),
            },
        );
        result = reduce_expected_command(
            result,
            CleanupCommand::ObserveActiveIdentityStatus { guard, identity },
            CleanupObservation::ActiveIdentityStatus {
                started_at: at,
                completed_at: at,
                status: RetainedProcessIdentityStatus::Current,
            },
        );
        result = reduce_expected_command(
            result,
            CleanupCommand::ObserveChildExit { guard },
            CleanupObservation::ChildExit {
                started_at: at,
                completed_at: at,
                exited: Some(false),
            },
        );
        result = reduce_expected_command(
            result,
            CleanupCommand::ObserveDescendants { guard },
            CleanupObservation::Descendants {
                started_at: at,
                completed_at: at,
                alive: Some(false),
            },
        );
        reduce_expected_command(
            result,
            CleanupCommand::ObserveOwnedDescendants { guard },
            CleanupObservation::OwnedDescendants {
                started_at: at,
                completed_at: at,
                alive: Some(false),
            },
        )
    }

    fn strict_cleanup_reconciliation(
        mut result: CleanupResult,
        at: Instant,
        guard: Option<Instant>,
        identity: ProcessIdentity,
    ) -> CleanupResult {
        let steps = [
            (
                CleanupCommand::ObserveActiveIdentity { guard },
                CleanupObservation::ActiveIdentity {
                    started_at: at,
                    completed_at: at,
                    identity: Some(identity),
                },
            ),
            (
                CleanupCommand::ObserveActiveIdentityStatus { guard, identity },
                CleanupObservation::ActiveIdentityStatus {
                    started_at: at,
                    completed_at: at,
                    status: RetainedProcessIdentityStatus::Current,
                },
            ),
            (
                CleanupCommand::ObserveChildExit { guard },
                CleanupObservation::ChildExit {
                    started_at: at,
                    completed_at: at,
                    exited: Some(true),
                },
            ),
            (
                CleanupCommand::ObserveDescendants { guard },
                CleanupObservation::Descendants {
                    started_at: at,
                    completed_at: at,
                    alive: Some(false),
                },
            ),
            (
                CleanupCommand::ObserveOwnedDescendants { guard },
                CleanupObservation::OwnedDescendants {
                    started_at: at,
                    completed_at: at,
                    alive: Some(false),
                },
            ),
            (
                CleanupCommand::WaitChild { guard },
                CleanupObservation::ChildWaited {
                    started_at: at,
                    completed_at: at,
                    reaped: true,
                },
            ),
            (
                CleanupCommand::ObserveGroupPresence { guard },
                CleanupObservation::GroupPresence {
                    started_at: at,
                    completed_at: at,
                    status: ProcessPresenceStatus::Absent,
                },
            ),
            (
                CleanupCommand::ObserveOwnedStopped { guard },
                CleanupObservation::OwnedStopped {
                    started_at: at,
                    completed_at: at,
                    stopped: Some(true),
                },
            ),
            (
                CleanupCommand::RetireOwnership { guard, identity },
                CleanupObservation::OwnershipRetired {
                    started_at: at,
                    completed_at: at,
                    retired: true,
                },
            ),
        ];
        for (command, observation) in steps {
            result = reduce_expected_command(result, command, observation);
        }
        result
    }

    #[test]
    fn cleanup_reducer_golden_trace_allocates_and_orders_every_readiness_phase() {
        let request_started = Instant::now();
        let request_deadline = request_started + Duration::from_secs(2);
        let protocol_started = request_started + Duration::from_millis(500);
        let started_at = readiness_protocol_deadline(request_deadline, protocol_started);
        let eof_deadline = started_at + Duration::from_millis(100);
        let term_deadline = started_at + Duration::from_millis(200);
        let deadline = request_deadline;
        let identity = ProcessIdentity {
            process_id: 41,
            started_microseconds: 7,
            started_seconds: 11,
        };
        let guard = Some(deadline);
        let mut result = cleanup_reduce(
            CleanupState::new(
                CleanupPhasePolicy::PreserveFinalReconciliation,
                identity.process_id,
                deadline,
                Some(READINESS_MAX_TERM_GRACE),
            ),
            CleanupObservation::Begin {
                observed_at: started_at,
            },
        );

        result = live_child_reconciliation(result, started_at, guard, identity);
        result = live_child_reconciliation(result, started_at, guard, identity);
        result = reduce_expected_command(
            result,
            CleanupCommand::Sleep {
                guard: Some(eof_deadline),
                duration: Duration::from_millis(10),
            },
            CleanupObservation::Slept {
                started_at,
                completed_at: eof_deadline,
            },
        );
        result = reduce_expected_command(
            result,
            CleanupCommand::SignalProcessGroup {
                guard,
                signal: SIGTERM,
            },
            CleanupObservation::ProcessGroupSignalled {
                started_at: eof_deadline,
                completed_at: eof_deadline,
                signal: SIGTERM,
            },
        );
        result = live_child_reconciliation(result, eof_deadline, guard, identity);
        result = reduce_expected_command(
            result,
            CleanupCommand::Sleep {
                guard: Some(term_deadline),
                duration: Duration::from_millis(10),
            },
            CleanupObservation::Slept {
                started_at: eof_deadline,
                completed_at: term_deadline,
            },
        );
        result = reduce_expected_command(
            result,
            CleanupCommand::RefreshOwned { guard },
            CleanupObservation::OwnedRefreshed {
                started_at: term_deadline,
                completed_at: term_deadline,
                refreshed: true,
            },
        );
        result = reduce_expected_command(
            result,
            CleanupCommand::SignalDescendants {
                guard,
                signal: SIGKILL,
            },
            CleanupObservation::DescendantsSignalled {
                started_at: term_deadline,
                completed_at: term_deadline,
                signal: SIGKILL,
                signalled: false,
            },
        );
        result = reduce_expected_command(
            result,
            CleanupCommand::SignalProcessGroup {
                guard,
                signal: SIGKILL,
            },
            CleanupObservation::ProcessGroupSignalled {
                started_at: term_deadline,
                completed_at: term_deadline,
                signal: SIGKILL,
            },
        );
        result = live_child_reconciliation(result, term_deadline, guard, identity);
        let (state, final_sleep) = expect_cleanup_command(result);
        assert_eq!(
            final_sleep,
            CleanupCommand::Sleep {
                guard,
                duration: Duration::from_millis(10),
            }
        );

        assert_eq!(
            cleanup_reduce(
                state,
                CleanupObservation::DeadlineClosed {
                    closed_at: deadline,
                },
            ),
            CleanupResult::Terminal(CleanupTerminal::Retained)
        );
    }

    #[test]
    fn readiness_reducer_anchors_term_deadline_when_eof_poll_completion_overshoots() {
        let started_at = Instant::now();
        let eof_deadline = started_at + Duration::from_millis(100);
        let term_deadline = started_at + Duration::from_millis(200);
        let overshot_at = started_at + Duration::from_millis(150);
        let deadline = started_at + READINESS_CLEANUP_RESERVE;
        let identity = ProcessIdentity {
            process_id: 41,
            started_microseconds: 7,
            started_seconds: 11,
        };
        let guard = Some(deadline);
        let mut result = cleanup_reduce(
            CleanupState::new(
                CleanupPhasePolicy::PreserveFinalReconciliation,
                identity.process_id,
                deadline,
                Some(Duration::from_millis(100)),
            ),
            CleanupObservation::Begin {
                observed_at: started_at,
            },
        );
        result = live_child_reconciliation(result, started_at, guard, identity);
        result = live_child_reconciliation(result, started_at, guard, identity);
        result = reduce_expected_command(
            result,
            CleanupCommand::Sleep {
                guard: Some(eof_deadline),
                duration: Duration::from_millis(10),
            },
            CleanupObservation::Slept {
                started_at: eof_deadline - Duration::from_nanos(1),
                completed_at: overshot_at,
            },
        );
        result = reduce_expected_command(
            result,
            CleanupCommand::SignalProcessGroup {
                guard,
                signal: SIGTERM,
            },
            CleanupObservation::ProcessGroupSignalled {
                started_at: overshot_at,
                completed_at: overshot_at,
                signal: SIGTERM,
            },
        );
        result = live_child_reconciliation(result, overshot_at, guard, identity);
        let (_, command) = expect_cleanup_command(result);
        assert_eq!(
            command,
            CleanupCommand::Sleep {
                guard: Some(term_deadline),
                duration: Duration::from_millis(10),
            }
        );
    }

    #[test]
    fn readiness_reducer_clamps_requested_term_grace_to_actual_entry_remaining() {
        let started_at = Instant::now();
        let eof_deadline = started_at + Duration::from_millis(30);
        let term_deadline = started_at + Duration::from_millis(60);
        let deadline = started_at + Duration::from_millis(90);
        let identity = ProcessIdentity {
            process_id: 41,
            started_microseconds: 7,
            started_seconds: 11,
        };
        let guard = Some(deadline);
        let mut result = cleanup_reduce(
            CleanupState::new(
                CleanupPhasePolicy::PreserveFinalReconciliation,
                identity.process_id,
                deadline,
                Some(Duration::from_millis(100)),
            ),
            CleanupObservation::Begin {
                observed_at: started_at,
            },
        );
        result = live_child_reconciliation(result, started_at, guard, identity);
        result = live_child_reconciliation(result, started_at, guard, identity);
        result = reduce_expected_command(
            result,
            CleanupCommand::Sleep {
                guard: Some(eof_deadline),
                duration: Duration::from_millis(10),
            },
            CleanupObservation::Slept {
                started_at,
                completed_at: eof_deadline,
            },
        );
        result = reduce_expected_command(
            result,
            CleanupCommand::SignalProcessGroup {
                guard,
                signal: SIGTERM,
            },
            CleanupObservation::ProcessGroupSignalled {
                started_at: eof_deadline,
                completed_at: eof_deadline,
                signal: SIGTERM,
            },
        );
        result = live_child_reconciliation(result, eof_deadline, guard, identity);
        let (_, command) = expect_cleanup_command(result);
        assert_eq!(
            command,
            CleanupCommand::Sleep {
                guard: Some(term_deadline),
                duration: Duration::from_millis(10),
            }
        );
    }

    #[test]
    fn cleanup_reducer_retains_for_every_non_strict_or_mismatched_proof() {
        let started_at = Instant::now();
        let deadline = started_at + READINESS_CLEANUP_RESERVE;
        let controller = CleanupController {
            policy: CleanupPhasePolicy::PreserveFinalReconciliation,
            process_group: 41,
            deadline,
            cleanup_started: started_at,
            eof_grace: Duration::from_millis(100),
            term_grace: Duration::from_millis(100),
        };
        let identity = ProcessIdentity {
            process_id: controller.process_group,
            started_microseconds: 7,
            started_seconds: 11,
        };
        let reused = ProcessIdentity {
            process_id: 42,
            ..identity
        };
        let cases = [
            (
                "missing ownership",
                CleanupProofStep::ActiveIdentity,
                None,
                CleanupObservation::ActiveIdentity {
                    started_at,
                    completed_at: started_at,
                    identity: None,
                },
            ),
            (
                "mismatched ownership",
                CleanupProofStep::ActiveIdentity,
                None,
                CleanupObservation::ActiveIdentity {
                    started_at,
                    completed_at: started_at,
                    identity: Some(reused),
                },
            ),
            (
                "reused identity",
                CleanupProofStep::ActiveIdentityStatus,
                Some(identity),
                CleanupObservation::ActiveIdentityStatus {
                    started_at,
                    completed_at: started_at,
                    status: RetainedProcessIdentityStatus::Reused,
                },
            ),
            (
                "unavailable identity",
                CleanupProofStep::ActiveIdentityStatus,
                Some(identity),
                CleanupObservation::ActiveIdentityStatus {
                    started_at,
                    completed_at: started_at,
                    status: RetainedProcessIdentityStatus::Unavailable,
                },
            ),
            (
                "live child",
                CleanupProofStep::ChildExit,
                Some(identity),
                CleanupObservation::ChildExit {
                    started_at,
                    completed_at: started_at,
                    exited: Some(false),
                },
            ),
            (
                "unavailable child",
                CleanupProofStep::ChildExit,
                Some(identity),
                CleanupObservation::ChildExit {
                    started_at,
                    completed_at: started_at,
                    exited: None,
                },
            ),
            (
                "live descendants",
                CleanupProofStep::Descendants,
                Some(identity),
                CleanupObservation::Descendants {
                    started_at,
                    completed_at: started_at,
                    alive: Some(true),
                },
            ),
            (
                "unavailable descendants",
                CleanupProofStep::Descendants,
                Some(identity),
                CleanupObservation::Descendants {
                    started_at,
                    completed_at: started_at,
                    alive: None,
                },
            ),
            (
                "live owned descendants",
                CleanupProofStep::OwnedDescendants,
                Some(identity),
                CleanupObservation::OwnedDescendants {
                    started_at,
                    completed_at: started_at,
                    alive: Some(true),
                },
            ),
            (
                "unavailable owned descendants",
                CleanupProofStep::OwnedDescendants,
                Some(identity),
                CleanupObservation::OwnedDescendants {
                    started_at,
                    completed_at: started_at,
                    alive: None,
                },
            ),
            (
                "wait failure",
                CleanupProofStep::WaitChild,
                Some(identity),
                CleanupObservation::ChildWaited {
                    started_at,
                    completed_at: started_at,
                    reaped: false,
                },
            ),
            (
                "present group",
                CleanupProofStep::GroupPresence,
                Some(identity),
                CleanupObservation::GroupPresence {
                    started_at,
                    completed_at: started_at,
                    status: ProcessPresenceStatus::Present,
                },
            ),
            (
                "unavailable group",
                CleanupProofStep::GroupPresence,
                Some(identity),
                CleanupObservation::GroupPresence {
                    started_at,
                    completed_at: started_at,
                    status: ProcessPresenceStatus::Unavailable,
                },
            ),
            (
                "owned process alive",
                CleanupProofStep::OwnedStopped,
                Some(identity),
                CleanupObservation::OwnedStopped {
                    started_at,
                    completed_at: started_at,
                    stopped: Some(false),
                },
            ),
            (
                "owned process unavailable",
                CleanupProofStep::OwnedStopped,
                Some(identity),
                CleanupObservation::OwnedStopped {
                    started_at,
                    completed_at: started_at,
                    stopped: None,
                },
            ),
            (
                "retirement failure",
                CleanupProofStep::RetireOwnership,
                Some(identity),
                CleanupObservation::OwnershipRetired {
                    started_at,
                    completed_at: started_at,
                    retired: false,
                },
            ),
            (
                "premature observation",
                CleanupProofStep::ActiveIdentity,
                None,
                CleanupObservation::ChildExit {
                    started_at,
                    completed_at: started_at,
                    exited: Some(true),
                },
            ),
        ];

        for (name, step, retained_identity, observation) in cases {
            let child_exited = matches!(
                step,
                CleanupProofStep::Descendants
                    | CleanupProofStep::OwnedDescendants
                    | CleanupProofStep::WaitChild
                    | CleanupProofStep::GroupPresence
                    | CleanupProofStep::OwnedStopped
                    | CleanupProofStep::RetireOwnership
            )
            .then_some(true);
            let descendants_alive = matches!(
                step,
                CleanupProofStep::OwnedDescendants
                    | CleanupProofStep::WaitChild
                    | CleanupProofStep::GroupPresence
                    | CleanupProofStep::OwnedStopped
                    | CleanupProofStep::RetireOwnership
            )
            .then_some(false);
            let state = CleanupState::Reconciling {
                controller,
                continuation: CleanupContinuation::Final,
                step,
                proof: CleanupProof {
                    identity: retained_identity,
                    child_exited,
                    descendants_alive,
                },
            };
            let mut result = cleanup_reduce(state, observation);
            if matches!(
                result,
                CleanupResult::Command {
                    command: CleanupCommand::ObserveDescendants { .. },
                    ..
                }
            ) {
                let (state, _) = expect_cleanup_command(result);
                result = cleanup_reduce(
                    state,
                    CleanupObservation::Descendants {
                        started_at,
                        completed_at: started_at,
                        alive: Some(false),
                    },
                );
            }
            if matches!(
                result,
                CleanupResult::Command {
                    command: CleanupCommand::ObserveOwnedDescendants { .. },
                    ..
                }
            ) {
                let (state, _) = expect_cleanup_command(result);
                result = cleanup_reduce(
                    state,
                    CleanupObservation::OwnedDescendants {
                        started_at,
                        completed_at: started_at,
                        alive: Some(false),
                    },
                );
            }
            assert_eq!(
                result,
                CleanupResult::Terminal(CleanupTerminal::Retained),
                "{name}"
            );
        }
    }

    #[test]
    fn cleanup_reducer_starts_no_next_primitive_after_a_completion_reaches_cutoff() {
        let started_at = Instant::now();
        let deadline = started_at + READINESS_CLEANUP_RESERVE;
        let before = deadline - Duration::from_nanos(1);
        let controller = CleanupController {
            policy: CleanupPhasePolicy::PreserveFinalReconciliation,
            process_group: 41,
            deadline,
            cleanup_started: started_at,
            eof_grace: Duration::from_millis(100),
            term_grace: Duration::from_millis(100),
        };
        let identity = ProcessIdentity {
            process_id: controller.process_group,
            started_microseconds: 7,
            started_seconds: 11,
        };
        let proof_cases = [
            (
                CleanupProofStep::ActiveIdentity,
                None,
                CleanupObservation::ActiveIdentity {
                    started_at: before,
                    completed_at: deadline,
                    identity: Some(identity),
                },
            ),
            (
                CleanupProofStep::ActiveIdentityStatus,
                Some(identity),
                CleanupObservation::ActiveIdentityStatus {
                    started_at: before,
                    completed_at: deadline,
                    status: RetainedProcessIdentityStatus::Current,
                },
            ),
            (
                CleanupProofStep::ChildExit,
                Some(identity),
                CleanupObservation::ChildExit {
                    started_at: before,
                    completed_at: deadline,
                    exited: Some(true),
                },
            ),
            (
                CleanupProofStep::Descendants,
                Some(identity),
                CleanupObservation::Descendants {
                    started_at: before,
                    completed_at: deadline,
                    alive: Some(false),
                },
            ),
            (
                CleanupProofStep::OwnedDescendants,
                Some(identity),
                CleanupObservation::OwnedDescendants {
                    started_at: before,
                    completed_at: deadline,
                    alive: Some(false),
                },
            ),
            (
                CleanupProofStep::WaitChild,
                Some(identity),
                CleanupObservation::ChildWaited {
                    started_at: before,
                    completed_at: deadline,
                    reaped: true,
                },
            ),
            (
                CleanupProofStep::GroupPresence,
                Some(identity),
                CleanupObservation::GroupPresence {
                    started_at: before,
                    completed_at: deadline,
                    status: ProcessPresenceStatus::Absent,
                },
            ),
            (
                CleanupProofStep::OwnedStopped,
                Some(identity),
                CleanupObservation::OwnedStopped {
                    started_at: before,
                    completed_at: deadline,
                    stopped: Some(true),
                },
            ),
        ];
        for (step, retained_identity, observation) in proof_cases {
            assert_eq!(
                cleanup_reduce(
                    CleanupState::Reconciling {
                        controller,
                        continuation: CleanupContinuation::Final,
                        step,
                        proof: CleanupProof {
                            identity: retained_identity,
                            ..CleanupProof::default()
                        },
                    },
                    observation,
                ),
                CleanupResult::Terminal(CleanupTerminal::Retained)
            );
        }

        let effect_cases = [
            (
                CleanupEffect::Sleep {
                    phase_deadline: deadline,
                    after: CleanupAfterPoll::SignalTerm,
                },
                CleanupObservation::Slept {
                    started_at: before,
                    completed_at: deadline,
                },
            ),
            (
                CleanupEffect::SignalTerm,
                CleanupObservation::ProcessGroupSignalled {
                    started_at: before,
                    completed_at: deadline,
                    signal: SIGTERM,
                },
            ),
            (
                CleanupEffect::RefreshOwned,
                CleanupObservation::OwnedRefreshed {
                    started_at: before,
                    completed_at: deadline,
                    refreshed: true,
                },
            ),
            (
                CleanupEffect::SignalDescendants,
                CleanupObservation::DescendantsSignalled {
                    started_at: before,
                    completed_at: deadline,
                    signal: SIGKILL,
                    signalled: true,
                },
            ),
            (
                CleanupEffect::SignalGroupKill,
                CleanupObservation::ProcessGroupSignalled {
                    started_at: before,
                    completed_at: deadline,
                    signal: SIGKILL,
                },
            ),
        ];
        for (effect, observation) in effect_cases {
            assert_eq!(
                cleanup_reduce(
                    CleanupState::AwaitingEffect { controller, effect },
                    observation,
                ),
                CleanupResult::Terminal(CleanupTerminal::Retained)
            );
        }
    }

    #[test]
    fn cleanup_reducer_rejects_deadline_closed_for_every_pending_primitive() {
        let started_at = Instant::now();
        let deadline = started_at + READINESS_CLEANUP_RESERVE;
        let controller = CleanupController {
            policy: CleanupPhasePolicy::PreserveFinalReconciliation,
            process_group: 41,
            deadline,
            cleanup_started: started_at,
            eof_grace: Duration::from_millis(100),
            term_grace: Duration::from_millis(100),
        };
        let identity = ProcessIdentity {
            process_id: controller.process_group,
            started_microseconds: 7,
            started_seconds: 11,
        };
        for step in [
            CleanupProofStep::ActiveIdentity,
            CleanupProofStep::ActiveIdentityStatus,
            CleanupProofStep::ChildExit,
            CleanupProofStep::Descendants,
            CleanupProofStep::OwnedDescendants,
            CleanupProofStep::WaitChild,
            CleanupProofStep::GroupPresence,
            CleanupProofStep::OwnedStopped,
            CleanupProofStep::RetireOwnership,
        ] {
            assert_eq!(
                cleanup_reduce(
                    CleanupState::Reconciling {
                        controller,
                        continuation: CleanupContinuation::Final,
                        step,
                        proof: CleanupProof {
                            identity: Some(identity),
                            ..CleanupProof::default()
                        },
                    },
                    CleanupObservation::DeadlineClosed {
                        closed_at: deadline,
                    },
                ),
                CleanupResult::Terminal(CleanupTerminal::Retained)
            );
        }
        for effect in [
            CleanupEffect::Sleep {
                phase_deadline: deadline,
                after: CleanupAfterPoll::SignalTerm,
            },
            CleanupEffect::SignalTerm,
            CleanupEffect::RefreshOwned,
            CleanupEffect::SignalDescendants,
            CleanupEffect::SignalGroupKill,
        ] {
            assert_eq!(
                cleanup_reduce(
                    CleanupState::AwaitingEffect { controller, effect },
                    CleanupObservation::DeadlineClosed {
                        closed_at: deadline,
                    },
                ),
                CleanupResult::Terminal(CleanupTerminal::Retained)
            );
        }
    }

    #[test]
    fn cleanup_reducer_rejects_invalid_initial_and_mismatched_effect_results() {
        let started_at = Instant::now();
        let deadline = started_at + READINESS_CLEANUP_RESERVE;
        let controller = CleanupController {
            policy: CleanupPhasePolicy::PreserveFinalReconciliation,
            process_group: 41,
            deadline,
            cleanup_started: started_at,
            eof_grace: Duration::from_millis(100),
            term_grace: Duration::from_millis(100),
        };
        assert_eq!(
            cleanup_reduce(
                CleanupState::new(
                    controller.policy,
                    controller.process_group,
                    controller.deadline,
                    Some(controller.term_grace),
                ),
                CleanupObservation::Slept {
                    started_at,
                    completed_at: started_at,
                },
            ),
            CleanupResult::Terminal(CleanupTerminal::Retained)
        );
        let cases = [
            (
                CleanupEffect::Sleep {
                    phase_deadline: deadline,
                    after: CleanupAfterPoll::SignalTerm,
                },
                CleanupObservation::OwnedRefreshed {
                    started_at,
                    completed_at: started_at,
                    refreshed: true,
                },
            ),
            (
                CleanupEffect::SignalTerm,
                CleanupObservation::ProcessGroupSignalled {
                    started_at,
                    completed_at: started_at,
                    signal: SIGKILL,
                },
            ),
            (
                CleanupEffect::RefreshOwned,
                CleanupObservation::Slept {
                    started_at,
                    completed_at: started_at,
                },
            ),
            (
                CleanupEffect::SignalDescendants,
                CleanupObservation::DescendantsSignalled {
                    started_at,
                    completed_at: started_at,
                    signal: SIGTERM,
                    signalled: true,
                },
            ),
            (
                CleanupEffect::SignalGroupKill,
                CleanupObservation::ProcessGroupSignalled {
                    started_at,
                    completed_at: started_at,
                    signal: SIGTERM,
                },
            ),
        ];
        for (effect, observation) in cases {
            assert_eq!(
                cleanup_reduce(
                    CleanupState::AwaitingEffect { controller, effect },
                    observation,
                ),
                CleanupResult::Terminal(CleanupTerminal::Retained)
            );
        }
    }

    #[test]
    fn cleanup_reducer_accepts_late_completion_only_after_retirement_already_succeeded() {
        let started_at = Instant::now();
        let deadline = started_at + READINESS_CLEANUP_RESERVE;
        let identity = ProcessIdentity {
            process_id: 41,
            started_microseconds: 7,
            started_seconds: 11,
        };
        let controller = CleanupController {
            policy: CleanupPhasePolicy::PreserveFinalReconciliation,
            process_group: identity.process_id,
            deadline,
            cleanup_started: started_at,
            eof_grace: Duration::from_millis(100),
            term_grace: Duration::from_millis(100),
        };
        assert_eq!(
            cleanup_reduce(
                CleanupState::Reconciling {
                    controller,
                    continuation: CleanupContinuation::Final,
                    step: CleanupProofStep::RetireOwnership,
                    proof: CleanupProof {
                        identity: Some(identity),
                        ..CleanupProof::default()
                    },
                },
                CleanupObservation::OwnershipRetired {
                    started_at: deadline - Duration::from_nanos(1),
                    completed_at: deadline,
                    retired: true,
                },
            ),
            CleanupResult::Terminal(CleanupTerminal::Cleaned)
        );
    }

    #[test]
    fn cleanup_reducer_sleep_completion_at_phase_boundary_advances_without_another_poll() {
        let started_at = Instant::now();
        let phase_deadline = started_at + Duration::from_millis(100);
        let deadline = started_at + READINESS_CLEANUP_RESERVE;
        let controller = CleanupController {
            policy: CleanupPhasePolicy::PreserveFinalReconciliation,
            process_group: 41,
            deadline,
            cleanup_started: started_at,
            eof_grace: Duration::from_millis(100),
            term_grace: Duration::from_millis(100),
        };
        for completed_at in [phase_deadline, phase_deadline + Duration::from_nanos(1)] {
            let result = cleanup_reduce(
                CleanupState::AwaitingEffect {
                    controller,
                    effect: CleanupEffect::Sleep {
                        phase_deadline,
                        after: CleanupAfterPoll::SignalTerm,
                    },
                },
                CleanupObservation::Slept {
                    started_at: phase_deadline - Duration::from_nanos(1),
                    completed_at,
                },
            );
            let (_, command) = expect_cleanup_command(result);
            assert_eq!(
                command,
                CleanupCommand::SignalProcessGroup {
                    guard: Some(deadline),
                    signal: SIGTERM,
                }
            );
        }
    }

    #[test]
    fn readiness_reducer_kills_the_group_after_signalling_live_descendants() {
        let started_at = Instant::now();
        let deadline = started_at + READINESS_CLEANUP_RESERVE;
        let controller = CleanupController {
            policy: CleanupPhasePolicy::PreserveFinalReconciliation,
            process_group: 41,
            deadline,
            cleanup_started: started_at,
            eof_grace: Duration::from_millis(100),
            term_grace: Duration::from_millis(100),
        };
        let result = cleanup_reduce(
            CleanupState::AwaitingEffect {
                controller,
                effect: CleanupEffect::SignalDescendants,
            },
            CleanupObservation::DescendantsSignalled {
                started_at,
                completed_at: started_at,
                signal: SIGKILL,
                signalled: true,
            },
        );
        let (_, command) = expect_cleanup_command(result);
        assert_eq!(
            command,
            CleanupCommand::SignalProcessGroup {
                guard: Some(deadline),
                signal: SIGKILL,
            }
        );
    }

    #[test]
    fn turn_cleanup_reducer_preserves_full_poll_and_effect_order() {
        let started_at = Instant::now();
        let deadline = started_at + TURN_CLEANUP_RESERVE;
        let eof_deadline = started_at + STDIN_EOF_GRACE;
        let term_deadline = eof_deadline + CANCEL_TERM_GRACE;
        let descendant_deadline = term_deadline + DESCENDANT_REAP_GRACE;
        let identity = ProcessIdentity {
            process_id: 41,
            started_microseconds: 7,
            started_seconds: 11,
        };
        let mut result = cleanup_reduce(
            CleanupState::new(
                CleanupPhasePolicy::AllowParentReap,
                identity.process_id,
                deadline,
                Some(CANCEL_TERM_GRACE),
            ),
            CleanupObservation::Begin {
                observed_at: started_at,
            },
        );

        result = live_child_reconciliation(result, started_at, None, identity);
        result = live_child_reconciliation(result, started_at, None, identity);
        result = reduce_expected_command(
            result,
            CleanupCommand::Sleep {
                guard: None,
                duration: Duration::from_millis(10),
            },
            CleanupObservation::Slept {
                started_at,
                completed_at: eof_deadline,
            },
        );
        result = reduce_expected_command(
            result,
            CleanupCommand::SignalProcessGroup {
                guard: None,
                signal: SIGTERM,
            },
            CleanupObservation::ProcessGroupSignalled {
                started_at: eof_deadline,
                completed_at: eof_deadline,
                signal: SIGTERM,
            },
        );
        result = live_child_reconciliation(result, eof_deadline, None, identity);
        result = reduce_expected_command(
            result,
            CleanupCommand::Sleep {
                guard: None,
                duration: Duration::from_millis(10),
            },
            CleanupObservation::Slept {
                started_at: eof_deadline,
                completed_at: term_deadline,
            },
        );
        result = reduce_expected_command(
            result,
            CleanupCommand::RefreshOwned { guard: None },
            CleanupObservation::OwnedRefreshed {
                started_at: term_deadline,
                completed_at: term_deadline,
                refreshed: true,
            },
        );
        result = reduce_expected_command(
            result,
            CleanupCommand::SignalDescendants {
                guard: None,
                signal: SIGKILL,
            },
            CleanupObservation::DescendantsSignalled {
                started_at: term_deadline,
                completed_at: term_deadline,
                signal: SIGKILL,
                signalled: true,
            },
        );
        result = live_child_reconciliation(result, term_deadline, None, identity);
        result = reduce_expected_command(
            result,
            CleanupCommand::Sleep {
                guard: None,
                duration: Duration::from_millis(10),
            },
            CleanupObservation::Slept {
                started_at: term_deadline,
                completed_at: descendant_deadline,
            },
        );
        result = reduce_expected_command(
            result,
            CleanupCommand::SignalProcessGroup {
                guard: None,
                signal: SIGKILL,
            },
            CleanupObservation::ProcessGroupSignalled {
                started_at: descendant_deadline,
                completed_at: descendant_deadline,
                signal: SIGKILL,
            },
        );
        result = live_child_reconciliation(result, descendant_deadline, None, identity);
        result = reduce_expected_command(
            result,
            CleanupCommand::Sleep {
                guard: None,
                duration: Duration::from_millis(10),
            },
            CleanupObservation::Slept {
                started_at: descendant_deadline,
                completed_at: deadline,
            },
        );

        assert_eq!(
            strict_cleanup_reconciliation(result, deadline, None, identity),
            CleanupResult::Terminal(CleanupTerminal::Cleaned)
        );
    }

    #[test]
    fn turn_cleanup_reducer_preserves_strict_parent_reap_after_the_deadline() {
        let started_at = Instant::now();
        let deadline = started_at + TURN_CLEANUP_RESERVE;
        let identity = ProcessIdentity {
            process_id: 41,
            started_microseconds: 7,
            started_seconds: 11,
        };
        let result = cleanup_reduce(
            CleanupState::new(
                CleanupPhasePolicy::AllowParentReap,
                identity.process_id,
                deadline,
                Some(CANCEL_TERM_GRACE),
            ),
            CleanupObservation::Begin {
                observed_at: deadline,
            },
        );
        assert_eq!(
            strict_cleanup_reconciliation(result, deadline, None, identity),
            CleanupResult::Terminal(CleanupTerminal::Cleaned)
        );
    }

    #[test]
    fn real_cleanup_executor_refuses_an_expired_sleep_without_invoking_it() {
        let mut child = Command::new("/usr/bin/true")
            .spawn()
            .expect("executor guard child");
        let active = ActiveRuntime::default();
        let process_group = child.id() as i32;
        let mut executor = RealCleanupExecutor {
            child: &mut child,
            process_group,
            active: &active,
        };
        let observation = executor.execute(CleanupCommand::Sleep {
            guard: Some(Instant::now() - Duration::from_nanos(1)),
            duration: Duration::from_millis(1),
        });
        assert!(matches!(
            observation,
            CleanupObservation::DeadlineClosed { .. }
        ));
        child.wait().expect("executor guard child reap");
    }

    #[test]
    fn readiness_cleanup_rejects_an_expired_entry_without_retiring_ownership() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("read -r release || exit 0; while read -r control; do :; done")
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("expired readiness cleanup process");
        let process_group = child.id() as i32;
        let (stdout_sender, stdout_receiver) = mpsc::sync_channel(1);
        let stdout_available = child.stdout.take().is_some_and(|stdout| {
            spawn_stdout_reader(stdout, stdout_sender, Arc::new(AtomicUsize::new(0)));
            true
        });
        let active = ActiveRuntime::default();
        let Some(token) = publish_blocked_fixture(&child, process_group, &active) else {
            let settled = settle_unpublished_fixture(&mut child, process_group, &active);
            assert!(settled);
            panic!("expired fixture publication failed after teardown");
        };
        let retained_identity = token.0;
        let release = child
            .stdin
            .as_mut()
            .is_some_and(|stdin| writeln!(stdin, "release").is_ok());
        let readiness_timeout = (release && stdout_available)
            .then(|| stdout_receiver.recv_timeout(Duration::from_millis(10)));
        let control = child.stdin.take();

        let cleaned = stop_process_group_with_term_grace(
            &mut child,
            process_group,
            &active,
            Instant::now() - Duration::from_millis(1),
            Some(Duration::ZERO),
            CleanupPhasePolicy::PreserveFinalReconciliation,
        );
        let late_reconciled = stop_process_group_with_term_grace(
            &mut child,
            process_group,
            &active,
            Instant::now() - Duration::from_millis(1),
            Some(Duration::ZERO),
            CleanupPhasePolicy::PreserveFinalReconciliation,
        );
        let retained = active.process_group.lock().ok().and_then(|group| *group);
        let still_running = process_group_exists(process_group);
        drop(control);
        let mut recovered = stop_process_group(
            &mut child,
            process_group,
            &active,
            Instant::now() + Duration::from_secs(1),
        );
        if !recovered {
            let _ = signal_active_process_group(&active, process_group, SIGKILL);
            recovered =
                reconcile_retained_process_group(&active, Instant::now() + Duration::from_secs(5));
        }
        let group_absent = !process_group_exists(process_group);
        let direct_child_reaped = finish_owned_child(token, &mut child, process_group, &active);
        let ownership_retired = active.process_group.lock().ok().and_then(|group| *group);
        let owned_stopped = authenticated_owned_processes_status(&active);

        assert!(release);
        assert!(matches!(
            readiness_timeout,
            Some(Err(RecvTimeoutError::Timeout))
        ));
        assert!(!cleaned);
        assert!(!late_reconciled);
        assert_eq!(retained, Some(retained_identity));
        assert!(still_running);
        assert!(recovered, "authenticated test recovery did not complete");
        assert!(group_absent);
        assert!(direct_child_reaped);
        assert_eq!(ownership_retired, None);
        assert_eq!(owned_stopped, Some(true));
    }

    #[test]
    fn readiness_cleanup_smoke_reports_strict_success_or_retained_failure() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let work_directory = fixture.work.join("readiness-cleanup-smoke");
        fs::create_dir(&work_directory).expect("readiness cleanup work");
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg(
                "trap '' TERM; read -r release || exit 0; /bin/sh -c \"trap '' TERM; printf 'ready\\n'; while read -r line; do :; done\" <&0 & wait; printf 'reaped\\n'",
            )
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("TERM-resistant readiness process");
        let process_group = child.id() as i32;
        let (stdout_sender, stdout_receiver) = mpsc::sync_channel(2);
        let stdout_available = child.stdout.take().is_some_and(|stdout| {
            spawn_stdout_reader(stdout, stdout_sender, Arc::new(AtomicUsize::new(0)));
            true
        });
        let active = ActiveRuntime::default();
        let Some(token) = publish_blocked_fixture(&child, process_group, &active) else {
            let settled = settle_unpublished_fixture(&mut child, process_group, &active);
            assert!(settled);
            panic!("smoke fixture publication failed after teardown");
        };
        let exact_identity = token.0;
        let release = child
            .stdin
            .as_mut()
            .is_some_and(|stdin| writeln!(stdin, "release").is_ok());
        let readiness = (release && stdout_available)
            .then(|| stdout_receiver.recv_timeout(Duration::from_secs(1)));
        let ready = readiness.as_ref().is_some_and(
            |event| matches!(event, Ok(FrameEvent::Frame(frame)) if frame == b"ready"),
        );
        if !ready {
            drop(child.stdin.take());
        }
        let control = child.stdin.take();
        let outcome = cleanup_after(
            child,
            process_group,
            RuntimeReadinessState::TimedOut,
            0,
            &active,
            Instant::now() + READINESS_CLEANUP_RESERVE,
        );
        let work_cleaned = finalize_readiness_work(&active, &work_directory, &outcome);
        let product_state = if outcome.cleaned && work_cleaned {
            outcome.state
        } else {
            RuntimeReadinessState::CleanupFailed
        };
        let original_cleaned = outcome.cleaned;
        let product_ownership = active.process_group.lock().ok().and_then(|group| *group);
        let product_group_presence = process_group_presence(process_group);
        let product_owned_stopped = authenticated_owned_processes_status(&active);
        let product_child_reaped = child_exited_without_reaping(process_group)
            .is_err_and(|error| error.raw_os_error() == Some(MACOS_ECHILD));
        let product_work_exists = work_directory.exists();
        let product_retained_work = active
            .retained_work_directories
            .lock()
            .ok()
            .is_some_and(|retained| retained.contains(&work_directory));

        drop(control);
        let mut process_recovered = original_cleaned;
        if !process_recovered {
            process_recovered =
                reconcile_retained_process_group(&active, Instant::now() + Duration::from_secs(5));
            if !process_recovered {
                let _ = signal_active_process_group(&active, process_group, SIGKILL);
                process_recovered = reconcile_retained_process_group(
                    &active,
                    Instant::now() + Duration::from_secs(5),
                );
            }
        }
        let eof_finalized = matches!(
            finalize_exact_child_after_eof(token),
            DirectChildFinalization::Settled
        );
        let work_recovered = reconcile_retained_work_directories(&active);
        let final_ownership = active.process_group.lock().ok().and_then(|group| *group);
        let final_group_presence = process_group_presence(process_group);
        let final_owned_stopped = authenticated_owned_processes_status(&active);
        let final_child_reaped = child_exited_without_reaping(process_group)
            .is_err_and(|error| error.raw_os_error() == Some(MACOS_ECHILD));
        let final_work_absent = !work_directory.exists()
            && active
                .retained_work_directories
                .lock()
                .ok()
                .is_some_and(|retained| retained.is_empty());
        let teardown_proven = process_recovered
            && work_recovered
            && eof_finalized
            && final_child_reaped
            && final_ownership.is_none()
            && final_group_presence == ProcessPresenceStatus::Absent
            && final_owned_stopped == Some(true)
            && final_work_absent;

        assert!(ready);
        match product_state {
            RuntimeReadinessState::TimedOut => {
                assert!(original_cleaned);
                assert!(work_cleaned);
                assert_eq!(product_ownership, None);
                assert_eq!(product_group_presence, ProcessPresenceStatus::Absent);
                assert_eq!(product_owned_stopped, Some(true));
                assert!(product_child_reaped);
                assert!(!product_work_exists);
                assert!(!product_retained_work);
            }
            RuntimeReadinessState::CleanupFailed => {
                assert!(!original_cleaned);
                assert!(!work_cleaned);
                assert_eq!(product_ownership, Some(exact_identity));
                assert!(product_work_exists);
                assert!(product_retained_work);
            }
            state => panic!("unexpected 300ms cleanup result: {state:?}"),
        }
        assert!(teardown_proven);
    }

    #[test]
    fn descendant_kill_allows_term_resistant_parent_to_wait_and_reap() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg(
                "trap '' TERM; read -r release || exit 0; /bin/sh -c \"trap '' TERM; printf 'ready\\n'; while read -r line; do :; done\" <&0 & wait; printf 'reaped\\n'",
            )
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("TERM-resistant parent and descendant");
        let process_group = child.id() as i32;
        let (stdout_sender, stdout_receiver) = mpsc::sync_channel(2);
        let stdout_available = child.stdout.take().is_some_and(|stdout| {
            spawn_stdout_reader(stdout, stdout_sender, Arc::new(AtomicUsize::new(0)));
            true
        });
        let active = ActiveRuntime::default();
        let Some(token) = publish_blocked_fixture(&child, process_group, &active) else {
            let settled = settle_unpublished_fixture(&mut child, process_group, &active);
            assert!(settled);
            panic!("strict fixture publication failed after teardown");
        };
        let release = child
            .stdin
            .as_mut()
            .is_some_and(|stdin| writeln!(stdin, "release").is_ok());
        let readiness = (release && stdout_available)
            .then(|| stdout_receiver.recv_timeout(Duration::from_secs(1)));
        let ready = readiness.as_ref().is_some_and(
            |event| matches!(event, Ok(FrameEvent::Frame(frame)) if frame == b"ready"),
        );
        if !ready {
            drop(child.stdin.take());
        }
        let refreshed = refresh_owned_processes(&active);
        let term_signalled = signal_active_process_group(&active, process_group, SIGTERM);
        let group_survived_term = process_group_exists(process_group);
        let descendants_after_term = process_group_has_descendants(process_group, process_group);
        let descendants_signalled = signal_active_descendants(&active, process_group, SIGKILL);
        let reap_deadline = Instant::now() + Duration::from_secs(5);
        let mut product_reconciled = false;
        while Instant::now() < reap_deadline {
            if reconcile_stopped_process_group(&mut child, process_group, &active) {
                product_reconciled = true;
                break;
            }
            thread::yield_now();
        }

        drop(child.stdin.take());
        let recovered = product_reconciled
            || stop_process_group(
                &mut child,
                process_group,
                &active,
                Instant::now() + Duration::from_secs(5),
            );
        let mut teardown_reconciled = recovered;
        if !teardown_reconciled {
            let _ = signal_active_process_group(&active, process_group, SIGKILL);
            teardown_reconciled =
                reconcile_retained_process_group(&active, Instant::now() + Duration::from_secs(5));
        }

        let retained = active.process_group.lock().ok().and_then(|group| *group);
        let owned_stopped = authenticated_owned_processes_status(&active);
        let group_presence = process_group_presence(process_group);
        let direct_child_reaped = finish_owned_child(token, &mut child, process_group, &active);
        let no_retained_work = active
            .retained_work_directories
            .lock()
            .ok()
            .is_some_and(|retained| retained.is_empty());
        let reap_marker = if group_presence == ProcessPresenceStatus::Absent
            && direct_child_reaped
            && owned_stopped == Some(true)
        {
            stdout_receiver.recv_timeout(Duration::from_secs(1))
        } else {
            Err(RecvTimeoutError::Disconnected)
        };

        assert!(release);
        assert!(ready);
        assert!(refreshed);
        assert!(term_signalled);
        assert!(group_survived_term);
        assert!(descendants_after_term.as_ref().is_ok_and(|alive| *alive));
        assert!(descendants_signalled);
        assert!(product_reconciled, "parent did not reap descendant");
        assert!(
            recovered,
            "test-owned recovery must not count as product success"
        );
        assert!(teardown_reconciled);
        assert_eq!(retained, None);
        assert_eq!(owned_stopped, Some(true));
        assert_eq!(group_presence, ProcessPresenceStatus::Absent);
        assert!(direct_child_reaped);
        assert!(no_retained_work);
        assert!(matches!(
            reap_marker,
            Ok(FrameEvent::Frame(frame)) if frame == b"reaped"
        ));
    }

    #[test]
    fn final_cleanup_reconciliation_reaps_an_exited_absent_process_group() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("printf 'ready\\n'; read -r line")
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("reconciliation process");
        let process_group = child.id() as i32;
        let mut stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        let mut ready = String::new();
        stdout.read_line(&mut ready).expect("readiness handshake");
        assert_eq!(ready, "ready\n");

        let active = ActiveRuntime::default();
        assert!(publish_active_process_group(&active, process_group));
        drop(child.stdin.take());
        let exit_deadline = Instant::now() + Duration::from_secs(1);
        while !child_exited_without_reaping(process_group).expect("direct-child exit state") {
            assert!(Instant::now() < exit_deadline, "direct child did not exit");
            thread::yield_now();
        }
        assert!(!process_group_exists(process_group));

        assert!(reconcile_stopped_process_group(
            &mut child,
            process_group,
            &active,
        ));
        assert_eq!(
            *active.process_group.lock().expect("process-group state"),
            None
        );
    }

    #[test]
    fn final_cleanup_reconciliation_rejects_a_mismatched_active_group() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut exited = Command::new("/bin/sh")
            .arg("-c")
            .arg("printf 'ready\\n'; read -r line")
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("exited reconciliation process");
        let exited_group = exited.id() as i32;
        let mut stdout = BufReader::new(exited.stdout.take().expect("child stdout"));
        let mut ready = String::new();
        stdout.read_line(&mut ready).expect("readiness handshake");
        assert_eq!(ready, "ready\n");
        drop(exited.stdin.take());
        let exit_deadline = Instant::now() + Duration::from_secs(1);
        while !child_exited_without_reaping(exited_group).expect("direct-child exit state") {
            assert!(Instant::now() < exit_deadline, "direct child did not exit");
            thread::yield_now();
        }
        assert!(!process_group_exists(exited_group));

        let mut live = Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("live active process group");
        let live_group = live.id() as i32;
        let active = ActiveRuntime::default();
        assert!(publish_active_process_group(&active, live_group));
        let live_identity = process_identity(live_group).expect("live process-group identity");

        let reconciled = reconcile_stopped_process_group(&mut exited, exited_group, &active);
        let exited_still_reapable = child_exited_without_reaping(exited_group).unwrap_or(false);
        let retained = *active.process_group.lock().expect("retained active group");
        let live_group_exists = process_group_exists(live_group);
        signal_process_group(live_group, SIGKILL);
        let _ = live.wait();
        let _ = exited.wait();

        assert!(!reconciled);
        assert!(exited_still_reapable);
        assert_eq!(retained, Some(live_identity));
        assert!(live_group_exists);
    }

    #[test]
    fn retained_ownership_reconciles_after_the_direct_child_was_reaped() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("printf 'ready\\n'; read -r line")
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("retained reconciliation process");
        let process_group = child.id() as i32;
        let mut stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        let mut ready = String::new();
        stdout.read_line(&mut ready).expect("readiness handshake");
        assert_eq!(ready, "ready\n");

        let active = ActiveRuntime::default();
        assert!(publish_active_process_group(&active, process_group));
        drop(child.stdin.take());
        assert!(child.wait().is_ok());
        assert!(!process_group_exists(process_group));
        assert!(
            active
                .process_group
                .lock()
                .expect("retained process group")
                .is_some()
        );

        assert!(reconcile_retained_process_group(
            &active,
            Instant::now() + Duration::from_secs(1),
        ));
        assert_eq!(
            *active.process_group.lock().expect("process-group state"),
            None
        );
    }

    #[test]
    fn retained_ownership_reaps_an_exited_direct_child_after_handle_drop() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("printf 'ready\\n'; read -r line")
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("unreaped retained reconciliation process");
        let process_group = child.id() as i32;
        let mut stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        let mut ready = String::new();
        stdout.read_line(&mut ready).expect("readiness handshake");
        assert_eq!(ready, "ready\n");

        let active = ActiveRuntime::default();
        assert!(publish_active_process_group(&active, process_group));
        drop(child.stdin.take());
        let exit_deadline = Instant::now() + Duration::from_secs(1);
        while !child_exited_without_reaping(process_group).expect("direct-child exit state") {
            assert!(Instant::now() < exit_deadline, "direct child did not exit");
            thread::yield_now();
        }
        assert!(!process_group_exists(process_group));
        drop(child);

        let reconciled =
            reconcile_retained_process_group(&active, Instant::now() + Duration::from_secs(1));
        let reap_observation = child_exited_without_reaping(process_group);
        if reap_observation.as_ref().is_ok_and(|exited| *exited) {
            let _ = reap_child(process_group);
        }

        assert!(reconciled);
        assert_eq!(
            reap_observation
                .expect_err("retained recovery must reap the direct child")
                .raw_os_error(),
            Some(MACOS_ECHILD)
        );
        assert_eq!(
            *active.process_group.lock().expect("process-group state"),
            None
        );
    }

    #[test]
    fn retained_child_reap_state_distinguishes_every_wait_observation() {
        assert_eq!(
            classify_retained_child_reap_state(Ok(true)),
            RetainedChildReapState::ExitedNeedsReap
        );
        assert_eq!(
            classify_retained_child_reap_state(Ok(false)),
            RetainedChildReapState::Live
        );
        assert_eq!(
            classify_retained_child_reap_state(Err(io::Error::from_raw_os_error(MACOS_ECHILD))),
            RetainedChildReapState::AlreadyReaped
        );
        assert_eq!(
            classify_retained_child_reap_state(Err(io::Error::other("wait unavailable"))),
            RetainedChildReapState::Unavailable
        );
    }

    #[test]
    fn retained_reconciliation_ignores_absent_and_mismatched_registrations() {
        let active = ActiveRuntime::default();
        assert!(retire_retained_process_group_if_stopped(&active, 42));

        let retained = ProcessIdentity {
            process_id: 41,
            started_microseconds: 7,
            started_seconds: 11,
        };
        *active.process_group.lock().expect("process-group state") = Some(retained);

        assert!(retire_retained_process_group_if_stopped(&active, 42));
        assert_eq!(
            *active.process_group.lock().expect("retained process group"),
            Some(retained)
        );
    }

    #[test]
    fn already_expired_deadline_never_creates_runtime_work() {
        let fixture = Fixture::new();
        let host = fixture.scripted_host("#!/bin/sh\nexit 0\n");
        let result = perform_check(
            host.configuration.as_ref().expect("configuration"),
            None,
            &ActiveRuntime::default(),
            &AtomicU64::new(0),
            Instant::now() - Duration::from_millis(1),
        );
        assert_eq!(result.state, RuntimeReadinessState::TimedOut);
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
    }

    #[test]
    fn readiness_work_is_retained_until_runtime_exit_is_proven() {
        let fixture = Fixture::new();
        let active = ActiveRuntime::default();
        let work_directory = fixture.work.join("retained-readiness-work");
        fs::create_dir(&work_directory).expect("readiness work");
        let outcome = ProtocolOutcome {
            state: RuntimeReadinessState::TimedOut,
            quarantined_events: 0,
            cleaned: false,
        };

        assert!(!finalize_readiness_work(&active, &work_directory, &outcome));
        assert!(work_directory.exists());
        assert!(
            active
                .retained_work_directories
                .lock()
                .expect("retained readiness work")
                .contains(&work_directory)
        );
    }

    #[test]
    fn cleanup_escalates_then_retires_a_stubborn_process_group() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("trap '' TERM; printf 'ready\\n'; while :; do /bin/sleep 1; done")
            .process_group(0)
            .stdout(Stdio::piped())
            .spawn()
            .expect("stubborn process group");
        let process_group = child.id() as i32;
        let mut stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        let mut ready = String::new();
        stdout.read_line(&mut ready).expect("readiness handshake");
        assert_eq!(ready, "ready\n");

        let active = ActiveRuntime::default();
        assert!(publish_active_process_group(&active, process_group));
        assert!(stop_process_group(
            &mut child,
            process_group,
            &active,
            Instant::now() + Duration::from_secs(5),
        ));
        assert_eq!(
            *active.process_group.lock().expect("process-group state"),
            None
        );
        assert!(!process_group_exists(process_group));
    }

    #[test]
    fn process_group_publication_requires_a_live_identity_and_available_ownership() {
        let active = ActiveRuntime::default();
        assert!(!publish_active_process_group(&active, i32::MAX));

        let _ = std::panic::catch_unwind(|| {
            let _guard = active
                .process_group
                .lock()
                .expect("initial process-group ownership lock");
            panic!("poison process-group ownership lock");
        });
        assert!(!publish_active_process_group(
            &active,
            std::process::id() as i32,
        ));
    }

    #[test]
    fn unavailable_readiness_publication_reaps_the_blocked_leader_without_release() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        struct ClearProcessGroupPoison<'a>(&'a Mutex<Option<ProcessIdentity>>);
        impl Drop for ClearProcessGroupPoison<'_> {
            fn drop(&mut self) {
                self.0.clear_poison();
            }
        }
        let fixture = Fixture::new();
        let descendant_marker = fixture.work.join("descendant-released");
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("read -r release || exit 0; printf released > \"$DESCENDANT_MARKER\"")
            .env("DESCENDANT_MARKER", &descendant_marker)
            .process_group(0)
            .stdin(Stdio::piped())
            .spawn()
            .expect("blocked publication fixture");
        let process_group = child.id() as i32;
        let active = ActiveRuntime::default();
        let clear_poison = ClearProcessGroupPoison(&active.process_group);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = active
                .process_group
                .lock()
                .expect("publication ownership before poisoning");
            panic!("make readiness publication unavailable");
        }));
        let published = publish_blocked_fixture(&child, process_group, &active);
        drop(clear_poison);
        let settled = settle_unpublished_fixture(&mut child, process_group, &active);
        let group_absent = !process_group_exists(process_group);
        let ownership_absent = active
            .process_group
            .lock()
            .is_ok_and(|group| group.is_none());
        let owned_absent = active
            .owned_processes
            .lock()
            .is_ok_and(|owned| owned.is_empty());
        let work_absent = !descendant_marker.exists()
            && active
                .retained_work_directories
                .lock()
                .is_ok_and(|retained| retained.is_empty());

        assert!(published.is_none() && settled && group_absent);
        assert!(ownership_absent && owned_absent);
        assert!(work_absent, "publication failure released descendant work");

        let mut eof_child = Command::new("/bin/sh")
            .arg("-c")
            .arg("read -r release || exit 0; read -r control || exit 0")
            .process_group(0)
            .stdin(Stdio::piped())
            .spawn()
            .expect("EOF finalizer fixture");
        let process_group = eof_child.id() as i32;
        let eof_active = ActiveRuntime::default();
        let Some(token) = publish_blocked_fixture(&eof_child, process_group, &eof_active) else {
            let settled = settle_unpublished_fixture(&mut eof_child, process_group, &eof_active);
            assert!(settled, "EOF publication teardown was not proven");
            panic!("EOF fixture publication failed after teardown");
        };
        let identity = token.0;
        let released = eof_child
            .stdin
            .as_mut()
            .is_some_and(|stdin| writeln!(stdin, "release").is_ok());
        let retired = retire_active_process_group(&eof_active, identity);
        drop(eof_child.stdin.take());
        let finalized = finish_owned_child(token, &mut eof_child, process_group, &eof_active);
        assert!(released && retired && finalized);
    }

    #[test]
    fn eof_finalizer_refuses_reused_identity_without_reaping_direct_child() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("read -r control || exit 0")
            .process_group(0)
            .stdin(Stdio::piped())
            .spawn()
            .expect("reused identity fixture");
        let process_group = child.id() as i32;
        let exact_identity = process_identity(process_group).expect("exact child identity");
        let reused_identity = ProcessIdentity {
            started_microseconds: exact_identity.started_microseconds.wrapping_add(1),
            ..exact_identity
        };
        let refused = authenticated_direct_child(&child, process_group, reused_identity).is_none();
        let unavailable_identity = unavailable_process_identity(i32::MAX);
        let unavailable_refused =
            authenticated_direct_child(&child, process_group, unavailable_identity).is_none();
        let active = ActiveRuntime::default();
        let mismatch_refused =
            authenticated_direct_child(&child, process_group + 1, exact_identity).is_none()
                && !settle_unpublished_fixture(&mut child, process_group + 1, &active);
        let remained_live = child.try_wait().is_ok_and(|status| status.is_none());
        drop(child.stdin.take());
        let _ = child.kill();
        let reaped = bounded_owned_child_exit(&mut child);
        let group_absent = !process_group_exists(process_group);
        assert!(
            refused
                && unavailable_refused
                && mismatch_refused
                && remained_live
                && reaped
                && group_absent
        );
    }

    #[test]
    fn direct_child_finalization_reducer_fails_closed() {
        use DirectChildState as State;
        let error = |code| Err(io::Error::from_raw_os_error(code));
        for (state, result, group, expected) in [
            (
                State::Waiting(false),
                error(MACOS_ECHILD),
                ProcessPresenceStatus::Present,
                State::Lost,
            ),
            (
                State::Waiting(false),
                error(MACOS_ECHILD),
                ProcessPresenceStatus::Unavailable,
                State::Lost,
            ),
            (
                State::Waiting(false),
                Ok(false),
                ProcessPresenceStatus::Unavailable,
                State::Waiting(true),
            ),
            (
                State::Verifying,
                Ok(false),
                ProcessPresenceStatus::Unavailable,
                State::Lost,
            ),
        ] {
            assert_eq!(reduce_direct_child(state, result, group), expected);
        }
    }

    #[test]
    fn direct_child_terminal_drain_is_independent_of_wait_deadline() {
        use DirectChildState as State;
        let interrupted = || Err(io::Error::from_raw_os_error(TEST_MACOS_EINTR));
        let no_child = || Err(io::Error::from_raw_os_error(MACOS_ECHILD));
        assert!(!continue_direct_child(State::Waiting(false), false, 0));
        let after_cutoff = reduce_direct_child(
            State::Waiting(false),
            Ok(true),
            ProcessPresenceStatus::Unavailable,
        );
        assert!(continue_direct_child(after_cutoff, false, 0));
        let after_reap =
            reduce_direct_child(after_cutoff, Ok(true), ProcessPresenceStatus::Unavailable);
        assert!(continue_direct_child(after_reap, false, 0));
        let after_interrupt = reduce_direct_child(
            after_reap,
            interrupted(),
            ProcessPresenceStatus::Unavailable,
        );
        assert!(continue_direct_child(after_interrupt, false, 1));
        let settled =
            reduce_direct_child(after_interrupt, no_child(), ProcessPresenceStatus::Absent);
        assert_eq!(settled, State::Settled);
        let exhausted = (0..DIRECT_CHILD_TERMINAL_INTERRUPTS).fold(after_cutoff, |state, _| {
            reduce_direct_child(state, interrupted(), ProcessPresenceStatus::Unavailable)
        });
        assert_eq!(exhausted, State::Reaping);
        assert!(!continue_direct_child(
            exhausted,
            false,
            DIRECT_CHILD_TERMINAL_INTERRUPTS,
        ));
    }

    #[test]
    fn direct_child_outcome_allows_only_exact_owned_settlement() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("read -r control || exit 0")
            .process_group(0)
            .stdin(Stdio::piped())
            .spawn()
            .expect("owned outcome fixture");
        let process_group = child.id() as i32;
        let identity = process_identity(process_group).expect("owned outcome identity");
        let active = ActiveRuntime::default();
        let lost_refused = !finish_owned_child_outcome(
            DirectChildFinalization::OwnershipLostOrUnavailable,
            &mut child,
            process_group,
            &active,
        );
        let mismatch = authenticated_direct_child(&child, process_group, identity)
            .expect("mismatch outcome token");
        let mismatch_refused = !finish_owned_child_outcome(
            DirectChildFinalization::StillDirectlyOwned(mismatch),
            &mut child,
            process_group + 1,
            &active,
        );
        let remained_live = child.try_wait().is_ok_and(|status| status.is_none());
        let exact = authenticated_direct_child(&child, process_group, identity)
            .expect("exact outcome token");
        let settled = finish_owned_child_outcome(
            DirectChildFinalization::StillDirectlyOwned(exact),
            &mut child,
            process_group,
            &active,
        );
        assert!(lost_refused && mismatch_refused && remained_live && settled);
        assert!(!process_group_exists(process_group));
    }

    #[test]
    fn cleanup_allows_stdin_eof_to_exit_before_signalling_term() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let term_marker = fixture.root.join("term-marker");
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg(format!(
                "trap 'printf term > {}' TERM; while read -r line; do :; done",
                term_marker.display()
            ))
            .process_group(0)
            .stdin(Stdio::piped())
            .spawn()
            .expect("EOF-aware process group");
        let process_group = child.id() as i32;
        let active = ActiveRuntime::default();
        assert!(publish_active_process_group(&active, process_group));
        drop(child.stdin.take());

        assert!(stop_process_group_with_term_grace(
            &mut child,
            process_group,
            &active,
            Instant::now() + Duration::from_secs(1),
            Some(Duration::from_millis(200)),
            CleanupPhasePolicy::AllowParentReap,
        ));
        assert!(!term_marker.exists());
        assert!(!process_group_exists(process_group));
    }

    #[test]
    fn cleanup_reaps_a_process_that_exits_during_term_grace() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let term_marker = fixture.root.join("term-marker");
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg(format!(
                "trap 'printf term > {}; exit 0' TERM; printf 'ready\\n'; while :; do /bin/sleep 1; done",
                term_marker.display()
            ))
            .process_group(0)
            .stdout(Stdio::piped())
            .spawn()
            .expect("TERM-aware process group");
        let process_group = child.id() as i32;
        let mut stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        let mut ready = String::new();
        stdout.read_line(&mut ready).expect("readiness handshake");
        assert_eq!(ready, "ready\n");
        let active = ActiveRuntime::default();
        assert!(publish_active_process_group(&active, process_group));

        assert!(stop_process_group_with_term_grace(
            &mut child,
            process_group,
            &active,
            Instant::now() + Duration::from_secs(1),
            Some(Duration::from_millis(20)),
            CleanupPhasePolicy::AllowParentReap,
        ));
        assert_eq!(
            fs::read_to_string(term_marker).expect("TERM marker"),
            "term"
        );
        assert!(!process_group_exists(process_group));
    }

    #[test]
    fn cleanup_failure_retains_ownership_until_reconciliation_proves_exit() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("trap '' TERM; while :; do /bin/sleep 1; done")
            .process_group(0)
            .spawn()
            .expect("owned process group");
        let process_group = child.id() as i32;
        let active = ActiveRuntime::default();
        assert!(publish_active_process_group(&active, process_group));
        let process_identity = process_identity(process_group).expect("process-group identity");

        assert!(!stop_process_group(
            &mut child,
            process_group,
            &active,
            Instant::now(),
        ));
        assert_eq!(
            *active.process_group.lock().expect("retained ownership"),
            Some(process_identity)
        );
        assert!(stop_process_group(
            &mut child,
            process_group,
            &active,
            Instant::now() + Duration::from_secs(5),
        ));
        assert_eq!(
            *active.process_group.lock().expect("retired ownership"),
            None
        );
    }

    #[test]
    fn retained_retirement_refuses_live_owned_or_group_members() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        let mut owned_leader = Command::new("/bin/sh")
            .arg("-c")
            .arg(
                "child=''; cleanup() { if [ -n \"$child\" ]; then kill \"$child\" 2>/dev/null; wait \"$child\" 2>/dev/null; fi; }; trap cleanup EXIT TERM INT; exec 3<&0; printf 'leader-ready\\n'; if read -r command; then /bin/sh -c \"trap 'exit 0' TERM INT; printf 'owned-ready\\n'; read -r line\" <&3 & child=$!; wait \"$child\"; fi",
            )
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("owned descendant leader");
        let owned_group = owned_leader.id() as i32;
        let mut owned_stdout = owned_leader.stdout.take().map(BufReader::new);
        let mut owned_stdin = owned_leader.stdin.take();
        let mut leader_ready = String::new();
        let leader_handshake = owned_stdout
            .as_mut()
            .map(|stdout| stdout.read_line(&mut leader_ready));
        let owned_active = ActiveRuntime::default();
        let owned_published = publish_active_process_group(&owned_active, owned_group);
        let owned_identity = owned_active
            .process_group
            .lock()
            .ok()
            .and_then(|group| *group);
        let owned_current = owned_identity.is_some_and(|identity| {
            retained_process_identity_status(identity) == RetainedProcessIdentityStatus::Current
        });
        let spawn_owned = (owned_published && owned_current).then(|| {
            owned_stdin.as_mut().map_or_else(
                || Err(io::Error::other("missing owned leader stdin")),
                |stdin| stdin.write_all(b"spawn\n").and_then(|()| stdin.flush()),
            )
        });
        let mut owned_ready = String::new();
        let owned_handshake = spawn_owned
            .as_ref()
            .is_some_and(Result::is_ok)
            .then(|| {
                owned_stdout
                    .as_mut()
                    .map(|stdout| stdout.read_line(&mut owned_ready))
            })
            .flatten();
        let owned_refreshed = refresh_owned_processes(&owned_active);
        let tracked_owned = owned_active
            .owned_processes
            .lock()
            .ok()
            .and_then(|owned| owned.iter().copied().next());
        let owned_refused = !retire_retained_process_group_if_stopped(&owned_active, owned_group);
        let owned_retained = owned_active
            .process_group
            .lock()
            .ok()
            .and_then(|group| *group);

        let owned_signalled = signal_active_process_group(&owned_active, owned_group, SIGTERM);
        drop(owned_stdin);
        let owned_graceful_exit = bounded_owned_child_exit(&mut owned_leader);
        let _ = owned_leader.kill();
        let owned_waited = owned_graceful_exit | bounded_owned_child_exit(&mut owned_leader);
        let owned_group_absent = !process_group_exists(owned_group);
        let tracked_owned_ended = tracked_owned
            .is_some_and(|identity| process_identity(identity.process_id) != Some(identity));
        let owned_cleanup_retired = owned_identity
            .is_some_and(|identity| retire_active_process_group(&owned_active, identity));
        let owned_group_cleared = owned_active
            .process_group
            .lock()
            .is_ok_and(|group| group.is_none());
        let owned_processes_cleared = owned_active
            .owned_processes
            .lock()
            .is_ok_and(|owned| owned.is_empty());

        assert_eq!(
            leader_handshake
                .expect("leader readiness pipe")
                .expect("leader readiness handshake"),
            13
        );
        assert_eq!(leader_ready, "leader-ready\n");
        assert!(owned_published);
        assert!(owned_current);
        assert!(spawn_owned.is_some_and(|result| result.is_ok()));
        assert_eq!(
            owned_handshake
                .expect("owned readiness pipe")
                .expect("owned readiness handshake"),
            12
        );
        assert_eq!(owned_ready, "owned-ready\n");
        assert!(owned_refreshed);
        assert!(tracked_owned.is_some());
        assert!(owned_refused);
        assert_eq!(owned_retained, owned_identity);
        assert!(owned_signalled);
        assert!(owned_waited);
        assert!(owned_group_absent);
        assert!(tracked_owned_ended);
        assert!(owned_cleanup_retired);
        assert!(owned_group_cleared);
        assert!(owned_processes_cleared);

        let mut group_leader = Command::new("/bin/sh")
            .arg("-c")
            .arg("trap 'exit 0' TERM INT; printf 'leader-ready\\n'; read -r line")
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("same-group leader");
        let same_group = group_leader.id() as i32;
        let group_stdin = group_leader.stdin.take();
        let mut group_stdout = group_leader.stdout.take().map(BufReader::new);
        let mut group_leader_ready = String::new();
        let group_leader_handshake = group_stdout
            .as_mut()
            .map(|stdout| stdout.read_line(&mut group_leader_ready));
        let group_active = ActiveRuntime::default();
        let group_published = publish_active_process_group(&group_active, same_group);
        let group_identity = group_active
            .process_group
            .lock()
            .ok()
            .and_then(|group| *group);
        let group_current = group_identity.is_some_and(|identity| {
            retained_process_identity_status(identity) == RetainedProcessIdentityStatus::Current
        });
        let member_spawn = (group_published && group_current).then(|| {
            Command::new("/bin/sh")
                .arg("-c")
                .arg("trap 'exit 0' TERM INT; printf 'member-ready\\n'; read -r line")
                .process_group(same_group)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
        });
        let member_spawned = member_spawn.as_ref().is_some_and(|result| result.is_ok());
        let mut group_member = member_spawn.and_then(Result::ok);
        let member_stdin = group_member.as_mut().and_then(|child| child.stdin.take());
        let mut member_stdout = group_member
            .as_mut()
            .and_then(|child| child.stdout.take())
            .map(BufReader::new);
        let mut member_ready = String::new();
        let member_handshake = member_stdout
            .as_mut()
            .map(|stdout| stdout.read_line(&mut member_ready));
        let group_refused = !retire_retained_process_group_if_stopped(&group_active, same_group);
        let group_owned_empty = group_active
            .owned_processes
            .lock()
            .is_ok_and(|owned| owned.is_empty());
        let live_group_member =
            process_group_has_descendants(same_group, same_group).unwrap_or(false);
        let group_retained = group_active
            .process_group
            .lock()
            .ok()
            .and_then(|group| *group);

        let group_signalled = signal_active_process_group(&group_active, same_group, SIGTERM);
        drop(group_stdin);
        drop(member_stdin);
        let group_leader_graceful_exit = bounded_owned_child_exit(&mut group_leader);
        let group_member_graceful_exit = group_member.as_mut().map(bounded_owned_child_exit);
        let _ = group_leader.kill();
        let _ = group_member.as_mut().map(Child::kill);
        let group_leader_waited =
            group_leader_graceful_exit | bounded_owned_child_exit(&mut group_leader);
        let group_member_waited = group_member_graceful_exit
            .zip(group_member.as_mut().map(bounded_owned_child_exit))
            .map(|(graceful, killed)| graceful | killed);
        let same_group_absent = !process_group_exists(same_group);
        let group_cleanup_retired = group_identity
            .is_some_and(|identity| retire_active_process_group(&group_active, identity));
        let group_ownership_cleared = group_active
            .process_group
            .lock()
            .is_ok_and(|group| group.is_none());
        let group_owned_processes_cleared = group_active
            .owned_processes
            .lock()
            .is_ok_and(|owned| owned.is_empty());

        assert_eq!(
            group_leader_handshake
                .expect("same-group leader readiness pipe")
                .expect("same-group leader handshake"),
            13
        );
        assert_eq!(group_leader_ready, "leader-ready\n");
        assert!(group_published);
        assert!(group_current);
        assert!(member_spawned);
        assert_eq!(
            member_handshake
                .expect("same-group member readiness pipe")
                .expect("same-group member handshake"),
            13
        );
        assert_eq!(member_ready, "member-ready\n");
        assert!(group_refused);
        assert!(group_owned_empty);
        assert!(live_group_member);
        assert_eq!(group_retained, group_identity);
        assert!(group_signalled);
        assert!(group_leader_waited);
        assert_eq!(group_member_waited, Some(true));
        assert!(same_group_absent);
        assert!(group_cleanup_retired);
        assert!(group_ownership_cleared);
        assert!(group_owned_processes_cleared);
    }

    #[test]
    fn owned_descendant_tracking_is_independent_of_process_group_membership() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut escaped = Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("independent descendant fixture");
        let active = ActiveRuntime::default();
        let leader = std::process::id() as i32;
        assert!(publish_active_process_group(&active, leader));
        assert_eq!(owned_descendants_alive(&active, leader), Some(true));
        let escaped_identity = process_identity(escaped.id() as i32).expect("escaped identity");
        let reused = ProcessIdentity {
            started_microseconds: escaped_identity.started_microseconds.wrapping_add(1),
            ..escaped_identity
        };
        active
            .owned_processes
            .lock()
            .expect("owned process state")
            .insert(reused);
        assert_ne!(process_identity(reused.process_id), Some(reused));
        signal_process(escaped.id() as i32, SIGKILL);
        let _ = escaped.wait();
        assert_eq!(owned_descendants_alive(&active, leader), Some(false));
    }

    struct Fixture {
        root: PathBuf,
        binary: PathBuf,
        home: PathBuf,
        work: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "keiko-runtime-test-{}-{}",
                std::process::id(),
                FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir_all(&root).expect("root");
            let root = fs::canonicalize(root).expect("canonical root");
            let binary = root.join("codex");
            let home = root.join("home");
            let work = root.join("work");
            fs::create_dir_all(&home).expect("home");
            fs::create_dir_all(&work).expect("work");
            fs::write(home.join("installation_id"), b"fixture-installation")
                .expect("installation identity");
            fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).expect("private home");
            fs::set_permissions(&work, fs::Permissions::from_mode(0o700))
                .expect("private work root");
            fs::write(&binary, b"not the approved runtime").expect("binary");
            let mut permissions = fs::metadata(&binary).expect("metadata").permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(&binary, permissions).expect("permissions");
            Self {
                root,
                binary,
                home,
                work,
            }
        }

        fn scripted_host(&self, script: &str) -> RuntimeHost {
            fs::write(&self.binary, script).expect("script");
            let mut permissions = fs::metadata(&self.binary).expect("metadata").permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(&self.binary, permissions).expect("permissions");
            RuntimeHost::for_test(
                self.binary.clone(),
                self.home.clone(),
                self.work.clone(),
                sha256_file(&self.binary).expect("digest"),
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
