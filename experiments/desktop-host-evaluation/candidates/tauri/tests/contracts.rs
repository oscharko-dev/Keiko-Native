#[cfg(not(feature = "evaluation-hooks"))]
use keiko_eval::package::{ReleaseSurface, inspect_release_surface};
#[cfg(not(feature = "evaluation-hooks"))]
use std::fs;

const CONFIG: &str = include_str!("../tauri.conf.json");
const CAPABILITY: &str = include_str!("../capabilities/main-shell.json");
const HTML: &str = include_str!("../web/index.html");
const SCRIPT: &str = include_str!("../web/app.js");
const STYLES: &str = include_str!("../web/styles.css");

#[test]
fn release_configuration_is_local_default_deny_and_without_devtools() {
    let config: serde_json::Value = serde_json::from_str(CONFIG).unwrap();
    let security = &config["app"]["security"];
    assert_eq!(config["app"]["windows"], serde_json::json!([]));
    assert_eq!(security["capabilities"], serde_json::json!(["main-shell"]));
    assert!(
        security["csp"]
            .as_str()
            .unwrap()
            .contains("default-src 'self'")
    );
    assert!(
        security["csp"]
            .as_str()
            .unwrap()
            .contains("object-src 'none'")
    );
    assert!(!CONFIG.contains("remote-debugging"));

    let capability: serde_json::Value = serde_json::from_str(CAPABILITY).unwrap();
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["local"], true);
    assert_eq!(capability["permissions"].as_array().unwrap().len(), 7);
    assert!(
        capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|permission| permission.as_str().unwrap().starts_with("allow-"))
    );
}

#[test]
fn semantic_journey_contract_is_present_without_generic_operating_system_apis() {
    for required in [
        "compositionstart",
        "compositionend",
        "role=\"status\"",
        "role=\"alert\"",
        "Choose folder",
        "Recover renderer",
    ] {
        assert!(
            HTML.contains(required) || SCRIPT.contains(required),
            "missing {required}"
        );
    }
    for prohibited in [
        "@tauri-apps/plugin-fs",
        "plugin-shell",
        "Command.create",
        "readFile(",
    ] {
        assert!(!SCRIPT.contains(prohibited));
    }
    assert!(STYLES.contains(":focus-visible"));
    assert!(STYLES.contains("forced-colors: active"));
    assert!(STYLES.contains("prefers-color-scheme: dark"));
    assert!(SCRIPT.contains("compositionUpdates += 1"));
    assert!(!SCRIPT.contains("announce(\"Text composition updated.\")"));
    assert!(SCRIPT.contains("after ${compositionUpdates} composition updates"));
    assert!(contrast_ratio("#6246c7", "#ffffff") >= 4.5);
    assert!(contrast_ratio("#5137b8", "#ffffff") >= 4.5);
}

#[test]
#[cfg(not(feature = "evaluation-hooks"))]
fn release_sources_do_not_embed_driver_or_debug_listener_capabilities() {
    let manifest = include_bytes!("../Cargo.toml");
    assert_eq!(
        inspect_release_surface(manifest).unwrap(),
        ReleaseSurface::Clean
    );
    assert!(!CONFIG.contains("devtools\": true"));
    assert!(!CONFIG.contains("test-credential"));

    let binary = fs::read(env!("CARGO_BIN_EXE_keiko-tauri-prototype")).unwrap();
    let text = String::from_utf8_lossy(&binary).to_ascii_lowercase();
    for forbidden in [
        "--fixture-child",
        "evaluation_shell_ready",
        "keiko-stable-rendered-shell-v1",
        "keiko_eval_ready_file",
        "__keiko_eval_ready.js",
        "evaluationready",
        "keiko_eval_close_file",
        "keiko-close-request-v1",
        "keiko-eval-close",
    ] {
        assert!(!text.contains(forbidden), "forbidden marker: {forbidden}");
    }
}

#[test]
fn evaluation_features_are_isolated_and_callback_contract_is_shared() {
    let manifest = include_str!("../Cargo.toml");
    let application = include_str!("../src/application.rs");
    let boundary = include_str!("../src/boundary.rs");
    assert!(manifest.contains("required-features = [\"evaluation-hooks\"]"));
    assert!(application.contains("request_start_fixture(window.label())"));
    assert!(boundary.contains("parse_and_authorize(payload)"));
    assert!(application.contains("evaluation_ready: Option<bool>"));
    assert!(!CAPABILITY.contains("evaluation-shell-ready"));
}

fn contrast_ratio(foreground: &str, background: &str) -> f64 {
    let foreground = relative_luminance(parse_hex(foreground));
    let background = relative_luminance(parse_hex(background));
    (foreground.max(background) + 0.05) / (foreground.min(background) + 0.05)
}

fn parse_hex(value: &str) -> [f64; 3] {
    let value = value.trim_start_matches('#');
    [0, 2, 4].map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap() as f64 / 255.0)
}

fn relative_luminance(rgb: [f64; 3]) -> f64 {
    let [red, green, blue] = rgb.map(|channel| {
        if channel <= 0.04045 {
            channel / 12.92
        } else {
            ((channel + 0.055) / 1.055).powf(2.4)
        }
    });
    0.2126 * red + 0.7152 * green + 0.0722 * blue
}
