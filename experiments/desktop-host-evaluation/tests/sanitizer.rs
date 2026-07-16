use keiko_eval::evidence::{EnvironmentClass, EvidenceSanitizer};

#[test]
fn environment_schema_accepts_classes_not_device_identity() {
    let environment = EnvironmentClass {
        platform: "macos".into(),
        architecture: "arm64".into(),
        memory_class_gib: 16,
        cpu_class: "apple-silicon".into(),
        power_source: "ac".into(),
        power_mode: "balanced".into(),
        thermal_state: "nominal".into(),
        thermal_method: "os-reported".into(),
        thermal_limitation: "class-only".into(),
        physical_display_width_px: 2_560,
        physical_display_height_px: 1_664,
        effective_scale_percent: 100,
    };
    assert!(EvidenceSanitizer::validate_environment(&environment).is_ok());
}

#[test]
fn usernames_paths_serials_and_device_ids_are_rejected() {
    for value in [
        "/Users/alice/work/repo",
        r"C:\\Users\\alice\\repo",
        "username=alice",
        "serial_number=C02SECRET",
        "device_id=stable-123",
        "https://private.invalid/endpoint",
    ] {
        assert!(EvidenceSanitizer::validate_text(value).is_err());
    }
}

#[test]
fn sensitive_identity_keys_are_rejected_even_when_values_look_harmless() {
    for key in ["user_name", "deviceId", "serial-number", "host_name"] {
        let value = serde_json::json!({ key: "redacted" });
        assert!(EvidenceSanitizer::validate_value(&value).is_err());
    }
}
