use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, RunEvent, Runtime, State, Webview, WebviewWindow, Window};

use crate::document_nonce::secure_document_nonce;
use crate::runtime::{
    HostCancellationMutation, RuntimeReadinessWorkspace, TerminalPublicationOutcome,
    UnmatchedHostCancellationPolicy,
    runtime_request_with_workspace_authority as dispatch_runtime_request,
};
use crate::{
    FolderPickerResult, FoundationHost, HostCancellationRecord, HostLifecycle, RuntimeHost,
    SenderContext, WorkspaceHost, application_cancel as dispatch_cancel,
    application_request as dispatch_request, canonical_origin,
    foundation_request as dispatch_foundation_request, is_bundled_navigation,
    workspace_request as dispatch_workspace_request,
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

#[cfg(test)]
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

pub(crate) fn page_load_transition_with_runtime<F>(
    lifecycle: &Mutex<HostLifecycle>,
    runtime: &RuntimeHost,
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
        PageLoadDecision::BeginDocument => runtime.handoff_host_cancellation(
            UnmatchedHostCancellationPolicy::CloseContainment,
            || {
                lifecycle.lock().map_or_else(
                    |_| HostCancellationMutation::ControlFailed(None),
                    |mut lifecycle| {
                        let records = lifecycle.prepare_renderer_page_load_replacement();
                        HostCancellationMutation::Completed(Some(lifecycle), records)
                    },
                )
            },
            |lifecycle| {
                let started = lifecycle.is_some_and(|mut lifecycle| {
                    lifecycle.start_renderer_page_load(|_| nonce_producer())
                });
                (decision, Some(started), None)
            },
        ),
        PageLoadDecision::InstallAuthority => runtime.handoff_host_cancellation(
            UnmatchedHostCancellationPolicy::CloseContainment,
            || {
                lifecycle.lock().map_or_else(
                    |_| HostCancellationMutation::ControlFailed(None),
                    |mut lifecycle| {
                        let (authority, records) =
                            lifecycle.finish_renderer_page_load_with_cancellations();
                        HostCancellationMutation::Completed(authority, records)
                    },
                )
            },
            |authority| {
                let script = authority
                    .and_then(|(generation, nonce)| document_authority_script(generation, &nonce));
                (decision, None, script)
            },
        ),
        PageLoadDecision::Ignore => (decision, None, None),
    }
}

pub fn install_result(lifecycle: &Mutex<HostLifecycle>, runtime: &RuntimeHost, succeeded: bool) {
    if succeeded {
        return;
    }
    lose_renderer_and_stop(lifecycle, runtime);
}

pub(crate) fn lose_renderer(lifecycle: &Mutex<HostLifecycle>) -> Vec<HostCancellationRecord> {
    lifecycle
        .lock()
        .map_or_else(|_| Vec::new(), |mut lifecycle| lifecycle.renderer_lost())
}

pub(crate) fn runtime_isolation_root(
    workspace: &Mutex<WorkspaceHost>,
) -> Result<Option<RuntimeReadinessWorkspace>, keiko_ui_port::ReasonCode> {
    let mut workspace = workspace
        .lock()
        .map_err(|_| keiko_ui_port::ReasonCode::InternalFailure)?;
    let view = workspace
        .status()
        .map_err(|_| keiko_ui_port::ReasonCode::InternalFailure)?;
    match view {
        keiko_application::workspace::WorkspaceView::Bound { generation, .. } => workspace
            .bound_root_for_isolation()
            .map(|path| RuntimeReadinessWorkspace::tracked(path, generation))
            .ok_or(keiko_ui_port::ReasonCode::InternalFailure)
            .map(Some),
        _ => Ok(None),
    }
}

pub(crate) fn shut_down(lifecycle: &Mutex<HostLifecycle>) -> Vec<HostCancellationRecord> {
    lifecycle
        .lock()
        .map_or_else(|_| Vec::new(), |mut lifecycle| lifecycle.shutdown())
}

