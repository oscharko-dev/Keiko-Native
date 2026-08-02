use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::OpenOptionsExt;
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
use crate::sha256::sha256_file;
#[cfg(test)]
use crate::sha256::sha256_reader;
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
const SIGKILL: i32 = 9;
const SIGTERM: i32 = 15;
const WEXITED: i32 = 0x0000_0004;
const WNOHANG: i32 = 0x0000_0001;
const WNOWAIT: i32 = 0x0000_0020;

const BINARY_ENV: &str = "KEIKO_CODEX_0_145_0_BINARY";
const HOME_ENV: &str = "KEIKO_CODEX_0_145_0_HOME";
const WORK_ROOT_ENV: &str = "KEIKO_CODEX_0_145_0_WORK_ROOT";
const CANCEL_TERM_GRACE: Duration = Duration::from_millis(500);
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
    process_group: Mutex<Option<i32>>,
    owned_processes: Mutex<HashSet<ProcessIdentity>>,
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
}

impl RuntimeCancellation {
    fn readiness_state(self) -> RuntimeReadinessState {
        match self {
            Self::ContainmentFailure => RuntimeReadinessState::ContainmentFailed,
            Self::User | Self::RendererLost | Self::AppShutdown => RuntimeReadinessState::Cancelled,
        }
    }

    fn turn_state(self) -> TurnState {
        match self {
            Self::ContainmentFailure => TurnState::ContainmentFailed,
            Self::User | Self::RendererLost | Self::AppShutdown => TurnState::Cancelled,
        }
    }

    fn turn_reason(self) -> TurnReason {
        match self {
            Self::User => TurnReason::UserCancelled,
            Self::RendererLost => TurnReason::RendererLost,
            Self::AppShutdown => TurnReason::AppShutdown,
            Self::ContainmentFailure => TurnReason::InternalFailure,
        }
    }
}

