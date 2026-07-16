use keiko_eval::benchmark::{
    BenchmarkContract, Candidate, CandidateLatencyCounts, LatencyMarker, ObservedThresholds,
    StartClass, Thresholds, accepted_schedule, counterbalanced_round_order,
};
use keiko_eval::statistics::{Distribution, OrderedSamples};

#[test]
fn percentile_uses_nearest_rank_without_dropping_raw_order() {
    let samples = OrderedSamples::new(vec![8.0, 1.0, 4.0, 2.0, 9.0]).unwrap();
    assert_eq!(samples.raw(), &[8.0, 1.0, 4.0, 2.0, 9.0]);
    let distribution = Distribution::from_samples(&samples);
    assert_eq!(distribution.p50, 4.0);
    assert_eq!(distribution.p75, 8.0);
    assert_eq!(distribution.p95, 9.0);
}

#[test]
fn empty_nan_and_infinite_samples_are_rejected() {
    assert!(OrderedSamples::new(Vec::new()).is_err());
    assert!(OrderedSamples::new(vec![f64::NAN]).is_err());
    assert!(OrderedSamples::new(vec![f64::INFINITY]).is_err());
}

#[test]
fn contract_rejects_too_few_or_unbalanced_samples() {
    let contract = BenchmarkContract::accepted();
    assert!(contract.validate_counts(19, 30).is_err());
    assert!(contract.validate_counts(20, 29).is_err());
    assert!(
        contract
            .validate_equal_latency_counts(20, 20, 20, 19)
            .is_err()
    );
}

#[test]
fn accepted_sample_boundaries_use_nearest_rank() {
    let cold = OrderedSamples::new((1..=20).map(f64::from).collect()).unwrap();
    let warm = OrderedSamples::new((1..=30).map(f64::from).collect()).unwrap();
    assert_eq!(Distribution::from_samples(&cold).p95, 19.0);
    assert_eq!(Distribution::from_samples(&warm).p95, 29.0);
}

#[test]
fn candidate_order_is_counterbalanced_by_round_and_retains_sequence() {
    let order = counterbalanced_round_order(6);
    assert_eq!(
        order,
        vec![
            Candidate::Tauri,
            Candidate::Slint,
            Candidate::Slint,
            Candidate::Tauri,
            Candidate::Tauri,
            Candidate::Slint,
        ]
    );
}

#[test]
fn exact_threshold_is_inclusive() {
    let thresholds = Thresholds::accepted();
    assert!(thresholds.cold_p50_ms.passes(1_500.0));
    assert!(thresholds.cold_p95_ms.passes(3_000.0));
    assert!(!thresholds.cold_p95_ms.passes(3_000.001));
}

#[test]
fn schedule_records_phase_round_position_and_exact_counts() {
    let schedule = accepted_schedule();
    assert_eq!(schedule.len(), 100);
    for candidate in [Candidate::Tauri, Candidate::Slint] {
        let cold = schedule
            .iter()
            .filter(|item| item.candidate == candidate && item.start_class == StartClass::Cold)
            .count();
        let warm = schedule
            .iter()
            .filter(|item| item.candidate == candidate && item.start_class == StartClass::Warm)
            .count();
        assert_eq!((cold, warm), (20, 30));
    }
    assert_eq!((schedule[0].round, schedule[0].position), (0, 0));
    assert_eq!((schedule[3].round, schedule[3].position), (1, 1));
}

#[test]
fn latency_counts_are_equal_per_metric_and_markers_are_exact() {
    let make = |candidate| CandidateLatencyCounts {
        candidate,
        input_marker: LatencyMarker::FirstPresentedFrameContainingInputMutation,
        input_samples: 30,
        runtime_marker: LatencyMarker::ExternallyObservableCommittedRuntimeState,
        runtime_samples: 20,
    };
    assert!(
        BenchmarkContract::accepted()
            .validate_latency_pair(&make(Candidate::Tauri), &make(Candidate::Slint))
            .is_ok()
    );
}

#[test]
fn every_threshold_and_orphan_gate_is_enforced() {
    let distribution = |p50, p75, p95| Distribution {
        minimum: 0.0,
        p50,
        p75,
        p95,
        maximum: p95,
    };
    let observed = ObservedThresholds {
        cold: distribution(1_500.0, 2_000.0, 3_000.0),
        warm: distribution(500.0, 750.0, 1_000.0),
        input: distribution(20.0, 33.0, 50.0),
        runtime_ui: distribution(50.0, 75.0, 100.0),
        shutdown_ms: 5_000.0,
        orphan_process: false,
    };
    assert!(Thresholds::accepted().evaluate(&observed).all_pass());
    let failed = ObservedThresholds {
        orphan_process: true,
        ..observed
    };
    assert!(!Thresholds::accepted().evaluate(&failed).all_pass());
}
