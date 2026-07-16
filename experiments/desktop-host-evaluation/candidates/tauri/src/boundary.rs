use std::path::PathBuf;

use keiko_eval::contract::{Authority, HostBoundary, Intent, Request, Sender};
use serde::{Deserialize, Serialize};

const TRUSTED_WINDOW: &str = "main";
const TRUSTED_ORIGIN: &str = "tauri://localhost";
const EVALUATION_SESSION: &str = "local-bundled-content";

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectionProbe {
    Malformed,
    Oversized,
    Unauthorized,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ProbeResult {
    pub probe: &'static str,
    pub rejected: bool,
    pub diagnostic: &'static str,
}

pub struct CallbackBoundary {
    inner: HostBoundary,
}

impl Default for CallbackBoundary {
    fn default() -> Self {
        Self {
            inner: HostBoundary::new(
                trusted_sender(),
                Authority::synthetic(PathBuf::from("synthetic-workspace")),
            ),
        }
    }
}

impl CallbackBoundary {
    pub fn authorize(&self, label: &str, intent: Intent) -> Result<(), String> {
        let request = Request::new(
            Sender::new(label, TRUSTED_ORIGIN, EVALUATION_SESSION),
            intent,
        );
        let payload = serde_json::to_vec(&request).map_err(|_| "request encoding failed")?;
        self.authorize_payload(&payload)
    }

    pub fn run_probe(&self, probe: RejectionProbe) -> ProbeResult {
        let rejected = match probe {
            RejectionProbe::Malformed => self.authorize_payload(br#"{"version":1"#).is_err(),
            RejectionProbe::Oversized => self.authorize_payload(&vec![b'x'; 65_537]).is_err(),
            RejectionProbe::Unauthorized => self.unauthorized_probe_is_rejected(),
        };
        ProbeResult {
            probe: probe.name(),
            rejected,
            diagnostic: "request rejected without retaining payload data",
        }
    }

    fn authorize_payload(&self, payload: &[u8]) -> Result<(), String> {
        self.inner
            .parse_and_authorize(payload)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn unauthorized_probe_is_rejected(&self) -> bool {
        let request = Request::new(
            Sender::new(TRUSTED_WINDOW, TRUSTED_ORIGIN, "invalid-session"),
            Intent::StartFixtureChild,
        );
        serde_json::to_vec(&request)
            .map_err(|_| ())
            .and_then(|payload| self.authorize_payload(&payload).map_err(|_| ()))
            .is_err()
    }
}

impl RejectionProbe {
    fn name(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::Oversized => "oversized",
            Self::Unauthorized => "unauthorized",
        }
    }
}

fn trusted_sender() -> Sender {
    Sender::new(TRUSTED_WINDOW, TRUSTED_ORIGIN, EVALUATION_SESSION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_fixed_hostile_probe_fails_closed() {
        for probe in [
            RejectionProbe::Malformed,
            RejectionProbe::Oversized,
            RejectionProbe::Unauthorized,
        ] {
            assert!(CallbackBoundary::default().run_probe(probe).rejected);
        }
    }

    #[test]
    fn only_the_manifest_window_identity_is_accepted() {
        let boundary = CallbackBoundary::default();
        assert!(
            boundary
                .authorize("main", Intent::StartFixtureChild)
                .is_ok()
        );
        assert!(
            boundary
                .authorize("secondary", Intent::StartFixtureChild)
                .is_err()
        );
    }
}