pub(crate) fn lose_renderer_and_stop(lifecycle: &Mutex<HostLifecycle>, runtime: &RuntimeHost) {
    runtime.handoff_host_cancellation(
        UnmatchedHostCancellationPolicy::CloseContainment,
        || {
            let records = lose_renderer(lifecycle);
            HostCancellationMutation::Completed((), records)
        },
        |()| (),
    );
}

pub(crate) fn shut_down_and_stop(lifecycle: &Mutex<HostLifecycle>, runtime: &RuntimeHost) -> bool {
    runtime.handoff_host_cancellation(
        UnmatchedHostCancellationPolicy::CloseContainment,
        || {
            let records = shut_down(lifecycle);
            HostCancellationMutation::Completed((), records)
        },
        |()| (),
    );
    runtime.wait_for_accepted_cancellation_cleanup()
}

fn forward_turn_event<E>(
    lifecycle: &Mutex<HostLifecycle>,
    runtime: &RuntimeHost,
    renderer_loss_forwarded: &mut bool,
    view: keiko_application::turn::TurnView,
    send: &mut impl FnMut(keiko_application::turn::TurnView) -> Result<(), E>,
) -> Option<HostCancellationRecord> {
    if send(view).is_ok() {
        return None;
    }
    record_turn_event_failure(lifecycle, runtime, renderer_loss_forwarded)
}

fn record_turn_event_failure(
    lifecycle: &Mutex<HostLifecycle>,
    runtime: &RuntimeHost,
    renderer_loss_forwarded: &mut bool,
) -> Option<HostCancellationRecord> {
    if *renderer_loss_forwarded {
        return None;
    }
    *renderer_loss_forwarded = true;
    let cancellations = lose_renderer(lifecycle);
    let first = cancellations.first().cloned();
    runtime.defer_host_cancellations(&cancellations);
    first
}

fn publish_terminal_turn_event(
    runtime: &RuntimeHost,
    terminal_cutoff: Instant,
    send: impl FnOnce() -> bool + Send + 'static,
    publication_failed: impl FnOnce() + Send + 'static,
) -> bool {
    matches!(
        runtime.publish_terminal_update_until_with_failure(
            terminal_cutoff,
            send,
            publication_failed,
        ),
        TerminalPublicationOutcome::Completed(true) | TerminalPublicationOutcome::Skipped
    )
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
    let output = dispatch_cancel_with_runtime_fence(
        lifecycle.inner(),
        runtime.inner(),
        window.label(),
        &origin,
        generation,
        &document_nonce,
        &request,
    );
    output.encoded
}

pub(crate) fn dispatch_cancel_with_runtime_fence(
    lifecycle: &Mutex<HostLifecycle>,
    runtime: &RuntimeHost,
    window_label: &str,
    origin: &str,
    generation: u64,
    document_nonce: &str,
    request: &str,
) -> crate::ApplicationCancelOutput {
    runtime.handoff_host_cancellation(
        UnmatchedHostCancellationPolicy::Ignore,
        || {
            let output = dispatch_cancel(
                lifecycle,
                window_label,
                origin,
                generation,
                document_nonce,
                request,
            );
            let records = application_cancel_records(&output);
            if output.host_control_failed {
                HostCancellationMutation::ControlFailed(output)
            } else {
                HostCancellationMutation::Completed(output, records)
            }
        },
        |output| output,
    )
}

