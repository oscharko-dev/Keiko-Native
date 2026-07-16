mod application;
mod boundary;
mod model;

use application::{
    AppState, choose_folder, fixture_start, fixture_stop, renderer_recover, renderer_unavailable,
    run_rejection_probe, shell_snapshot,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(feature = "evaluation-hooks")]
mod evaluation_assets;
#[cfg(feature = "evaluation-hooks")]
mod evaluation_ready;

pub fn run() {
    let app = configured_builder()
        .setup(|app| {
            let window_builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Keiko Host Evaluation")
                    .inner_size(880.0, 680.0)
                    .min_inner_size(620.0, 560.0)
                    .resizable(true)
                    .devtools(false)
                    .on_navigation(allowed_navigation);
            let window = window_builder.build()?;
            drop(window);
            Ok(())
        })
        .build(configured_context())
        .expect("evaluation shell must build");

    app.run(|handle, event| {
        if should_cleanup(&event) {
            handle.state::<AppState>().cleanup();
        }
    });
}

fn allowed_navigation(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "tauri" | "http")
        && matches!(url.host_str(), Some("localhost" | "tauri.localhost"))
        && matches!(url.path(), "" | "/" | "/index.html")
        && url.query().is_none()
        && url.fragment().is_none()
}

#[cfg(not(feature = "evaluation-hooks"))]
fn configured_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg(feature = "evaluation-hooks")]
fn configured_context() -> tauri::Context<tauri::Wry> {
    let mut context = tauri::generate_context!();
    evaluation_assets::install(&mut context);
    context
}

fn should_cleanup(event: &tauri::RunEvent) -> bool {
    match event {
        tauri::RunEvent::ExitRequested { .. } => true,
        tauri::RunEvent::WindowEvent { label, event, .. } => {
            label == "main" && matches!(event, tauri::WindowEvent::CloseRequested { .. })
        }
        _ => false,
    }
}

fn base_builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default().manage(AppState::default())
}

#[cfg(not(feature = "evaluation-hooks"))]
fn configured_builder() -> tauri::Builder<tauri::Wry> {
    base_builder().invoke_handler(tauri::generate_handler![
        choose_folder,
        fixture_start,
        fixture_stop,
        run_rejection_probe,
        renderer_unavailable,
        renderer_recover,
        shell_snapshot
    ])
}

#[cfg(feature = "evaluation-hooks")]
fn configured_builder() -> tauri::Builder<tauri::Wry> {
    base_builder().invoke_handler(tauri::generate_handler![
        choose_folder,
        fixture_start,
        fixture_stop,
        run_rejection_probe,
        renderer_unavailable,
        renderer_recover,
        shell_snapshot
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_accepts_only_the_exact_local_bundled_document() {
        for accepted in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html",
        ] {
            assert!(allowed_navigation(&accepted.parse().unwrap()));
        }
        for denied in [
            "https://tauri.localhost/index.html",
            "http://remote.invalid/index.html",
            "http://tauri.localhost/other.html",
            "http://tauri.localhost/index.html?redirect=true",
        ] {
            assert!(!allowed_navigation(&denied.parse().unwrap()));
        }
    }
}
