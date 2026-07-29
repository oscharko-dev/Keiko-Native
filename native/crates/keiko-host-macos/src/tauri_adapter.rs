use std::sync::Mutex;

use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, RunEvent, Runtime, State, Webview, WebviewWindow, Window};

use crate::document_nonce::secure_document_nonce;
use crate::{
    FolderPickerResult, FoundationHost, HostLifecycle, RuntimeHost, SenderContext, WorkspaceHost,
    application_cancel as dispatch_cancel, application_request as dispatch_request,
    canonical_origin, foundation_request as dispatch_foundation_request, is_bundled_navigation,
    runtime_request as dispatch_runtime_request, workspace_request as dispatch_workspace_request,
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

pub fn stop_runtime(runtime: &RuntimeHost) {
    runtime.cancel_all();
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
    runtime: State<'_, RuntimeHost>,
    generation: u64,
    document_nonce: String,
    request: String,
) -> String {
    let origin = canonical_origin(window.url().ok().as_ref());
    let encoded = dispatch_cancel(
        lifecycle.inner(),
        window.label(),
        &origin,
        generation,
        &document_nonce,
        &request,
    );
    if encoded.contains(r#""status":"cancelled""#)
        && let Ok(cancel) = keiko_ui_port::parse_cancel(request.as_bytes())
    {
        runtime.cancel_request(keiko_ui_port::cancel_request_id(&cancel));
    }
    encoded
}

#[tauri::command]
pub fn foundation_request(
    app: AppHandle,
    window: WebviewWindow,
    lifecycle: State<'_, Mutex<HostLifecycle>>,
    foundation: State<'_, Mutex<FoundationHost>>,
    generation: u64,
    document_nonce: String,
    request: String,
) -> String {
    let origin = canonical_origin(window.url().ok().as_ref());
    let sender = SenderContext {
        window_label: window.label().to_owned(),
        origin,
        generation,
        document_nonce,
    };
    let output = dispatch_foundation_request(
        lifecycle.inner(),
        foundation.inner(),
        &sender,
        &request,
        platform_open,
    );
    if output.quit {
        app.exit(0);
    }
    output.encoded
}

#[tauri::command]
pub fn workspace_request(
    window: WebviewWindow,
    lifecycle: State<'_, Mutex<HostLifecycle>>,
    workspace: State<'_, Mutex<WorkspaceHost>>,
    generation: u64,
    document_nonce: String,
    request: String,
) -> String {
    let origin = canonical_origin(window.url().ok().as_ref());
    let sender = SenderContext {
        window_label: window.label().to_owned(),
        origin,
        generation,
        document_nonce,
    };
    let output = dispatch_workspace_request(
        lifecycle.inner(),
        workspace.inner(),
        &sender,
        &request,
        Box::new(platform_select_workspace),
    );
    if output.acknowledged_status {
        eprintln!("keiko-native-workspace-ack/v1 state=available");
    }
    output.encoded
}

#[tauri::command]
pub async fn runtime_request(
    app: AppHandle,
    window: WebviewWindow,
    generation: u64,
    document_nonce: String,
    request: String,
) -> String {
    let sender = SenderContext {
        window_label: window.label().to_owned(),
        origin: canonical_origin(window.url().ok().as_ref()),
        generation,
        document_nonce,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<Mutex<HostLifecycle>>();
        let runtime = app.state::<RuntimeHost>();
        let workspace = app.state::<Mutex<WorkspaceHost>>();
        let selected_workspace = workspace
            .lock()
            .ok()
            .and_then(|workspace| workspace.bound_root_for_isolation());
        dispatch_runtime_request(
            lifecycle.inner(),
            runtime.inner(),
            &sender,
            selected_workspace.as_deref(),
            &request,
        )
        .encoded
    })
    .await
    .unwrap_or_else(|_| {
        keiko_ui_port::encode_error(
            "unknown-request",
            keiko_ui_port::ReasonCode::InternalFailure,
        )
    })
}

fn platform_select_workspace() -> FolderPickerResult {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSModalResponseCancel, NSModalResponseOK, NSOpenPanel};
        #[allow(deprecated)]
        use objc2_foundation::MainThreadMarker;
        use objc2_foundation::NSString;

        let Some(main_thread) = MainThreadMarker::new() else {
            return FolderPickerResult::Unavailable;
        };
        let panel = NSOpenPanel::openPanel(main_thread);
        panel.setCanChooseDirectories(true);
        panel.setCanChooseFiles(false);
        panel.setAllowsMultipleSelection(false);
        panel.setResolvesAliases(false);
        panel.setTitle(Some(&NSString::from_str(
            "Lokales Git-Repository auswählen",
        )));
        panel.setPrompt(Some(&NSString::from_str("Repository auswählen")));
        panel.setMessage(Some(&NSString::from_str(
            "Keiko bindet dieses Repository nur für die aktuelle Sitzung.",
        )));
        match panel.runModal() {
            response if response == NSModalResponseOK => panel
                .URL()
                .and_then(|url| url.path())
                .map(|path| FolderPickerResult::Selected(path.to_string().into()))
                .unwrap_or(FolderPickerResult::Unavailable),
            response if response == NSModalResponseCancel => FolderPickerResult::Cancelled,
            _ => FolderPickerResult::Unavailable,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        FolderPickerResult::Unavailable
    }
}

fn platform_open(url: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::{NSString, NSURL};

        NSURL::URLWithString(&NSString::from_str(url))
            .is_some_and(|url| NSWorkspace::sharedWorkspace().openURL(&url))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        false
    }
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
            stop_runtime(webview.state::<RuntimeHost>().inner());
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
    stop_runtime(webview.state::<RuntimeHost>().inner());
}

pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &tauri::WindowEvent) {
    if matches!(event, tauri::WindowEvent::Destroyed) {
        lose_renderer(window.state::<Mutex<HostLifecycle>>().inner());
        stop_runtime(window.state::<RuntimeHost>().inner());
    }
}

pub fn handle_run_event<R: Runtime>(handle: &AppHandle<R>, event: RunEvent) {
    if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
        shut_down(handle.state::<Mutex<HostLifecycle>>().inner());
        stop_runtime(handle.state::<RuntimeHost>().inner());
    }
}

#[cfg(test)]
#[path = "tauri_adapter_tests.rs"]
mod tests;
