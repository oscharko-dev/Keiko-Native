use std::{env, path::PathBuf, process::Command};

const EVALUATION_CAPABILITIES: &str = "./capabilities/evaluation/**/*.json";
const EVALUATION_PERMISSIONS: &str = "./permissions/evaluation/**/*.toml";
const RELEASE_CAPABILITIES: &str = "./capabilities/release/**/*.json";
const RELEASE_PERMISSIONS: &str = "./permissions/release/**/*.toml";

fn main() {
    let evaluation_hook = env::var_os("CARGO_FEATURE_EVALUATION_HOOK").is_some();

    if evaluation_hook {
        let overlay =
            serde_json::from_str::<serde_json::Value>(include_str!("evaluation.config.json"))
                .expect("evaluation configuration must be valid JSON")
                .to_string();
        // SAFETY: this build script is single-threaded and sets the variable before invoking Tauri.
        unsafe { env::set_var("TAURI_CONFIG", &overlay) };
        println!("cargo:rustc-env=TAURI_CONFIG={overlay}");
        println!("cargo:rerun-if-changed=evaluation.config.json");
    }

    let (capabilities, permissions) = if evaluation_hook {
        println!("cargo:rerun-if-changed=capabilities/evaluation");
        println!("cargo:rerun-if-changed=permissions/evaluation");
        (EVALUATION_CAPABILITIES, EVALUATION_PERMISSIONS)
    } else {
        println!("cargo:rerun-if-changed=capabilities/release");
        println!("cargo:rerun-if-changed=permissions/release");
        (RELEASE_CAPABILITIES, RELEASE_PERMISSIONS)
    };

    let attributes = tauri_build::Attributes::new()
        .capabilities_path_pattern(capabilities)
        .app_manifest(tauri_build::AppManifest::new().permissions_path_pattern(permissions));
    tauri_build::try_build(attributes).expect("Tauri build inputs must be structurally valid");

    #[cfg(target_os = "macos")]
    if evaluation_hook {
        let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"));
        let object = output.join("native-dialog.o");
        let status = Command::new("xcrun")
            .args([
                "clang",
                "-fobjc-arc",
                "-fblocks",
                "-c",
                "src/native_dialog.m",
                "-o",
            ])
            .arg(&object)
            .status()
            .expect("xcrun must be available for the macOS evaluation");
        assert!(status.success(), "native dialog shim must compile");
        println!("cargo:rustc-link-arg={}", object.display());
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rerun-if-changed=src/native_dialog.m");
    }
}
