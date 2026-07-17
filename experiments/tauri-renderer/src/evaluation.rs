use std::{
    collections::HashSet,
    io::Write,
    os::unix::{fs::PermissionsExt, process::CommandExt},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, webview::PageLoadEvent,
};

const MAX_ENVELOPE_BYTES: usize = 4_096;
const MAX_REQUEST_ID_BYTES: usize = 64;
const MAX_SEEN_REQUEST_IDS: usize = 64;
const MAX_AXE_RULE_IDS: usize = 32;
const MAX_AXE_RULE_ID_BYTES: usize = 64;
const EXPECTED_WINDOW: &str = "main";
const FIXTURE_TERM_MS: u64 = 100;
const FIXTURE_KILL_MS: u64 = 1_000;
// The bounded prepare, native-dialog, fixture, and two renderer-probe paths can
// legitimately consume just over 20 seconds under slow scheduling. Keep the
// host watchdog after that aggregate budget but before the harness's 30-second
// hard timeout so a genuine hang still fails closed with time to flush evidence.
const EVALUATION_WATCHDOG_MS: u64 = 28_000;
const _: () = assert!(FIXTURE_TERM_MS + FIXTURE_KILL_MS < 5_000);
const _: () = assert!(EVALUATION_WATCHDOG_MS < 30_000);

