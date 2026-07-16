use serde::{Deserialize, Serialize};
use thiserror::Error;

const FORBIDDEN_MARKERS: &[&[u8]] = &[
    b"EVALUATION_DRIVER_V1",
    b"evaluation-driver",
    b"evaluation_driver",
    b"KEIKO_EVAL_DRIVER",
    b"--remote-debugging-port",
    b"test-credential",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReleaseSurface {
    Clean,
}

pub fn inspect_release_surface(bytes: &[u8]) -> Result<ReleaseSurface, ReleaseIsolationError> {
    if FORBIDDEN_MARKERS
        .iter()
        .any(|marker| contains(bytes, marker))
    {
        return Err(ReleaseIsolationError::TestCapabilityPresent);
    }
    Ok(ReleaseSurface::Clean)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ArtifactSizes {
    pub packed_bytes: u64,
    pub unpacked_bytes: u64,
    pub external_runtime: ExternalRuntime,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalRuntime {
    SystemWebView,
    BundledNativeRenderer,
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum ReleaseIsolationError {
    #[error("release-like artifact contains evaluation-only capability")]
    TestCapabilityPresent,
}
