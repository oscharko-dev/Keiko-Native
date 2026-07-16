use std::process::Command;
use std::time::{Duration, Instant};

use crate::benchmark::{Candidate, ScheduledLaunch, StartClass, Thresholds, accepted_schedule};
use crate::lifecycle::{ProcessSupervisor, Termination, supervision_backend};
pub use crate::runner_error::RunnerError;
use crate::runner_evidence::*;
use crate::runner_package::*;
use crate::runner_platform::*;
use crate::runner_support::*;
use crate::statistics::{Distribution, OrderedSamples};

const READINESS_FINGERPRINT: &str =
    "4ef64b75cd9b2f4786f1317f360542b81a65cde058777709b4f2eeb233fc065e";
const CLEANUP_DEADLINE: Duration = Duration::from_secs(5);
const RESOURCE_IDLE_SETTLE: Duration = Duration::from_millis(250);
const RESOURCE_SAMPLE_INTERVAL: Duration = Duration::from_millis(100);
const MEASUREMENT_RESOLUTION_MS: f64 = 10.0;

pub fn verify_current() -> Result<VerifyEvidence, RunnerError> {
    let platform = current_platform()?;
    let source = source_binding()?;
    run_quality_commands()?;
    validate_source_binding(&source)?;
    let packages = prepare_packages(platform, &source)?;
    let backend = supervision_backend();
    let mut gates = verification_gates(platform, backend, &packages);
    gates.extend(journey_gates(platform));
    let decision_ready = complete(&gates);
    let evidence = VerifyEvidence {
        schema_version: 2,
        contract_version: "v1".into(),
        readiness_fingerprint: READINESS_FINGERPRINT.into(),
        source_commit: source.commit,
        platform: platform.into(),
        rust_version: rust_version()?,
        supervision_backend: backend,
        dependency_lock_sha256: source.lock_sha256,
        packages,
        gates,
        decision_ready,
    };
    write_sanitized(&verify_output(), &evidence)?;
    require_complete(evidence.decision_ready)?;
    Ok(evidence)
}

pub fn benchmark_current() -> Result<BenchmarkEvidence, RunnerError> {
    let platform = current_platform()?;
    let source = source_binding()?;
    let packages = existing_packages(platform, &source)?;
    let samples = measure_schedule(platform, &packages)?;
    validate_source_binding(&source)?;
    let summaries = summarize(&samples)?;
    let mut gates = benchmark_gates(&samples, &summaries, platform);
    gates.extend(journey_gates(platform));
    let decision_ready = complete(&gates);
    let evidence = BenchmarkEvidence {
        schema_version: 2,
        contract_version: "v1".into(),
        readiness_fingerprint: READINESS_FINGERPRINT.into(),
        source_commit: source.commit,
        dependency_lock_sha256: source.lock_sha256,
        environment: environment(platform),
        thresholds: Thresholds::accepted(),
        packages,
        methodology: benchmark_methodology(),
        samples,
        summaries,
        gates,
        decision_ready,
    };
    write_sanitized(&benchmark_output(), &evidence)?;
    require_complete(evidence.decision_ready)?;
    Ok(evidence)
}

fn run_quality_commands() -> Result<(), RunnerError> {
    run_cargo(["fmt", "--all", "--", "--check"])?;
    run_cargo(["test", "--locked", "--workspace", "--all-targets"])?;
    run_cargo([
        "clippy",
        "--locked",
        "--workspace",
        "--all-targets",
        "--",
        "-D",
        "warnings",
    ])?;
    run_cargo(["build", "--locked", "--workspace", "--bins", "--release"])?;
    build_instrumented_candidate("keiko-tauri-prototype")?;
    build_instrumented_candidate("keiko-slint-prototype")
}

fn build_instrumented_candidate(package: &str) -> Result<(), RunnerError> {
    run_cargo([
        "build",
        "--locked",
        "--release",
        "--package",
        package,
        "--features",
        "evaluation-hooks",
    ])
}

fn measure_schedule(
    platform: &str,
    packages: &[PackageEvidence],
) -> Result<Vec<LaunchSample>, RunnerError> {
    let mut warmed = [false; 2];
    accepted_schedule()
        .into_iter()
        .map(|launch| {
            let index = match launch.candidate {
                Candidate::Tauri => 0,
                Candidate::Slint => 1,
            };
            if launch.start_class == StartClass::Warm && !warmed[index] {
                warm_candidate(platform, packages, launch.candidate)?;
                warmed[index] = true;
            }
            measure_launch(platform, packages, launch, warmed[index])
        })
        .collect()
}

