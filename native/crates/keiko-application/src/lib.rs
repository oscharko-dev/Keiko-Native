use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HealthRequest {
    pub request_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BuildIdentity {
    pub version: String,
    #[serde(rename = "sourceRevision")]
    pub source_revision: String,
    #[serde(rename = "targetTriple")]
    pub target_triple: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ApplicationResult {
    #[serde(rename = "application-health")]
    ApplicationHealth {
        status: String,
        build: BuildIdentity,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ApplicationResponse {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u8,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub result: ApplicationResult,
}

pub fn current_build_identity() -> BuildIdentity {
    BuildIdentity {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        source_revision: option_env!("KEIKO_NATIVE_SOURCE_REVISION")
            .unwrap_or("0000000000000000000000000000000000000000")
            .to_owned(),
        target_triple: format!(
            "{}-apple-darwin",
            match std::env::consts::ARCH {
                "aarch64" => "aarch64",
                "x86_64" => "x86_64",
                other => other,
            }
        ),
    }
}

pub fn health_response(request: HealthRequest, build: BuildIdentity) -> ApplicationResponse {
    ApplicationResponse {
        schema_version: 1,
        request_id: request.request_id,
        result: ApplicationResult::ApplicationHealth {
            status: "healthy".to_owned(),
            build,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_response_is_closed_to_the_requested_operation() {
        let response = health_response(
            HealthRequest {
                request_id: "request-00000001".to_owned(),
            },
            BuildIdentity {
                version: "0.1.0".to_owned(),
                source_revision: "0123456789012345678901234567890123456789".to_owned(),
                target_triple: "aarch64-apple-darwin".to_owned(),
            },
        );

        assert_eq!(response.schema_version, 1);
        assert_eq!(response.request_id, "request-00000001");
        match response.result {
            ApplicationResult::ApplicationHealth { status, build } => {
                assert_eq!(status, "healthy");
                assert_eq!(build.target_triple, "aarch64-apple-darwin");
            }
        }
    }
}
