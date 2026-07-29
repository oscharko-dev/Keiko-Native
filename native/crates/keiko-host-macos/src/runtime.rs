use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::sha256::sha256_file;
use crate::{AcceptedRequest, HostLifecycle, SenderContext};
use keiko_application::runtime::{
    CODEX_RUNTIME_SHA256, RuntimeReadinessState, RuntimeReadinessView,
};
use keiko_application::{ApplicationResult, application_response};
use keiko_ui_port::{
    Operation, ReasonCode, encode_error, encode_success, request_metadata, request_operation,
};
use serde_json::{Value, json};

const INITIALIZE_DEADLINE: Duration = Duration::from_secs(5);
const CLEANUP_DEADLINE: Duration = Duration::from_secs(5);
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_QUEUE_BYTES: usize = 4 * 1024 * 1024;
const MAX_QUEUE_FRAMES: usize = 256;
const MAX_STDERR_BYTES: usize = 1024 * 1024;
const MAX_QUARANTINED_EVENTS: u16 = 64;
const EPERM: i32 = 1;
const SIGKILL: i32 = 9;
const SIGTERM: i32 = 15;

const BINARY_ENV: &str = "KEIKO_CODEX_0_145_0_BINARY";
const HOME_ENV: &str = "KEIKO_CODEX_0_145_0_HOME";
const WORK_ROOT_ENV: &str = "KEIKO_CODEX_0_145_0_WORK_ROOT";

unsafe extern "C" {
    #[link_name = "kill"]
    fn keiko_kill(process_or_group: i32, signal: i32) -> i32;
}

#[derive(Clone, Debug)]
struct RuntimeConfiguration {
    binary: PathBuf,
    codex_home: PathBuf,
    work_root: PathBuf,
    expected_sha256: String,
}

#[derive(Debug, Default)]
struct ActiveRuntime {
    process_group: Mutex<Option<i32>>,
    request_id: Mutex<Option<String>>,
    cancelled: AtomicBool,
    running: AtomicBool,
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
        if self
            .active
            .running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return RuntimeReadinessView::terminal(RuntimeReadinessState::ContainmentFailed, 0);
        }
        self.active.cancelled.store(false, Ordering::Release);
        if let Ok(mut active_request_id) = self.active.request_id.lock() {
            *active_request_id = Some(request_id.to_owned());
        }
        let result = self.configuration.as_ref().map_or_else(
            || RuntimeReadinessView::terminal(RuntimeReadinessState::Unavailable, 0),
            |configuration| {
                perform_check(
                    configuration,
                    selected_workspace,
                    &self.active,
                    &self.work_generation,
                )
            },
        );
        if let Ok(mut active_request_id) = self.active.request_id.lock() {
            *active_request_id = None;
        }
        self.active.running.store(false, Ordering::Release);
        result
    }

    pub fn cancel_request(&self, request_id: &str) {
        let matches = self
            .active
            .request_id
            .lock()
            .is_ok_and(|active| active.as_deref() == Some(request_id));
        if matches {
            self.cancel_all();
        }
    }

    pub fn cancel_all(&self) {
        self.active.cancelled.store(true, Ordering::Release);
        let process_group = self
            .active
            .process_group
            .lock()
            .ok()
            .and_then(|active| *active);
        if let Some(process_group) = process_group {
            signal_process_group(process_group, SIGTERM);
        }
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
    let (request_id, _, _) = request_metadata(&accepted.request);
    let view = runtime.check(request_id, selected_workspace);
    let encoded = encode_runtime(&accepted, view);
    finish_encoded(lifecycle, accepted, encoded)
}