fn warm_candidate(
    platform: &str,
    packages: &[PackageEvidence],
    candidate: Candidate,
) -> Result<(), RunnerError> {
    let launch = ScheduledLaunch {
        start_class: StartClass::Warm,
        round: 0,
        position: 0,
        candidate,
    };
    let mut process = start_candidate(platform, packages, launch, false)?;
    close_candidate(platform, &mut process.supervisor)?;
    remove_handshake(&process.handshake)
}

fn measure_launch(
    platform: &str,
    packages: &[PackageEvidence],
    launch: ScheduledLaunch,
    warmup_completed: bool,
) -> Result<LaunchSample, RunnerError> {
    let mut process = start_candidate(platform, packages, launch, true)?;
    let stable_shell_ms = rounded_millis(process.started.elapsed());
    let idle_resources = process
        .supervisor
        .sample_resources_after_settle(RESOURCE_IDLE_SETTLE, RESOURCE_SAMPLE_INTERVAL);
    let shutdown_started = Instant::now();
    request_normal_close(platform, process.supervisor.root_pid())?;
    let termination = process.supervisor.wait_or_terminate(CLEANUP_DEADLINE)?;
    let normal_shutdown_ms = rounded_millis(shutdown_started.elapsed());
    let orphan_process = process.supervisor.process_tree_remains();
    remove_handshake(&process.handshake)?;
    if termination != Termination::Exited {
        return Err(RunnerError::NormalShutdownFailed);
    }
    Ok(LaunchSample {
        launch,
        precondition: launch_precondition(launch.start_class, warmup_completed),
        stable_shell_ms,
        normal_shutdown_ms,
        measurement_resolution_ms: MEASUREMENT_RESOLUTION_MS,
        uncertainty_ms: MEASUREMENT_RESOLUTION_MS,
        idle_resources,
        orphan_process,
    })
}

struct RunningCandidate {
    supervisor: ProcessSupervisor,
    handshake: std::path::PathBuf,
    started: Instant,
}

fn start_candidate(
    platform: &str,
    packages: &[PackageEvidence],
    launch: ScheduledLaunch,
    unique_state: bool,
) -> Result<RunningCandidate, RunnerError> {
    require_package_record(packages, launch.candidate)?;
    let executable = packaged_executable(platform, launch.candidate);
    let handshake = fresh_handshake_path(launch)?;
    let state = launch_state_path(launch, unique_state)?;
    let started = Instant::now();
    let mut command = Command::new(executable);
    command
        .env("KEIKO_EVAL_READY_FILE", &handshake)
        .env("KEIKO_EVAL_STATE_DIR", state);
    let supervisor = ProcessSupervisor::spawn(command)?;
    wait_for_stable_shell(&supervisor, &handshake, started)?;
    Ok(RunningCandidate {
        supervisor,
        handshake,
        started,
    })
}

fn close_candidate(platform: &str, supervisor: &mut ProcessSupervisor) -> Result<(), RunnerError> {
    request_normal_close(platform, supervisor.root_pid())?;
    if supervisor.wait_or_terminate(CLEANUP_DEADLINE)? != Termination::Exited {
        return Err(RunnerError::NormalShutdownFailed);
    }
    Ok(())
}

fn summarize(samples: &[LaunchSample]) -> Result<Vec<CandidateSummary>, RunnerError> {
    [Candidate::Tauri, Candidate::Slint]
        .into_iter()
        .map(|candidate| summarize_candidate(samples, candidate))
        .collect()
}

fn summarize_candidate(
    samples: &[LaunchSample],
    candidate: Candidate,
) -> Result<CandidateSummary, RunnerError> {
    let cold = sample_values(samples, candidate, Some(StartClass::Cold), |sample| {
        sample.stable_shell_ms
    })?;
    let warm = sample_values(samples, candidate, Some(StartClass::Warm), |sample| {
        sample.stable_shell_ms
    })?;
    let shutdown = sample_values(samples, candidate, None, |sample| sample.normal_shutdown_ms)?;
    Ok(CandidateSummary {
        candidate,
        cold_start_ms: Distribution::from_samples(&cold),
        warm_start_ms: Distribution::from_samples(&warm),
        shutdown_ms: Distribution::from_samples(&shutdown),
    })
}

fn sample_values(
    samples: &[LaunchSample],
    candidate: Candidate,
    class: Option<StartClass>,
    value: impl Fn(&LaunchSample) -> f64,
) -> Result<OrderedSamples, RunnerError> {
    let values = samples
        .iter()
        .filter(|sample| {
            sample.launch.candidate == candidate
                && class.is_none_or(|expected| sample.launch.start_class == expected)
        })
        .map(value)
        .collect();
    Ok(OrderedSamples::new(values)?)
}

