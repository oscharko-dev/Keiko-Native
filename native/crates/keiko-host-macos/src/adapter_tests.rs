use super::*;
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

#[test]
fn acknowledgement_requires_two_successes_in_one_generation() {
    let start = || {
        let mut lifecycle = HostLifecycle::default();
        let generation = lifecycle
            .begin_renderer_session(nonce('a'))
            .expect("renderer generation");
        (Mutex::new(lifecycle), generation)
    };

    let (lifecycle, generation) = start();
    let second_first = application_request(
        &lifecycle,
        "main",
        "tauri://localhost",
        generation,
        &nonce('a'),
        &String::from_utf8(request_for(generation, 2)).expect("request"),
    );
    assert!(!second_first.acknowledged);

    let (lifecycle, generation) = start();
    let sender = lifecycle.lock().expect("lifecycle").sender_for_document(
        "main",
        "tauri://localhost",
        generation,
        &nonce('a'),
    );
    let first = lifecycle
        .lock()
        .expect("lifecycle")
        .begin_application_request(&sender, &request_for(generation, 1))
        .expect("first in flight");
    assert!(
        application_cancel(
            &lifecycle,
            "main",
            "tauri://localhost",
            generation,
            &nonce('a'),
            &cancel(generation, 1),
        )
        .encoded
        .contains("cancelled")
    );
    assert!(
        lifecycle
            .lock()
            .expect("lifecycle")
            .complete_application_request(first)
            .contains("cancelled")
    );
    let after_cancel = application_request(
        &lifecycle,
        "main",
        "tauri://localhost",
        generation,
        &nonce('a'),
        &String::from_utf8(request_for(generation, 2)).expect("request"),
    );
    assert!(!after_cancel.acknowledged);

    let (lifecycle, first_generation) = start();
    assert!(
        application_request(
            &lifecycle,
            "main",
            "tauri://localhost",
            first_generation,
            &nonce('a'),
            &String::from_utf8(request_for(first_generation, 1)).expect("request"),
        )
        .encoded
        .contains("healthy")
    );
    let second_generation = lifecycle
        .lock()
        .expect("lifecycle")
        .begin_renderer_session(nonce('b'))
        .expect("second generation");
    let after_replacement = application_request(
        &lifecycle,
        "main",
        "tauri://localhost",
        second_generation,
        &nonce('b'),
        &String::from_utf8(request_for(second_generation, 2)).expect("request"),
    );
    assert!(!after_replacement.acknowledged);
}

