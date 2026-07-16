use serde::Serialize;
use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FixtureState {
    Stopped,
    Running,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RendererState {
    Available,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct ShellSnapshot {
    pub fixture: FixtureState,
    pub renderer: RendererState,
    pub folder_selected: bool,
}

#[derive(Debug)]
pub struct ShellModel {
    fixture: FixtureState,
    renderer: RendererState,
    folder_selected: bool,
}

impl Default for ShellModel {
    fn default() -> Self {
        Self {
            fixture: FixtureState::Stopped,
            renderer: RendererState::Available,
            folder_selected: false,
        }
    }
}

impl ShellModel {
    pub fn snapshot(&self) -> ShellSnapshot {
        ShellSnapshot {
            fixture: self.fixture,
            renderer: self.renderer,
            folder_selected: self.folder_selected,
        }
    }

    pub fn record_folder_selection(&mut self, selected: bool) -> Result<(), ModelError> {
        self.require_renderer()?;
        self.folder_selected = selected;
        Ok(())
    }

    pub fn start_fixture(&mut self) -> Result<(), ModelError> {
        self.require_renderer()?;
        if self.fixture == FixtureState::Running {
            return Err(ModelError::FixtureAlreadyRunning);
        }
        self.fixture = FixtureState::Running;
        Ok(())
    }

    pub fn stop_fixture(&mut self) -> Result<(), ModelError> {
        if self.fixture == FixtureState::Stopped {
            return Err(ModelError::FixtureNotRunning);
        }
        self.fixture = FixtureState::Stopped;
        Ok(())
    }

    pub fn renderer_unavailable(&mut self) -> Result<(), ModelError> {
        if self.renderer == RendererState::Unavailable {
            return Err(ModelError::RendererAlreadyUnavailable);
        }
        self.renderer = RendererState::Unavailable;
        Ok(())
    }

    pub fn renderer_recover(&mut self) -> Result<(), ModelError> {
        if self.renderer == RendererState::Available {
            return Err(ModelError::RendererAlreadyAvailable);
        }
        self.renderer = RendererState::Available;
        Ok(())
    }

    pub fn cleanup(&mut self) {
        self.fixture = FixtureState::Stopped;
    }

    fn require_renderer(&self) -> Result<(), ModelError> {
        if self.renderer == RendererState::Unavailable {
            return Err(ModelError::RendererUnavailable);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum ModelError {
    #[error("fixture is already running")]
    FixtureAlreadyRunning,
    #[error("fixture is not running")]
    FixtureNotRunning,
    #[error("renderer is unavailable")]
    RendererUnavailable,
    #[error("renderer is already unavailable")]
    RendererAlreadyUnavailable,
    #[error("renderer is already available")]
    RendererAlreadyAvailable,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journey_state_transitions_are_explicit_and_recoverable() {
        let mut model = ShellModel::default();
        model.start_fixture().unwrap();
        assert_eq!(
            model.start_fixture(),
            Err(ModelError::FixtureAlreadyRunning)
        );
        model.renderer_unavailable().unwrap();
        assert_eq!(model.start_fixture(), Err(ModelError::RendererUnavailable));
        model.renderer_recover().unwrap();
        model.stop_fixture().unwrap();
        assert_eq!(model.snapshot().fixture, FixtureState::Stopped);
    }

    #[test]
    fn cleanup_is_idempotent_after_partial_journey() {
        let mut model = ShellModel::default();
        model.start_fixture().unwrap();
        model.cleanup();
        model.cleanup();
        assert_eq!(model.snapshot().fixture, FixtureState::Stopped);
    }
}
