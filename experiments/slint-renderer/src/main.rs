#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

slint::include_modules!();

#[cfg(feature = "evaluation-hook")]
mod evaluation;

fn main() -> Result<(), slint::PlatformError> {
    let ui = MainWindow::new()?;
    #[cfg(feature = "evaluation-hook")]
    if evaluation::requested() {
        return evaluation::run(ui);
    }
    ui.run()
}
