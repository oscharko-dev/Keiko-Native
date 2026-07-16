#[cfg(not(feature = "evaluation-hooks"))]
use std::fs;

#[cfg(not(feature = "evaluation-hooks"))]
use keiko_eval::package::inspect_release_surface;

#[test]
#[cfg(not(feature = "evaluation-hooks"))]
fn default_artifact_contains_no_test_listener_or_debug_hook() {
    let binary = fs::read(env!("CARGO_BIN_EXE_keiko-slint-prototype"))
        .expect("read compiled candidate artifact");
    inspect_release_surface(&binary).expect("shared release-surface inspection");

    let text = String::from_utf8_lossy(&binary).to_ascii_lowercase();
    for forbidden in [
        "keiko-stable-rendered-shell-v1",
        "keiko_eval_ready_file",
        "evaluation_driver_v1",
        "remote-debugging",
        "slint_interpreter",
        "test-credential",
        "webdriver",
    ] {
        assert!(!text.contains(forbidden), "forbidden marker: {forbidden}");
    }
}

#[test]
fn build_contract_pins_compiled_ui_and_disables_paid_surfaces() {
    let manifest = include_str!("../Cargo.toml");
    let build = include_str!("../build.rs");
    assert!(manifest.contains("version = \"=1.17.1\""));
    assert!(manifest.contains("default-features = false"));
    assert!(!manifest.contains("live-preview"));
    assert!(!manifest.contains("slint-interpreter"));
    assert!(build.contains("compile_with_config"));
    assert!(manifest.contains("evaluation-hooks = []"));
}

#[test]
fn source_contract_restores_focus_and_exposes_persistent_states() {
    let ui = include_str!("../ui/app.slint");
    let main = include_str!("../src/main.rs");
    for state in [
        "folder-state",
        "fixture-state",
        "probe-state",
        "renderer-state",
    ] {
        assert!(ui.contains(&format!("accessible-id: \"{state}\"")));
    }
    assert!(ui.contains("accessible-live-region: polite"));
    assert!(ui.contains("choose-folder-button.focus()"));
    assert!(ui.contains("recover-button.focus()"));
    assert!(ui.contains("unavailable-button.focus()"));
    assert!(main.contains("invoke_restore_folder_focus"));
}
