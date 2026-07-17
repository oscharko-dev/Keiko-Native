use std::{env, path::PathBuf, process::Command};

fn main() {
    slint_build::compile("ui/main.slint").expect("the Slint evaluation UI must compile");

    #[cfg(target_os = "macos")]
    if env::var_os("CARGO_FEATURE_EVALUATION_HOOK").is_some() {
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
