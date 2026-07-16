use serde::{Deserialize, Serialize};

use crate::benchmark::{Candidate, ScheduledLaunch, Thresholds};
use crate::evidence::EnvironmentClass;
use crate::lifecycle::{ProcessTreeResources, SupervisionBackend};
use crate::package::ExternalRuntime;
use crate::statistics::Distribution;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GateStatus {
    Pass,
    Fail,
    Pending,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceClass {
    Automated,
    Accessibility,
    InternationalInput,
    NativeDialog,
    Recovery,
    Visual,
    Platform,
    ReleaseIsolation,
    Performance,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GateResult {
    pub gate: String,
    pub candidate: Option<Candidate>,
    pub platform: String,
    pub checkpoint: String,
    pub evidence_class: EvidenceClass,
    pub status: GateStatus,
    pub artifact_sha256: Option<String>,
    pub evidence: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PackageEvidence {
    pub candidate: Candidate,
    pub format: String,
    pub release_like: bool,
    pub evaluation_hooks_present: bool,
    pub artifact_sha256: String,
    pub source_commit: String,
    pub dependency_lock_sha256: String,
    pub candidate_source_sha256: String,
    pub packed_bytes: Option<u64>,
    pub unpacked_bytes: u64,
    pub external_runtime: ExternalRuntime,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct VerifyEvidence {
    pub schema_version: u8,
    pub contract_version: String,
    pub readiness_fingerprint: String,
    pub source_commit: String,
    pub platform: String,
    pub rust_version: String,
    pub supervision_backend: SupervisionBackend,
    pub dependency_lock_sha256: String,
    pub packages: Vec<PackageEvidence>,
    pub gates: Vec<GateResult>,
    pub decision_ready: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationState {
    FreshDirectoryProvided,
    ReusedDirectoryProvided,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OsCacheState {
    Uncontrolled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchPrecondition {
    pub application_state: ApplicationState,
    pub os_cache_state: OsCacheState,
    pub warmup_completed: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LaunchSample {
    pub launch: ScheduledLaunch,
    pub precondition: LaunchPrecondition,
    pub stable_shell_ms: f64,
    pub normal_shutdown_ms: f64,
    pub measurement_resolution_ms: f64,
    pub uncertainty_ms: f64,
    pub idle_resources: ProcessTreeResources,
    pub orphan_process: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CandidateSummary {
    pub candidate: Candidate,
    pub cold_start_ms: Distribution,
    pub warm_start_ms: Distribution,
    pub shutdown_ms: Distribution,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BenchmarkMethodology {
    pub startup_endpoint: String,
    pub cold_precondition: String,
    pub warm_precondition: String,
    pub os_cache_limitation: String,
    pub resource_endpoint: String,
    pub resource_accounting: String,
    pub resource_limitation: String,
    pub shutdown_endpoint: String,
    pub measurement_resolution: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct BenchmarkEvidence {
    pub schema_version: u8,
    pub contract_version: String,
    pub readiness_fingerprint: String,
    pub source_commit: String,
    pub dependency_lock_sha256: String,
    pub environment: EnvironmentClass,
    pub thresholds: Thresholds,
    pub packages: Vec<PackageEvidence>,
    pub methodology: BenchmarkMethodology,
    pub samples: Vec<LaunchSample>,
    pub summaries: Vec<CandidateSummary>,
    pub gates: Vec<GateResult>,
    pub decision_ready: bool,
}

pub fn complete(gates: &[GateResult]) -> bool {
    gates.iter().all(|gate| gate.status == GateStatus::Pass)
}

pub(crate) fn require_complete(complete: bool) -> Result<(), crate::runner::RunnerError> {
    complete
        .then_some(())
        .ok_or(crate::runner::RunnerError::IncompleteEvidence)
}
