use super::*;
use crate::activate_renderer_document;
use crate::request_timing::{AcceptedCancellation, CancellationSource};
use keiko_application::runtime::RuntimeDescriptor;
use keiko_application::turn::{TurnSession, TurnState};
use keiko_ui_port::canonical_request_id;
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

fn nonce(value: char) -> String {
    value.to_string().repeat(64)
}

fn activate_document(lifecycle: &Mutex<HostLifecycle>, value: Option<String>) -> bool {
    lifecycle
        .lock()
        .is_ok_and(|mut lifecycle| activate_renderer_document(&mut lifecycle, |_| value))
}

fn has_authority(lifecycle: &Mutex<HostLifecycle>) -> bool {
    lifecycle
        .lock()
        .is_ok_and(|lifecycle| lifecycle.current_document_authority().is_some())
}

#[test]
fn user_cancel_forwards_only_the_admission_bound_runtime_owner() {
    let lifecycle = Mutex::new(HostLifecycle::default());
    assert!(activate_document(&lifecycle, Some(nonce('8'))));
    let (generation, document_nonce) = lifecycle
        .lock()
        .expect("document authority")
        .current_document_authority()
        .expect("active document");
    let sender = lifecycle.lock().expect("Host sender").sender_for_document(
        "main",
        "tauri://localhost",
        generation,
        &document_nonce,
    );
    for (sequence, kind, expected_records) in
        [(1, "application-health", 0), (2, "runtime-readiness", 1)]
    {
        let request_id = canonical_request_id(generation, sequence).unwrap();
        let request = format!(
            r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":{sequence},"timeoutMs":1000,"operation":{{"kind":"{kind}"}}}}"#,
        );
        lifecycle
            .lock()
            .expect("Host admission")
            .begin_application_request(&sender, request.as_bytes())
            .expect("accepted Host request");
        let cancellation = format!(r#"{{"schemaVersion":1,"requestId":"{request_id}"}}"#);

        let output = dispatch_cancel(
            &lifecycle,
            "main",
            "tauri://localhost",
            generation,
            &document_nonce,
            &cancellation,
        );

        assert!(output.encoded.contains("cancelled"));
        assert_eq!(application_cancel_records(&output).len(), expected_records);
        assert!(
            lifecycle
                .lock()
                .expect("Host terminal authority")
                .in_flight
                .get(&request_id)
                .is_some_and(|request| request.accepted_cancellation.is_some())
        );
    }
}

fn receive_before<T>(receiver: &mpsc::Receiver<T>, deadline: Instant, label: &str) -> T {
    loop {
        match receiver.try_recv() {
            Ok(value) => return value,
            Err(mpsc::TryRecvError::Disconnected) => panic!("{label} disconnected"),
            Err(mpsc::TryRecvError::Empty) => {
                assert!(Instant::now() < deadline, "{label} exceeded its deadline");
                thread::yield_now();
            }
        }
    }
}

fn join_before<T>(handle: thread::JoinHandle<T>, deadline: Instant, label: &str) -> T {
    while !handle.is_finished() {
        assert!(Instant::now() < deadline, "{label} exceeded its deadline");
        thread::yield_now();
    }
    handle.join().unwrap_or_else(|_| panic!("{label} panicked"))
}

#[test]
fn page_load_and_script_policy_are_exact() {
    let _navigation = navigation_policy::<tauri::Wry>();
    let root = tauri::Url::parse("tauri://localhost/index.html").expect("URL");
    let hostile = tauri::Url::parse("data:text/plain,hostile").expect("URL");
    assert_eq!(
        page_load_decision("main", &root, PageLoadEvent::Started),
        PageLoadDecision::BeginDocument
    );
    assert_eq!(
        page_load_decision("main", &root, PageLoadEvent::Finished),
        PageLoadDecision::InstallAuthority
    );
    assert_eq!(
        page_load_decision("other", &root, PageLoadEvent::Started),
        PageLoadDecision::Ignore
    );
    assert_eq!(
        page_load_decision("main", &hostile, PageLoadEvent::Started),
        PageLoadDecision::Ignore
    );
    let script = document_authority_script(7, &nonce('a')).expect("script");
    assert!(script.contains("generation:7"));
    assert!(script.contains(&nonce('a')));
    assert!(script.contains("Object.freeze"));
    assert!(document_authority_script(7, "bad").is_none());

    let lifecycle = Mutex::new(HostLifecycle::default());
    assert!(activate_document(&lifecycle, Some(nonce('a'))));
    for (label, url) in [("other", &root), ("main", &hostile)] {
        assert_eq!(
            page_load_transition(&lifecycle, label, url, PageLoadEvent::Started, || panic!(
                "ignored load must not acquire entropy"
            ),),
            (PageLoadDecision::Ignore, None, None)
        );
        assert!(has_authority(&lifecycle));
    }
}

#[test]
fn document_start_install_loss_and_shutdown_fail_closed() {
    let lifecycle = Mutex::new(HostLifecycle::default());
    let runtime = RuntimeHost::unavailable_for_test();
    assert!(!activate_document(&lifecycle, None));
    assert!(activate_document(&lifecycle, Some(nonce('a'))));
    assert!(
        lifecycle
            .lock()
            .expect("lifecycle")
            .current_document_authority()
            .is_some()
    );
    install_result(&lifecycle, &runtime, false);
    assert!(
        lifecycle
            .lock()
            .expect("lifecycle")
            .current_document_authority()
            .is_none()
    );
    assert!(activate_document(&lifecycle, Some(nonce('b'))));
    install_result(&lifecycle, &runtime, true);
    lose_renderer(&lifecycle);
    assert!(
        lifecycle
            .lock()
            .expect("lifecycle")
            .current_document_authority()
            .is_none()
    );
    assert!(activate_document(&lifecycle, Some(nonce('c'))));
    shut_down(&lifecycle);
    let authority = lifecycle.lock().expect("lifecycle").sender_for_document(
        "main",
        "tauri://localhost",
        3,
        &nonce('c'),
    );
    assert_eq!(
        lifecycle
            .lock()
            .expect("lifecycle")
            .begin_application_request(&authority, b"{}"),
        Err((
            "unknown-request".to_owned(),
            keiko_ui_port::ReasonCode::ShuttingDown
        ))
    );

    for (cleanup_proven, prevent_exit) in [(true, false), (false, true)] {
        let exit_lifecycle = Mutex::new(HostLifecycle::default());
        assert!(activate_document(&exit_lifecycle, Some(nonce('d'))));
        let exit_authority = exit_lifecycle
            .lock()
            .expect("lifecycle")
            .sender_for_document("main", "tauri://localhost", 1, &nonce('d'));
        let _ = shut_down(&exit_lifecycle);
        assert_eq!(cleanup_failure_prevents_exit(cleanup_proven), prevent_exit);
        assert_eq!(
            exit_lifecycle
                .lock()
                .expect("lifecycle")
                .begin_application_request(&exit_authority, b"{}"),
            Err((
                "unknown-request".to_owned(),
                keiko_ui_port::ReasonCode::ShuttingDown
            ))
        );
    }
}

#[test]
fn tauri_forwarding_preserves_the_literal_host_cancel_window() {
    let mut lifecycle = HostLifecycle::default();
    let generation = lifecycle
        .begin_renderer_session(nonce('a'))
        .expect("renderer generation");
    let sender =
        lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce('a'));
    let request = format!(
        r#"{{"schemaVersion":1,"requestId":"{}","sequence":1,"timeoutMs":1000,"operation":{{"kind":"runtime-readiness"}}}}"#,
        canonical_request_id(generation, 1).expect("request ID")
    );
    let _accepted = lifecycle
        .begin_application_request(&sender, request.as_bytes())
        .expect("in flight");
    let lifecycle = Mutex::new(lifecycle);
    let request_id = canonical_request_id(generation, 1).expect("request ID");
    let runtime = RuntimeHost::unavailable_for_test();
    runtime.set_active_request_for_test(&request_id);
    let rejected = dispatch_cancel_with_runtime_fence(
        &lifecycle,
        &runtime,
        "main",
        "tauri://localhost",
        generation,
        &nonce('a'),
        "{}",
    );
    assert!(rejected.accepted.is_none());
    assert!(
        runtime.cancellation_window_for_test().is_none(),
        "an invalid cancel must not close an unrelated healthy request"
    );
    let literal_host_acceptance = Instant::now();
    let output = dispatch_cancel_with_runtime_fence(
        &lifecycle,
        &runtime,
        "main",
        "tauri://localhost",
        generation,
        &nonce('a'),
        &format!(
            r#"{{"schemaVersion":1,"requestId":"{}"}}"#,
            canonical_request_id(generation, 1).expect("request ID")
        ),
    );
    let accepted = output.accepted.expect("typed Host acceptance");

    assert_eq!(
        runtime
            .cancellation_window_for_test()
            .expect("pending cancellation")
            .terminal_cutoff,
        accepted.accepted_at + Duration::from_secs(5),
        "the Tauri boundary must not replace Host acceptance with its own clock"
    );
    assert_eq!(
        runtime
            .cancellation_window_for_test()
            .expect("pending cancellation")
            .host_acceptance,
        Some(accepted)
    );
    assert!(accepted.accepted_at >= literal_host_acceptance);
}

