use std::time::Duration;

use crate::benchmark::StartClass;
use crate::runner::{RunnerError, benchmark_methodology, launch_precondition, rounded_millis};
use crate::runner_evidence::{ApplicationState, OsCacheState, require_complete};

#[test]
fn timing_is_rounded_to_declared_resolution() {
    assert_eq!(rounded_millis(Duration::from_millis(14)), 10.0);
    assert_eq!(rounded_millis(Duration::from_millis(16)), 20.0);
}

#[test]
fn cold_and_warm_preconditions_are_not_claimed_as_cache_flushes() {
    let cold = launch_precondition(StartClass::Cold, false);
    assert_eq!(
        cold.application_state,
        ApplicationState::FreshDirectoryProvided
    );
    assert_eq!(cold.os_cache_state, OsCacheState::Uncontrolled);
    assert!(!cold.warmup_completed);

    let warm = launch_precondition(StartClass::Warm, true);
    assert_eq!(
        warm.application_state,
        ApplicationState::ReusedDirectoryProvided
    );
    assert!(warm.warmup_completed);
}

#[test]
fn pending_evidence_fails_the_frozen_command() {
    assert!(matches!(
        require_complete(false),
        Err(RunnerError::IncompleteEvidence)
    ));
}

#[test]
fn methodology_accounts_for_endpoints_and_limitations() {
    let methodology = benchmark_methodology();
    assert!(methodology.startup_endpoint.contains("stable shell"));
    assert!(methodology.shutdown_endpoint.contains("dispatch"));
    assert!(methodology.resource_limitation.contains("not attributed"));
}
