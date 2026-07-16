use std::fs;

use crate::benchmark::{Candidate, ScheduledLaunch, StartClass};
use crate::runner_evidence::{EvidenceClass, GateStatus};
use crate::runner_support::{
    clear_canonical_output, fresh_handshake_path, journey_gates, remove_handshake,
    stable_shell_ready,
};

#[test]
fn stable_shell_handshake_is_exact_and_stale_files_are_removed() {
    let launch = ScheduledLaunch {
        start_class: StartClass::Cold,
        round: 19,
        position: 1,
        candidate: Candidate::Slint,
    };
    let path = fresh_handshake_path(launch).unwrap();
    fs::write(&path, b"visible-window-only\n").unwrap();
    assert!(!stable_shell_ready(&path));
    let reset = fresh_handshake_path(launch).unwrap();
    assert!(!reset.exists());
    fs::write(&reset, b"keiko-stable-rendered-shell-v1\n").unwrap();
    assert!(stable_shell_ready(&reset));
    remove_handshake(&reset).unwrap();
}

#[test]
fn every_journey_gate_is_candidate_and_platform_specific() {
    let gates = journey_gates("windows");
    assert_eq!(gates.len(), 14);
    assert!(gates.iter().all(|gate| {
        gate.candidate.is_some()
            && gate.platform == "windows"
            && gate.status == GateStatus::Pending
            && !gate.checkpoint.is_empty()
    }));
    for class in [
        EvidenceClass::Accessibility,
        EvidenceClass::InternationalInput,
        EvidenceClass::NativeDialog,
        EvidenceClass::Recovery,
        EvidenceClass::Visual,
    ] {
        assert_eq!(
            gates
                .iter()
                .filter(|gate| gate.evidence_class == class)
                .count(),
            2
        );
    }
}

#[test]
fn early_failures_remove_stale_canonical_output() {
    for name in ["current-platform-verify.json", "current-platform.json"] {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join(name);
        fs::write(&output, br#"{"source_commit":"stale"}"#).unwrap();

        let result: Result<(), crate::runner::RunnerError> = clear_canonical_output(&output)
            .and(Err(crate::runner::RunnerError::UnsupportedPlatform));

        assert!(matches!(
            result,
            Err(crate::runner::RunnerError::UnsupportedPlatform)
        ));
        assert!(!output.exists(), "stale {name} survived an early failure");
    }
}

#[test]
fn canonical_output_removal_failure_is_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("current-platform.json");
    fs::create_dir(&output).unwrap();

    let result = clear_canonical_output(&output);

    assert!(matches!(result, Err(crate::runner::RunnerError::Io(_))));
    assert!(output.is_dir());
}

#[test]
fn incomplete_fresh_evidence_remains_available() {
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("current-platform.json");
    fs::write(&output, br#"{"source_commit":"stale"}"#).unwrap();

    let result: Result<(), crate::runner::RunnerError> =
        clear_canonical_output(&output).and_then(|()| {
            fs::write(&output, br#"{"source_commit":"fresh"}"#).unwrap();
            Err(crate::runner::RunnerError::IncompleteEvidence)
        });

    assert!(matches!(
        result,
        Err(crate::runner::RunnerError::IncompleteEvidence)
    ));
    assert_eq!(
        fs::read_to_string(output).unwrap(),
        r#"{"source_commit":"fresh"}"#
    );
}
