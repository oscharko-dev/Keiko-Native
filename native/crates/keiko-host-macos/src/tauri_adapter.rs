use std::sync::Mutex;

use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, RunEvent, Runtime, State, Webview, WebviewWindow, Window};

use crate::document_nonce::secure_document_nonce;
use crate::{
    HostLifecycle, application_cancel as dispatch_cancel, application_request as dispatch_request,
    canonical_origin, is_bundled_navigation,
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

pub fn page_load_transition<F>(
    lifecycle: &Mutex<HostLifecycle>,
    window_label: &str,
    url: &tauri::Url,
    event: PageLoadEvent,
    nonce_producer: F,
) -> (PageLoadDecision, Option<bool>, Option<String>)
where
    F: FnOnce() -> Option<String>,
{
    let decision = page_load_decision(window_label, url, event);
    match decision {
        PageLoadDecision::BeginDocument => {
            let started = lifecycle.lock().is_ok_and(|mut lifecycle| {
                lifecycle.begin_renderer_page_load(|_| nonce_producer())
            });
            (decision, Some(started), None)
        }
        PageLoadDecision::InstallAuthority => {
            let script = lifecycle
                .lock()
                .ok()
                .and_then(|mut lifecycle| lifecycle.finish_renderer_page_load())
                .and_then(|(generation, nonce)| document_authority_script(generation, &nonce));
            (decision, None, script)
        }
        PageLoadDecision::Ignore => (decision, None, None),
    }
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
    let lifecycle = webview.state::<Mutex<HostLifecycle>>();
    let (decision, started, install_script) = page_load_transition(
        lifecycle.inner(),
        webview.label(),
        payload.url(),
        payload.event(),
        secure_document_nonce,
    );
    match decision {
        PageLoadDecision::BeginDocument => {
            if started != Some(true) {
                eprintln!("keiko-renderer-authority-generation-failed");
            }
        }
        PageLoadDecision::InstallAuthority => {
            let installed = install_script.is_some_and(|script| webview.eval(&script).is_ok());
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
#[path = "tauri_adapter_tests.rs"]
mod tests;