fn cancel(generation: u64, sequence: u64) -> String {
    let request_id = canonical_request_id(generation, sequence).expect("canonical request ID");
    format!(r#"{{"schemaVersion":1,"requestId":"{request_id}"}}"#)
}

fn nonce(value: char) -> String {
    value.to_string().repeat(64)
}

#[test]
fn bundled_navigation_policy_is_exact() {
    let tauri_root = tauri::Url::parse("tauri://localhost/index.html").expect("tauri URL");
    let http_root = tauri::Url::parse("http://tauri.localhost/").expect("http URL");
    assert_eq!(canonical_origin(Some(&tauri_root)), "tauri://localhost");
    assert_eq!(canonical_origin(Some(&http_root)), "http://tauri.localhost");
    assert!(is_bundled_navigation(&tauri_root));
    assert!(is_bundled_navigation(&http_root));
    for denied in [
        "https://tauri.localhost/",
        concat!("tauri://", "user@", "localhost/index.html"),
        "tauri://localhost:4040/index.html",
        concat!("http://", "user@", "tauri.localhost/"),
        "http://tauri.localhost:4040/",
        "tauri://localhost/other",
        "tauri://localhost/index.html?debug=true",
        "tauri://localhost/index.html#fragment",
    ] {
        let url = tauri::Url::parse(denied).expect("denied URL");
        let hostile_authority =
            denied.starts_with("https:") || denied.contains("user@") || denied.contains(":4040");
        assert_eq!(canonical_origin(Some(&url)).is_empty(), hostile_authority);
        assert!(!is_bundled_navigation(&url));
    }
    assert!(canonical_origin(None).is_empty());
    let password_without_user =
        tauri::Url::parse("tauri://:secret@localhost/").expect("password URL");
    assert!(password_without_user.username().is_empty());
    assert!(password_without_user.password().is_some());
    assert!(canonical_origin(Some(&password_without_user)).is_empty());
}

#[test]
fn command_wrapper_rejects_non_exact_authorities() {
    for origin in [
        concat!("tauri://", "user@", "localhost"),
        "tauri://localhost:4040",
        concat!("http://", "user@", "tauri.localhost"),
        "http://tauri.localhost:4040",
    ] {
        let lifecycle = Mutex::new(HostLifecycle::default());
        lifecycle
            .lock()
            .expect("lifecycle")
            .begin_renderer_session(nonce('a'));
        assert!(
            application_request(
                &lifecycle,
                "main",
                origin,
                1,
                &nonce('a'),
                &String::from_utf8(request(1, "request-00000001")).expect("request"),
            )
            .encoded
            .contains("unauthenticated-origin")
        );
    }
}

#[test]
fn runtime_workspace_poison_fails_closed_instead_of_dropping_isolation() {
    let healthy = Mutex::new(WorkspaceHost::default());
    assert_eq!(tauri_adapter::runtime_isolation_root(&healthy), Ok(None));

    let poisoned = Mutex::new(WorkspaceHost::default());
    let _ = std::panic::catch_unwind(|| {
        let _guard = poisoned.lock().expect("workspace lock before poisoning");
        panic!("poison workspace");
    });
    assert_eq!(
        tauri_adapter::runtime_isolation_root(&poisoned),
        Err(ReasonCode::InternalFailure)
    );
}

#[test]
fn tauri_host_commands_cover_success_cancellation_and_poisoning() {
    let lifecycle = Mutex::new(HostLifecycle::default());
    lifecycle
        .lock()
        .expect("lifecycle")
        .begin_renderer_session(nonce('a'));
    let first = application_request(
        &lifecycle,
        "main",
        "tauri://localhost",
        1,
        &nonce('a'),
        &String::from_utf8(request(1, "request-00000001")).expect("request"),
    );
    assert!(!first.acknowledged);
    assert!(first.encoded.contains("healthy"));
    let second = application_request(
        &lifecycle,
        "main",
        "tauri://localhost",
        1,
        &nonce('a'),
        &String::from_utf8(request(2, "request-00000002")).expect("request"),
    );
    assert!(second.acknowledged);
    assert!(
        application_request(
            &lifecycle,
            "other",
            "tauri://localhost",
            1,
            &nonce('a'),
            "{}",
        )
        .encoded
        .contains("unauthenticated-sender")
    );

    let mut started = HostLifecycle::default();
    started.begin_renderer_session(nonce('a'));
    let lifecycle = Mutex::new(started);
    let sender = lifecycle.lock().expect("lifecycle").sender_for_document(
        "main",
        "tauri://localhost",
        1,
        &nonce('a'),
    );
    let accepted = lifecycle
        .lock()
        .expect("lifecycle")
        .begin_application_request(&sender, &request(1, "request-00000003"))
        .expect("in flight");
    assert!(
        application_cancel(
            &lifecycle,
            "main",
            "tauri://localhost",
            1,
            &nonce('a'),
            &cancel(1, 1),
        )
        .encoded
        .contains("cancelled")
    );
    assert!(
        lifecycle
            .lock()
            .expect("lifecycle")
            .complete_application_request(accepted)
            .contains("cancelled")
    );

    let poisoned = Mutex::new(HostLifecycle::default());
    let _ = std::panic::catch_unwind(|| {
        let _guard = poisoned.lock().expect("lock before poisoning");
        panic!("poison lifecycle");
    });
    assert!(
        application_request(&poisoned, "main", "tauri://localhost", 0, &nonce('a'), "{}",)
            .encoded
            .contains("internal-failure")
    );
    assert!(
        application_cancel(&poisoned, "main", "tauri://localhost", 0, &nonce('a'), "{}",)
            .encoded
            .contains("internal-failure")
    );
}

#[test]
fn stale_queued_wrapper_request_and_cancel_keep_document_generation() {
    let mut lifecycle = HostLifecycle::default();
    let old_nonce = nonce('a');
    let old_generation = lifecycle
        .begin_renderer_session(old_nonce.clone())
        .expect("valid nonce");
    let old_sender =
        lifecycle.sender_for_document("main", "tauri://localhost", old_generation, &old_nonce);
    let accepted = lifecycle
        .begin_application_request(&old_sender, &request(1, "request-00000001"))
        .expect("old in-flight request");
    let current_generation = lifecycle
        .begin_renderer_session(nonce('b'))
        .expect("valid nonce");
    let lifecycle = Mutex::new(lifecycle);

    assert!(
        application_request(
            &lifecycle,
            "main",
            "tauri://localhost",
            old_generation,
            &old_nonce,
            &String::from_utf8(request(2, "request-00000002")).expect("request"),
        )
        .encoded
        .contains("unauthorized")
    );
    assert!(
        application_cancel(
            &lifecycle,
            "main",
            "tauri://localhost",
            old_generation,
            &old_nonce,
            &cancel(old_generation, 1),
        )
        .encoded
        .contains("unauthorized")
    );
    assert_eq!(
        lifecycle
            .lock()
            .expect("lifecycle")
            .current_document_authority()
            .map(|(generation, _)| generation),
        Some(current_generation),
    );
    assert!(
        lifecycle
            .lock()
            .expect("lifecycle")
            .complete_application_request(accepted)
            .contains("cancelled")
    );
}

#[test]
fn request_adapter_carries_literal_host_acceptance_without_resampling() {
    let mut lifecycle = HostLifecycle::default();
    let generation = lifecycle
        .begin_renderer_session(nonce('a'))
        .expect("renderer generation");
    let sender =
        lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce('a'));
    let _accepted = lifecycle
        .begin_application_request(&sender, &request_for(generation, 1))
        .expect("in flight");
    let lifecycle = Mutex::new(lifecycle);
    let literal_host_acceptance = Instant::now();
    let output = application_cancel(
        &lifecycle,
        "main",
        "tauri://localhost",
        generation,
        &nonce('a'),
        &cancel(generation, 1),
    );
    assert!(output.encoded.contains("cancelled"));
    let accepted = output.accepted.expect("typed Host acceptance");

    let runtime = RuntimeHost::unavailable_for_test();
    runtime.accept_request_cancellation(
        output
            .cancelled_request_id
            .as_deref()
            .expect("accepted cancel"),
        accepted,
    );
    let window = runtime
        .cancellation_window_for_test()
        .expect("pending runtime cancellation");
    assert_eq!(
        window.terminal_cutoff,
        accepted.accepted_at + Duration::from_secs(5),
        "the adapter must forward Host acceptance, not authorize a later timestamp"
    );
    assert_eq!(window.host_acceptance, Some(accepted));
    assert!(accepted.accepted_at >= literal_host_acceptance);
}
