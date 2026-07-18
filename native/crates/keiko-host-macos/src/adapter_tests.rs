use super::*;
use std::sync::Mutex;

fn request(sequence: u64, request_id: &str) -> Vec<u8> {
    format!(
        r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":{sequence},"timeoutMs":1000,"operation":{{"kind":"application-health"}}}}"#,
    )
    .into_bytes()
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
        "tauri://user@localhost/index.html",
        "tauri://localhost:4040/index.html",
        "http://user@tauri.localhost/",
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
}

#[test]
fn command_wrapper_rejects_non_exact_authorities() {
    for origin in [
        "tauri://user@localhost",
        "tauri://localhost:4040",
        "http://user@tauri.localhost",
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
            r#"{"schemaVersion":1,"requestId":"request-00000003"}"#,
        )
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
            r#"{"schemaVersion":1,"requestId":"request-00000001"}"#,
        )
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
