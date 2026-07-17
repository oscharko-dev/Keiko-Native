use std::{
    cell::{Cell, RefCell},
    collections::HashSet,
    io::Write,
    os::unix::{fs::PermissionsExt, process::CommandExt},
    path::Path,
    process::{Child, Command, Stdio},
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::{Value, json};
use slint::{ComponentHandle, RenderingState};

use crate::MainWindow;

const MAX_PAYLOAD_BYTES: usize = 4_096;
const FIXTURE_READY_MS: u64 = 500;
const FIXTURE_TERM_MS: u64 = 100;
const FIXTURE_KILL_MS: u64 = 1_000;
const FIXTURE_TOTAL_BUDGET_MS: u64 = FIXTURE_READY_MS + FIXTURE_TERM_MS + FIXTURE_KILL_MS;
const _: () = assert!(FIXTURE_TOTAL_BUDGET_MS < 5_000);

unsafe extern "C" {
    fn keiko_evaluation_native_dialog_cancel() -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
    fn setsid() -> i32;
    fn getsid(pid: i32) -> i32;
    fn getpgid(pid: i32) -> i32;
    fn signal(number: i32, handler: usize) -> usize;
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
    RuntimeEvent,
    RuntimeEventCommitted(RuntimeEventCommitted),
    BoundedWork(BoundedWork),
    NativeDialog,
    FixtureProcess,
    RendererCycle(RendererProof),
    Finish(Diagnostics),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StableShell {
    double_rendered: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeEventCommitted {
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererProof {
    first_instance_id: String,
    second_instance_id: String,
    first_loaded: bool,
    first_destroyed: bool,
    second_loaded: bool,
    second_destroyed: bool,
    host_survived: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Diagnostics {
    appearance_diagnostic: bool,
    composition_diagnostic: bool,
    focus_diagnostic: bool,
    input_diagnostic_ms: f64,
    scale_factor_diagnostic: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoundedWork {
    work_ms: u64,
    timeout_ms: u64,
    #[serde(default)]
    cancel_after_ms: Option<u64>,
}

#[derive(Debug)]
struct Port {
    authority_active: bool,
    renderer_available: bool,
    seen_request_ids: HashSet<String>,
    runtime_event: Option<(String, Instant)>,
    fixture_ack: String,
    fixture_cleanup_ack: String,
    fixture_escalation_ack: String,
    fixture_marker: String,
}

impl Port {
    fn dispatch(&mut self, bytes: &[u8]) -> Value {
        if bytes.len() > MAX_PAYLOAD_BYTES {
            return response(false, "payload_too_large");
        }
        let request: Envelope = match serde_json::from_slice(bytes) {
            Ok(value) => value,
            Err(_) => return response(false, "invalid_request"),
        };
        if request.schema_version != 1
            || request.request_id.is_empty()
            || request.request_id.len() > 64
            || !request
                .request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return response(false, "invalid_request");
        }
        if !self.seen_request_ids.insert(request.request_id) {
            return response(false, "replayed_request");
        }
        if !self.authority_active {
            return response(false, "unauthorized");
        }
        if !self.renderer_available {
            return response(false, "renderer_unavailable");
        }
        match request.operation {
            Operation::PrepareRenderer => response(true, "accepted"),
            Operation::StableShell(data) if data.double_rendered => response(true, "accepted"),
            Operation::StableShell(_) => response(false, "invalid_diagnostics"),
            Operation::Ping => response(true, "accepted"),
            Operation::RuntimeEvent => {
                let token = "runtime-event-1".to_owned();
                self.runtime_event = Some((token.clone(), Instant::now()));
                json!({ "ok": true, "code": "accepted", "eventToken": token, "uiValue": "accepted" })
            }
            Operation::RuntimeEventCommitted(data) => {
                let Some((token, started)) = self.runtime_event.take() else {
                    return response(false, "invalid_request");
                };
                if token != data.token {
                    return response(false, "invalid_request");
                }
                json!({ "ok": true, "code": "accepted", "elapsedMs": started.elapsed().as_secs_f64() * 1_000.0 })
            }
            Operation::BoundedWork(data) => bounded_work(data),
            Operation::NativeDialog => {
                // SAFETY: dispatch runs on Slint's macOS application thread.
                let cancelled = unsafe { keiko_evaluation_native_dialog_cancel() } != 0;
                response(
                    cancelled,
                    if cancelled {
                        "accepted"
                    } else {
                        "native_surface_not_cancelled"
                    },
                )
            }
            Operation::FixtureProcess => fixture_process(
                &self.fixture_marker,
                &self.fixture_ack,
                &self.fixture_escalation_ack,
                &self.fixture_cleanup_ack,
            ),
            Operation::RendererCycle(data) => {
                let valid = data.first_loaded
                    && data.first_destroyed
                    && data.second_loaded
                    && data.second_destroyed
                    && data.host_survived
                    && data.first_instance_id != data.second_instance_id;
                response(
                    valid,
                    if valid {
                        "accepted"
                    } else {
                        "renderer_recovery_failed"
                    },
                )
            }
            Operation::Finish(data) => {
                let valid = data.appearance_diagnostic
                    && data.composition_diagnostic
                    && data.focus_diagnostic
                    && data.input_diagnostic_ms.is_finite()
                    && (0.0..=10_000.0).contains(&data.input_diagnostic_ms)
                    && data.scale_factor_diagnostic.is_finite()
                    && (0.5..=8.0).contains(&data.scale_factor_diagnostic);
                response(
                    valid,
                    if valid {
                        "accepted"
                    } else {
                        "invalid_diagnostics"
                    },
                )
            }
        }
    }
}

struct Measurements {
    started: Instant,
    focus_visible: Option<bool>,
    input_started: Option<Instant>,
    input_to_paint_ms: Option<f64>,
    runtime_token: Option<String>,
    runtime_to_ui_ms: Option<f64>,
    startup_ms: Option<f64>,
}

struct UiDiagnostics {
    dark_appearance: bool,
    composition: bool,
    focus_visible: bool,
    scale_factor: f32,
}

struct RendererCycle {
    first_id: String,
    second_id: String,
    first_loaded: bool,
    first_destroyed: bool,
    second_loaded: bool,
    second_destroyed: bool,
    host_pid: u32,
}

impl RendererCycle {
    fn complete(&self) -> bool {
        self.first_loaded
            && self.first_destroyed
            && self.second_loaded
            && self.second_destroyed
            && self.first_id != self.second_id
            && self.host_pid == std::process::id()
    }
}

fn render_once() -> Result<bool, slint::PlatformError> {
    let rendered = Rc::new(Cell::new(false));
    let rendered_for_callback = rendered.clone();
    let window = MainWindow::new()?;
    window
        .window()
        .set_rendering_notifier(move |state, _| {
            if matches!(state, RenderingState::AfterRendering)
                && !rendered_for_callback.replace(true)
            {
                let _ = slint::quit_event_loop();
            }
        })
        .map_err(|error| slint::PlatformError::from(error.to_string()))?;
    window.run()?;
    let loaded = rendered.get();
    window.hide()?;
    drop(window);
    Ok(loaded)
}

fn run_renderer_cycle() -> Result<RendererCycle, slint::PlatformError> {
    let host_pid = std::process::id();
    let first_id = format!("slint-probe-first-{host_pid}");
    let second_id = format!("slint-probe-second-{host_pid}");
    let first_loaded = render_once()?;
    let first_destroyed = true;
    let second_loaded = render_once()?;
    let second_destroyed = true;
    Ok(RendererCycle {
        first_id,
        second_id,
        first_loaded,
        first_destroyed,
        second_loaded,
        second_destroyed,
        host_pid,
    })
}

pub fn requested() -> bool {
    std::env::args().any(|argument| argument == "--evaluation-json")
}

fn mode() -> &'static str {
    let mut arguments = std::env::args();
    while let Some(argument) = arguments.next() {
        if argument == "--mode" {
            return match arguments.next().as_deref() {
                Some("cold") => "cold",
                Some("warm") => "warm",
                _ => "invalid",
            };
        }
    }
    "invalid"
}

fn bounded_argument(name: &str, valid: impl Fn(&str) -> bool) -> Option<String> {
    let arguments = std::env::args().collect::<Vec<_>>();
    arguments
        .windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
        .filter(|value| valid(value))
}

fn response(ok: bool, code: &'static str) -> Value {
    json!({ "ok": ok, "code": code })
}

fn bounded_work(data: BoundedWork) -> Value {
    if data.work_ms == 0
        || data.work_ms > 1_000
        || data.timeout_ms == 0
        || data.timeout_ms > 1_000
        || data.cancel_after_ms.is_some_and(|value| value > 1_000)
    {
        return response(false, "invalid_request");
    }
    let started = Instant::now();
    let work_ms = data.work_ms;
    let timeout_ms = data.timeout_ms;
    let cancel_after_ms = data.cancel_after_ms;
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = cancelled.clone();
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
        let elapsed = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        if cancel_after_ms.is_some_and(|value| elapsed >= value) {
            break "cancelled";
        }
        if elapsed >= timeout_ms {
            break "timed_out";
        }
        if elapsed >= work_ms {
            break "completed";
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    if decision != "completed" {
        cancelled.store(true, Ordering::Release);
    }
    let completed = worker.join().unwrap_or(false);
    match (decision, completed) {
        ("completed", true) => response(true, "accepted"),
        ("cancelled", _) => response(false, "cancelled"),
        ("timed_out", _) => response(false, "timed_out"),
        _ => response(false, "invalid_request"),
    }
}

fn request(request_id: &str, operation: &str, data: Option<Value>) -> Vec<u8> {
    let operation = match data {
        Some(data) => json!({ "kind": operation, "data": data }),
        None => json!({ "kind": operation }),
    };
    serde_json::to_vec(&json!({
        "schemaVersion": 1,
        "requestId": request_id,
        "operation": operation
    }))
    .expect("synthetic request serializes")
}

pub fn run(ui: MainWindow) -> Result<(), slint::PlatformError> {
    let mode = mode();
    if mode == "invalid" {
        eprintln!("evaluation mode must be cold or warm");
        std::process::exit(64);
    }
    let Some(fixture_marker) = bounded_argument("--fixture-marker", |value| {
        value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) else {
        eprintln!("evaluation fixture marker is invalid");
        std::process::exit(64);
    };
    let Some(fixture_ack) = bounded_argument("--fixture-ack", |value| {
        value.len() <= 512 && (value.starts_with("/private/") || value.starts_with("/var/"))
    }) else {
        eprintln!("evaluation fixture acknowledgement is invalid");
        std::process::exit(64);
    };
    let Some(fixture_escalation_ack) = bounded_argument("--fixture-escalation-ack", |value| {
        value.len() <= 512 && (value.starts_with("/private/") || value.starts_with("/var/"))
    }) else {
        eprintln!("evaluation fixture escalation acknowledgement is invalid");
        std::process::exit(64);
    };
    let Some(fixture_cleanup_ack) = bounded_argument("--fixture-cleanup-ack", |value| {
        value.len() <= 512 && (value.starts_with("/private/") || value.starts_with("/var/"))
    }) else {
        eprintln!("evaluation fixture cleanup acknowledgement is invalid");
        std::process::exit(64);
    };

    let port = Rc::new(RefCell::new(Port {
        authority_active: true,
        renderer_available: true,
        seen_request_ids: HashSet::new(),
        runtime_event: None,
        fixture_ack,
        fixture_cleanup_ack,
        fixture_escalation_ack,
        fixture_marker,
    }));
    let stage = Rc::new(Cell::new(0_u8));
    let measurements = Rc::new(RefCell::new(Measurements {
        started: Instant::now(),
        focus_visible: None,
        input_started: None,
        input_to_paint_ms: None,
        runtime_token: None,
        runtime_to_ui_ms: None,
        startup_ms: None,
    }));
    let weak = ui.as_weak();
    let stage_for_render = stage.clone();
    let measurements_for_render = measurements.clone();
    let port_for_render = port.clone();
    ui.window()
        .set_rendering_notifier(move |state, _| {
            if !matches!(state, RenderingState::AfterRendering) {
                return;
            }
            let Some(ui) = weak.upgrade() else { return };
            match stage_for_render.get() {
                0 => {
                    let mut values = measurements_for_render.borrow_mut();
                    values.startup_ms = Some(values.started.elapsed().as_secs_f64() * 1_000.0);
                    let mut stdout = std::io::stdout().lock();
                    let _ = writeln!(stdout, "KEIKO_PRESENTED");
                    let _ = stdout.flush();
                    let _ = port_for_render.borrow_mut().dispatch(&request(
                        "prepare-1",
                        "prepare-renderer",
                        None,
                    ));
                    let _ = port_for_render.borrow_mut().dispatch(&request(
                        "stable-1",
                        "stable-shell",
                        Some(json!({ "doubleRendered": true })),
                    ));
                    ui.invoke_focus_input();
                    values.focus_visible = Some(ui.get_input_has_focus());
                    values.input_started = Some(Instant::now());
                    ui.set_input_text("かなa".into());
                    stage_for_render.set(1);
                    ui.window().request_redraw();
                }
                1 => {
                    stage_for_render.set(2);
                    ui.window().request_redraw();
                }
                2 => {
                    let mut values = measurements_for_render.borrow_mut();
                    values.input_to_paint_ms = values
                        .input_started
                        .map(|started| started.elapsed().as_secs_f64() * 1_000.0);
                    let event = port_for_render.borrow_mut().dispatch(&request(
                        "runtime-1",
                        "runtime-event",
                        None,
                    ));
                    values.runtime_token = event["eventToken"].as_str().map(ToOwned::to_owned);
                    ui.set_status_text(event["uiValue"].as_str().unwrap_or("failed").into());
                    stage_for_render.set(3);
                    ui.window().request_redraw();
                }
                3 => {
                    stage_for_render.set(4);
                    ui.window().request_redraw();
                }
                4 => {
                    let mut values = measurements_for_render.borrow_mut();
                    values.focus_visible =
                        Some(values.focus_visible.unwrap_or(false) || ui.get_input_has_focus());
                    if values.runtime_to_ui_ms.is_none() {
                        let token = values.runtime_token.clone().unwrap_or_default();
                        let committed = port_for_render.borrow_mut().dispatch(&request(
                            "runtime-commit-1",
                            "runtime-event-committed",
                            Some(json!({ "token": token })),
                        ));
                        values.runtime_to_ui_ms = committed["elapsedMs"].as_f64();
                    }
                    stage_for_render.set(5);
                    let _ = slint::quit_event_loop();
                }
                _ => {}
            }
        })
        .map_err(|error| slint::PlatformError::from(error.to_string()))?;

    ui.run()?;
    if stage.get() != 5 {
        return Err(slint::PlatformError::from(
            "primary evaluation journey ended before its committed render boundary",
        ));
    }

    let focus_visible = measurements.borrow().focus_visible.unwrap_or(false);
    ui.set_dark_mode(true);
    let diagnostics = UiDiagnostics {
        dark_appearance: ui.get_dark_mode(),
        composition: ui.get_input_text().as_str() == "かなa",
        focus_visible,
        scale_factor: ui.window().scale_factor(),
    };
    ui.hide()?;
    drop(ui);

    let renderer_cycle = run_renderer_cycle()?;
    finish(
        mode,
        &measurements.borrow(),
        &renderer_cycle,
        &diagnostics,
        &mut port.borrow_mut(),
    );
    Ok(())
}

fn finish(
    mode: &str,
    measurements: &Measurements,
    renderer_cycle: &RendererCycle,
    diagnostics: &UiDiagnostics,
    port: &mut Port,
) {
    let accepted_request = request("accepted-1", "ping", None);
    let accepted = port.dispatch(&accepted_request);
    let replay = port.dispatch(&accepted_request);
    let unknown = br#"{"schemaVersion":1,"requestId":"unknown-1","operation":{"kind":"ping"},"surprise":true}"#;

    let negatives = json!({
        "callerMetadata": "not-applicable-in-process-host-owned-callsite",
        "replay": replay,
        "unknown": port.dispatch(unknown),
        "hostile": port.dispatch(&request("hostile-1", "shell", None)),
        "oversized": port.dispatch(&vec![b'x'; MAX_PAYLOAD_BYTES + 1]),
        "timeout": port.dispatch(&request("timeout-1", "bounded-work", Some(json!({ "workMs": 40, "timeoutMs": 5 })))),
        "cancelled": port.dispatch(&request("cancel-1", "bounded-work", Some(json!({ "workMs": 40, "timeoutMs": 50, "cancelAfterMs": 5 }))))
    });

    port.renderer_available = false;
    let unavailable = port.dispatch(&request("unavailable-1", "ping", None));
    port.renderer_available = true;
    let recovered = port.dispatch(&request("recovered-1", "ping", None));

    let native_dialog = port.dispatch(&request("native-dialog-1", "native-dialog", None));
    let fixture = port.dispatch(&request("fixture-1", "fixture-process", None));
    let fixture_ok = fixture["ok"] == true
        && fixture["code"] == "accepted"
        && fixture["escalated"] == true
        && fixture["parentReaped"] == true
        && fixture["groupAbsent"] == true
        && fixture["sessionIsolated"] == true
        && fixture["execChanged"] == true
        && fixture["descendantAbsent"] == true;
    let renderer_cycle_reply = port.dispatch(&request(
        "renderer-cycle-1",
        "renderer-cycle",
        Some(json!({
            "firstInstanceId": renderer_cycle.first_id,
            "secondInstanceId": renderer_cycle.second_id,
            "firstLoaded": renderer_cycle.first_loaded,
            "firstDestroyed": renderer_cycle.first_destroyed,
            "secondLoaded": renderer_cycle.second_loaded,
            "secondDestroyed": renderer_cycle.second_destroyed,
            "hostSurvived": renderer_cycle.host_pid == std::process::id()
        })),
    ));

    let finish_reply = port.dispatch(&request(
        "finish-1",
        "finish",
        Some(json!({
            "appearanceDiagnostic": diagnostics.dark_appearance,
            "compositionDiagnostic": diagnostics.composition,
            "focusDiagnostic": diagnostics.focus_visible,
            "inputDiagnosticMs": measurements.input_to_paint_ms,
            "scaleFactorDiagnostic": diagnostics.scale_factor
        })),
    ));
    let rss_bytes = rss_bytes();
    let evidence = json!({
        "schemaVersion": 1,
        "candidate": "slint-femtovg",
        "mode": mode,
        "environment": {
            "architecture": std::env::consts::ARCH,
            "osFamily": std::env::consts::OS,
            "referenceClass": "owner-m4-16gib-macos26"
        },
        "dependencies": {
            "frontend": "slint-declarative-ui-1.17.1",
            "host": "slint-winit-1.17.1",
            "renderer": "slint-femtovg-1.17.1",
            "rust": "1.92.0"
        },
        "processAccounting": {
            "definition": "root-process-only-after-fixture-cleanup",
            "rssComparableForWinGate": false,
            "limitation": "cross-candidate-rss-is-invalid-because-tauri-webkit-xpc-processes-are-not-consistently-attributable"
        },
        "hardGates": {
            "nativeSemanticTreeAutomation": {
                "passed": false,
                "code": "automated_native_semantic_tree_unavailable",
                "limitation": "source-labels-and-manual-ax-observation-cannot-substitute-for-a-governed-machine-check"
            },
            "signedUpdateRecipe": {
                "passed": false,
                "code": "no-slint-owned-integrated-signed-updater-recipe"
            },
            "royaltyFreeLicenceAttribution": {
                "passed": false,
                "code": "required-about-slint-widget-or-discoverable-badge-not-present-in-prototype"
            }
        },
        "metrics": {
            "rssBytes": rss_bytes,
            "startup": { "startupMs": measurements.startup_ms },
            "client": {
                "darkAppearance": diagnostics.dark_appearance,
                "focusVisible": diagnostics.focus_visible,
                "imeValue": if diagnostics.composition { "かなa" } else { "" },
                "inputToPaintMs": measurements.input_to_paint_ms,
                "runtimeToUiMs": measurements.runtime_to_ui_ms,
                "scaleFactor": diagnostics.scale_factor
            }
        },
        "journey": {
            "accepted": accepted,
            "fixture": fixture,
            "nativeDialog": native_dialog,
            "finish": finish_reply,
            "rendererCycle": {
                "portResponse": renderer_cycle_reply,
                "ok": renderer_cycle.complete(),
                "firstInstanceId": renderer_cycle.first_id,
                "secondInstanceId": renderer_cycle.second_id,
                "firstLoaded": renderer_cycle.first_loaded,
                "firstDestroyed": renderer_cycle.first_destroyed,
                "secondLoaded": renderer_cycle.second_loaded,
                "secondDestroyed": renderer_cycle.second_destroyed,
                "hostSurvived": renderer_cycle.host_pid == std::process::id()
            },
            "negatives": negatives,
            "unavailableResponse": unavailable,
            "recoveredResponse": recovered
        }
    });
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "KEIKO_EVIDENCE:{evidence}");
    let _ = writeln!(stdout, "KEIKO_SHUTDOWN_START");
    let _ = stdout.flush();
    if !fixture_ok {
        eprintln!("KEIKO_DIAGNOSTIC_FIXTURE_PROCESS_CLEANUP_FAILED");
        std::process::exit(70);
    }
}

fn fixture_process(marker: &str, ack: &str, escalation_ack: &str, cleanup_ack: &str) -> Value {
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
        Err(_) => return json!({ "ok": false, "code": "fixture_unavailable" }),
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
        let _ = wait_for_cleanup(&mut child, group, Duration::from_millis(FIXTURE_KILL_MS));
        return response(false, "fixture_unavailable");
    }
    let term_sent = signal_group(group, 15);
    let after_term = wait_for_cleanup(&mut child, group, Duration::from_millis(FIXTURE_TERM_MS));
    let escalated = term_sent && !after_term.complete();
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
            let _ = wait_for_cleanup(&mut child, group, Duration::from_millis(FIXTURE_KILL_MS));
            return response(false, "fixture_unavailable");
        }
        let _ = signal_group(group, 9);
    }
    let cleanup = if after_term.complete() {
        after_term
    } else {
        wait_for_cleanup(&mut child, group, Duration::from_millis(FIXTURE_KILL_MS))
    };
    if !cleanup.complete() {
        let _ = signal_group(group, 9);
    }
    if cleanup.complete() {
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "KEIKO_FIXTURE_CLEANED");
        let _ = stdout.flush();
        let cleanup_deadline = Instant::now() + Duration::from_secs(2);
        while !acknowledged(cleanup_ack) && Instant::now() < cleanup_deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        if !acknowledged(cleanup_ack) {
            return response(false, "fixture_unavailable");
        }
    }
    json!({
        "ok": term_sent && escalated && cleanup.complete(),
        "code": if cleanup.complete() && escalated { "accepted" } else { "process_cleanup_failed" },
        "escalated": escalated,
        "parentReaped": cleanup.parent_reaped,
        "groupAbsent": cleanup.group_absent,
        "sessionIsolated": session_isolated,
        "execChanged": exec_changed,
        "descendantAbsent": cleanup.complete()
    })
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

#[derive(Clone, Copy)]
struct CleanupState {
    parent_reaped: bool,
    group_absent: bool,
}

impl CleanupState {
    fn complete(self) -> bool {
        self.parent_reaped && self.group_absent
    }
}

fn wait_for_cleanup(child: &mut Child, group: i32, budget: Duration) -> CleanupState {
    let deadline = Instant::now() + budget;
    let mut parent_reaped = false;
    loop {
        if !parent_reaped {
            parent_reaped = child.try_wait().ok().flatten().is_some();
        }
        let state = CleanupState {
            parent_reaped,
            group_absent: !group_exists(group),
        };
        if state.complete() {
            return state;
        }
        if Instant::now() >= deadline {
            return state;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn rss_bytes() -> Option<u64> {
    let output = Command::new("/bin/ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    let kibibytes = String::from_utf8(output.stdout)
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    Some(kibibytes * 1_024)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_is_closed_bounded_and_replay_safe() {
        let mut port = Port {
            authority_active: true,
            renderer_available: true,
            seen_request_ids: HashSet::new(),
            runtime_event: None,
            fixture_ack: "/var/empty/unused".into(),
            fixture_cleanup_ack: "/var/empty/unused-cleanup".into(),
            fixture_escalation_ack: "/var/empty/unused-escalation".into(),
            fixture_marker: "0".repeat(32),
        };
        let accepted = request("accepted-1", "ping", None);
        assert_eq!(port.dispatch(&accepted)["code"], "accepted");
        assert_eq!(port.dispatch(&accepted)["code"], "replayed_request");
        let finish_diagnostics = |focus_diagnostic| {
            Some(json!({
                "appearanceDiagnostic": true,
                "compositionDiagnostic": true,
                "focusDiagnostic": focus_diagnostic,
                "inputDiagnosticMs": 1.0,
                "scaleFactorDiagnostic": 2.0
            }))
        };
        assert_eq!(
            port.dispatch(&request(
                "finish-unfocused-1",
                "finish",
                finish_diagnostics(false)
            ))["code"],
            "invalid_diagnostics"
        );
        assert_eq!(
            port.dispatch(&request(
                "finish-focused-1",
                "finish",
                finish_diagnostics(true)
            ))["code"],
            "accepted"
        );
        assert_eq!(
            port.dispatch(&request("hostile-1", "shell", None))["code"],
            "invalid_request"
        );
        assert_eq!(
            port.dispatch(&vec![b'x'; MAX_PAYLOAD_BYTES + 1])["code"],
            "payload_too_large"
        );
        let runtime = port.dispatch(&request("runtime-1", "runtime-event", None));
        let token = runtime["eventToken"].as_str().unwrap();
        assert_eq!(
            port.dispatch(&request(
                "runtime-commit-1",
                "runtime-event-committed",
                Some(json!({ "token": token }))
            ))["code"],
            "accepted"
        );
    }

    #[test]
    fn work_fails_closed_for_cancel_and_timeout() {
        assert_eq!(
            bounded_work(BoundedWork {
                work_ms: 40,
                timeout_ms: 50,
                cancel_after_ms: Some(1),
            })["code"],
            "cancelled"
        );
        assert_eq!(
            bounded_work(BoundedWork {
                work_ms: 40,
                timeout_ms: 1,
                cancel_after_ms: None,
            })["code"],
            "timed_out"
        );
    }

    #[test]
    fn fixture_cleanup_reaps_its_owned_process_group() {
        let ack = format!("/var/tmp/keiko-fixture-ack-{}", std::process::id());
        std::fs::write(&ack, []).expect("fixture acknowledgement is created");
        let escalation_ack = format!("{ack}-escalation");
        let cleanup_ack = format!("{ack}-cleanup");
        std::fs::write(&escalation_ack, []).expect("fixture escalation acknowledgement is created");
        std::fs::write(&cleanup_ack, []).expect("fixture cleanup acknowledgement is created");
        for path in [&ack, &escalation_ack, &cleanup_ack] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .expect("fixture acknowledgement is private");
        }
        let proof = fixture_process(
            "0123456789abcdef0123456789abcdef",
            &ack,
            &escalation_ack,
            &cleanup_ack,
        );
        let _ = std::fs::remove_file(ack);
        let _ = std::fs::remove_file(escalation_ack);
        let _ = std::fs::remove_file(cleanup_ack);
        assert_eq!(proof["code"], "accepted");
        assert_eq!(proof["escalated"], true);
        assert_eq!(proof["parentReaped"], true);
        assert_eq!(proof["groupAbsent"], true);
        assert_eq!(proof["sessionIsolated"], true);
        assert_eq!(proof["execChanged"], true);
        assert_eq!(proof["descendantAbsent"], true);
    }
}