fn benchmark_gates(
    samples: &[LaunchSample],
    summaries: &[CandidateSummary],
    platform: &str,
) -> Vec<GateResult> {
    let thresholds = Thresholds::accepted();
    let startup = summaries
        .iter()
        .all(|summary| startup_passes(summary, thresholds));
    let shutdown = summaries
        .iter()
        .all(|summary| thresholds.shutdown_ms.passes(summary.shutdown_ms.maximum));
    let cleanup = samples.iter().all(|sample| !sample.orphan_process);
    let mut gates = measured_benchmark_gates(platform, startup, shutdown, cleanup);
    gates.extend(pending_benchmark_gates(platform));
    gates
}

fn measured_benchmark_gates(
    platform: &str,
    startup: bool,
    shutdown: bool,
    cleanup: bool,
) -> Vec<GateResult> {
    vec![
        gate(
            platform,
            "startup_thresholds",
            "stable_rendered_shell",
            EvidenceClass::Performance,
            startup,
            "ready handshake and exact thresholds",
        ),
        gate(
            platform,
            "normal_shutdown",
            "close_dispatch_to_tree_exit",
            EvidenceClass::Performance,
            shutdown,
            "close dispatch is included in the five second bound",
        ),
        gate(
            platform,
            "orphan_cleanup",
            "post_close_process_tree",
            EvidenceClass::Automated,
            cleanup,
            "tracked root and descendant processes are absent",
        ),
    ]
}

fn pending_benchmark_gates(platform: &str) -> Vec<GateResult> {
    vec![
        pending(
            platform,
            "cold_os_cache",
            "cold_start_precondition",
            EvidenceClass::Performance,
            "an empty external state directory is provided but candidate use and operating-system caches are uncontrolled",
        ),
        pending(
            platform,
            "package_size",
            "release_package",
            EvidenceClass::Performance,
            "diagnostic executable directories are excluded from package-size claims",
        ),
        pending(
            platform,
            "peak_and_recovery_resources",
            "recovery_resource_distribution",
            EvidenceClass::Performance,
            "recovery-phase resource samples are not supplied",
        ),
        pending(
            platform,
            "environment_preflight",
            "power_thermal_and_display_conditions",
            EvidenceClass::Platform,
            "sanitized operator preflight is required before authoritative timing",
        ),
        pending(
            platform,
            "other_physical_platform",
            "cross_platform_evidence",
            EvidenceClass::Platform,
            if platform == "windows" {
                "macOS physical evidence is not supplied"
            } else {
                "Windows physical evidence is not supplied"
            },
        ),
    ]
}

fn startup_passes(summary: &CandidateSummary, thresholds: Thresholds) -> bool {
    thresholds.cold_p50_ms.passes(summary.cold_start_ms.p50)
        && thresholds.cold_p95_ms.passes(summary.cold_start_ms.p95)
        && thresholds.warm_p95_ms.passes(summary.warm_start_ms.p95)
}

pub(crate) fn benchmark_methodology() -> BenchmarkMethodology {
    BenchmarkMethodology {
        startup_endpoint:
            "candidate writes keiko-stable-rendered-shell-v1 after stable shell presentation".into(),
        cold_precondition: "new empty external state directory is provided; candidate persistence is not claimed"
            .into(),
        warm_precondition: "one unmeasured launch then the same external directory is provided; candidate persistence is not claimed"
            .into(),
        os_cache_limitation:
            "runner does not claim or manipulate operating-system disk or renderer caches".into(),
        resource_endpoint: "250 ms idle settle followed by two refreshes 100 ms apart".into(),
        resource_accounting: "root plus recursively observed descendants, summed once per process"
            .into(),
        resource_limitation:
            "shared system WebView services outside the descendant tree are not attributed".into(),
        shutdown_endpoint: "normal-close dispatch start through full supervised process-tree exit"
            .into(),
        measurement_resolution: "values rounded to 10 ms with plus-or-minus 10 ms uncertainty"
            .into(),
    }
}

pub(crate) fn rounded_millis(duration: Duration) -> f64 {
    let raw = duration.as_secs_f64() * 1_000.0;
    (raw / MEASUREMENT_RESOLUTION_MS).round() * MEASUREMENT_RESOLUTION_MS
}

pub(crate) fn launch_precondition(class: StartClass, warmed: bool) -> LaunchPrecondition {
    LaunchPrecondition {
        application_state: if class == StartClass::Cold {
            ApplicationState::FreshDirectoryProvided
        } else {
            ApplicationState::ReusedDirectoryProvided
        },
        os_cache_state: OsCacheState::Uncontrolled,
        warmup_completed: class == StartClass::Warm && warmed,
    }
}
