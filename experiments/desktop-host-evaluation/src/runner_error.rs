use std::io;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum RunnerError {
    #[error("runner command failed")]
    CommandFailed,
    #[error("candidate package is missing; run verify first")]
    MissingPackage,
    #[error("candidate package does not match the current clean source binding")]
    StalePackage,
    #[error("diagnostic package contains content outside the selected candidate executable")]
    UnexpectedPackageContent,
    #[error("source evidence requires an exact clean HEAD before build or sampling")]
    DirtySource,
    #[error("current platform is outside the accepted Windows and macOS scope")]
    UnsupportedPlatform,
    #[error("candidate exited before a visible window was observed")]
    CandidateExited,
    #[error("stable rendered shell handshake was not observed before the deadline")]
    StableShellTimeout,
    #[error("close request path was not fresh")]
    StaleCloseRequest,
    #[error("close request was not an exact regular file")]
    InvalidCloseRequest,
    #[error("candidate required forced termination")]
    NormalShutdownFailed,
    #[error("required exact-head evidence contains a failed or pending gate")]
    IncompleteEvidence,
    #[error("runner produced invalid output")]
    InvalidOutput,
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Statistics(#[from] crate::statistics::StatisticsError),
    #[error(transparent)]
    Sanitizer(#[from] crate::evidence::SanitizerError),
    #[error(transparent)]
    ReleaseIsolation(#[from] crate::package::ReleaseIsolationError),
}
