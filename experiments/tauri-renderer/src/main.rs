#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "evaluation-hook")]
mod evaluation;

fn bundled_navigation(url: &tauri::Url) -> bool {
    #[cfg(feature = "evaluation-hook")]
    eprintln!(
        "KEIKO_DIAGNOSTIC_NAV:{}:{}",
        url.scheme(),
        url.host_str().unwrap_or("none")
    );
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
}

fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default().plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("bundled-navigation-policy")
            .on_navigation(|_, url| bundled_navigation(url))
            .build(),
    )
}

#[cfg(feature = "evaluation-hook")]
fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg(not(feature = "evaluation-hook"))]
fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

fn main() {
    let context = context();
    #[cfg(feature = "evaluation-hook")]
    if evaluation::requested() {
        evaluation::run(builder(), context);
        return;
    }

    builder()
        .run(context)
        .expect("the Tauri evaluation shell must run");
}