#[test]
fn literal_host_mutation_waits_for_the_runtime_projection_action_fence() {
    let mut lifecycle = HostLifecycle::default();
    let nonce_value = nonce('f');
    let generation = lifecycle
        .begin_renderer_session(nonce_value.clone())
        .expect("renderer generation");
    let sender =
        lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce_value);
    let request_id = canonical_request_id(generation, 1).expect("request ID");
    lifecycle
        .begin_application_request(
            &sender,
            format!(
                r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":1000,"operation":{{"kind":"application-health"}}}}"#,
            )
            .as_bytes(),
        )
        .expect("in flight");
    let lifecycle = Arc::new(Mutex::new(lifecycle));
    let runtime = RuntimeHost::unavailable_for_test();
    runtime.set_active_request_for_test(&request_id);
    let (fence_owned_sender, fence_owned_receiver) = mpsc::sync_channel(1);
    let (release_fence_sender, release_fence_receiver) = mpsc::sync_channel(1);
    let fenced_runtime = runtime.clone();
    let fence = thread::spawn(move || {
        fenced_runtime.hold_projection_action_fence_for_test(|| {
            fence_owned_sender.send(()).expect("publish owned fence");
            receive_before(
                &release_fence_receiver,
                Instant::now() + Duration::from_secs(1),
                "release owned fence",
            );
        });
    });
    receive_before(
        &fence_owned_receiver,
        Instant::now() + Duration::from_secs(1),
        "action fence owned",
    );

    let (handoff_attempted_sender, handoff_attempted_receiver) = mpsc::sync_channel(1);
    let (mutation_started_sender, mutation_started_receiver) = mpsc::sync_channel(1);
    let cancelling_runtime = runtime.clone();
    let cancelling_lifecycle = Arc::clone(&lifecycle);
    let cancellation = format!(r#"{{"schemaVersion":1,"requestId":"{request_id}"}}"#);
    let cancel = thread::spawn(move || {
        handoff_attempted_sender
            .send(())
            .expect("publish handoff attempt");
        cancelling_runtime.handoff_host_cancellation(
            UnmatchedHostCancellationPolicy::Ignore,
            || {
                mutation_started_sender
                    .send(())
                    .expect("publish literal mutation");
                let output = dispatch_cancel(
                    &cancelling_lifecycle,
                    "main",
                    "tauri://localhost",
                    generation,
                    &nonce_value,
                    &cancellation,
                );
                let records = output
                    .cancelled_request_id
                    .clone()
                    .zip(output.accepted)
                    .map(|(request_id, accepted)| HostCancellationRecord {
                        accepted,
                        request_id,
                    })
                    .into_iter()
                    .collect();
                HostCancellationMutation::Completed(output, records)
            },
            |output| output,
        )
    });
    receive_before(
        &handoff_attempted_receiver,
        Instant::now() + Duration::from_secs(1),
        "handoff attempted",
    );
    assert_eq!(
        mutation_started_receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty),
        "literal Host mutation must wait while the action fence is owned"
    );
    release_fence_sender.send(()).expect("release action fence");
    receive_before(
        &mutation_started_receiver,
        Instant::now() + Duration::from_secs(1),
        "literal Host mutation started",
    );
    let join_deadline = Instant::now() + Duration::from_secs(1);
    join_before(fence, join_deadline, "action fence thread");
    let output = join_before(cancel, join_deadline, "cancellation handoff");
    let accepted = output.accepted.expect("literal Host acceptance");
    assert_eq!(
        runtime
            .cancellation_window_for_test()
            .expect("runtime cancellation")
            .host_acceptance,
        Some(accepted)
    );
}

