use super::*;
use crate::activate_renderer_document;

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
fn page_load_and_script_policy_are_exact() {
    let _navigation = navigation_policy::<tauri::Wry>();
    let root = tauri::Url::parse("tauri://localhost/index.html").expect("URL");
    let hostile = tauri::Url::parse("https://example.invalid/").expect("URL");
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
    assert!(!activate_document(&lifecycle, None));
    assert!(activate_document(&lifecycle, Some(nonce('a'))));
    assert!(
        lifecycle
            .lock()
            .expect("lifecycle")
            .current_document_authority()
            .is_some()
    );
    install_result(&lifecycle, false);
    assert!(
        lifecycle
            .lock()
            .expect("lifecycle")
            .current_document_authority()
            .is_none()
    );
    assert!(activate_document(&lifecycle, Some(nonce('b'))));
    install_result(&lifecycle, true);
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
}
#[test]
fn failed_document_start_clears_finished_install_and_old_work() {
    let lifecycle = Mutex::new(HostLifecycle::default());
    let root = tauri::Url::parse("tauri://localhost/index.html").expect("URL");
    for (index, replacement) in [None, Some("malformed".to_owned())].into_iter().enumerate() {
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
                            r#"{{"schemaVersion":1,"requestId":"request-0000000{}","sequence":1,"timeoutMs":1000,"operation":{{"kind":"application-health"}}}}"#,
                            index + 1
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
