use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentClass {
    pub platform: String,
    pub architecture: String,
    pub memory_class_gib: u16,
    pub cpu_class: String,
    pub power_source: String,
    pub power_mode: String,
    pub thermal_state: String,
    pub thermal_method: String,
    pub thermal_limitation: String,
    pub physical_display_width_px: u32,
    pub physical_display_height_px: u32,
    pub effective_scale_percent: u16,
}

pub struct EvidenceSanitizer;

impl EvidenceSanitizer {
    pub fn validate_environment(environment: &EnvironmentClass) -> Result<(), SanitizerError> {
        let value = serde_json::to_value(environment).map_err(|_| SanitizerError::Invalid)?;
        Self::validate_value(&value)
    }

    pub fn validate_value(value: &serde_json::Value) -> Result<(), SanitizerError> {
        match value {
            serde_json::Value::String(text) => Self::validate_text(text),
            serde_json::Value::Array(values) => values.iter().try_for_each(Self::validate_value),
            serde_json::Value::Object(values) => {
                for (key, value) in values {
                    validate_key(key)?;
                    Self::validate_value(value)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    pub fn validate_text(text: &str) -> Result<(), SanitizerError> {
        let lower = text.to_ascii_lowercase();
        let forbidden_key = ["username=", "serial_number=", "device_id="]
            .iter()
            .any(|marker| lower.contains(marker));
        if forbidden_key || looks_like_private_path(text) || text.contains("://") {
            return Err(SanitizerError::SensitiveValue);
        }
        Ok(())
    }
}

fn looks_like_private_path(text: &str) -> bool {
    text.starts_with('/') || text.get(1..3) == Some(":\\") || text.contains("\\Users\\")
}

fn validate_key(key: &str) -> Result<(), SanitizerError> {
    let normalized: String = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    let forbidden = ["username", "userid", "deviceid", "serialnumber", "hostname"];
    if forbidden.iter().any(|candidate| normalized == *candidate) {
        return Err(SanitizerError::SensitiveValue);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum SanitizerError {
    #[error("evidence contains a prohibited identity or path value")]
    SensitiveValue,
    #[error("evidence cannot be represented by the sanitized schema")]
    Invalid,
}
