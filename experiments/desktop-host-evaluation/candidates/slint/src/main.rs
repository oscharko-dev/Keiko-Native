use std::cell::RefCell;
use std::error::Error;
use std::rc::Rc;

use keiko_slint_prototype::{AppController, NativeFixtureProcess, NativeFolderPicker, UiState};
use slint::ComponentHandle;

#[cfg(feature = "evaluation-hooks")]
const READY_MARKER: &[u8] = b"keiko-stable-rendered-shell-v1\n";
#[cfg(feature = "evaluation-hooks")]
const MAX_READY_PATH_BYTES: usize = 4_096;

#[cfg(feature = "evaluation-hooks")]
struct ReadyRequest {
    path: std::path::PathBuf,
}

slint::include_modules!();

fn apply_state(window: &AppShell, state: &UiState) {
    window.set_status_text(state.status.clone().into());
    window.set_folder_state(state.folder_status.clone().into());
    window.set_fixture_state(state.fixture_status.clone().into());
    window.set_probe_state(state.probe_status.clone().into());
    window.set_renderer_state(state.renderer_status.clone().into());
    window.set_fixture_running(state.fixture_running);
    window.set_renderer_available(state.renderer_available);
    window.set_rejection_count(state.rejection_count);
}

fn refresh(weak: &slint::Weak<AppShell>, controller: &Rc<RefCell<AppController>>) {
    if let Some(window) = weak.upgrade() {
        apply_state(&window, controller.borrow().state());
    }
}

fn bind_callbacks(window: &AppShell, controller: Rc<RefCell<AppController>>) {
    let weak = window.as_weak();
    let state = controller.clone();
    window.on_choose_folder(move || {
        state.borrow_mut().choose_folder();
        refresh(&weak, &state);
        if let Some(window) = weak.upgrade() {
            window.invoke_restore_folder_focus();
        }
    });

    let weak = window.as_weak();
    let state = controller.clone();
    window.on_start_fixture(move || {
        state.borrow_mut().start_fixture();
        refresh(&weak, &state);
    });

    let weak = window.as_weak();
    let state = controller.clone();
    window.on_stop_fixture(move || {
        state.borrow_mut().stop_fixture();
        refresh(&weak, &state);
    });

    let weak = window.as_weak();
    let state = controller.clone();
    window.on_exercise_rejections(move || {
        state.borrow_mut().exercise_rejections();
        refresh(&weak, &state);
    });

    let weak = window.as_weak();
    let state = controller.clone();
    window.on_simulate_renderer_unavailable(move || {
        state.borrow_mut().simulate_renderer_unavailable();
        refresh(&weak, &state);
        if let Some(window) = weak.upgrade() {
            window.invoke_focus_recovery_action();
        }
    });

    let weak = window.as_weak();
    window.on_recover_renderer(move || {
        controller.borrow_mut().recover_renderer();
        refresh(&weak, &controller);
        if let Some(window) = weak.upgrade() {
            window.invoke_restore_recovery_focus();
        }
    });
}

#[cfg(feature = "evaluation-hooks")]
fn schedule_evaluation_ready() {
    slint::Timer::single_shot(std::time::Duration::ZERO, || {
        slint::Timer::single_shot(std::time::Duration::from_millis(34), || {
            let _ = write_evaluation_ready();
        });
    });
}

#[cfg(feature = "evaluation-hooks")]
fn write_evaluation_ready() -> std::io::Result<()> {
    use std::io::Write;

    let configured = std::env::var_os("KEIKO_EVAL_READY_FILE")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))?;
    let path = authorize_ready_request(
        ReadyRequest {
            path: configured.clone(),
        },
        &configured,
    )?;
    let temporary = path.with_extension(format!("keiko-ready-{}", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(READY_MARKER)?;
    file.sync_all()?;
    let published = std::fs::hard_link(&temporary, &path);
    let removed = std::fs::remove_file(temporary);
    published?;
    removed
}

#[cfg(feature = "evaluation-hooks")]
fn authorize_ready_request(
    request: ReadyRequest,
    configured: &std::path::Path,
) -> std::io::Result<std::path::PathBuf> {
    let bounded = request.path.as_os_str().to_string_lossy().len() <= MAX_READY_PATH_BYTES;
    if !bounded || request.path != configured || request.path.exists() {
        return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
    }
    Ok(request.path)
}

fn main() -> Result<(), Box<dyn Error>> {
    slint::BackendSelector::new()
        .backend_name("winit".into())
        .renderer_name("femtovg".into())
        .select()?;

    let controller = Rc::new(RefCell::new(AppController::new(
        Box::new(NativeFolderPicker),
        Box::new(NativeFixtureProcess::default()),
    )));
    let window = AppShell::new()?;
    apply_state(&window, controller.borrow().state());
    bind_callbacks(&window, controller.clone());
    window.show()?;
    #[cfg(feature = "evaluation-hooks")]
    schedule_evaluation_ready();
    slint::run_event_loop()?;
    controller.borrow_mut().shutdown();
    Ok(())
}

#[cfg(all(test, feature = "evaluation-hooks"))]
mod tests {
    use super::*;

    #[test]
    fn ready_request_must_match_fresh_configured_path() {
        let path = std::env::temp_dir().join("keiko-slint-ready-contract");
        assert!(authorize_ready_request(ReadyRequest { path: path.clone() }, &path).is_ok());
        assert!(
            authorize_ready_request(
                ReadyRequest { path: path.clone() },
                &path.with_extension("other")
            )
            .is_err()
        );
    }
}
