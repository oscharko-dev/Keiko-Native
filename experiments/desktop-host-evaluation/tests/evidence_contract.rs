use keiko_eval::benchmark::Candidate;
use keiko_eval::runner_evidence::{EvidenceClass, GateResult, GateStatus, complete};

fn gate(status: GateStatus) -> GateResult {
    GateResult {
        gate: "accessibility".into(),
        candidate: Some(Candidate::Slint),
        platform: "windows".into(),
        checkpoint: "keyboard_and_semantics".into(),
        evidence_class: EvidenceClass::Accessibility,
        status,
        artifact_sha256: Some("a".repeat(64)),
        evidence: "exact-head artifact".into(),
    }
}

#[test]
fn gate_schema_binds_candidate_platform_checkpoint_class_and_artifact() {
    let value = serde_json::to_value(gate(GateStatus::Pass)).unwrap();
    assert_eq!(value["candidate"], "slint");
    assert_eq!(value["platform"], "windows");
    assert_eq!(value["checkpoint"], "keyboard_and_semantics");
    assert_eq!(value["evidence_class"], "accessibility");
    assert_eq!(value["artifact_sha256"].as_str().unwrap().len(), 64);
}

#[test]
fn pending_or_failed_gate_is_never_decision_ready() {
    assert!(complete(&[gate(GateStatus::Pass)]));
    assert!(!complete(&[gate(GateStatus::Pending)]));
    assert!(!complete(&[gate(GateStatus::Fail)]));
}