fn encode_runtime(accepted: &AcceptedRequest, state: RuntimeReadinessView) -> String {
    let (request_id, _, _) = request_metadata(&accepted.request);
    encode_success(&application_response(
        request_id,
        ApplicationResult::RuntimeReadiness { state },
    ))
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
) -> RuntimeReadinessView {
    let verified = match verify_configuration(configuration, selected_workspace) {
        Ok(verified) => verified,
        Err(state) => return RuntimeReadinessView::terminal(state, 0),
    };
    if active.cancelled.load(Ordering::Acquire) {
        return RuntimeReadinessView::terminal(RuntimeReadinessState::Cancelled, 0);
    }
    let generation = work_generation.fetch_add(1, Ordering::AcqRel) + 1;
    let work_directory = verified
        .work_root
        .join(format!("readiness-{}-{generation}", std::process::id()));
    if fs::create_dir(&work_directory).is_err() {
        return RuntimeReadinessView::terminal(RuntimeReadinessState::Unavailable, 0);
    }
    let outcome = run_protocol(&verified, &work_directory, active);
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

#[derive(Clone, Debug)]
struct VerifiedConfiguration {
    binary: PathBuf,
    codex_home: PathBuf,
    work_root: PathBuf,
}

fn verify_configuration(
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
    let metadata = fs::metadata(&binary).map_err(|_| RuntimeReadinessState::Unavailable)?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err(RuntimeReadinessState::Unavailable);
    }
    let digest = sha256_file(&binary).map_err(|_| RuntimeReadinessState::Unavailable)?;
    if digest != configuration.expected_sha256 {
        return Err(RuntimeReadinessState::Incompatible);
    }
    Ok(VerifiedConfiguration {
        binary,
        codex_home,
        work_root,
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
    configuration: &VerifiedConfiguration,
    work_directory: &Path,
    active: &ActiveRuntime,
) -> ProtocolOutcome {
    let mut command = Command::new(&configuration.binary);
    command
        .args([
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
            "app-server",
            "--listen",
            "stdio://",
        ])
        .current_dir(work_directory)
        .env_clear()
        .env("CODEX_HOME", &configuration.codex_home)
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
        );
    }
    let mut projection = ProtocolProjection::new(&configuration.codex_home);
    let deadline = Instant::now() + INITIALIZE_DEADLINE;
    let state = loop {
        if active.cancelled.load(Ordering::Acquire) {
            break RuntimeReadinessState::Cancelled;
        }
        if stderr_saturated.load(Ordering::Acquire) {
            break RuntimeReadinessState::ContainmentFailed;
        }
        let now = Instant::now();
        if now >= deadline {
            break RuntimeReadinessState::TimedOut;
        }
        match receiver.recv_timeout((deadline - now).min(Duration::from_millis(20))) {
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
                break if active.cancelled.load(Ordering::Acquire) {
                    RuntimeReadinessState::Cancelled
                } else {
                    RuntimeReadinessState::Incompatible
                };
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                break if active.cancelled.load(Ordering::Acquire) {
                    RuntimeReadinessState::Cancelled
                } else {
                    RuntimeReadinessState::Incompatible
                };
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
                .any(|key| !matches!(key.as_str(), "method" | "params"))
        {
            return ProjectionAction::Terminal(RuntimeReadinessState::ContainmentFailed);
        }
        let Some(method) = object.get("method").and_then(Value::as_str) else {
            return ProjectionAction::Terminal(RuntimeReadinessState::ContainmentFailed);
        };
        if !matches!(
            method,
            "turn/plan/updated"
                | "thread/status/changed"
                | "item/agentMessage/delta"
                | "account/updated"
        ) || self.quarantined_events == MAX_QUARANTINED_EVENTS
        {
            return ProjectionAction::Terminal(RuntimeReadinessState::ContainmentFailed);
        }
        self.quarantined_events += 1;
        ProjectionAction::Continue
    }
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
        ProjectionAction::Terminal(RuntimeReadinessState::AuthenticationRequired)
    }
}

fn has_exact_keys(object: &serde_json::Map<String, Value>, keys: &[&str]) -> bool {
    object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
}

fn cleanup_after(
    mut child: Child,
    process_group: i32,
    state: RuntimeReadinessState,
    quarantined_events: u16,
    active: &ActiveRuntime,
) -> ProtocolOutcome {
    let cleaned = stop_process_group(&mut child, process_group);
    if let Ok(mut active_group) = active.process_group.lock() {
        *active_group = None;
    }
    ProtocolOutcome {
        state,
        quarantined_events,
        cleaned,
    }
}

