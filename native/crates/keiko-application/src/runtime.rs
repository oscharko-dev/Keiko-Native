use serde::{Deserialize, Serialize};

pub const CODEX_RUNTIME_VERSION: &str = "0.145.0";
pub const CODEX_RUNTIME_SHA256: &str =
    "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590";
pub const CONTAINMENT_PROFILE: &str = "keiko-codex-readiness-v1";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeReadinessState {
    Checking,
    Ready,
    Unavailable,
    Incompatible,
    AuthenticationRequired,
    ContainmentFailed,
    TimedOut,
    Cancelled,
    CleanupFailed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RuntimeDescriptor {
    pub version: String,
    #[serde(rename = "artifactSha256")]
    pub artifact_sha256: String,
    #[serde(rename = "containmentProfile")]
    pub containment_profile: String,
    #[serde(rename = "freshStartRequired")]
    pub fresh_start_required: bool,
}

impl RuntimeDescriptor {
    pub fn approved() -> Self {
        Self {
            version: CODEX_RUNTIME_VERSION.to_owned(),
            artifact_sha256: CODEX_RUNTIME_SHA256.to_owned(),
            containment_profile: CONTAINMENT_PROFILE.to_owned(),
            fresh_start_required: true,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RuntimeReadinessView {
    pub state: RuntimeReadinessState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<RuntimeDescriptor>,
    #[serde(rename = "quarantinedEvents")]
    pub quarantined_events: u16,
}

impl RuntimeReadinessView {
    pub fn terminal(state: RuntimeReadinessState, quarantined_events: u16) -> Self {
        Self {
            descriptor: (state == RuntimeReadinessState::Ready).then(RuntimeDescriptor::approved),
            state,
            quarantined_events,
        }
    }

    pub fn checking() -> Self {
        Self {
            state: RuntimeReadinessState::Checking,
            descriptor: None,
            quarantined_events: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_exports_only_the_immutable_fresh_start_contract() {
        let view = RuntimeReadinessView::terminal(RuntimeReadinessState::Ready, 2);
        let descriptor = view.descriptor.expect("ready descriptor");
        assert_eq!(descriptor.version, "0.145.0");
        assert_eq!(
            descriptor.artifact_sha256,
            "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590"
        );
        assert_eq!(descriptor.containment_profile, "keiko-codex-readiness-v1");
        assert!(descriptor.fresh_start_required);
    }

    #[test]
    fn non_ready_states_never_export_a_runtime_descriptor() {
        for state in [
            RuntimeReadinessState::Checking,
            RuntimeReadinessState::Unavailable,
            RuntimeReadinessState::Incompatible,
            RuntimeReadinessState::AuthenticationRequired,
            RuntimeReadinessState::ContainmentFailed,
            RuntimeReadinessState::TimedOut,
            RuntimeReadinessState::Cancelled,
            RuntimeReadinessState::CleanupFailed,
        ] {
            assert_eq!(
                RuntimeReadinessView::terminal(state, 0).descriptor,
                None,
                "{state:?}"
            );
        }
    }
}
