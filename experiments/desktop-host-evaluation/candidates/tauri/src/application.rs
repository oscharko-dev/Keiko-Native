#[cfg(feature = "evaluation-hooks")]
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use keiko_eval::lifecycle::ProcessSupervisor;
use serde::Serialize;
use tauri::{State, WebviewWindow};

use keiko_eval::contract::Intent;

use crate::boundary::{CallbackBoundary, ProbeResult, RejectionProbe};
use crate::model::{ShellModel, ShellSnapshot};

const CLEANUP_DEADLINE: Duration = Duration::from_secs(5);

struct InnerState {
    model: ShellModel,
    fixture: Option<ProcessSupervisor>,
}

pub struct AppState {
    inner: Mutex<InnerState>,
    boundary: CallbackBoundary,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(InnerState {
                model: ShellModel::default(),
                fixture: None,
            }),
            boundary: CallbackBoundary::default(),
        }
    }
}

impl AppState {
    fn snapshot(&self) -> Result<ShellSnapshot, String> {
        Ok(self.lock()?.model.snapshot())
    }

    fn authorize(&self, label: &str, intent: Intent) -> Result<(), String> {
        self.boundary.authorize(label, intent)
    }

    fn run_probe(&self, probe: RejectionProbe) -> ProbeResult {
        self.boundary.run_probe(probe)
    }

    fn request_start_fixture(&self, label: &str) -> Result<ShellSnapshot, String> {
        self.authorize(label, Intent::StartFixtureChild)?;
        self.start_fixture()
    }

    fn request_stop_fixture(&self, label: &str) -> Result<ShellSnapshot, String> {
        self.authorize(label, Intent::StopFixtureChild)?;
        self.stop_fixture()
    }

    fn record_folder(&self, selected: bool) -> Result<ShellSnapshot, String> {
        let mut inner = self.lock()?;
        inner
            .model
            .record_folder_selection(selected)
            .map_err(|error| error.to_string())?;
        Ok(inner.model.snapshot())
    }

    fn start_fixture(&self) -> Result<ShellSnapshot, String> {
        let mut inner = self.lock()?;
        inner
            .model
            .start_fixture()
            .map_err(|error| error.to_string())?;
        match spawn_fixture() {
            Ok(fixture) => inner.fixture = Some(fixture),
            Err(error) => {
                let _ = inner.model.stop_fixture();
                return Err(format!("fixture could not start: {error}"));
            }
        }
        Ok(inner.model.snapshot())
    }

    fn stop_fixture(&self) -> Result<ShellSnapshot, String> {
        let mut fixture = {
            let mut inner = self.lock()?;
            inner
                .model
                .stop_fixture()
                .map_err(|error| error.to_string())?;
            inner.fixture.take()
        };
        if let Some(supervisor) = fixture.as_mut() {
            supervisor
                .stop(CLEANUP_DEADLINE)
                .map_err(|error| format!("fixture could not stop cleanly: {error}"))?;
        }
        self.snapshot()
    }

    fn renderer_unavailable(&self) -> Result<ShellSnapshot, String> {
        let mut inner = self.lock()?;
        inner
            .model
            .renderer_unavailable()
            .map_err(|error| error.to_string())?;
        Ok(inner.model.snapshot())
    }

    fn renderer_recover(&self) -> Result<ShellSnapshot, String> {
        let mut inner = self.lock()?;
        inner
            .model
            .renderer_recover()
            .map_err(|error| error.to_string())?;
        Ok(inner.model.snapshot())
    }

    pub fn cleanup(&self) {
        let fixture = self.inner.lock().ok().and_then(|mut inner| {
            inner.model.cleanup();
            inner.fixture.take()
        });
        if let Some(mut supervisor) = fixture {
            let _ = supervisor.stop(CLEANUP_DEADLINE);
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, InnerState>, String> {
        self.inner
            .lock()
            .map_err(|_| "application state is unavailable".into())
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        self.cleanup();
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderOutcome {
    Cancelled,
    Selected,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct FolderPickerResult {
    pub outcome: FolderOutcome,
    pub snapshot: ShellSnapshot,
}

#[tauri::command]
pub async fn choose_folder(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<FolderPickerResult, String> {
    state.authorize(window.label(), Intent::CancelFolderPicker)?;
    let selection = rfd::AsyncFileDialog::new()
        .set_title("Choose a synthetic evaluation folder")
        .pick_folder()
        .await;
    let selected = selection.is_some();
    Ok(FolderPickerResult {
        outcome: if selected {
            FolderOutcome::Selected
        } else {
            FolderOutcome::Cancelled
        },
        snapshot: state.record_folder(selected)?,
    })
}

#[tauri::command]
pub fn fixture_start(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ShellSnapshot, String> {
    state.request_start_fixture(window.label())
}

#[tauri::command]
pub fn fixture_stop(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ShellSnapshot, String> {
    state.request_stop_fixture(window.label())
}

#[tauri::command]
pub fn run_rejection_probe(
    window: WebviewWindow,
    state: State<'_, AppState>,
    probe: RejectionProbe,
) -> Result<ProbeResult, String> {
    state.authorize(window.label(), Intent::CancelFolderPicker)?;
    Ok(state.run_probe(probe))
}

#[tauri::command]
pub fn renderer_unavailable(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ShellSnapshot, String> {
    state.authorize(window.label(), Intent::RecoverRenderer)?;
    state.renderer_unavailable()
}

#[tauri::command]
pub fn renderer_recover(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ShellSnapshot, String> {
    state.authorize(window.label(), Intent::RecoverRenderer)?;
    state.renderer_recover()
}

#[tauri::command]
#[cfg(not(feature = "evaluation-hooks"))]
pub fn shell_snapshot(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ShellSnapshot, String> {
    state.authorize(window.label(), Intent::CancelFolderPicker)?;
    state.snapshot()
}

#[cfg(feature = "evaluation-hooks")]
#[tauri::command]
pub fn shell_snapshot(
    window: WebviewWindow,
    state: State<'_, AppState>,
    evaluation_ready: Option<bool>,
) -> Result<ShellSnapshot, String> {
    state.authorize(window.label(), Intent::CancelFolderPicker)?;
    let snapshot = state.snapshot()?;
    if evaluation_ready == Some(true) {
        crate::evaluation_ready::write_for_window(window.label())?;
    }
    Ok(snapshot)
}

#[cfg(feature = "evaluation-hooks")]
fn spawn_fixture() -> std::io::Result<ProcessSupervisor> {
    let executable = std::env::current_exe()?;
    let name = if cfg!(windows) {
        "keiko-tauri-fixture-child.exe"
    } else {
        "keiko-tauri-fixture-child"
    };
    ProcessSupervisor::spawn(Command::new(executable.with_file_name(name)))
}

#[cfg(not(feature = "evaluation-hooks"))]
fn spawn_fixture() -> std::io::Result<ProcessSupervisor> {
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "evaluation fixture is unavailable in release-like builds",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::FixtureState;

    #[test]
    fn actual_fixture_callback_rejects_untrusted_sender_before_effect() {
        let state = AppState::default();
        assert!(state.request_start_fixture("secondary").is_err());
        assert_eq!(state.snapshot().unwrap().fixture, FixtureState::Stopped);
    }
}
