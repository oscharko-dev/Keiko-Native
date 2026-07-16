use std::fmt;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

const MAX_PAYLOAD_BYTES: usize = 65_536;

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Sender {
    pub window: String,
    pub origin: String,
    pub authentication: String,
}

impl Sender {
    pub fn new(window: &str, origin: &str, authentication: &str) -> Self {
        Self {
            window: window.into(),
            origin: origin.into(),
            authentication: authentication.into(),
        }
    }
}

impl fmt::Debug for Sender {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Sender")
            .field("window", &self.window)
            .field("origin", &self.origin)
            .field("authentication", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    CancelFolderPicker,
    InspectSyntheticPath(PathBuf),
    StartFixtureChild,
    StopFixtureChild,
    TimeoutFixtureChild,
    RecoverRenderer,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u8,
    pub sender: Sender,
    pub intent: Intent,
}

impl Request {
    pub fn new(sender: Sender, intent: Intent) -> Self {
        Self {
            version: 1,
            sender,
            intent,
        }
    }
}

#[derive(Clone)]
pub struct Authority {
    synthetic_root: PathBuf,
}

impl Authority {
    pub fn synthetic(synthetic_root: PathBuf) -> Self {
        Self { synthetic_root }
    }
}

#[derive(Clone)]
pub struct HostBoundary {
    trusted_sender: Sender,
    authority: Authority,
}

impl HostBoundary {
    pub fn new(trusted_sender: Sender, authority: Authority) -> Self {
        Self {
            trusted_sender,
            authority,
        }
    }

    pub fn parse_and_authorize(&self, bytes: &[u8]) -> Result<Request, BoundaryError> {
        if bytes.len() > MAX_PAYLOAD_BYTES {
            return Err(BoundaryError::Oversized);
        }
        let request = serde_json::from_slice(bytes).map_err(|_| BoundaryError::Malformed)?;
        self.authorize(&request)?;
        Ok(request)
    }

    pub fn authorize(&self, request: &Request) -> Result<(), BoundaryError> {
        if request.version != 1 {
            return Err(BoundaryError::UnsupportedVersion);
        }
        self.authorize_sender(&request.sender)?;
        self.authorize_intent(&request.intent)
    }

    fn authorize_sender(&self, sender: &Sender) -> Result<(), BoundaryError> {
        if sender.window != self.trusted_sender.window {
            return Err(BoundaryError::WrongSender);
        }
        if sender.origin != self.trusted_sender.origin {
            return Err(BoundaryError::WrongOrigin);
        }
        if sender.authentication != self.trusted_sender.authentication {
            return Err(BoundaryError::Unauthorized);
        }
        Ok(())
    }

    fn authorize_intent(&self, intent: &Intent) -> Result<(), BoundaryError> {
        match intent {
            Intent::InspectSyntheticPath(path) => self.authorize_path(path),
            _ => Ok(()),
        }
    }

    fn authorize_path(&self, path: &Path) -> Result<(), BoundaryError> {
        let bounded = path
            .components()
            .all(|part| matches!(part, Component::Normal(_)));
        if !bounded || path.as_os_str().is_empty() {
            return Err(BoundaryError::WorkspaceEscape);
        }
        let _bounded_target = self.authority.synthetic_root.join(path);
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum BoundaryError {
    #[error("request payload is malformed")]
    Malformed,
    #[error("request payload exceeds the accepted bound")]
    Oversized,
    #[error("request version is unsupported")]
    UnsupportedVersion,
    #[error("request sender is not trusted")]
    WrongSender,
    #[error("request origin is not trusted")]
    WrongOrigin,
    #[error("request authentication is invalid")]
    Unauthorized,
    #[error("request escapes the synthetic workspace")]
    WorkspaceEscape,
}