#[test]
fn deferred_renderer_token_precedes_a_later_external_handoff() {
    let runtime = RuntimeHost::unavailable_for_test();
    let request_id = "request-deferred-renderer";
    runtime.set_active_request_for_test(request_id);
    let first = AcceptedCancellation {
        accepted_at: Instant::now(),
        source: CancellationSource::RendererLost,
    };
    runtime.defer_host_cancellations(&[HostCancellationRecord {
        accepted: first,
        request_id: request_id.to_owned(),
    }]);
    runtime.handoff_host_cancellation(
        UnmatchedHostCancellationPolicy::Ignore,
        || {
            HostCancellationMutation::Completed(
                (),
                vec![HostCancellationRecord {
                    accepted: AcceptedCancellation {
                        accepted_at: first.accepted_at + Duration::from_millis(1),
                        source: CancellationSource::User,
                    },
                    request_id: request_id.to_owned(),
                }],
            )
        },
        |()| (),
    );

    assert_eq!(
        runtime
            .cancellation_window_for_test()
            .expect("first cancellation")
            .host_acceptance,
        Some(first),
        "the acquired handoff fence must materialize an earlier deferred token first"
    );
}

#[test]
fn pending_multiple_host_tokens_are_retained_until_the_exact_request_claims_one() {
    let runtime = RuntimeHost::unavailable_for_test();
    let accepted_at = Instant::now();
    let records = ["request-wrong", "request-exact"].map(|request_id| HostCancellationRecord {
        accepted: AcceptedCancellation {
            accepted_at,
            source: CancellationSource::RendererLost,
        },
        request_id: request_id.to_owned(),
    });
    runtime.handoff_host_cancellation(
        UnmatchedHostCancellationPolicy::Ignore,
        || HostCancellationMutation::Completed((), records.to_vec()),
        |()| (),
    );
    runtime.set_active_request_for_test("request-exact");
    runtime.handoff_host_cancellation(
        UnmatchedHostCancellationPolicy::Ignore,
        || HostCancellationMutation::Completed((), Vec::new()),
        |()| (),
    );

    let cancellation = runtime
        .cancellation_window_for_test()
        .expect("later exact Host cancellation");
    assert_eq!(cancellation.host_acceptance, Some(records[1].accepted));
}

