use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use crate::benchmark::{Candidate, ScheduledLaunch, StartClass};
use crate::evidence::EvidenceSanitizer;
use crate::lifecycle::{ProcessSupervisor, SupervisionBackend};
use crate::runner::RunnerError;
use crate::runner_evidence::{EvidenceClass, GateResult, GateStatus, PackageEvidence};
use crate::runner_package::{candidate_name, manifest_dir};
use crate::runner_platform::rust_version;
use serde::Serialize;

const SHELL_READY: &[u8] = b"keiko-stable-rendered-shell-v1\n";
const READY_DEADLINE: Duration = Duration::from_secs(5);

pub(crate) fn wait_for_stable_shell(
    supervisor: &ProcessSupervisor,
    ready_file: &Path,
    started: Instant,
) -> Result<(), RunnerError> {
    while started.elapsed() < READY_DEADLINE {
        if stable_shell_ready(ready_file) {
            return Ok(());
        }
        if !supervisor.process_tree_remains() {
            return Err(RunnerError::CandidateExited);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err(RunnerError::StableShellTimeout)
}

pub(crate) fn stable_shell_ready(path: &Path) -> bool {
    fs::read(path).is_ok_and(|bytes| bytes == SHELL_READY)
}

pub(crate) fn fresh_handshake_path(launch: ScheduledLaunch) -> Result<PathBuf, RunnerError> {
    let path = manifest_dir()
        .join("target")
        .join("evaluation-handshakes")
        .join(format!(
            "{}-{:?}-{}-{}.ready",
            candidate_name(launch.candidate),
            launch.start_class,
            launch.round,
            launch.position
        ));
    remove_handshake(&path)?;
    fs::create_dir_all(path.parent().ok_or(RunnerError::InvalidOutput)?)?;
    Ok(path)
}

pub(crate) fn remove_handshake(path: &Path) -> Result<(), RunnerError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn clear_canonical_output(path: &Path) -> Result<(), RunnerError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn launch_state_path(
    launch: ScheduledLaunch,
    reset_warm: bool,
) -> Result<PathBuf, RunnerError> {
    let suffix = if launch.start_class == StartClass::Cold {
        format!("cold-{}-{}", launch.round, launch.position)
    } else {
        "warm-shared".into()
    };
    let path = manifest_dir()
        .join("target")
        .join("evaluation-state")
        .join(candidate_name(launch.candidate))
        .join(suffix);
    let reset = launch.start_class == StartClass::Cold || !reset_warm;
    if reset && path.exists() {
        fs::remove_dir_all(&path)?;
    }
    fs::create_dir_all(&path)?;
    Ok(path)
}

pub(crate) fn request_normal_close(platform: &str, pid: u32) -> Result<(), RunnerError> {
    let output = if platform == "macos" {
        Command::new("osascript").args(["-e", &format!(
            "tell application \"System Events\" to tell first process whose unix id is {pid} to click button 1 of window 1"
        )]).output()?
    } else {
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("if (-not (Get-Process -Id {pid}).CloseMainWindow()) {{ exit 1 }}"),
            ])
            .output()?
    };
    output
        .status
        .success()
        .then_some(())
        .ok_or(RunnerError::NormalCloseUnavailable)
}

pub(crate) fn verification_gates(
    platform: &str,
    backend: SupervisionBackend,
    packages: &[PackageEvidence],
) -> Vec<GateResult> {
    let exact_toolchain = rust_version().is_ok_and(|version| version.starts_with("rustc 1.92.0 "));
    let mut gates = verified_build_gates(platform, exact_toolchain, packages.len() == 2);
    gates.extend(release_pending_gates(platform));
    gates.push(windows_supervision_gate(platform, backend));
    gates
}

fn verified_build_gates(platform: &str, toolchain: bool, packages: bool) -> Vec<GateResult> {
    vec![
        gate(
            platform,
            "workspace_checks",
            "locked_quality_commands",
            EvidenceClass::Automated,
            true,
            "locked format build test and lint passed",
        ),
        gate(
            platform,
            "source_commit_frozen",
            "source_and_lock_binding",
            EvidenceClass::Automated,
            true,
            "clean HEAD and dependency lock were bound before build",
        ),
        gate(
            platform,
            "rust_toolchain",
            "compiler_version",
            EvidenceClass::Platform,
            toolchain,
            "runner requires Rust 1.92.0 exactly",
        ),
        gate(
            platform,
            "diagnostic_packages",
            "artifact_provenance",
            EvidenceClass::Automated,
            packages,
            "fresh diagnostic artifacts match source commit lock and candidate source digests",
        ),
    ]
}

fn release_pending_gates(platform: &str) -> Vec<GateResult> {
    vec![
        pending(
            platform,
            "release_isolation",
            "release_package",
            EvidenceClass::ReleaseIsolation,
            "raw diagnostic executables cannot prove release-package isolation",
        ),
        pending(
            platform,
            "release_package_size",
            "release_package",
            EvidenceClass::Performance,
            "packed size requires an actual macOS or Windows release package",
        ),
    ]
}

