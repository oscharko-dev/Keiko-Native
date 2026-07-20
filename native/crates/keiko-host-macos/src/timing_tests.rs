use keiko_application::current_build_identity;
use keiko_ui_port::{dispatch_health, encode_success};

use super::*;

fn nonce(value: char) -> String {
    value.to_string().repeat(64)
}

fn request(sequence: u64, _legacy_request_id: &str) -> Vec<u8> {
    let request_id = canonical_request_id(1, sequence).expect("canonical request ID");
    format!(
        r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":{sequence},"timeoutMs":1000,"operation":{{"kind":"application-health"}}}}"#,
    )
    .into_bytes()
}

fn cancel(sequence: u64) -> Vec<u8> {
    let request_id = canonical_request_id(1, sequence).expect("canonical request ID");
    format!(r#"{{"schemaVersion":1,"requestId":"{request_id}"}}"#).into_bytes()
}

fn started() -> (HostLifecycle, SenderContext) {
    let mut lifecycle = HostLifecycle::default();
    let document_nonce = nonce('a');
    let generation = lifecycle
        .begin_renderer_session(document_nonce.clone())
        .expect("valid nonce");
    let sender =
        lifecycle.sender_for_document("main", "tauri://localhost", generation, &document_nonce);
    (lifecycle, sender)
}

fn accept(
    lifecycle: &mut HostLifecycle,
    sender: &SenderContext,
    sequence: u64,
    request_id: &str,
) -> AcceptedRequest {
    lifecycle
        .begin_application_request(sender, &request(sequence, request_id))
        .expect("accepted")
}

#[test]
fn earliest_terminal_event_wins_at_every_timeout_boundary() {
    let (mut lifecycle, sender) = started();
    lifecycle.set_test_now_ms(0);
    let early_cancel = accept(&mut lifecycle, &sender, 1, "request-00000001");
    lifecycle.set_test_now_ms(999);
    assert!(
        lifecycle
            .cancel_application_request(&sender, &cancel(1),)
            .contains("cancelled")
    );
    lifecycle.set_test_now_ms(1500);
    assert!(
        lifecycle
            .cancel_application_request(&sender, &cancel(1),)
            .contains("cancelled")
    );
    assert!(
        lifecycle
            .complete_application_request(early_cancel)
            .contains("cancelled")
    );

    lifecycle.set_test_now_ms(0);
    let before_deadline = accept(&mut lifecycle, &sender, 2, "request-00000002");
    lifecycle.set_test_now_ms(999);
    assert!(
        lifecycle
            .complete_application_request(before_deadline)
            .contains("healthy")
    );

    lifecycle.set_test_now_ms(0);
    let at_deadline = accept(&mut lifecycle, &sender, 3, "request-00000003");
    lifecycle.set_test_now_ms(1000);
    assert!(
        lifecycle
            .complete_application_request(at_deadline)
            .contains("timed-out")
    );

    lifecycle.set_test_now_ms(0);
    let late_cancel = accept(&mut lifecycle, &sender, 4, "request-00000004");
    lifecycle.set_test_now_ms(1001);
    assert!(
        lifecycle
            .cancel_application_request(&sender, &cancel(4),)
            .contains("timed-out")
    );
    assert!(
        lifecycle
            .complete_application_request(late_cancel)
            .contains("timed-out")
    );
}

#[test]
fn replacement_and_shutdown_obey_the_same_early_late_precedence() {
    for (event_at_ms, expected) in [(999, "cancelled"), (1000, "timed-out")] {
        let (mut lifecycle, sender) = started();
        lifecycle.set_test_now_ms(0);
        let accepted = accept(&mut lifecycle, &sender, 1, "request-00000001");
        lifecycle.set_test_now_ms(event_at_ms);
        assert!(lifecycle.begin_renderer_session(nonce('b')).is_some());
        lifecycle.set_test_now_ms(1001);
        assert!(
            lifecycle
                .complete_application_request(accepted)
                .contains(expected)
        );

        let (mut lifecycle, sender) = started();
        lifecycle.set_test_now_ms(0);
        let accepted = accept(&mut lifecycle, &sender, 1, "request-00000001");
        lifecycle.set_test_now_ms(event_at_ms);
        lifecycle.shutdown();
        lifecycle.set_test_now_ms(1001);
        assert!(
            lifecycle
                .complete_application_request(accepted)
                .contains(expected)
        );
    }
}

#[test]
fn final_mutex_sample_host_unavailability_and_at_most_once_are_enforced() {
    let (mut lifecycle, sender) = started();
    lifecycle.set_test_now_ms(0);
    let crossing = accept(&mut lifecycle, &sender, 1, "request-00000001");
    lifecycle.set_test_now_ms(999);
    let encoded = encode_success(
        &dispatch_health(crossing.request.clone(), current_build_identity())
            .expect("health request"),
    );
    lifecycle.set_test_now_ms(1000);
    assert!(
        lifecycle
            .complete_with_encoded(crossing, encoded)
            .contains("timed-out")
    );

    lifecycle.set_test_now_ms(0);
    let unavailable = accept(&mut lifecycle, &sender, 2, "request-00000002");
    lifecycle.set_test_now_ms(1);
    let _ = lifecycle.cancel_application_request(&sender, &cancel(2));
    lifecycle.set_test_now_ms(1000);
    assert!(
        lifecycle
            .complete_unavailable(unavailable)
            .contains("host-unavailable")
    );

    lifecycle.set_test_now_ms(0);
    let accepted = accept(&mut lifecycle, &sender, 3, "request-00000003");
    let duplicate = AcceptedRequest {
        generation: accepted.generation,
        request: accepted.request.clone(),
    };
    lifecycle.set_test_now_ms(1);
    assert!(
        lifecycle
            .complete_application_request(accepted)
            .contains("healthy")
    );
    assert!(
        lifecycle
            .complete_application_request(duplicate)
            .contains("internal-failure")
    );
}