fn stop_process_group(child: &mut Child, process_group: i32) -> bool {
    let cleanup_started = Instant::now();
    let term_deadline = cleanup_started + Duration::from_secs(4);
    let absolute_deadline = cleanup_started + CLEANUP_DEADLINE;
    if child.try_wait().ok().flatten().is_none() {
        signal_process_group(process_group, SIGTERM);
    }
    while Instant::now() < term_deadline {
        if child.try_wait().ok().flatten().is_some() && !process_group_exists(process_group) {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    signal_process_group(process_group, SIGKILL);
    while Instant::now() < absolute_deadline {
        if child.try_wait().ok().flatten().is_some() && !process_group_exists(process_group) {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    false
}

fn signal_process_group(process_group: i32, signal: i32) {
    // SAFETY: kill is called with a positive, host-owned process group ID and a
    // fixed signal. A negative PID targets only that group, never an arbitrary
    // shell command or caller-selected process.
    unsafe {
        keiko_kill(-process_group, signal);
    }
}

fn process_group_exists(process_group: i32) -> bool {
    // SAFETY: signal 0 performs existence/permission checking only. The process
    // group ID came directly from the child created by this supervisor.
    let result = unsafe { keiko_kill(-process_group, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(EPERM)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::os::unix::fs::symlink;

    static PROCESS_TEST_LOCK: Mutex<()> = Mutex::new(());

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

        let unauthenticated = [
            json!({"id": 2, "result": {"account": {}, "requiresOpenaiAuth": true}}),
            json!({"id": 2, "result": {"account": {"type": "chatgpt", "email": "redacted", "planType": "plus", "extra": true}, "requiresOpenaiAuth": true}}),
            json!({"id": 2, "result": {"account": {"type": "apiKey", "email": "redacted", "planType": "plus"}, "requiresOpenaiAuth": true}}),
            json!({"id": 2, "result": {"account": {"type": "chatgpt", "email": 7, "planType": "plus"}, "requiresOpenaiAuth": true}}),
            json!({"id": 2, "result": {"account": {"type": "chatgpt", "email": "redacted", "planType": 7}, "requiresOpenaiAuth": true}}),
        ];
        for response in unauthenticated {
            let mut projection = ProtocolProjection::new(home);
            projection.stage = ProjectionStage::Account;
            assert_eq!(
                projection.accept(&serde_json::to_vec(&response).expect("response")),
                ProjectionAction::Terminal(RuntimeReadinessState::AuthenticationRequired)
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
            verify_configuration(&relative, None).expect_err("relative binary"),
            RuntimeReadinessState::ContainmentFailed
        );

        let mut missing = valid.clone();
        missing.binary = fixture.root.join("missing");
        assert_eq!(
            verify_configuration(&missing, None).expect_err("missing binary"),
            RuntimeReadinessState::Unavailable
        );

        let binary_link = fixture.root.join("codex-link");
        symlink(&fixture.binary, &binary_link).expect("binary symlink");
        let mut linked = valid.clone();
        linked.binary = binary_link;
        assert_eq!(
            verify_configuration(&linked, None).expect_err("linked binary"),
            RuntimeReadinessState::ContainmentFailed
        );

        let mut home_is_file = valid.clone();
        home_is_file.codex_home = fixture.binary.clone();
        assert_eq!(
            verify_configuration(&home_is_file, None).expect_err("file home"),
            RuntimeReadinessState::ContainmentFailed
        );

        let mut aliased = valid.clone();
        aliased.codex_home = fixture.home.join("..").join("home");
        assert_eq!(
            verify_configuration(&aliased, None).expect_err("non-canonical alias"),
            RuntimeReadinessState::ContainmentFailed
        );

        let non_executable = fixture.root.join("not-executable");
        fs::write(&non_executable, b"runtime").expect("non-executable");
        let mut not_executable = valid.clone();
        not_executable.binary = non_executable;
        assert_eq!(
            verify_configuration(&not_executable, None).expect_err("non-executable binary"),
            RuntimeReadinessState::Unavailable
        );

        let mut directory_binary = valid.clone();
        directory_binary.binary = fixture.root.join("other-directory");
        fs::create_dir(&directory_binary.binary).expect("directory binary");
        assert_eq!(
            verify_configuration(&directory_binary, None).expect_err("directory binary"),
            RuntimeReadinessState::Unavailable
        );

        for selected_workspace in [&fixture.binary, &fixture.home, &fixture.work] {
            assert_eq!(
                verify_configuration(&valid, Some(selected_workspace))
                    .expect_err("overlapping workspace"),
                RuntimeReadinessState::ContainmentFailed
            );
        }
        assert_eq!(
            verify_configuration(&valid, Some(&fixture.root.join("missing-workspace")))
                .expect_err("missing workspace"),
            RuntimeReadinessState::ContainmentFailed
        );
    }

    #[test]
    fn host_rejects_concurrency_honours_pre_cancel_and_preserves_collisions() {
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
        host.cancel_all();
        *host
            .active
            .process_group
            .lock()
            .expect("process-group state") = None;

        let configuration = host.configuration.as_ref().expect("configuration");
        let active = ActiveRuntime::default();
        active.cancelled.store(true, Ordering::Release);
        assert_eq!(
            perform_check(configuration, None, &active, &AtomicU64::new(0)).state,
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
            let _guard = active.request_id.lock().expect("request bookkeeping");
            panic!("poison request bookkeeping");
        })
        .join();

        assert_eq!(
            host.check("poisoned-bookkeeping", None).state,
            RuntimeReadinessState::Unavailable
        );
        host.cancel_request("poisoned-bookkeeping");
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
