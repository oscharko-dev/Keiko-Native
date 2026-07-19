use serde::{Deserialize, Serialize};

pub const PRODUCT_NAME: &str = "Keiko Native";
pub const INTERNAL_CHANNEL: &str = "internal";
pub const REPOSITORY_URL: &str = "https://github.com/oscharko-dev/Keiko-Native";
pub const MAX_COMMITTED_TEXT_BYTES: usize = 2048;

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
    #[serde(rename = "welcome")]
    Welcome { title: String, explanation: String },
    #[serde(rename = "canvas")]
    Canvas {
        #[serde(rename = "committedText")]
        committed_text: String,
    },
    #[serde(rename = "about")]
    About {
        #[serde(rename = "productName")]
        product_name: String,
        channel: String,
        version: String,
        #[serde(rename = "sourceRevision")]
        source_revision: String,
        #[serde(rename = "repositoryUrl")]
        repository_url: String,
        #[serde(rename = "licenseUrl")]
        license_url: String,
        statement: String,
    },
    #[serde(rename = "internal-update")]
    InternalUpdate { message: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ApplicationResponse {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u8,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub result: ApplicationResult,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FoundationIntent {
    Load,
    DismissWelcome,
    ShowCanvas,
    ShowAbout,
    ShowInternalUpdate,
    CommitCanvasText(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Surface {
    Welcome,
    Canvas,
    About,
    InternalUpdate,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FoundationApplication {
    surface: Surface,
    committed_text: String,
}

impl FoundationApplication {
    pub fn new(welcome_dismissed: bool) -> Self {
        Self {
            surface: if welcome_dismissed {
                Surface::Canvas
            } else {
                Surface::Welcome
            },
            committed_text: String::new(),
        }
    }

    pub fn apply(
        &mut self,
        intent: FoundationIntent,
        build: &BuildIdentity,
    ) -> Result<ApplicationResult, FoundationError> {
        self.surface = match intent {
            FoundationIntent::Load => self.surface.clone(),
            FoundationIntent::DismissWelcome | FoundationIntent::ShowCanvas => Surface::Canvas,
            FoundationIntent::ShowAbout => Surface::About,
            FoundationIntent::ShowInternalUpdate => Surface::InternalUpdate,
            FoundationIntent::CommitCanvasText(value) => {
                self.committed_text = bounded_unicode(&value)?;
                Surface::Canvas
            }
        };
        self.view(build)
    }

    pub fn view(&self, build: &BuildIdentity) -> Result<ApplicationResult, FoundationError> {
        match self.surface {
            Surface::Welcome => Ok(ApplicationResult::Welcome {
                title: "Willkommen bei Keiko Native v0.1.".to_owned(),
                explanation: "Diese interne Version enthält bewusst keine Coding- oder Wissensfunktionen. Sie belegt, dass die barrierefreie, stabile Grundlage läuft.".to_owned(),
            }),
            Surface::Canvas => Ok(ApplicationResult::Canvas {
                committed_text: self.committed_text.clone(),
            }),
            Surface::About => about_result(build),
            Surface::InternalUpdate => Ok(ApplicationResult::InternalUpdate {
                message: "Update-Prüfung für interne Builds nicht verfügbar.".to_owned(),
            }),
        }
    }

    pub fn can_open_foundation_links(&self) -> bool {
        self.surface == Surface::About
    }

    pub fn restore_committed_text(&mut self, value: &str) -> Result<(), FoundationError> {
        self.committed_text = bounded_unicode(value)?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FoundationError {
    InvalidBuildIdentity,
    InputTooLarge,
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
    application_response(
        request.request_id,
        ApplicationResult::ApplicationHealth {
            status: "healthy".to_owned(),
            build,
        },
    )
}

pub fn application_response(
    request_id: impl Into<String>,
    result: ApplicationResult,
) -> ApplicationResponse {
    ApplicationResponse {
        schema_version: 1,
        request_id: request_id.into(),
        result,
    }
}

fn about_result(build: &BuildIdentity) -> Result<ApplicationResult, FoundationError> {
    if build.version.is_empty()
        || build.source_revision.len() != 40
        || !build
            .source_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(FoundationError::InvalidBuildIdentity);
    }
    Ok(ApplicationResult::About {
        product_name: PRODUCT_NAME.to_owned(),
        channel: INTERNAL_CHANNEL.to_owned(),
        version: build.version.clone(),
        source_revision: build.source_revision.clone(),
        repository_url: REPOSITORY_URL.to_owned(),
        license_url: format!("{REPOSITORY_URL}/blob/{}/LICENSE", build.source_revision),
        statement: "Interner Foundation-Build. Bewusst ohne produktive Features.".to_owned(),
    })
}

fn bounded_unicode(value: &str) -> Result<String, FoundationError> {
    if value.len() > MAX_COMMITTED_TEXT_BYTES {
        return Err(FoundationError::InputTooLarge);
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build() -> BuildIdentity {
        BuildIdentity {
            version: "0.1.0".to_owned(),
            source_revision: "0123456789012345678901234567890123456789".to_owned(),
            target_triple: "aarch64-apple-darwin".to_owned(),
        }
    }

    #[test]
    fn health_response_is_closed_to_the_requested_operation() {
        let response = health_response(
            HealthRequest {
                request_id: "request-00000001".to_owned(),
            },
            build(),
        );
        assert_eq!(response.schema_version, 1);
        assert_eq!(response.request_id, "request-00000001");
        assert!(matches!(
            response.result,
            ApplicationResult::ApplicationHealth { .. }
        ));
    }

    #[test]
    fn foundation_exposes_exactly_the_accepted_state_transitions() {
        let mut application = FoundationApplication::new(false);
        assert!(matches!(
            application.apply(FoundationIntent::Load, &build()),
            Ok(ApplicationResult::Welcome { .. })
        ));
        assert!(matches!(
            application.apply(FoundationIntent::DismissWelcome, &build()),
            Ok(ApplicationResult::Canvas { .. })
        ));
        assert!(matches!(
            application.apply(FoundationIntent::ShowAbout, &build()),
            Ok(ApplicationResult::About { .. })
        ));
        assert!(matches!(
            application.apply(FoundationIntent::ShowInternalUpdate, &build()),
            Ok(ApplicationResult::InternalUpdate { .. })
        ));
        assert!(matches!(
            application.apply(FoundationIntent::ShowCanvas, &build()),
            Ok(ApplicationResult::Canvas { .. })
        ));
    }

    #[test]
    fn about_identity_is_exact_and_commit_bound() {
        let mut application = FoundationApplication::new(true);
        let result = application
            .apply(FoundationIntent::ShowAbout, &build())
            .expect("valid metadata");
        let ApplicationResult::About {
            channel,
            source_revision,
            repository_url,
            license_url,
            ..
        } = result
        else {
            panic!("about result");
        };
        assert_eq!(channel, "internal");
        assert_eq!(repository_url, REPOSITORY_URL);
        assert_eq!(
            license_url,
            format!("{REPOSITORY_URL}/blob/{source_revision}/LICENSE")
        );

        for revision in ["", "abc", &"A".repeat(40), &"g".repeat(40)] {
            let mut invalid = build();
            invalid.source_revision = revision.to_owned();
            assert_eq!(
                application.apply(FoundationIntent::ShowAbout, &invalid),
                Err(FoundationError::InvalidBuildIdentity)
            );
        }
    }

    #[test]
    fn ime_harness_text_is_in_memory_and_bounded() {
        let mut application = FoundationApplication::new(true);
        assert!(matches!(
            application.apply(
                FoundationIntent::CommitCanvasText("Grüße かな 😀".to_owned()),
                &build()
            ),
            Ok(ApplicationResult::Canvas { committed_text })
                if committed_text == "Grüße かな 😀"
        ));
        assert_eq!(
            application.apply(
                FoundationIntent::CommitCanvasText("x".repeat(MAX_COMMITTED_TEXT_BYTES + 1)),
                &build()
            ),
            Err(FoundationError::InputTooLarge)
        );
        let mut restored = FoundationApplication::new(true);
        restored
            .restore_committed_text("wiederhergestellt")
            .expect("bounded restore");
        assert!(matches!(
            restored.apply(FoundationIntent::Load, &build()),
            Ok(ApplicationResult::Canvas { committed_text })
                if committed_text == "wiederhergestellt"
        ));
    }
}
