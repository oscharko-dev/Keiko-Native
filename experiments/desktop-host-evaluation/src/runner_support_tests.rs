use std::ffi::OsStr;
use std::fs;

use crate::benchmark::{Candidate, ScheduledLaunch, StartClass};
use crate::runner_close::{
    close_request_ready, fresh_close_request_path, publish_close_request, remove_close_request,
};
use crate::runner_evidence::{EvidenceClass, GateStatus};
use crate::runner_support::{
    cargo_command, clear_canonical_output, fresh_handshake_path, isolated_cargo_target_dir,
    journey_gates, remove_handshake, select_cargo_target_dir, stable_shell_ready,
};

#[test]
fn internal_cargo_commands_isolate_build_outputs_from_the_running_driver() {
    for arguments in [
        vec!["fmt", "--all", "--", "--check"],
        vec!["test", "--locked", "--workspace", "--all-targets"],
        vec![
            "clippy",
            "--locked",
            "--workspace",
            "--all-targets",
            "--",
            "-D",
            "warnings",
        ],
        vec!["build", "--locked", "--workspace", "--bins", "--release"],
        vec![
            "build",
            "--locked",
            "--release",
            "--package",
            "keiko-tauri-prototype",
            "--features",
            "evaluation-hooks",
        ],
        vec![
            "build",
            "--locked",
            "--release",
            "--package",
            "keiko-slint-prototype",
            "--features",
            "evaluation-hooks",
        ],
    ] {
        let command = cargo_command(&arguments).unwrap();
        let target = command
            .get_envs()
            .find_map(|(name, value)| (name == OsStr::new("CARGO_TARGET_DIR")).then_some(value))
            .flatten();
        assert_eq!(
            target,
            Some(isolated_cargo_target_dir().unwrap().as_os_str()),
            "Cargo invocation was not isolated: {arguments:?}"
        );
    }
}

#[test]
fn child_target_selection_never_reuses_the_running_driver_tree() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = directory.path().join("evaluation");
    let primary_driver = manifest
        .join("target")
        .join("evaluation-cargo-target")
        .join("release")
        .join("keiko-eval.exe");
    let alternate = select_cargo_target_dir(&manifest, &primary_driver);
    assert_eq!(
        alternate,
        manifest
            .join("target")
            .join("evaluation-cargo-target-alternate")
    );
    assert!(!primary_driver.starts_with(&alternate));

    let default_driver = manifest
        .join("target")
        .join("release")
        .join("keiko-eval.exe");
    let primary = select_cargo_target_dir(&manifest, &default_driver);
    assert_eq!(
        primary,
        manifest.join("target").join("evaluation-cargo-target")
    );
    assert!(!default_driver.starts_with(&primary));
}

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
fn close_request_is_unique_exact_atomic_and_removed() {
    let launch = ScheduledLaunch {
        start_class: StartClass::Warm,
        round: 7,
        position: 0,
        candidate: Candidate::Tauri,
    };
    let first = fresh_close_request_path(launch).unwrap();
    let second = fresh_close_request_path(launch).unwrap();
    assert_ne!(first, second);
    assert!(!first.exists());
    publish_close_request(&first).unwrap();
    assert!(close_request_ready(&first));
    assert_eq!(fs::read(&first).unwrap(), b"keiko-close-request-v1\n");
    assert!(!first.with_extension("request.tmp").exists());
    remove_close_request(&first).unwrap();
    remove_close_request(&second).unwrap();
    assert!(!first.exists());
}

#[test]
fn stale_or_malformed_close_requests_fail_closed() {
    let launch = ScheduledLaunch {
        start_class: StartClass::Cold,
        round: 8,
        position: 1,
        candidate: Candidate::Slint,
    };
    let path = fresh_close_request_path(launch).unwrap();
    fs::write(&path, b"old-or-malformed\n").unwrap();
    assert!(matches!(
        publish_close_request(&path),
        Err(crate::runner::RunnerError::StaleCloseRequest)
    ));
    assert!(matches!(
        remove_close_request(&path),
        Err(crate::runner::RunnerError::InvalidCloseRequest)
    ));
    assert!(path.exists());
    fs::remove_file(path).unwrap();
}

#[cfg(unix)]
#[test]
fn symlink_close_request_is_rejected_without_touching_target() {
    use std::os::unix::fs::symlink;

    let launch = ScheduledLaunch {
        start_class: StartClass::Cold,
        round: 9,
        position: 0,
        candidate: Candidate::Tauri,
    };
    let path = fresh_close_request_path(launch).unwrap();
    let target = path.with_extension("target");
    fs::write(&target, b"keiko-close-request-v1\n").unwrap();
    symlink(&target, &path).unwrap();
    assert!(matches!(
        publish_close_request(&path),
        Err(crate::runner::RunnerError::StaleCloseRequest)
    ));
    assert!(matches!(
        remove_close_request(&path),
        Err(crate::runner::RunnerError::InvalidCloseRequest)
    ));
    assert_eq!(fs::read(&target).unwrap(), b"keiko-close-request-v1\n");
    fs::remove_file(path).unwrap();
    fs::remove_file(target).unwrap();
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