#[test]
fn unmatched_global_renderer_loss_closes_runtime_containment() {
    let lifecycle = Mutex::new(HostLifecycle::default());
    let runtime = RuntimeHost::unavailable_for_test();
    runtime.set_active_request_for_test("runtime-only-request");

    lose_renderer_and_stop(&lifecycle, &runtime);

    let cancellation = runtime
        .cancellation_window_for_test()
        .expect("closed global-loss contradiction");
    assert_eq!(cancellation.host_acceptance, None);
    assert!(
        cancellation.terminal_cutoff <= Instant::now(),
        "an unmatched global loss must not grant a new terminal budget"
    );
}

#[test]
fn application_cancel_control_failure_closes_only_the_active_runtime_containment() {
    for runtime_poisoned in [false, true] {
        for prior_window in [false, true] {
            let poisoned = Mutex::new(HostLifecycle::default());
            let _ = std::panic::catch_unwind(|| {
                let _guard = poisoned.lock().expect("lifecycle before poison");
                panic!("poison lifecycle control");
            });
            let runtime = RuntimeHost::unavailable_for_test();
            let request_id = format!("request-active-host-control-failure-{prior_window}");
            runtime.set_active_request_for_test(&request_id);
            if prior_window {
                runtime.accept_request_cancellation(
                    &request_id,
                    AcceptedCancellation {
                        accepted_at: Instant::now(),
                        source: CancellationSource::User,
                    },
                );
            }
            if runtime_poisoned {
                runtime.poison_control_for_test();
            }

            let detection_started = Instant::now();
            let output = dispatch_cancel_with_runtime_fence(
                &poisoned,
                &runtime,
                "main",
                "tauri://localhost",
                1,
                &nonce('a'),
                &format!(r#"{{"schemaVersion":1,"requestId":"{request_id}"}}"#),
            );
            let detection_observed = Instant::now();

            assert!(output.host_control_failed);
            assert!(output.encoded.contains("internal-failure"));
            let cancellation = runtime
                .cancellation_window_for_test()
                .expect("Host-control failure closes active containment");
            assert_eq!(cancellation.host_acceptance, None);
            assert!(cancellation.accepted_at >= detection_started);
            assert!(cancellation.accepted_at <= detection_observed);
            assert_eq!(cancellation.cleanup_cutoff, cancellation.accepted_at);
            assert_eq!(cancellation.terminal_cutoff, cancellation.accepted_at);
            assert!(cancellation.terminal_cutoff <= detection_observed);
            assert!(!runtime.claim_turn_request_for_host_settlement("request-fresh"));
            runtime.finish_active_request_for_test();
            assert!(runtime.claim_turn_request_for_host_settlement("request-fresh-after-proof"));
            assert!(runtime.cancellation_window_for_test().is_none());
            runtime.finish_active_request_for_test();
        }
    }

    let mut healthy = HostLifecycle::default();
    let generation = healthy
        .begin_renderer_session(nonce('b'))
        .expect("renderer generation");
    let healthy = Mutex::new(healthy);
    let unauthorized_runtime = RuntimeHost::unavailable_for_test();
    unauthorized_runtime.set_active_request_for_test("request-still-active");
    let unauthorized = dispatch_cancel_with_runtime_fence(
        &healthy,
        &unauthorized_runtime,
        "main",
        "tauri://localhost",
        generation,
        &nonce('c'),
        r#"{"schemaVersion":1,"requestId":"request-still-active"}"#,
    );
    assert!(!unauthorized.host_control_failed);
    assert!(unauthorized.encoded.contains("unauthorized"));
    assert!(
        unauthorized_runtime
            .cancellation_window_for_test()
            .is_none(),
        "invalid cancellation keeps the Ignore policy"
    );
}

#[test]
fn renderer_loss_and_shutdown_forward_their_literal_host_tokens() {
    for source in ["page-load", "renderer-loss", "shutdown"] {
        let mut lifecycle = HostLifecycle::default();
        let nonce_value = nonce(match source {
            "page-load" => 'a',
            "renderer-loss" => 'b',
            "shutdown" => 'c',
            _ => unreachable!(),
        });
        let generation = lifecycle
            .begin_renderer_session(nonce_value.clone())
            .expect("renderer generation");
        let sender =
            lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce_value);
        let request = format!(
            r#"{{"schemaVersion":1,"requestId":"{}","sequence":1,"timeoutMs":1000,"operation":{{"kind":"runtime-readiness"}}}}"#,
            canonical_request_id(generation, 1).expect("request ID")
        );
        lifecycle
            .begin_application_request(&sender, request.as_bytes())
            .expect("in flight");
        let request_id = canonical_request_id(generation, 1).expect("request ID");
        let lifecycle = Mutex::new(lifecycle);
        let runtime = RuntimeHost::unavailable_for_test();
        runtime.set_active_request_for_test(&request_id);

        match source {
            "page-load" => {
                let root = tauri::Url::parse("tauri://localhost/index.html").expect("URL");
                assert_eq!(
                    page_load_transition_with_runtime(
                        &lifecycle,
                        &runtime,
                        "main",
                        &root,
                        PageLoadEvent::Started,
                        || Some(nonce('d')),
                    ),
                    (PageLoadDecision::BeginDocument, Some(true), None)
                );
            }
            "renderer-loss" => lose_renderer_and_stop(&lifecycle, &runtime),
            "shutdown" => {
                let _ = shut_down_and_stop(&lifecycle, &runtime);
            }
            _ => unreachable!(),
        }

        let host_acceptance = lifecycle
            .lock()
            .expect("lifecycle")
            .in_flight
            .get(&request_id)
            .and_then(|request| request.accepted_cancellation)
            .expect("Host cancellation token");
        assert_eq!(
            runtime
                .cancellation_window_for_test()
                .expect("runtime cancellation window")
                .host_acceptance,
            Some(host_acceptance),
            "{source} must forward the one literal Host token"
        );
    }
}

