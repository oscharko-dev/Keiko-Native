use std::sync::Mutex;

use keiko_host_macos::tauri_adapter::{
    handle_page_load, handle_run_event, handle_web_content_process_terminate, handle_window_event,
    navigation_policy,
};
use keiko_host_macos::{FoundationHost, HostLifecycle};
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(HostLifecycle::default()))
        .setup(|app| {
            app.manage(Mutex::new(FoundationHost::new(
                app.path()
                    .app_data_dir()
                    .expect("Keiko Native app-support path unavailable")
                    .join("foundation-state.json"),
            )));
            Ok(())
        })
        .plugin(navigation_policy())
        .invoke_handler(tauri::generate_handler![
            keiko_host_macos::tauri_adapter::application_request,
            keiko_host_macos::tauri_adapter::application_cancel,
            keiko_host_macos::tauri_adapter::foundation_request
        ])
        .on_page_load(handle_page_load)
        .on_web_content_process_terminate(handle_web_content_process_terminate)
        .on_window_event(handle_window_event)
        .build(tauri::generate_context!())
        .expect("Keiko Native host lifecycle failed")
        .run(handle_run_event);
}