unsafe extern "C" {
    fn keiko_evaluation_activate() -> i32;
    fn keiko_evaluation_native_dialog_cancel() -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
    fn setsid() -> i32;
    fn getsid(pid: i32) -> i32;
    fn getpgid(pid: i32) -> i32;
    fn signal(number: i32, handler: usize) -> usize;
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Code {
    Accepted,
    AccessibilityViolation,
    Cancelled,
    FixtureUnavailable,
    InvalidDiagnostics,
    InvalidRequest,
    NativeSurfaceNotCancelled,
    NativeSurfaceTimeout,
    NativeSurfaceUnavailable,
    PayloadTooLarge,
    ProcessCleanupFailed,
    RendererRecoveryFailed,
    ReplayedRequest,
    TimedOut,
    UnauthenticatedOrigin,
    UnauthenticatedSender,
    Unauthorized,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Reply {
    ok: bool,
    code: Code,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    elapsed_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    escalated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    renderer_recreated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_survived: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    event_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ui_value: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    first_instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    second_instance_id: Option<String>,
}

impl Reply {
    const fn accepted() -> Self {
        Self {
            ok: true,
            code: Code::Accepted,
            request_id: None,
            elapsed_ms: None,
            escalated: None,
            renderer_recreated: None,
            host_survived: None,
            event_token: None,
            ui_value: None,
            first_instance_id: None,
            second_instance_id: None,
        }
    }

    const fn rejected(code: Code) -> Self {
        Self {
            ok: false,
            code,
            request_id: None,
            elapsed_ms: None,
            escalated: None,
            renderer_recreated: None,
            host_survived: None,
            event_token: None,
            ui_value: None,
            first_instance_id: None,
            second_instance_id: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    schema_version: u8,
    request_id: String,
    operation: Operation,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "kebab-case")]
enum Operation {
    PrepareRenderer,
    StableShell(StableShell),
    Ping,
    AccessibilityResult(AccessibilityResult),
    RuntimeEvent,
    RuntimeEventCommitted(RuntimeEventCommitted),
    BoundedWork(BoundedWork),
    NativeDialog,
    FixtureProcess,
    RendererCycle,
    EvaluationFailed(EvaluationFailed),
    Finish(Finish),
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum FailureStage {
    Startup,
    PrepareRenderer,
    StableShell,
    SyntheticInput,
    RuntimeEvent,
    RequestValidation,
    ReplayProtection,
    Accessibility,
    BoundedWork,
    NativeDialog,
    FixtureProcess,
    RendererCycle,
    Finish,
}

impl FailureStage {
    const fn diagnostic(self) -> &'static str {
        match self {
            Self::Startup => "frontend-startup",
            Self::PrepareRenderer => "frontend-prepare-renderer",
            Self::StableShell => "frontend-stable-shell",
            Self::SyntheticInput => "frontend-synthetic-input",
            Self::RuntimeEvent => "frontend-runtime-event",
            Self::RequestValidation => "frontend-request-validation",
            Self::ReplayProtection => "frontend-replay-protection",
            Self::Accessibility => "frontend-accessibility",
            Self::BoundedWork => "frontend-bounded-work",
            Self::NativeDialog => "frontend-native-dialog",
            Self::FixtureProcess => "frontend-fixture-process",
            Self::RendererCycle => "frontend-renderer-cycle",
            Self::Finish => "frontend-finish",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvaluationFailed {
    stage: FailureStage,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeEventCommitted {
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StableShell {
    double_rendered: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccessibilityResult {
    violation_count: u8,
    rule_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoundedWork {
    work_ms: u64,
    timeout_ms: u64,
    #[serde(default)]
    cancel_after_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Diagnostics {
    appearance_diagnostic: bool,
    composition_diagnostic: bool,
    focus_diagnostic: bool,
    input_diagnostic_ms: f64,
    scale_factor_diagnostic: f64,
}

impl Diagnostics {
    fn valid(&self) -> bool {
        self.input_diagnostic_ms.is_finite()
            && (0.0..=10_000.0).contains(&self.input_diagnostic_ms)
            && self.scale_factor_diagnostic.is_finite()
            && (0.5..=8.0).contains(&self.scale_factor_diagnostic)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Finish {
    diagnostics: Diagnostics,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Journey {
    prepare_renderer: Option<Code>,
    stable_shell: Option<Code>,
    ping: Option<Code>,
    replay: Option<Code>,
    accessibility: Option<Code>,
    axe_violation_count: Option<u8>,
    axe_rule_ids: Vec<String>,
    runtime_event: Option<Code>,
    runtime_event_committed: Option<Code>,
    runtime_to_ui_ms: Option<f64>,
    invalid_request_count: u8,
    oversized: Option<Code>,
    cancelled_work: Option<Code>,
    timed_out_work: Option<Code>,
    native_dialog: Option<Code>,
    fixture_process: Option<Code>,
    fixture_escalated: Option<bool>,
    fixture_parent_reaped: Option<bool>,
    fixture_group_absent: Option<bool>,
    fixture_session_isolated: Option<bool>,
    fixture_exec_changed: Option<bool>,
    fixture_descendant_absent: Option<bool>,
    renderer_cycle: Option<Code>,
    probe_acl_denied: Option<bool>,
    renderer_recreated: Option<bool>,
    host_survived: Option<bool>,
    first_instance_id: Option<String>,
    second_instance_id: Option<String>,
}

struct EvaluationState {
    authority_active: bool,
    journey: Mutex<Journey>,
    fixture_ack: Option<String>,
    fixture_cleanup_ack: Option<String>,
    fixture_escalation_ack: Option<String>,
    fixture_marker: Option<String>,
    manual: bool,
    mode: &'static str,
    started: Instant,
    runtime_event: Mutex<Option<(String, Instant)>>,
    seen_request_ids: Mutex<HashSet<String>>,
    terminal_emitted: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DependencyEvidence<'a> {
    frontend: &'a str,
    host: &'a str,
    renderer: &'a str,
    rust: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Evidence<'a> {
    schema_version: u8,
    candidate: &'a str,
    mode: &'a str,
    environment: Environment<'a>,
    dependencies: DependencyEvidence<'a>,
    process_accounting: ProcessAccounting<'a>,
    diagnostics: Diagnostics,
    journey: Journey,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Environment<'a> {
    architecture: &'a str,
    os_family: &'a str,
    reference_class: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessAccounting<'a> {
    definition: &'a str,
    rss_comparable_for_win_gate: bool,
    limitation: &'a str,
}

pub fn requested() -> bool {
    std::env::args()
        .any(|argument| argument == "--evaluation-json" || argument == "--manual-evaluation")
}

fn execution_mode() -> Option<(&'static str, bool)> {
    let arguments = std::env::args().collect::<Vec<_>>();
    let benchmark = arguments.iter().any(|value| value == "--evaluation-json");
    let manual = arguments.iter().any(|value| value == "--manual-evaluation");
    let mode = arguments
        .windows(2)
        .find(|pair| pair[0] == "--mode")
        .map(|pair| pair[1].as_str());
    let has_mode_flag = arguments.iter().any(|value| value == "--mode");
    select_execution_mode(benchmark, manual, mode, has_mode_flag)
}

fn bounded_argument(name: &str, valid: impl Fn(&str) -> bool) -> Option<String> {
    let arguments = std::env::args().collect::<Vec<_>>();
    arguments
        .windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
        .filter(|value| valid(value))
}

fn select_execution_mode(
    benchmark: bool,
    manual: bool,
    mode: Option<&str>,
    has_mode_flag: bool,
) -> Option<(&'static str, bool)> {
    match (benchmark, manual, mode, has_mode_flag) {
        (true, false, Some("cold"), true) => Some(("cold", false)),
        (true, false, Some("warm"), true) => Some(("warm", false)),
        (false, true, None, false) => Some(("manual", true)),
        _ => None,
    }
}

pub fn run(builder: tauri::Builder<tauri::Wry>, context: tauri::Context<tauri::Wry>) {
    let Some((mode, manual)) = execution_mode() else {
        eprintln!("evaluation arguments are invalid");
        std::process::exit(64);
    };
    let fixture_marker = bounded_argument("--fixture-marker", |value| {
        value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    });
    let fixture_ack = bounded_argument("--fixture-ack", |value| {
        value.len() <= 512 && (value.starts_with("/private/") || value.starts_with("/var/"))
    });
    let fixture_escalation_ack = bounded_argument("--fixture-escalation-ack", |value| {
        value.len() <= 512 && (value.starts_with("/private/") || value.starts_with("/var/"))
    });
    let fixture_cleanup_ack = bounded_argument("--fixture-cleanup-ack", |value| {
        value.len() <= 512 && (value.starts_with("/private/") || value.starts_with("/var/"))
    });
    if !manual
        && (fixture_marker.is_none()
            || fixture_ack.is_none()
            || fixture_escalation_ack.is_none()
            || fixture_cleanup_ack.is_none())
    {
        eprintln!("evaluation fixture authority is invalid");
        std::process::exit(64);
    }
    let builder = if manual {
        builder.plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("manual-evaluation-marker")
                .js_init_script("window.__KEIKO_MANUAL_EVALUATION__=true;")
                .build(),
        )
    } else {
        builder
    };
    let terminal_emitted = Arc::new(AtomicBool::new(false));
    let watchdog_terminal = Arc::clone(&terminal_emitted);
    builder
        .setup(move |app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(2));
                if let Some(window) = handle.get_webview_window("main") {
                    eprintln!(
                        "KEIKO_DIAGNOSTIC_TITLE:{}",
                        window.title().unwrap_or_else(|_| "unavailable".into())
                    );
                }
            });
            let watchdog_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(EVALUATION_WATCHDOG_MS));
                emit_failure_once(
                    &watchdog_handle,
                    &watchdog_terminal,
                    "host-watchdog-timeout",
                );
            });
            Ok(())
        })
        .manage(EvaluationState {
            authority_active: true,
            journey: Mutex::new(Journey::default()),
            fixture_ack,
            fixture_cleanup_ack,
            fixture_escalation_ack,
            fixture_marker,
            manual,
            mode,
            started: Instant::now(),
            runtime_event: Mutex::new(None),
            seen_request_ids: Mutex::new(HashSet::new()),
            terminal_emitted,
        })
        .invoke_handler(tauri::generate_handler![evaluation_dispatch])
        .run(context)
        .expect("the instrumented Tauri evaluation shell must run");
}

#[tauri::command]
async fn evaluation_dispatch(app: AppHandle, window: WebviewWindow, envelope: Value) -> Reply {
    let state = app.state::<EvaluationState>();
    eprintln!("KEIKO_DIAGNOSTIC_DISPATCH");
    let serialized = match serde_json::to_vec(&envelope) {
        Ok(value) => value,
        Err(_) => return record_invalid(&state, Code::InvalidRequest),
    };
    if serialized.len() > MAX_ENVELOPE_BYTES {
        let mut journey = state.journey.lock().expect("journey state is available");
        journey.oversized = Some(Code::PayloadTooLarge);
        return Reply::rejected(Code::PayloadTooLarge);
    }
    if let Err(code) = authorize_caller(
        window.label(),
        window.url().ok().as_ref(),
        state.authority_active,
    ) {
        return Reply::rejected(code);
    }
    let envelope: Envelope = match serde_json::from_slice(&serialized) {
        Ok(value) => value,
        Err(_) => return record_invalid(&state, Code::InvalidRequest),
    };
    if envelope.schema_version != 1 {
        return record_invalid(&state, Code::InvalidRequest);
    }

    let request_id = envelope.request_id;
    let registration = register_request_id(
        &mut state
            .seen_request_ids
            .lock()
            .expect("request correlation state is available"),
        &request_id,
    );
    if let Err(code) = registration {
        if code == Code::ReplayedRequest {
            state
                .journey
                .lock()
                .expect("journey state is available")
                .replay = Some(code);
        }
        let mut reply = if code == Code::ReplayedRequest {
            Reply::rejected(code)
        } else {
            record_invalid(&state, code)
        };
        reply.request_id = Some(request_id);
        return reply;
    }

    if state.manual && !manual_operation_allowed(&envelope.operation) {
        let mut reply = Reply::rejected(Code::Unauthorized);
        reply.request_id = Some(request_id);
        return reply;
    }

    let mut reply = match envelope.operation {
        Operation::PrepareRenderer => prepare_renderer(&app, &window, &state),
        Operation::StableShell(data) => stable_shell(data, &state),
        Operation::Ping => {
            state
                .journey
                .lock()
                .expect("journey state is available")
                .ping = Some(Code::Accepted);
            Reply::accepted()
        }
        Operation::AccessibilityResult(data) => accessibility_result(data, &state),
        Operation::RuntimeEvent => runtime_event(&state),
        Operation::RuntimeEventCommitted(data) => runtime_event_committed(data, &state),
        Operation::BoundedWork(data) => bounded_work(data, &state),
        Operation::NativeDialog => native_dialog(&app, &state),
        Operation::FixtureProcess => fixture_process(&state),
        Operation::RendererCycle => renderer_cycle(&app, &state),
        Operation::EvaluationFailed(data) => {
            emit_failure_once(&app, &state.terminal_emitted, data.stage.diagnostic());
            Reply::rejected(Code::InvalidDiagnostics)
        }
        Operation::Finish(data) => finish(data, app.clone(), &state),
    };
    reply.request_id = Some(request_id);
    reply
}

fn manual_operation_allowed(operation: &Operation) -> bool {
    matches!(
        operation,
        Operation::PrepareRenderer | Operation::NativeDialog
    )
}

fn register_request_id(seen: &mut HashSet<String>, request_id: &str) -> Result<(), Code> {
    let valid = (16..=MAX_REQUEST_ID_BYTES).contains(&request_id.len())
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if !valid || seen.len() >= MAX_SEEN_REQUEST_IDS {
        return Err(Code::InvalidRequest);
    }
    if !seen.insert(request_id.to_owned()) {
        return Err(Code::ReplayedRequest);
    }
    Ok(())
}

fn prepare_renderer(app: &AppHandle, window: &WebviewWindow, state: &EvaluationState) -> Reply {
    #[cfg(target_os = "macos")]
    let shown = {
        let (sender, receiver) = mpsc::sync_channel(1);
        let scheduled = app.run_on_main_thread(move || {
            // SAFETY: the shim invokes AppKit only from the application main thread.
            let active = unsafe { keiko_evaluation_activate() } != 0;
            let _ = sender.send(active);
        });
        let activated =
            scheduled.is_ok() && receiver.recv_timeout(Duration::from_secs(1)) == Ok(true);
        app.show().is_ok() && window.show().is_ok() && window.set_focus().is_ok() && activated
    };
    #[cfg(not(target_os = "macos"))]
    let shown = window.show().is_ok() && window.set_focus().is_ok();
    eprintln!("KEIKO_DIAGNOSTIC_PREPARED:{shown}");
    let code = if shown {
        Code::Accepted
    } else {
        Code::RendererRecoveryFailed
    };
    state
        .journey
        .lock()
        .expect("journey state is available")
        .prepare_renderer = Some(code);
    Reply {
        ok: shown,
        code,
        ..Reply::accepted()
    }
}

fn record_invalid(state: &EvaluationState, code: Code) -> Reply {
    let mut journey = state.journey.lock().expect("journey state is available");
    journey.invalid_request_count = journey.invalid_request_count.saturating_add(1);
    Reply::rejected(code)
}

fn authorize_caller(
    label: &str,
    url: Option<&tauri::Url>,
    authority_active: bool,
) -> Result<(), Code> {
    if label != EXPECTED_WINDOW {
        return Err(Code::UnauthenticatedSender);
    }
    let Some(url) = url else {
        return Err(Code::UnauthenticatedOrigin);
    };
    let bundled = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
    if !bundled {
        return Err(Code::UnauthenticatedOrigin);
    }
    if !authority_active {
        return Err(Code::Unauthorized);
    }
    Ok(())
}

fn stable_shell(data: StableShell, state: &EvaluationState) -> Reply {
    if !data.double_rendered {
        return Reply::rejected(Code::InvalidDiagnostics);
    }
    state
        .journey
        .lock()
        .expect("journey state is available")
        .stable_shell = Some(Code::Accepted);
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "KEIKO_PRESENTED");
    let _ = stdout.flush();
    Reply {
        elapsed_ms: Some(state.started.elapsed().as_secs_f64() * 1_000.0),
        ..Reply::accepted()
    }
}

fn accessibility_result(data: AccessibilityResult, state: &EvaluationState) -> Reply {
    let valid = data.rule_ids.len() == usize::from(data.violation_count)
        && data.rule_ids.len() <= MAX_AXE_RULE_IDS
        && data.rule_ids.iter().all(|id| {
            !id.is_empty()
                && id.len() <= MAX_AXE_RULE_ID_BYTES
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
        && data.rule_ids.iter().collect::<HashSet<_>>().len() == data.rule_ids.len();
    if !valid {
        return Reply::rejected(Code::InvalidDiagnostics);
    }
    let code = if data.violation_count == 0 {
        Code::Accepted
    } else {
        Code::AccessibilityViolation
    };
    let mut journey = state.journey.lock().expect("journey state is available");
    journey.accessibility = Some(code);
    journey.axe_violation_count = Some(data.violation_count);
    journey.axe_rule_ids = data.rule_ids;
    Reply {
        ok: code == Code::Accepted,
        code,
        ..Reply::accepted()
    }
}

fn runtime_event(state: &EvaluationState) -> Reply {
    let token = "runtime-event-1".to_owned();
    *state
        .runtime_event
        .lock()
        .expect("runtime event state is available") = Some((token.clone(), Instant::now()));
    state
        .journey
        .lock()
        .expect("journey state is available")
        .runtime_event = Some(Code::Accepted);
    Reply {
        event_token: Some(token),
        ui_value: Some("accepted"),
        ..Reply::accepted()
    }
}

fn runtime_event_committed(data: RuntimeEventCommitted, state: &EvaluationState) -> Reply {
    let pending = state
        .runtime_event
        .lock()
        .expect("runtime event state is available")
        .take();
    let Some((token, started)) = pending else {
        return Reply::rejected(Code::InvalidRequest);
    };
    if token != data.token {
        return Reply::rejected(Code::InvalidRequest);
    }
    let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let mut journey = state.journey.lock().expect("journey state is available");
    journey.runtime_event_committed = Some(Code::Accepted);
    journey.runtime_to_ui_ms = Some(elapsed_ms);
    Reply {
        elapsed_ms: Some(elapsed_ms),
        ..Reply::accepted()
    }
}

fn bounded_work(data: BoundedWork, state: &EvaluationState) -> Reply {
    if data.work_ms == 0
        || data.work_ms > 1_000
        || data.timeout_ms == 0
        || data.timeout_ms > 1_000
        || data.cancel_after_ms.is_some_and(|value| value > 1_000)
    {
        return Reply::rejected(Code::InvalidRequest);
    }

    let started = Instant::now();
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = cancelled.clone();
    let work_ms = data.work_ms;
    let worker = std::thread::spawn(move || {
        let work_started = Instant::now();
        let mut accumulator = 0_u64;
        while work_started.elapsed() < Duration::from_millis(work_ms) {
            if worker_cancelled.load(Ordering::Acquire) {
                return false;
            }
            accumulator = accumulator.wrapping_mul(31).wrapping_add(1);
            std::hint::black_box(accumulator);
            std::thread::yield_now();
        }
        true
    });

    let decision = loop {
        let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        match work_decision(
            elapsed_ms,
            data.work_ms,
            data.timeout_ms,
            data.cancel_after_ms,
        ) {
            WorkDecision::Continue => std::thread::sleep(Duration::from_millis(1)),
            decision => break decision,
        }
    };
    if decision != WorkDecision::Completed {
        cancelled.store(true, Ordering::Release);
    }
    let completed = worker.join().unwrap_or(false);
    let code = match decision {
        WorkDecision::Cancelled => Code::Cancelled,
        WorkDecision::TimedOut => Code::TimedOut,
        WorkDecision::Completed if completed => Code::Accepted,
        _ => Code::InvalidRequest,
    };
    let mut journey = state.journey.lock().expect("journey state is available");
    match code {
        Code::Cancelled => journey.cancelled_work = Some(code),
        Code::TimedOut => journey.timed_out_work = Some(code),
        _ => {}
    }
    Reply {
        ok: code == Code::Accepted,
        code,
        elapsed_ms: Some(started.elapsed().as_secs_f64() * 1_000.0),
        ..Reply::accepted()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkDecision {
    Continue,
    Cancelled,
    TimedOut,
    Completed,
}

fn work_decision(
    elapsed_ms: u64,
    work_ms: u64,
    timeout_ms: u64,
    cancel_after_ms: Option<u64>,
) -> WorkDecision {
    if cancel_after_ms.is_some_and(|cancel| elapsed_ms >= cancel) {
        WorkDecision::Cancelled
    } else if elapsed_ms >= timeout_ms {
        WorkDecision::TimedOut
    } else if elapsed_ms >= work_ms {
        WorkDecision::Completed
    } else {
        WorkDecision::Continue
    }
}

fn native_dialog(app: &AppHandle, state: &EvaluationState) -> Reply {
    let (sender, receiver) = mpsc::sync_channel(1);
    if app
        .run_on_main_thread(move || {
            // SAFETY: the shim owns its AppKit objects and runs on the application main thread.
            let cancelled = unsafe { keiko_evaluation_native_dialog_cancel() } != 0;
            let _ = sender.send(cancelled);
        })
        .is_err()
    {
        return Reply::rejected(Code::NativeSurfaceUnavailable);
    }
    let reply = match receiver.recv_timeout(Duration::from_secs(2)) {
        Ok(true) => Reply::accepted(),
        Ok(false) => Reply::rejected(Code::NativeSurfaceNotCancelled),
        Err(_) => Reply::rejected(Code::NativeSurfaceTimeout),
    };
    state
        .journey
        .lock()
        .expect("journey state is available")
        .native_dialog = Some(reply.code);
    reply
}

fn fixture_process(state: &EvaluationState) -> Reply {
    let started = Instant::now();
    let (Some(marker), Some(ack), Some(escalation_ack), Some(cleanup_ack)) = (
        state.fixture_marker.as_deref(),
        state.fixture_ack.as_deref(),
        state.fixture_escalation_ack.as_deref(),
        state.fixture_cleanup_ack.as_deref(),
    ) else {
        return Reply::rejected(Code::FixtureUnavailable);
    };
    let mut command = Command::new("/usr/bin/tail");
    command
        .arg0(marker)
        .args(["-f", "/dev/null"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: this runs after fork and before exec, creates a new session, and
    // installs the standard ignored disposition that survives exec.
    unsafe {
        command.pre_exec(|| {
            if setsid() == -1 || signal(15, 1) == usize::MAX {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = match command.spawn() {
        Ok(value) => value,
        Err(_) => return Reply::rejected(Code::FixtureUnavailable),
    };
    let group = i32::try_from(child.id()).unwrap_or(i32::MAX);
    let session_isolated = unsafe { getsid(group) == group && getpgid(group) == group };
    let exec_changed = std::env::current_exe()
        .ok()
        .zip(std::fs::canonicalize("/usr/bin/tail").ok())
        .is_some_and(|(current, helper)| current != helper);
    let ack_deadline = Instant::now() + Duration::from_secs(2);
    while !acknowledged(ack) && Instant::now() < ack_deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    if !acknowledged(ack) {
        let _ = signal_group(group, 9);
        let _ = wait_for_reaped_group_absence(
            &mut child,
            group,
            Duration::from_millis(FIXTURE_KILL_MS),
        );
        return Reply::rejected(Code::FixtureUnavailable);
    }
    let term_sent = signal_group(group, 15);
    let exited_after_term =
        wait_for_reaped_group_absence(&mut child, group, Duration::from_millis(FIXTURE_TERM_MS));
    let escalated = term_sent && !exited_after_term;
    if escalated {
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "KEIKO_FIXTURE_ESCALATED");
        let _ = stdout.flush();
        let escalation_deadline = Instant::now() + Duration::from_secs(2);
        while !acknowledged(escalation_ack) && Instant::now() < escalation_deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        if !acknowledged(escalation_ack) {
            let _ = signal_group(group, 9);
            let _ = wait_for_reaped_group_absence(
                &mut child,
                group,
                Duration::from_millis(FIXTURE_KILL_MS),
            );
            return Reply::rejected(Code::FixtureUnavailable);
        }
        let _ = signal_group(group, 9);
    }
    let exited = exited_after_term
        || wait_for_reaped_group_absence(&mut child, group, Duration::from_millis(FIXTURE_KILL_MS));
    if !exited {
        let _ = signal_group(group, 9);
    }
    let absent = !group_exists(group);
    if exited && absent {
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "KEIKO_FIXTURE_CLEANED");
        let _ = stdout.flush();
        let cleanup_deadline = Instant::now() + Duration::from_secs(2);
        while !acknowledged(cleanup_ack) && Instant::now() < cleanup_deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        if !acknowledged(cleanup_ack) {
            return Reply::rejected(Code::FixtureUnavailable);
        }
    }
    let code = fixture_cleanup_code(term_sent, escalated, exited, absent);
    let mut journey = state.journey.lock().expect("journey state is available");
    journey.fixture_process = Some(code);
    journey.fixture_escalated = Some(escalated);
    journey.fixture_parent_reaped = Some(exited);
    journey.fixture_group_absent = Some(absent);
    journey.fixture_session_isolated = Some(session_isolated);
    journey.fixture_exec_changed = Some(exec_changed);
    journey.fixture_descendant_absent = Some(exited && absent);
    Reply {
        ok: code == Code::Accepted,
        code,
        elapsed_ms: Some(started.elapsed().as_secs_f64() * 1_000.0),
        escalated: Some(escalated),
        ..Reply::accepted()
    }
}

fn acknowledged(path: &str) -> bool {
    std::fs::symlink_metadata(Path::new(path)).is_ok_and(|metadata| {
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.permissions().mode() & 0o777 == 0o600
    })
}

fn signal_group(group: i32, signal: i32) -> bool {
    // SAFETY: a negative PID targets only the fixture's newly created process group.
    (unsafe { kill(-group, signal) }) == 0
}

fn group_exists(group: i32) -> bool {
    // SAFETY: signal zero probes existence without mutating the process group.
    (unsafe { kill(-group, 0) }) == 0
}

fn fixture_cleanup_code(term_sent: bool, escalated: bool, exited: bool, absent: bool) -> Code {
    if term_sent && escalated && exited && absent {
        Code::Accepted
    } else {
        Code::ProcessCleanupFailed
    }
}

fn emit_failure_once(app: &AppHandle, terminal_emitted: &AtomicBool, category: &'static str) {
    if terminal_emitted
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        eprintln!("KEIKO_DIAGNOSTIC_FAILURE:{category}");
        let _ = std::io::stderr().flush();
        app.exit(1);
    }
}

fn wait_for_reaped_group_absence(child: &mut Child, group: i32, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        let parent_reaped = child.try_wait().ok().flatten().is_some();
        if parent_reaped && !group_exists(group) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn renderer_cycle(app: &AppHandle, state: &EvaluationState) -> Reply {
    let started = Instant::now();
    let host = std::process::id();
    let first_id = format!("renderer-probe-first-{host}");
    let second_id = format!("renderer-probe-second-{host}");
    let first = create_probe(app, &first_id);
    let first_acl_denied = first.as_ref().is_some_and(|probe| probe.acl_denied);
    let first_destroyed = first
        .as_ref()
        .is_some_and(|probe| destroy_probe(app, probe.window.clone()));
    let first_absent = wait_for_window_absence(app, &first_id, Duration::from_secs(1));
    let second = create_probe(app, &second_id);
    let second_acl_denied = second.as_ref().is_some_and(|probe| probe.acl_denied);
    let recreated = first.is_some()
        && first_destroyed
        && first_absent
        && second.is_some()
        && first_id != second_id;
    let second_destroyed = second
        .as_ref()
        .is_some_and(|probe| destroy_probe(app, probe.window.clone()));
    let second_absent = wait_for_window_absence(app, &second_id, Duration::from_secs(1));
    let host_survived = host == std::process::id() && app.get_webview_window("main").is_some();
    eprintln!(
        "KEIKO_DIAGNOSTIC_CYCLE:first_loaded={},first_acl_denied={first_acl_denied},first_destroyed={first_destroyed},first_absent={first_absent},second_loaded={},second_acl_denied={second_acl_denied},second_destroyed={second_destroyed},second_absent={second_absent},host_survived={host_survived}",
        first.is_some(),
        second.is_some()
    );
    let code = if recreated
        && first_acl_denied
        && second_acl_denied
        && second_destroyed
        && second_absent
        && host_survived
    {
        Code::Accepted
    } else {
        Code::RendererRecoveryFailed
    };
    let mut journey = state.journey.lock().expect("journey state is available");
    journey.renderer_cycle = Some(code);
    journey.probe_acl_denied = Some(first_acl_denied && second_acl_denied);
    journey.renderer_recreated = Some(recreated);
    journey.host_survived = Some(host_survived);
    journey.first_instance_id = Some(first_id.clone());
    journey.second_instance_id = Some(second_id.clone());
    Reply {
        ok: code == Code::Accepted,
        code,
        elapsed_ms: Some(started.elapsed().as_secs_f64() * 1_000.0),
        escalated: None,
        renderer_recreated: Some(recreated),
        host_survived: Some(host_survived),
        first_instance_id: Some(first_id),
        second_instance_id: Some(second_id),
        ..Reply::accepted()
    }
}

struct Probe {
    window: WebviewWindow,
    acl_denied: bool,
}

fn create_probe(app: &AppHandle, label: &str) -> Option<Probe> {
    let (built_sender, built_receiver) = mpsc::sync_channel(1);
    let (loaded_sender, loaded_receiver) = mpsc::sync_channel(1);
    let (acl_sender, acl_receiver) = mpsc::sync_channel(1);
    let handle = app.clone();
    let label = label.to_owned();
    if app
        .run_on_main_thread(move || {
            let result =
                WebviewWindowBuilder::new(&handle, &label, WebviewUrl::App("probe.html".into()))
                    .title("Renderer recovery probe")
                    .visible(true)
                    .inner_size(360.0, 180.0)
                    .on_navigation(move |url| {
                        if let Some(denied) = probe_navigation_result(url.path()) {
                            let _ = acl_sender.try_send(denied);
                            return false;
                        }
                        (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                            || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
                    })
                    .on_page_load(move |_, payload| {
                        if payload.event() == PageLoadEvent::Finished {
                            let _ = loaded_sender.try_send(());
                        }
                    })
                    .build()
                    .ok();
            let _ = built_sender.send(result);
        })
        .is_err()
    {
        return None;
    }
    let window = built_receiver
        .recv_timeout(Duration::from_secs(1))
        .ok()
        .flatten()?;
    if loaded_receiver
        .recv_timeout(Duration::from_secs(1))
        .is_err()
    {
        let _ = destroy_probe(app, window);
        return None;
    }
    let acl_denied = acl_receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap_or(false);
    Some(Probe { window, acl_denied })
}

fn probe_navigation_result(path: &str) -> Option<bool> {
    match path {
        "/__keiko-probe-acl-denied__" => Some(true),
        "/__keiko-probe-bridge-unavailable__"
        | "/__keiko-probe-unexpectedly-allowed__"
        | "/__keiko-probe-non-acl-error__" => Some(false),
        _ => None,
    }
}

fn destroy_probe(app: &AppHandle, window: WebviewWindow) -> bool {
    let (sender, receiver) = mpsc::sync_channel(1);
    if app
        .run_on_main_thread(move || {
            let _ = sender.send(window.destroy().is_ok());
        })
        .is_err()
    {
        return false;
    }
    receiver.recv_timeout(Duration::from_secs(1)) == Ok(true)
}

fn wait_for_window_absence(app: &AppHandle, label: &str, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if app.get_webview_window(label).is_none() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    app.get_webview_window(label).is_none()
}

fn finish(data: Finish, app: AppHandle, state: &EvaluationState) -> Reply {
    if !data.diagnostics.valid() {
        emit_failure_once(
            &app,
            &state.terminal_emitted,
            "host-invalid-finish-diagnostics",
        );
        return Reply::rejected(Code::InvalidDiagnostics);
    }
    let journey = state
        .journey
        .lock()
        .expect("journey state is available")
        .clone();
    let complete = journey.prepare_renderer == Some(Code::Accepted)
        && journey.stable_shell == Some(Code::Accepted)
        && journey.ping == Some(Code::Accepted)
        && journey.replay == Some(Code::ReplayedRequest)
        && journey.accessibility == Some(Code::Accepted)
        && journey.axe_violation_count == Some(0)
        && journey.axe_rule_ids.is_empty()
        && journey.runtime_event == Some(Code::Accepted)
        && journey.runtime_event_committed == Some(Code::Accepted)
        && journey
            .runtime_to_ui_ms
            .is_some_and(|value| value.is_finite())
        && journey.invalid_request_count >= 2
        && journey.oversized == Some(Code::PayloadTooLarge)
        && journey.cancelled_work == Some(Code::Cancelled)
        && journey.timed_out_work == Some(Code::TimedOut)
        && journey.native_dialog == Some(Code::Accepted)
        && journey.fixture_process == Some(Code::Accepted)
        && journey.fixture_escalated == Some(true)
        && journey.fixture_parent_reaped == Some(true)
        && journey.fixture_group_absent == Some(true)
        && journey.fixture_session_isolated == Some(true)
        && journey.fixture_exec_changed == Some(true)
        && journey.fixture_descendant_absent == Some(true)
        && journey.renderer_cycle == Some(Code::Accepted)
        && journey.probe_acl_denied == Some(true)
        && journey.renderer_recreated == Some(true)
        && journey.host_survived == Some(true)
        && journey.first_instance_id != journey.second_instance_id;
    if !complete {
        emit_failure_once(&app, &state.terminal_emitted, "host-journey-incomplete");
        return Reply::rejected(Code::InvalidDiagnostics);
    }

    let evidence = Evidence {
        schema_version: 1,
        candidate: "tauri-system-webview",
        mode: state.mode,
        environment: Environment {
            architecture: std::env::consts::ARCH,
            os_family: std::env::consts::OS,
            reference_class: "owner-m4-16gib-macos26",
        },
        dependencies: DependencyEvidence {
            frontend: "react-19.2.7-typescript-5.9.3-vite-7.3.6-axe-core-4.12.1",
            host: "tauri-2.11.5",
            renderer: "system-webview",
            rust: "1.92.0",
        },
        process_accounting: ProcessAccounting {
            definition: "root-process-and-observed-descendants",
            rss_comparable_for_win_gate: false,
            limitation: "shared-webkit-xpc-processes-are-not-consistently-attributable",
        },
        diagnostics: data.diagnostics,
        journey,
    };
    let encoded = match serde_json::to_string(&evidence) {
        Ok(value) if value.len() <= 16_384 => value,
        _ => {
            emit_failure_once(&app, &state.terminal_emitted, "host-evidence-invalid");
            return Reply::rejected(Code::InvalidDiagnostics);
        }
    };
    if state
        .terminal_emitted
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Reply::rejected(Code::InvalidDiagnostics);
    }
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "KEIKO_EVIDENCE:{encoded}");
    let _ = writeln!(stdout, "KEIKO_SHUTDOWN_START");
    let _ = stdout.flush();
    app.exit(0);
    Reply::accepted()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_envelope() -> Value {
        serde_json::json!({
            "schemaVersion": 1,
            "requestId": "request-00000001",
            "operation": { "kind": "ping" }
        })
    }

    #[test]
    fn envelope_is_closed_and_bounded() {
        assert!(serde_json::from_value::<Envelope>(valid_envelope()).is_ok());
        let mut unknown = valid_envelope();
        unknown["unexpected"] = Value::Bool(true);
        assert!(serde_json::from_value::<Envelope>(unknown).is_err());
        let mut hostile = valid_envelope();
        hostile["operation"]["kind"] = Value::String("shell".into());
        assert!(serde_json::from_value::<Envelope>(hostile).is_err());
        assert!(serde_json::to_vec(&valid_envelope()).unwrap().len() < MAX_ENVELOPE_BYTES);
    }

    #[test]
    fn caller_identity_comes_from_host_metadata() {
        let bundled = "tauri://localhost/index.html"
            .parse::<tauri::Url>()
            .unwrap();
        let hostile = "https://hostile.invalid".parse::<tauri::Url>().unwrap();
        assert_eq!(
            authorize_caller("other", Some(&bundled), true),
            Err(Code::UnauthenticatedSender)
        );
        assert_eq!(
            authorize_caller(EXPECTED_WINDOW, Some(&hostile), true),
            Err(Code::UnauthenticatedOrigin)
        );
        assert_eq!(
            authorize_caller(EXPECTED_WINDOW, Some(&bundled), false),
            Err(Code::Unauthorized)
        );
        assert_eq!(
            authorize_caller(EXPECTED_WINDOW, Some(&bundled), true),
            Ok(())
        );
    }

    #[test]
    fn execution_modes_are_explicit_and_mutually_exclusive() {
        assert_eq!(
            select_execution_mode(true, false, Some("cold"), true),
            Some(("cold", false))
        );
        assert_eq!(
            select_execution_mode(true, false, Some("warm"), true),
            Some(("warm", false))
        );
        assert_eq!(
            select_execution_mode(false, true, None, false),
            Some(("manual", true))
        );
        assert_eq!(select_execution_mode(false, false, None, false), None);
        assert_eq!(select_execution_mode(true, true, Some("warm"), true), None);
        assert_eq!(select_execution_mode(false, true, Some("warm"), true), None);
    }

    #[test]
    fn manual_mode_exposes_only_physical_journey_effects() {
        assert!(manual_operation_allowed(&Operation::PrepareRenderer));
        assert!(manual_operation_allowed(&Operation::NativeDialog));
        assert!(!manual_operation_allowed(&Operation::Ping));
        assert!(!manual_operation_allowed(&Operation::RendererCycle));
    }

    #[test]
    fn probe_accepts_only_the_exact_acl_denial_sentinel() {
        assert_eq!(
            probe_navigation_result("/__keiko-probe-acl-denied__"),
            Some(true)
        );
        assert_eq!(
            probe_navigation_result("/__keiko-probe-unexpectedly-allowed__"),
            Some(false)
        );
        assert_eq!(probe_navigation_result("/probe.html"), None);
        assert_eq!(
            probe_navigation_result("/__keiko-probe-acl-denied__/x"),
            None
        );
    }

    #[test]
    fn request_ids_are_bounded_unique_and_replay_safe() {
        let mut seen = HashSet::new();
        assert_eq!(register_request_id(&mut seen, "request-00000001"), Ok(()));
        assert_eq!(
            register_request_id(&mut seen, "request-00000001"),
            Err(Code::ReplayedRequest)
        );
        assert_eq!(
            register_request_id(&mut seen, "short"),
            Err(Code::InvalidRequest)
        );
        assert_eq!(
            register_request_id(&mut seen, &"x".repeat(MAX_REQUEST_ID_BYTES + 1)),
            Err(Code::InvalidRequest)
        );
        assert_eq!(
            register_request_id(&mut seen, "request_with_underscore"),
            Err(Code::InvalidRequest)
        );
    }

    #[test]
    fn accessibility_summary_is_closed_and_bounded() {
        let state = EvaluationState {
            authority_active: true,
            journey: Mutex::new(Journey::default()),
            fixture_ack: None,
            fixture_cleanup_ack: None,
            fixture_escalation_ack: None,
            fixture_marker: None,
            manual: false,
            mode: "warm",
            started: Instant::now(),
            runtime_event: Mutex::new(None),
            seen_request_ids: Mutex::new(HashSet::new()),
            terminal_emitted: Arc::new(AtomicBool::new(false)),
        };
        let accepted = accessibility_result(
            AccessibilityResult {
                violation_count: 0,
                rule_ids: Vec::new(),
            },
            &state,
        );
        assert_eq!(accepted.code, Code::Accepted);
        let rejected = accessibility_result(
            AccessibilityResult {
                violation_count: 1,
                rule_ids: vec!["color-contrast".into()],
            },
            &state,
        );
        assert_eq!(rejected.code, Code::AccessibilityViolation);
        let invalid = accessibility_result(
            AccessibilityResult {
                violation_count: 1,
                rule_ids: vec!["raw DOM".into()],
            },
            &state,
        );
        assert_eq!(invalid.code, Code::InvalidDiagnostics);
    }

    #[test]
    fn work_policy_uses_injected_elapsed_time_without_sleeping() {
        assert_eq!(work_decision(4, 40, 50, Some(5)), WorkDecision::Continue);
        assert_eq!(work_decision(5, 40, 50, Some(5)), WorkDecision::Cancelled);
        assert_eq!(work_decision(5, 40, 5, None), WorkDecision::TimedOut);
        assert_eq!(work_decision(40, 40, 50, None), WorkDecision::Completed);
    }

    #[test]
    fn fixture_cleanup_requires_reap_and_exact_group_absence() {
        assert_eq!(fixture_cleanup_code(true, true, true, true), Code::Accepted);
        assert_eq!(
            fixture_cleanup_code(true, true, false, true),
            Code::ProcessCleanupFailed
        );
        assert_eq!(
            fixture_cleanup_code(true, true, true, false),
            Code::ProcessCleanupFailed
        );
        assert_eq!(
            fixture_cleanup_code(true, false, true, true),
            Code::ProcessCleanupFailed
        );
    }

    #[test]
    fn frontend_failure_stage_is_closed_and_sanitized() {
        let parsed: EvaluationFailed = serde_json::from_value(serde_json::json!({
            "stage": "fixture-process"
        }))
        .unwrap();
        assert_eq!(parsed.stage, FailureStage::FixtureProcess);
        assert_eq!(parsed.stage.diagnostic(), "frontend-fixture-process");
        assert!(parsed.stage.diagnostic().len() <= 64);
        assert!(
            serde_json::from_value::<EvaluationFailed>(serde_json::json!({
                "stage": "fixture-process",
                "message": "raw failure"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<EvaluationFailed>(serde_json::json!({
                "stage": "raw-free-form"
            }))
            .is_err()
        );
    }

    #[test]
    fn diagnostics_are_closed_and_bounded() {
        let valid = serde_json::json!({
            "appearanceDiagnostic": true,
            "compositionDiagnostic": true,
            "focusDiagnostic": true,
            "inputDiagnosticMs": 10.0,
            "scaleFactorDiagnostic": 2.0
        });
        let parsed: Diagnostics = serde_json::from_value(valid.clone()).unwrap();
        assert!(parsed.valid());
        let mut unknown = valid;
        unknown["rawPath"] = Value::String("denied".into());
        assert!(serde_json::from_value::<Diagnostics>(unknown).is_err());
    }
}