#[test]
fn finished_orphan_and_failed_install_use_runtime_before_host_token_handoff() {
    for source in ["finished-orphan", "install-failed"] {
        let mut lifecycle = HostLifecycle::default();
        let nonce_value = nonce(if source == "finished-orphan" {
            '8'
        } else {
            '9'
        });
        let generation = lifecycle
            .begin_renderer_session(nonce_value.clone())
            .expect("renderer generation");
        let sender =
            lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce_value);
        let request_id = canonical_request_id(generation, 1).expect("request ID");
        lifecycle
            .begin_application_request(
                &sender,
                format!(
                    r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":1000,"operation":{{"kind":"runtime-readiness"}}}}"#,
                )
                .as_bytes(),
            )
            .expect("in flight");
        let lifecycle = Mutex::new(lifecycle);
        let runtime = RuntimeHost::unavailable_for_test();
        runtime.set_active_request_for_test(&request_id);

        if source == "finished-orphan" {
            let root = tauri::Url::parse("tauri://localhost/index.html").expect("URL");
            assert_eq!(
                page_load_transition_with_runtime(
                    &lifecycle,
                    &runtime,
                    "main",
                    &root,
                    PageLoadEvent::Finished,
                    || panic!("Finished must not acquire entropy"),
                ),
                (PageLoadDecision::InstallAuthority, None, None)
            );
        } else {
            install_result(&lifecycle, &runtime, false);
        }

        let host_acceptance = lifecycle
            .lock()
            .expect("lifecycle")
            .in_flight
            .get(&request_id)
            .and_then(|request| request.accepted_cancellation)
            .expect("Host renderer-loss token");
        assert_eq!(
            runtime
                .cancellation_window_for_test()
                .expect("runtime cancellation")
                .host_acceptance,
            Some(host_acceptance),
            "{source} must preserve the literal Host token"
        );
    }
}

