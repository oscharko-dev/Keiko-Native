use std::sync::Mutex;

use keiko_host_macos::{
    HostLifecycle, application_cancel as dispatch_application_cancel,
    application_request as dispatch_application_request, canonical_origin, is_bundled_navigation,
};
use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, State, WebviewWindow, WindowEvent};

#[tauri::command]
fn application_request(
    window: WebviewWindow,
    lifecycle: State<'_, Mutex<HostLifecycle>>,
    request: String,
) -> String {
    let url = window.url().ok();
    let origin = canonical_origin(url.as_ref());
    let output = dispatch_application_request(lifecycle.inner(), window.label(), &origin, &request);
    if output.acknowledged {
        eprintln!("keiko-native-health-ack/v1 sequence=2");
    }
    output.encoded
}

#[tauri::command]
fn application_cancel(
    window: WebviewWindow,
    lifecycle: State<'_, Mutex<HostLifecycle>>,
    request: String,
) -> String {
    let url = window.url().ok();
    let origin = canonical_origin(url.as_ref());
    dispatch_application_cancel(lifecycle.inner(), window.label(), &origin, &request)
}

fn navigation_policy<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("keiko-navigation")
        .on_navigation(|webview, url| webview.label() == "main" && is_bundled_navigation(url))
        .build()
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Mutex::new(HostLifecycle::default()))
        .plugin(navigation_policy())
        .invoke_handler(tauri::generate_handler![
            application_request,
            application_cancel
        ])
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && payload.event() == PageLoadEvent::Started
                && is_bundled_navigation(payload.url())
                && let Ok(mut lifecycle) = webview.state::<Mutex<HostLifecycle>>().lock()
            {
                lifecycle.begin_renderer_session();
            }
        })
        .on_web_content_process_terminate(|webview| {
            if let Ok(mut lifecycle) = webview.state::<Mutex<HostLifecycle>>().lock() {
                lifecycle.renderer_lost();
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed)
                && let Ok(mut lifecycle) = window.state::<Mutex<HostLifecycle>>().lock()
            {
                lifecycle.renderer_lost();
            }
        })
        .build(tauri::generate_context!())
        .expect("Keiko Native host lifecycle failed");

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. })
            && let Ok(mut lifecycle) = handle.state::<Mutex<HostLifecycle>>().lock()
        {
            lifecycle.shutdown();
        }
    });
}