fn application_cancel_records(
    output: &crate::ApplicationCancelOutput,
) -> Vec<HostCancellationRecord> {
    if !output.runtime_owned {
        return Vec::new();
    }
    output
        .cancelled_request_id
        .clone()
        .zip(output.accepted)
        .map(|(request_id, accepted)| HostCancellationRecord {
            accepted,
            request_id,
        })
        .into_iter()
        .collect()
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
    runtime: State<'_, RuntimeHost>,
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
        Box::new(|workspace_generation| {
            runtime.cancel_for_workspace_change_and_wait(workspace_generation)
        }),
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
        let selected_workspace = match runtime_isolation_root(workspace.inner()) {
            Ok(selected_workspace) => selected_workspace,
            Err(reason) => return keiko_ui_port::encode_error("unknown-request", reason),
        };
        dispatch_runtime_request(
            lifecycle.inner(),
            runtime.inner(),
            &sender,
            selected_workspace.as_ref(),
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

#[tauri::command]
pub async fn codex_turn_request(
    app: AppHandle,
    window: WebviewWindow,
    generation: u64,
    document_nonce: String,
    request: String,
    on_event: Channel<keiko_application::turn::TurnView>,
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
        let mut renderer_loss_forwarded = false;
        crate::turn::turn_request_with_channel(
            lifecycle.inner(),
            workspace.inner(),
            runtime.inner(),
            &sender,
            &request,
            |view, terminal_cutoff| {
                if matches!(
                    view.state,
                    keiko_application::turn::TurnState::Completed
                        | keiko_application::turn::TurnState::Cancelled
                        | keiko_application::turn::TurnState::Failed
                        | keiko_application::turn::TurnState::TimedOut
                        | keiko_application::turn::TurnState::ContainmentFailed
                        | keiko_application::turn::TurnState::CleanupFailed
                ) {
                    let terminal_channel = on_event.clone();
                    let publication_cutoff = terminal_cutoff
                        .unwrap_or_else(|| Instant::now() + Duration::from_millis(100));
                    let failure_app = app.clone();
                    return publish_terminal_turn_event(
                        runtime.inner(),
                        publication_cutoff,
                        move || terminal_channel.send(view).is_ok(),
                        move || {
                            let lifecycle = failure_app.state::<Mutex<HostLifecycle>>();
                            let runtime = failure_app.state::<RuntimeHost>();
                            lose_renderer_and_stop(lifecycle.inner(), runtime.inner());
                        },
                    );
                }
                let mut published = false;
                let _ = forward_turn_event(
                    lifecycle.inner(),
                    runtime.inner(),
                    &mut renderer_loss_forwarded,
                    view,
                    &mut |view| {
                        let result = on_event.send(view);
                        published = result.is_ok();
                        result
                    },
                );
                published
            },
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
    let (decision, started, install_script) = page_load_transition_with_runtime(
        lifecycle.inner(),
        webview.state::<RuntimeHost>().inner(),
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
            install_result(
                lifecycle.inner(),
                webview.state::<RuntimeHost>().inner(),
                installed,
            );
            if !installed {
                eprintln!("keiko-renderer-authority-install-failed");
            }
        }
        PageLoadDecision::Ignore => {}
    }
}

pub fn handle_web_content_process_terminate<R: Runtime>(webview: &Webview<R>) {
    lose_renderer_and_stop(
        webview.state::<Mutex<HostLifecycle>>().inner(),
        webview.state::<RuntimeHost>().inner(),
    );
}

pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &tauri::WindowEvent) {
    if matches!(event, tauri::WindowEvent::Destroyed) {
        lose_renderer_and_stop(
            window.state::<Mutex<HostLifecycle>>().inner(),
            window.state::<RuntimeHost>().inner(),
        );
    }
}

fn cleanup_failure_prevents_exit(cleanup_proven: bool) -> bool {
    !cleanup_proven
}

pub fn handle_run_event<R: Runtime>(handle: &AppHandle<R>, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { api, .. } => {
            if cleanup_failure_prevents_exit(shut_down_and_stop(
                handle.state::<Mutex<HostLifecycle>>().inner(),
                handle.state::<RuntimeHost>().inner(),
            )) {
                api.prevent_exit();
                eprintln!("keiko-native-runtime-shutdown-cleanup-failed");
            }
        }
        RunEvent::Exit => {
            if cleanup_failure_prevents_exit(shut_down_and_stop(
                handle.state::<Mutex<HostLifecycle>>().inner(),
                handle.state::<RuntimeHost>().inner(),
            )) {
                eprintln!("keiko-native-runtime-shutdown-cleanup-failed");
            }
        }
        _ => {}
    }
}

#[cfg(test)]
#[path = "tauri_adapter_tests.rs"]
mod tests;
