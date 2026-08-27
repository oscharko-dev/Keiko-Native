use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::request_timing::{AcceptedCancellation, CancellationSource, terminal_cutoff_exceeded};
use crate::sha256::sha256_copy;
#[cfg(test)]
use crate::sha256::{sha256_file, sha256_reader};
use crate::workspace::WorkspaceRuntimeBinding;
use crate::{AcceptedRequest, HostCancellationRecord, HostLifecycle, SenderContext};
use keiko_application::runtime::{
    CODEX_RUNTIME_SHA256, RuntimeReadinessState, RuntimeReadinessView,
};
use keiko_application::turn::{MAX_AGENT_TEXT_BYTES, TurnReason, TurnState};
use keiko_ui_port::{Operation, ReasonCode, encode_error, request_metadata, request_operation};
use serde_json::{Value, json};

const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_QUEUE_BYTES: usize = 4 * 1024 * 1024;
const READER_RETIREMENT_BUDGET: Duration = Duration::from_millis(100);
const MAX_QUEUE_FRAMES: usize = 256;
const MAX_STDERR_BYTES: usize = 1024 * 1024;
const MAX_QUARANTINED_EVENTS: u16 = 64;
const MAX_DEFERRED_CANCELLATIONS: usize = 64;
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
const TURN_TERMINAL_BUDGET: Duration = Duration::from_secs(5);
const TURN_TERMINAL_PROJECTION_RESERVE: Duration = Duration::from_millis(500);
const TURN_WORKER_RETIREMENT_BUDGET: Duration = Duration::from_millis(100);
const TERMINAL_PUBLICATION_BUDGET: Duration = Duration::from_millis(100);
const TURN_CLEANUP_RESERVE: Duration =
    TURN_TERMINAL_BUDGET.saturating_sub(TURN_TERMINAL_PROJECTION_RESERVE);
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

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReadinessDeadlineStage {
    Request,
    PerformCheck,
    RunProtocol,
    CleanupAfter,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ReadinessDeadlineObservation {
    stage: ReadinessDeadlineStage,
    started_at: Option<Instant>,
    timeout: Option<Duration>,
    deadline: Instant,
}

#[derive(Debug, Default)]
struct ActiveRuntime {
    process_group: Mutex<Option<ProcessIdentity>>,
    retained_unpublished_children: Mutex<Vec<Child>>,
    #[cfg(test)]
    process_group_observer: Mutex<Option<SyncSender<ProcessIdentity>>>,
    #[cfg(test)]
    readiness_deadline_trace: Mutex<Vec<ReadinessDeadlineObservation>>,
    owned_processes: Mutex<HashSet<ProcessIdentity>>,
    retained_work_directories: Mutex<HashSet<PathBuf>>,
    retained_readers: Mutex<Vec<RuntimeReader>>,
    retained_turn_workers: Mutex<Vec<RetainedTurnWorker>>,
    retained_publication_workers: Mutex<Vec<RetainedPublicationWorker>>,
    deferred_publication_failures: Mutex<Vec<DeferredPublicationFailure>>,
    tracked_directory_cleanups: Mutex<Vec<TrackedDirectoryCleanup>>,
    deferred_cancellations: Mutex<Vec<DeferredRuntimeCancellation>>,
    saturated_containment: Mutex<Option<AcceptedRuntimeCancellation>>,
    deferred_cancellation_overflow: AtomicBool,
    control: Mutex<RuntimeControl>,
    next_effect_generation: AtomicU64,
    closed_control_failure_cleanup: AtomicBool,
    finished: Condvar,
    #[cfg(test)]
    idle_waiting: AtomicBool,
    #[cfg(test)]
    reader_spawn_attempt: AtomicUsize,
    #[cfg(test)]
    reader_spawn_failure: AtomicUsize,
    #[cfg(test)]
    spawn_rollback_failure: AtomicUsize,
    #[cfg(test)]
    reader_retirement_hook: Mutex<Option<ReaderRetirementHook>>,
    #[cfg(test)]
    reader_retirement_observer: Mutex<Option<SyncSender<()>>>,
    #[cfg(test)]
    reader_reconciliation_hook: Mutex<Option<ReaderReconciliationHook>>,
    #[cfg(test)]
    runtime_effect_hook: Mutex<Option<RuntimeEffectHook>>,
    #[cfg(test)]
    runtime_effect_trace: Mutex<Vec<RuntimeEffectStage>>,
    #[cfg(test)]
    terminal_publication_now: Mutex<Option<Instant>>,
    #[cfg(test)]
    terminal_publication_hook: Mutex<Option<TerminalPublicationHook>>,
    #[cfg(test)]
    request_commit_hook: Mutex<Option<RequestClaimHook>>,
    #[cfg(test)]
    post_begin_rollback_hook: Mutex<Option<RequestClaimHook>>,
    #[cfg(test)]
    cancellation_signal_hook: Mutex<Option<RequestClaimHook>>,
    #[cfg(test)]
    readiness_settlement_hook: Mutex<Option<RequestClaimHook>>,
    #[cfg(test)]
    readiness_completion_hook: Mutex<Option<RequestClaimHook>>,
    #[cfg(test)]
    failed_claim_settlement_hook: Mutex<Option<RequestClaimHook>>,
    running: AtomicBool,
}

#[derive(Debug, Default)]
struct RuntimeControl {
    request_id: Option<String>,
    pending_request_id: Option<String>,
    cancellation: Option<AcceptedRuntimeCancellation>,
    closed_control_failure_token: Option<AcceptedRuntimeCancellation>,
    effect_generation: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RuntimeRequestReservation {
    request_id: String,
    effect_generation: u64,
    cancellation: Option<AcceptedRuntimeCancellation>,
    closed_control_failure_token: Option<AcceptedRuntimeCancellation>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RuntimeSignalAuthority {
    request_id: String,
    effect_generation: u64,
    cancellation: AcceptedRuntimeCancellation,
    process_identity: ProcessIdentity,
}

#[derive(Debug)]
struct RuntimeEffectPermit {
    request_id: String,
    generation: u64,
}

#[derive(Debug)]
enum RuntimeEffectResult<T> {
    Completed(T),
    Rejected(RuntimeCancellation),
    Cancelled(T, RuntimeCancellation),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HostTurnClaimDisposition {
    Claimed,
    Cancelled,
    Rejected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RuntimeEffectStage {
    Bind,
    Workspace,
    Directory,
    Stage,
    Spawn,
    Publish,
    Readers,
    InitializeWrite,
}

#[cfg(test)]
#[derive(Debug)]
struct RuntimeEffectHook {
    stage: RuntimeEffectStage,
    started: SyncSender<()>,
    release: Arc<(Mutex<bool>, Condvar)>,
}

#[cfg(test)]
#[derive(Debug)]
struct TerminalPublicationHook {
    entered: SyncSender<()>,
    release: Arc<(Mutex<bool>, Condvar)>,
}

#[cfg(test)]
#[derive(Debug)]
struct RequestClaimHook {
    entered: SyncSender<()>,
    release: Arc<(Mutex<bool>, Condvar)>,
}

#[cfg(test)]
type ReaderRetirementTestHook = (
    mpsc::Receiver<()>,
    mpsc::Receiver<()>,
    Arc<(Mutex<bool>, Condvar)>,
);

#[cfg(test)]
#[derive(Clone, Debug)]
struct ReaderRetirementHook {
    thread_name: &'static str,
    body_completed: SyncSender<()>,
    release: Arc<(Mutex<bool>, Condvar)>,
}

#[cfg(test)]
#[derive(Debug)]
struct ReaderReconciliationHook {
    entered: SyncSender<()>,
    release: Arc<(Mutex<bool>, Condvar)>,
}

#[derive(Debug)]
enum DeferredRuntimeCancellation {
    Host(HostCancellationRecord),
    ReservedHost(HostCancellationRecord),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AcceptedRuntimeCancellation {
    reason: RuntimeCancellation,
    pub(crate) host_acceptance: Option<AcceptedCancellation>,
    pub(crate) accepted_at: Instant,
    pub(crate) cleanup_cutoff: Instant,
    pub(crate) terminal_cutoff: Instant,
}

impl AcceptedRuntimeCancellation {
    fn new(reason: RuntimeCancellation, accepted_at: Instant) -> Self {
        Self {
            reason,
            host_acceptance: None,
            accepted_at,
            cleanup_cutoff: accepted_at + TURN_CLEANUP_RESERVE,
            terminal_cutoff: accepted_at + TURN_TERMINAL_BUDGET,
        }
    }

    fn from_host(accepted: AcceptedCancellation) -> Self {
        let reason = match accepted.source {
            CancellationSource::User => RuntimeCancellation::User,
            CancellationSource::RendererLost => RuntimeCancellation::RendererLost,
            CancellationSource::AppShutdown => RuntimeCancellation::AppShutdown,
        };
        Self {
            host_acceptance: Some(accepted),
            ..Self::new(reason, accepted.accepted_at)
        }
    }

    fn fail_safe(mut self) -> Self {
        self.reason = RuntimeCancellation::ContainmentFailure;
        self
    }

    fn closed(accepted_at: Instant) -> Self {
        Self {
            reason: RuntimeCancellation::ContainmentFailure,
            host_acceptance: None,
            accepted_at,
            cleanup_cutoff: accepted_at,
            terminal_cutoff: accepted_at,
        }
    }
}

#[derive(Debug)]
struct TrackedDirectoryCleanup {
    path: PathBuf,
    completed: mpsc::Receiver<bool>,
    worker: thread::JoinHandle<()>,
}

#[derive(Debug)]
struct RuntimeReader {
    completed: mpsc::Receiver<()>,
    worker: thread::JoinHandle<()>,
}

#[derive(Debug)]
struct RetainedTurnWorker {
    completed: mpsc::Receiver<bool>,
    cleanup_proven: Option<bool>,
    worker: thread::JoinHandle<()>,
}

#[derive(Debug)]
struct OwnedTurnWorker {
    events: mpsc::Receiver<TurnWorkerEvent>,
    retained: RetainedTurnWorker,
}

#[derive(Debug)]
struct RetainedPublicationWorker {
    result: mpsc::Receiver<TerminalPublicationWorkerResult>,
    worker: thread::JoinHandle<()>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TerminalPublicationWorkerResult {
    Published,
    Skipped,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
enum TerminalPublicationDisposition {
    Pending = 0,
    Admitted = 1,
    Published = 2,
    Skipped = 3,
    Failed = 4,
}

impl TerminalPublicationDisposition {
    fn from_worker_result(result: TerminalPublicationWorkerResult) -> Self {
        match result {
            TerminalPublicationWorkerResult::Published => Self::Published,
            TerminalPublicationWorkerResult::Skipped => Self::Skipped,
            TerminalPublicationWorkerResult::Failed => Self::Failed,
        }
    }
}

struct DeferredPublicationFailure(Option<Box<dyn FnOnce() + Send + 'static>>);

impl std::fmt::Debug for DeferredPublicationFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("DeferredPublicationFailure")
            .field(&self.0.is_some())
            .finish()
    }
}

#[derive(Debug)]
enum TurnWorkerEvent {
    Update(TurnRuntimeUpdate),
    Outcome(TurnRuntimeOutcome),
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
    fn terminal_publication_now(&self) -> Instant {
        #[cfg(test)]
        if let Some(now) = *self
            .terminal_publication_now
            .lock()
            .expect("terminal publication clock")
        {
            return now;
        }
        Instant::now()
    }

    #[cfg(test)]
    fn install_runtime_effect_hook(
        &self,
        stage: RuntimeEffectStage,
    ) -> (mpsc::Receiver<()>, Arc<(Mutex<bool>, Condvar)>) {
        let (started, observed) = mpsc::sync_channel(1);
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        *self
            .runtime_effect_hook
            .lock()
            .expect("runtime effect hook") = Some(RuntimeEffectHook {
            stage,
            started,
            release: Arc::clone(&release),
        });
        (observed, release)
    }

    #[cfg(test)]
    fn install_terminal_publication_hook(
        &self,
    ) -> (mpsc::Receiver<()>, Arc<(Mutex<bool>, Condvar)>) {
        let (entered, observed) = mpsc::sync_channel(1);
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        *self
            .terminal_publication_hook
            .lock()
            .expect("terminal publication hook") = Some(TerminalPublicationHook {
            entered,
            release: Arc::clone(&release),
        });
        (observed, release)
    }

    fn enter_terminal_publication_effect(&self) {
        #[cfg(test)]
        {
            let hook = self
                .terminal_publication_hook
                .lock()
                .expect("terminal publication hook")
                .take();
            let Some(hook) = hook else {
                return;
            };
            hook.entered.send(()).expect("publication worker entered");
            let (released, wake) = &*hook.release;
            let released = released.lock().expect("publication release");
            let (released, wait) = wake
                .wait_timeout_while(released, Duration::from_secs(2), |released| !*released)
                .expect("publication wait");
            assert!(
                !wait.timed_out() && *released,
                "terminal publication release timed out"
            );
        }
    }

    #[cfg(test)]
    fn install_request_claim_hook(
        target: &Mutex<Option<RequestClaimHook>>,
    ) -> (mpsc::Receiver<()>, Arc<(Mutex<bool>, Condvar)>) {
        let (entered, observed) = mpsc::sync_channel(1);
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        *target.lock().expect("request claim hook") = Some(RequestClaimHook {
            entered,
            release: Arc::clone(&release),
        });
        (observed, release)
    }

    #[cfg(test)]
    fn pause_request_claim(target: &Mutex<Option<RequestClaimHook>>) -> bool {
        let Some(hook) = target.lock().expect("request claim hook").take() else {
            return false;
        };
        hook.entered.send(()).expect("request claim entered");
        let (released, wake) = &*hook.release;
        let released = released.lock().expect("request claim release");
        let (released, wait) = wake
            .wait_timeout_while(released, Duration::from_secs(2), |released| !*released)
            .expect("request claim wait");
        assert!(
            !wait.timed_out() && *released,
            "request claim release timed out"
        );
        true
    }

    #[cfg(test)]
    fn install_reader_retirement_hook(
        &self,
        thread_name: &'static str,
    ) -> ReaderRetirementTestHook {
        let (body_completed, observed) = mpsc::sync_channel(1);
        let (retirement_started, retirement_observed) = mpsc::sync_channel(1);
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        *self
            .reader_retirement_hook
            .lock()
            .expect("reader retirement hook") = Some(ReaderRetirementHook {
            thread_name,
            body_completed,
            release: Arc::clone(&release),
        });
        *self
            .reader_retirement_observer
            .lock()
            .expect("reader retirement observer") = Some(retirement_started);
        (observed, retirement_observed, release)
    }

    #[cfg(test)]
    fn install_reader_reconciliation_hook(
        &self,
    ) -> (mpsc::Receiver<()>, Arc<(Mutex<bool>, Condvar)>) {
        let (entered, observed) = mpsc::sync_channel(1);
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        *self
            .reader_reconciliation_hook
            .lock()
            .expect("reader reconciliation hook") = Some(ReaderReconciliationHook {
            entered,
            release: Arc::clone(&release),
        });
        (observed, release)
    }

    #[cfg(test)]
    fn enter_reader_reconciliation(&self) {
        let hook = self
            .reader_reconciliation_hook
            .lock()
            .expect("reader reconciliation hook")
            .take();
        let Some(hook) = hook else {
            return;
        };
        hook.entered
            .send(())
            .expect("reader reconciliation entered");
        let (released, wake) = &*hook.release;
        let released = released.lock().expect("reader reconciliation release");
        let (released, wait) = wake
            .wait_timeout_while(released, Duration::from_secs(2), |released| !*released)
            .expect("reader reconciliation wait");
        assert!(
            !wait.timed_out() && *released,
            "reader reconciliation release timed out"
        );
    }

    #[cfg(not(test))]
    fn enter_reader_reconciliation(&self) {}

    #[cfg(test)]
    fn enter_runtime_effect(&self, stage: RuntimeEffectStage) {
        self.runtime_effect_trace
            .lock()
            .expect("runtime effect trace")
            .push(stage);
        let hook = self
            .runtime_effect_hook
            .lock()
            .expect("runtime effect hook");
        let Some(hook) = hook.as_ref().filter(|hook| hook.stage == stage) else {
            return;
        };
        hook.started.send(()).expect("runtime effect started");
        let (released, wake) = &*hook.release;
        let released = released.lock().expect("runtime effect release");
        let (released, wait) = wake
            .wait_timeout_while(released, Duration::from_secs(1), |released| !*released)
            .expect("runtime effect release wait");
        assert!(
            !wait.timed_out() && *released,
            "runtime effect release timed out"
        );
    }

    #[cfg(not(test))]
    fn enter_runtime_effect(&self, _stage: RuntimeEffectStage) {}

    #[cfg(test)]
    fn runtime_effect_trace(&self) -> Vec<RuntimeEffectStage> {
        self.runtime_effect_trace
            .lock()
            .expect("runtime effect trace")
            .clone()
    }

    fn close_deferred_cancellations(&self) {
        self.deferred_cancellation_overflow
            .store(true, Ordering::Release);
    }

    fn defer_cancellation(&self, cancellation: AcceptedRuntimeCancellation) {
        if self
            .deferred_cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
            >= MAX_DEFERRED_CANCELLATIONS
        {
            self.close_deferred_cancellations();
        }
        let mut saturated = self
            .saturated_containment
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        saturated.get_or_insert(cancellation);
    }

    fn defer_host_cancellations(&self, records: &[HostCancellationRecord]) {
        let mut deferred = self
            .deferred_cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if records.is_empty() {
            drop(deferred);
            self.defer_cancellation(AcceptedRuntimeCancellation::closed(Instant::now()));
        } else {
            for record in records {
                if !deferred.iter().any(|deferred| {
                    matches!(
                        deferred,
                        DeferredRuntimeCancellation::Host(existing)
                            | DeferredRuntimeCancellation::ReservedHost(existing)
                            if existing.request_id == record.request_id
                    )
                }) {
                    if deferred.len() >= MAX_DEFERRED_CANCELLATIONS {
                        self.close_deferred_cancellations();
                        break;
                    }
                    deferred.push(DeferredRuntimeCancellation::Host(record.clone()));
                }
            }
        }
    }

    fn defer_reserved_host_cancellation(&self, record: HostCancellationRecord) -> bool {
        let mut deferred = self
            .deferred_cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(existing) = deferred.iter_mut().find(|deferred| {
            matches!(
                deferred,
                DeferredRuntimeCancellation::Host(existing)
                    | DeferredRuntimeCancellation::ReservedHost(existing)
                    if existing.request_id == record.request_id
            )
        }) {
            *existing = DeferredRuntimeCancellation::ReservedHost(record);
            true
        } else if deferred.len() >= MAX_DEFERRED_CANCELLATIONS {
            self.close_deferred_cancellations();
            false
        } else {
            deferred.push(DeferredRuntimeCancellation::ReservedHost(record));
            true
        }
    }

    fn materialize_deferred_cancellation(&self, control: &mut RuntimeControl) {
        let mut deferred = self
            .deferred_cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let request_id = control
            .request_id
            .as_deref()
            .or(control.pending_request_id.as_deref());
        let has_request_owner = request_id.is_some();
        let cancellation = deferred
            .iter()
            .position(|item| match item {
                DeferredRuntimeCancellation::Host(record) => {
                    request_id == Some(record.request_id.as_str())
                }
                DeferredRuntimeCancellation::ReservedHost(_) => false,
            })
            .map(|index| match deferred.remove(index) {
                DeferredRuntimeCancellation::Host(record) => {
                    AcceptedRuntimeCancellation::from_host(record.accepted)
                }
                DeferredRuntimeCancellation::ReservedHost(record) => {
                    AcceptedRuntimeCancellation::from_host(record.accepted)
                }
            });
        if let Some(cancellation) = cancellation {
            if control.closed_control_failure_token.is_some() {
                control.cancellation = Some(cancellation);
            } else {
                control.cancellation.get_or_insert(cancellation);
            }
        }
        drop(deferred);
        let mut saturated = self
            .saturated_containment
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(cancellation) = saturated.take() {
            if has_request_owner {
                if control.closed_control_failure_token.is_some() {
                    control.cancellation = Some(cancellation);
                } else {
                    control.cancellation.get_or_insert(cancellation);
                }
            } else {
                self.close_deferred_cancellations();
            }
        }
    }

    fn take_exact_deferred_host_cancellation(
        &self,
        request_id: &str,
    ) -> Option<AcceptedRuntimeCancellation> {
        let mut deferred = self
            .deferred_cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let index = deferred.iter().position(|item| {
            matches!(
                item,
                DeferredRuntimeCancellation::Host(record)
                    | DeferredRuntimeCancellation::ReservedHost(record)
                    if record.request_id == request_id
            )
        })?;
        match deferred.remove(index) {
            DeferredRuntimeCancellation::Host(record)
            | DeferredRuntimeCancellation::ReservedHost(record) => {
                Some(AcceptedRuntimeCancellation::from_host(record.accepted))
            }
        }
    }

    fn deferred_cancellation_overflowed(&self) -> bool {
        self.deferred_cancellation_overflow.load(Ordering::Acquire)
    }

    fn has_reserved_host_cancellation(&self, request_id: &str) -> bool {
        self.deferred_cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .any(|item| {
                matches!(
                    item,
                    DeferredRuntimeCancellation::ReservedHost(record)
                        if record.request_id == request_id
                )
            })
    }

    fn has_exact_deferred_host_cancellation(&self, request_id: &str) -> bool {
        self.deferred_cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .any(|item| {
                matches!(
                    item,
                    DeferredRuntimeCancellation::Host(record)
                        | DeferredRuntimeCancellation::ReservedHost(record)
                        if record.request_id == request_id
                )
            })
    }

    fn exact_host_acceptance_for_settlement(
        &self,
        control: &mut RuntimeControl,
        request_id: &str,
        extracted: &mut Option<AcceptedRuntimeCancellation>,
    ) -> Option<AcceptedCancellation> {
        if extracted.is_none() {
            *extracted = self.take_exact_deferred_host_cancellation(request_id);
        }
        if let Some(acceptance) = extracted.and_then(|cancellation| cancellation.host_acceptance) {
            return Some(acceptance);
        }
        let owns_exact_request = control.request_id.as_deref() == Some(request_id)
            || control.pending_request_id.as_deref() == Some(request_id);
        if owns_exact_request {
            self.materialize_deferred_cancellation(control);
            if let Some(acceptance) = control
                .cancellation
                .and_then(|cancellation| cancellation.host_acceptance)
            {
                return Some(acceptance);
            }
        }
        None
    }

    fn clear_exact_host_settlement_owner(
        &self,
        control: &mut RuntimeControl,
        request_id: &str,
        cancellation: Option<AcceptedRuntimeCancellation>,
    ) -> bool {
        let owns_exact_request = control.request_id.as_deref() == Some(request_id)
            || control.pending_request_id.as_deref() == Some(request_id);
        let owns_exact_cancellation =
            cancellation.is_some() && control.cancellation == cancellation;
        if !owns_exact_request || !owns_exact_cancellation {
            return false;
        }
        let released_running = control.request_id.as_deref() == Some(request_id);
        control.request_id = None;
        control.pending_request_id = None;
        control.effect_generation = 0;
        control.cancellation = control.closed_control_failure_token;
        released_running
    }

    fn clear_poisoned_exact_host_settlement_owner(
        &self,
        control: &mut RuntimeControl,
        request_id: &str,
        extracted: Option<AcceptedRuntimeCancellation>,
    ) -> Option<bool> {
        extracted.and_then(|cancellation| cancellation.host_acceptance)?;
        let owns_exact_request = control.request_id.as_deref() == Some(request_id)
            || control.pending_request_id.as_deref() == Some(request_id);
        let closed = control.closed_control_failure_token?;
        if !owns_exact_request || control.cancellation != Some(closed) {
            return None;
        }
        let released_running = control.request_id.as_deref() == Some(request_id);
        control.request_id = None;
        control.pending_request_id = None;
        control.effect_generation = 0;
        Some(released_running)
    }
    #[cfg(test)]
    fn record_readiness_deadline(&self, observation: ReadinessDeadlineObservation) {
        self.readiness_deadline_trace
            .lock()
            .expect("readiness deadline trace")
            .push(observation);
    }

    #[cfg(test)]
    fn take_readiness_deadline_trace(&self) -> Vec<ReadinessDeadlineObservation> {
        std::mem::take(
            &mut *self
                .readiness_deadline_trace
                .lock()
                .expect("readiness deadline trace"),
        )
    }

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
        if !self.running.load(Ordering::Acquire) {
            self.apply_deferred_publication_failures();
        }
        let Some(reservation) = self.reserve_request(request_id) else {
            return false;
        };
        let mut retained_unpublished_children = self
            .retained_unpublished_children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        retained_unpublished_children.retain_mut(|child| !matches!(child.try_wait(), Ok(Some(_))));
        if !retained_unpublished_children.is_empty() {
            self.rollback_request_reservation(&reservation);
            return false;
        }
        let mut retained_readers = self
            .retained_readers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !reconcile_retained_readers_locked(self, &mut retained_readers) {
            self.rollback_request_reservation(&reservation);
            return false;
        }
        let mut retained_turn_workers = self
            .retained_turn_workers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !reconcile_retained_turn_workers_locked(&mut retained_turn_workers) {
            self.rollback_request_reservation(&reservation);
            return false;
        }
        let mut retained_publication_workers = self
            .retained_publication_workers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !reconcile_retained_publication_workers_locked(&mut retained_publication_workers) {
            self.rollback_request_reservation(&reservation);
            return false;
        }
        self.apply_deferred_publication_failures();
        let reconcile_closed_cleanup = reservation.closed_control_failure_token.is_some();
        if reconcile_closed_cleanup {
            if !reconcile_retained_process_group(self, Instant::now())
                || !authenticated_owned_processes_stopped(self)
            {
                self.rollback_request_reservation(&reservation);
                return false;
            }
            let retained_work_reconciled = reconcile_retained_work_directories(self);
            if !retained_work_reconciled {
                self.rollback_request_reservation(&reservation);
                return false;
            }
        }
        let Ok(process_group) = self.process_group.lock() else {
            self.rollback_request_reservation(&reservation);
            return false;
        };
        if process_group.is_some() {
            self.rollback_request_reservation(&reservation);
            return false;
        }
        drop(process_group);
        drop(retained_unpublished_children);
        drop(retained_publication_workers);
        drop(retained_turn_workers);
        drop(retained_readers);
        let retained_work_reconciled = if reconcile_closed_cleanup {
            true
        } else {
            match lock_projection_action(self) {
                Ok(_guard) => reconcile_retained_work_directories(self),
                Err(_) => reconcile_retained_work_directories(self),
            }
        };
        if !retained_work_reconciled {
            self.rollback_request_reservation(&reservation);
            return false;
        }
        #[cfg(test)]
        Self::pause_request_claim(&self.request_commit_hook);
        if !self.commit_request_reservation(&reservation) {
            return false;
        }
        #[cfg(test)]
        if Self::pause_request_claim(&self.post_begin_rollback_hook) {
            self.rollback_request_reservation(&reservation);
            return false;
        }
        if !self.finalize_request_reservation(&reservation) {
            self.rollback_request_reservation(&reservation);
            return false;
        }
        true
    }

    fn reserve_request(&self, request_id: &str) -> Option<RuntimeRequestReservation> {
        if self.deferred_cancellation_overflowed()
            || self.has_reserved_host_cancellation(request_id)
        {
            return None;
        }
        let marker = self.closed_control_failure_cleanup.load(Ordering::Acquire);
        let mut control = match self.control.lock() {
            Ok(control) => control,
            Err(poisoned) if marker => poisoned.into_inner(),
            Err(_) => return None,
        };
        self.materialize_deferred_cancellation(&mut control);
        if self.deferred_cancellation_overflowed()
            || marker != control.closed_control_failure_token.is_some()
            || self.running.load(Ordering::Acquire)
            || control.request_id.is_some()
            || (control.pending_request_id.is_some() && control.effect_generation != 0)
        {
            return None;
        }
        if control
            .pending_request_id
            .as_deref()
            .is_some_and(|pending| pending != request_id)
        {
            return None;
        }
        let effect_generation = self
            .next_effect_generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        control.pending_request_id = Some(request_id.to_owned());
        control.effect_generation = effect_generation;
        if effect_generation == 0 {
            control.cancellation = Some(AcceptedRuntimeCancellation::closed(Instant::now()));
        }
        self.materialize_deferred_cancellation(&mut control);
        Some(RuntimeRequestReservation {
            request_id: request_id.to_owned(),
            effect_generation,
            cancellation: control.cancellation,
            closed_control_failure_token: control.closed_control_failure_token,
        })
    }

    fn commit_request_reservation(&self, reservation: &RuntimeRequestReservation) -> bool {
        let mut control = match self.control.lock() {
            Ok(control) => control,
            Err(poisoned) if reservation.closed_control_failure_token.is_some() => {
                poisoned.into_inner()
            }
            Err(poisoned) => {
                let mut control = poisoned.into_inner();
                let retained_in_control =
                    !self.retain_reservation_cancellations(&mut control, reservation);
                let closed = control.cancellation.map_or_else(
                    || AcceptedRuntimeCancellation::closed(Instant::now()),
                    AcceptedRuntimeCancellation::fail_safe,
                );
                control.closed_control_failure_token = Some(closed);
                if !retained_in_control {
                    control.cancellation = Some(closed);
                }
                self.closed_control_failure_cleanup
                    .store(true, Ordering::Release);
                if !retained_in_control {
                    Self::clear_pending_reservation(&mut control, reservation);
                }
                drop(control);
                self.finished.notify_all();
                return false;
            }
        };
        if !self.reservation_matches(&control, reservation)
            || self
                .running
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            if self.retain_reservation_cancellations(&mut control, reservation) {
                Self::clear_pending_reservation(&mut control, reservation);
            }
            drop(control);
            self.finished.notify_all();
            return false;
        }
        control.pending_request_id = None;
        control.request_id = Some(reservation.request_id.clone());
        true
    }

    fn finalize_request_reservation(&self, reservation: &RuntimeRequestReservation) -> bool {
        let mut control = match self.control.lock() {
            Ok(control) => control,
            Err(poisoned) if reservation.closed_control_failure_token.is_some() => {
                poisoned.into_inner()
            }
            Err(_) => return false,
        };
        if control.request_id.as_deref() != Some(reservation.request_id.as_str())
            || control.effect_generation != reservation.effect_generation
            || control.cancellation != reservation.cancellation
            || control.closed_control_failure_token != reservation.closed_control_failure_token
            || self.closed_control_failure_cleanup.load(Ordering::Acquire)
                != reservation.closed_control_failure_token.is_some()
        {
            return false;
        }
        if let Some(closed_token) = reservation.closed_control_failure_token {
            control.closed_control_failure_token = None;
            self.closed_control_failure_cleanup
                .store(false, Ordering::Release);
            if control.cancellation == Some(closed_token) {
                control.cancellation = None;
            }
            self.control.clear_poison();
        }
        true
    }

    fn reservation_matches(
        &self,
        control: &RuntimeControl,
        reservation: &RuntimeRequestReservation,
    ) -> bool {
        control.request_id.is_none()
            && control.pending_request_id.as_deref() == Some(reservation.request_id.as_str())
            && control.effect_generation == reservation.effect_generation
            && control.cancellation == reservation.cancellation
            && control.closed_control_failure_token == reservation.closed_control_failure_token
            && self.closed_control_failure_cleanup.load(Ordering::Acquire)
                == reservation.closed_control_failure_token.is_some()
    }

    fn clear_pending_reservation(
        control: &mut RuntimeControl,
        reservation: &RuntimeRequestReservation,
    ) {
        if control.request_id.is_none()
            && control.pending_request_id.as_deref() == Some(reservation.request_id.as_str())
            && control.effect_generation == reservation.effect_generation
        {
            control.pending_request_id = None;
            control.effect_generation = 0;
        }
    }

    fn rollback_request_reservation(&self, reservation: &RuntimeRequestReservation) {
        let mut released_running = false;
        match self.control.lock() {
            Ok(mut control) => {
                let clearable = self.retain_reservation_cancellations(&mut control, reservation);
                if clearable
                    && control.request_id.as_deref() == Some(reservation.request_id.as_str())
                    && control.effect_generation == reservation.effect_generation
                {
                    control.request_id = None;
                    control.effect_generation = 0;
                    released_running = true;
                } else if clearable {
                    Self::clear_pending_reservation(&mut control, reservation);
                }
            }
            Err(poisoned) => {
                let mut control = poisoned.into_inner();
                let clearable = self.retain_reservation_cancellations(&mut control, reservation);
                if clearable
                    && control.request_id.as_deref() == Some(reservation.request_id.as_str())
                    && control.effect_generation == reservation.effect_generation
                {
                    control.request_id = None;
                    control.effect_generation = 0;
                    released_running = true;
                } else if clearable {
                    Self::clear_pending_reservation(&mut control, reservation);
                }
            }
        }
        if released_running {
            self.running.store(false, Ordering::Release);
        }
        self.finished.notify_all();
    }

    fn retain_reservation_cancellations(
        &self,
        control: &mut RuntimeControl,
        reservation: &RuntimeRequestReservation,
    ) -> bool {
        let superseding = control
            .cancellation
            .filter(|cancellation| Some(*cancellation) != reservation.cancellation)
            .and_then(|cancellation| cancellation.host_acceptance);
        let reservation_acceptance = reservation
            .cancellation
            .and_then(|cancellation| cancellation.host_acceptance);
        let retained_acceptance = superseding.or(reservation_acceptance);
        let retained = retained_acceptance.is_none_or(|accepted| {
            self.defer_reserved_host_cancellation(HostCancellationRecord {
                request_id: reservation.request_id.clone(),
                accepted,
            })
        });
        let owns_reservation = control.effect_generation == reservation.effect_generation
            && (control.request_id.as_deref() == Some(reservation.request_id.as_str())
                || control.pending_request_id.as_deref() == Some(reservation.request_id.as_str()));
        if owns_reservation {
            control.cancellation = if retained {
                control.closed_control_failure_token
            } else {
                retained_acceptance.map(AcceptedRuntimeCancellation::from_host)
            };
        }
        retained
    }

    #[cfg(test)]
    fn begin_request(
        &self,
        request_id: &str,
        reconciled_closed_token: Option<AcceptedRuntimeCancellation>,
    ) -> bool {
        let mut control = match self.control.lock() {
            Ok(control) => control,
            Err(poisoned) if reconciled_closed_token.is_some() => {
                self.control.clear_poison();
                poisoned.into_inner()
            }
            Err(_) => {
                self.running.store(false, Ordering::Release);
                self.finished.notify_all();
                return false;
            }
        };
        if let Some(reconciled_closed_token) = reconciled_closed_token {
            if !self.closed_control_failure_cleanup.load(Ordering::Acquire)
                || control.cancellation != Some(reconciled_closed_token)
            {
                self.running.store(false, Ordering::Release);
                self.finished.notify_all();
                return false;
            }
            *control = RuntimeControl::default();
            self.closed_control_failure_cleanup
                .store(false, Ordering::Release);
        }
        if control
            .pending_request_id
            .as_deref()
            .is_some_and(|pending| pending != request_id)
        {
            control.cancellation = None;
        }
        control.pending_request_id = None;
        control.request_id = Some(request_id.to_owned());
        control.effect_generation = self
            .next_effect_generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        if control.effect_generation == 0 {
            control.cancellation = Some(AcceptedRuntimeCancellation::closed(Instant::now()));
        }
        self.materialize_deferred_cancellation(&mut control);
        true
    }

    fn owns_request(&self, request_id: &str) -> bool {
        self.running.load(Ordering::Acquire)
            && self
                .control
                .lock()
                .is_ok_and(|control| control.request_id.as_deref() == Some(request_id))
    }

    fn finish_request(&self) {
        match self.control.lock() {
            Ok(mut control) => {
                self.materialize_deferred_cancellation(&mut control);
                let retain_closed_cleanup =
                    self.closed_control_failure_cleanup.load(Ordering::Acquire);
                if retain_closed_cleanup {
                    control.request_id = None;
                    control.pending_request_id = None;
                    control.effect_generation = 0;
                } else {
                    *control = RuntimeControl::default();
                }
            }
            Err(poisoned) => {
                let mut control = poisoned.into_inner();
                self.materialize_deferred_cancellation(&mut control);
                let retain_closed_cleanup =
                    self.closed_control_failure_cleanup.load(Ordering::Acquire);
                if retain_closed_cleanup {
                    control.request_id = None;
                    control.pending_request_id = None;
                    control.effect_generation = 0;
                }
            }
        }
        self.running.store(false, Ordering::Release);
        self.finished.notify_all();
        self.apply_deferred_publication_failures();
    }

    fn defer_publication_failure(&self, failure: DeferredPublicationFailure) {
        self.deferred_publication_failures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(failure);
    }

    fn apply_deferred_publication_failures(&self) {
        let failures = {
            let mut failures = self
                .deferred_publication_failures
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            std::mem::take(&mut *failures)
        };
        for mut failure in failures {
            if let Some(failure) = failure.0.take() {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(failure));
            }
        }
    }

    #[cfg(test)]
    fn cancel(&self, reason: RuntimeCancellation) {
        match self.control.lock() {
            Ok(mut control) => {
                if self.running.load(Ordering::Acquire) && control.cancellation.is_none() {
                    control.cancellation =
                        Some(AcceptedRuntimeCancellation::new(reason, Instant::now()));
                }
            }
            Err(poisoned) => {
                let mut control = poisoned.into_inner();
                control.cancellation = Some(control.cancellation.map_or_else(
                    || AcceptedRuntimeCancellation::closed(Instant::now()),
                    AcceptedRuntimeCancellation::fail_safe,
                ));
            }
        }
    }

    fn cancellation(&self) -> Option<RuntimeCancellation> {
        self.cancellation_window().map(|accepted| accepted.reason)
    }

    fn cancellation_window(&self) -> Option<AcceptedRuntimeCancellation> {
        match self.control.lock() {
            Ok(control) => control.cancellation,
            Err(poisoned) => {
                let mut control = poisoned.into_inner();
                let fail_safe = control.cancellation.map_or_else(
                    || AcceptedRuntimeCancellation::closed(Instant::now()),
                    AcceptedRuntimeCancellation::fail_safe,
                );
                control.cancellation = Some(fail_safe);
                Some(fail_safe)
            }
        }
    }

    fn cancellation_state(&self) -> Option<RuntimeReadinessState> {
        self.cancellation()
            .map(RuntimeCancellation::readiness_state)
    }

    fn wait_for_idle(&self, timeout: Duration) -> bool {
        let control = match self.control.lock() {
            Ok(control) => control,
            Err(poisoned) => {
                let control = poisoned.into_inner();
                if control.pending_request_id.is_none() {
                    return false;
                }
                control
            }
        };
        #[cfg(test)]
        self.idle_waiting.store(true, Ordering::Release);
        let wait = self
            .finished
            .wait_timeout_while(control, timeout, |control| {
                self.running.load(Ordering::Acquire)
                    || control.request_id.is_some()
                    || control.pending_request_id.is_some()
                    || control.effect_generation != 0
            });
        #[cfg(test)]
        self.idle_waiting.store(false, Ordering::Release);
        let (control, _wait) = match wait {
            Ok(wait) => wait,
            Err(poisoned) => poisoned.into_inner(),
        };
        !self.running.load(Ordering::Acquire)
            && control.request_id.is_none()
            && control.pending_request_id.is_none()
            && control.effect_generation == 0
    }
}

#[derive(Clone, Debug)]
pub struct RuntimeHost {
    configuration: Option<RuntimeConfiguration>,
    active: Arc<ActiveRuntime>,
    work_generation: Arc<AtomicU64>,
    invalidated_workspace_generation: Arc<AtomicU64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RuntimeReadinessWorkspace {
    path: PathBuf,
    generation: Option<u64>,
}

impl RuntimeReadinessWorkspace {
    pub(crate) fn tracked(path: PathBuf, generation: u64) -> Self {
        Self {
            path,
            generation: Some(generation),
        }
    }

    fn untracked(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
            generation: None,
        }
    }

    fn remains_authoritative(&self, invalidated_generation: &AtomicU64) -> bool {
        self.generation
            .is_none_or(|generation| generation > invalidated_generation.load(Ordering::Acquire))
    }
}

struct TurnExecution<'a> {
    request_id: &'a str,
    workspace_generation: u64,
    selected_workspace: &'a WorkspaceRuntimeBinding,
    task: &'a str,
    timeout: Duration,
    retain_for_host_settlement: bool,
}

fn cancellation_cleanup_wait_budget(
    now: Instant,
    cancellation: Option<AcceptedRuntimeCancellation>,
) -> Duration {
    cancellation.map_or(TURN_TERMINAL_BUDGET, |window| {
        window.terminal_cutoff.saturating_duration_since(now)
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UnmatchedHostCancellationPolicy {
    CloseContainment,
    Ignore,
}

pub(crate) enum HostCancellationMutation<T> {
    Completed(T, Vec<HostCancellationRecord>),
    ControlFailed(T),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TerminalPublicationOutcome {
    Completed(bool),
    Skipped,
    Deferred,
}

fn install_matching_host_cancellation(
    control: &mut RuntimeControl,
    running: bool,
    records: &[HostCancellationRecord],
    unmatched_policy: UnmatchedHostCancellationPolicy,
) -> bool {
    let current_request_id = if running {
        control.request_id.as_deref()
    } else {
        None
    };
    let pending_request_id = control.pending_request_id.as_deref();
    let matched = current_request_id
        .or(pending_request_id)
        .and_then(|request_id| {
            records
                .iter()
                .find(|record| record.request_id == request_id)
        })
        .or_else(|| {
            (current_request_id.is_none() && pending_request_id.is_none() && records.len() == 1)
                .then(|| records.first())
                .flatten()
        });
    if let Some(record) = matched {
        if current_request_id.is_none() {
            control.pending_request_id = Some(record.request_id.clone());
        }
        let cancellation = AcceptedRuntimeCancellation::from_host(record.accepted);
        if control.closed_control_failure_token.is_some() {
            control.cancellation = Some(cancellation);
        } else {
            control.cancellation.get_or_insert(cancellation);
        }
        return true;
    }
    if unmatched_policy == UnmatchedHostCancellationPolicy::CloseContainment
        && (current_request_id.is_some() || pending_request_id.is_some())
    {
        control
            .cancellation
            .get_or_insert_with(|| AcceptedRuntimeCancellation::closed(Instant::now()));
        return true;
    }
    false
}

impl RuntimeHost {
    fn terminal_publication_now(&self) -> Instant {
        self.active.terminal_publication_now()
    }

    #[cfg(test)]
    pub(crate) fn publish_terminal_update(
        &self,
        publish: impl FnOnce() -> bool + Send + 'static,
    ) -> TerminalPublicationOutcome {
        let terminal_cutoff = self.active.cancellation_window().map_or_else(
            || Instant::now() + TERMINAL_PUBLICATION_BUDGET,
            |window| window.terminal_cutoff,
        );
        self.publish_terminal_update_until(terminal_cutoff, publish)
    }

    #[cfg(test)]
    pub(crate) fn publish_terminal_update_until(
        &self,
        terminal_cutoff: Instant,
        publish: impl FnOnce() -> bool + Send + 'static,
    ) -> TerminalPublicationOutcome {
        self.publish_terminal_update_until_with_failure(terminal_cutoff, publish, || {})
    }

    pub(crate) fn publish_terminal_update_until_with_failure(
        &self,
        terminal_cutoff: Instant,
        publish: impl FnOnce() -> bool + Send + 'static,
        publication_failed: impl FnOnce() + Send + 'static,
    ) -> TerminalPublicationOutcome {
        let wait_started_at = Instant::now();
        let started_at = self.terminal_publication_now();
        if started_at >= terminal_cutoff {
            return TerminalPublicationOutcome::Skipped;
        }
        let (result_sender, result_receiver) = mpsc::sync_channel(1);
        let active = Arc::clone(&self.active);
        let disposition = Arc::new(AtomicU8::new(TerminalPublicationDisposition::Pending as u8));
        let worker_disposition = Arc::clone(&disposition);
        let failure = Arc::new(Mutex::new(Some(DeferredPublicationFailure(Some(
            Box::new(publication_failed),
        )))));
        let worker_failure = Arc::clone(&failure);
        let worker = match thread::Builder::new()
            .name("keiko-terminal-publication".to_owned())
            .spawn(move || {
                active.enter_terminal_publication_effect();
                let effect_started_at = active.terminal_publication_now();
                let admitted = effect_started_at < terminal_cutoff
                    && worker_disposition
                        .compare_exchange(
                            TerminalPublicationDisposition::Pending as u8,
                            TerminalPublicationDisposition::Admitted as u8,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok();
                let result = if !admitted {
                    TerminalPublicationWorkerResult::Skipped
                } else {
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(publish)) {
                        Ok(true)
                            if !terminal_cutoff_exceeded(
                                active.terminal_publication_now(),
                                terminal_cutoff,
                            ) =>
                        {
                            TerminalPublicationWorkerResult::Published
                        }
                        Ok(true) => TerminalPublicationWorkerResult::Skipped,
                        Ok(false) | Err(_) => TerminalPublicationWorkerResult::Failed,
                    }
                };
                worker_disposition.store(
                    TerminalPublicationDisposition::from_worker_result(result) as u8,
                    Ordering::Release,
                );
                let _ = result_sender.send(result);
                if result == TerminalPublicationWorkerResult::Failed {
                    let failure = worker_failure
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .take();
                    if let Some(mut failure) = failure {
                        if active.wait_for_idle(TURN_TERMINAL_BUDGET) {
                            if let Some(failure) = failure.0.take() {
                                let _ =
                                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(failure));
                            }
                        } else {
                            active.defer_publication_failure(failure);
                        }
                    }
                }
            }) {
            Ok(worker) => worker,
            Err(_) => {
                if let Some(failure) = failure
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take()
                {
                    self.active.defer_publication_failure(failure);
                }
                return TerminalPublicationOutcome::Completed(false);
            }
        };
        let wait_budget = terminal_cutoff
            .saturating_duration_since(started_at)
            .min(TERMINAL_PUBLICATION_BUDGET);
        let deadline = wait_started_at + wait_budget;
        let result =
            result_receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()));
        let retained = RetainedPublicationWorker {
            result: result_receiver,
            worker,
        };
        match result {
            Ok(TerminalPublicationWorkerResult::Published) => {
                retire_publication_worker(&self.active, retained, deadline);
                TerminalPublicationOutcome::Completed(true)
            }
            Ok(TerminalPublicationWorkerResult::Skipped) => {
                retire_publication_worker(&self.active, retained, deadline);
                TerminalPublicationOutcome::Skipped
            }
            Ok(TerminalPublicationWorkerResult::Failed) => {
                retain_publication_worker(&self.active, retained);
                TerminalPublicationOutcome::Completed(false)
            }
            Err(RecvTimeoutError::Timeout) => {
                retain_publication_worker(&self.active, retained);
                match disposition.compare_exchange(
                    TerminalPublicationDisposition::Pending as u8,
                    TerminalPublicationDisposition::Skipped as u8,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                ) {
                    Ok(_) => TerminalPublicationOutcome::Skipped,
                    Err(value) if value == TerminalPublicationDisposition::Published as u8 => {
                        TerminalPublicationOutcome::Completed(true)
                    }
                    Err(value) if value == TerminalPublicationDisposition::Skipped as u8 => {
                        TerminalPublicationOutcome::Skipped
                    }
                    Err(value) if value == TerminalPublicationDisposition::Failed as u8 => {
                        TerminalPublicationOutcome::Completed(false)
                    }
                    Err(_) => TerminalPublicationOutcome::Deferred,
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                retire_publication_worker(&self.active, retained, deadline);
                TerminalPublicationOutcome::Completed(false)
            }
        }
    }

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
        let selected_workspace = selected_workspace.map(RuntimeReadinessWorkspace::untracked);
        self.check_with_timeout(
            request_id,
            selected_workspace.as_ref(),
            DEFAULT_REQUEST_TIMEOUT,
        )
    }

    fn check_with_timeout(
        &self,
        request_id: &str,
        selected_workspace: Option<&RuntimeReadinessWorkspace>,
        timeout: Duration,
    ) -> RuntimeReadinessView {
        let started_at = Instant::now();
        let deadline = started_at + timeout;
        #[cfg(test)]
        self.active
            .record_readiness_deadline(ReadinessDeadlineObservation {
                stage: ReadinessDeadlineStage::Request,
                started_at: Some(started_at),
                timeout: Some(timeout),
                deadline,
            });
        if !self.active.claim_request(request_id) {
            return RuntimeReadinessView::terminal(RuntimeReadinessState::ContainmentFailed, 0);
        }
        if selected_workspace.is_some_and(|workspace| {
            !workspace.remains_authoritative(&self.invalidated_workspace_generation)
        }) {
            self.active.finish_request();
            return RuntimeReadinessView::terminal(RuntimeReadinessState::Cancelled, 0);
        }
        let result = self.configuration.as_ref().map_or_else(
            || RuntimeReadinessView::terminal(RuntimeReadinessState::Unavailable, 0),
            |configuration| {
                perform_check(
                    configuration,
                    selected_workspace,
                    &self.active,
                    &self.work_generation,
                    &self.invalidated_workspace_generation,
                    deadline,
                )
            },
        );
        self.active.finish_request();
        result
    }

    pub fn cancel_request(&self, request_id: &str) {
        self.cancel_request_at(request_id, Instant::now());
    }

    #[cfg(test)]
    pub(crate) fn accept_request_cancellation(
        &self,
        request_id: &str,
        accepted: AcceptedCancellation,
    ) {
        self.cancel_request_with(request_id, AcceptedRuntimeCancellation::from_host(accepted));
    }

    pub(crate) fn handoff_host_cancellation<T, Output>(
        &self,
        unmatched_policy: UnmatchedHostCancellationPolicy,
        mutation: impl FnOnce() -> HostCancellationMutation<T>,
        after_install: impl FnOnce(T) -> Output,
    ) -> Output {
        let output;
        let signal_authority;
        let kill;
        match self.active.control.lock() {
            Ok(mut control) => {
                self.active.materialize_deferred_cancellation(&mut control);
                let (value, records, host_control_failed) = match mutation() {
                    HostCancellationMutation::Completed(value, records) => (value, records, false),
                    HostCancellationMutation::ControlFailed(value) => (value, Vec::new(), true),
                };
                let running = self.active.running.load(Ordering::Acquire);
                let signal = if host_control_failed
                    && (running
                        || control.request_id.is_some()
                        || control.pending_request_id.is_some())
                {
                    let closed = AcceptedRuntimeCancellation::closed(Instant::now());
                    control.cancellation = Some(closed);
                    control.closed_control_failure_token = Some(closed);
                    self.active
                        .closed_control_failure_cleanup
                        .store(true, Ordering::Release);
                    true
                } else {
                    install_matching_host_cancellation(
                        &mut control,
                        running,
                        &records,
                        unmatched_policy,
                    )
                };
                let request_id = if self.active.running.load(Ordering::Acquire) {
                    control.request_id.as_deref()
                } else {
                    control.pending_request_id.as_deref()
                };
                let retain = records
                    .iter()
                    .filter(|record| request_id != Some(record.request_id.as_str()))
                    .cloned()
                    .collect::<Vec<_>>();
                if !retain.is_empty() {
                    self.active.defer_host_cancellations(&retain);
                }
                output = after_install(value);
                self.active.materialize_deferred_cancellation(&mut control);
                signal_authority = (signal || control.cancellation.is_some())
                    .then(|| self.capture_signal_authority(&control))
                    .flatten();
                kill = self
                    .active
                    .closed_control_failure_cleanup
                    .load(Ordering::Acquire);
            }
            Err(poisoned) => {
                let mut control = poisoned.into_inner();
                let running = self.active.running.load(Ordering::Acquire);
                let (value, records, host_control_failed) = match mutation() {
                    HostCancellationMutation::Completed(value, records) => (value, records, false),
                    HostCancellationMutation::ControlFailed(value) => (value, Vec::new(), true),
                };
                let active_or_pending =
                    running || control.request_id.is_some() || control.pending_request_id.is_some();
                let installed_host_request_id;
                if host_control_failed && active_or_pending {
                    let closed = AcceptedRuntimeCancellation::closed(Instant::now());
                    control.cancellation = Some(closed);
                    control.closed_control_failure_token = Some(closed);
                    self.active
                        .closed_control_failure_cleanup
                        .store(true, Ordering::Release);
                    installed_host_request_id = None;
                } else {
                    let matched = control.closed_control_failure_token.is_some()
                        && install_matching_host_cancellation(
                            &mut control,
                            running,
                            &records,
                            unmatched_policy,
                        );
                    if !matched {
                        control.cancellation = Some(control.cancellation.map_or_else(
                            || AcceptedRuntimeCancellation::closed(Instant::now()),
                            AcceptedRuntimeCancellation::fail_safe,
                        ));
                    }
                    installed_host_request_id = matched
                        .then(|| {
                            if running {
                                control.request_id.clone()
                            } else {
                                control.pending_request_id.clone()
                            }
                        })
                        .flatten();
                }
                let retain = records
                    .iter()
                    .filter(|record| {
                        installed_host_request_id.as_deref() != Some(record.request_id.as_str())
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                if !retain.is_empty() {
                    self.active.defer_host_cancellations(&retain);
                }
                output = after_install(value);
                self.active.materialize_deferred_cancellation(&mut control);
                signal_authority = self.capture_signal_authority(&control);
                kill = self
                    .active
                    .closed_control_failure_cleanup
                    .load(Ordering::Acquire);
            }
        }
        self.signal_captured_authority(signal_authority, kill);
        output
    }

    fn capture_signal_authority(&self, control: &RuntimeControl) -> Option<RuntimeSignalAuthority> {
        if !self.active.running.load(Ordering::Acquire) || control.cancellation.is_none() {
            return None;
        }
        let request_id = control.request_id.clone()?;
        if control.effect_generation == 0 {
            return None;
        }
        let process_identity = self
            .active
            .process_group
            .lock()
            .ok()
            .and_then(|process_group| *process_group)?;
        Some(RuntimeSignalAuthority {
            request_id,
            effect_generation: control.effect_generation,
            cancellation: control.cancellation?,
            process_identity,
        })
    }

    fn signal_active_process_with_authority(
        &self,
        authority: &RuntimeSignalAuthority,
        signal: i32,
    ) -> bool {
        let control = match self.active.control.lock() {
            Ok(control) => control,
            Err(poisoned) => poisoned.into_inner(),
        };
        if !self.active.running.load(Ordering::Acquire)
            || control.request_id.as_deref() != Some(authority.request_id.as_str())
            || control.effect_generation != authority.effect_generation
            || control.cancellation != Some(authority.cancellation)
        {
            return false;
        }
        let Ok(process_group) = self.active.process_group.lock() else {
            return false;
        };
        if *process_group != Some(authority.process_identity)
            || retained_process_identity_status(authority.process_identity)
                != RetainedProcessIdentityStatus::Current
        {
            return false;
        }
        signal_process_group(authority.process_identity.process_id, signal);
        if let Ok(owned) = self.active.owned_processes.lock() {
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

    fn signal_captured_authority(&self, authority: Option<RuntimeSignalAuthority>, kill: bool) {
        let Some(authority) = authority else {
            return;
        };
        #[cfg(test)]
        ActiveRuntime::pause_request_claim(&self.active.cancellation_signal_hook);
        self.signal_active_process_with_authority(&authority, SIGTERM);
        if kill {
            self.signal_active_process_with_authority(&authority, SIGKILL);
        }
    }

    pub(crate) fn cancel_request_at(&self, request_id: &str, accepted_at: Instant) {
        self.cancel_request_with(
            request_id,
            AcceptedRuntimeCancellation::new(RuntimeCancellation::User, accepted_at),
        );
    }

    fn cancel_request_with(&self, request_id: &str, cancellation: AcceptedRuntimeCancellation) {
        let signal_authority = match self.active.control.lock() {
            Ok(mut control) => {
                let mut accepted = false;
                if self.active.running.load(Ordering::Acquire)
                    && control.request_id.as_deref() == Some(request_id)
                {
                    if control.closed_control_failure_token.is_some() {
                        control.cancellation = Some(cancellation);
                    } else {
                        control.cancellation.get_or_insert(cancellation);
                    }
                    accepted = true;
                } else if control.request_id.is_none()
                    && control
                        .pending_request_id
                        .as_deref()
                        .is_none_or(|pending| pending == request_id)
                {
                    control.pending_request_id = Some(request_id.to_owned());
                    if control.closed_control_failure_token.is_some() {
                        control.cancellation = Some(cancellation);
                    } else {
                        control.cancellation.get_or_insert(cancellation);
                    }
                    accepted = true;
                }
                accepted
                    .then(|| self.capture_signal_authority(&control))
                    .flatten()
            }
            Err(poisoned) => {
                let mut control = poisoned.into_inner();
                let exact_request = control.request_id.as_deref() == Some(request_id)
                    || control.pending_request_id.as_deref() == Some(request_id);
                if exact_request && control.closed_control_failure_token.is_some() {
                    control.cancellation = Some(cancellation);
                } else {
                    control.cancellation = Some(control.cancellation.map_or_else(
                        || AcceptedRuntimeCancellation::closed(Instant::now()),
                        AcceptedRuntimeCancellation::fail_safe,
                    ));
                }
                self.capture_signal_authority(&control)
            }
        };
        self.signal_captured_authority(signal_authority, false);
    }

    #[cfg(test)]
    pub(crate) fn cancellation_window_for_test(&self) -> Option<AcceptedRuntimeCancellation> {
        self.active.cancellation_window()
    }

    #[cfg(test)]
    pub(crate) fn set_active_request_for_test(&self, request_id: &str) {
        self.active.running.store(true, Ordering::Release);
        let mut control = self
            .active
            .control
            .lock()
            .expect("active request test seam");
        control.request_id = Some(request_id.to_owned());
        control.effect_generation = self
            .active
            .next_effect_generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
    }

    #[cfg(test)]
    pub(crate) fn finish_active_request_for_test(&self) {
        self.active.finish_request();
    }

    #[cfg(test)]
    pub(crate) fn set_terminal_publication_now_for_test(&self, now: Instant) {
        *self
            .active
            .terminal_publication_now
            .lock()
            .expect("terminal publication clock") = Some(now);
    }

    #[cfg(test)]
    pub(crate) fn install_terminal_publication_hook_for_test(
        &self,
    ) -> (mpsc::Receiver<()>, Arc<(Mutex<bool>, Condvar)>) {
        self.active.install_terminal_publication_hook()
    }

    #[cfg(test)]
    pub(crate) fn install_request_commit_hook_for_test(
        &self,
    ) -> (mpsc::Receiver<()>, Arc<(Mutex<bool>, Condvar)>) {
        ActiveRuntime::install_request_claim_hook(&self.active.request_commit_hook)
    }

    #[cfg(test)]
    fn install_post_begin_rollback_hook_for_test(
        &self,
    ) -> (mpsc::Receiver<()>, Arc<(Mutex<bool>, Condvar)>) {
        ActiveRuntime::install_request_claim_hook(&self.active.post_begin_rollback_hook)
    }

    #[cfg(test)]
    fn install_cancellation_signal_hook_for_test(
        &self,
    ) -> (mpsc::Receiver<()>, Arc<(Mutex<bool>, Condvar)>) {
        ActiveRuntime::install_request_claim_hook(&self.active.cancellation_signal_hook)
    }

    #[cfg(test)]
    fn install_readiness_settlement_hook_for_test(
        &self,
    ) -> (mpsc::Receiver<()>, Arc<(Mutex<bool>, Condvar)>) {
        ActiveRuntime::install_request_claim_hook(&self.active.readiness_settlement_hook)
    }

    #[cfg(test)]
    fn install_readiness_completion_hook_for_test(
        &self,
    ) -> (mpsc::Receiver<()>, Arc<(Mutex<bool>, Condvar)>) {
        ActiveRuntime::install_request_claim_hook(&self.active.readiness_completion_hook)
    }

    #[cfg(test)]
    pub(crate) fn poison_control_for_test(&self) {
        let active = Arc::clone(&self.active);
        let _ = std::panic::catch_unwind(move || {
            let _guard = active
                .control
                .lock()
                .expect("runtime control before poison");
            panic!("poison runtime control for publication test");
        });
    }

    #[cfg(test)]
    pub(crate) fn has_no_runtime_effects_for_test(&self) -> bool {
        self.active.runtime_effect_trace().is_empty()
            && !self.active.running.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn owns_request_for_test(&self, request_id: &str) -> bool {
        self.active.owns_request(request_id)
    }

    #[cfg(test)]
    pub(crate) fn install_failed_claim_settlement_hook_for_test(
        &self,
    ) -> (mpsc::Receiver<()>, Arc<(Mutex<bool>, Condvar)>) {
        ActiveRuntime::install_request_claim_hook(&self.active.failed_claim_settlement_hook)
    }

    #[cfg(test)]
    pub(crate) fn pause_failed_claim_settlement_for_test(&self) {
        ActiveRuntime::pause_request_claim(&self.active.failed_claim_settlement_hook);
    }

    #[cfg(test)]
    fn fail_reader_spawn_for_test(&self, attempt: usize) {
        self.active.reader_spawn_attempt.store(0, Ordering::Release);
        self.active
            .reader_spawn_failure
            .store(attempt, Ordering::Release);
    }

    #[cfg(test)]
    fn fail_spawn_rollback_for_test(&self, phase: usize) {
        self.active
            .spawn_rollback_failure
            .store(phase, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn hold_projection_action_fence_for_test(&self, action: impl FnOnce()) {
        let guard = lock_projection_action(&self.active).expect("projection action fence");
        action();
        drop(guard);
    }

    pub(crate) fn defer_host_cancellations(&self, records: &[HostCancellationRecord]) {
        self.active.defer_host_cancellations(records);
        let signal_authority = self.materialize_deferred_signal_authority();
        self.signal_captured_authority(signal_authority, false);
    }

    pub(crate) fn defer_containment_failure(&self) {
        self.active
            .defer_cancellation(AcceptedRuntimeCancellation::closed(Instant::now()));
        let signal_authority = self.materialize_deferred_signal_authority();
        self.signal_captured_authority(signal_authority, false);
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
        self.cancel_with_reason(reason);
        self.wait_for_accepted_cancellation_cleanup()
    }

    pub(crate) fn wait_for_accepted_cancellation_cleanup(&self) -> bool {
        let now = Instant::now();
        let cancellation = self.active.cancellation_window();
        let deadline =
            cancellation.map_or(now + TURN_TERMINAL_BUDGET, |window| window.terminal_cutoff);
        let idle_timeout = cancellation_cleanup_wait_budget(now, cancellation);
        if !self.active.wait_for_idle(idle_timeout) {
            return false;
        }
        reconcile_retained_runtime_ownership(&self.active)
            && reconcile_retained_unpublished_children(&self.active, deadline)
            && reconcile_retained_process_group(&self.active, deadline)
            && reconcile_retained_work_directories(&self.active)
            && !self.active.running.load(Ordering::Acquire)
            && self.active.control.lock().is_ok_and(|control| {
                control.request_id.is_none()
                    && control.pending_request_id.is_none()
                    && control.effect_generation == 0
            })
    }

    fn cancel_with_reason(&self, reason: RuntimeCancellation) {
        let signal_authority = match self.active.control.lock() {
            Ok(mut control) => {
                if self.active.running.load(Ordering::Acquire) {
                    control.cancellation.get_or_insert_with(|| {
                        AcceptedRuntimeCancellation::new(reason, Instant::now())
                    });
                } else if control.effect_generation != 0 {
                    control.cancellation =
                        Some(AcceptedRuntimeCancellation::new(reason, Instant::now()));
                }
                self.capture_signal_authority(&control)
            }
            Err(poisoned) => {
                let mut control = poisoned.into_inner();
                if !self.active.running.load(Ordering::Acquire) && control.effect_generation != 0 {
                    let closed = AcceptedRuntimeCancellation::closed(Instant::now());
                    control.cancellation = Some(closed);
                    control.closed_control_failure_token = Some(closed);
                    self.active
                        .closed_control_failure_cleanup
                        .store(true, Ordering::Release);
                } else if !self.active.running.load(Ordering::Acquire)
                    && control.pending_request_id.is_some()
                {
                    let closed = AcceptedRuntimeCancellation::closed(Instant::now());
                    control.closed_control_failure_token = Some(closed);
                    self.active
                        .closed_control_failure_cleanup
                        .store(true, Ordering::Release);
                } else {
                    control.cancellation = Some(control.cancellation.map_or_else(
                        || AcceptedRuntimeCancellation::closed(Instant::now()),
                        AcceptedRuntimeCancellation::fail_safe,
                    ));
                }
                self.capture_signal_authority(&control)
            }
        };
        self.signal_captured_authority(signal_authority, false);
    }

    fn materialize_deferred_signal_authority(&self) -> Option<RuntimeSignalAuthority> {
        let (mut control, poisoned) = match self.active.control.try_lock() {
            Ok(control) => (control, false),
            Err(std::sync::TryLockError::WouldBlock) => return None,
            Err(std::sync::TryLockError::Poisoned(poisoned)) => (poisoned.into_inner(), true),
        };
        self.active.materialize_deferred_cancellation(&mut control);
        if poisoned {
            control.cancellation = Some(control.cancellation.map_or_else(
                || AcceptedRuntimeCancellation::closed(Instant::now()),
                AcceptedRuntimeCancellation::fail_safe,
            ));
        }
        self.capture_signal_authority(&control)
    }

    #[cfg(test)]
    pub(crate) fn run_turn(
        &self,
        request_id: &str,
        workspace_generation: u64,
        selected_workspace: &WorkspaceRuntimeBinding,
        task: &str,
        timeout: Duration,
        update: impl FnMut(TurnRuntimeUpdate),
    ) -> TurnRuntimeOutcome {
        self.run_turn_with_settlement(
            TurnExecution {
                request_id,
                workspace_generation,
                selected_workspace,
                task,
                timeout,
                retain_for_host_settlement: false,
            },
            update,
        )
    }

    pub(crate) fn run_turn_for_host_settlement(
        &self,
        request_id: &str,
        workspace_generation: u64,
        selected_workspace: &WorkspaceRuntimeBinding,
        task: &str,
        timeout: Duration,
        update: impl FnMut(TurnRuntimeUpdate),
    ) -> TurnRuntimeOutcome {
        self.run_turn_with_settlement(
            TurnExecution {
                request_id,
                workspace_generation,
                selected_workspace,
                task,
                timeout,
                retain_for_host_settlement: true,
            },
            update,
        )
    }

    #[cfg(test)]
    pub(crate) fn claim_turn_request_for_host_settlement(&self, request_id: &str) -> bool {
        self.active.claim_request(request_id)
    }

    pub(crate) fn claim_turn_request_for_host_settlement_disposition(
        &self,
        request_id: &str,
    ) -> HostTurnClaimDisposition {
        if self.active.claim_request(request_id) {
            return HostTurnClaimDisposition::Claimed;
        }
        let mut control = match self.active.control.lock() {
            Ok(control) => control,
            Err(poisoned) => poisoned.into_inner(),
        };
        let owns_exact_request = control.request_id.as_deref() == Some(request_id)
            || control.pending_request_id.as_deref() == Some(request_id);
        if owns_exact_request {
            self.active.materialize_deferred_cancellation(&mut control);
            if control
                .cancellation
                .is_some_and(|cancellation| cancellation.host_acceptance.is_some())
            {
                return HostTurnClaimDisposition::Cancelled;
            }
        }
        if self.active.has_exact_deferred_host_cancellation(request_id) {
            HostTurnClaimDisposition::Cancelled
        } else {
            HostTurnClaimDisposition::Rejected
        }
    }

    fn run_turn_with_settlement(
        &self,
        execution: TurnExecution<'_>,
        mut update: impl FnMut(TurnRuntimeUpdate),
    ) -> TurnRuntimeOutcome {
        let TurnExecution {
            request_id,
            workspace_generation,
            selected_workspace,
            task,
            timeout,
            retain_for_host_settlement,
        } = execution;
        let deadline = Instant::now() + timeout;
        if !self.active.owns_request(request_id) && !self.active.claim_request(request_id) {
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
            if !retain_for_host_settlement {
                self.active.finish_request();
            }
            return TurnRuntimeOutcome::terminal(TurnState::Failed, TurnReason::StaleWorkspace);
        }
        if !selected_workspace.remains_current() {
            if !retain_for_host_settlement {
                self.active.finish_request();
            }
            return TurnRuntimeOutcome::terminal(TurnState::Failed, TurnReason::StaleWorkspace);
        }
        let mut result = self.configuration.as_ref().map_or_else(
            || TurnRuntimeOutcome::terminal(TurnState::Failed, TurnReason::RuntimeUnavailable),
            |configuration| {
                run_owned_turn(
                    configuration.clone(),
                    selected_workspace.clone(),
                    task.to_owned(),
                    Arc::clone(&self.active),
                    Arc::clone(&self.work_generation),
                    deadline,
                    &mut update,
                )
            },
        );
        result.cancellation = result
            .cancellation
            .or_else(|| self.active.cancellation_window());
        if !retain_for_host_settlement {
            self.active.finish_request();
        }
        result
    }

    pub(crate) fn settle_host_turn<Published, Output>(
        &self,
        request_id: &str,
        publish: impl FnOnce(&mut dyn FnMut() -> Option<AcceptedCancellation>, bool) -> Published,
        finalize: impl FnOnce(Published, Option<AcceptedCancellation>) -> Output,
    ) -> Output {
        let (mut control, poisoned) = match self.active.control.lock() {
            Ok(control) => (control, false),
            Err(poisoned) => (poisoned.into_inner(), true),
        };
        let mut extracted = None;
        let initial_acceptance = self.active.exact_host_acceptance_for_settlement(
            &mut control,
            request_id,
            &mut extracted,
        );
        if poisoned {
            if extracted.is_none() && initial_acceptance.is_some() {
                extracted = control
                    .cancellation
                    .filter(|cancellation| cancellation.host_acceptance == initial_acceptance);
            }
            let closed = AcceptedRuntimeCancellation::closed(Instant::now());
            control.closed_control_failure_token = Some(closed);
            self.active
                .closed_control_failure_cleanup
                .store(true, Ordering::Release);
            let different_owner = control
                .request_id
                .as_deref()
                .or(control.pending_request_id.as_deref())
                .is_some_and(|owner| owner != request_id);
            if !different_owner {
                control.cancellation = Some(closed);
            }
        }
        let published = {
            let mut refresh_acceptance = || {
                self.active.exact_host_acceptance_for_settlement(
                    &mut control,
                    request_id,
                    &mut extracted,
                )
            };
            publish(
                &mut refresh_acceptance,
                poisoned && initial_acceptance.is_none(),
            )
        };
        let final_acceptance = self.active.exact_host_acceptance_for_settlement(
            &mut control,
            request_id,
            &mut extracted,
        );
        let output = finalize(published, final_acceptance);
        let settlement_cancellation = extracted.or_else(|| {
            control.cancellation.filter(|cancellation| {
                cancellation.host_acceptance.is_some()
                    && cancellation.host_acceptance == final_acceptance
            })
        });
        let released_cancelled_request = self
            .active
            .clear_poisoned_exact_host_settlement_owner(&mut control, request_id, extracted)
            .unwrap_or_else(|| {
                self.active.clear_exact_host_settlement_owner(
                    &mut control,
                    request_id,
                    settlement_cancellation,
                )
            });
        if released_cancelled_request {
            self.active.running.store(false, Ordering::Release);
        } else if control.request_id.as_deref() == Some(request_id) {
            if self
                .active
                .closed_control_failure_cleanup
                .load(Ordering::Acquire)
            {
                control.request_id = None;
                control.pending_request_id = None;
                control.effect_generation = 0;
            } else {
                *control = RuntimeControl::default();
            }
            self.active.running.store(false, Ordering::Release);
        }
        drop(control);
        self.active.finished.notify_all();
        self.active.apply_deferred_publication_failures();
        output
    }

    fn settle_host_readiness<Output>(
        &self,
        request_id: &str,
        mut view: RuntimeReadinessView,
        finalize: impl FnOnce(RuntimeReadinessView) -> Output,
    ) -> Output {
        let (mut control, poisoned) = match self.active.control.lock() {
            Ok(control) => (control, false),
            Err(poisoned) => (poisoned.into_inner(), true),
        };
        let mut extracted = None;
        let acceptance = self.active.exact_host_acceptance_for_settlement(
            &mut control,
            request_id,
            &mut extracted,
        );
        if acceptance.is_some() && view.state != RuntimeReadinessState::CleanupFailed {
            view = RuntimeReadinessView::terminal(
                RuntimeReadinessState::Cancelled,
                view.quarantined_events,
            );
        } else if poisoned && view.state != RuntimeReadinessState::CleanupFailed {
            view = RuntimeReadinessView::terminal(
                RuntimeReadinessState::ContainmentFailed,
                view.quarantined_events,
            );
        }
        if poisoned {
            if extracted.is_none() && acceptance.is_some() {
                extracted = control
                    .cancellation
                    .filter(|cancellation| cancellation.host_acceptance == acceptance);
            }
            let closed = AcceptedRuntimeCancellation::closed(Instant::now());
            control.closed_control_failure_token = Some(closed);
            self.active
                .closed_control_failure_cleanup
                .store(true, Ordering::Release);
            let different_owner = control
                .request_id
                .as_deref()
                .or(control.pending_request_id.as_deref())
                .is_some_and(|owner| owner != request_id);
            if !different_owner {
                control.cancellation = Some(closed);
            }
        }
        #[cfg(test)]
        ActiveRuntime::pause_request_claim(&self.active.readiness_completion_hook);
        let output = finalize(view);
        let settlement_cancellation = extracted.or_else(|| {
            control.cancellation.filter(|cancellation| {
                cancellation.host_acceptance.is_some() && cancellation.host_acceptance == acceptance
            })
        });
        let released_running = self
            .active
            .clear_poisoned_exact_host_settlement_owner(&mut control, request_id, extracted)
            .unwrap_or_else(|| {
                self.active.clear_exact_host_settlement_owner(
                    &mut control,
                    request_id,
                    settlement_cancellation,
                )
            });
        if released_running {
            self.active.running.store(false, Ordering::Release);
        } else if control.request_id.as_deref() == Some(request_id) {
            control.request_id = None;
            control.pending_request_id = None;
            control.effect_generation = 0;
            if !self
                .active
                .closed_control_failure_cleanup
                .load(Ordering::Acquire)
            {
                control.cancellation = None;
            }
            self.active.running.store(false, Ordering::Release);
        }
        drop(control);
        self.active.finished.notify_all();
        output
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
    pub(crate) cancellation: Option<AcceptedRuntimeCancellation>,
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
            cancellation: None,
        }
    }
}

fn cleanup_failed_turn_outcome() -> TurnRuntimeOutcome {
    let mut outcome =
        TurnRuntimeOutcome::terminal(TurnState::CleanupFailed, TurnReason::CleanupFailed);
    outcome.cleaned = false;
    outcome
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
    let selected_workspace = selected_workspace.map(RuntimeReadinessWorkspace::untracked);
    runtime_request_with_workspace_authority(
        lifecycle,
        runtime,
        sender,
        selected_workspace.as_ref(),
        request,
    )
}

pub(crate) fn runtime_request_with_workspace_authority(
    lifecycle: &Mutex<HostLifecycle>,
    runtime: &RuntimeHost,
    sender: &SenderContext,
    selected_workspace: Option<&RuntimeReadinessWorkspace>,
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
    let request_id = request_id.to_owned();
    let view = runtime.check_with_timeout(
        &request_id,
        selected_workspace,
        Duration::from_millis(u64::from(timeout_ms)),
    );
    #[cfg(test)]
    ActiveRuntime::pause_request_claim(&runtime.active.readiness_settlement_hook);
    let encoded = runtime.settle_host_readiness(&request_id, view, |view| {
        lifecycle.lock().map_or_else(
            |_| encode_error("unknown-request", ReasonCode::InternalFailure),
            |mut lifecycle| lifecycle.complete_runtime_request(accepted, view),
        )
    });
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
    selected_workspace: Option<&RuntimeReadinessWorkspace>,
    active: &ActiveRuntime,
    work_generation: &AtomicU64,
    invalidated_workspace_generation: &AtomicU64,
    deadline: Instant,
) -> RuntimeReadinessView {
    #[cfg(test)]
    active.record_readiness_deadline(ReadinessDeadlineObservation {
        stage: ReadinessDeadlineStage::PerformCheck,
        started_at: None,
        timeout: None,
        deadline,
    });
    if Instant::now() >= deadline {
        return RuntimeReadinessView::terminal(RuntimeReadinessState::TimedOut, 0);
    }
    let mut verified = match runtime_effect(active, RuntimeEffectStage::Bind, || {
        if selected_workspace.is_some_and(|workspace| {
            !workspace.remains_authoritative(invalidated_workspace_generation)
        }) {
            return Err(RuntimeReadinessState::Cancelled);
        }
        bind_configuration(
            configuration,
            selected_workspace.map(|workspace| workspace.path.as_path()),
        )
    }) {
        RuntimeEffectResult::Rejected(cancellation)
        | RuntimeEffectResult::Cancelled(_, cancellation) => {
            return RuntimeReadinessView::terminal(cancellation.readiness_state(), 0);
        }
        RuntimeEffectResult::Completed(Ok(verified)) => verified,
        RuntimeEffectResult::Completed(Err(state)) => {
            return RuntimeReadinessView::terminal(state, 0);
        }
    };
    if let Some(state) = active.cancellation_state() {
        return RuntimeReadinessView::terminal(state, 0);
    }
    let Some(owner) = process_identity(std::process::id() as i32) else {
        return RuntimeReadinessView::terminal(RuntimeReadinessState::ContainmentFailed, 0);
    };
    let work_root = verified.work_root.clone();
    let (work_directory, created) =
        match runtime_effect(active, RuntimeEffectStage::Directory, || {
            let generation = work_generation.fetch_add(1, Ordering::AcqRel) + 1;
            let work_directory =
                work_root.join(runtime_work_directory_name("readiness", owner, generation));
            let created =
                create_private_readiness_directory(active, &work_directory, owner, generation);
            (work_directory, created)
        }) {
            RuntimeEffectResult::Completed(result) => result,
            RuntimeEffectResult::Rejected(cancellation) => {
                return RuntimeReadinessView::terminal(cancellation.readiness_state(), 0);
            }
            RuntimeEffectResult::Cancelled((work_directory, created), cancellation) => {
                if created.is_ok() && !remove_directory_if_present(&work_directory) {
                    retain_work_directory(active, &work_directory);
                    return RuntimeReadinessView::terminal(RuntimeReadinessState::CleanupFailed, 0);
                }
                return RuntimeReadinessView::terminal(cancellation.readiness_state(), 0);
            }
        };
    if let Err(state) = created {
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

fn run_owned_turn(
    configuration: RuntimeConfiguration,
    selected_workspace: WorkspaceRuntimeBinding,
    task: String,
    active: Arc<ActiveRuntime>,
    work_generation: Arc<AtomicU64>,
    deadline: Instant,
    update: &mut impl FnMut(TurnRuntimeUpdate),
) -> TurnRuntimeOutcome {
    let (events_sender, events) = mpsc::channel();
    let (completed_sender, completed) = mpsc::sync_channel(1);
    let worker_active = Arc::clone(&active);
    let worker = match thread::Builder::new()
        .name("keiko-runtime-turn".to_owned())
        .spawn(move || {
            let outcome = perform_turn(
                &configuration,
                &selected_workspace,
                &task,
                &worker_active,
                &work_generation,
                deadline,
                &mut |event| {
                    if !matches!(event, TurnRuntimeUpdate::Stopping(_)) {
                        let _ = events_sender.send(TurnWorkerEvent::Update(event));
                    }
                },
            );
            let _ = events_sender.send(TurnWorkerEvent::Outcome(outcome.clone()));
            let _ = completed_sender.send(true);
        }) {
        Ok(worker) => worker,
        Err(_) => {
            let mut outcome = TurnRuntimeOutcome::terminal(
                TurnState::ContainmentFailed,
                TurnReason::InternalFailure,
            );
            outcome.cleaned = false;
            return outcome;
        }
    };
    await_owned_turn(
        &active,
        OwnedTurnWorker {
            events,
            retained: RetainedTurnWorker {
                completed,
                cleanup_proven: None,
                worker,
            },
        },
        deadline,
        update,
    )
}

fn await_owned_turn(
    active: &ActiveRuntime,
    owned: OwnedTurnWorker,
    request_deadline: Instant,
    update: &mut impl FnMut(TurnRuntimeUpdate),
) -> TurnRuntimeOutcome {
    let OwnedTurnWorker { events, retained } = owned;
    let mut retained = Some(retained);
    let mut stopping_published = false;
    loop {
        let cancellation = active.cancellation_window();
        if let Some(cancellation) = cancellation
            && cancellation.reason.turn_state() == TurnState::Cancelled
            && !stopping_published
        {
            update(TurnRuntimeUpdate::Stopping(
                cancellation.reason.turn_reason(),
            ));
            stopping_published = true;
        }
        let now = Instant::now();
        let wait_deadline = cancellation.map_or(request_deadline, |cancellation| {
            cancellation.cleanup_cutoff.min(request_deadline)
        });
        let deadline_closed = cancellation
            .is_some_and(|_| terminal_cutoff_exceeded(now, wait_deadline))
            || (cancellation.is_none() && now >= wait_deadline);
        if deadline_closed {
            retain_turn_worker(active, retained.take().expect("owned turn worker"));
            let mut outcome =
                TurnRuntimeOutcome::terminal(TurnState::CleanupFailed, TurnReason::CleanupFailed);
            outcome.cleaned = false;
            outcome.cancellation = cancellation;
            return outcome;
        }
        let wait = wait_deadline
            .saturating_duration_since(now)
            .min(Duration::from_millis(10));
        match events.recv_timeout(wait) {
            Ok(TurnWorkerEvent::Update(event)) => {
                if matches!(event, TurnRuntimeUpdate::Stopping(_)) {
                    stopping_published = true;
                }
                update(event);
            }
            Ok(TurnWorkerEvent::Outcome(mut outcome)) => {
                if outcome.state == TurnState::Cancelled && !stopping_published {
                    update(TurnRuntimeUpdate::Stopping(
                        outcome.reason.unwrap_or(TurnReason::InternalFailure),
                    ));
                }
                let retirement_deadline =
                    wait_deadline.min(Instant::now() + TURN_WORKER_RETIREMENT_BUDGET);
                if !retire_turn_worker(
                    active,
                    retained.take().expect("owned turn worker"),
                    retirement_deadline,
                ) {
                    outcome.state = TurnState::CleanupFailed;
                    outcome.reason = Some(TurnReason::CleanupFailed);
                    outcome.cleaned = false;
                }
                return outcome;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                retain_turn_worker(active, retained.take().expect("owned turn worker"));
                let mut outcome = TurnRuntimeOutcome::terminal(
                    TurnState::ContainmentFailed,
                    TurnReason::InternalFailure,
                );
                outcome.cleaned = false;
                outcome.cancellation = cancellation;
                return outcome;
            }
        }
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
    let mut verified = match runtime_effect(active, RuntimeEffectStage::Bind, || {
        bind_configuration(configuration, Some(selected_workspace.path()))
    }) {
        RuntimeEffectResult::Rejected(cancellation)
        | RuntimeEffectResult::Cancelled(_, cancellation) => {
            return cancellation_turn_outcome(cancellation, update);
        }
        RuntimeEffectResult::Completed(Ok(verified)) => verified,
        RuntimeEffectResult::Completed(Err(RuntimeReadinessState::Unavailable)) => {
            return TurnRuntimeOutcome::terminal(TurnState::Failed, TurnReason::RuntimeUnavailable);
        }
        RuntimeEffectResult::Completed(Err(RuntimeReadinessState::Incompatible)) => {
            return TurnRuntimeOutcome::terminal(
                TurnState::Failed,
                TurnReason::RuntimeIncompatible,
            );
        }
        RuntimeEffectResult::Completed(Err(_)) => {
            return TurnRuntimeOutcome::terminal(
                TurnState::ContainmentFailed,
                TurnReason::ProtocolRejected,
            );
        }
    };
    match runtime_effect(active, RuntimeEffectStage::Workspace, || {
        selected_workspace.remains_current()
    }) {
        RuntimeEffectResult::Rejected(cancellation)
        | RuntimeEffectResult::Cancelled(_, cancellation) => {
            return cancellation_turn_outcome(cancellation, update);
        }
        RuntimeEffectResult::Completed(false) => {
            return TurnRuntimeOutcome::terminal(TurnState::Failed, TurnReason::StaleWorkspace);
        }
        RuntimeEffectResult::Completed(true) => {}
    }
    let Some(owner) = process_identity(std::process::id() as i32) else {
        return TurnRuntimeOutcome::terminal(
            TurnState::ContainmentFailed,
            TurnReason::ProtocolRejected,
        );
    };
    let work_root = verified.work_root.clone();
    let (work_directory, created) =
        match runtime_effect(active, RuntimeEffectStage::Directory, || {
            let generation = work_generation.fetch_add(1, Ordering::AcqRel) + 1;
            let work_directory =
                work_root.join(runtime_work_directory_name("turn", owner, generation));
            let created = create_private_turn_directory(active, &work_directory, owner, generation);
            (work_directory, created)
        }) {
            RuntimeEffectResult::Completed(result) => result,
            RuntimeEffectResult::Rejected(cancellation) => {
                return cancellation_turn_outcome(cancellation, update);
            }
            RuntimeEffectResult::Cancelled((work_directory, created), cancellation) => {
                if created.is_ok() && !remove_directory_if_present(&work_directory) {
                    retain_work_directory(active, &work_directory);
                    let mut outcome = TurnRuntimeOutcome::terminal(
                        TurnState::CleanupFailed,
                        TurnReason::CleanupFailed,
                    );
                    outcome.cleaned = false;
                    return outcome;
                }
                return cancellation_turn_outcome(cancellation, update);
            }
        };
    if let Err(outcome) = created {
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
        let directory_deadline = active
            .cancellation_window()
            .map_or(deadline, |window| deadline.min(window.cleanup_cutoff));
        cleanup_or_track_work_directory_until(active, &work_directory, directory_deadline)
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

fn cancellation_turn_outcome(
    cancellation: RuntimeCancellation,
    update: &mut dyn FnMut(TurnRuntimeUpdate),
) -> TurnRuntimeOutcome {
    let state = cancellation.turn_state();
    let reason = cancellation.turn_reason();
    if state == TurnState::Cancelled {
        update(TurnRuntimeUpdate::Stopping(reason));
    }
    TurnRuntimeOutcome::terminal(state, reason)
}

fn settle_turn_readers(
    active: &ActiveRuntime,
    readers: impl IntoIterator<Item = RuntimeReader>,
    deadline: Instant,
    mut outcome: TurnRuntimeOutcome,
) -> TurnRuntimeOutcome {
    if !retire_runtime_readers(active, readers, reader_retirement_deadline(deadline)) {
        outcome.state = TurnState::CleanupFailed;
        outcome.reason = Some(TurnReason::CleanupFailed);
        outcome.cleaned = false;
    }
    outcome
}

fn settle_readiness_readers(
    active: &ActiveRuntime,
    readers: impl IntoIterator<Item = RuntimeReader>,
    deadline: Instant,
    mut outcome: ProtocolOutcome,
) -> ProtocolOutcome {
    if !retire_runtime_readers(active, readers, reader_retirement_deadline(deadline)) {
        outcome.state = RuntimeReadinessState::CleanupFailed;
        outcome.cleaned = false;
    }
    outcome
}

fn cleanup_or_retain_work_directory(active: &ActiveRuntime, path: &Path) -> bool {
    if remove_directory_if_present(path) {
        return true;
    }
    retain_work_directory(active, path);
    false
}

fn cleanup_or_track_work_directory_until(
    active: &ActiveRuntime,
    path: &Path,
    deadline: Instant,
) -> bool {
    cleanup_or_track_work_directory_until_at(active, path, deadline, Instant::now())
}

fn cleanup_or_track_work_directory_until_at(
    active: &ActiveRuntime,
    path: &Path,
    deadline: Instant,
    observed_at: Instant,
) -> bool {
    cleanup_or_track_work_directory_until_with(
        active,
        path,
        deadline,
        observed_at,
        |task| {
            thread::Builder::new()
                .name("keiko-turn-directory-cleanup".to_owned())
                .spawn(task)
        },
        || {},
    )
}

fn cleanup_or_track_work_directory_until_with<Spawn, AfterSpawn>(
    active: &ActiveRuntime,
    path: &Path,
    deadline: Instant,
    observed_at: Instant,
    spawn: Spawn,
    after_spawn: AfterSpawn,
) -> bool
where
    Spawn: FnOnce(Box<dyn FnOnce() + Send + 'static>) -> io::Result<thread::JoinHandle<()>>,
    AfterSpawn: FnOnce(),
{
    let path = path.to_path_buf();
    let (sender, completed) = mpsc::sync_channel(1);
    let worker_path = path.clone();
    let worker = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        spawn(Box::new(move || {
            let _ = sender.send(remove_directory_if_present(&worker_path));
        }))
    })) {
        Ok(Ok(worker)) => worker,
        Ok(Err(_)) | Err(_) => {
            retain_work_directory(active, &path);
            return false;
        }
    };
    after_spawn();
    let mut current_observed = observed_at;
    loop {
        let active_deadline = effective_cleanup_guard(active, Some(deadline)).unwrap_or(deadline);
        if current_observed >= active_deadline {
            retain_work_directory(active, &path);
            active
                .tracked_directory_cleanups
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(TrackedDirectoryCleanup {
                    path,
                    completed,
                    worker,
                });
            return false;
        }
        let wait = active_deadline
            .saturating_duration_since(current_observed)
            .min(Duration::from_millis(5));
        match completed.recv_timeout(wait) {
            Ok(cleaned) => {
                let joined = worker.join().is_ok();
                current_observed = current_observed.max(Instant::now());
                let completion_deadline =
                    effective_cleanup_guard(active, Some(deadline)).unwrap_or(deadline);
                if cleaned && joined && current_observed < completion_deadline {
                    return true;
                }
                retain_work_directory(active, &path);
                return false;
            }
            Err(RecvTimeoutError::Timeout) => {
                current_observed = current_observed.max(Instant::now());
            }
            Err(RecvTimeoutError::Disconnected) => {
                retain_work_directory(active, &path);
                active
                    .tracked_directory_cleanups
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(TrackedDirectoryCleanup {
                        path,
                        completed,
                        worker,
                    });
                return false;
            }
        }
    }
}

fn retain_work_directory(active: &ActiveRuntime, path: &Path) {
    let mut retained = active
        .retained_work_directories
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    retained.insert(path.to_path_buf());
}

fn reconcile_retained_work_directories(active: &ActiveRuntime) -> bool {
    let mut completed_paths = Vec::new();
    {
        let mut cleanups = active
            .tracked_directory_cleanups
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut pending = Vec::new();
        for cleanup in cleanups.drain(..) {
            match cleanup.completed.try_recv() {
                Ok(cleaned) => {
                    let joined = cleanup.worker.join().is_ok();
                    if cleaned && joined {
                        completed_paths.push(cleanup.path);
                    }
                }
                Err(mpsc::TryRecvError::Empty) => pending.push(cleanup),
                Err(mpsc::TryRecvError::Disconnected) => {
                    let _ = cleanup.worker.join();
                }
            }
        }
        *cleanups = pending;
        if !cleanups.is_empty() {
            return false;
        }
    }
    let retained_paths = {
        let mut retained = active
            .retained_work_directories
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for path in completed_paths {
            retained.remove(&path);
        }
        if retained.is_empty() {
            return true;
        }
        retained.iter().cloned().collect::<Vec<_>>()
    };
    let mut started = Vec::new();
    for path in retained_paths {
        let (sender, completed) = mpsc::sync_channel(1);
        let worker_path = path.clone();
        let spawned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            thread::Builder::new()
                .name("keiko-turn-directory-recovery".to_owned())
                .spawn(move || {
                    let _ = sender.send(remove_directory_if_present(&worker_path));
                })
        }));
        if let Ok(Ok(worker)) = spawned {
            started.push(TrackedDirectoryCleanup {
                path,
                completed,
                worker,
            });
        }
    }
    active
        .tracked_directory_cleanups
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .extend(started);
    false
}

fn remove_directory_if_present(path: &Path) -> bool {
    match fs::remove_dir_all(path) {
        Ok(()) => true,
        Err(error) => error.kind() == io::ErrorKind::NotFound,
    }
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
    let executable = match runtime_effect(active, RuntimeEffectStage::Stage, || {
        configuration.stage_verified_binary(work_directory)
    }) {
        RuntimeEffectResult::Rejected(cancellation) => {
            return cancellation_turn_outcome(cancellation, update);
        }
        RuntimeEffectResult::Cancelled(staged, cancellation) => {
            if let Ok(executable) = staged
                && fs::remove_file(executable.path()).is_err()
            {
                return TurnRuntimeOutcome::terminal(
                    TurnState::ContainmentFailed,
                    TurnReason::CleanupFailed,
                );
            }
            return cancellation_turn_outcome(cancellation, update);
        }
        RuntimeEffectResult::Completed(Ok(executable)) => executable,
        RuntimeEffectResult::Completed(Err(
            RuntimeReadinessState::Unavailable | RuntimeReadinessState::Incompatible,
        )) => {
            return TurnRuntimeOutcome::terminal(
                TurnState::ContainmentFailed,
                TurnReason::RuntimeIncompatible,
            );
        }
        RuntimeEffectResult::Completed(Err(_)) => {
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
    let mut child = match runtime_effect(active, RuntimeEffectStage::Spawn, || {
        spawn_verified_runtime(&mut command, work_directory)
    }) {
        RuntimeEffectResult::Rejected(cancellation) => {
            return cancellation_turn_outcome(cancellation, update);
        }
        RuntimeEffectResult::Cancelled(spawned, cancellation) => {
            let outcome = cancellation_turn_outcome(cancellation, update);
            if let Ok(child) = spawned
                && !rollback_spawned_before_publication(child, active, deadline)
            {
                return cleanup_failed_turn_outcome();
            }
            return outcome;
        }
        RuntimeEffectResult::Completed(Ok(child)) => child,
        RuntimeEffectResult::Completed(Err(error)) => {
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
    let published = match runtime_effect(active, RuntimeEffectStage::Publish, || {
        let published = publish_active_process_group(active, process_group);
        if published {
            register_owned_process(active, process_group);
        }
        published
    }) {
        RuntimeEffectResult::Completed(published) => published,
        RuntimeEffectResult::Rejected(cancellation) => {
            let outcome = cancellation_turn_outcome(cancellation, update);
            return if rollback_spawned_before_publication(child, active, deadline) {
                outcome
            } else {
                cleanup_failed_turn_outcome()
            };
        }
        RuntimeEffectResult::Cancelled(published, cancellation) => {
            if published {
                return cleanup_turn(
                    child,
                    process_group,
                    cancellation_turn_outcome(cancellation, update),
                    active,
                    deadline,
                );
            }
            let outcome = cancellation_turn_outcome(cancellation, update);
            return if rollback_spawned_before_publication(child, active, deadline) {
                outcome
            } else {
                cleanup_failed_turn_outcome()
            };
        }
    };
    if !published {
        return if rollback_spawned_before_publication(child, active, deadline) {
            TurnRuntimeOutcome::terminal(TurnState::ContainmentFailed, TurnReason::ProtocolRejected)
        } else {
            cleanup_failed_turn_outcome()
        };
    }
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
    let reader_threads = match runtime_effect(active, RuntimeEffectStage::Readers, || {
        spawn_runtime_readers(
            active,
            stdout,
            stderr,
            sender,
            Arc::clone(&queued_bytes),
            Arc::clone(&stderr_saturated),
        )
    }) {
        RuntimeEffectResult::Completed(Ok(readers)) => readers,
        RuntimeEffectResult::Completed(Err(partial)) => {
            drop(receiver);
            let outcome = cleanup_turn(
                child,
                process_group,
                TurnRuntimeOutcome::terminal(
                    TurnState::ContainmentFailed,
                    TurnReason::InternalFailure,
                ),
                active,
                deadline,
            );
            if let Some(reader) = partial {
                return settle_turn_readers(active, [reader], deadline, outcome);
            }
            return outcome;
        }
        RuntimeEffectResult::Rejected(cancellation) => {
            drop(receiver);
            return cleanup_turn(
                child,
                process_group,
                cancellation_turn_outcome(cancellation, update),
                active,
                deadline,
            );
        }
        RuntimeEffectResult::Cancelled(readers, cancellation) => {
            drop(receiver);
            let outcome = cleanup_turn(
                child,
                process_group,
                cancellation_turn_outcome(cancellation, update),
                active,
                deadline,
            );
            match readers {
                Ok((stdout, stderr)) => {
                    return settle_turn_readers(active, [stdout, stderr], deadline, outcome);
                }
                Err(Some(stdout)) => {
                    return settle_turn_readers(active, [stdout], deadline, outcome);
                }
                Err(None) => return outcome,
            }
        }
    };
    let mut boundary_audit = RuntimeBoundaryAudit::new(selected_workspace.path());
    let initialize = runtime_effect(active, RuntimeEffectStage::InitializeWrite, || {
        boundary_audit.write_json_line(
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
    });
    if !matches!(initialize, RuntimeEffectResult::Completed(Ok(()))) {
        let outcome = match initialize {
            RuntimeEffectResult::Rejected(cancellation)
            | RuntimeEffectResult::Cancelled(_, cancellation) => {
                cancellation_turn_outcome(cancellation, update)
            }
            RuntimeEffectResult::Completed(Err(_)) => TurnRuntimeOutcome::terminal(
                TurnState::ContainmentFailed,
                TurnReason::ProtocolRejected,
            ),
            RuntimeEffectResult::Completed(Ok(())) => unreachable!(),
        };
        let outcome = cleanup_turn(child, process_group, outcome, active, deadline);
        return settle_turn_readers(
            active,
            [reader_threads.0, reader_threads.1],
            deadline,
            outcome,
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
                let action = match accept_turn_frame(active, &mut projection, &frame) {
                    Ok(action) => action,
                    Err(cancellation) => {
                        let state = cancellation.turn_state();
                        let reason = cancellation.turn_reason();
                        if state == TurnState::Cancelled {
                            update(TurnRuntimeUpdate::Stopping(reason));
                        }
                        break (state, reason);
                    }
                };
                let mut action_guard = match lock_projection_action(active) {
                    Ok(guard) => guard,
                    Err(cancellation) => {
                        let state = cancellation.turn_state();
                        let reason = cancellation.turn_reason();
                        if state == TurnState::Cancelled {
                            update(TurnRuntimeUpdate::Stopping(reason));
                        }
                        break (state, reason);
                    }
                };
                match action {
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
                active.materialize_deferred_cancellation(&mut action_guard);
                if let Some(cancellation) = action_guard.cancellation {
                    let state = cancellation.reason.turn_state();
                    let reason = cancellation.reason.turn_reason();
                    drop(action_guard);
                    if state == TurnState::Cancelled {
                        update(TurnRuntimeUpdate::Stopping(reason));
                    }
                    break (state, reason);
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
        cancellation: active.cancellation_window(),
    };
    if outcome.state == TurnState::Completed && outcome.agent_text.is_empty() {
        outcome.state = TurnState::ContainmentFailed;
        outcome.reason = Some(TurnReason::ProtocolRejected);
    }
    let outcome = cleanup_turn(child, process_group, outcome, active, deadline);
    settle_turn_readers(
        active,
        [reader_threads.0, reader_threads.1],
        deadline,
        outcome,
    )
}

fn accept_turn_frame(
    active: &ActiveRuntime,
    projection: &mut TurnProtocolProjection,
    frame: &[u8],
) -> Result<TurnProjectionAction, RuntimeCancellation> {
    accept_turn_frame_with(active, projection, frame, || {})
}

fn accept_turn_frame_with(
    active: &ActiveRuntime,
    projection: &mut TurnProtocolProjection,
    frame: &[u8],
    before_mutation: impl FnOnce(),
) -> Result<TurnProjectionAction, RuntimeCancellation> {
    before_mutation();
    let control = active
        .control
        .lock()
        .map_err(|_| RuntimeCancellation::ContainmentFailure)?;
    match control.cancellation {
        Some(cancellation) => Err(cancellation.reason),
        None => Ok(projection.accept(frame)),
    }
}

fn lock_projection_action(
    active: &ActiveRuntime,
) -> Result<std::sync::MutexGuard<'_, RuntimeControl>, RuntimeCancellation> {
    lock_projection_action_with(active, || {})
}

fn lock_projection_action_with(
    active: &ActiveRuntime,
    after_revalidation: impl FnOnce(),
) -> Result<std::sync::MutexGuard<'_, RuntimeControl>, RuntimeCancellation> {
    match active.control.lock() {
        Ok(mut guard) => {
            active.materialize_deferred_cancellation(&mut guard);
            match guard.cancellation {
                None => {
                    after_revalidation();
                    active.materialize_deferred_cancellation(&mut guard);
                    match guard.cancellation {
                        None => Ok(guard),
                        Some(cancellation) => Err(cancellation.reason),
                    }
                }
                Some(cancellation) => Err(cancellation.reason),
            }
        }
        Err(_) => Err(RuntimeCancellation::ContainmentFailure),
    }
}

fn runtime_effect<T>(
    active: &ActiveRuntime,
    stage: RuntimeEffectStage,
    effect: impl FnOnce() -> T,
) -> RuntimeEffectResult<T> {
    if stage == RuntimeEffectStage::InitializeWrite {
        return linearized_initialize_effect(active, effect);
    }
    let effect_permit = match authorize_runtime_effect(active) {
        Ok(effect_permit) => effect_permit,
        Err(cancellation) => return RuntimeEffectResult::Rejected(cancellation),
    };
    active.enter_runtime_effect(stage);
    let result = effect();
    match revalidate_runtime_effect(active, &effect_permit) {
        Ok(()) => RuntimeEffectResult::Completed(result),
        Err(cancellation) => RuntimeEffectResult::Cancelled(result, cancellation),
    }
}

fn linearized_initialize_effect<T>(
    active: &ActiveRuntime,
    effect: impl FnOnce() -> T,
) -> RuntimeEffectResult<T> {
    active.enter_runtime_effect(RuntimeEffectStage::InitializeWrite);
    let mut control = match active.control.lock() {
        Ok(control) => control,
        Err(_) => {
            return RuntimeEffectResult::Rejected(RuntimeCancellation::ContainmentFailure);
        }
    };
    active.materialize_deferred_cancellation(&mut control);
    if let Some(cancellation) = control.cancellation {
        return RuntimeEffectResult::Rejected(cancellation.reason);
    }
    if control.request_id.is_none() || control.effect_generation == 0 {
        return RuntimeEffectResult::Rejected(RuntimeCancellation::ContainmentFailure);
    }
    RuntimeEffectResult::Completed(effect())
}

fn authorize_runtime_effect(
    active: &ActiveRuntime,
) -> Result<RuntimeEffectPermit, RuntimeCancellation> {
    let mut control = active
        .control
        .lock()
        .map_err(|_| RuntimeCancellation::ContainmentFailure)?;
    active.materialize_deferred_cancellation(&mut control);
    if let Some(cancellation) = control.cancellation {
        return Err(cancellation.reason);
    }
    let Some(request_id) = control.request_id.clone() else {
        return Err(RuntimeCancellation::ContainmentFailure);
    };
    if control.effect_generation == 0 {
        return Err(RuntimeCancellation::ContainmentFailure);
    }
    Ok(RuntimeEffectPermit {
        request_id,
        generation: control.effect_generation,
    })
}

fn revalidate_runtime_effect(
    active: &ActiveRuntime,
    effect_permit: &RuntimeEffectPermit,
) -> Result<(), RuntimeCancellation> {
    let mut control = active
        .control
        .lock()
        .map_err(|_| RuntimeCancellation::ContainmentFailure)?;
    active.materialize_deferred_cancellation(&mut control);
    if control.request_id.as_deref() != Some(&effect_permit.request_id)
        || control.effect_generation != effect_permit.generation
    {
        return Err(RuntimeCancellation::ContainmentFailure);
    }
    match control.cancellation {
        Some(cancellation) => Err(cancellation.reason),
        None => Ok(()),
    }
}

fn cleanup_turn(
    mut child: Child,
    process_group: i32,
    mut outcome: TurnRuntimeOutcome,
    active: &ActiveRuntime,
    deadline: Instant,
) -> TurnRuntimeOutcome {
    let cleanup_started = Instant::now();
    let cleanup_deadline = active.cancellation_window().map_or_else(
        || turn_cleanup_deadline(cleanup_started, deadline),
        |window| {
            if active
                .closed_control_failure_cleanup
                .load(Ordering::Acquire)
            {
                turn_cleanup_deadline(cleanup_started, deadline)
            } else {
                deadline.min(window.cleanup_cutoff)
            }
        },
    );
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

fn rollback_spawned_before_publication(
    mut child: Child,
    active: &ActiveRuntime,
    deadline: Instant,
) -> bool {
    let process_group = child.id() as i32;
    if publish_active_process_group(active, process_group) {
        register_owned_process(active, process_group);
        #[cfg(test)]
        match active.spawn_rollback_failure.swap(0, Ordering::AcqRel) {
            1 => return false,
            2 => {
                signal_active_process_group(active, process_group, SIGKILL);
                return false;
            }
            _ => {}
        }
        return stop_process_group_with_term_grace(
            &mut child,
            process_group,
            active,
            deadline,
            Some(CANCEL_TERM_GRACE),
            CleanupPhasePolicy::AllowParentReap,
        );
    }
    let killed = child.kill().is_ok();
    let reaped = child.wait().is_ok();
    if !(killed && reaped) {
        active
            .retained_unpublished_children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(child);
    }
    killed && reaped
}

fn turn_cleanup_deadline(cleanup_started: Instant, request_deadline: Instant) -> Instant {
    request_deadline.min(
        cleanup_started
            .checked_add(TURN_CLEANUP_RESERVE)
            .unwrap_or(cleanup_started),
    )
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
    #[cfg(test)]
    active.record_readiness_deadline(ReadinessDeadlineObservation {
        stage: ReadinessDeadlineStage::RunProtocol,
        started_at: None,
        timeout: None,
        deadline,
    });
    let executable = match runtime_effect(active, RuntimeEffectStage::Stage, || {
        configuration.stage_verified_binary(work_directory)
    }) {
        RuntimeEffectResult::Rejected(cancellation) => {
            return ProtocolOutcome {
                state: cancellation.readiness_state(),
                quarantined_events: 0,
                cleaned: true,
            };
        }
        RuntimeEffectResult::Cancelled(staged, cancellation) => {
            let cleaned = match staged {
                Ok(executable) => fs::remove_file(executable.path()).is_ok(),
                Err(_) => true,
            };
            return ProtocolOutcome {
                state: if cleaned {
                    cancellation.readiness_state()
                } else {
                    RuntimeReadinessState::CleanupFailed
                },
                quarantined_events: 0,
                cleaned,
            };
        }
        RuntimeEffectResult::Completed(Ok(executable)) => executable,
        RuntimeEffectResult::Completed(Err(state)) => {
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
    let mut child = match runtime_effect(active, RuntimeEffectStage::Spawn, || {
        spawn_verified_runtime(&mut command, work_directory)
    }) {
        RuntimeEffectResult::Rejected(cancellation) => {
            return ProtocolOutcome {
                state: cancellation.readiness_state(),
                quarantined_events: 0,
                cleaned: true,
            };
        }
        RuntimeEffectResult::Cancelled(spawned, cancellation) => {
            let cleaned = spawned
                .map(|child| rollback_spawned_before_publication(child, active, deadline))
                .unwrap_or(true);
            return ProtocolOutcome {
                state: if cleaned {
                    cancellation.readiness_state()
                } else {
                    RuntimeReadinessState::CleanupFailed
                },
                quarantined_events: 0,
                cleaned,
            };
        }
        RuntimeEffectResult::Completed(Ok(child)) => child,
        RuntimeEffectResult::Completed(Err(error)) => {
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
    let published = match runtime_effect(active, RuntimeEffectStage::Publish, || {
        let published = publish_active_process_group(active, process_group);
        if published {
            register_owned_process(active, process_group);
        }
        published
    }) {
        RuntimeEffectResult::Completed(published) => published,
        RuntimeEffectResult::Rejected(cancellation) => {
            let cleaned = rollback_spawned_before_publication(child, active, deadline);
            return ProtocolOutcome {
                state: if cleaned {
                    cancellation.readiness_state()
                } else {
                    RuntimeReadinessState::CleanupFailed
                },
                quarantined_events: 0,
                cleaned,
            };
        }
        RuntimeEffectResult::Cancelled(published, cancellation) => {
            if published {
                return cleanup_after(
                    child,
                    process_group,
                    cancellation.readiness_state(),
                    0,
                    active,
                    deadline,
                );
            }
            let cleaned = rollback_spawned_before_publication(child, active, deadline);
            return ProtocolOutcome {
                state: if cleaned {
                    cancellation.readiness_state()
                } else {
                    RuntimeReadinessState::CleanupFailed
                },
                quarantined_events: 0,
                cleaned,
            };
        }
    };
    if !published {
        let cleaned = rollback_spawned_before_publication(child, active, deadline);
        return ProtocolOutcome {
            state: if cleaned {
                RuntimeReadinessState::ContainmentFailed
            } else {
                RuntimeReadinessState::CleanupFailed
            },
            quarantined_events: 0,
            cleaned,
        };
    }
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
    let reader_threads = match runtime_effect(active, RuntimeEffectStage::Readers, || {
        spawn_runtime_readers(
            active,
            stdout,
            stderr,
            sender,
            Arc::clone(&queued_bytes),
            Arc::clone(&stderr_saturated),
        )
    }) {
        RuntimeEffectResult::Completed(Ok(readers)) => readers,
        RuntimeEffectResult::Completed(Err(partial)) => {
            drop(receiver);
            let outcome = cleanup_after(
                child,
                process_group,
                RuntimeReadinessState::ContainmentFailed,
                0,
                active,
                deadline,
            );
            if let Some(reader) = partial {
                return settle_readiness_readers(active, [reader], deadline, outcome);
            }
            return outcome;
        }
        RuntimeEffectResult::Rejected(cancellation) => {
            drop(receiver);
            return cleanup_after(
                child,
                process_group,
                cancellation.readiness_state(),
                0,
                active,
                deadline,
            );
        }
        RuntimeEffectResult::Cancelled(readers, cancellation) => {
            drop(receiver);
            let outcome = cleanup_after(
                child,
                process_group,
                cancellation.readiness_state(),
                0,
                active,
                deadline,
            );
            return match readers {
                Ok((stdout, stderr)) => {
                    settle_readiness_readers(active, [stdout, stderr], deadline, outcome)
                }
                Err(Some(stdout)) => settle_readiness_readers(active, [stdout], deadline, outcome),
                Err(None) => outcome,
            };
        }
    };
    let initialize = runtime_effect(active, RuntimeEffectStage::InitializeWrite, || {
        write_json_line(
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
    });
    if !matches!(initialize, RuntimeEffectResult::Completed(Ok(()))) {
        let state = match initialize {
            RuntimeEffectResult::Rejected(cancellation)
            | RuntimeEffectResult::Cancelled(_, cancellation) => cancellation.readiness_state(),
            RuntimeEffectResult::Completed(Err(_)) => RuntimeReadinessState::Incompatible,
            RuntimeEffectResult::Completed(Ok(())) => unreachable!(),
        };
        let outcome = cleanup_after(child, process_group, state, 0, active, deadline);
        return settle_readiness_readers(
            active,
            [reader_threads.0, reader_threads.1],
            deadline,
            outcome,
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
    let outcome = cleanup_after(
        child,
        process_group,
        state,
        projection.quarantined_events,
        active,
        deadline,
    );
    settle_readiness_readers(
        active,
        [reader_threads.0, reader_threads.1],
        deadline,
        outcome,
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

type ReaderTask = Box<dyn FnOnce() + Send + 'static>;

fn spawn_runtime_readers_with(
    stdout: impl Read + Send + 'static,
    stderr: impl Read + Send + 'static,
    sender: SyncSender<FrameEvent>,
    queued_bytes: Arc<AtomicUsize>,
    stderr_saturated: Arc<AtomicBool>,
    spawn: &mut dyn FnMut(&str, ReaderTask) -> io::Result<thread::JoinHandle<()>>,
) -> Result<(RuntimeReader, RuntimeReader), Option<RuntimeReader>> {
    let stdout = spawn_stdout_reader_with(stdout, sender, queued_bytes, spawn).map_err(|_| None)?;
    match spawn_stderr_reader_with(stderr, stderr_saturated, spawn) {
        Ok(stderr) => Ok((stdout, stderr)),
        Err(_) => Err(Some(stdout)),
    }
}

fn spawn_runtime_readers(
    active: &ActiveRuntime,
    stdout: impl Read + Send + 'static,
    stderr: impl Read + Send + 'static,
    sender: SyncSender<FrameEvent>,
    queued_bytes: Arc<AtomicUsize>,
    stderr_saturated: Arc<AtomicBool>,
) -> Result<(RuntimeReader, RuntimeReader), Option<RuntimeReader>> {
    #[cfg(not(test))]
    let _ = active;
    spawn_runtime_readers_with(
        stdout,
        stderr,
        sender,
        queued_bytes,
        stderr_saturated,
        &mut |name, task| {
            #[cfg(test)]
            {
                let attempt = active.reader_spawn_attempt.fetch_add(1, Ordering::AcqRel) + 1;
                if active.reader_spawn_failure.load(Ordering::Acquire) == attempt {
                    return Err(io::Error::other("injected reader spawn failure"));
                }
            }
            #[cfg(test)]
            let hook = active
                .reader_retirement_hook
                .lock()
                .expect("reader retirement hook")
                .clone()
                .filter(|hook| hook.thread_name == name);
            #[cfg(test)]
            let task = match hook {
                Some(hook) => Box::new(move || {
                    task();
                    let _ = hook.body_completed.send(());
                    let (released, wake) = &*hook.release;
                    let released = released.lock().expect("reader retirement release");
                    let _ = wake
                        .wait_timeout_while(released, Duration::from_secs(10), |released| {
                            !*released
                        })
                        .expect("reader retirement wait");
                }) as ReaderTask,
                None => task,
            };
            thread::Builder::new().name(name.to_owned()).spawn(task)
        },
    )
}

#[cfg(test)]
fn spawn_stdout_reader(
    stdout: impl Read + Send + 'static,
    sender: SyncSender<FrameEvent>,
    queued_bytes: Arc<AtomicUsize>,
) -> io::Result<RuntimeReader> {
    spawn_stdout_reader_with(stdout, sender, queued_bytes, &mut |name, task| {
        thread::Builder::new().name(name.to_owned()).spawn(task)
    })
}

fn spawn_stdout_reader_with(
    stdout: impl Read + Send + 'static,
    sender: SyncSender<FrameEvent>,
    queued_bytes: Arc<AtomicUsize>,
    spawn: &mut dyn FnMut(&str, ReaderTask) -> io::Result<thread::JoinHandle<()>>,
) -> io::Result<RuntimeReader> {
    spawn_owned_reader(
        "keiko-runtime-stdout",
        Box::new(move || {
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
        }),
        spawn,
    )
}

fn spawn_owned_reader(
    name: &str,
    task: ReaderTask,
    spawn: &mut dyn FnMut(&str, ReaderTask) -> io::Result<thread::JoinHandle<()>>,
) -> io::Result<RuntimeReader> {
    let (completed, completion) = mpsc::sync_channel(1);
    let worker = spawn(
        name,
        Box::new(move || {
            task();
            let _ = completed.send(());
        }),
    )?;
    Ok(RuntimeReader {
        completed: completion,
        worker,
    })
}

fn retire_runtime_readers(
    active: &ActiveRuntime,
    readers: impl IntoIterator<Item = RuntimeReader>,
    deadline: Instant,
) -> bool {
    #[cfg(test)]
    if let Some(observer) = active
        .reader_retirement_observer
        .lock()
        .expect("reader retirement observer")
        .take()
    {
        let _ = observer.send(());
    }
    let mut retained = Vec::new();
    let mut clean = true;
    for reader in readers {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match reader.completed.recv_timeout(remaining) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => {
                while !reader.worker.is_finished() && Instant::now() < deadline {
                    thread::yield_now();
                }
                if reader.worker.is_finished() {
                    clean &= reader.worker.join().is_ok();
                } else {
                    retained.push(reader);
                    clean = false;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                retained.push(reader);
                clean = false;
            }
        }
    }
    if !retained.is_empty() {
        active
            .retained_readers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .extend(retained);
    }
    clean
}

fn reconcile_retained_readers_locked(
    active: &ActiveRuntime,
    retained: &mut Vec<RuntimeReader>,
) -> bool {
    let readers = std::mem::take(retained);
    active.enter_reader_reconciliation();
    let mut pending = Vec::new();
    let mut clean = true;
    for reader in readers {
        match reader.completed.try_recv() {
            Ok(()) | Err(mpsc::TryRecvError::Disconnected) => {
                if reader.worker.is_finished() {
                    clean &= reader.worker.join().is_ok();
                } else {
                    pending.push(reader);
                }
            }
            Err(mpsc::TryRecvError::Empty) => pending.push(reader),
        }
    }
    if !pending.is_empty() {
        retained.extend(pending);
        return false;
    }
    clean
}

fn reader_retirement_deadline(deadline: Instant) -> Instant {
    deadline.min(Instant::now() + READER_RETIREMENT_BUDGET)
}

fn retire_turn_worker(
    active: &ActiveRuntime,
    mut retained: RetainedTurnWorker,
    deadline: Instant,
) -> bool {
    let remaining = deadline.saturating_duration_since(Instant::now());
    match retained.completed.recv_timeout(remaining) {
        Ok(cleanup_proven) => {
            retained.cleanup_proven = Some(cleanup_proven);
        }
        Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {}
    }
    if retained.cleanup_proven == Some(true) {
        while !retained.worker.is_finished() && Instant::now() < deadline {
            thread::yield_now();
        }
        if retained.worker.is_finished() {
            return retained.worker.join().is_ok();
        }
    }
    retain_turn_worker(active, retained);
    false
}

fn retain_turn_worker(active: &ActiveRuntime, retained: RetainedTurnWorker) {
    active
        .retained_turn_workers
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(retained);
}

fn reconcile_retained_turn_workers_locked(retained: &mut Vec<RetainedTurnWorker>) -> bool {
    let workers = std::mem::take(retained);
    let mut pending = Vec::new();
    let mut clean = true;
    for mut worker in workers {
        if worker.cleanup_proven.is_none()
            && let Ok(cleanup_proven) = worker.completed.try_recv()
        {
            worker.cleanup_proven = Some(cleanup_proven);
        }
        if worker.cleanup_proven.is_some() && worker.worker.is_finished() {
            clean &= worker.cleanup_proven == Some(true) && worker.worker.join().is_ok();
        } else {
            pending.push(worker);
        }
    }
    if !pending.is_empty() {
        retained.extend(pending);
        return false;
    }
    clean
}

fn retire_publication_worker(
    active: &ActiveRuntime,
    retained: RetainedPublicationWorker,
    deadline: Instant,
) -> bool {
    while !retained.worker.is_finished() && Instant::now() < deadline {
        thread::yield_now();
    }
    if retained.worker.is_finished() {
        return retained.worker.join().is_ok();
    }
    retain_publication_worker(active, retained);
    false
}

fn retain_publication_worker(active: &ActiveRuntime, retained: RetainedPublicationWorker) {
    active
        .retained_publication_workers
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(retained);
}

fn reconcile_retained_publication_workers_locked(
    retained: &mut Vec<RetainedPublicationWorker>,
) -> bool {
    let workers = std::mem::take(retained);
    let mut pending = Vec::new();
    let mut clean = true;
    for worker in workers {
        if worker.worker.is_finished() {
            let _ = worker.result.try_recv();
            clean &= worker.worker.join().is_ok();
        } else {
            pending.push(worker);
        }
    }
    if !pending.is_empty() {
        retained.extend(pending);
        return false;
    }
    clean
}

fn reconcile_retained_runtime_ownership(active: &ActiveRuntime) -> bool {
    let mut readers = active
        .retained_readers
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !reconcile_retained_readers_locked(active, &mut readers) {
        return false;
    }
    let mut turn_workers = active
        .retained_turn_workers
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !reconcile_retained_turn_workers_locked(&mut turn_workers) {
        return false;
    }
    let mut publication_workers = active
        .retained_publication_workers
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let reconciled = reconcile_retained_publication_workers_locked(&mut publication_workers);
    if reconciled {
        active.apply_deferred_publication_failures();
    }
    reconciled
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

#[cfg(test)]
fn spawn_stderr_reader(
    stderr: impl Read + Send + 'static,
    saturated: Arc<AtomicBool>,
) -> io::Result<RuntimeReader> {
    spawn_stderr_reader_with(stderr, saturated, &mut |name, task| {
        thread::Builder::new().name(name.to_owned()).spawn(task)
    })
}

fn spawn_stderr_reader_with(
    stderr: impl Read + Send + 'static,
    saturated: Arc<AtomicBool>,
    spawn: &mut dyn FnMut(&str, ReaderTask) -> io::Result<thread::JoinHandle<()>>,
) -> io::Result<RuntimeReader> {
    spawn_owned_reader(
        "keiko-runtime-stderr",
        Box::new(move || {
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
        }),
        spawn,
    )
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
    #[cfg(test)]
    active.record_readiness_deadline(ReadinessDeadlineObservation {
        stage: ReadinessDeadlineStage::CleanupAfter,
        started_at: None,
        timeout: None,
        deadline,
    });
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
        let effective_guard = effective_cleanup_guard(self.active, command.guard());
        if effective_guard.is_some_and(|deadline| started_at >= deadline) {
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
                let duration = effective_guard.map_or(duration, |deadline| {
                    duration.min(deadline.saturating_duration_since(started_at))
                });
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

fn effective_cleanup_guard(active: &ActiveRuntime, guard: Option<Instant>) -> Option<Instant> {
    match (guard, active.cancellation_window()) {
        (Some(guard), Some(window)) => Some(guard.min(window.cleanup_cutoff)),
        (None, Some(window)) => Some(window.cleanup_cutoff),
        (guard, None) => guard,
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

fn reconcile_retained_unpublished_children(active: &ActiveRuntime, deadline: Instant) -> bool {
    let children = {
        let mut retained = active
            .retained_unpublished_children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        std::mem::take(&mut *retained)
    };
    let mut cleaned = true;
    for child in children {
        cleaned &= rollback_spawned_before_publication(child, active, deadline);
    }
    cleaned
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
    use keiko_application::runtime::RuntimeDescriptor;
    use keiko_application::turn::TurnSession;
    use keiko_ui_port::canonical_request_id;
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
        authority: AuthenticatedDirectChild,
        child: &mut Child,
        process_group: i32,
        active: &ActiveRuntime,
    ) -> bool {
        let outcome = finalize_exact_child_after_eof(authority);
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

    struct OwnedFixtureChild(Child);

    impl Drop for OwnedFixtureChild {
        fn drop(&mut self) {
            drop(self.0.stdin.take());
            let _ = self.0.kill();
            let _ = bounded_owned_child_exit(&mut self.0);
        }
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
        let _stdout = spawn_stdout_reader(
            Cursor::new(b"{}\n".to_vec()),
            sender,
            Arc::clone(&queued_bytes),
        )
        .expect("stdout reader");
        assert!(matches!(
            receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("rejection"),
            FrameEvent::Rejected
        ));
        assert_eq!(queued_bytes.load(Ordering::Acquire), MAX_QUEUE_BYTES);

        let (sender, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let _stdout = spawn_stdout_reader(
            Cursor::new(b"{}\n".to_vec()),
            sender,
            Arc::new(AtomicUsize::new(0)),
        )
        .expect("stdout reader");

        let saturated = Arc::new(AtomicBool::new(false));
        let _stderr = spawn_stderr_reader(
            Cursor::new(vec![b'x'; MAX_STDERR_BYTES + 1]),
            Arc::clone(&saturated),
        )
        .expect("stderr reader");
        let deadline = Instant::now() + Duration::from_secs(1);
        while !saturated.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(saturated.load(Ordering::Acquire));
    }

    #[test]
    fn reader_thread_creation_is_fallible_for_first_and_partial_spawn() {
        for failed_spawn in [1, 2] {
            let (sender, receiver) = mpsc::sync_channel(1);
            let mut attempts = 0;
            let started = spawn_runtime_readers_with(
                Cursor::new(Vec::<u8>::new()),
                Cursor::new(Vec::<u8>::new()),
                sender,
                Arc::new(AtomicUsize::new(0)),
                Arc::new(AtomicBool::new(false)),
                &mut |name, task| {
                    attempts += 1;
                    if attempts == failed_spawn {
                        Err(io::Error::other("injected reader spawn failure"))
                    } else {
                        thread::Builder::new().name(name.to_owned()).spawn(task)
                    }
                },
            );
            let mut partial = started.expect_err("reader spawn must be fallible");
            drop(receiver);
            if let Some(handle) = partial.take() {
                assert!(retire_runtime_readers(
                    &ActiveRuntime::default(),
                    [handle],
                    Instant::now() + Duration::from_secs(1),
                ));
            }
            assert_eq!(attempts, failed_spawn);
        }
    }

    #[test]
    fn reader_spawn_failure_after_child_creation_leaves_no_process_or_directory_residue() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for failed_spawn in [1, 2] {
            let fixture = Fixture::new();
            let repository = fixture.root.join("repository");
            fs::create_dir(&repository).expect("repository");
            fs::create_dir(repository.join(".git")).expect("repository marker");
            let host = fixture.scripted_host("#!/bin/sh\nwhile :; do /bin/sleep 1; done\n");
            host.fail_reader_spawn_for_test(failed_spawn);

            let outcome = host.run_turn(
                &format!("request-reader-{failed_spawn}"),
                1,
                &WorkspaceRuntimeBinding::for_test(&repository),
                "Bounded task.",
                Duration::from_secs(5),
                |_| {},
            );

            assert_eq!(outcome.state, TurnState::ContainmentFailed);
            assert!(outcome.cleaned);
            assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
            assert_eq!(
                *host.active.process_group.lock().expect("process group"),
                None
            );
            assert!(
                host.active
                    .owned_processes
                    .lock()
                    .expect("owned processes")
                    .is_empty()
            );
        }
    }

    #[test]
    fn retained_reader_reconciliation_is_atomic_with_two_fresh_claims() {
        let active = Arc::new(ActiveRuntime::default());
        let worker_release = Arc::new((Mutex::new(false), Condvar::new()));
        let released = Arc::clone(&worker_release);
        let (completed_sender, completed) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let (released, wake) = &*released;
            let released = released.lock().expect("reader worker release");
            let _ = wake
                .wait_timeout_while(released, Duration::from_secs(2), |released| !*released)
                .expect("reader worker wait");
            let _ = completed_sender.send(());
        });
        active
            .retained_readers
            .lock()
            .expect("retained readers")
            .push(RuntimeReader { completed, worker });
        let (reconciliation_entered, reconciliation_release) =
            active.install_reader_reconciliation_hook();
        let first_active = Arc::clone(&active);
        let first = thread::spawn(move || first_active.claim_request("first-claim"));
        reconciliation_entered
            .recv_timeout(Duration::from_secs(1))
            .expect("first reconciliation entered");
        let second_active = Arc::clone(&active);
        let second = thread::spawn(move || second_active.claim_request("second-claim"));
        {
            let (released, wake) = &*reconciliation_release;
            *released.lock().expect("reconciliation release") = true;
            wake.notify_all();
        }
        assert!(!first.join().expect("first claim"));
        assert!(
            !second.join().expect("second claim"),
            "a second claim must not pass while the first reconciliation owns a pending reader"
        );
        {
            let (released, wake) = &*worker_release;
            *released.lock().expect("worker release") = true;
            wake.notify_all();
        }
        let recovery_deadline = Instant::now() + Duration::from_secs(1);
        let recovered = loop {
            if active.claim_request("recovered-claim") {
                break true;
            }
            if Instant::now() >= recovery_deadline {
                break false;
            }
            thread::yield_now();
        };
        assert!(recovered, "completed reader must permit a fresh claim");
        active.finish_request();
    }

    #[test]
    fn unfinished_turn_reader_blocks_fresh_recovery_until_bounded_retirement() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository");
        fs::create_dir(repository.join(".git")).expect("repository marker");
        let codex_home = r#"'"$CODEX_HOME"'"#;
        let script = format!(
            r#"#!/bin/sh
set -eu
work=$(/bin/pwd -P)
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
printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"thread-1","turn":{{"id":"turn-1","status":"completed","error":null}}}}}}'
"#,
        );
        let host = fixture.scripted_host(&script);
        let (reader_body_completed, retirement_started, release_reader) = host
            .active
            .install_reader_retirement_hook("keiko-runtime-stdout");
        let running_host = host.clone();
        let running_repository = repository.clone();
        let pending = thread::spawn(move || {
            running_host.run_turn(
                "request-reader-retirement",
                1,
                &WorkspaceRuntimeBinding::for_test(&running_repository),
                "Bounded task.",
                Duration::from_secs(1),
                |_| {},
            )
        });
        reader_body_completed
            .recv_timeout(Duration::from_secs(1))
            .expect("reader body completed before retirement");
        retirement_started
            .recv_timeout(Duration::from_secs(2))
            .expect("bounded reader retirement started");
        let completion_deadline = Instant::now() + Duration::from_millis(500);
        while !pending.is_finished() && Instant::now() < completion_deadline {
            thread::yield_now();
        }
        let retirement_was_bounded = pending.is_finished();
        let fresh_was_blocked =
            retirement_was_bounded && !host.active.claim_request("request-fresh");
        if retirement_was_bounded && !fresh_was_blocked {
            host.active.finish_request();
        }
        {
            let (released, wake) = &*release_reader;
            *released.lock().expect("reader release") = true;
            wake.notify_all();
        }
        let outcome = pending.join().expect("turn outcome");
        let recovery_deadline = Instant::now() + Duration::from_secs(1);
        let recovered = loop {
            if host.active.claim_request("request-reader-recovered") {
                break true;
            }
            if Instant::now() >= recovery_deadline {
                break false;
            }
            thread::yield_now();
        };
        if recovered {
            host.active.finish_request();
        }

        assert!(
            retirement_was_bounded,
            "reader retirement must remain bounded"
        );
        assert!(
            fresh_was_blocked,
            "unfinished reader ownership must block fresh work"
        );
        assert_eq!(outcome.state, TurnState::CleanupFailed);
        assert!(!outcome.cleaned);
        assert!(
            recovered,
            "completed reader ownership must retire for recovery"
        );
    }

    #[test]
    fn unfinished_readiness_reader_blocks_fresh_recovery_until_bounded_retirement() {
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
        let (reader_body_completed, retirement_started, release_reader) = host
            .active
            .install_reader_retirement_hook("keiko-runtime-stdout");
        let running_host = host.clone();
        let pending = thread::spawn(move || running_host.check("request-reader-readiness", None));
        reader_body_completed
            .recv_timeout(Duration::from_secs(1))
            .expect("readiness reader body completed");
        retirement_started
            .recv_timeout(Duration::from_secs(2))
            .expect("readiness reader retirement started");
        let completion_deadline = Instant::now() + Duration::from_millis(500);
        while !pending.is_finished() && Instant::now() < completion_deadline {
            thread::yield_now();
        }
        let retirement_was_bounded = pending.is_finished();
        let fresh_was_blocked =
            retirement_was_bounded && !host.active.claim_request("request-readiness-fresh");
        if retirement_was_bounded && !fresh_was_blocked {
            host.active.finish_request();
        }
        {
            let (released, wake) = &*release_reader;
            *released.lock().expect("reader release") = true;
            wake.notify_all();
        }
        let outcome = pending.join().expect("readiness outcome");
        let recovery_deadline = Instant::now() + Duration::from_secs(1);
        let recovered = loop {
            if host.active.claim_request("request-readiness-recovered") {
                break true;
            }
            if Instant::now() >= recovery_deadline {
                break false;
            }
            thread::yield_now();
        };
        if recovered {
            host.active.finish_request();
        }

        assert!(retirement_was_bounded);
        assert!(fresh_was_blocked);
        assert_eq!(outcome.state, RuntimeReadinessState::CleanupFailed);
        assert!(recovered);
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
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let mut child = OwnedFixtureChild(
            Command::new("/bin/sleep")
                .arg("30")
                .spawn()
                .expect("nonleader runtime"),
        );
        let process = child.0.id() as i32;
        let child_identity = process_identity(process).expect("nonleader runtime identity");
        let publication_rejected = write_runtime_process_record(&fixture.work, process).is_err();
        let live_not_reconciled = !reconcile_orphaned_runtime_process_group(child_identity);
        let reused_not_reconciled = !reconcile_orphaned_runtime_process_group(ProcessIdentity {
            started_microseconds: child_identity.started_microseconds.wrapping_add(1),
            ..child_identity
        });
        let _ = child.0.kill();
        let reaped = bounded_owned_child_exit(&mut child.0);
        let child_absent = child_exited_without_reaping(process)
            .is_err_and(|error| error.raw_os_error() == Some(MACOS_ECHILD));
        let group_absent = process_group_presence(process);
        let dead_reconciled = reconcile_orphaned_runtime_process_group(ProcessIdentity {
            process_id: i32::MAX,
            started_seconds: 1,
            started_microseconds: 0,
        });

        assert!(publication_rejected, "a nonleader cannot own a runtime");
        assert!(live_not_reconciled);
        assert!(reused_not_reconciled);
        assert!(reaped);
        assert!(child_absent);
        assert_eq!(group_absent, ProcessPresenceStatus::Absent);
        assert!(dead_reconciled);
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
        assert_eq!(
            host.check("different-request", None).state,
            RuntimeReadinessState::Cancelled
        );

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
        assert!(host.active.begin_request("request-in-registration", None));
        assert_eq!(host.active.cancellation(), Some(RuntimeCancellation::User));
        host.active.finish_request();
        host.active.running.store(false, Ordering::Release);

        host.active.running.store(true, Ordering::Release);
        assert!(host.active.begin_request("fresh-retry", None));
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
        assert_eq!(
            first_cancellation.map(|cancellation| cancellation.reason),
            Some(RuntimeCancellation::User)
        );
        assert_eq!(second_pending, first_pending);
        assert_eq!(second_cancellation, first_cancellation);
        assert!(!host.active.running.load(Ordering::Acquire));
        assert_eq!(
            *host.active.process_group.lock().expect("process group"),
            None
        );
    }

    #[test]
    fn workspace_cancel_preserves_a_generation_zero_exact_host_owner_until_settlement() {
        let runtime = RuntimeHost::unavailable_for_test();
        let request_id = "request-generation-zero-host-owner";
        let accepted = AcceptedCancellation {
            accepted_at: Instant::now() - Duration::from_millis(41),
            source: CancellationSource::RendererLost,
        };
        runtime.accept_request_cancellation(request_id, accepted);
        let exact = runtime
            .cancellation_window_for_test()
            .expect("literal generation-zero Host token");

        runtime
            .invalidated_workspace_generation
            .store(9, Ordering::Release);
        runtime.cancel_with_reason(RuntimeCancellation::WorkspaceChanged);

        let control = runtime.active.control.lock().expect("exact Host owner");
        assert_eq!(control.pending_request_id.as_deref(), Some(request_id));
        assert_eq!(control.effect_generation, 0);
        assert_eq!(control.cancellation, Some(exact));
        assert_eq!(
            control.cancellation.map(|window| window.terminal_cutoff),
            Some(exact.terminal_cutoff)
        );
        drop(control);
        assert!(
            !runtime
                .active
                .claim_request("request-wrong-generation-zero-owner")
        );
        assert_eq!(settle_exact_host_cancel(&runtime, request_id), accepted);
        assert!(runtime.wait_for_accepted_cancellation_cleanup());
        assert!(
            runtime
                .active
                .claim_request("request-after-generation-zero-settlement")
        );
        runtime.finish_active_request_for_test();
    }

    #[test]
    fn deferred_host_cancellations_are_bounded_and_overflow_fails_closed() {
        let active = ActiveRuntime::default();
        let accepted_at = Instant::now();
        let records = (0..65)
            .map(|index| HostCancellationRecord {
                accepted: AcceptedCancellation {
                    accepted_at,
                    source: CancellationSource::RendererLost,
                },
                request_id: format!("request-deferred-{index}"),
            })
            .collect::<Vec<_>>();

        active.defer_host_cancellations(&records);

        let deferred = active
            .deferred_cancellations
            .lock()
            .expect("deferred cancellations");
        assert!(
            deferred.len() <= 64,
            "unmatched Host records must have a fixed memory bound"
        );
        drop(deferred);
        assert!(active.deferred_cancellation_overflowed());
        assert!(!active.claim_request("request-unrelated-after-overflow"));
    }

    #[test]
    fn deferred_overflow_preserves_an_exact_active_host_token_and_cutoff() {
        let runtime = RuntimeHost::unavailable_for_test();
        let request_id = "request-active-before-overflow";
        runtime.set_active_request_for_test(request_id);
        let accepted = AcceptedCancellation {
            accepted_at: Instant::now() - Duration::from_millis(17),
            source: CancellationSource::RendererLost,
        };
        runtime.accept_request_cancellation(request_id, accepted);
        let exact = runtime
            .cancellation_window_for_test()
            .expect("exact active Host token");
        let unrelated = (0..=MAX_DEFERRED_CANCELLATIONS)
            .map(|index| HostCancellationRecord {
                accepted: AcceptedCancellation {
                    accepted_at: Instant::now(),
                    source: CancellationSource::User,
                },
                request_id: format!("request-overflow-unrelated-{index}"),
            })
            .collect::<Vec<_>>();

        runtime.active.defer_host_cancellations(&unrelated);
        {
            let mut control = runtime.active.control.lock().expect("overflow control");
            runtime
                .active
                .materialize_deferred_cancellation(&mut control);
            assert_eq!(control.cancellation, Some(exact));
            assert_eq!(
                control
                    .cancellation
                    .map(|cancellation| cancellation.terminal_cutoff),
                Some(exact.terminal_cutoff)
            );
        }
        assert_eq!(settle_exact_host_cancel(&runtime, request_id), accepted);
        assert!(!runtime.active.claim_request("request-blocked-by-overflow"));
    }

    #[test]
    fn overflow_never_materializes_into_an_unrelated_owner_and_exact_records_still_settle() {
        let runtime = RuntimeHost::unavailable_for_test();
        let exact_request = "request-exact-amid-overflow";
        let accepted = AcceptedCancellation {
            accepted_at: Instant::now() - Duration::from_millis(23),
            source: CancellationSource::RendererLost,
        };
        let records = (0..=MAX_DEFERRED_CANCELLATIONS)
            .map(|index| HostCancellationRecord {
                accepted: AcceptedCancellation {
                    accepted_at: Instant::now(),
                    source: CancellationSource::User,
                },
                request_id: format!("request-overflow-fill-{index}"),
            })
            .collect::<Vec<_>>();
        runtime.active.defer_host_cancellations(&records);
        assert!(runtime.active.deferred_cancellation_overflowed());
        {
            let mut control = RuntimeControl {
                request_id: Some("request-unrelated-owner".to_owned()),
                ..RuntimeControl::default()
            };
            runtime
                .active
                .materialize_deferred_cancellation(&mut control);
            assert!(control.cancellation.is_none());
        }
        runtime.accept_request_cancellation(exact_request, accepted);
        assert_eq!(
            runtime
                .cancellation_window_for_test()
                .and_then(|cancellation| cancellation.host_acceptance),
            Some(accepted),
            "a matching Host record accepted after overflow remains exact"
        );
        assert_eq!(settle_exact_host_cancel(&runtime, exact_request), accepted);
        assert!(
            !runtime
                .active
                .claim_request("request-blocked-after-exact-settlement")
        );
    }

    #[test]
    fn reservation_rollback_keeps_exact_host_owner_when_typed_storage_is_full() {
        let runtime = RuntimeHost::unavailable_for_test();
        let request_id = "request-capacity-owned-host";
        let accepted = AcceptedCancellation {
            accepted_at: Instant::now() - Duration::from_millis(31),
            source: CancellationSource::RendererLost,
        };
        let records = (0..MAX_DEFERRED_CANCELLATIONS)
            .map(|index| HostCancellationRecord {
                accepted: AcceptedCancellation {
                    accepted_at: Instant::now(),
                    source: CancellationSource::User,
                },
                request_id: format!("request-capacity-fill-{index}"),
            })
            .collect::<Vec<_>>();
        runtime.active.defer_host_cancellations(&records);
        runtime.accept_request_cancellation(request_id, accepted);
        let reservation = runtime
            .active
            .reserve_request(request_id)
            .expect("exact generation-zero Host owner may reserve its request");
        let exact = reservation.cancellation.expect("reserved exact Host token");

        runtime.active.rollback_request_reservation(&reservation);

        assert!(runtime.active.deferred_cancellation_overflowed());
        let control = runtime.active.control.lock().expect("capacity exact owner");
        assert_eq!(control.pending_request_id.as_deref(), Some(request_id));
        assert_eq!(control.effect_generation, reservation.effect_generation);
        assert_eq!(control.cancellation, Some(exact));
        drop(control);
        assert_eq!(settle_exact_host_cancel(&runtime, request_id), accepted);
        let control = runtime.active.control.lock().expect("capacity settlement");
        assert!(control.request_id.is_none());
        assert!(control.pending_request_id.is_none());
        assert!(control.cancellation.is_none());
        assert_eq!(control.effect_generation, 0);
    }

    #[test]
    fn delayed_unmatched_host_records_remain_exact_until_claim_or_settlement() {
        let active = ActiveRuntime::default();
        let now = Instant::now();
        active.defer_host_cancellations(&[
            HostCancellationRecord {
                accepted: AcceptedCancellation {
                    accepted_at: now - TURN_TERMINAL_BUDGET - Duration::from_millis(1),
                    source: CancellationSource::RendererLost,
                },
                request_id: "request-stale".to_owned(),
            },
            HostCancellationRecord {
                accepted: AcceptedCancellation {
                    accepted_at: now,
                    source: CancellationSource::RendererLost,
                },
                request_id: "request-live".to_owned(),
            },
        ]);
        let mut control = RuntimeControl {
            request_id: Some("request-live".to_owned()),
            ..RuntimeControl::default()
        };

        active.materialize_deferred_cancellation(&mut control);

        assert_eq!(
            control
                .cancellation
                .and_then(|cancellation| cancellation.host_acceptance)
                .map(|accepted| accepted.accepted_at),
            Some(now)
        );
        assert!(
            active
                .deferred_cancellations
                .lock()
                .expect("exact deferred cancellations")
                .iter()
                .any(|item| matches!(
                    item,
                    DeferredRuntimeCancellation::Host(record)
                        if record.request_id == "request-stale"
                )),
            "an accepted nonmatching Host record must remain exact beyond five seconds"
        );
        let stale = active
            .take_exact_deferred_host_cancellation("request-stale")
            .expect("delayed exact settlement");
        assert_eq!(
            stale.host_acceptance.map(|accepted| accepted.accepted_at),
            Some(now - TURN_TERMINAL_BUDGET - Duration::from_millis(1))
        );
        assert!(
            active
                .deferred_cancellations
                .lock()
                .expect("drained exact cancellations")
                .is_empty()
        );
    }

    #[test]
    fn exact_deferred_host_cancellation_materializes_atomically_with_request_claim() {
        let active = ActiveRuntime::default();
        let accepted = AcceptedCancellation {
            accepted_at: Instant::now(),
            source: CancellationSource::RendererLost,
        };
        active.defer_host_cancellations(&[HostCancellationRecord {
            accepted,
            request_id: "request-claimed".to_owned(),
        }]);

        assert!(active.claim_request("request-claimed"));

        assert_eq!(
            active
                .cancellation_window()
                .and_then(|cancellation| cancellation.host_acceptance),
            Some(accepted),
            "the claim must own its deferred Host token before any runtime effect"
        );
        active.finish_request();
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
        assert!(active.begin_request("request", None));
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
    fn unavailable_host_and_malformed_runtime_are_distinct() {
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
        let malformed = fixture.scripted_host("#!/bin/sh\nread -r _\nexit 0\n");
        assert_eq!(
            malformed.check("malformed", None).state,
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
        assert!(
            !active.claim_request("retry-cleanup"),
            "the first retry only schedules owned asynchronous recovery"
        );
        let recovery_deadline = Instant::now() + Duration::from_secs(1);
        let claimed = loop {
            if active.claim_request("retry-cleanup") {
                break true;
            }
            if Instant::now() >= recovery_deadline {
                break false;
            }
            thread::yield_now();
        };
        assert!(
            claimed,
            "bounded owned recovery must unblock the next request"
        );
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
    fn readiness_settlement_poison_cannot_publish_a_computed_ready_result() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let home = fixture.home.to_string_lossy();
        let runtime = fixture.scripted_host(&format!(
            r#"#!/bin/sh
read -r initialize
printf '%s\n' '{{"id":1,"result":{{"userAgent":"codex_cli_rs/0.145.0","codexHome":"{home}","platformFamily":"unix","platformOs":"macos"}}}}'
read -r initialized
read -r account
printf '%s\n' '{{"id":2,"result":{{"account":{{"type":"chatgpt","email":"redacted","planType":"plus"}},"requiresOpenaiAuth":true}}}}'
"#
        ));
        let nonce = "5".repeat(64);
        let mut lifecycle = crate::HostLifecycle::default();
        let generation = lifecycle
            .begin_renderer_session(nonce.clone())
            .expect("settlement poison renderer");
        let sender = lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce);
        let request_id =
            keiko_ui_port::canonical_request_id(generation, 1).expect("settlement poison ID");
        let request = format!(
            r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":1000,"operation":{{"kind":"runtime-readiness"}}}}"#
        );
        let lifecycle = Arc::new(Mutex::new(lifecycle));
        let (settlement_entered, release_settlement) =
            runtime.install_readiness_settlement_hook_for_test();
        let running_lifecycle = Arc::clone(&lifecycle);
        let running_runtime = runtime.clone();
        let pending = thread::spawn(move || {
            runtime_request(
                &running_lifecycle,
                &running_runtime,
                &sender,
                None,
                &request,
            )
        });
        settlement_entered
            .recv_timeout(Duration::from_secs(3))
            .expect("computed readiness paused before settlement");

        runtime.poison_control_for_test();
        release_request_claim(&release_settlement);

        let output = pending.join().expect("poisoned readiness settlement");
        assert!(output.encoded.contains(r#""state":"containment-failed""#));
        assert!(!output.encoded.contains(r#""state":"ready""#));
        assert!(
            !output.encoded.contains(r#""descriptor""#),
            "a poisoned settlement must not retain readiness authority"
        );
        assert!(runtime.active.control.is_poisoned());
        {
            let control = runtime
                .active
                .control
                .lock()
                .expect_err("settlement poison remains observable")
                .into_inner();
            assert!(control.request_id.is_none());
            assert!(control.pending_request_id.is_none());
            assert_eq!(control.effect_generation, 0);
            assert_eq!(control.cancellation, control.closed_control_failure_token);
            assert!(control.cancellation.is_some());
        }
        assert!(
            runtime
                .active
                .closed_control_failure_cleanup
                .load(Ordering::Acquire)
        );
        assert!(
            runtime
                .active
                .claim_request("request-after-readiness-settlement-poison")
        );
        assert!(!runtime.active.control.is_poisoned());
        assert!(runtime.cancellation_window_for_test().is_none());
        runtime.finish_active_request_for_test();
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
    fn accepted_cancellation_fences_a_late_completion_frame_before_projection_mutation() {
        let active = ActiveRuntime::default();
        active.running.store(true, Ordering::Release);
        active
            .control
            .lock()
            .expect("cancellation control")
            .cancellation = Some(AcceptedRuntimeCancellation::new(
            RuntimeCancellation::User,
            Instant::now(),
        ));
        let mut projection = TurnProtocolProjection::new(
            Path::new("/private/tmp/codex-home"),
            Path::new("/private/tmp/codex-work"),
        );
        projection.stage = TurnProjectionStage::Active;
        projection.thread_id = Some("thread-1".to_owned());
        projection.turn_id = Some("turn-1".to_owned());

        assert_eq!(
            accept_turn_frame(
                &active,
                &mut projection,
                br#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","error":null}}}"#,
            ),
            Err(RuntimeCancellation::User)
        );
        assert!(projection.agent_text.is_empty());
        assert_eq!(projection.stage, TurnProjectionStage::Active);
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
    fn host_control_failure_during_readiness_retains_closed_cleanup_until_dead_proof() {
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
        let pending = thread::spawn(move || checking_host.check("request-readiness-poison", None));
        let process_group = published
            .recv_timeout(Duration::from_secs(10))
            .expect("active readiness process group");

        let detection_started = Instant::now();
        host.handoff_host_cancellation(
            UnmatchedHostCancellationPolicy::CloseContainment,
            || HostCancellationMutation::ControlFailed(()),
            |()| (),
        );
        let detection_observed = Instant::now();
        let closed = host
            .cancellation_window_for_test()
            .expect("readiness Host-control failure token");
        assert!(closed.accepted_at >= detection_started);
        assert_eq!(closed.cleanup_cutoff, closed.accepted_at);
        assert_eq!(closed.terminal_cutoff, closed.accepted_at);
        assert!(closed.terminal_cutoff <= detection_observed);
        assert!(
            !host
                .active
                .claim_request("request-readiness-before-settlement")
        );

        let readiness = pending.join().expect("readiness thread");
        assert_eq!(readiness.state, RuntimeReadinessState::CleanupFailed);
        assert_eq!(
            host.cancellation_window_for_test()
                .expect("retained readiness token"),
            closed
        );
        let cleanup_deadline = Instant::now() + TURN_CLEANUP_RESERVE;
        while !host
            .active
            .claim_request("request-readiness-after-dead-proof")
        {
            assert!(
                Instant::now() <= cleanup_deadline,
                "readiness cleanup remained retained after strict dead proof"
            );
            thread::yield_now();
        }
        assert!(!process_group_exists(process_group.process_id));
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
        assert!(host.cancellation_window_for_test().is_none());
        host.active.finish_request();
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
        let cancellation_window = host
            .active
            .cancellation_window()
            .expect("accepted cancellation window");
        let (cancelled, updates) = pending.join().expect("turn thread");
        let terminal_observed_at = Instant::now();
        assert!(
            !terminal_cutoff_exceeded(terminal_observed_at, cancellation_window.terminal_cutoff),
            "cancel terminal exceeded its accepted monotonic cutoff: {:?}",
            terminal_observed_at.saturating_duration_since(stopping_started)
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
    fn accepted_cancel_drives_one_injected_clock_window_through_cleanup_and_terminal() {
        let fixture = Fixture::new();
        let tracked_directory = fixture.work.join("tracked-cancellation-cleanup");
        fs::create_dir(&tracked_directory).expect("tracked private work directory");
        let nonce = "a".repeat(64);
        let mut lifecycle = crate::HostLifecycle::default();
        let generation = lifecycle
            .begin_renderer_session(nonce.clone())
            .expect("renderer generation");
        lifecycle.set_test_now_ms(0);
        let request_id = keiko_ui_port::canonical_request_id(generation, 1).unwrap();
        let request = format!(
            r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":120000,"operation":{{"kind":"codex-turn-start","workspaceGeneration":1,"task":"Bounded task."}}}}"#
        );
        let sender = lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce);
        let accepted_request = lifecycle
            .begin_application_request(&sender, request.as_bytes())
            .expect("Host request");
        lifecycle.set_test_now_ms(1);
        let lifecycle = Mutex::new(lifecycle);
        let cancel = format!(r#"{{"schemaVersion":1,"requestId":"{request_id}"}}"#);
        let runtime = RuntimeHost::from_configuration(None);
        runtime.set_active_request_for_test(&request_id);
        let output = crate::tauri_adapter::dispatch_cancel_with_runtime_fence(
            &lifecycle,
            &runtime,
            "main",
            "tauri://localhost",
            generation,
            &nonce,
            &cancel,
        );
        let host_acceptance = output.accepted.expect("literal Host token");
        let first_window = runtime
            .active
            .cancellation_window()
            .expect("accepted cancellation window");
        assert_eq!(first_window.host_acceptance, Some(host_acceptance));
        let duplicate = crate::tauri_adapter::dispatch_cancel_with_runtime_fence(
            &lifecycle,
            &runtime,
            "main",
            "tauri://localhost",
            generation,
            &nonce,
            &cancel,
        );
        assert!(duplicate.accepted.is_some());
        assert_eq!(runtime.active.cancellation_window(), Some(first_window));

        fs::set_permissions(&fixture.work, fs::Permissions::from_mode(0o500))
            .expect("deny delayed directory cleanup");
        let directory_cleaned = cleanup_or_track_work_directory_until_at(
            &runtime.active,
            &tracked_directory,
            first_window.cleanup_cutoff,
            host_acceptance.accepted_at + Duration::from_millis(4_600),
        );
        assert!(!directory_cleaned);
        let mut session = keiko_application::turn::TurnSession::new(
            generation,
            1,
            1,
            "Bounded task.".to_owned(),
            keiko_application::runtime::RuntimeDescriptor::approved(),
        )
        .unwrap();
        session.request_stop(TurnReason::UserCancelled).unwrap();
        session.settle_cleanup(false).unwrap();
        lifecycle.lock().unwrap().set_test_now_ms(4_900);
        let final_output = crate::turn::finish_turn_with_runtime(
            &lifecycle,
            &runtime,
            &request_id,
            accepted_request,
            session.view(),
            &mut |commit| commit().is_ok(),
        );
        assert!(final_output.encoded.contains(r#""state":"cleanup-failed""#));
        assert!(!runtime.active.claim_request("request-fresh"));

        fs::set_permissions(&fixture.work, fs::Permissions::from_mode(0o700))
            .expect("restore fixture cleanup permission");
        let reconciliation_deadline = Instant::now() + Duration::from_secs(1);
        while !reconcile_retained_work_directories(&runtime.active) {
            assert!(
                Instant::now() < reconciliation_deadline,
                "tracked cleanup worker did not settle"
            );
            thread::yield_now();
        }
        assert!(runtime.active.claim_request("request-fresh"));
        runtime.active.finish_request();
    }

    #[test]
    fn production_coordinator_carries_tauri_cancel_through_process_cleanup_and_host_response() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository identity");
        fs::create_dir(repository.join(".git")).expect("repository marker");
        let runtime = fixture.scripted_host(
            r#"#!/bin/sh
trap '' TERM
read -r initialize
printf '%s\n' '{"id":1,"result":{"userAgent":"codex_cli_rs/0.145.0","codexHome":"'"$CODEX_HOME"'","platformFamily":"unix","platformOs":"macos"}}'
while :; do /bin/sleep 1; done
"#,
        );
        let mut workspace = crate::WorkspaceHost::default();
        let workspace_generation = match workspace
            .select(crate::FolderPickerResult::Selected(repository.clone()))
            .expect("workspace selection")
        {
            keiko_application::workspace::WorkspaceView::Bound { generation, .. } => generation,
            _ => panic!("bound workspace"),
        };
        let nonce = "b".repeat(64);
        let mut lifecycle = crate::HostLifecycle::default();
        let generation = lifecycle
            .begin_renderer_session(nonce.clone())
            .expect("renderer generation");
        let sender = lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce);
        let request_id = keiko_ui_port::canonical_request_id(generation, 1).unwrap();
        let request = format!(
            r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":120000,"operation":{{"kind":"codex-turn-start","workspaceGeneration":{workspace_generation},"task":"Bounded task."}}}}"#
        );
        let lifecycle = Arc::new(Mutex::new(lifecycle));
        let workspace = Arc::new(Mutex::new(workspace));
        let updates = Arc::new(Mutex::new(Vec::new()));
        let published = runtime.active.observe_next_process_group();
        let running_lifecycle = Arc::clone(&lifecycle);
        let running_workspace = Arc::clone(&workspace);
        let running_runtime = runtime.clone();
        let running_updates = Arc::clone(&updates);
        let running_sender = sender.clone();
        let pending = thread::spawn(move || {
            crate::turn::turn_request(
                &running_lifecycle,
                &running_workspace,
                &running_runtime,
                &running_sender,
                &request,
                |view| running_updates.lock().expect("updates").push(view),
            )
        });
        let process_group = published
            .recv_timeout(Duration::from_secs(5))
            .expect("active production process group");
        assert!(process_group_exists(process_group.process_id));

        let cancellation = format!(r#"{{"schemaVersion":1,"requestId":"{request_id}"}}"#);
        let cancelled = crate::tauri_adapter::dispatch_cancel_with_runtime_fence(
            &lifecycle,
            &runtime,
            "main",
            "tauri://localhost",
            generation,
            &nonce,
            &cancellation,
        );
        let accepted = cancelled.accepted.expect("literal Tauri Host token");
        let completion_deadline = accepted.accepted_at + Duration::from_secs(5);
        while !pending.is_finished() {
            assert!(
                Instant::now() <= completion_deadline,
                "production coordinator exceeded the accepted terminal cutoff"
            );
            thread::yield_now();
        }
        let output = pending.join().expect("production turn thread");

        assert!(output.encoded.contains(r#""state":"cancelled""#));
        assert!(output.encoded.contains(r#""reason":"user-cancelled""#));
        assert_eq!(
            updates
                .lock()
                .expect("updates")
                .iter()
                .map(|view| view.state)
                .collect::<Vec<_>>(),
            vec![
                TurnState::Preflighting,
                TurnState::Stopping,
                TurnState::Cancelled,
            ],
            "the actual terminal channel callback must match the final response"
        );
        assert!(!process_group_exists(process_group.process_id));
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
        assert!(
            runtime
                .active
                .claim_request("request-fresh-after-settlement")
        );
        runtime.active.finish_request();
    }

    #[test]
    fn production_host_control_failure_signals_cleans_and_retains_the_exact_runtime() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository identity");
        fs::create_dir(repository.join(".git")).expect("repository marker");
        let runtime = fixture.scripted_host(
            r#"#!/bin/sh
trap '' TERM
read -r initialize
printf '%s\n' '{"id":1,"result":{"userAgent":"codex_cli_rs/0.145.0","codexHome":"'"$CODEX_HOME"'","platformFamily":"unix","platformOs":"macos"}}'
while :; do /bin/sleep 1; done
"#,
        );
        let mut workspace = crate::WorkspaceHost::default();
        let workspace_generation = match workspace
            .select(crate::FolderPickerResult::Selected(repository))
            .expect("workspace selection")
        {
            keiko_application::workspace::WorkspaceView::Bound { generation, .. } => generation,
            _ => panic!("bound workspace"),
        };
        let nonce = "f".repeat(64);
        let mut lifecycle = crate::HostLifecycle::default();
        let generation = lifecycle
            .begin_renderer_session(nonce.clone())
            .expect("renderer generation");
        let sender = lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce);
        let request_id = keiko_ui_port::canonical_request_id(generation, 1).unwrap();
        let request = format!(
            r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":120000,"operation":{{"kind":"codex-turn-start","workspaceGeneration":{workspace_generation},"task":"Bounded task."}}}}"#
        );
        let lifecycle = Arc::new(Mutex::new(lifecycle));
        let workspace = Arc::new(Mutex::new(workspace));
        let published = runtime.active.observe_next_process_group();
        let running_lifecycle = Arc::clone(&lifecycle);
        let running_workspace = Arc::clone(&workspace);
        let running_runtime = runtime.clone();
        let pending = thread::spawn(move || {
            crate::turn::turn_request(
                &running_lifecycle,
                &running_workspace,
                &running_runtime,
                &sender,
                &request,
                |_| {},
            )
        });
        let process_group = published
            .recv_timeout(Duration::from_secs(5))
            .expect("active production process group");
        assert!(process_group_exists(process_group.process_id));

        let _ = std::panic::catch_unwind({
            let lifecycle = Arc::clone(&lifecycle);
            move || {
                let _guard = lifecycle.lock().expect("lifecycle before poison");
                panic!("poison active Host control");
            }
        });
        let cancellation = format!(r#"{{"schemaVersion":1,"requestId":"{request_id}"}}"#);
        let detection_started = Instant::now();
        let failed = crate::tauri_adapter::dispatch_cancel_with_runtime_fence(
            &lifecycle,
            &runtime,
            "main",
            "tauri://localhost",
            generation,
            &nonce,
            &cancellation,
        );
        let detection_observed = Instant::now();
        assert!(failed.host_control_failed);
        assert!(failed.encoded.contains("internal-failure"));
        let closed = runtime
            .cancellation_window_for_test()
            .expect("closed Host-control cancellation");
        assert!(closed.accepted_at >= detection_started);
        assert_eq!(closed.cleanup_cutoff, closed.accepted_at);
        assert_eq!(closed.terminal_cutoff, closed.accepted_at);
        assert!(closed.terminal_cutoff <= detection_observed);
        assert!(!runtime.active.claim_request("request-fresh-before-proof"));

        let completion_deadline = Instant::now() + TURN_TERMINAL_BUDGET;
        while !pending.is_finished() {
            assert!(
                Instant::now() <= completion_deadline,
                "Host-control containment exceeded the terminal cutoff"
            );
            thread::yield_now();
        }
        let output = pending.join().expect("production turn thread");
        assert!(output.encoded.contains("internal-failure"));
        let retained = runtime
            .cancellation_window_for_test()
            .expect("closed control-failure token retained through settlement");
        assert_eq!(retained.accepted_at, closed.accepted_at);
        assert_eq!(retained.cleanup_cutoff, closed.cleanup_cutoff);
        assert_eq!(retained.terminal_cutoff, closed.terminal_cutoff);
        let cleanup_deadline = Instant::now() + TURN_CLEANUP_RESERVE;
        while process_group_exists(process_group.process_id) {
            assert!(
                Instant::now() <= cleanup_deadline,
                "owned production cleanup must become strictly proven"
            );
            thread::yield_now();
        }
        while !runtime.active.claim_request("request-fresh-after-proof") {
            assert!(
                Instant::now() <= cleanup_deadline,
                "fresh work remained blocked after strict cleanup proof"
            );
            thread::yield_now();
        }
        assert!(!process_group_exists(process_group.process_id));
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
        assert!(runtime.cancellation_window_for_test().is_none());
        runtime.active.finish_request();
    }

    fn runtime_with_retained_control_failure() -> (RuntimeHost, AcceptedRuntimeCancellation) {
        let runtime = RuntimeHost::unavailable_for_test();
        runtime.set_active_request_for_test("request-old-control-failure");
        runtime.handoff_host_cancellation(
            UnmatchedHostCancellationPolicy::CloseContainment,
            || HostCancellationMutation::ControlFailed(()),
            |()| (),
        );
        let closed = runtime
            .cancellation_window_for_test()
            .expect("old closed ControlFailed token");
        runtime.finish_active_request_for_test();
        (runtime, closed)
    }

    fn release_request_claim(release: &Arc<(Mutex<bool>, Condvar)>) {
        let (released, wake) = &**release;
        *released.lock().expect("request claim release") = true;
        wake.notify_all();
    }

    fn install_exact_user_host_cancel(
        runtime: &RuntimeHost,
        request_id: &str,
        accepted_at: Instant,
    ) {
        runtime.handoff_host_cancellation(
            UnmatchedHostCancellationPolicy::Ignore,
            || {
                HostCancellationMutation::Completed(
                    (),
                    vec![HostCancellationRecord {
                        accepted: AcceptedCancellation {
                            accepted_at,
                            source: CancellationSource::User,
                        },
                        request_id: request_id.to_owned(),
                    }],
                )
            },
            |()| (),
        );
    }

    fn settle_exact_host_cancel(runtime: &RuntimeHost, request_id: &str) -> AcceptedCancellation {
        let (published, finalized) = runtime.settle_host_turn(
            request_id,
            |refresh, _control_failed| refresh(),
            |published, finalized| (published, finalized),
        );
        assert_eq!(published, finalized);
        published.expect("exact Host cancellation settlement")
    }

    #[test]
    fn failed_turn_claim_settles_exact_host_cancel_on_original_request() {
        let repository = std::env::temp_dir().join(format!(
            "keiko-failed-turn-claim-{}-{}",
            std::process::id(),
            FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(repository.join(".git")).expect("turn claim workspace");
        let mut workspace = crate::WorkspaceHost::default();
        let workspace_generation = match workspace
            .select(crate::FolderPickerResult::Selected(repository.clone()))
            .expect("turn claim workspace selection")
        {
            keiko_application::workspace::WorkspaceView::Bound { generation, .. } => generation,
            _ => panic!("bound turn claim workspace"),
        };
        let nonce = "9".repeat(64);
        let mut lifecycle = crate::HostLifecycle::default();
        let generation = lifecycle
            .begin_renderer_session(nonce.clone())
            .expect("turn claim renderer");
        let sender = lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce);
        let request_id =
            keiko_ui_port::canonical_request_id(generation, 1).expect("turn request ID");
        let request = format!(
            r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":120000,"operation":{{"kind":"codex-turn-start","workspaceGeneration":{workspace_generation},"task":"Bounded task."}}}}"#
        );
        let lifecycle = Arc::new(Mutex::new(lifecycle));
        let workspace = Arc::new(Mutex::new(workspace));
        let runtime = RuntimeHost::unavailable_for_test();
        let (commit_entered, release_commit) = runtime.install_request_commit_hook_for_test();
        let running_lifecycle = Arc::clone(&lifecycle);
        let running_workspace = Arc::clone(&workspace);
        let running_runtime = runtime.clone();
        let pending = thread::spawn(move || {
            crate::turn::turn_request(
                &running_lifecycle,
                &running_workspace,
                &running_runtime,
                &sender,
                &request,
                |_| {},
            )
        });
        commit_entered
            .recv_timeout(Duration::from_secs(1))
            .expect("turn claim reserved");
        let records = lifecycle.lock().expect("turn lifecycle").renderer_lost();
        runtime.defer_host_cancellations(&records);
        release_request_claim(&release_commit);

        let output = pending.join().expect("failed turn claim settlement");
        assert!(output.encoded.contains(r#""state":"cancelled""#));
        assert!(output.encoded.contains(r#""reason":"renderer-lost""#));
        assert!(!output.encoded.contains(r#""reason":"internal-failure""#));
        assert!(
            runtime
                .active
                .deferred_cancellations
                .lock()
                .expect("turn settlement storage")
                .is_empty()
        );
        fs::remove_dir_all(repository).expect("remove turn claim workspace");
    }

    #[test]
    fn failed_readiness_claim_drains_exact_host_cancel_during_host_settlement() {
        let nonce = "8".repeat(64);
        let mut lifecycle = crate::HostLifecycle::default();
        let generation = lifecycle
            .begin_renderer_session(nonce.clone())
            .expect("readiness claim renderer");
        let sender = lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce);
        let request_id =
            keiko_ui_port::canonical_request_id(generation, 1).expect("readiness request ID");
        let request = format!(
            r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":1000,"operation":{{"kind":"runtime-readiness"}}}}"#
        );
        let lifecycle = Arc::new(Mutex::new(lifecycle));
        let runtime = RuntimeHost::unavailable_for_test();
        let (commit_entered, release_commit) = runtime.install_request_commit_hook_for_test();
        let running_lifecycle = Arc::clone(&lifecycle);
        let running_runtime = runtime.clone();
        let pending = thread::spawn(move || {
            runtime_request(
                &running_lifecycle,
                &running_runtime,
                &sender,
                None,
                &request,
            )
        });
        commit_entered
            .recv_timeout(Duration::from_secs(1))
            .expect("readiness claim reserved");
        let records = lifecycle
            .lock()
            .expect("readiness lifecycle")
            .renderer_lost();
        runtime.defer_host_cancellations(&records);
        release_request_claim(&release_commit);

        let output = pending.join().expect("failed readiness claim settlement");
        assert!(output.encoded.contains(r#""code":"cancelled""#));
        assert!(
            runtime
                .active
                .deferred_cancellations
                .lock()
                .expect("readiness settlement storage")
                .is_empty()
        );
    }

    #[test]
    fn readiness_finish_gap_settles_exact_renderer_and_shutdown_host_authority() {
        for shutdown in [false, true] {
            let nonce = if shutdown {
                "7".repeat(64)
            } else {
                "6".repeat(64)
            };
            let mut lifecycle = crate::HostLifecycle::default();
            let generation = lifecycle
                .begin_renderer_session(nonce.clone())
                .expect("readiness gap renderer");
            let sender =
                lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce);
            let request_id =
                keiko_ui_port::canonical_request_id(generation, 1).expect("readiness gap ID");
            let request = format!(
                r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":1000,"operation":{{"kind":"runtime-readiness"}}}}"#
            );
            let lifecycle = Arc::new(Mutex::new(lifecycle));
            let runtime = RuntimeHost::unavailable_for_test();
            let (settlement_entered, release_settlement) =
                runtime.install_readiness_settlement_hook_for_test();
            let running_lifecycle = Arc::clone(&lifecycle);
            let running_runtime = runtime.clone();
            let pending = thread::spawn(move || {
                runtime_request(
                    &running_lifecycle,
                    &running_runtime,
                    &sender,
                    None,
                    &request,
                )
            });
            settlement_entered
                .recv_timeout(Duration::from_secs(1))
                .expect("readiness finished before Host settlement");

            runtime.handoff_host_cancellation(
                UnmatchedHostCancellationPolicy::Ignore,
                || {
                    let records = if shutdown {
                        lifecycle.lock().expect("shutdown lifecycle").shutdown()
                    } else {
                        lifecycle
                            .lock()
                            .expect("renderer lifecycle")
                            .renderer_lost()
                    };
                    HostCancellationMutation::Completed((), records)
                },
                |()| (),
            );
            {
                let control = runtime.active.control.lock().expect("gap Host authority");
                assert_eq!(
                    control.pending_request_id.as_deref(),
                    Some(request_id.as_str())
                );
                assert!(
                    control
                        .cancellation
                        .and_then(|cancellation| cancellation.host_acceptance)
                        .is_some()
                );
            }
            let exact = runtime
                .cancellation_window_for_test()
                .expect("literal gap cancellation");
            assert_eq!(
                runtime.check("request-readiness-gap-wrong", None).state,
                RuntimeReadinessState::ContainmentFailed
            );
            assert!(!runtime.claim_turn_request_for_host_settlement("request-turn-gap-wrong"));
            {
                let control = runtime
                    .active
                    .control
                    .lock()
                    .expect("wrong-ID claims preserve exact gap authority");
                assert_eq!(
                    control.pending_request_id.as_deref(),
                    Some(request_id.as_str())
                );
                assert_eq!(control.effect_generation, 0);
                assert_eq!(control.cancellation, Some(exact));
            }
            release_request_claim(&release_settlement);
            let output = pending.join().expect("readiness gap settlement");
            assert!(output.encoded.contains(r#""code":"cancelled""#));
            let control = runtime.active.control.lock().expect("settled control");
            assert!(control.request_id.is_none());
            assert!(control.pending_request_id.is_none());
            assert!(control.cancellation.is_none());
            assert_eq!(control.effect_generation, 0);
            drop(control);
            assert!(runtime.active.wait_for_idle(Duration::ZERO));
            assert_eq!(
                runtime.check("request-readiness-after-gap", None).state,
                RuntimeReadinessState::Unavailable
            );
        }
    }

    #[test]
    fn readiness_host_completion_is_atomic_with_final_exact_runtime_settlement() {
        let nonce = "8".repeat(64);
        let mut lifecycle = crate::HostLifecycle::default();
        let generation = lifecycle
            .begin_renderer_session(nonce.clone())
            .expect("atomic readiness renderer");
        let sender = lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce);
        let request_id =
            keiko_ui_port::canonical_request_id(generation, 1).expect("atomic readiness ID");
        let request = format!(
            r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":1000,"operation":{{"kind":"runtime-readiness"}}}}"#
        );
        let lifecycle = Arc::new(Mutex::new(lifecycle));
        let runtime = RuntimeHost::unavailable_for_test();
        let (completion_entered, release_completion) =
            runtime.install_readiness_completion_hook_for_test();
        let running_lifecycle = Arc::clone(&lifecycle);
        let running_runtime = runtime.clone();
        let pending = thread::spawn(move || {
            runtime_request(
                &running_lifecycle,
                &running_runtime,
                &sender,
                None,
                &request,
            )
        });
        completion_entered
            .recv_timeout(Duration::from_secs(1))
            .expect("Runtime settlement owns Host completion boundary");

        let (attempted_sender, attempted) = mpsc::sync_channel(1);
        let cancelling_lifecycle = Arc::clone(&lifecycle);
        let cancelling_runtime = runtime.clone();
        let cancelling = thread::spawn(move || {
            attempted_sender
                .send(())
                .expect("late cancellation attempted");
            cancelling_runtime.handoff_host_cancellation(
                UnmatchedHostCancellationPolicy::Ignore,
                || {
                    let records = cancelling_lifecycle
                        .lock()
                        .expect("late renderer lifecycle")
                        .renderer_lost();
                    let retained = records.len();
                    HostCancellationMutation::Completed(retained, records)
                },
                std::convert::identity,
            )
        });
        attempted
            .recv_timeout(Duration::from_secs(1))
            .expect("late cancellation reached Runtime owner");
        assert!(!cancelling.is_finished());

        release_request_claim(&release_completion);
        let output = pending.join().expect("atomic readiness completion");
        assert!(output.encoded.contains(r#""state":"unavailable""#));
        assert_eq!(cancelling.join().expect("late Host cancellation"), 0);
        let control = runtime
            .active
            .control
            .lock()
            .expect("atomic settled control");
        assert!(control.request_id.is_none());
        assert!(control.pending_request_id.is_none());
        assert!(control.cancellation.is_none());
        assert_eq!(control.effect_generation, 0);
    }

    #[test]
    fn readiness_exact_settlement_preserves_wrong_id_and_poisoned_containment_owners() {
        let wrong_id = RuntimeHost::unavailable_for_test();
        wrong_id.set_active_request_for_test("request-readiness-wrong-owner");
        let wrong_acceptance = AcceptedCancellation {
            accepted_at: Instant::now(),
            source: CancellationSource::User,
        };
        wrong_id.accept_request_cancellation("request-readiness-wrong-owner", wrong_acceptance);
        wrong_id.poison_control_for_test();
        let view = wrong_id.settle_host_readiness(
            "request-readiness-settlement",
            RuntimeReadinessView::terminal(RuntimeReadinessState::Unavailable, 0),
            std::convert::identity,
        );
        assert_eq!(view.state, RuntimeReadinessState::ContainmentFailed);
        let control = wrong_id
            .active
            .control
            .lock()
            .expect_err("wrong readiness owner remains poisoned")
            .into_inner();
        assert_eq!(
            control.request_id.as_deref(),
            Some("request-readiness-wrong-owner")
        );
        assert_eq!(
            control
                .cancellation
                .and_then(|cancellation| cancellation.host_acceptance),
            Some(wrong_acceptance)
        );
        drop(control);
        assert_eq!(
            settle_exact_host_cancel(&wrong_id, "request-readiness-wrong-owner"),
            wrong_acceptance
        );
        assert!(
            wrong_id
                .active
                .claim_request("request-after-wrong-owner-proof")
        );
        wrong_id.finish_active_request_for_test();

        let poisoned = RuntimeHost::unavailable_for_test();
        poisoned.poison_control_for_test();
        let exact_acceptance = AcceptedCancellation {
            accepted_at: Instant::now(),
            source: CancellationSource::RendererLost,
        };
        poisoned
            .active
            .defer_host_cancellations(&[HostCancellationRecord {
                accepted: exact_acceptance,
                request_id: "request-readiness-poisoned".to_owned(),
            }]);
        let view = poisoned.settle_host_readiness(
            "request-readiness-poisoned",
            RuntimeReadinessView::terminal(RuntimeReadinessState::ContainmentFailed, 0),
            std::convert::identity,
        );
        assert_eq!(view.state, RuntimeReadinessState::Cancelled);
        assert!(
            poisoned
                .active
                .deferred_cancellations
                .lock()
                .expect("poisoned exact settlement storage")
                .is_empty()
        );
        assert!(poisoned.active.control.is_poisoned());
    }

    #[test]
    fn sequential_failed_claim_settlements_drain_typed_storage_without_overflow() {
        let runtime = RuntimeHost::unavailable_for_test();
        for index in 0..=MAX_DEFERRED_CANCELLATIONS {
            let request_id = format!("request-sequential-settlement-{index}");
            runtime
                .active
                .defer_reserved_host_cancellation(HostCancellationRecord {
                    accepted: AcceptedCancellation {
                        accepted_at: Instant::now() - TURN_TERMINAL_BUDGET,
                        source: CancellationSource::User,
                    },
                    request_id: request_id.clone(),
                });
            assert!(!runtime.active.claim_request(&request_id));
            assert_eq!(
                settle_exact_host_cancel(&runtime, &request_id).source,
                CancellationSource::User
            );
            assert!(
                runtime
                    .active
                    .deferred_cancellations
                    .lock()
                    .expect("sequential settlement storage")
                    .is_empty()
            );
        }
        assert!(!runtime.active.deferred_cancellation_overflowed());
        assert!(
            runtime
                .active
                .claim_request("request-after-sequential-settlements")
        );
        runtime.finish_active_request_for_test();
    }

    #[test]
    fn exact_host_settlement_does_not_mutate_a_wrong_id_owner() {
        let runtime = RuntimeHost::unavailable_for_test();
        let accepted_at = Instant::now();
        runtime
            .active
            .defer_reserved_host_cancellation(HostCancellationRecord {
                accepted: AcceptedCancellation {
                    accepted_at,
                    source: CancellationSource::RendererLost,
                },
                request_id: "request-original-settlement".to_owned(),
            });
        runtime.set_active_request_for_test("request-unrelated-owner");

        let settled = settle_exact_host_cancel(&runtime, "request-original-settlement");

        assert_eq!(settled.accepted_at, accepted_at);
        assert_eq!(settled.source, CancellationSource::RendererLost);
        let control = runtime.active.control.lock().expect("wrong-ID owner");
        assert_eq!(
            control.request_id.as_deref(),
            Some("request-unrelated-owner")
        );
        assert!(control.cancellation.is_none());
        drop(control);
        assert!(runtime.active.runtime_effect_trace().is_empty());
        runtime.finish_active_request_for_test();
    }

    #[test]
    fn rollback_retains_direct_and_deferred_reservation_owned_host_acceptance() {
        for deferred in [false, true] {
            let runtime = RuntimeHost::unavailable_for_test();
            let request_id = format!("request-reservation-owned-host-{deferred}");
            let accepted = AcceptedCancellation {
                accepted_at: Instant::now(),
                source: CancellationSource::RendererLost,
            };
            if deferred {
                runtime
                    .active
                    .defer_host_cancellations(&[HostCancellationRecord {
                        accepted,
                        request_id: request_id.clone(),
                    }]);
            } else {
                runtime.accept_request_cancellation(&request_id, accepted);
            }
            let reservation = runtime
                .active
                .reserve_request(&request_id)
                .expect("exact Host reservation");
            assert_eq!(
                reservation
                    .cancellation
                    .and_then(|cancellation| cancellation.host_acceptance),
                Some(accepted)
            );

            runtime.active.rollback_request_reservation(&reservation);

            let control = runtime.active.control.lock().expect("rolled back control");
            assert!(control.request_id.is_none());
            assert!(control.pending_request_id.is_none());
            assert!(control.cancellation.is_none());
            assert_eq!(control.effect_generation, 0);
            drop(control);
            assert!(!runtime.active.claim_request(&request_id));
            assert_eq!(settle_exact_host_cancel(&runtime, &request_id), accepted);
            assert!(runtime.active.claim_request("request-after-host-rollback"));
            assert!(runtime.cancellation_window_for_test().is_none());
            runtime.finish_active_request_for_test();
        }
    }

    #[test]
    fn reconciliation_failures_retain_reservation_host_authority_for_turn_and_readiness() {
        #[derive(Clone, Copy, Debug)]
        enum FailureKind {
            Reader,
            Process,
            WorkDirectory,
        }

        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for failure in [
            FailureKind::Reader,
            FailureKind::Process,
            FailureKind::WorkDirectory,
        ] {
            for readiness in [false, true] {
                for deferred in [false, true] {
                    let runtime = RuntimeHost::unavailable_for_test();
                    let request_id = format!(
                        "request-retained-failure-{}-{readiness}-{deferred}",
                        match failure {
                            FailureKind::Reader => "reader",
                            FailureKind::Process => "process",
                            FailureKind::WorkDirectory => "workdir",
                        }
                    );
                    let accepted = AcceptedCancellation {
                        accepted_at: Instant::now(),
                        source: CancellationSource::RendererLost,
                    };
                    if deferred {
                        runtime
                            .active
                            .defer_host_cancellations(&[HostCancellationRecord {
                                accepted,
                                request_id: request_id.clone(),
                            }]);
                    } else {
                        runtime.accept_request_cancellation(&request_id, accepted);
                    }

                    let mut release_reader = None;
                    let mut release_directory = None;
                    let mut process = None;
                    let mut process_identity = None;
                    match failure {
                        FailureKind::Reader => {
                            let (release, released) = mpsc::channel();
                            let (completed, completion) = mpsc::channel();
                            let worker = thread::spawn(move || {
                                let _ = released.recv();
                                let _ = completed.send(());
                            });
                            runtime
                                .active
                                .retained_readers
                                .lock()
                                .expect("retained reader")
                                .push(RuntimeReader {
                                    completed: completion,
                                    worker,
                                });
                            release_reader = Some(release);
                        }
                        FailureKind::Process => {
                            let child = Command::new("/bin/sleep")
                                .arg("30")
                                .stdin(Stdio::null())
                                .stdout(Stdio::null())
                                .stderr(Stdio::null())
                                .process_group(0)
                                .spawn()
                                .expect("retained process fixture");
                            let process_group = child.id() as i32;
                            assert!(publish_active_process_group(&runtime.active, process_group));
                            register_owned_process(&runtime.active, process_group);
                            process_identity = runtime
                                .active
                                .process_group
                                .lock()
                                .expect("retained process identity")
                                .to_owned();
                            process = Some(child);
                        }
                        FailureKind::WorkDirectory => {
                            let (release, released) = mpsc::channel();
                            let (completed, completion) = mpsc::channel();
                            let worker = thread::spawn(move || {
                                let _ = released.recv();
                                let _ = completed.send(true);
                            });
                            runtime
                                .active
                                .tracked_directory_cleanups
                                .lock()
                                .expect("tracked work directory")
                                .push(TrackedDirectoryCleanup {
                                    path: std::env::temp_dir().join(format!(
                                        "keiko-absent-retained-workdir-{}",
                                        FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
                                    )),
                                    completed: completion,
                                    worker,
                                });
                            release_directory = Some(release);
                        }
                    }

                    let claimed = if readiness {
                        runtime.check(&request_id, None);
                        false
                    } else {
                        runtime.claim_turn_request_for_host_settlement(&request_id)
                    };
                    assert!(
                        !claimed,
                        "claim unexpectedly passed {failure:?}, readiness={readiness}, deferred={deferred}"
                    );
                    assert_eq!(settle_exact_host_cancel(&runtime, &request_id), accepted);

                    if let Some(release) = release_reader {
                        release.send(()).expect("release retained reader");
                    }
                    if let Some(release) = release_directory {
                        release.send(()).expect("release tracked directory");
                    }
                    if let Some(mut child) = process {
                        let identity = process_identity.expect("retained process identity");
                        signal_process_group(identity.process_id, SIGKILL);
                        child.wait().expect("retained process reaped");
                        assert!(retire_active_process_group(&runtime.active, identity));
                    }
                    let recovery_deadline = Instant::now() + Duration::from_secs(1);
                    while !runtime
                        .active
                        .claim_request("request-fresh-after-retained-failure")
                    {
                        assert!(
                            Instant::now() <= recovery_deadline,
                            "fresh claim after {failure:?}, readiness={readiness}, deferred={deferred}"
                        );
                        thread::yield_now();
                    }
                    assert!(runtime.cancellation_window_for_test().is_none());
                    runtime.finish_active_request_for_test();
                }
            }
        }
    }

    #[test]
    fn pending_turn_and_readiness_reservations_are_superseded_before_idle_proof() {
        #[derive(Clone, Copy)]
        enum RequestKind {
            Turn,
            Readiness,
        }
        #[derive(Clone, Copy)]
        enum CancellationKind {
            Workspace,
            Shutdown,
        }

        for poisoned in [false, true] {
            for request_kind in [RequestKind::Turn, RequestKind::Readiness] {
                for cancellation_kind in [CancellationKind::Workspace, CancellationKind::Shutdown] {
                    let runtime = RuntimeHost::unavailable_for_test();
                    let request_id = format!(
                        "request-pending-{}-{}-{}",
                        poisoned,
                        matches!(request_kind, RequestKind::Readiness),
                        matches!(cancellation_kind, CancellationKind::Shutdown)
                    );
                    let (commit_entered, release_commit) =
                        runtime.install_request_commit_hook_for_test();
                    let requesting_runtime = runtime.clone();
                    let requesting_id = request_id.clone();
                    let request = thread::spawn(move || match request_kind {
                        RequestKind::Turn => requesting_runtime
                            .claim_turn_request_for_host_settlement(&requesting_id),
                        RequestKind::Readiness => {
                            requesting_runtime.check(&requesting_id, None);
                            false
                        }
                    });
                    commit_entered
                        .recv_timeout(Duration::from_secs(1))
                        .expect("pending request reserved");
                    if poisoned {
                        runtime.poison_control_for_test();
                    }

                    let cancelling_runtime = runtime.clone();
                    let cancelling = thread::spawn(move || match cancellation_kind {
                        CancellationKind::Workspace => {
                            cancelling_runtime.cancel_for_workspace_change_and_wait(1)
                        }
                        CancellationKind::Shutdown => {
                            cancelling_runtime.cancel_for_app_shutdown_and_wait()
                        }
                    });
                    let cleanup_proven = if poisoned {
                        let cleanup_proven =
                            cancelling.join().expect("closed-cutoff cleanup waiter");
                        assert!(
                            !cleanup_proven,
                            "strict cutoff cannot claim proof while a reservation remains"
                        );
                        assert!(!request.is_finished());
                        release_request_claim(&release_commit);
                        assert!(!request.join().expect("superseded request"));
                        cleanup_proven
                    } else {
                        let observation_deadline = Instant::now() + Duration::from_secs(1);
                        while !runtime.active.idle_waiting.load(Ordering::Acquire) {
                            assert!(
                                Instant::now() <= observation_deadline,
                                "cleanup waiter did not observe the pending reservation"
                            );
                            thread::yield_now();
                        }
                        assert!(
                            !cancelling.is_finished(),
                            "cleanup proof returned while a pending identity remained"
                        );
                        release_request_claim(&release_commit);
                        assert!(!request.join().expect("superseded request"));
                        cancelling.join().expect("pending cleanup waiter")
                    };
                    assert_eq!(cleanup_proven, !poisoned);
                    let control = runtime
                        .active
                        .control
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    assert!(control.request_id.is_none());
                    assert!(control.pending_request_id.is_none());
                    assert_eq!(control.effect_generation, 0);
                    if !poisoned {
                        assert!(control.cancellation.is_none());
                    }
                    drop(control);
                    if !poisoned {
                        assert!(
                            runtime
                                .active
                                .claim_request("request-fresh-turn-after-global-cancel")
                        );
                        assert!(runtime.cancellation_window_for_test().is_none());
                        runtime.finish_active_request_for_test();
                        let readiness =
                            runtime.check("request-fresh-readiness-after-global-cancel", None);
                        assert_eq!(readiness.state, RuntimeReadinessState::Unavailable);
                        assert!(runtime.cancellation_window_for_test().is_none());
                    }
                    assert!(runtime.active.runtime_effect_trace().is_empty());
                }
            }
        }
    }

    fn assert_poisoned_retained_global_cancel_supersedes(readiness: bool, shutdown: bool) {
        let (runtime, old_closed) = runtime_with_retained_control_failure();
        runtime.poison_control_for_test();
        let request_id = format!("request-poisoned-retained-{readiness}-{shutdown}");
        let (commit_entered, release_commit) = runtime.install_request_commit_hook_for_test();
        let requesting_runtime = runtime.clone();
        let requesting_id = request_id.clone();
        let request = thread::spawn(move || {
            if readiness {
                requesting_runtime.check(&requesting_id, None);
                false
            } else {
                requesting_runtime.claim_turn_request_for_host_settlement(&requesting_id)
            }
        });
        commit_entered
            .recv_timeout(Duration::from_secs(1))
            .expect("poisoned retained request reserved");

        let detection_started = Instant::now();
        let cancelling_runtime = runtime.clone();
        let cancelling = thread::spawn(move || {
            if shutdown {
                cancelling_runtime.cancel_for_app_shutdown_and_wait()
            } else {
                cancelling_runtime.cancel_for_workspace_change_and_wait(1)
            }
        });
        let observation_deadline = Instant::now() + Duration::from_secs(1);
        let newer_closed = loop {
            let control = runtime
                .active
                .control
                .lock()
                .expect_err("Runtime control remains poisoned")
                .into_inner();
            let observed = control
                .cancellation
                .filter(|cancellation| *cancellation != old_closed);
            if let Some(newer_closed) = observed {
                assert_eq!(control.closed_control_failure_token, Some(newer_closed));
                assert_eq!(
                    control.pending_request_id.as_deref(),
                    Some(request_id.as_str())
                );
                assert_ne!(control.effect_generation, 0);
                break newer_closed;
            }
            drop(control);
            assert!(Instant::now() <= observation_deadline);
            thread::yield_now();
        };
        let detection_observed = Instant::now();
        assert!(newer_closed.accepted_at >= detection_started);
        assert!(newer_closed.accepted_at <= detection_observed);
        assert_eq!(newer_closed.cleanup_cutoff, newer_closed.accepted_at);
        assert_eq!(newer_closed.terminal_cutoff, newer_closed.accepted_at);

        release_request_claim(&release_commit);
        assert!(!request.join().expect("superseded retained request"));
        assert!(!cancelling.join().expect("poisoned retained cleanup wait"));
        assert!(runtime.active.runtime_effect_trace().is_empty());
        {
            let control = runtime
                .active
                .control
                .lock()
                .expect_err("Runtime control remains poisoned until strict recovery")
                .into_inner();
            assert_eq!(control.cancellation, Some(newer_closed));
            assert_eq!(control.closed_control_failure_token, Some(newer_closed));
            assert!(control.request_id.is_none());
            assert!(control.pending_request_id.is_none());
            assert_eq!(control.effect_generation, 0);
        }

        assert!(runtime.active.claim_request("request-after-poisoned-proof"));
        assert!(!runtime.active.control.is_poisoned());
        assert!(runtime.cancellation_window_for_test().is_none());
        assert!(
            !runtime
                .active
                .closed_control_failure_cleanup
                .load(Ordering::Acquire)
        );
        runtime.finish_active_request_for_test();
    }

    #[test]
    fn poisoned_retained_turn_workspace_cancel_supersedes_the_old_closed_reservation() {
        assert_poisoned_retained_global_cancel_supersedes(false, false);
    }

    #[test]
    fn poisoned_retained_turn_shutdown_supersedes_the_old_closed_reservation() {
        assert_poisoned_retained_global_cancel_supersedes(false, true);
    }

    #[test]
    fn poisoned_retained_readiness_workspace_cancel_supersedes_the_old_closed_reservation() {
        assert_poisoned_retained_global_cancel_supersedes(true, false);
    }

    #[test]
    fn poisoned_retained_readiness_shutdown_supersedes_the_old_closed_reservation() {
        assert_poisoned_retained_global_cancel_supersedes(true, true);
    }

    #[test]
    fn tracked_readiness_workspace_is_revalidated_before_runtime_effects() {
        let runtime = RuntimeHost::unavailable_for_test();
        runtime
            .invalidated_workspace_generation
            .store(7, Ordering::Release);
        let selected = RuntimeReadinessWorkspace::tracked(PathBuf::from("/tmp/repository"), 7);

        let view = runtime.check_with_timeout(
            "request-stale-readiness-workspace",
            Some(&selected),
            Duration::from_secs(1),
        );

        assert_eq!(view.state, RuntimeReadinessState::Cancelled);
        assert!(runtime.active.runtime_effect_trace().is_empty());
        assert!(!runtime.active.running.load(Ordering::Acquire));
    }

    #[test]
    fn reserved_recovery_aborts_for_exact_new_user_cancel_and_excludes_a_second_claim() {
        let (runtime, old_closed) = runtime_with_retained_control_failure();
        let (commit_entered, release_commit) = runtime.install_request_commit_hook_for_test();
        let claiming_runtime = runtime.clone();
        let claiming = thread::spawn(move || {
            claiming_runtime
                .active
                .claim_request("request-reserved-user-cancel")
        });
        commit_entered
            .recv_timeout(Duration::from_secs(1))
            .expect("reserved claim before commit");

        assert!(
            !runtime.active.claim_request("request-second-claim"),
            "the pending identity and generation must exclude a second claim"
        );
        let accepted_at = Instant::now();
        install_exact_user_host_cancel(&runtime, "request-reserved-user-cancel", accepted_at);
        release_request_claim(&release_commit);
        assert!(!claiming.join().expect("reserved claim"));

        let retained = runtime
            .cancellation_window_for_test()
            .expect("old cleanup authority retained");
        assert_eq!(retained, old_closed);
        {
            let control = runtime.active.control.lock().expect("runtime control");
            assert_eq!(control.closed_control_failure_token, Some(old_closed));
            assert!(control.request_id.is_none());
            assert!(control.pending_request_id.is_none());
            assert_eq!(control.effect_generation, 0);
        }
        assert!(
            runtime
                .active
                .closed_control_failure_cleanup
                .load(Ordering::Acquire)
        );
        assert!(runtime.active.runtime_effect_trace().is_empty());

        assert!(runtime.active.claim_request("request-wrong-id"));
        assert!(runtime.cancellation_window_for_test().is_none());
        runtime.finish_active_request_for_test();
        assert!(runtime.active.runtime_effect_trace().is_empty());

        assert!(!runtime.active.claim_request("request-reserved-user-cancel"));
        let settled = settle_exact_host_cancel(&runtime, "request-reserved-user-cancel");
        assert_eq!(settled.accepted_at, accepted_at);
        assert_eq!(settled.source, CancellationSource::User);
        assert!(
            !runtime
                .active
                .closed_control_failure_cleanup
                .load(Ordering::Acquire)
        );
        assert!(
            runtime
                .active
                .control
                .lock()
                .expect("runtime control")
                .closed_control_failure_token
                .is_none()
        );
        runtime.finish_active_request_for_test();
    }

    #[test]
    fn reserved_recovery_aborts_for_new_control_failure_then_recovers_exactly() {
        let (runtime, old_closed) = runtime_with_retained_control_failure();
        let (commit_entered, release_commit) = runtime.install_request_commit_hook_for_test();
        let claiming_runtime = runtime.clone();
        let claiming = thread::spawn(move || {
            claiming_runtime
                .active
                .claim_request("request-reserved-control-failure")
        });
        commit_entered
            .recv_timeout(Duration::from_secs(1))
            .expect("reserved claim before commit");

        let detection_started = Instant::now();
        runtime.handoff_host_cancellation(
            UnmatchedHostCancellationPolicy::CloseContainment,
            || HostCancellationMutation::ControlFailed(()),
            |()| (),
        );
        let detection_observed = Instant::now();
        release_request_claim(&release_commit);
        assert!(!claiming.join().expect("reserved claim"));

        let newer_closed = runtime
            .cancellation_window_for_test()
            .expect("new ControlFailed authority retained");
        assert_ne!(newer_closed, old_closed);
        assert!(newer_closed.accepted_at >= detection_started);
        assert!(newer_closed.accepted_at <= detection_observed);
        assert_eq!(newer_closed.cleanup_cutoff, newer_closed.accepted_at);
        assert_eq!(newer_closed.terminal_cutoff, newer_closed.accepted_at);
        {
            let control = runtime.active.control.lock().expect("runtime control");
            assert_eq!(
                control.closed_control_failure_token,
                Some(newer_closed),
                "the marker must never exist without its exact closed token"
            );
            assert!(control.request_id.is_none());
            assert!(control.pending_request_id.is_none());
            assert_eq!(control.effect_generation, 0);
        }
        assert!(runtime.active.runtime_effect_trace().is_empty());

        assert!(
            runtime
                .active
                .claim_request("request-after-control-failure-proof")
        );
        assert!(runtime.cancellation_window_for_test().is_none());
        assert!(
            !runtime
                .active
                .closed_control_failure_cleanup
                .load(Ordering::Acquire)
        );
        runtime.finish_active_request_for_test();
    }

    #[test]
    fn poisoned_reserved_recovery_preserves_exact_new_host_cancel_until_recovery() {
        let (runtime, old_closed) = runtime_with_retained_control_failure();
        runtime.poison_control_for_test();
        let (commit_entered, release_commit) = runtime.install_request_commit_hook_for_test();
        let claiming_runtime = runtime.clone();
        let claiming = thread::spawn(move || {
            claiming_runtime
                .active
                .claim_request("request-poisoned-reserved-cancel")
        });
        commit_entered
            .recv_timeout(Duration::from_secs(1))
            .expect("poisoned reserved claim before commit");

        let accepted_at = Instant::now();
        install_exact_user_host_cancel(&runtime, "request-poisoned-reserved-cancel", accepted_at);
        release_request_claim(&release_commit);
        assert!(!claiming.join().expect("poisoned reserved claim"));
        {
            let control = runtime
                .active
                .control
                .lock()
                .expect_err("Runtime control remains poisoned")
                .into_inner();
            assert_eq!(control.cancellation, Some(old_closed));
            assert_eq!(control.closed_control_failure_token, Some(old_closed));
            assert!(control.request_id.is_none());
            assert!(control.pending_request_id.is_none());
            assert_eq!(control.effect_generation, 0);
        }

        assert!(runtime.active.claim_request("request-poison-recovery"));
        runtime.finish_active_request_for_test();
        assert!(!runtime.active.control.is_poisoned());
        assert!(
            !runtime
                .active
                .claim_request("request-poisoned-reserved-cancel")
        );
        let settled = settle_exact_host_cancel(&runtime, "request-poisoned-reserved-cancel");
        assert_eq!(settled.accepted_at, accepted_at);
        assert_eq!(settled.source, CancellationSource::User);
    }

    #[test]
    fn poisoned_reserved_handoff_retains_every_unmatched_exact_host_record() {
        let (runtime, old_closed) = runtime_with_retained_control_failure();
        runtime.poison_control_for_test();
        let (commit_entered, release_commit) = runtime.install_request_commit_hook_for_test();
        let claiming_runtime = runtime.clone();
        let claiming = thread::spawn(move || {
            claiming_runtime
                .active
                .claim_request("request-poison-first")
        });
        commit_entered
            .recv_timeout(Duration::from_secs(1))
            .expect("poisoned multi-record claim before commit");

        let first_accepted_at = Instant::now();
        let second_accepted_at = first_accepted_at + Duration::from_millis(1);
        runtime.handoff_host_cancellation(
            UnmatchedHostCancellationPolicy::Ignore,
            || {
                HostCancellationMutation::Completed(
                    (),
                    vec![
                        HostCancellationRecord {
                            accepted: AcceptedCancellation {
                                accepted_at: first_accepted_at,
                                source: CancellationSource::User,
                            },
                            request_id: "request-poison-first".to_owned(),
                        },
                        HostCancellationRecord {
                            accepted: AcceptedCancellation {
                                accepted_at: second_accepted_at,
                                source: CancellationSource::RendererLost,
                            },
                            request_id: "request-poison-second".to_owned(),
                        },
                    ],
                )
            },
            |()| (),
        );
        release_request_claim(&release_commit);
        assert!(!claiming.join().expect("poisoned multi-record claim"));
        assert_eq!(runtime.cancellation_window_for_test(), Some(old_closed));

        assert!(runtime.active.claim_request("request-poison-wrong"));
        assert!(runtime.cancellation_window_for_test().is_none());
        runtime.finish_active_request_for_test();

        assert!(!runtime.active.claim_request("request-poison-first"));
        let first = settle_exact_host_cancel(&runtime, "request-poison-first");
        assert_eq!(first.accepted_at, first_accepted_at);
        assert_eq!(first.source, CancellationSource::User);

        let second = settle_exact_host_cancel(&runtime, "request-poison-second");
        assert_eq!(second.accepted_at, second_accepted_at);
        assert_eq!(second.source, CancellationSource::RendererLost);
        assert!(runtime.active.runtime_effect_trace().is_empty());
    }

    #[test]
    fn post_begin_rollback_preserves_newer_authority_and_old_cleanup_marker() {
        let (runtime, old_closed) = runtime_with_retained_control_failure();
        let (rollback_entered, release_rollback) =
            runtime.install_post_begin_rollback_hook_for_test();
        let claiming_runtime = runtime.clone();
        let claiming = thread::spawn(move || {
            claiming_runtime
                .active
                .claim_request("request-post-begin-cancel")
        });
        rollback_entered
            .recv_timeout(Duration::from_secs(1))
            .expect("post-begin rollback pause");

        let accepted_at = Instant::now() - TURN_TERMINAL_BUDGET - Duration::from_millis(1);
        install_exact_user_host_cancel(&runtime, "request-post-begin-cancel", accepted_at);
        release_request_claim(&release_rollback);
        assert!(!claiming.join().expect("post-begin claim"));
        let retained = runtime
            .cancellation_window_for_test()
            .expect("post-begin cleanup authority");
        assert_eq!(retained, old_closed);
        {
            let control = runtime.active.control.lock().expect("runtime control");
            assert_eq!(control.closed_control_failure_token, Some(old_closed));
            assert!(control.request_id.is_none());
            assert!(control.pending_request_id.is_none());
            assert_eq!(control.effect_generation, 0);
        }
        assert!(!runtime.active.running.load(Ordering::Acquire));
        assert!(runtime.active.runtime_effect_trace().is_empty());

        assert!(runtime.active.claim_request("request-post-begin-wrong-id"));
        assert!(runtime.cancellation_window_for_test().is_none());
        runtime.finish_active_request_for_test();
        assert!(runtime.active.runtime_effect_trace().is_empty());

        assert!(!runtime.active.claim_request("request-post-begin-cancel"));
        let settled = settle_exact_host_cancel(&runtime, "request-post-begin-cancel");
        assert_eq!(settled.accepted_at, accepted_at);
        assert_eq!(settled.source, CancellationSource::User);
    }

    #[test]
    fn every_stale_cancellation_signal_refuses_newer_process_authority() {
        #[derive(Clone, Copy, Debug)]
        enum SignalCase {
            ExactHostRequest,
            DeferredHostRequest,
            DeferredContainment,
            RendererLoss,
            ContainmentFailure,
            AppShutdown,
            HostControlFailed,
        }

        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for signal_case in [
            SignalCase::ExactHostRequest,
            SignalCase::DeferredHostRequest,
            SignalCase::DeferredContainment,
            SignalCase::RendererLoss,
            SignalCase::ContainmentFailure,
            SignalCase::AppShutdown,
            SignalCase::HostControlFailed,
        ] {
            let runtime = RuntimeHost::unavailable_for_test();
            runtime.set_active_request_for_test("request-old-signal");
            let mut old_child = Command::new("/bin/sh")
                .args(["-c", "trap '' TERM; while :; do /bin/sleep 1; done"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .expect("old signal fixture");
            let old_group = old_child.id() as i32;
            assert!(publish_active_process_group(&runtime.active, old_group));
            register_owned_process(&runtime.active, old_group);
            let old_identity = runtime
                .active
                .process_group
                .lock()
                .expect("old process identity")
                .expect("old process published");

            let (signal_entered, release_signal) =
                runtime.install_cancellation_signal_hook_for_test();
            let cancelling_runtime = runtime.clone();
            let cancellation = thread::spawn(move || match signal_case {
                SignalCase::ExactHostRequest => cancelling_runtime.accept_request_cancellation(
                    "request-old-signal",
                    AcceptedCancellation {
                        accepted_at: Instant::now(),
                        source: CancellationSource::User,
                    },
                ),
                SignalCase::DeferredHostRequest => {
                    cancelling_runtime.defer_host_cancellations(&[HostCancellationRecord {
                        accepted: AcceptedCancellation {
                            accepted_at: Instant::now(),
                            source: CancellationSource::RendererLost,
                        },
                        request_id: "request-old-signal".to_owned(),
                    }]);
                }
                SignalCase::DeferredContainment => {
                    cancelling_runtime.defer_containment_failure();
                }
                SignalCase::RendererLoss => cancelling_runtime.cancel_for_renderer_loss(),
                SignalCase::ContainmentFailure => {
                    cancelling_runtime.cancel_for_containment_failure();
                }
                SignalCase::AppShutdown => cancelling_runtime.cancel_for_app_shutdown(),
                SignalCase::HostControlFailed => {
                    cancelling_runtime.handoff_host_cancellation(
                        UnmatchedHostCancellationPolicy::Ignore,
                        || HostCancellationMutation::ControlFailed(()),
                        |()| (),
                    );
                }
            });
            signal_entered
                .recv_timeout(Duration::from_secs(1))
                .unwrap_or_else(|_| panic!("{signal_case:?} installed before signal"));

            signal_process_group(old_group, SIGKILL);
            old_child.wait().expect("old process reaped");
            assert!(retire_active_process_group(&runtime.active, old_identity));
            runtime.finish_active_request_for_test();
            assert!(runtime.active.claim_request("request-new-signal"));

            let mut new_child = Command::new("/bin/sh")
                .args(["-c", "while :; do /bin/sleep 1; done"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .expect("new signal fixture");
            let new_group = new_child.id() as i32;
            assert!(publish_active_process_group(&runtime.active, new_group));
            register_owned_process(&runtime.active, new_group);
            let new_identity = runtime
                .active
                .process_group
                .lock()
                .expect("new process identity")
                .expect("new process published");

            release_request_claim(&release_signal);
            cancellation.join().expect("stale cancellation signal");
            assert_eq!(new_child.try_wait().expect("new process state"), None);
            assert!(process_group_exists(new_group));

            signal_process_group(new_group, SIGKILL);
            new_child.wait().expect("new process reaped");
            assert!(retire_active_process_group(&runtime.active, new_identity));
            runtime.finish_active_request_for_test();
        }
    }

    #[test]
    fn stale_signal_authority_refuses_replaced_token_with_same_request_generation_and_process() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for control_failed in [false, true] {
            let runtime = RuntimeHost::unavailable_for_test();
            runtime.set_active_request_for_test("request-token-replaced");
            let mut child = Command::new("/bin/sleep")
                .arg("30")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .expect("token replacement signal fixture");
            let process_group = child.id() as i32;
            assert!(publish_active_process_group(&runtime.active, process_group));
            register_owned_process(&runtime.active, process_group);
            let identity = runtime
                .active
                .process_group
                .lock()
                .expect("token replacement identity")
                .expect("published token replacement process");
            let (signal_entered, release_signal) =
                runtime.install_cancellation_signal_hook_for_test();
            let cancelling_runtime = runtime.clone();
            let cancellation = thread::spawn(move || {
                if control_failed {
                    cancelling_runtime.handoff_host_cancellation(
                        UnmatchedHostCancellationPolicy::Ignore,
                        || HostCancellationMutation::ControlFailed(()),
                        |()| (),
                    );
                } else {
                    cancelling_runtime.accept_request_cancellation(
                        "request-token-replaced",
                        AcceptedCancellation {
                            accepted_at: Instant::now(),
                            source: CancellationSource::User,
                        },
                    );
                }
            });
            signal_entered
                .recv_timeout(Duration::from_secs(1))
                .expect("signal authority captured");
            {
                let mut control = runtime.active.control.lock().expect("replace signal token");
                let replacement = AcceptedRuntimeCancellation::closed(Instant::now());
                control.cancellation = Some(replacement);
                if control.closed_control_failure_token.is_some() {
                    control.closed_control_failure_token = Some(replacement);
                }
            }
            release_request_claim(&release_signal);
            cancellation.join().expect("stale token signal");
            assert_eq!(child.try_wait().expect("replacement process state"), None);
            assert!(process_group_exists(process_group));

            signal_process_group(process_group, SIGKILL);
            child.wait().expect("token replacement process reaped");
            assert!(retire_active_process_group(&runtime.active, identity));
            runtime.finish_active_request_for_test();
        }
    }

    #[test]
    fn unmatched_deferred_host_record_never_acquires_active_signal_authority() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let runtime = RuntimeHost::unavailable_for_test();
        runtime.set_active_request_for_test("request-active-unmatched");
        let mut child = Command::new("/bin/sh")
            .args(["-c", "while :; do /bin/sleep 1; done"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("unmatched signal fixture");
        let process_group = child.id() as i32;
        assert!(publish_active_process_group(&runtime.active, process_group));
        register_owned_process(&runtime.active, process_group);
        let identity = runtime
            .active
            .process_group
            .lock()
            .expect("unmatched process identity")
            .expect("unmatched process published");
        let (_signal_entered, _release_signal) =
            runtime.install_cancellation_signal_hook_for_test();

        runtime.defer_host_cancellations(&[HostCancellationRecord {
            accepted: AcceptedCancellation {
                accepted_at: Instant::now(),
                source: CancellationSource::RendererLost,
            },
            request_id: "request-other-unmatched".to_owned(),
        }]);

        assert!(runtime.cancellation_window_for_test().is_none());
        assert!(
            runtime
                .active
                .cancellation_signal_hook
                .lock()
                .expect("unused signal hook")
                .take()
                .is_some(),
            "an unmatched record must not reach the signal boundary"
        );
        assert_eq!(child.try_wait().expect("unmatched process state"), None);
        signal_process_group(process_group, SIGKILL);
        child.wait().expect("unmatched process reaped");
        assert!(retire_active_process_group(&runtime.active, identity));
        runtime.finish_active_request_for_test();
    }

    #[test]
    fn reentrant_host_settlement_defers_then_materializes_without_control_deadlock() {
        let runtime = RuntimeHost::unavailable_for_test();
        runtime.set_active_request_for_test("request-reentrant-settlement");
        let accepted = AcceptedCancellation {
            accepted_at: Instant::now(),
            source: CancellationSource::RendererLost,
        };

        let (published, finalized) = runtime.settle_host_turn(
            "request-reentrant-settlement",
            |refresh_acceptance, _control_failed| {
                runtime.defer_host_cancellations(&[HostCancellationRecord {
                    accepted,
                    request_id: "request-reentrant-settlement".to_owned(),
                }]);
                refresh_acceptance()
            },
            |published, finalized| (published, finalized),
        );

        assert_eq!(published, Some(accepted));
        assert_eq!(finalized, Some(accepted));
        assert!(!runtime.active.running.load(Ordering::Acquire));
    }

    #[test]
    fn saturated_reentrant_public_containment_is_bound_to_the_active_owner() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let runtime = RuntimeHost::unavailable_for_test();
        runtime.set_active_request_for_test("request-reentrant-saturated");
        let mut child = Command::new("/bin/sleep")
            .arg("10")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("reentrant signal fixture");
        let process_group = child.id() as i32;
        assert!(publish_active_process_group(&runtime.active, process_group));
        register_owned_process(&runtime.active, process_group);
        let identity = runtime
            .active
            .process_group
            .lock()
            .expect("reentrant process identity")
            .expect("reentrant process published");
        let records = (0..MAX_DEFERRED_CANCELLATIONS)
            .map(|index| HostCancellationRecord {
                accepted: AcceptedCancellation {
                    accepted_at: Instant::now(),
                    source: CancellationSource::RendererLost,
                },
                request_id: format!("request-saturated-unmatched-{index}"),
            })
            .collect::<Vec<_>>();
        runtime.active.defer_host_cancellations(&records);
        let before = Instant::now();
        let (signal_entered, release_signal) = runtime.install_cancellation_signal_hook_for_test();
        let (callback_complete, callback_observed) = mpsc::sync_channel(1);
        let cancelling_runtime = runtime.clone();
        let cancellation = thread::spawn(move || {
            cancelling_runtime.handoff_host_cancellation(
                UnmatchedHostCancellationPolicy::Ignore,
                || HostCancellationMutation::Completed((), Vec::new()),
                |()| {
                    cancelling_runtime.defer_host_cancellations(&[]);
                    callback_complete.send(()).expect("callback completion");
                },
            );
        });
        callback_observed
            .recv_timeout(Duration::from_secs(1))
            .expect("reentrant callback completes without control deadlock");
        signal_entered
            .recv_timeout(Duration::from_secs(1))
            .expect("exact signal waits until after the action fence");
        assert_eq!(child.try_wait().expect("pre-signal child state"), None);
        release_request_claim(&release_signal);
        cancellation.join().expect("reentrant cancellation");

        let control = runtime.active.control.lock().expect("reentrant owner");
        let cancellation = control
            .cancellation
            .expect("saturated containment belongs to active request");
        assert_eq!(
            control.request_id.as_deref(),
            Some("request-reentrant-saturated")
        );
        assert_eq!(cancellation.reason, RuntimeCancellation::ContainmentFailure);
        assert!(cancellation.terminal_cutoff <= Instant::now());
        assert!(cancellation.accepted_at >= before);
        assert!(runtime.active.deferred_cancellation_overflowed());
        assert!(
            runtime
                .active
                .saturated_containment
                .lock()
                .expect("saturated containment")
                .is_none()
        );
        drop(control);
        child.wait().expect("signalled child reaped");
        assert!(retire_active_process_group(&runtime.active, identity));
        runtime.finish_active_request_for_test();
    }

    #[test]
    fn host_runtime_ownership_two_wave_filters_then_settles_exactly() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let runtime = RuntimeHost::unavailable_for_test();
        let mut lifecycle = HostLifecycle::default();
        let first_nonce = "6".repeat(64);
        let first_generation = lifecycle
            .begin_renderer_session(first_nonce.clone())
            .expect("first renderer");
        let first_sender = lifecycle.sender_for_document(
            "main",
            "tauri://localhost",
            first_generation,
            &first_nonce,
        );
        let mut non_runtime = Vec::new();
        for sequence in 1..=MAX_DEFERRED_CANCELLATIONS as u64 {
            let request_id = canonical_request_id(first_generation, sequence).unwrap();
            let request = serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "requestId": request_id,
                "sequence": sequence,
                "timeoutMs": 1_000,
                "operation": { "kind": "application-health" }
            }))
            .unwrap();
            non_runtime.push(
                lifecycle
                    .begin_application_request(&first_sender, &request)
                    .expect("non-Runtime Host request"),
            );
        }
        let first_records = lifecycle.renderer_lost();
        assert!(first_records.is_empty());
        runtime.handoff_host_cancellation(
            UnmatchedHostCancellationPolicy::CloseContainment,
            || HostCancellationMutation::Completed((), first_records),
            |()| (),
        );
        assert!(!runtime.active.deferred_cancellation_overflowed());
        assert!(runtime.cancellation_window_for_test().is_none());
        for request in non_runtime {
            assert!(
                lifecycle
                    .complete_application_request(request)
                    .contains("cancelled")
            );
        }

        let second_nonce = "7".repeat(64);
        let second_generation = lifecycle
            .begin_renderer_session(second_nonce.clone())
            .expect("second renderer");
        let second_sender = lifecycle.sender_for_document(
            "main",
            "tauri://localhost",
            second_generation,
            &second_nonce,
        );
        let request_id = canonical_request_id(second_generation, 1).unwrap();
        let request = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "requestId": request_id,
            "sequence": 1,
            "timeoutMs": 120_000,
            "operation": {
                "kind": "codex-turn-start",
                "workspaceGeneration": 1,
                "task": "Bounded task."
            }
        }))
        .unwrap();
        let accepted_request = lifecycle
            .begin_application_request(&second_sender, &request)
            .expect("Runtime-owned turn");
        runtime.set_active_request_for_test(&request_id);
        let child = Command::new("/bin/sh")
            .args(["-c", "trap '' TERM; while :; do /bin/sleep 1; done"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("TERM-resistant Runtime group");
        let process_group = child.id() as i32;
        assert!(publish_active_process_group(&runtime.active, process_group));
        register_owned_process(&runtime.active, process_group);
        drop(child);
        let records = lifecycle.renderer_lost();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].request_id, request_id);
        let literal = records[0].accepted;
        let (signal_entered, release_signal) = runtime.install_cancellation_signal_hook_for_test();
        let cancelling_runtime = runtime.clone();
        let cancellation = thread::spawn(move || {
            cancelling_runtime.handoff_host_cancellation(
                UnmatchedHostCancellationPolicy::CloseContainment,
                || HostCancellationMutation::Completed((), records),
                |()| (),
            );
        });
        signal_entered
            .recv_timeout(Duration::from_secs(1))
            .expect("post-fence exact signal authority");
        release_request_claim(&release_signal);
        cancellation.join().expect("literal Host handoff");
        let exact = runtime
            .cancellation_window_for_test()
            .expect("exact Runtime cancellation");
        assert_eq!(exact.host_acceptance, Some(literal));
        assert_eq!(
            exact.terminal_cutoff,
            literal.accepted_at + TURN_TERMINAL_BUDGET
        );
        assert!(reconcile_retained_process_group(
            &runtime.active,
            Instant::now() + Duration::from_secs(1)
        ));
        assert_eq!(settle_exact_host_cancel(&runtime, &request_id), literal);
        let mut turn = TurnSession::new(
            second_generation,
            1,
            1,
            "Bounded task.".to_owned(),
            RuntimeDescriptor::approved(),
        )
        .expect("turn session");
        turn.fail(TurnState::Failed, TurnReason::InternalFailure)
            .expect("failed no-effect turn");
        turn.settle_cleanup(true).expect("strict cleanup");
        let encoded = lifecycle.complete_turn_request(accepted_request, turn.view());
        assert!(encoded.contains(r#""state":"cancelled""#));
        assert!(!runtime.active.deferred_cancellation_overflowed());
        assert!(
            runtime
                .active
                .claim_request("request-fresh-after-two-waves")
        );
        runtime.finish_active_request_for_test();
    }

    #[test]
    fn failed_claim_disposition_reads_exact_control_authority_at_capacity() {
        let runtime = RuntimeHost::unavailable_for_test();
        let request_id = "request-failed-claim-control-owner";
        let accepted = AcceptedCancellation {
            accepted_at: Instant::now() - Duration::from_millis(19),
            source: CancellationSource::RendererLost,
        };
        runtime.accept_request_cancellation(request_id, accepted);
        let records = (0..=MAX_DEFERRED_CANCELLATIONS)
            .map(|index| HostCancellationRecord {
                accepted: AcceptedCancellation {
                    accepted_at: Instant::now(),
                    source: CancellationSource::User,
                },
                request_id: format!("request-failed-claim-fill-{index}"),
            })
            .collect::<Vec<_>>();
        runtime.active.defer_host_cancellations(&records);

        assert_eq!(
            runtime.claim_turn_request_for_host_settlement_disposition(request_id),
            HostTurnClaimDisposition::Cancelled
        );
        assert!(!runtime.active.running.load(Ordering::Acquire));
        assert_eq!(settle_exact_host_cancel(&runtime, request_id), accepted);
        assert!(
            !runtime
                .active
                .claim_request("request-overflow-remains-global")
        );
    }

    #[test]
    fn poison_settlement_keeps_one_closed_marker_token_then_recovers_fresh() {
        for readiness in [false, true] {
            let runtime = RuntimeHost::unavailable_for_test();
            let request_id = format!("request-poison-deferred-{readiness}");
            let accepted = AcceptedCancellation {
                accepted_at: Instant::now(),
                source: CancellationSource::RendererLost,
            };
            runtime
                .active
                .defer_host_cancellations(&[HostCancellationRecord {
                    accepted,
                    request_id: request_id.clone(),
                }]);
            runtime.poison_control_for_test();
            if readiness {
                let view = runtime.settle_host_readiness(
                    &request_id,
                    RuntimeReadinessView::terminal(RuntimeReadinessState::Ready, 0),
                    std::convert::identity,
                );
                assert_eq!(view.state, RuntimeReadinessState::Cancelled);
            } else {
                assert_eq!(settle_exact_host_cancel(&runtime, &request_id), accepted);
            }
            let control = runtime
                .active
                .control
                .lock()
                .expect_err("poison remains until strict recovery")
                .into_inner();
            assert_eq!(control.cancellation, control.closed_control_failure_token);
            assert!(control.cancellation.is_some());
            assert!(control.request_id.is_none());
            assert!(control.pending_request_id.is_none());
            drop(control);

            let fresh = format!("request-poison-recovered-{readiness}");
            assert!(runtime.active.claim_request(&fresh));
            assert!(runtime.cancellation_window_for_test().is_none());
            assert!(!runtime.active.control.is_poisoned());
            runtime.finish_active_request_for_test();
        }
    }

    #[test]
    fn failed_preflight_channel_send_cancels_before_runtime_or_provider_effects() {
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository identity");
        fs::create_dir(repository.join(".git")).expect("repository marker");
        let runtime = fixture.scripted_host(
            r#"#!/bin/sh
printf spawned > "$CODEX_HOME/provider-write"
exit 0
"#,
        );
        let process_published = runtime.active.observe_next_process_group();
        let mut workspace = crate::WorkspaceHost::default();
        let workspace_generation = match workspace
            .select(crate::FolderPickerResult::Selected(repository))
            .expect("workspace selection")
        {
            keiko_application::workspace::WorkspaceView::Bound { generation, .. } => generation,
            _ => panic!("bound workspace"),
        };
        let nonce = "d".repeat(64);
        let mut lifecycle = crate::HostLifecycle::default();
        let generation = lifecycle
            .begin_renderer_session(nonce.clone())
            .expect("renderer generation");
        let sender = lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce);
        let request_id = keiko_ui_port::canonical_request_id(generation, 1).unwrap();
        let request = format!(
            r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":5000,"operation":{{"kind":"codex-turn-start","workspaceGeneration":{workspace_generation},"task":"Bounded task."}}}}"#
        );
        let lifecycle = Mutex::new(lifecycle);
        let mut first = true;

        let output = crate::turn::turn_request_with_channel(
            &lifecycle,
            &Mutex::new(workspace),
            &runtime,
            &sender,
            &request,
            |_, _| {
                if first {
                    first = false;
                    let records = crate::tauri_adapter::lose_renderer(&lifecycle);
                    runtime.defer_host_cancellations(&records);
                    false
                } else {
                    true
                }
            },
        );

        assert!(output.encoded.contains(r#""state":"cancelled""#));
        assert!(output.encoded.contains(r#""reason":"renderer-lost""#));
        assert!(
            process_published
                .recv_timeout(Duration::from_millis(10))
                .is_err()
        );
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
        assert!(!fixture.home.join("provider-write").exists());
    }

    #[test]
    fn poisoned_control_preserves_or_closes_the_existing_cancellation_window() {
        let host = RuntimeHost::from_configuration(None);
        let accepted_at = Instant::now();
        host.cancel_request_at("request-poison-window", accepted_at);
        let first = host
            .active
            .cancellation_window()
            .expect("first accepted cancellation");
        let _ = std::panic::catch_unwind({
            let active = Arc::clone(&host.active);
            move || {
                let _control = active.control.lock().expect("control before poison");
                panic!("poison runtime control");
            }
        });

        let poisoned = host
            .active
            .cancellation_window()
            .expect("fail-safe cancellation");
        let repeated = host
            .active
            .cancellation_window()
            .expect("stable fail-safe cancellation");
        assert_eq!(poisoned.accepted_at, first.accepted_at);
        assert_eq!(poisoned.cleanup_cutoff, first.cleanup_cutoff);
        assert_eq!(poisoned.terminal_cutoff, first.terminal_cutoff);
        assert_eq!(poisoned.reason, RuntimeCancellation::ContainmentFailure);
        assert_eq!(repeated, poisoned, "poison reads must not restart a budget");
    }

    #[test]
    fn cleanup_worker_spawn_failure_is_fallible_and_retained() {
        let fixture = Fixture::new();
        let directory = fixture.work.join("spawn-failure");
        fs::create_dir(&directory).expect("private directory");
        let active = ActiveRuntime::default();
        let now = Instant::now();

        let cleaned = cleanup_or_track_work_directory_until_with(
            &active,
            &directory,
            now + Duration::from_secs(5),
            now,
            |_task| Err(io::Error::other("injected spawn failure")),
            || {},
        );

        assert!(!cleaned);
        assert!(
            active
                .retained_work_directories
                .lock()
                .expect("retained work")
                .contains(&directory),
            "failed worker creation must fail closed and retain owned cleanup"
        );
    }

    #[test]
    fn cleanup_worker_spawn_panic_is_caught_and_retained() {
        let fixture = Fixture::new();
        let directory = fixture.work.join("spawn-panic");
        fs::create_dir(&directory).expect("private directory");
        let active = ActiveRuntime::default();
        let now = Instant::now();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            cleanup_or_track_work_directory_until_with(
                &active,
                &directory,
                now + Duration::from_secs(5),
                now,
                |_task| panic!("injected spawn panic"),
                || {},
            )
        }));

        assert!(matches!(result, Ok(false)), "spawn unwind must fail closed");
        assert!(
            active
                .retained_work_directories
                .lock()
                .expect("retained work")
                .contains(&directory)
        );
    }

    #[test]
    fn disconnected_panicked_cleanup_recovery_never_falls_back_to_caller_io() {
        let fixture = Fixture::new();
        let directory = fixture.work.join("disconnected-cleanup");
        fs::create_dir(&directory).expect("private directory");
        let active = ActiveRuntime::default();
        retain_work_directory(&active, &directory);
        let (sender, completed) = mpsc::sync_channel(1);
        drop(sender);
        let worker = thread::spawn(|| panic!("injected cleanup worker panic"));
        active
            .tracked_directory_cleanups
            .lock()
            .expect("tracked cleanup")
            .push(TrackedDirectoryCleanup {
                path: directory.clone(),
                completed,
                worker,
            });

        assert!(
            !reconcile_retained_work_directories(&active),
            "recovery must retain and schedule bounded owned work after disconnect"
        );
        assert_eq!(
            active
                .tracked_directory_cleanups
                .lock()
                .expect("bounded owned recovery")
                .len(),
            1,
            "recovery must remain represented by one owned worker until joined"
        );
    }

    #[test]
    fn poisoned_handoff_without_a_prior_window_closes_immediately() {
        let host = RuntimeHost::from_configuration(None);
        let _ = std::panic::catch_unwind({
            let active = Arc::clone(&host.active);
            move || {
                let _control = active.control.lock().expect("control before poison");
                panic!("poison before adapter handoff");
            }
        });
        let handed_off_at = Instant::now();
        let host_mutated = Arc::new(AtomicBool::new(false));
        let mutation = Arc::clone(&host_mutated);
        host.handoff_host_cancellation(
            UnmatchedHostCancellationPolicy::Ignore,
            || {
                mutation.store(true, Ordering::Release);
                HostCancellationMutation::Completed(
                    (),
                    vec![HostCancellationRecord {
                        accepted: AcceptedCancellation {
                            accepted_at: handed_off_at,
                            source: CancellationSource::User,
                        },
                        request_id: "request-poisoned-handoff".to_owned(),
                    }],
                )
            },
            |()| (),
        );

        let window = host
            .cancellation_window_for_test()
            .expect("closed fail-safe window");
        let observed_after_handoff = Instant::now();
        assert!(
            window.terminal_cutoff <= observed_after_handoff
                && window.cleanup_cutoff == window.accepted_at
                && window.terminal_cutoff == window.accepted_at,
            "poison before the first window must not grant a future budget"
        );
        assert!(host_mutated.load(Ordering::Acquire));
        assert_eq!(window.reason, RuntimeCancellation::ContainmentFailure);
    }

    #[test]
    fn cancellation_after_directory_cleanup_starts_adopts_the_host_cutoff() {
        let fixture = Fixture::new();
        let directory = fixture.work.join("active-cleanup-cancel");
        fs::create_dir(&directory).expect("private directory");
        let host = RuntimeHost::from_configuration(None);
        let accepted_at = Instant::now();
        let (started_sender, started_receiver) = mpsc::sync_channel(1);
        let (release_sender, release_receiver) = mpsc::sync_channel(1);
        let active = Arc::clone(&host.active);

        let cleaned = cleanup_or_track_work_directory_until_with(
            &host.active,
            &directory,
            accepted_at + Duration::from_secs(120),
            accepted_at + Duration::from_millis(4_600),
            move |task| {
                thread::Builder::new()
                    .name("keiko-turn-directory-cleanup-test".to_owned())
                    .spawn(move || {
                        started_sender.send(()).expect("cleanup started");
                        release_receiver
                            .recv_timeout(Duration::from_secs(1))
                            .expect("release cleanup before bounded deadline");
                        task();
                    })
            },
            move || {
                started_receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("worker started before bounded deadline");
                active.running.store(true, Ordering::Release);
                active.control.lock().expect("active request").request_id =
                    Some("request-active-cleanup".to_owned());
                let runtime = RuntimeHost {
                    configuration: None,
                    active,
                    work_generation: Arc::new(AtomicU64::new(0)),
                    invalidated_workspace_generation: Arc::new(AtomicU64::new(0)),
                };
                runtime.cancel_request_at("request-active-cleanup", accepted_at);
                release_sender.send(()).expect("release cleanup");
            },
        );

        assert!(
            !cleaned,
            "cleanup completing after the accepted +4,500ms cutoff cannot be credited"
        );
    }

    #[test]
    fn accepted_cancel_linearizes_before_frame_mutation() {
        let fixture = Fixture::new();
        let active = ActiveRuntime::default();
        active.running.store(true, Ordering::Release);
        active.control.lock().expect("active request").request_id =
            Some("request-frame-race".to_owned());
        let mut projection = TurnProtocolProjection::new(&fixture.home, &fixture.work);
        let frame = serde_json::to_vec(&json!({
            "id": 1,
            "result": {
                "codexHome": fixture.home,
                "platformFamily": "unix",
                "platformOs": "macos",
                "userAgent": "codex_cli_rs/0.145.0"
            }
        }))
        .expect("initialize frame");

        let result = accept_turn_frame_with(&active, &mut projection, &frame, || {
            active.cancel(RuntimeCancellation::User);
        });

        assert_eq!(result, Err(RuntimeCancellation::User));
        assert_eq!(
            projection.stage,
            TurnProjectionStage::Initialize,
            "cancel-won frames must not mutate projection"
        );
    }

    #[test]
    fn accepted_cancel_after_projection_is_fenced_before_action_callback() {
        let fixture = Fixture::new();
        let active = ActiveRuntime::default();
        active.running.store(true, Ordering::Release);
        active.control.lock().expect("active request").request_id =
            Some("request-projection-fence".to_owned());
        let mut projection = TurnProtocolProjection::new(&fixture.home, &fixture.work);
        let action = projection.accept(
            &serde_json::to_vec(&json!({
                "id": 1,
                "result": {
                    "codexHome": fixture.home,
                    "platformFamily": "unix",
                    "platformOs": "macos",
                    "userAgent": "codex_cli_rs/0.145.0"
                }
            }))
            .expect("initialize frame"),
        );
        assert_eq!(action, TurnProjectionAction::SendAccountRead);

        let mut callback_runs = 0;
        match lock_projection_action_with(&active, || {
            active.defer_cancellation(AcceptedRuntimeCancellation::new(
                RuntimeCancellation::User,
                Instant::now(),
            ));
        }) {
            Ok(guard) => {
                callback_runs += 1;
                drop(guard);
            }
            Err(cancellation) => assert_eq!(cancellation, RuntimeCancellation::User),
        }

        assert_eq!(
            callback_runs, 0,
            "cancel-won actions must not reach callbacks"
        );
    }

    #[test]
    fn initialize_write_linearizes_after_prompt_cancellation_without_provider_bytes() {
        let active = Arc::new(ActiveRuntime::default());
        assert!(active.claim_request("initialize-linearization"));
        let (effect_started, release_effect) =
            active.install_runtime_effect_hook(RuntimeEffectStage::InitializeWrite);
        let writing_active = Arc::clone(&active);
        let pending = thread::spawn(move || {
            let mut provider_bytes = Vec::new();
            let result =
                runtime_effect(&writing_active, RuntimeEffectStage::InitializeWrite, || {
                    write_json_line(&mut provider_bytes, &json!({"method":"initialize","id":1}))
                });
            (result, provider_bytes)
        });
        effect_started
            .recv_timeout(Duration::from_secs(1))
            .expect("initialize boundary entered");
        let acceptance_started = Instant::now();
        active.cancel(RuntimeCancellation::User);
        assert!(
            acceptance_started.elapsed() < Duration::from_millis(100),
            "initialize boundary blocked cancellation acceptance"
        );
        {
            let (released, wake) = &*release_effect;
            *released.lock().expect("initialize release") = true;
            wake.notify_all();
        }
        let (result, provider_bytes) = pending.join().expect("initialize writer");

        assert!(matches!(
            result,
            RuntimeEffectResult::Rejected(RuntimeCancellation::User)
        ));
        assert!(
            provider_bytes.is_empty(),
            "cancel-won initialize must write zero provider bytes"
        );
        active.finish_request();
    }

    #[test]
    fn cancel_terminal_is_bounded_while_reversible_work_remains_owned_for_rollback() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let repository = fixture.root.join("repository");
        fs::create_dir(&repository).expect("repository identity");
        fs::create_dir(repository.join(".git")).expect("repository marker");
        let host = fixture.scripted_host("#!/bin/sh\nwhile :; do /bin/sleep 1; done\n");
        let (effect_started, release_effect) = host
            .active
            .install_runtime_effect_hook(RuntimeEffectStage::Directory);
        let running_host = host.clone();
        let running_repository = repository.clone();
        let pending = thread::spawn(move || {
            running_host.run_turn(
                "bounded-owned-effect",
                1,
                &WorkspaceRuntimeBinding::for_test(&running_repository),
                "Bounded task.",
                Duration::from_secs(30),
                |_| {},
            )
        });
        effect_started
            .recv_timeout(Duration::from_secs(1))
            .expect("directory effect entered");
        host.cancel_request_at(
            "bounded-owned-effect",
            Instant::now() - TURN_TERMINAL_BUDGET - Duration::from_millis(1),
        );
        let return_deadline = Instant::now() + Duration::from_millis(250);
        while !pending.is_finished() && Instant::now() < return_deadline {
            thread::yield_now();
        }
        let terminal_was_bounded = pending.is_finished();
        let fresh_was_blocked = !host.active.claim_request("effect-still-owned");
        if !fresh_was_blocked {
            host.active.finish_request();
        }
        let workspace_cleanup_was_proven = host.cancel_for_workspace_change_and_wait(1);
        {
            let (released, wake) = &*release_effect;
            *released.lock().expect("effect release") = true;
            wake.notify_all();
        }
        let outcome = pending.join().expect("bounded turn outcome");
        let recovery_deadline = Instant::now() + Duration::from_secs(1);
        let recovered = loop {
            if host.active.claim_request("effect-rollback-recovered") {
                break true;
            }
            if Instant::now() >= recovery_deadline {
                break false;
            }
            thread::yield_now();
        };
        if recovered {
            host.active.finish_request();
        }

        assert!(
            terminal_was_bounded,
            "accepted cancellation must settle while reversible work is still blocked"
        );
        assert!(
            fresh_was_blocked,
            "unfinished work must block a fresh claim"
        );
        assert!(
            !workspace_cleanup_was_proven,
            "workspace replacement must not report cleanup while an effect worker remains owned"
        );
        assert_eq!(outcome.state, TurnState::CleanupFailed);
        assert!(!outcome.cleaned);
        assert!(recovered, "completed rollback must permit recovery");
        assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
    }

    #[test]
    fn blocked_terminal_publication_remains_owned_and_cannot_block_settlement() {
        let host = RuntimeHost::unavailable_for_test();
        host.set_active_request_for_test("terminal-publication");
        let (started_sender, started_receiver) = mpsc::sync_channel(1);
        let (release_sender, release_receiver) = mpsc::sync_channel(1);
        let publishing_host = host.clone();
        let pending = thread::spawn(move || {
            publishing_host.publish_terminal_update(move || {
                started_sender.send(()).expect("publication started");
                release_receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("publication released");
                true
            })
        });
        started_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("publication worker entered callback");
        let settlement_deadline = Instant::now() + Duration::from_millis(250);
        while !pending.is_finished() && Instant::now() < settlement_deadline {
            thread::yield_now();
        }
        let settled_without_callback = pending.is_finished();
        let fresh_was_blocked = if settled_without_callback {
            host.active.finish_request();
            !host.active.claim_request("publication-still-owned")
        } else {
            false
        };
        let shutdown_cleanup_was_proven = host.cancel_for_app_shutdown_and_wait();
        release_sender.send(()).expect("release publication");
        let outcome = pending.join().expect("publication owner");
        if !settled_without_callback {
            host.active.finish_request();
        }
        let recovery_deadline = Instant::now() + Duration::from_secs(1);
        let recovered = loop {
            if host.active.claim_request("publication-recovered") {
                break true;
            }
            if Instant::now() >= recovery_deadline {
                break false;
            }
            thread::yield_now();
        };
        if recovered {
            host.active.finish_request();
        }

        assert!(
            settled_without_callback,
            "a blocked terminal callback must not own the settlement caller"
        );
        assert_eq!(outcome, TerminalPublicationOutcome::Deferred);
        assert!(
            fresh_was_blocked,
            "an unfinished publication worker must block a fresh request"
        );
        assert!(
            !shutdown_cleanup_was_proven,
            "shutdown must not report cleanup while publication remains owned"
        );
        assert!(
            recovered,
            "a retired publication worker must permit recovery"
        );
    }

    #[test]
    fn expired_terminal_publication_window_never_invokes_the_callback() {
        let host = RuntimeHost::unavailable_for_test();
        host.set_active_request_for_test("expired-terminal-publication");
        host.cancel_request_at(
            "expired-terminal-publication",
            Instant::now() - TURN_TERMINAL_BUDGET - Duration::from_millis(1),
        );
        let (called, observed) = mpsc::sync_channel(1);

        let outcome = host.publish_terminal_update(move || {
            called.send(()).expect("publication callback observation");
            true
        });

        assert_eq!(outcome, TerminalPublicationOutcome::Skipped);
        assert!(observed.try_recv().is_err());
        host.active.finish_request();
    }

    #[test]
    fn terminal_publication_uses_one_clock_at_worker_start_and_completion() {
        for (worker_elapsed_ms, completion_elapsed_ms, expected_calls, expected_outcome) in [
            (
                4_999_u64,
                4_999_u64,
                1,
                TerminalPublicationOutcome::Completed(true),
            ),
            (4_999, 5_000, 1, TerminalPublicationOutcome::Completed(true)),
            (5_000, 5_000, 0, TerminalPublicationOutcome::Skipped),
            (5_001, 5_001, 0, TerminalPublicationOutcome::Skipped),
            (4_999, 5_001, 1, TerminalPublicationOutcome::Skipped),
        ] {
            let host = RuntimeHost::unavailable_for_test();
            host.set_active_request_for_test("coherent-publication-clock");
            let accepted_at = Instant::now();
            let cutoff = accepted_at + TURN_TERMINAL_BUDGET;
            host.set_terminal_publication_now_for_test(accepted_at + Duration::from_millis(4_900));
            let (worker_entered, release_worker) =
                host.install_terminal_publication_hook_for_test();
            let calls = Arc::new(AtomicUsize::new(0));
            let calls_for_callback = Arc::clone(&calls);
            let completion_clock = host.clone();
            let publishing_host = host.clone();
            let pending = thread::spawn(move || {
                publishing_host.publish_terminal_update_until(cutoff, move || {
                    calls_for_callback.fetch_add(1, Ordering::AcqRel);
                    completion_clock.set_terminal_publication_now_for_test(
                        accepted_at + Duration::from_millis(completion_elapsed_ms),
                    );
                    true
                })
            });
            worker_entered
                .recv_timeout(Duration::from_secs(1))
                .expect("publication worker entered");
            host.set_terminal_publication_now_for_test(
                accepted_at + Duration::from_millis(worker_elapsed_ms),
            );
            {
                let (released, wake) = &*release_worker;
                *released.lock().expect("publication release") = true;
                wake.notify_all();
            }
            let completion_deadline = Instant::now() + Duration::from_secs(1);
            while !pending.is_finished() {
                assert!(
                    Instant::now() < completion_deadline,
                    "publication outcome exceeded its bounded wait"
                );
                thread::yield_now();
            }
            let outcome = pending.join().expect("publication outcome");

            assert_eq!(
                calls.load(Ordering::Acquire),
                expected_calls,
                "worker={worker_elapsed_ms}ms, completion={completion_elapsed_ms}ms"
            );
            assert_eq!(
                outcome, expected_outcome,
                "worker={worker_elapsed_ms}ms, completion={completion_elapsed_ms}ms"
            );
            host.active.finish_request();
        }
    }

    #[test]
    fn late_failed_or_panicked_terminal_publication_is_applied_after_settlement() {
        for panic_after_release in [false, true] {
            let host = RuntimeHost::unavailable_for_test();
            host.set_active_request_for_test("late-terminal-publication");
            let (entered, started) = mpsc::sync_channel(1);
            let (release, released) = mpsc::sync_channel(1);
            let (failed, failure_observed) = mpsc::sync_channel(1);
            let outcome = host.publish_terminal_update_until_with_failure(
                Instant::now() + Duration::from_secs(1),
                move || {
                    entered.send(()).expect("publication entered");
                    released
                        .recv_timeout(Duration::from_secs(1))
                        .expect("publication released");
                    assert!(!panic_after_release, "injected publication panic");
                    false
                },
                move || failed.send(()).expect("failure disposition"),
            );
            started
                .recv_timeout(Duration::from_secs(1))
                .expect("publication callback entered");
            assert_eq!(outcome, TerminalPublicationOutcome::Deferred);
            host.active.finish_request();
            assert!(!host.active.claim_request("publication-unsettled"));
            release.send(()).expect("release publication callback");
            failure_observed
                .recv_timeout(Duration::from_secs(1))
                .expect("late failure must be applied");
            let recovery_deadline = Instant::now() + Duration::from_secs(1);
            while !host.active.claim_request("publication-recovered") {
                assert!(
                    Instant::now() < recovery_deadline,
                    "publication worker did not retire"
                );
                thread::yield_now();
            }
            host.active.finish_request();
        }
    }

    #[test]
    fn turn_and_readiness_retain_spawn_rollback_kill_or_reap_failure() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for readiness in [false, true] {
            for failed_phase in [1, 2] {
                let fixture = Fixture::new();
                let repository = fixture.root.join("repository");
                fs::create_dir(&repository).expect("repository identity");
                fs::create_dir(repository.join(".git")).expect("repository marker");
                let host = fixture.scripted_host(
                    r#"#!/bin/sh
while :; do /bin/sleep 1; done
"#,
                );
                let request_id = if readiness {
                    "readiness-spawn-rollback"
                } else {
                    "turn-spawn-rollback"
                };
                let (effect_started, release_effect) = host
                    .active
                    .install_runtime_effect_hook(RuntimeEffectStage::Spawn);
                host.fail_spawn_rollback_for_test(failed_phase);
                let running_host = host.clone();
                let running_repository = repository.clone();
                let pending = thread::spawn(move || {
                    if readiness {
                        (running_host.check(request_id, None).state, None)
                    } else {
                        let outcome = running_host.run_turn(
                            request_id,
                            1,
                            &WorkspaceRuntimeBinding::for_test(&running_repository),
                            "Bounded task.",
                            Duration::from_secs(30),
                            |_| {},
                        );
                        (RuntimeReadinessState::Unavailable, Some(outcome))
                    }
                });
                effect_started
                    .recv_timeout(Duration::from_secs(5))
                    .expect("spawn effect entered");
                host.cancel_request_at(request_id, Instant::now());
                {
                    let (released, wake) = &*release_effect;
                    *released.lock().expect("spawn release") = true;
                    wake.notify_all();
                }
                let completion_deadline = Instant::now() + Duration::from_secs(5);
                while !pending.is_finished() {
                    assert!(
                        Instant::now() < completion_deadline,
                        "spawn rollback outcome exceeded its bounded deadline"
                    );
                    thread::yield_now();
                }
                let (readiness_state, turn_outcome) = pending.join().expect("runtime outcome");

                if let Some(turn_outcome) = turn_outcome {
                    assert_eq!(turn_outcome.state, TurnState::CleanupFailed);
                    assert!(!turn_outcome.cleaned);
                } else {
                    assert_eq!(readiness_state, RuntimeReadinessState::CleanupFailed);
                }
                assert!(
                    host.active
                        .process_group
                        .lock()
                        .is_ok_and(|group| group.is_some())
                );
                assert!(!host.active.claim_request("rollback-not-reconciled"));
                let recovery_deadline = Instant::now() + Duration::from_secs(5);
                while !host.wait_for_accepted_cancellation_cleanup() {
                    assert!(
                        Instant::now() < recovery_deadline,
                        "retained spawn rollback did not reconcile"
                    );
                    thread::yield_now();
                }
                assert!(host.active.claim_request("rollback-recovered"));
                host.active.finish_request();
            }
        }
    }

    #[test]
    fn literal_host_cancel_remains_prompt_at_each_production_effect_boundary() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let targets = [
            RuntimeEffectStage::Bind,
            RuntimeEffectStage::Directory,
            RuntimeEffectStage::Stage,
            RuntimeEffectStage::Spawn,
            RuntimeEffectStage::Publish,
            RuntimeEffectStage::Readers,
            RuntimeEffectStage::InitializeWrite,
        ];
        let ordered = [
            RuntimeEffectStage::Bind,
            RuntimeEffectStage::Workspace,
            RuntimeEffectStage::Directory,
            RuntimeEffectStage::Stage,
            RuntimeEffectStage::Spawn,
            RuntimeEffectStage::Publish,
            RuntimeEffectStage::Readers,
            RuntimeEffectStage::InitializeWrite,
        ];
        for target in targets {
            let fixture = Fixture::new();
            let repository = fixture.root.join("repository");
            fs::create_dir(&repository).expect("repository identity");
            fs::create_dir(repository.join(".git")).expect("repository marker");
            let runtime = fixture.scripted_host(
                r#"#!/bin/sh
read -r initialize
printf '%s\n' '{"id":1,"result":{"userAgent":"codex_cli_rs/0.145.0","codexHome":"'"$CODEX_HOME"'","platformFamily":"unix","platformOs":"macos"}}'
read -r initialized
read -r account
printf provider-write > "$CODEX_HOME/provider-write"
while :; do /bin/sleep 1; done
"#,
            );
            let (effect_started, release_effect) =
                runtime.active.install_runtime_effect_hook(target);
            let mut workspace = crate::WorkspaceHost::default();
            let workspace_generation = match workspace
                .select(crate::FolderPickerResult::Selected(repository))
                .expect("workspace selection")
            {
                keiko_application::workspace::WorkspaceView::Bound { generation, .. } => generation,
                _ => panic!("bound workspace"),
            };
            let nonce = "e".repeat(64);
            let mut lifecycle = crate::HostLifecycle::default();
            let generation = lifecycle
                .begin_renderer_session(nonce.clone())
                .expect("renderer generation");
            let sender =
                lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce);
            let request_id = keiko_ui_port::canonical_request_id(generation, 1).unwrap();
            let request = format!(
                r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":120000,"operation":{{"kind":"codex-turn-start","workspaceGeneration":{workspace_generation},"task":"Bounded task."}}}}"#
            );
            let lifecycle = Arc::new(Mutex::new(lifecycle));
            let workspace = Arc::new(Mutex::new(workspace));
            let running_lifecycle = Arc::clone(&lifecycle);
            let running_workspace = Arc::clone(&workspace);
            let running_runtime = runtime.clone();
            let running_sender = sender.clone();
            let turn = thread::spawn(move || {
                crate::turn::turn_request(
                    &running_lifecycle,
                    &running_workspace,
                    &running_runtime,
                    &running_sender,
                    &request,
                    |_| {},
                )
            });
            effect_started
                .recv_timeout(Duration::from_secs(5))
                .expect("production effect boundary reached");
            let cancellation = format!(r#"{{"schemaVersion":1,"requestId":"{request_id}"}}"#);
            let cancel_lifecycle = Arc::clone(&lifecycle);
            let cancel_runtime = runtime.clone();
            let (accepted_sender, accepted_receiver) = mpsc::sync_channel(1);
            let cancel = thread::spawn(move || {
                let result = crate::tauri_adapter::dispatch_cancel_with_runtime_fence(
                    &cancel_lifecycle,
                    &cancel_runtime,
                    "main",
                    "tauri://localhost",
                    generation,
                    &nonce,
                    &cancellation,
                );
                accepted_sender
                    .send(result.accepted)
                    .expect("cancel acceptance observation");
            });
            let accepted_promptly = accepted_receiver
                .recv_timeout(Duration::from_millis(100))
                .ok()
                .flatten();
            {
                let (released, wake) = &*release_effect;
                *released.lock().expect("effect release") = true;
                wake.notify_all();
            }
            let accepted = accepted_promptly.or_else(|| {
                accepted_receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("eventual cancel acceptance")
            });
            cancel.join().expect("cancel thread");
            let output = turn.join().expect("turn thread");

            assert!(
                accepted_promptly.is_some(),
                "{target:?} blocked Host acceptance"
            );
            assert!(
                accepted.is_some(),
                "{target:?} must retain literal Host token"
            );
            assert!(output.encoded.contains(r#""state":"cancelled""#));
            let target_index = ordered.iter().position(|stage| *stage == target).unwrap();
            assert_eq!(
                runtime.active.runtime_effect_trace(),
                ordered[..=target_index],
                "no later production effect may begin after cancellation at {target:?}"
            );
            assert_eq!(fs::read_dir(&fixture.work).expect("work root").count(), 0);
            assert!(!fixture.home.join("provider-write").exists());
        }
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
        assert!(
            !reconcile_retained_work_directories(&active),
            "the first reconciliation only starts the owned worker"
        );
        let reconciliation_deadline = Instant::now() + Duration::from_secs(1);
        let reconciled = loop {
            if reconcile_retained_work_directories(&active) {
                break true;
            }
            if Instant::now() >= reconciliation_deadline {
                break false;
            }
            thread::yield_now();
        };
        assert!(reconciled, "proven absence must complete bounded recovery");
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
        assert!(never_idle.begin_request("never-idle", None));
        assert!(!never_idle.wait_for_idle(Duration::from_millis(1)));
        never_idle.finish_request();
    }

    #[test]
    fn pending_cleanup_wait_uses_only_the_authoritative_cancellation_cutoff() {
        let now = Instant::now();
        let accepted =
            AcceptedRuntimeCancellation::new(RuntimeCancellation::User, now - TURN_TERMINAL_BUDGET);
        assert_eq!(accepted.terminal_cutoff, now);
        assert_eq!(
            cancellation_cleanup_wait_budget(now, Some(accepted)),
            Duration::ZERO,
            "an exact pending cancellation never receives a fresh five-second wait"
        );
        assert_eq!(
            cancellation_cleanup_wait_budget(now, None),
            TURN_TERMINAL_BUDGET
        );
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
        assert!(poisoned_while_waiting.begin_request("poisoned-wait", None));
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
    fn request_deadline_is_forwarded_unchanged_through_readiness_composition() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        let host = fixture.scripted_host(
            "#!/bin/sh\nIFS= read -r initialize || exit 0\nexec 1>&-\nIFS= read -r cleanup || exit 0\n",
        );
        let timeout = Duration::from_secs(2);
        let result = host.check_with_timeout("deadline-composition", None, timeout);
        let trace = host.active.take_readiness_deadline_trace();
        let request = trace.first().copied();
        let active = &host.active;
        let running = active.running.load(Ordering::Acquire);
        let process_group = active.process_group.lock().ok().and_then(|group| *group);
        let owned_empty = active
            .owned_processes
            .lock()
            .is_ok_and(|owned| owned.is_empty());
        let retained_work_empty = active
            .retained_work_directories
            .lock()
            .is_ok_and(|retained| retained.is_empty());
        let work_empty = fs::read_dir(&fixture.work).is_ok_and(|entries| entries.count() == 0);
        assert_eq!(result.state, RuntimeReadinessState::Incompatible);
        assert!(!running);
        assert_eq!(process_group, None);
        assert!(owned_empty);
        assert!(retained_work_empty);
        assert!(work_empty);
        assert_eq!(trace.len(), 4, "missing readiness deadline sequence");
        let request = request.expect("request deadline observation");
        assert_eq!(request.stage, ReadinessDeadlineStage::Request);
        assert_eq!(request.timeout, Some(timeout));
        assert_eq!(
            request.deadline,
            request.started_at.expect("request start") + timeout
        );
        let handoff = ReadinessDeadlineObservation {
            stage: ReadinessDeadlineStage::PerformCheck,
            started_at: None,
            timeout: None,
            deadline: request.deadline,
        };
        let mut protocol = handoff;
        protocol.stage = ReadinessDeadlineStage::RunProtocol;
        let mut cleanup = handoff;
        cleanup.stage = ReadinessDeadlineStage::CleanupAfter;
        assert_eq!(trace, vec![request, handoff, protocol, cleanup]);
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
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut child = OwnedFixtureChild(
            Command::new("/usr/bin/true")
                .spawn()
                .expect("executor guard child"),
        );
        let active = ActiveRuntime::default();
        let process_group = child.0.id() as i32;
        let observation = {
            let mut executor = RealCleanupExecutor {
                child: &mut child.0,
                process_group,
                active: &active,
            };
            executor.execute(CleanupCommand::Sleep {
                guard: Some(Instant::now() - Duration::from_nanos(1)),
                duration: Duration::from_millis(1),
            })
        };
        let reaped = bounded_owned_child_exit(&mut child.0);
        let child_absent = child_exited_without_reaping(process_group)
            .is_err_and(|error| error.raw_os_error() == Some(MACOS_ECHILD));

        assert!(matches!(
            observation,
            CleanupObservation::DeadlineClosed { .. }
        ));
        assert!(reaped);
        assert!(child_absent);
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
            let _stdout = spawn_stdout_reader(stdout, stdout_sender, Arc::new(AtomicUsize::new(0)))
                .expect("stdout reader");
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
            let _stdout = spawn_stdout_reader(stdout, stdout_sender, Arc::new(AtomicUsize::new(0)))
                .expect("stdout reader");
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
            let _stdout = spawn_stdout_reader(stdout, stdout_sender, Arc::new(AtomicUsize::new(0)))
                .expect("stdout reader");
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
        let mut child = OwnedFixtureChild(
            Command::new("/bin/sh")
                .arg("-c")
                .arg("read -r control || exit 0")
                .process_group(0)
                .stdin(Stdio::piped())
                .spawn()
                .expect("reused identity fixture"),
        );
        let process_group = child.0.id() as i32;
        let exact_identity = process_identity(process_group).expect("exact child identity");
        let reused_identity = ProcessIdentity {
            started_microseconds: exact_identity.started_microseconds.wrapping_add(1),
            ..exact_identity
        };
        let refused =
            authenticated_direct_child(&child.0, process_group, reused_identity).is_none();
        let unavailable_identity = unavailable_process_identity(i32::MAX);
        let unavailable_refused =
            authenticated_direct_child(&child.0, process_group, unavailable_identity).is_none();
        let active = ActiveRuntime::default();
        let mismatch_refused =
            authenticated_direct_child(&child.0, process_group + 1, exact_identity).is_none()
                && !settle_unpublished_fixture(&mut child.0, process_group + 1, &active);
        let remained_live = child.0.try_wait().is_ok_and(|status| status.is_none());
        drop(child.0.stdin.take());
        let _ = child.0.kill();
        let reaped = bounded_owned_child_exit(&mut child.0);
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
                error(1),
                ProcessPresenceStatus::Absent,
                State::Lost,
            ),
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
    fn cleanup_reconciliation_poll_failure_preserves_policy_and_cutoff() {
        let started_at = Instant::now();
        let phase_deadline = started_at + Duration::from_millis(10);
        let deadline = started_at + Duration::from_secs(1);
        let continuation = CleanupContinuation::Poll {
            phase_deadline,
            after: CleanupAfterPoll::SignalTerm,
        };
        let controller = |policy| CleanupController {
            policy,
            process_group: 41,
            deadline,
            cleanup_started: started_at,
            eof_grace: Duration::ZERO,
            term_grace: Duration::ZERO,
        };
        let (_, before) = expect_cleanup_command(cleanup_reconciliation_failed(
            controller(CleanupPhasePolicy::PreserveFinalReconciliation),
            continuation,
            started_at,
        ));
        assert_eq!(
            before,
            CleanupCommand::Sleep {
                guard: Some(phase_deadline),
                duration: Duration::from_millis(10),
            }
        );
        let (_, parent_reap) = expect_cleanup_command(cleanup_reconciliation_failed(
            controller(CleanupPhasePolicy::AllowParentReap),
            continuation,
            phase_deadline,
        ));
        assert_eq!(
            parent_reap,
            CleanupCommand::Sleep {
                guard: None,
                duration: Duration::from_millis(10),
            }
        );
    }

    #[test]
    fn cleanup_reconciliation_poll_failure_advances_at_preserved_phase_cutoff() {
        let started_at = Instant::now();
        let phase_deadline = started_at + Duration::from_millis(10);
        let deadline = started_at + Duration::from_secs(1);
        let controller = CleanupController {
            policy: CleanupPhasePolicy::PreserveFinalReconciliation,
            process_group: 41,
            deadline,
            cleanup_started: started_at,
            eof_grace: Duration::ZERO,
            term_grace: Duration::ZERO,
        };
        let (_, command) = expect_cleanup_command(cleanup_reconciliation_failed(
            controller,
            CleanupContinuation::Poll {
                phase_deadline,
                after: CleanupAfterPoll::SignalTerm,
            },
            phase_deadline,
        ));
        assert_eq!(
            command,
            CleanupCommand::SignalProcessGroup {
                guard: Some(deadline),
                signal: SIGTERM,
            }
        );
    }

    #[test]
    fn direct_child_helpers_reject_nonchild_and_foreign_authority() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut child = OwnedFixtureChild(
            Command::new("/bin/cat")
                .process_group(0)
                .stdin(Stdio::piped())
                .spawn()
                .expect("foreign direct-child fixture"),
        );
        let process_group = child.0.id() as i32;
        let (waiting, group) =
            observe_direct_child(DirectChildState::Waiting(false), process_group);
        let waiting = waiting.ok();
        let nonchild_error = reap_exact_child(i32::MAX)
            .err()
            .and_then(|error| error.raw_os_error());
        let foreign = AuthenticatedDirectChild(unavailable_process_identity(i32::MAX));
        let refused = finish_owned_child_outcome(
            DirectChildFinalization::StillDirectlyOwned(foreign),
            &mut child.0,
            process_group,
            &ActiveRuntime::default(),
        );
        let remained_live = child.0.try_wait().ok().flatten().is_none();
        let settled =
            settle_unpublished_fixture(&mut child.0, process_group, &ActiveRuntime::default());
        assert_eq!(waiting, Some(false));
        assert_eq!(group, ProcessPresenceStatus::Unavailable);
        assert_eq!(nonchild_error, Some(MACOS_ECHILD));
        assert!(!refused);
        assert!(remained_live);
        assert!(settled);
        assert_eq!(
            process_group_presence(process_group),
            ProcessPresenceStatus::Absent
        );
    }

    #[test]
    fn published_fixture_stop_requires_current_exact_identity() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut child = OwnedFixtureChild(
            Command::new("/bin/cat")
                .process_group(0)
                .stdin(Stdio::piped())
                .spawn()
                .expect("published stop fixture"),
        );
        let process_group = child.0.id() as i32;
        let active = ActiveRuntime::default();
        let identity = process_identity(process_group).expect("published stop identity");
        let missing = stop_published_fixture_group(&mut child.0, process_group, &active);
        let live_after_missing = child.0.try_wait().ok().flatten().is_none();
        *active.process_group.lock().expect("wrong ownership state") =
            Some(unavailable_process_identity(process_group + 1));
        let wrong = stop_published_fixture_group(&mut child.0, process_group, &active);
        let live_after_wrong = child.0.try_wait().ok().flatten().is_none();
        *active.process_group.lock().expect("reused ownership state") = Some(ProcessIdentity {
            started_microseconds: identity.started_microseconds.wrapping_add(1),
            ..identity
        });
        let reused = stop_published_fixture_group(&mut child.0, process_group, &active);
        let live_after_reused = child.0.try_wait().ok().flatten().is_none();
        *active
            .process_group
            .lock()
            .expect("current ownership state") = Some(identity);
        let current = stop_published_fixture_group(&mut child.0, process_group, &active);
        let settled = settle_unpublished_fixture(&mut child.0, process_group, &active);
        assert_eq!((missing, live_after_missing), (false, true));
        assert_eq!((wrong, live_after_wrong), (false, true));
        assert_eq!((reused, live_after_reused), (false, true));
        assert_eq!((current, settled), (true, true));
        assert_eq!(
            process_group_presence(process_group),
            ProcessPresenceStatus::Absent
        );
    }

    #[test]
    fn owned_settlement_refuses_a_live_group_member_then_cleans_both_children() {
        let _process_guard = PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut leader = OwnedFixtureChild(
            Command::new("/bin/cat")
                .process_group(0)
                .stdin(Stdio::piped())
                .spawn()
                .expect("settlement leader"),
        );
        let process_group = leader.0.id() as i32;
        let mut member = OwnedFixtureChild(
            Command::new("/bin/cat")
                .process_group(process_group)
                .stdin(Stdio::piped())
                .spawn()
                .expect("settlement member"),
        );
        let active = ActiveRuntime::default();
        let refused = settle_unpublished_fixture(&mut leader.0, process_group, &active);
        let leader_error = child_exited_without_reaping(process_group)
            .err()
            .and_then(|error| error.raw_os_error());
        let group_present = process_group_presence(process_group);
        let member_live = member.0.try_wait().ok().flatten().is_none();
        let _ = leader.0.kill();
        let leader_reaped = bounded_owned_child_exit(&mut leader.0);
        drop(member.0.stdin.take());
        let _ = member.0.kill();
        let member_reaped = bounded_owned_child_exit(&mut member.0);
        assert!(!refused);
        assert_eq!(leader_error, Some(MACOS_ECHILD));
        assert_eq!(group_present, ProcessPresenceStatus::Present);
        assert!(member_live);
        assert!(leader_reaped);
        assert!(member_reaped);
        assert_eq!(
            process_group_presence(process_group),
            ProcessPresenceStatus::Absent
        );
    }

    #[test]
    fn settled_fixture_retirement_fails_closed_on_poisoned_ownership() {
        struct ClearProcessGroupPoison<'a>(&'a Mutex<Option<ProcessIdentity>>);
        impl Drop for ClearProcessGroupPoison<'_> {
            fn drop(&mut self) {
                self.0.clear_poison();
            }
        }
        struct ClearOwnedProcessesPoison<'a>(&'a Mutex<HashSet<ProcessIdentity>>);
        impl Drop for ClearOwnedProcessesPoison<'_> {
            fn drop(&mut self) {
                self.0.clear_poison();
            }
        }
        let group_poisoned = ActiveRuntime::default();
        let group_clear = ClearProcessGroupPoison(&group_poisoned.process_group);
        let _ = std::panic::catch_unwind(|| {
            let _guard = group_poisoned
                .process_group
                .lock()
                .expect("group poison lock");
            panic!("poison group ownership");
        });
        assert!(!retire_settled_fixture(&group_poisoned));
        drop(group_clear);

        let owned_poisoned = ActiveRuntime::default();
        *owned_poisoned
            .process_group
            .lock()
            .expect("stored ownership") = Some(unavailable_process_identity(i32::MAX));
        let owned_clear = ClearOwnedProcessesPoison(&owned_poisoned.owned_processes);
        let _ = std::panic::catch_unwind(|| {
            let _guard = owned_poisoned
                .owned_processes
                .lock()
                .expect("owned poison lock");
            panic!("poison owned processes");
        });
        assert!(!retire_settled_fixture(&owned_poisoned));
        drop(owned_clear);
        assert!(retire_settled_fixture(&owned_poisoned));
        assert_eq!(
            *owned_poisoned
                .process_group
                .lock()
                .expect("retired poison ownership"),
            None
        );
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
        let mut child = OwnedFixtureChild(
            Command::new("/bin/sh")
                .arg("-c")
                .arg("read -r control || exit 0")
                .process_group(0)
                .stdin(Stdio::piped())
                .spawn()
                .expect("owned outcome fixture"),
        );
        let process_group = child.0.id() as i32;
        let identity = process_identity(process_group).expect("owned outcome identity");
        let active = ActiveRuntime::default();
        let lost_refused = !finish_owned_child_outcome(
            DirectChildFinalization::OwnershipLostOrUnavailable,
            &mut child.0,
            process_group,
            &active,
        );
        let mismatch = authenticated_direct_child(&child.0, process_group, identity)
            .expect("mismatch outcome token");
        let mismatch_refused = !finish_owned_child_outcome(
            DirectChildFinalization::StillDirectlyOwned(mismatch),
            &mut child.0,
            process_group + 1,
            &active,
        );
        let remained_live = child.0.try_wait().is_ok_and(|status| status.is_none());
        let exact = authenticated_direct_child(&child.0, process_group, identity)
            .expect("exact outcome token");
        let settled = finish_owned_child_outcome(
            DirectChildFinalization::StillDirectlyOwned(exact),
            &mut child.0,
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
        let mut escaped = OwnedFixtureChild(
            Command::new("/bin/sleep")
                .arg("30")
                .process_group(0)
                .spawn()
                .expect("independent descendant fixture"),
        );
        let active = ActiveRuntime::default();
        let leader = std::process::id() as i32;
        let escaped_process = escaped.0.id() as i32;
        let escaped_information =
            process_information(escaped_process).expect("escaped process information");
        let published = publish_active_process_group(&active, leader);
        let leader_identity = active
            .process_group
            .lock()
            .expect("published test-process leader")
            .expect("test-process identity");
        let alive_before_stop = owned_descendants_alive(&active, leader);
        let escaped_identity = process_identity(escaped_process).expect("escaped process identity");
        let reused = ProcessIdentity {
            started_microseconds: escaped_identity.started_microseconds.wrapping_add(1),
            ..escaped_identity
        };
        let reused_status = known_owned_process_status(reused);
        let _ = escaped.0.kill();
        let escaped_reaped = bounded_owned_child_exit(&mut escaped.0);
        let escaped_echild = child_exited_without_reaping(escaped_process)
            .is_err_and(|error| error.raw_os_error() == Some(MACOS_ECHILD));
        let escaped_group = process_group_presence(escaped_process);
        let alive_after_stop = owned_descendants_alive(&active, leader);
        let owned_before_retire = authenticated_owned_processes_status(&active);
        let retired = retire_active_process_group(&active, leader_identity);
        let ownership_absent = active
            .process_group
            .lock()
            .is_ok_and(|group| group.is_none());
        let owned_absent = active
            .owned_processes
            .lock()
            .is_ok_and(|owned| owned.is_empty());

        assert!(published);
        assert_eq!(escaped_information.parent_process_id, leader as u32);
        assert_ne!(escaped_information.process_group, leader as u32);
        assert_eq!(alive_before_stop, Some(true));
        assert_eq!(reused_status, KnownOwnedProcessStatus::Stopped);
        assert!(escaped_reaped);
        assert!(escaped_echild);
        assert_eq!(escaped_group, ProcessPresenceStatus::Absent);
        assert_eq!(alive_after_stop, Some(false));
        assert_eq!(owned_before_retire, Some(true));
        assert!(retired);
        assert!(ownership_absent);
        assert!(owned_absent);
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