pub(crate) fn journey_gates(platform: &str) -> Vec<GateResult> {
    [Candidate::Tauri, Candidate::Slint]
        .into_iter()
        .flat_map(|candidate| candidate_journey_gates(platform, candidate))
        .collect()
}

fn candidate_journey_gates(platform: &str, candidate: Candidate) -> Vec<GateResult> {
    journey_specs()
        .into_iter()
        .map(|(name, checkpoint, class)| {
            pending_for(
                platform,
                candidate,
                name,
                checkpoint,
                class,
                "exact-head candidate artifact evidence is not supplied",
            )
        })
        .collect()
}

fn journey_specs() -> [(&'static str, &'static str, EvidenceClass); 7] {
    [
        (
            "input_to_paint",
            "first_presented_input",
            EvidenceClass::Performance,
        ),
        (
            "runtime_to_ui",
            "committed_runtime_state",
            EvidenceClass::Performance,
        ),
        (
            "accessibility",
            "keyboard_and_semantics",
            EvidenceClass::Accessibility,
        ),
        (
            "international_input",
            "ime_composition",
            EvidenceClass::InternationalInput,
        ),
        (
            "native_dialog",
            "folder_picker_cancel",
            EvidenceClass::NativeDialog,
        ),
        (
            "renderer_recovery",
            "unavailable_then_usable",
            EvidenceClass::Recovery,
        ),
        (
            "visual_platform",
            "appearance_scaling_contrast",
            EvidenceClass::Visual,
        ),
    ]
}

pub(crate) fn gate(
    platform: &str,
    name: &str,
    checkpoint: &str,
    class: EvidenceClass,
    passes: bool,
    evidence: &str,
) -> GateResult {
    GateResult {
        gate: name.into(),
        candidate: None,
        platform: platform.into(),
        checkpoint: checkpoint.into(),
        evidence_class: class,
        status: if passes {
            GateStatus::Pass
        } else {
            GateStatus::Fail
        },
        artifact_sha256: None,
        evidence: evidence.into(),
    }
}

pub(crate) fn pending(
    platform: &str,
    name: &str,
    checkpoint: &str,
    class: EvidenceClass,
    evidence: &str,
) -> GateResult {
    pending_result(platform, None, name, checkpoint, class, evidence)
}

fn pending_for(
    platform: &str,
    candidate: Candidate,
    name: &str,
    checkpoint: &str,
    class: EvidenceClass,
    evidence: &str,
) -> GateResult {
    pending_result(platform, Some(candidate), name, checkpoint, class, evidence)
}

fn pending_result(
    platform: &str,
    candidate: Option<Candidate>,
    name: &str,
    checkpoint: &str,
    class: EvidenceClass,
    evidence: &str,
) -> GateResult {
    GateResult {
        gate: name.into(),
        candidate,
        platform: platform.into(),
        checkpoint: checkpoint.into(),
        evidence_class: class,
        status: GateStatus::Pending,
        artifact_sha256: None,
        evidence: evidence.into(),
    }
}

fn windows_supervision_gate(platform: &str, backend: SupervisionBackend) -> GateResult {
    if platform == "windows" {
        gate(
            platform,
            "windows_job_object",
            "descendant_cleanup",
            EvidenceClass::Platform,
            backend == SupervisionBackend::WindowsJobObject,
            "workspace lifecycle tests exercise root-exit descendant cleanup",
        )
    } else {
        pending(
            platform,
            "windows_job_object",
            "descendant_cleanup",
            EvidenceClass::Platform,
            "must be proven by canonical verification on Windows",
        )
    }
}

pub(crate) fn run_cargo<const N: usize>(arguments: [&str; N]) -> Result<(), RunnerError> {
    let status = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .args(arguments)
        .current_dir(manifest_dir())
        .status()?;
    status
        .success()
        .then_some(())
        .ok_or(RunnerError::CommandFailed)
}

pub(crate) fn write_sanitized(path: &Path, evidence: &impl Serialize) -> Result<(), RunnerError> {
    let value = serde_json::to_value(evidence)?;
    EvidenceSanitizer::validate_value(&value)?;
    fs::create_dir_all(path.parent().ok_or(RunnerError::InvalidOutput)?)?;
    fs::write(path, serde_json::to_vec_pretty(&value)?)?;
    Ok(())
}

pub(crate) fn require_package_record(
    records: &[PackageEvidence],
    candidate: Candidate,
) -> Result<(), RunnerError> {
    records
        .iter()
        .any(|record| record.candidate == candidate)
        .then_some(())
        .ok_or(RunnerError::MissingPackage)
}

pub(crate) fn verify_output() -> PathBuf {
    manifest_dir()
        .join("artifacts")
        .join("current-platform-verify.json")
}
pub(crate) fn benchmark_output() -> PathBuf {
    manifest_dir()
        .join("artifacts")
        .join("current-platform.json")
}