#[test]
fn failed_final_channel_send_defers_renderer_loss_without_host_reentry_deadlock() {
    let mut lifecycle = HostLifecycle::default();
    let nonce_value = nonce('7');
    let generation = lifecycle
        .begin_renderer_session(nonce_value.clone())
        .expect("renderer generation");
    let sender =
        lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce_value);
    let request_id = canonical_request_id(generation, 1).expect("request ID");
    let accepted_request = lifecycle
        .begin_application_request(
            &sender,
            format!(
                r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":5000,"operation":{{"kind":"codex-turn-start","workspaceGeneration":1,"task":"Bounded task."}}}}"#,
            )
            .as_bytes(),
        )
        .expect("in flight");
    let lifecycle = Arc::new(Mutex::new(lifecycle));
    let runtime = RuntimeHost::unavailable_for_test();
    runtime.set_active_request_for_test(&request_id);
    let mut session = TurnSession::new(
        generation,
        1,
        1,
        "Bounded task.".to_owned(),
        RuntimeDescriptor::approved(),
    )
    .expect("turn session");
    session.mark_streaming().expect("streaming");
    session.append_agent_delta("answer").expect("answer");
    session.complete().expect("complete");
    session.settle_cleanup(true).expect("cleanup");
    let (publication_started, publication_entered) = mpsc::sync_channel(1);
    let (release_publication, publication_release) = mpsc::sync_channel(1);
    let mut publication_release = Some(publication_release);
    let output = crate::turn::finish_turn_with_runtime(
        &lifecycle,
        &runtime,
        &request_id,
        accepted_request,
        session.view(),
        &mut |commit| {
            let Ok(publication) = commit() else {
                return false;
            };
            let publication_started = publication_started.clone();
            let publication_release = publication_release
                .take()
                .expect("single terminal publication");
            let failure_lifecycle = Arc::clone(&lifecycle);
            let failure_runtime = runtime.clone();
            publish_terminal_turn_event(
                &runtime,
                publication
                    .terminal_cutoff
                    .unwrap_or_else(|| Instant::now() + Duration::from_secs(1)),
                move || {
                    publication_started.send(()).expect("publication entered");
                    publication_release
                        .recv_timeout(Duration::from_secs(1))
                        .expect("publication released");
                    false
                },
                move || lose_renderer_and_stop(&failure_lifecycle, &failure_runtime),
            )
        },
    );

    publication_entered
        .recv_timeout(Duration::from_secs(1))
        .expect("publication worker entered callback");
    assert!(!runtime.claim_turn_request_for_host_settlement("publication-disposition-pending"));
    release_publication.send(()).expect("release publication");
    let renderer_loss_deadline = Instant::now() + Duration::from_secs(1);
    while lifecycle
        .lock()
        .is_ok_and(|lifecycle| lifecycle.current_document_authority().is_some())
    {
        assert!(
            Instant::now() < renderer_loss_deadline,
            "late publication failure did not close renderer authority"
        );
        thread::yield_now();
    }
    assert!(output.encoded.contains(r#""state":"cleanup-failed""#));
    assert_eq!(session.view().state, TurnState::Completed);
}

#[test]
fn host_cutoff_controls_tauri_publication_when_runtime_acceptance_is_unavailable() {
    for runtime_state in ["absent", "different", "poisoned"] {
        for elapsed_ms in [4_999_u64, 5_000, 5_001] {
            let mut lifecycle = HostLifecycle::default();
            lifecycle.set_test_now_ms(0);
            let generation = lifecycle
                .begin_renderer_session(nonce('a'))
                .expect("renderer generation");
            let sender =
                lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce('a'));
            let request_id = canonical_request_id(generation, 1).expect("request ID");
            let accepted_request = lifecycle
                .begin_application_request(
                    &sender,
                    format!(
                        r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":120000,"operation":{{"kind":"codex-turn-start","workspaceGeneration":1,"task":"Bounded task."}}}}"#
                    )
                    .as_bytes(),
                )
                .expect("accepted turn");
            let cancellation = format!(r#"{{"schemaVersion":1,"requestId":"{request_id}"}}"#);
            let host_acceptance = lifecycle
                .cancel_application_request_with_acceptance(&sender, cancellation.as_bytes())
                .accepted
                .expect("literal Host acceptance");
            lifecycle.set_test_now_ms(elapsed_ms);
            let lifecycle = Arc::new(Mutex::new(lifecycle));
            let runtime = RuntimeHost::unavailable_for_test();
            runtime.set_active_request_for_test(&request_id);
            match runtime_state {
                "absent" => {}
                "different" => runtime.accept_request_cancellation(
                    &request_id,
                    AcceptedCancellation {
                        accepted_at: host_acceptance.accepted_at + Duration::from_millis(1),
                        source: host_acceptance.source,
                    },
                ),
                "poisoned" => runtime.poison_control_for_test(),
                _ => unreachable!(),
            }
            runtime.set_terminal_publication_now_for_test(
                host_acceptance.accepted_at + Duration::from_millis(4_900),
            );
            let (worker_entered, release_worker) =
                runtime.install_terminal_publication_hook_for_test();
            let mut completed = TurnSession::new(
                generation,
                1,
                1,
                "Bounded task.".to_owned(),
                RuntimeDescriptor::approved(),
            )
            .expect("turn session");
            completed.mark_streaming().expect("streaming");
            completed.append_agent_delta("answer").expect("answer");
            completed.complete().expect("complete");
            completed.settle_cleanup(true).expect("cleanup");
            let published = Arc::new(Mutex::new(Vec::new()));
            let published_for_callback = Arc::clone(&published);

            let finishing_lifecycle = Arc::clone(&lifecycle);
            let finishing_runtime = runtime.clone();
            let finishing_request_id = request_id.clone();
            let completed_view = completed.view();
            let (output_sender, output_receiver) = mpsc::sync_channel(1);
            let finishing = thread::spawn(move || {
                let output = crate::turn::finish_turn_with_runtime(
                    &finishing_lifecycle,
                    &finishing_runtime,
                    &finishing_request_id,
                    accepted_request,
                    completed_view,
                    &mut |commit| {
                        let Ok(publication) = commit() else {
                            return false;
                        };
                        let callback_view = publication.view.clone();
                        let publication_cutoff = publication
                            .terminal_cutoff
                            .expect("Host cancellation supplies the exact cutoff");
                        publish_terminal_turn_event(
                            &finishing_runtime,
                            publication_cutoff,
                            {
                                let published = Arc::clone(&published_for_callback);
                                move || {
                                    published
                                        .lock()
                                        .expect("published views")
                                        .push(callback_view);
                                    true
                                }
                            },
                            || {},
                        )
                    },
                );
                output_sender.send(output).expect("publish Tauri output");
            });
            worker_entered
                .recv_timeout(Duration::from_secs(1))
                .expect("publication worker reached the synchronized effect gate");
            runtime.set_terminal_publication_now_for_test(
                host_acceptance.accepted_at + Duration::from_millis(elapsed_ms),
            );
            {
                let (released, wake) = &*release_worker;
                *released.lock().expect("publication release") = true;
                wake.notify_all();
            }
            let output = output_receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("synchronized Tauri publication completed");
            finishing.join().expect("Tauri publication worker");

            let published = published.lock().expect("published views");
            let expected_callback_count = usize::from(elapsed_ms < 5_000);
            assert_eq!(
                published.len(),
                expected_callback_count,
                "runtime={runtime_state}, elapsed={elapsed_ms}ms"
            );
            if let Some(view) = published.first() {
                assert_eq!(view.state, TurnState::ContainmentFailed);
                let response: serde_json::Value =
                    serde_json::from_str(&output.encoded).expect("encoded response");
                assert_eq!(
                    response.pointer("/result/state"),
                    Some(&serde_json::to_value(view).expect("callback view")),
                    "runtime={runtime_state}, elapsed={elapsed_ms}ms"
                );
            }
            assert!(
                output.encoded.contains(r#""state":"containment-failed""#),
                "runtime={runtime_state}, elapsed={elapsed_ms}ms: {}",
                output.encoded
            );
        }
    }
}

#[test]
fn failed_document_start_clears_finished_install_and_old_work() {
    let lifecycle = Mutex::new(HostLifecycle::default());
    let root = tauri::Url::parse("tauri://localhost/index.html").expect("URL");
    for replacement in [None, Some("malformed".to_owned())] {
        assert!(activate_document(&lifecycle, Some(nonce('a'))));
        let accepted = {
            let mut current = lifecycle.lock().expect("lifecycle");
            let (generation, document_nonce) =
                current.current_document_authority().expect("old authority");
            let sender = current.sender_for_document(
                "main",
                "tauri://localhost",
                generation,
                &document_nonce,
            );
            current
                    .begin_application_request(
                        &sender,
                        format!(
                            r#"{{"schemaVersion":1,"requestId":"{}","sequence":1,"timeoutMs":1000,"operation":{{"kind":"application-health"}}}}"#,
                            canonical_request_id(generation, 1).expect("canonical request ID")
                        )
                        .as_bytes(),
                    )
                    .expect("accepted old work")
        };

        assert_eq!(
            page_load_transition(&lifecycle, "main", &root, PageLoadEvent::Started, || {
                replacement
            },),
            (PageLoadDecision::BeginDocument, Some(false), None)
        );
        assert_eq!(
            page_load_transition(
                &lifecycle,
                "main",
                &root,
                PageLoadEvent::Finished,
                || panic!("Finished must not acquire entropy"),
            ),
            (PageLoadDecision::InstallAuthority, None, None)
        );
        assert!(!has_authority(&lifecycle));
        assert!(
            lifecycle
                .lock()
                .expect("lifecycle")
                .complete_application_request(accepted)
                .contains("cancelled")
        );
    }

    assert_eq!(
        page_load_transition(&lifecycle, "main", &root, PageLoadEvent::Started, || {
            Some(nonce('c'))
        }),
        (PageLoadDecision::BeginDocument, Some(true), None)
    );
    let (_, _, script) =
        page_load_transition(&lifecycle, "main", &root, PageLoadEvent::Finished, || {
            panic!("Finished must not acquire entropy")
        });
    let script = script.expect("fresh install script");
    assert!(script.contains("generation:3"));
    assert!(script.contains(&nonce('c')));
}

#[test]
fn overlapping_page_loads_never_install_the_wrong_authority() {
    let lifecycle = Mutex::new(HostLifecycle::default());
    let root = tauri::Url::parse("tauri://localhost/index.html").expect("URL");

    assert_eq!(
        page_load_transition(&lifecycle, "main", &root, PageLoadEvent::Started, || {
            Some(nonce('a'))
        }),
        (PageLoadDecision::BeginDocument, Some(true), None)
    );
    let isolated = page_load_transition(&lifecycle, "main", &root, PageLoadEvent::Finished, || {
        panic!("Finished must not acquire entropy")
    });
    assert!(isolated.2.expect("isolated install").contains(&nonce('a')));
    assert_eq!(
        page_load_transition(
            &lifecycle,
            "main",
            &root,
            PageLoadEvent::Finished,
            || panic!("orphan Finished must not acquire entropy"),
        ),
        (PageLoadDecision::InstallAuthority, None, None)
    );
    assert!(!has_authority(&lifecycle));

    for nonce_value in ['a', 'b'] {
        assert_eq!(
            page_load_transition(&lifecycle, "main", &root, PageLoadEvent::Started, || Some(
                nonce(nonce_value)
            ),),
            (PageLoadDecision::BeginDocument, Some(true), None)
        );
    }
    for _ in 0..2 {
        assert_eq!(
            page_load_transition(
                &lifecycle,
                "main",
                &root,
                PageLoadEvent::Finished,
                || panic!("ambiguous Finished must not acquire entropy"),
            ),
            (PageLoadDecision::InstallAuthority, None, None)
        );
        assert!(!has_authority(&lifecycle));
    }

    assert_eq!(
        page_load_transition(&lifecycle, "main", &root, PageLoadEvent::Started, || {
            Some(nonce('d'))
        }),
        (PageLoadDecision::BeginDocument, Some(true), None)
    );
    assert_eq!(
        page_load_transition(&lifecycle, "main", &root, PageLoadEvent::Started, || None),
        (PageLoadDecision::BeginDocument, Some(false), None)
    );
    for _ in 0..2 {
        assert_eq!(
            page_load_transition(
                &lifecycle,
                "main",
                &root,
                PageLoadEvent::Finished,
                || panic!("ambiguous Finished must not acquire entropy"),
            ),
            (PageLoadDecision::InstallAuthority, None, None)
        );
    }

    assert_eq!(
        page_load_transition(&lifecycle, "main", &root, PageLoadEvent::Started, || {
            Some(nonce('c'))
        }),
        (PageLoadDecision::BeginDocument, Some(true), None)
    );
    let later = page_load_transition(&lifecycle, "main", &root, PageLoadEvent::Finished, || {
        panic!("Finished must not acquire entropy")
    });
    let later = later.2.expect("later isolated install");
    assert!(later.contains("generation:5"));
    assert!(later.contains(&nonce('c')));
}
