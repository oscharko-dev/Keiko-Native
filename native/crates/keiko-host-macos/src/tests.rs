use super::*;

fn request(sequence: u64, _legacy_request_id: &str) -> Vec<u8> {
    request_for(1, sequence)
}

fn request_for(generation: u64, sequence: u64) -> Vec<u8> {
    let request_id = canonical_request_id(generation, sequence).expect("canonical request ID");
    format!(
        r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":{sequence},"timeoutMs":1000,"operation":{{"kind":"application-health"}}}}"#,
    )
    .into_bytes()
}

fn cancel_for(generation: u64, sequence: u64) -> Vec<u8> {
    let request_id = canonical_request_id(generation, sequence).expect("canonical request ID");
    format!(r#"{{"schemaVersion":1,"requestId":"{request_id}"}}"#).into_bytes()
}

fn nonce(value: char) -> String {
    value.to_string().repeat(64)
}

fn started() -> (HostLifecycle, SenderContext) {
    let mut lifecycle = HostLifecycle::default();
    let document_nonce = nonce('a');
    let generation = lifecycle
        .begin_renderer_session(document_nonce.clone())
        .expect("valid nonce");
    (
        lifecycle,
        SenderContext {
            window_label: "main".to_owned(),
            origin: "tauri://localhost".to_owned(),
            generation,
            document_nonce,
        },
    )
}

#[test]
fn health_replay_stale_sender_origin_and_shutdown_fail_closed() {
    let (mut lifecycle, sender) = started();
    let accepted = lifecycle
        .begin_application_request(&sender, &request(1, "request-00000001"))
        .expect("accepted");
    assert!(
        lifecycle
            .complete_application_request(accepted)
            .contains("healthy")
    );
    assert_eq!(
        lifecycle.begin_application_request(&sender, &request(1, "request-00000001")),
        Err((
            "request-0000000000000001-0000000000000001".to_owned(),
            ReasonCode::ReplayedRequest,
        ))
    );
    assert_eq!(
        lifecycle.begin_application_request(&sender, &request(1, "request-00000002")),
        Err((
            "request-0000000000000001-0000000000000001".to_owned(),
            ReasonCode::ReplayedRequest,
        ))
    );
    for (context, reason) in [
        (
            SenderContext {
                window_label: "other".to_owned(),
                ..sender.clone()
            },
            ReasonCode::UnauthenticatedSender,
        ),
        (
            SenderContext {
                origin: "hostile-origin".to_owned(),
                ..sender.clone()
            },
            ReasonCode::UnauthenticatedOrigin,
        ),
    ] {
        assert_eq!(
            lifecycle.begin_application_request(&context, &request(2, "request-00000003")),
            Err(("unknown-request".to_owned(), reason))
        );
    }
    lifecycle.shutdown();
    assert_eq!(
        lifecycle.begin_application_request(&sender, &request(2, "request-00000004")),
        Err(("unknown-request".to_owned(), ReasonCode::ShuttingDown))
    );
}

#[test]
fn cancellation_is_owned_by_the_current_generation() {
    let (mut lifecycle, sender) = started();
    let accepted = lifecycle
        .begin_application_request(&sender, &request(1, "request-00000001"))
        .expect("accepted");
    let cancel = cancel_for(1, 1);
    assert!(
        lifecycle
            .cancel_application_request(&sender, &cancel)
            .contains("cancelled")
    );
    assert!(
        lifecycle
            .complete_application_request(accepted)
            .contains("cancelled")
    );

    let accepted = lifecycle
        .begin_application_request(&sender, &request(2, "request-00000002"))
        .expect("accepted");
    let old_sender = sender;
    let new_generation = lifecycle
        .begin_renderer_session(nonce('b'))
        .expect("valid nonce");
    assert!(
        lifecycle
            .complete_application_request(accepted)
            .contains("cancelled")
    );
    assert!(
        lifecycle
            .cancel_application_request(&old_sender, &cancel_for(1, 2),)
            .contains("unauthorized")
    );
    assert!(new_generation > old_sender.generation);
}

#[test]
fn concurrent_replay_shutdown_and_replay_window_fail_closed() {
    let (mut lifecycle, sender) = started();
    let accepted = lifecycle
        .begin_application_request(&sender, &request(1, "request-00000001"))
        .expect("accepted");
    assert_eq!(
        lifecycle.begin_application_request(&sender, &request(1, "request-00000001")),
        Err((
            "request-0000000000000001-0000000000000001".to_owned(),
            ReasonCode::ReplayedRequest,
        ))
    );
    lifecycle.shutdown();
    assert!(
        lifecycle
            .complete_application_request(accepted)
            .contains("cancelled")
    );

    let (mut lifecycle, sender) = started();
    for sequence in 1..=65 {
        let request_id = format!("request-{sequence:08}");
        let accepted = lifecycle
            .begin_application_request(&sender, &request(sequence, &request_id))
            .expect("bounded replay request");
        assert!(
            lifecycle
                .complete_application_request(accepted)
                .contains("healthy")
        );
    }
    assert_eq!(
        lifecycle.begin_application_request(&sender, &request(1, "evicted")),
        Err((
            "request-0000000000000001-0000000000000001".to_owned(),
            ReasonCode::StaleRequest,
        ))
    );
    let evicted_id_with_newer_sequence = br#"{"schemaVersion":1,"requestId":"request-0000000000000001-0000000000000001","sequence":66,"timeoutMs":1000,"operation":{"kind":"application-health"}}"#;
    assert_eq!(
        lifecycle.begin_application_request(&sender, evicted_id_with_newer_sequence),
        Err((
            "request-0000000000000001-0000000000000001".to_owned(),
            ReasonCode::InvalidRequest,
        ))
    );
}

#[test]
fn outstanding_request_capacity_precedes_host_acceptance_and_frees_on_completion() {
    let (mut lifecycle, sender) = started();
    let mut accepted = Vec::new();
    for sequence in 1..=MAX_IN_FLIGHT_REQUESTS as u64 {
        accepted.push(
            lifecycle
                .begin_application_request(&sender, &request_for(1, sequence))
                .expect("request within exact cancellation capacity"),
        );
    }

    let duplicate_id = canonical_request_id(1, 1).expect("canonical duplicate ID");
    assert_eq!(
        lifecycle.begin_application_request(&sender, &request_for(1, 1)),
        Err((duplicate_id, ReasonCode::ReplayedRequest))
    );
    for sequence in [65, 66] {
        let request_id = canonical_request_id(1, sequence).expect("canonical overflow ID");
        assert_eq!(
            lifecycle.begin_application_request(&sender, &request_for(1, sequence)),
            Err((request_id, ReasonCode::InternalFailure))
        );
    }
    assert_eq!(lifecycle.in_flight.len(), MAX_IN_FLIGHT_REQUESTS);

    let cancellations = lifecycle.renderer_lost();
    assert!(
        cancellations.is_empty(),
        "non-Runtime Host cancellations must not become Runtime records"
    );
    assert!(
        lifecycle
            .in_flight
            .values()
            .all(|request| request.accepted_cancellation.is_some()),
        "every Host request retains its own terminal cancellation"
    );
    for request in accepted.drain(..) {
        assert!(
            lifecycle
                .complete_application_request(request)
                .contains("cancelled")
        );
    }
    assert!(lifecycle.in_flight.is_empty());
    let next_nonce = nonce('b');
    let generation = lifecycle
        .begin_renderer_session(next_nonce.clone())
        .expect("replacement renderer");
    let next_sender =
        lifecycle.sender_for_document("main", "tauri://localhost", generation, &next_nonce);
    let request_id = canonical_request_id(generation, 1).expect("Runtime request ID");
    let runtime_request = format!(
        r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":120000,"operation":{{"kind":"codex-turn-start","workspaceGeneration":1,"task":"Bounded task."}}}}"#,
    );
    lifecycle
        .begin_application_request(&next_sender, runtime_request.as_bytes())
        .expect("exact completion frees Host admission for a Runtime request");
    let runtime_cancellations = lifecycle.renderer_lost();
    assert_eq!(runtime_cancellations.len(), 1);
    assert_eq!(runtime_cancellations[0].request_id, request_id);
}

#[test]
fn shutdown_forwards_only_runtime_owned_records_but_cancels_every_host_request() {
    let (mut lifecycle, sender) = started();
    let health = lifecycle
        .begin_application_request(&sender, &request_for(1, 1))
        .expect("health request");
    let readiness_id = canonical_request_id(1, 2).expect("readiness ID");
    let readiness = format!(
        r#"{{"schemaVersion":1,"requestId":"{readiness_id}","sequence":2,"timeoutMs":5000,"operation":{{"kind":"runtime-readiness"}}}}"#,
    );
    let readiness = lifecycle
        .begin_application_request(&sender, readiness.as_bytes())
        .expect("readiness request");

    let records = lifecycle.shutdown();

    assert_eq!(records.len(), 1);
    assert_eq!(records[0].request_id, readiness_id);
    assert!(
        lifecycle
            .complete_application_request(health)
            .contains("cancelled")
    );
    assert!(
        lifecycle
            .complete_runtime_request(
                readiness,
                RuntimeReadinessView::terminal(RuntimeReadinessState::Unavailable, 0),
            )
            .contains("cancelled")
    );
}

#[test]
fn request_identifier_must_match_authenticated_generation_and_sequence() {
    let (mut lifecycle, sender) = started();
    let mismatched = br#"{"schemaVersion":1,"requestId":"request-0000000000000002-0000000000000001","sequence":1,"timeoutMs":1000,"operation":{"kind":"application-health"}}"#;
    assert_eq!(
        lifecycle.begin_application_request(&sender, mismatched),
        Err((
            "request-0000000000000002-0000000000000001".to_owned(),
            ReasonCode::InvalidRequest,
        ))
    );
}

#[test]
fn renderer_generation_exhaustion_fails_closed_without_reuse() {
    let mut lifecycle = HostLifecycle {
        generation: MAX_SEQUENCE,
        ..HostLifecycle::default()
    };
    assert_eq!(lifecycle.begin_renderer_session(nonce('a')), None);
    assert!(lifecycle.current_document_authority().is_none());
}

#[test]
fn malformed_missing_cross_generation_and_late_cancellation_are_closed() {
    let (mut lifecycle, sender) = started();
    assert!(
        lifecycle
            .cancel_application_request(&sender, b"not-json")
            .contains("invalid-request")
    );
    assert!(
        lifecycle
            .cancel_application_request(&sender, &cancel_for(1, 1),)
            .contains("unauthorized")
    );
    let accepted = lifecycle
        .begin_application_request(&sender, &request(1, "request-00000002"))
        .expect("accepted");
    lifecycle.begin_renderer_session(nonce('b'));
    let (current_generation, current_nonce) = lifecycle
        .current_document_authority()
        .expect("document authority");
    let current = lifecycle.sender_for_document(
        "main",
        "tauri://localhost",
        current_generation,
        &current_nonce,
    );
    assert!(
        lifecycle
            .cancel_application_request(&current, &cancel_for(1, 1),)
            .contains("unauthorized")
    );
    assert!(
        lifecycle
            .complete_application_request(accepted)
            .contains("cancelled")
    );

    let duplicate_completion = AcceptedRequest {
        generation: current.generation,
        request: parse_request(&request(2, "request-00000003")).expect("request"),
    };
    assert!(
        lifecycle
            .complete_application_request(duplicate_completion)
            .contains("internal-failure")
    );
}

#[test]
fn injected_unavailable_timeout_and_renderer_loss_are_terminal() {
    let (mut lifecycle, sender) = started();
    lifecycle.set_test_now_ms(0);
    let unavailable = lifecycle
        .begin_application_request(&sender, &request(1, "request-00000001"))
        .expect("accepted");
    lifecycle.set_test_now_ms(1);
    assert!(
        lifecycle
            .complete_unavailable(unavailable)
            .contains("host-unavailable")
    );
    lifecycle.set_test_now_ms(0);
    let timeout = lifecycle
        .begin_application_request(&sender, &request(2, "request-00000002"))
        .expect("accepted");
    lifecycle.set_test_now_ms(1000);
    assert!(
        lifecycle
            .complete_application_request(timeout)
            .contains("timed-out")
    );
    lifecycle.set_test_now_ms(0);
    let cancelled = lifecycle
        .begin_application_request(&sender, &request(3, "request-00000003"))
        .expect("accepted");
    lifecycle.set_test_now_ms(1);
    assert!(
        lifecycle
            .cancel_application_request(&sender, &cancel_for(1, 3),)
            .contains("cancelled")
    );
    lifecycle.set_test_now_ms(2);
    assert!(
        lifecycle
            .complete_application_request(cancelled)
            .contains("cancelled")
    );
    lifecycle.renderer_lost();
    assert_eq!(
        lifecycle.begin_application_request(&sender, &request(4, "request-00000004")),
        Err(("unknown-request".to_owned(), ReasonCode::Unauthorized))
    );
}

#[test]
fn explicit_cancellation_at_deadline_never_beats_timeout() {
    let (mut lifecycle, sender) = started();
    lifecycle.set_test_now_ms(0);
    let accepted = lifecycle
        .begin_application_request(&sender, &request(1, "request-00000001"))
        .expect("accepted");
    lifecycle.set_test_now_ms(1000);
    assert!(
        lifecycle
            .cancel_application_request(&sender, &cancel_for(1, 1),)
            .contains("timed-out")
    );
    assert!(
        lifecycle
            .complete_application_request(accepted)
            .contains("timed-out")
    );
}

#[test]
fn host_records_only_the_first_eligible_cancel_acceptance() {
    let (mut lifecycle, sender) = started();
    lifecycle.set_test_now_ms(0);
    let _accepted = lifecycle
        .begin_application_request(&sender, &request(1, "request-first-token"))
        .expect("accepted request");
    let request_id = canonical_request_id(sender.generation, 1).expect("request ID");

    lifecycle.set_test_now_ms(25);
    assert!(
        lifecycle
            .cancel_application_request(&sender, &cancel_for(sender.generation, 1))
            .contains("cancelled")
    );
    lifecycle.set_test_now_ms(75);
    assert!(
        lifecycle
            .cancel_application_request(&sender, &cancel_for(sender.generation, 1))
            .contains("cancelled")
    );

    let in_flight = lifecycle.in_flight.get(&request_id).expect("in flight");
    assert_eq!(in_flight.cancelled_at_ms, Some(25));
    assert_eq!(
        in_flight.cancellation_source,
        Some(CancellationSource::User)
    );
}

#[test]
fn host_acceptance_timestamp_is_sampled_at_the_literal_first_mutation() {
    let (mut lifecycle, sender) = started();
    lifecycle.set_test_now_ms(0);
    let _accepted = lifecycle
        .begin_application_request(&sender, &request(1, "request-literal-mutation"))
        .expect("accepted request");
    lifecycle.set_test_now_ms(25);

    let outcome = lifecycle.cancel_application_request_with_acceptance_before_mutation(
        &sender,
        &cancel_for(sender.generation, 1),
        |lifecycle| lifecycle.set_test_now_ms(75),
    );

    assert_eq!(
        outcome.accepted.expect("literal acceptance").accepted_at,
        lifecycle.current_instant_for_test(),
        "validation delay before the first mutation must not consume the public window"
    );
}

#[test]
fn ineligible_cancels_never_create_an_acceptance_record() {
    let (mut lifecycle, sender) = started();
    lifecycle.set_test_now_ms(0);
    let _accepted = lifecycle
        .begin_application_request(&sender, &request(1, "request-no-token"))
        .expect("accepted request");
    let request_id = canonical_request_id(sender.generation, 1).expect("request ID");

    assert!(
        lifecycle
            .cancel_application_request(&sender, b"not-json")
            .contains("invalid-request")
    );
    assert_eq!(
        lifecycle
            .in_flight
            .get(&request_id)
            .expect("in flight")
            .cancelled_at_ms,
        None
    );

    lifecycle.set_test_now_ms(1_000);
    assert!(
        lifecycle
            .cancel_application_request(&sender, &cancel_for(sender.generation, 1))
            .contains("timed-out")
    );
    assert_eq!(
        lifecycle
            .in_flight
            .get(&request_id)
            .expect("in flight")
            .cancelled_at_ms,
        None,
        "a timed-out cancel is rejected and must not create authority"
    );
}

#[test]
fn document_nonce_is_unpredictable_outer_authority_and_fails_closed() {
    let mut lifecycle = HostLifecycle::default();
    assert!(!activate_renderer_document(&mut lifecycle, |_| None));
    assert!(lifecycle.current_document_authority().is_none());
    assert!(!activate_renderer_document(&mut lifecycle, |_| Some(
        "too-short".to_owned()
    )));
    let honest_nonce = nonce('a');
    assert!(activate_renderer_document(&mut lifecycle, |_| Some(
        honest_nonce.clone()
    )));
    let (generation, _) = lifecycle
        .current_document_authority()
        .expect("current authority");
    for guessed in [String::new(), nonce('b')] {
        let sender =
            lifecycle.sender_for_document("main", "tauri://localhost", generation, &guessed);
        assert_eq!(
            lifecycle.begin_application_request(&sender, &request(1, "request-00000001")),
            Err(("unknown-request".to_owned(), ReasonCode::Unauthorized))
        );
    }
    let next_generation =
        lifecycle.sender_for_document("main", "tauri://localhost", generation + 1, &honest_nonce);
    assert_eq!(
        lifecycle.begin_application_request(&next_generation, &request(1, "request-00000002")),
        Err(("unknown-request".to_owned(), ReasonCode::Unauthorized))
    );
    let honest =
        lifecycle.sender_for_document("main", "tauri://localhost", generation, &honest_nonce);
    assert!(
        lifecycle
            .begin_application_request(&honest, &request(1, "request-00000003"))
            .is_ok()
    );
}

#[test]
fn accepted_document_start_always_retires_previous_authority_and_work() {
    for replacement in [None, Some("malformed".to_owned())] {
        let (mut lifecycle, sender) = started();
        let old_generation = sender.generation;
        let accepted = lifecycle
            .begin_application_request(&sender, &request(1, "request-00000001"))
            .expect("accepted old work");

        assert!(!activate_renderer_document(&mut lifecycle, |retired| {
            assert!(retired.current_document_authority().is_none());
            replacement
        }));
        assert!(lifecycle.current_document_authority().is_none());
        assert!(
            lifecycle
                .complete_application_request(accepted)
                .contains("cancelled")
        );

        assert!(activate_renderer_document(&mut lifecycle, |retired| {
            assert!(retired.current_document_authority().is_none());
            Some(nonce('b'))
        }));
        let (new_generation, new_nonce) = lifecycle
            .current_document_authority()
            .expect("fresh authority");
        assert!(new_generation > old_generation);
        assert_eq!(new_nonce, nonce('b'));
    }
}

#[test]
fn bundled_origins_are_closed() {
    assert!(is_bundled_origin("tauri://localhost"));
    assert!(is_bundled_origin("http://tauri.localhost"));
    assert!(!is_bundled_origin("tauri://localhost/index.html"));
    assert!(!is_bundled_origin("hostile-origin"));
}
