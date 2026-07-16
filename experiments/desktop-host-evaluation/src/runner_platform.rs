use sysinfo::System;

use crate::evidence::EnvironmentClass;
use crate::runner::RunnerError;

pub(crate) fn environment(platform: &str) -> EnvironmentClass {
    let mut system = System::new();
    system.refresh_memory();
    let gib = 1024_u64.pow(3);
    EnvironmentClass {
        platform: platform.into(),
        architecture: std::env::consts::ARCH.into(),
        memory_class_gib: system.total_memory().div_ceil(gib).min(u16::MAX.into()) as u16,
        cpu_class: if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        }
        .into(),
        power_source: "operator_report_required".into(),
        power_mode: "operator_report_required".into(),
        thermal_state: "operator_report_required".into(),
        thermal_method: "operator_report_required".into(),
        thermal_limitation: "not_automatically_observed".into(),
        physical_display_width_px: 0,
        physical_display_height_px: 0,
        effective_scale_percent: 0,
    }
}

pub(crate) fn current_platform() -> Result<&'static str, RunnerError> {
    if cfg!(target_os = "macos") {
        Ok("macos")
    } else if cfg!(target_os = "windows") {
        Ok("windows")
    } else {
        Err(RunnerError::UnsupportedPlatform)
    }
}

pub(crate) fn rust_version() -> Result<String, RunnerError> {
    let output = std::process::Command::new("rustc")
        .arg("--version")
        .output()?;
    let version = String::from_utf8(output.stdout).map_err(|_| RunnerError::InvalidOutput)?;
    Ok(version.trim().into())
}
