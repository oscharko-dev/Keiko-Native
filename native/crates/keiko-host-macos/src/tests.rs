use super::*;

fn request(sequence: u64, request_id: &str) -> Vec<u8> {
    format!(
        r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":{sequence},"timeoutMs":1000,"operation":{{"kind":"application-health"}}}}"#,
    )
    .into_bytes()
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
        lifecycle.begin_application_request(&sender, &request(2, "request-00000001")),
        Err(("request-00000001".to_owned(), ReasonCode::ReplayedRequest))
    );
    assert_eq!(
        lifecycle.begin_application_request(&sender, &request(1, "request-00000002")),
        Err(("request-00000002".to_owned(), ReasonCode::StaleRequest))
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
                origin: "https://example.invalid".to_owned(),
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
    let cancel = br#"{"schemaVersion":1,"requestId":"request-00000001"}"#;
    assert!(
        lifecycle
            .cancel_application_request(&sender, cancel)
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
            .cancel_application_request(
                &old_sender,
                br#"{"schemaVersion":1,"requestId":"request-00000002"}"#,
            )
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
        lifecycle.begin_application_request(&sender, &request(2, "request-00000001")),
        Err(("request-00000001".to_owned(), ReasonCode::ReplayedRequest))
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
            .cancel_application_request(
                &sender,
                br#"{"schemaVersion":1,"requestId":"request-00000001"}"#,
            )
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
            .cancel_application_request(
                &current,
                br#"{"schemaVersion":1,"requestId":"request-00000002"}"#,
            )
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
    let unavailable = lifecycle
        .begin_application_request(&sender, &request(1, "request-00000001"))
        .expect("accepted");
    assert!(
        lifecycle
            .complete_observed(
                unavailable,
                ExecutionObservation {
                    cancelled_at_ms: None,
                    completed_at_ms: None,
                    host_available: false,
                },
            )
            .contains("host-unavailable")
    );
    let timeout = lifecycle
        .begin_application_request(&sender, &request(2, "request-00000002"))
        .expect("accepted");
    assert!(
        lifecycle
            .complete_observed(
                timeout,
                ExecutionObservation {
                    cancelled_at_ms: Some(1000),
                    completed_at_ms: None,
                    host_available: true,
                },
            )
            .contains("timed-out")
    );
    let cancelled = lifecycle
        .begin_application_request(&sender, &request(3, "request-00000003"))
        .expect("accepted");
    assert!(
        lifecycle
            .complete_observed(
                cancelled,
                ExecutionObservation {
                    cancelled_at_ms: Some(1),
                    completed_at_ms: Some(2),
                    host_available: true,
                },
            )
            .contains("cancelled")
    );
    lifecycle.renderer_lost();
    assert_eq!(
        lifecycle.begin_application_request(&sender, &request(4, "request-00000004")),
        Err(("unknown-request".to_owned(), ReasonCode::Unauthorized))
    );
}

#[test]
fn document_nonce_is_unpredictable_outer_authority_and_fails_closed() {
    let mut lifecycle = HostLifecycle::default();
    assert!(!activate_renderer_document(&mut lifecycle, None));
    assert!(lifecycle.current_document_authority().is_none());
    assert!(!activate_renderer_document(
        &mut lifecycle,
        Some("too-short".to_owned())
    ));
    let honest_nonce = nonce('a');
    assert!(activate_renderer_document(
        &mut lifecycle,
        Some(honest_nonce.clone())
    ));
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
fn bundled_origins_are_closed() {
    assert!(is_bundled_origin("tauri://localhost"));
    assert!(is_bundled_origin("http://tauri.localhost"));
    assert!(!is_bundled_origin("tauri://localhost/index.html"));
    assert!(!is_bundled_origin("https://example.invalid"));
}
