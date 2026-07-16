use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::statistics::Distribution;

pub const COLD_SAMPLES_PER_CANDIDATE: usize = 20;
pub const WARM_SAMPLES_PER_CANDIDATE: usize = 30;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Candidate {
    Tauri,
    Slint,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StartClass {
    Cold,
    Warm,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScheduledLaunch {
    pub start_class: StartClass,
    pub round: usize,
    pub position: usize,
    pub candidate: Candidate,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LatencyMarker {
    FirstPresentedFrameContainingInputMutation,
    ExternallyObservableCommittedRuntimeState,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CandidateLatencyCounts {
    pub candidate: Candidate,
    pub input_marker: LatencyMarker,
    pub input_samples: usize,
    pub runtime_marker: LatencyMarker,
    pub runtime_samples: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BenchmarkContract;

impl BenchmarkContract {
    pub fn accepted() -> Self {
        Self
    }

    pub fn validate_counts(&self, cold: usize, warm: usize) -> Result<(), BenchmarkError> {
        if cold < COLD_SAMPLES_PER_CANDIDATE || warm < WARM_SAMPLES_PER_CANDIDATE {
            return Err(BenchmarkError::InsufficientSamples);
        }
        Ok(())
    }

    pub fn validate_equal_latency_counts(
        &self,
        tauri_input: usize,
        slint_input: usize,
        tauri_runtime: usize,
        slint_runtime: usize,
    ) -> Result<(), BenchmarkError> {
        if tauri_input != slint_input || tauri_runtime != slint_runtime {
            return Err(BenchmarkError::UnbalancedCandidates);
        }
        if tauri_input == 0 || tauri_runtime == 0 {
            return Err(BenchmarkError::InsufficientSamples);
        }
        Ok(())
    }

    pub fn validate_latency_pair(
        &self,
        tauri: &CandidateLatencyCounts,
        slint: &CandidateLatencyCounts,
    ) -> Result<(), BenchmarkError> {
        self.validate_equal_latency_counts(
            tauri.input_samples,
            slint.input_samples,
            tauri.runtime_samples,
            slint.runtime_samples,
        )?;
        validate_markers(tauri)?;
        validate_markers(slint)
    }
}

fn validate_markers(counts: &CandidateLatencyCounts) -> Result<(), BenchmarkError> {
    let valid = counts.input_marker == LatencyMarker::FirstPresentedFrameContainingInputMutation
        && counts.runtime_marker == LatencyMarker::ExternallyObservableCommittedRuntimeState;
    if !valid {
        return Err(BenchmarkError::InvalidLatencyMarker);
    }
    Ok(())
}

pub fn accepted_schedule() -> Vec<ScheduledLaunch> {
    let mut schedule = schedule_phase(StartClass::Cold, COLD_SAMPLES_PER_CANDIDATE);
    schedule.extend(schedule_phase(StartClass::Warm, WARM_SAMPLES_PER_CANDIDATE));
    schedule
}

pub fn counterbalanced_round_order(launches: usize) -> Vec<Candidate> {
    schedule_phase(StartClass::Cold, launches.div_ceil(2))
        .into_iter()
        .take(launches)
        .map(|launch| launch.candidate)
        .collect()
}

fn schedule_phase(start_class: StartClass, rounds: usize) -> Vec<ScheduledLaunch> {
    (0..rounds)
        .flat_map(|round| schedule_round(start_class, round))
        .collect()
}

fn schedule_round(start_class: StartClass, round: usize) -> [ScheduledLaunch; 2] {
    let candidates = if round.is_multiple_of(2) {
        [Candidate::Tauri, Candidate::Slint]
    } else {
        [Candidate::Slint, Candidate::Tauri]
    };
    [
        ScheduledLaunch {
            start_class,
            round,
            position: 0,
            candidate: candidates[0],
        },
        ScheduledLaunch {
            start_class,
            round,
            position: 1,
            candidate: candidates[1],
        },
    ]
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct Threshold {
    pub maximum_ms: f64,
}

impl Threshold {
    pub fn passes(self, observed_ms: f64) -> bool {
        observed_ms.is_finite() && observed_ms >= 0.0 && observed_ms <= self.maximum_ms
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct Thresholds {
    pub cold_p50_ms: Threshold,
    pub cold_p95_ms: Threshold,
    pub warm_p95_ms: Threshold,
    pub input_p75_ms: Threshold,
    pub input_p95_ms: Threshold,
    pub runtime_ui_p95_ms: Threshold,
    pub shutdown_ms: Threshold,
}

impl Thresholds {
    pub fn accepted() -> Self {
        Self {
            cold_p50_ms: Threshold {
                maximum_ms: 1_500.0,
            },
            cold_p95_ms: Threshold {
                maximum_ms: 3_000.0,
            },
            warm_p95_ms: Threshold {
                maximum_ms: 1_000.0,
            },
            input_p75_ms: Threshold { maximum_ms: 33.0 },
            input_p95_ms: Threshold { maximum_ms: 50.0 },
            runtime_ui_p95_ms: Threshold { maximum_ms: 100.0 },
            shutdown_ms: Threshold {
                maximum_ms: 5_000.0,
            },
        }
    }

    pub fn passes_orphan_gate(orphan_process: bool) -> bool {
        !orphan_process
    }

    pub fn evaluate(self, observed: &ObservedThresholds) -> ThresholdEvaluation {
        ThresholdEvaluation {
            cold_p50: self.cold_p50_ms.passes(observed.cold.p50),
            cold_p95: self.cold_p95_ms.passes(observed.cold.p95),
            warm_p95: self.warm_p95_ms.passes(observed.warm.p95),
            input_p75: self.input_p75_ms.passes(observed.input.p75),
            input_p95: self.input_p95_ms.passes(observed.input.p95),
            runtime_ui_p95: self.runtime_ui_p95_ms.passes(observed.runtime_ui.p95),
            shutdown: self.shutdown_ms.passes(observed.shutdown_ms),
            orphan_free: Self::passes_orphan_gate(observed.orphan_process),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct ObservedThresholds {
    pub cold: Distribution,
    pub warm: Distribution,
    pub input: Distribution,
    pub runtime_ui: Distribution,
    pub shutdown_ms: f64,
    pub orphan_process: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ThresholdEvaluation {
    pub cold_p50: bool,
    pub cold_p95: bool,
    pub warm_p95: bool,
    pub input_p75: bool,
    pub input_p95: bool,
    pub runtime_ui_p95: bool,
    pub shutdown: bool,
    pub orphan_free: bool,
}

impl ThresholdEvaluation {
    pub fn all_pass(self) -> bool {
        self.cold_p50
            && self.cold_p95
            && self.warm_p95
            && self.input_p75
            && self.input_p95
            && self.runtime_ui_p95
            && self.shutdown
            && self.orphan_free
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum BenchmarkError {
    #[error("accepted cold or warm sample count is not met")]
    InsufficientSamples,
    #[error("candidate latency sample counts differ")]
    UnbalancedCandidates,
    #[error("latency measurement marker does not match the accepted semantic endpoint")]
    InvalidLatencyMarker,
}
