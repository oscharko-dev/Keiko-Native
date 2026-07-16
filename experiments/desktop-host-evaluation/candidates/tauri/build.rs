const RELEASE_COMMANDS: &[&str] = &[
    "choose_folder",
    "fixture_start",
    "fixture_stop",
    "run_rejection_probe",
    "renderer_unavailable",
    "renderer_recover",
    "shell_snapshot",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(RELEASE_COMMANDS)),
    )
    .expect("Tauri build metadata must be valid");
}
