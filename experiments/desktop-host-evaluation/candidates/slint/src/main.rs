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
const CLOSE_MARKER: &[u8] = b"keiko-close-request-v1\n";
#[cfg(feature = "evaluation-hooks")]
const MAX_CLOSE_PATH_BYTES: usize = 4_096;

#[cfg(feature = "evaluation-hooks")]
struct ReadyRequest {
    path: std::path::PathBuf,
}

#[cfg(feature = "evaluation-hooks")]
struct CloseRequest {
    path: std::path::PathBuf,
}

#[cfg(feature = "evaluation-hooks")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CloseCheck {
    Pending,
    Accepted,
    Rejected,
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
fn schedule_evaluation_close(window: &AppShell) -> Option<Rc<slint::Timer>> {
    let configured = std::env::var_os("KEIKO_EVAL_CLOSE_FILE").map(std::path::PathBuf::from)?;
    let request = authorize_close_request(CloseRequest { path: configured }).ok()?;
    let weak = window.as_weak();
    let timer = Rc::new(slint::Timer::default());
    let callback_timer = Rc::downgrade(&timer);
    timer.start(
        slint::TimerMode::Repeated,
        std::time::Duration::from_millis(20),
        move || match check_close_request(&request.path) {
            CloseCheck::Pending => {}
            CloseCheck::Rejected => {
                if let Some(timer) = callback_timer.upgrade() {
                    timer.stop();
                }
            }
            CloseCheck::Accepted => {
                if let Some(timer) = callback_timer.upgrade() {
                    timer.stop();
                }
                if let Some(window) = weak.upgrade() {
                    let _ = window.hide();
                }
                let _ = slint::quit_event_loop();
            }
        },
    );
    Some(timer)
}

#[cfg(feature = "evaluation-hooks")]
fn authorize_close_request(request: CloseRequest) -> std::io::Result<CloseRequest> {
    let path_bytes = request.path.as_os_str().to_string_lossy().len();
    let parent = request.path.parent();
    if path_bytes == 0
        || path_bytes > MAX_CLOSE_PATH_BYTES
        || !request.path.is_absolute()
        || request.path.file_name().is_none()
        || !parent.is_some_and(safe_close_parent)
    {
        return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
    }
    match std::fs::symlink_metadata(&request.path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(request),
        _ => Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
    }
}

#[cfg(feature = "evaluation-hooks")]
fn safe_close_parent(parent: &std::path::Path) -> bool {
    std::fs::symlink_metadata(parent)
        .is_ok_and(|metadata| metadata.file_type().is_dir() && !metadata.file_type().is_symlink())
}

#[cfg(feature = "evaluation-hooks")]
fn check_close_request(path: &std::path::Path) -> CloseCheck {
    use std::io::Read;

    if !path.parent().is_some_and(safe_close_parent) {
        return CloseCheck::Rejected;
    }
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return CloseCheck::Pending,
        Err(_) => return CloseCheck::Rejected,
    };
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.len() != CLOSE_MARKER.len() as u64
    {
        return CloseCheck::Rejected;
    }
    let mut bytes = Vec::with_capacity(CLOSE_MARKER.len() + 1);
    let result = std::fs::File::open(path).and_then(|file| {
        file.take((CLOSE_MARKER.len() + 1) as u64)
            .read_to_end(&mut bytes)
    });
    match result {
        Ok(length) if length == CLOSE_MARKER.len() && bytes == CLOSE_MARKER => CloseCheck::Accepted,
        _ => CloseCheck::Rejected,
    }
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
    #[cfg(feature = "evaluation-hooks")]
    let _close_timer = schedule_evaluation_close(&window);
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

    #[test]
    fn close_request_requires_a_fresh_path_and_exact_marker() {
        assert_eq!(CLOSE_MARKER.len(), 23);
        let path = test_path("exact-close-request");
        let _ = std::fs::remove_file(&path);
        let request = authorize_close_request(CloseRequest { path: path.clone() }).unwrap();
        assert_eq!(check_close_request(&request.path), CloseCheck::Pending);

        std::fs::write(&path, CLOSE_MARKER).unwrap();
        assert_eq!(check_close_request(&request.path), CloseCheck::Accepted);
        assert!(authorize_close_request(CloseRequest { path: path.clone() }).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn malformed_close_request_fails_closed() {
        let path = test_path("malformed-close-request");
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, b"not-the-close-marker").unwrap();
        assert_eq!(check_close_request(&path), CloseCheck::Rejected);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn relative_close_request_fails_closed() {
        assert!(
            authorize_close_request(CloseRequest {
                path: std::path::PathBuf::from("relative-close-request")
            })
            .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_close_request_fails_closed() {
        let path = test_path("symlink-close-request");
        let target = test_path("symlink-close-target");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&target);
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(authorize_close_request(CloseRequest { path: path.clone() }).is_err());
        assert_eq!(check_close_request(&path), CloseCheck::Rejected);
        std::fs::remove_file(path).unwrap();
    }

    fn test_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("keiko-slint-{name}-{}", std::process::id()))
    }
}
