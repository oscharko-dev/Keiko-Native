use std::path::PathBuf;

use keiko_eval::contract::{Authority, HostBoundary, Intent, Request, Sender};

use crate::ports::{FixtureProcess, FolderPicker, FolderSelection};

const TRUSTED_WINDOW: &str = "main";
const TRUSTED_ORIGIN: &str = "keiko://localhost";
const EVALUATION_AUTH: &str = "eval-session";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UiState {
    pub status: String,
    pub folder_status: String,
    pub fixture_status: String,
    pub probe_status: String,
    pub renderer_status: String,
    pub fixture_running: bool,
    pub renderer_available: bool,
    pub rejection_count: i32,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            status: "Ready. Enter international text or choose an action.".into(),
            folder_status: "Not chosen".into(),
            fixture_status: "Stopped".into(),
            probe_status: "Not run".into(),
            renderer_status: "Available".into(),
            fixture_running: false,
            renderer_available: true,
            rejection_count: 0,
        }
    }
}

pub struct AppController {
    picker: Box<dyn FolderPicker>,
    fixture: Box<dyn FixtureProcess>,
    boundary: HostBoundary,
    sender: Sender,
    state: UiState,
}

impl AppController {
    pub fn new(picker: Box<dyn FolderPicker>, fixture: Box<dyn FixtureProcess>) -> Self {
        Self::with_sender(
            picker,
            fixture,
            Sender::new(TRUSTED_WINDOW, TRUSTED_ORIGIN, EVALUATION_AUTH),
        )
    }

    pub fn with_sender(
        picker: Box<dyn FolderPicker>,
        fixture: Box<dyn FixtureProcess>,
        sender: Sender,
    ) -> Self {
        let authority = Authority::synthetic(PathBuf::from("synthetic-workspace"));
        Self {
            picker,
            fixture,
            boundary: HostBoundary::new(
                Sender::new(TRUSTED_WINDOW, TRUSTED_ORIGIN, EVALUATION_AUTH),
                authority,
            ),
            sender,
            state: UiState::default(),
        }
    }

    pub fn state(&self) -> &UiState {
        &self.state
    }

    pub fn choose_folder(&mut self) {
        self.dispatch_trusted(Intent::CancelFolderPicker);
    }

    pub fn start_fixture(&mut self) {
        self.dispatch_trusted(Intent::StartFixtureChild);
    }

    pub fn stop_fixture(&mut self) {
        self.dispatch_trusted(Intent::StopFixtureChild);
    }

    pub fn exercise_rejections(&mut self) {
        let malformed = self.dispatch_payload(br#"{"sender":[]}"#);
        let oversized = self.dispatch_payload(&vec![b'x'; 65_537]);
        let unauthorized = Request::new(
            Sender::new(TRUSTED_WINDOW, TRUSTED_ORIGIN, "expired"),
            Intent::CancelFolderPicker,
        );
        let unauthorized = self.boundary.authorize(&unauthorized).map_err(|_| ());
        self.state.rejection_count = i32::from(malformed.is_err())
            + i32::from(oversized.is_err())
            + i32::from(unauthorized.is_err());
        self.state.status = "Malformed, oversized, and unauthorized requests rejected.".into();
        self.state.probe_status = format!("{} rejected", self.state.rejection_count);
    }

    pub fn simulate_renderer_unavailable(&mut self) {
        self.state.renderer_available = false;
        self.state.renderer_status = "Unavailable".into();
        self.state.status = "Renderer unavailable. Recovery action remains available.".into();
    }

    pub fn recover_renderer(&mut self) {
        self.dispatch_trusted(Intent::RecoverRenderer);
    }

    pub fn shutdown(&mut self) {
        self.fixture.cleanup();
        self.state.fixture_running = false;
        self.state.fixture_status = "Stopped".into();
    }

    fn dispatch_trusted(&mut self, intent: Intent) {
        let request = Request::new(self.sender.clone(), intent);
        let result = self
            .boundary
            .authorize(&request)
            .map_err(|_| ())
            .and_then(|_| self.perform(request.intent));
        if result.is_err() {
            self.state.status = "Action rejected by the trusted host boundary.".into();
        }
    }

    fn dispatch_payload(&mut self, payload: &[u8]) -> Result<(), ()> {
        let request = self.boundary.parse_and_authorize(payload).map_err(|_| ())?;
        self.perform(request.intent)
    }

    fn perform(&mut self, intent: Intent) -> Result<(), ()> {
        match intent {
            Intent::CancelFolderPicker => self.perform_folder(),
            Intent::StartFixtureChild => self.perform_start_fixture(),
            Intent::StopFixtureChild => self.perform_stop_fixture(),
            Intent::RecoverRenderer => self.perform_recovery(),
            _ => return Err(()),
        }
        Ok(())
    }

    fn perform_folder(&mut self) {
        let (state, status) = match self.picker.pick_folder() {
            FolderSelection::Cancelled => ("Cancelled", "Folder selection cancelled."),
            FolderSelection::Selected => (
                "Selected",
                "Folder selected without reading or retaining its path.",
            ),
        };
        self.state.folder_status = state.into();
        self.state.status = status.into();
    }

    fn perform_start_fixture(&mut self) {
        match self.fixture.start() {
            Ok(()) => {
                self.state.fixture_running = true;
                self.state.fixture_status = "Running".into();
                self.state.status = "Fixture process running under supervised cleanup.".into();
            }
            Err(_) => self.state.status = "Fixture process could not start.".into(),
        }
    }

    fn perform_stop_fixture(&mut self) {
        match self.fixture.stop() {
            Ok(()) => {
                self.state.fixture_running = false;
                self.state.fixture_status = "Stopped".into();
                self.state.status = "Fixture process stopped; no child remains.".into();
            }
            Err(_) => self.state.status = "Fixture cleanup failed closed.".into(),
        }
    }

    fn perform_recovery(&mut self) {
        self.state.renderer_available = true;
        self.state.renderer_status = "Available".into();
        self.state.status = "Renderer recovered; shell is usable again.".into();
    }
}

impl Drop for AppController {
    fn drop(&mut self) {
        self.shutdown();
    }
}