impl ActiveRuntime {
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
        Self {
            configuration,
            active: Arc::new(ActiveRuntime::default()),
            work_generation: Arc::new(AtomicU64::new(0)),
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
        if self
            .active
            .running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return RuntimeReadinessView::terminal(RuntimeReadinessState::ContainmentFailed, 0);
        }
        if !self.active.begin_request(request_id) {
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
        if let Ok(mut control) = self.active.control.lock()
            && self.active.running.load(Ordering::Acquire)
        {
            if control.request_id.as_deref() == Some(request_id) {
                control
                    .cancellation
                    .get_or_insert(RuntimeCancellation::User);
                accepted = true;
            } else if control.request_id.is_none() {
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
        self.cancel_for_app_shutdown();
        self.active.wait_for_idle(TURN_CLEANUP_RESERVE)
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
            .and_then(|active| *active);
        if let Some(process_group) = process_group {
            signal_active_process_group(&self.active, process_group, SIGTERM);
        }
    }

    pub fn run_turn(
        &self,
        request_id: &str,
        selected_workspace: &Path,
        task: &str,
        timeout: Duration,
        mut update: impl FnMut(TurnRuntimeUpdate),
    ) -> TurnRuntimeOutcome {
        let deadline = Instant::now() + timeout;
        if self
            .active
            .running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return TurnRuntimeOutcome::terminal(
                TurnState::ContainmentFailed,
                TurnReason::InternalFailure,
            );
        }
        if !self.active.begin_request(request_id) {
            return TurnRuntimeOutcome::terminal(
                TurnState::ContainmentFailed,
                TurnReason::InternalFailure,
            );
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
        }
    }

    #[cfg(test)]
    pub(crate) fn unavailable_for_test() -> Self {
        Self {
            configuration: None,
            active: Arc::new(ActiveRuntime::default()),
            work_generation: Arc::new(AtomicU64::new(0)),
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
    let generation = work_generation.fetch_add(1, Ordering::AcqRel) + 1;
    let work_directory = verified
        .work_root
        .join(format!("readiness-{}-{generation}", std::process::id()));
    if fs::create_dir(&work_directory).is_err() {
        return RuntimeReadinessView::terminal(RuntimeReadinessState::Unavailable, 0);
    }
    let outcome = run_protocol(&mut verified, &work_directory, active, deadline);
    let work_cleaned = fs::remove_dir_all(&work_directory).is_ok();
    if !outcome.cleaned || !work_cleaned {
        RuntimeReadinessView::terminal(
            RuntimeReadinessState::CleanupFailed,
            outcome.quarantined_events,
        )
    } else {
        RuntimeReadinessView::terminal(outcome.state, outcome.quarantined_events)
    }
}

fn perform_turn(
    configuration: &RuntimeConfiguration,
    selected_workspace: &Path,
    task: &str,
    active: &ActiveRuntime,
    work_generation: &AtomicU64,
    deadline: Instant,
    update: &mut impl FnMut(TurnRuntimeUpdate),
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
    let mut verified = match bind_configuration(configuration, Some(selected_workspace)) {
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
    let generation = work_generation.fetch_add(1, Ordering::AcqRel) + 1;
    let work_directory = verified
        .work_root
        .join(format!("turn-{}-{generation}", std::process::id()));
    if fs::create_dir(&work_directory).is_err()
        || fs::set_permissions(&work_directory, fs::Permissions::from_mode(0o700)).is_err()
    {
        return TurnRuntimeOutcome::terminal(TurnState::Failed, TurnReason::RuntimeUnavailable);
    }
    let mut outcome = run_turn_protocol(
        &mut verified,
        &work_directory,
        task,
        active,
        deadline,
        update,
    );
    let work_cleaned = fs::remove_dir_all(&work_directory).is_ok();
    outcome.cleaned = outcome.cleaned && work_cleaned;
    if !outcome.cleaned {
        outcome.state = TurnState::CleanupFailed;
        outcome.reason = Some(TurnReason::CleanupFailed);
    }
    outcome
}

fn run_turn_protocol(
    configuration: &mut VerifiedConfiguration,
    work_directory: &Path,
    task: &str,
    active: &ActiveRuntime,
    deadline: Instant,
    update: &mut impl FnMut(TurnRuntimeUpdate),
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
    let mut command = Command::new(executable);
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
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            return TurnRuntimeOutcome::terminal(TurnState::Failed, TurnReason::RuntimeUnavailable);
        }
    };
    let process_group = child.id() as i32;
    if let Ok(mut active_group) = active.process_group.lock() {
        *active_group = Some(process_group);
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
                            break (TurnState::ContainmentFailed, TurnReason::ProtocolRejected);
                        }
                    }
                    TurnProjectionAction::SendThreadStart => {
                        let work = work_directory.to_string_lossy();
                        if write_json_line(
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
                        if write_json_line(
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
    let cleanup_deadline = if outcome.state == TurnState::Cancelled {
        deadline.min(Instant::now() + TURN_CLEANUP_RESERVE)
    } else {
        deadline
    };
    outcome.cleaned = if outcome.state == TurnState::Cancelled {
        stop_process_group_with_term_grace(
            &mut child,
            process_group,
            active,
            cleanup_deadline,
            Some(CANCEL_TERM_GRACE),
        )
    } else {
        stop_process_group(&mut child, process_group, active, cleanup_deadline)
    };
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
    ) -> Result<PathBuf, RuntimeReadinessState> {
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
        Ok(staged)
    }
}

fn staged_file_valid(metadata: &Metadata, digest: &str, expected_digest: &str) -> bool {
    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0 && digest == expected_digest
}

fn bind_configuration(
    configuration: &RuntimeConfiguration,
    selected_workspace: Option<&Path>,
) -> Result<VerifiedConfiguration, RuntimeReadinessState> {
    let binary = canonical_existing(&configuration.binary, false)?;
    let codex_home = canonical_existing(&configuration.codex_home, true)?;
    let work_root = canonical_existing(&configuration.work_root, true)?;
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
    let mut command = Command::new(executable);
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
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            return ProtocolOutcome {
                state: RuntimeReadinessState::Unavailable,
                quarantined_events: 0,
                cleaned: true,
            };
        }
    };
    let process_group = child.id() as i32;
    if let Ok(mut active_group) = active.process_group.lock() {
        *active_group = Some(process_group);
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
    let remaining = deadline.saturating_duration_since(Instant::now());
    let cleanup_reserve = remaining / 5;
    let protocol_deadline = deadline.checked_sub(cleanup_reserve).unwrap_or(deadline);
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

fn write_json_line(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()
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
    quarantined_events: u16,
    started_items: HashMap<String, InertItemKind>,
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
            quarantined_events: 0,
            started_items: HashMap::new(),
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
        let Some(thread) = params
            .and_then(|params| params.get("thread"))
            .and_then(Value::as_object)
        else {
            return self.containment(TurnReason::ProtocolRejected);
        };
        if self.thread_id.as_deref() == thread.get("id").and_then(Value::as_str) {
            self.quarantine()
        } else {
            self.containment(TurnReason::ProtocolRejected)
        }
    }

    fn quarantine_correlated_thread(&mut self, params: Option<&Value>) -> TurnProjectionAction {
        if self.thread_id.as_deref()
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
            || self
                .turn_id
                .as_deref()
                .is_some_and(|known| known != turn_id)
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
        } else if self.started_items.get(item_id) != Some(&item_kind)
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
            || self.agent_text.len().saturating_add(delta.len()) > MAX_AGENT_TEXT_BYTES
        {
            return self.containment(TurnReason::BufferLimit);
        }
        self.agent_text.push_str(delta);
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
        self.thread_id.as_deref() == params.get("threadId").and_then(Value::as_str)
            && self.turn_id.as_deref() == params.get("turnId").and_then(Value::as_str)
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
    let cleaned = stop_process_group(&mut child, process_group, active, deadline);
    ProtocolOutcome {
        state,
        quarantined_events,
        cleaned,
    }
}

fn stop_process_group(
    child: &mut Child,
    process_group: i32,
    active: &ActiveRuntime,
    deadline: Instant,
) -> bool {
    stop_process_group_with_term_grace(child, process_group, active, deadline, None)
}

fn stop_process_group_with_term_grace(
    child: &mut Child,
    process_group: i32,
    active: &ActiveRuntime,
    deadline: Instant,
    term_grace: Option<Duration>,
) -> bool {
    let cleanup_started = Instant::now();
    let remaining = deadline.saturating_duration_since(cleanup_started);
    let term_deadline = term_grace.map_or_else(
        || cleanup_started + remaining.saturating_sub(remaining / 5),
        |grace| deadline.min(cleanup_started + grace),
    );
    signal_active_process_group(active, process_group, SIGTERM);
    while Instant::now() < term_deadline {
        if ready_to_reap(child.id() as i32, process_group, active) {
            retire_active_process_group(active, process_group);
            return child.wait().is_ok();
        }
        thread::sleep(Duration::from_millis(10));
    }
    signal_active_process_group(active, process_group, SIGKILL);
    while Instant::now() < deadline {
        if ready_to_reap(child.id() as i32, process_group, active) {
            retire_active_process_group(active, process_group);
            return child.wait().is_ok();
        }
        thread::sleep(Duration::from_millis(10));
    }
    let _ = child.try_wait();
    false
}

fn signal_active_process_group(active: &ActiveRuntime, process_group: i32, signal: i32) -> bool {
    let Ok(active_group) = active.process_group.lock() else {
        return false;
    };
    if *active_group != Some(process_group) {
        return false;
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

fn retire_active_process_group(active: &ActiveRuntime, process_group: i32) {
    if let Ok(mut active_group) = active.process_group.lock()
        && *active_group == Some(process_group)
    {
        *active_group = None;
        if let Ok(mut owned) = active.owned_processes.lock() {
            owned.clear();
        }
    }
}

fn ready_to_reap(child: i32, process_group: i32, active: &ActiveRuntime) -> bool {
    let exited = child_exited_without_reaping(child);
    let descendants = process_group_has_descendants(process_group, child);
    let owned_descendants = owned_descendants_alive(active, child);
    exited.unwrap_or(false)
        && !descendants.unwrap_or(true)
        && owned_descendants.is_some_and(|alive| !alive)
}

fn register_owned_process(active: &ActiveRuntime, process: i32) {
    debug_assert_eq!(
        active.process_group.lock().ok().and_then(|group| *group),
        Some(process)
    );
    let _ = refresh_owned_processes(active);
}

fn refresh_owned_processes(active: &ActiveRuntime) -> bool {
    let Some(leader) = active.process_group.lock().ok().and_then(|group| *group) else {
        return false;
    };
    let Ok(mut owned) = active.owned_processes.lock() else {
        return false;
    };
    owned.retain(|identity| process_identity(identity.process_id) == Some(*identity));
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
        return Ok(true);
    }
    Ok(members[..member_count]
        .iter()
        .any(|process| *process > 0 && *process != leader))
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

#[cfg(test)]
fn process_group_exists(process_group: i32) -> bool {
    // SAFETY: signal 0 performs existence/permission checking only. The process
    // group ID came directly from the child created by this supervisor.
    let result = unsafe { keiko_kill(-process_group, 0) };
    result == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::os::unix::fs::symlink;

    static PROCESS_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn turn_and_readiness_share_the_closed_no_effect_runtime_arguments() {
        let joined = CODEX_CONTAINMENT_ARGUMENTS.join(" ");
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
    fn staged_runtime_is_bound_to_verified_descriptor_not_mutable_install_path() {
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
        let staged = verified
            .stage_verified_binary(&stage_root)
            .expect("verified staging");

        fs::write(&fixture.binary, "#!/bin/sh\nprintf 'replacement\\n'\n")
            .expect("replace installation path");
        fs::set_permissions(&fixture.binary, fs::Permissions::from_mode(0o700))
            .expect("replacement mode");
        assert_eq!(sha256_file(&staged).expect("staged digest"), expected);
        let output = Command::new(staged)
            .output()
            .expect("execute staged runtime");
        assert_eq!(output.stdout, b"verified\n");
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
            .expect("process-group state") = Some(i32::MAX);
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

        let collision = fixture
            .work
            .join(format!("readiness-{}-1", std::process::id()));
        fs::create_dir(&collision).expect("collision");
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
        *active.process_group.lock().expect("process-group state") = Some(i32::MAX);
        retire_active_process_group(&active, i32::MAX - 1);
        assert_eq!(
            *active.process_group.lock().expect("process-group state"),
            Some(i32::MAX)
        );
        retire_active_process_group(&active, i32::MAX);
        assert!(!signal_active_process_group(&active, i32::MAX, SIGTERM));
        assert!(!signal_active_process_group(&active, i32::MAX, SIGKILL));

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
        assert!(!refresh_owned_processes(&poisoned));
        assert_eq!(owned_descendants_alive(&poisoned, i32::MAX), None);
        retire_active_process_group(&poisoned, i32::MAX);

        let poisoned_owned = Arc::new(ActiveRuntime::default());
        *poisoned_owned
            .process_group
            .lock()
            .expect("process group before owned poisoning") = Some(i32::MAX);
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
    fn unavailable_host_and_unspawnable_runtime_are_distinct() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let unavailable = RuntimeHost {
            configuration: None,
            active: Arc::new(ActiveRuntime::default()),
            work_generation: Arc::new(AtomicU64::new(0)),
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
    fn poisoned_request_bookkeeping_still_fails_closed() {
        let host = RuntimeHost {
            configuration: None,
            active: Arc::new(ActiveRuntime::default()),
            work_generation: Arc::new(AtomicU64::new(0)),
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
            &fixture.root,
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
                "item": {"id": "item-1", "type": "agentMessage"}
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
        assert_eq!(
            duplicate_completion.accept(&serde_json::to_vec(&completed).unwrap()),
            TurnProjectionAction::Quarantine
        );
        assert_turn_containment(
            duplicate_completion.accept(&serde_json::to_vec(&completed).unwrap()),
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
    }

    #[test]
    fn fake_turn_uses_disposable_sqlite_home_streams_and_cleans_every_descendant() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository identity");
        let home = fixture.home.to_string_lossy();
        let script = format!(
            r#"#!/bin/sh
set -eu
work=$(/bin/pwd -P)
test "$CODEX_SQLITE_HOME" = "$work"
test "$(/usr/bin/stat -f '%Lp' "$work")" = "700"
printf 'transient provider state' > "$CODEX_SQLITE_HOME/logs_2.sqlite"
read -r initialize
printf '%s\n' '{{"id":1,"result":{{"userAgent":"codex_cli_rs/0.145.0","codexHome":"{home}","platformFamily":"unix","platformOs":"macos"}}}}'
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
printf '%s\n' '{{"method":"item/completed","params":{{"threadId":"thread-1","turnId":"turn-1","completedAtMs":2,"item":{{"type":"agentMessage","id":"item-1"}}}}}}'
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
            &repository,
            "Repository-independent prompt.",
            Duration::from_secs(5),
            |update| updates.push(update),
        );
        assert_eq!(outcome.state, TurnState::Completed, "{outcome:?}");
        assert_eq!(outcome.agent_text, "Bounded answer.");
        assert!(outcome.cleaned);
        assert!(outcome.provider_thread_established);
        assert!(outcome.provider_turn_established);
        assert!(updates.contains(&TurnRuntimeUpdate::StreamingStarted));
        assert!(updates.contains(&TurnRuntimeUpdate::AgentDelta("Bounded answer.".to_owned())));
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
        assert!(!fixture.home.join("logs_2.sqlite").exists());
        assert!(!host.active.running.load(Ordering::Acquire));
        assert_eq!(*host.active.process_group.lock().unwrap(), None);
    }

    #[test]
    fn cancellation_terminates_the_owned_process_group_and_retry_starts_fresh() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let host = fixture.scripted_host(
            r#"#!/bin/sh
read -r initialize
while :; do /bin/sleep 1; done
"#,
        );
        let checking_host = host.clone();
        let pending = thread::spawn(move || checking_host.check("request-cancel", None));
        let wait_deadline = Instant::now() + Duration::from_secs(2);
        while host
            .active
            .process_group
            .lock()
            .expect("process-group state")
            .is_none()
            && Instant::now() < wait_deadline
        {
            thread::sleep(Duration::from_millis(5));
        }
        let process_group = host
            .active
            .process_group
            .lock()
            .expect("process-group state")
            .expect("active process group");
        assert!(process_group_exists(process_group));
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
: > cancel-ready
read -r initialize
while :; do /bin/sleep 1; done
"#,
        );
        let running_host = host.clone();
        let pending = thread::spawn(move || {
            let mut updates = Vec::new();
            let outcome = running_host.run_turn(
                "request-cancel-turn",
                &repository,
                "Bounded task.",
                Duration::from_secs(5),
                |update| updates.push(update),
            );
            (outcome, updates)
        });
        let wait_deadline = Instant::now() + Duration::from_secs(2);
        let cancellation_ready = || {
            fs::read_dir(&fixture.work).is_ok_and(|entries| {
                entries
                    .filter_map(Result::ok)
                    .any(|entry| entry.path().join("cancel-ready").is_file())
            })
        };
        while (!cancellation_ready()
            || host
                .active
                .process_group
                .lock()
                .expect("process-group state")
                .is_none())
            && Instant::now() < wait_deadline
        {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            cancellation_ready(),
            "stubborn runtime did not become ready"
        );

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
: > shutdown-ready
read -r initialize
while :; do /bin/sleep 1; done
"#,
        );
        let running_host = host.clone();
        let pending = thread::spawn(move || {
            running_host.run_turn(
                "request-app-shutdown",
                &repository,
                "Bounded task.",
                Duration::from_secs(5),
                |_| {},
            )
        });
        let wait_deadline = Instant::now() + Duration::from_secs(2);
        let shutdown_ready = || {
            fs::read_dir(&fixture.work).is_ok_and(|entries| {
                entries
                    .filter_map(Result::ok)
                    .any(|entry| entry.path().join("shutdown-ready").is_file())
            })
        };
        while !shutdown_ready() && Instant::now() < wait_deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            shutdown_ready(),
            "runtime did not become ready for shutdown"
        );

        assert!(host.cancel_for_app_shutdown_and_wait());
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
        let cancelled = pending.join().expect("turn thread");
        assert_eq!(cancelled.state, TurnState::Cancelled);
        assert_eq!(cancelled.reason, Some(TurnReason::AppShutdown));
        assert!(cancelled.cleaned);
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
                &repository,
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
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let request_timeout = Duration::from_secs(2);
        let fixture = Fixture::new();
        let host = fixture.scripted_host(
            r#"#!/bin/sh
read -r initialize
while :; do /bin/sleep 1; done
"#,
        );
        let started = Instant::now();
        let result = host.check_with_timeout("request-timeout", None, request_timeout);
        assert_eq!(result.state, RuntimeReadinessState::TimedOut);
        assert!(
            started.elapsed() < request_timeout + request_timeout / 2,
            "request deadline was multiplied across phases: {:?}",
            started.elapsed()
        );
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
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
        *active.process_group.lock().expect("process-group state") = Some(process_group);
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
        *active.process_group.lock().expect("process-group state") = Some(process_group);

        assert!(!stop_process_group(
            &mut child,
            process_group,
            &active,
            Instant::now(),
        ));
        assert_eq!(
            *active.process_group.lock().expect("retained ownership"),
            Some(process_group)
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
        *active.process_group.lock().expect("process-group state") = Some(leader);
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
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("time")
                    .as_nanos()
            ));
            fs::create_dir_all(&root).expect("root");
            let root = fs::canonicalize(root).expect("canonical root");
            let binary = root.join("codex");
            let home = root.join("home");
            let work = root.join("work");
            fs::create_dir_all(&home).expect("home");
            fs::create_dir_all(&work).expect("work");
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
