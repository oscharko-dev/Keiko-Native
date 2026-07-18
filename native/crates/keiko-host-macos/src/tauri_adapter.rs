use std::sync::Mutex;

use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, RunEvent, Runtime, State, Webview, WebviewWindow, Window};

use crate::document_nonce::secure_document_nonce;
use crate::{
    HostLifecycle, activate_renderer_document, application_cancel as dispatch_cancel,
    application_request as dispatch_request, canonical_origin, is_bundled_navigation,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PageLoadDecision {
    BeginDocument,
    InstallAuthority,
    Ignore,
}

pub fn page_load_decision(
    window_label: &str,
    url: &tauri::Url,
    event: PageLoadEvent,
) -> PageLoadDecision {
    if window_label != "main" || !is_bundled_navigation(url) {
        return PageLoadDecision::Ignore;
    }
    match event {
        PageLoadEvent::Started => PageLoadDecision::BeginDocument,
        PageLoadEvent::Finished => PageLoadDecision::InstallAuthority,
    }
}

pub fn document_authority_script(generation: u64, document_nonce: &str) -> Option<String> {
    if document_nonce.len() != 64
        || !document_nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    Some(format!(
        "Object.defineProperty(window,'__KEIKO_RENDERER_AUTHORITY',{{value:Object.freeze({{generation:{generation},documentNonce:'{document_nonce}'}}),configurable:false,writable:false}});window.dispatchEvent(new CustomEvent('keiko-renderer-authority',{{detail:window.__KEIKO_RENDERER_AUTHORITY}}));"
    ))
}

pub fn begin_document(lifecycle: &Mutex<HostLifecycle>, nonce: Option<String>) -> bool {
    lifecycle
        .lock()
        .is_ok_and(|mut lifecycle| activate_renderer_document(&mut lifecycle, nonce))
}

pub fn authority_install_script(lifecycle: &Mutex<HostLifecycle>) -> Option<String> {
    lifecycle
        .lock()
        .ok()
        .and_then(|lifecycle| lifecycle.current_document_authority())
        .and_then(|(generation, nonce)| document_authority_script(generation, &nonce))
}

pub fn install_result(lifecycle: &Mutex<HostLifecycle>, succeeded: bool) {
    if succeeded {
        return;
    }
    if let Ok(mut lifecycle) = lifecycle.lock() {
        lifecycle.renderer_lost();
    }
}

pub fn lose_renderer(lifecycle: &Mutex<HostLifecycle>) {
    if let Ok(mut lifecycle) = lifecycle.lock() {
        lifecycle.renderer_lost();
    }
}

pub fn shut_down(lifecycle: &Mutex<HostLifecycle>) {
    if let Ok(mut lifecycle) = lifecycle.lock() {
        lifecycle.shutdown();
    }
}

#[tauri::command]
pub fn application_request(
    window: WebviewWindow,
    lifecycle: State<'_, Mutex<HostLifecycle>>,
    generation: u64,
    document_nonce: String,
    request: String,
) -> String {
    let origin = canonical_origin(window.url().ok().as_ref());
    let output = dispatch_request(
        lifecycle.inner(),
        window.label(),
        &origin,
        generation,
        &document_nonce,
        &request,
    );
    if output.acknowledged {
        eprintln!("keiko-native-health-ack/v1 sequence=2");
    }
    output.encoded
}

#[tauri::command]
pub fn application_cancel(
    window: WebviewWindow,
    lifecycle: State<'_, Mutex<HostLifecycle>>,
    generation: u64,
    document_nonce: String,
    request: String,
) -> String {
    let origin = canonical_origin(window.url().ok().as_ref());
    dispatch_cancel(
        lifecycle.inner(),
        window.label(),
        &origin,
        generation,
        &document_nonce,
        &request,
    )
}

pub fn navigation_policy<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("keiko-navigation")
        .on_navigation(|webview, url| webview.label() == "main" && is_bundled_navigation(url))
        .build()
}

pub fn handle_page_load<R: Runtime>(webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
    match page_load_decision(webview.label(), payload.url(), payload.event()) {
        PageLoadDecision::BeginDocument => {
            if !begin_document(
                webview.state::<Mutex<HostLifecycle>>().inner(),
                secure_document_nonce(),
            ) {
                eprintln!("keiko-renderer-authority-generation-failed");
            }
        }
        PageLoadDecision::InstallAuthority => {
            let lifecycle = webview.state::<Mutex<HostLifecycle>>();
            let installed = authority_install_script(lifecycle.inner())
                .is_some_and(|script| webview.eval(&script).is_ok());
            install_result(lifecycle.inner(), installed);
            if !installed {
                eprintln!("keiko-renderer-authority-install-failed");
            }
        }
        PageLoadDecision::Ignore => {}
    }
}

pub fn handle_web_content_process_terminate<R: Runtime>(webview: &Webview<R>) {
    lose_renderer(webview.state::<Mutex<HostLifecycle>>().inner());
}

pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &tauri::WindowEvent) {
    if matches!(event, tauri::WindowEvent::Destroyed) {
        lose_renderer(window.state::<Mutex<HostLifecycle>>().inner());
    }
}

pub fn handle_run_event<R: Runtime>(handle: &AppHandle<R>, event: RunEvent) {
    if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
        shut_down(handle.state::<Mutex<HostLifecycle>>().inner());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nonce(value: char) -> String {
        value.to_string().repeat(64)
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
    }

    #[test]
    fn document_start_install_loss_and_shutdown_fail_closed() {
        let lifecycle = Mutex::new(HostLifecycle::default());
        assert!(!begin_document(&lifecycle, None));
        assert!(begin_document(&lifecycle, Some(nonce('a'))));
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
        assert!(begin_document(&lifecycle, Some(nonce('b'))));
        install_result(&lifecycle, true);
        lose_renderer(&lifecycle);
        assert!(
            lifecycle
                .lock()
                .expect("lifecycle")
                .current_document_authority()
                .is_none()
        );
        assert!(begin_document(&lifecycle, Some(nonce('c'))));
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
        for (index, replacement) in [None, Some("malformed".to_owned())].into_iter().enumerate() {
            assert!(begin_document(&lifecycle, Some(nonce('a'))));
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

            assert!(!begin_document(&lifecycle, replacement));
            assert!(authority_install_script(&lifecycle).is_none());
            assert!(
                lifecycle
                    .lock()
                    .expect("lifecycle")
                    .complete_application_request(accepted)
                    .contains("cancelled")
            );
        }

        assert!(begin_document(&lifecycle, Some(nonce('c'))));
        let script = authority_install_script(&lifecycle).expect("fresh install script");
        assert!(script.contains("generation:3"));
        assert!(script.contains(&nonce('c')));
    }
}
