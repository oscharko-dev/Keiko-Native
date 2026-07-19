use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use keiko_application::{
    FoundationApplication, FoundationError, FoundationIntent, REPOSITORY_URL, application_response,
    current_build_identity,
};
use keiko_ui_port::{
    LinkDestination, Operation, ReasonCode, encode_error, encode_success, request_metadata,
    request_operation,
};
use serde::{Deserialize, Serialize};

use crate::{HostLifecycle, SenderContext};

const MAX_PERSISTED_STATE_BYTES: u64 = 128;
const MAX_IME_STATE_BYTES: u64 = 4096;
const STATE_SCHEMA_VERSION: u8 = 1;

#[derive(Debug)]
pub struct FoundationHost {
    state_path: PathBuf,
    ime_state_path: PathBuf,
    application: Option<FoundationApplication>,
}

#[derive(Debug, Eq, PartialEq)]
pub struct FoundationRequestOutput {
    pub encoded: String,
    pub quit: bool,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct WelcomeState {
    #[serde(rename = "schemaVersion")]
    schema_version: u8,
    dismissed: bool,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct ImeState {
    #[serde(rename = "schemaVersion")]
    schema_version: u8,
    #[serde(rename = "committedText")]
    committed_text: String,
}

impl FoundationHost {
    pub fn new(state_path: PathBuf) -> Self {
        let ime_state_path = state_path.with_file_name(format!(
            "{}.ime.json",
            state_path
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("foundation-state")
        ));
        Self {
            state_path,
            ime_state_path,
            application: None,
        }
    }

    fn application(&mut self) -> &mut FoundationApplication {
        if self.application.is_none() {
            let dismissed = read_welcome_state(&self.state_path);
            let mut application = FoundationApplication::new(dismissed);
            if let Some(committed_text) = read_ime_state(&self.ime_state_path) {
                let _ = application.restore_committed_text(&committed_text);
            }
            self.application = Some(application);
        }
        self.application.as_mut().expect("application initialized")
    }

    fn dispatch<F>(
        &mut self,
        request: &keiko_ui_port::UiRequest,
        open_external: F,
    ) -> FoundationRequestOutput
    where
        F: FnOnce(&str) -> bool,
    {
        let (request_id, _, _) = request_metadata(request);
        let build = current_build_identity();
        let outcome = match request_operation(request).clone() {
            Operation::FoundationLoad => self.application().apply(FoundationIntent::Load, &build),
            Operation::DismissWelcome => {
                if write_welcome_state(&self.state_path).is_err() {
                    return failed(request_id, ReasonCode::InternalFailure);
                }
                self.application()
                    .apply(FoundationIntent::DismissWelcome, &build)
            }
            Operation::ShowCanvas => self
                .application()
                .apply(FoundationIntent::ShowCanvas, &build),
            Operation::ShowAbout => self
                .application()
                .apply(FoundationIntent::ShowAbout, &build),
            Operation::ShowInternalUpdate => self
                .application()
                .apply(FoundationIntent::ShowInternalUpdate, &build),
            Operation::CommitCanvasText { committed_text } => {
                let mut candidate = self.application().clone();
                let result = candidate.apply(
                    FoundationIntent::CommitCanvasText(committed_text.clone()),
                    &build,
                );
                if result.is_ok() && write_ime_state(&self.ime_state_path, &committed_text).is_err()
                {
                    return failed(request_id, ReasonCode::InternalFailure);
                }
                if result.is_ok() {
                    self.application = Some(candidate);
                }
                result
            }
            Operation::OpenFoundationLink { destination } => {
                if !self.application().can_open_foundation_links() {
                    return failed(request_id, ReasonCode::Unauthorized);
                }
                let url = allowed_url(destination, &build.source_revision);
                if !is_exact_allowed_url(&url, &build.source_revision) {
                    return failed(request_id, ReasonCode::Unauthorized);
                }
                if !open_external(&url) {
                    return failed(request_id, ReasonCode::HostUnavailable);
                }
                self.application().view(&build)
            }
            Operation::QuitApplication => {
                return match self.application().view(&build) {
                    Ok(result) => FoundationRequestOutput {
                        encoded: encode_success(&application_response(request_id, result)),
                        quit: true,
                    },
                    Err(error) => failed(request_id, reason_for(error)),
                };
            }
            Operation::ApplicationHealth => {
                return failed(request_id, ReasonCode::UnknownOperation);
            }
        };
        match outcome {
            Ok(result) => FoundationRequestOutput {
                encoded: encode_success(&application_response(request_id, result)),
                quit: false,
            },
            Err(error) => failed(request_id, reason_for(error)),
        }
    }
}

pub fn foundation_request<F>(
    lifecycle: &Mutex<HostLifecycle>,
    foundation: &Mutex<FoundationHost>,
    sender: &SenderContext,
    request: &str,
    open_external: F,
) -> FoundationRequestOutput
where
    F: FnOnce(&str) -> bool,
{
    let accepted = {
        let mut lifecycle = match lifecycle.lock() {
            Ok(lifecycle) => lifecycle,
            Err(_) => return failed("unknown-request", ReasonCode::InternalFailure),
        };
        match lifecycle.begin_application_request(sender, request.as_bytes()) {
            Ok(accepted) => accepted,
            Err((request_id, reason)) => return failed(&request_id, reason),
        }
    };

    let output = match foundation.lock() {
        Ok(mut foundation) => foundation.dispatch(&accepted.request, open_external),
        Err(_) => failed("unknown-request", ReasonCode::InternalFailure),
    };
    let encoded = lifecycle.lock().map_or_else(
        |_| encode_error("unknown-request", ReasonCode::InternalFailure),
        |mut lifecycle| lifecycle.complete_foundation_request(accepted, output.encoded.clone()),
    );
    FoundationRequestOutput {
        encoded,
        quit: output.quit,
    }
}

pub fn is_exact_allowed_url(value: &str, revision: &str) -> bool {
    if revision.len() != 40
        || !revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return false;
    }
    value == REPOSITORY_URL || value == format!("{REPOSITORY_URL}/blob/{revision}/LICENSE")
}

fn allowed_url(destination: LinkDestination, revision: &str) -> String {
    match destination {
        LinkDestination::Repository => REPOSITORY_URL.to_owned(),
        LinkDestination::License => format!("{REPOSITORY_URL}/blob/{revision}/LICENSE"),
    }
}

fn read_welcome_state(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_PERSISTED_STATE_BYTES {
        return false;
    }
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    if Read::by_ref(&mut file)
        .take(MAX_PERSISTED_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.is_empty()
        || bytes.len() as u64 > MAX_PERSISTED_STATE_BYTES
    {
        return false;
    }
    serde_json::from_slice::<WelcomeState>(&bytes)
        .is_ok_and(|state| state.schema_version == STATE_SCHEMA_VERSION && state.dismissed)
}

fn write_welcome_state(path: &Path) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&WelcomeState {
        schema_version: STATE_SCHEMA_VERSION,
        dismissed: true,
    })
    .map_err(std::io::Error::other)?;
    durable_replace(path, &bytes)
}

fn read_ime_state(path: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_IME_STATE_BYTES {
        return None;
    }
    let mut file = File::open(path).ok()?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_IME_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_IME_STATE_BYTES {
        return None;
    }
    serde_json::from_slice::<ImeState>(&bytes)
        .ok()
        .filter(|state| state.schema_version == STATE_SCHEMA_VERSION)
        .and_then(|state| {
            FoundationApplication::new(true)
                .restore_committed_text(&state.committed_text)
                .ok()
                .map(|()| state.committed_text)
        })
}

fn write_ime_state(path: &Path, committed_text: &str) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&ImeState {
        schema_version: STATE_SCHEMA_VERSION,
        committed_text: committed_text.to_owned(),
    })
    .map_err(std::io::Error::other)?;
    if bytes.len() as u64 > MAX_IME_STATE_BYTES {
        return Err(std::io::Error::other("IME state exceeds boundary"));
    }
    durable_replace(path, &bytes)
}

fn durable_replace(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("state parent unavailable"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("state"),
        std::process::id()
    ));
    let _ = fs::remove_file(&temporary);
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn reason_for(error: FoundationError) -> ReasonCode {
    match error {
        FoundationError::InvalidBuildIdentity => ReasonCode::InternalFailure,
        FoundationError::InputTooLarge => ReasonCode::PayloadTooLarge,
    }
}

fn failed(request_id: &str, reason: ReasonCode) -> FoundationRequestOutput {
    FoundationRequestOutput {
        encoded: encode_error(request_id, reason),
        quit: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use keiko_ui_port::canonical_request_id;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(1);

    fn temporary_state() -> PathBuf {
        std::env::temp_dir().join(format!(
            "keiko-native-foundation-{}-{}-state.json",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn request(generation: u64, sequence: u64, operation: &str) -> String {
        format!(
            r#"{{"schemaVersion":1,"requestId":"{}","sequence":{sequence},"timeoutMs":1000,"operation":{operation}}}"#,
            canonical_request_id(generation, sequence).expect("request ID")
        )
    }

    fn session() -> (Mutex<HostLifecycle>, u64, String) {
        let nonce = "a".repeat(64);
        let mut lifecycle = HostLifecycle::default();
        let generation = lifecycle
            .begin_renderer_session(nonce.clone())
            .expect("generation");
        (Mutex::new(lifecycle), generation, nonce)
    }

    #[test]
    fn persistence_defaults_closed_and_relaunches_to_canvas_only_after_atomic_dismissal() {
        let path = temporary_state();
        for malformed in [
            "",
            "{",
            r#"{"schemaVersion":2,"dismissed":true}"#,
            r#"{"schemaVersion":1,"dismissed":true,"extra":true}"#,
            r#"{"schemaVersion":1}"#,
        ] {
            fs::write(&path, malformed).expect("fixture");
            assert!(!read_welcome_state(&path));
        }
        fs::write(&path, "x".repeat(MAX_PERSISTED_STATE_BYTES as usize + 1)).expect("fixture");
        assert!(!read_welcome_state(&path));
        write_welcome_state(&path).expect("atomic state");
        assert!(read_welcome_state(&path));
        let parsed: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).expect("state bytes")).expect("JSON");
        assert_eq!(parsed.as_object().expect("object").len(), 2);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn ime_state_relaunches_committed_unicode_and_rejects_corruption() {
        let path = temporary_state().with_file_name(format!(
            "keiko-native-foundation-{}-{}-ime.json",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        write_ime_state(&path, "Grüße かな 😀").expect("IME state");
        assert_eq!(read_ime_state(&path).as_deref(), Some("Grüße かな 😀"));
        for malformed in [
            "",
            "{",
            r#"{"schemaVersion":2,"committedText":"x"}"#,
            r#"{"schemaVersion":1,"committedText":"x","extra":true}"#,
        ] {
            fs::write(&path, malformed).expect("fixture");
            assert_eq!(read_ime_state(&path), None);
        }
        fs::write(&path, "x".repeat(MAX_IME_STATE_BYTES as usize + 1)).expect("fixture");
        assert_eq!(read_ime_state(&path), None);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn link_allowlist_rejects_every_non_exact_destination_shape() {
        let revision = "a".repeat(40);
        assert!(is_exact_allowed_url(REPOSITORY_URL, &revision));
        assert!(is_exact_allowed_url(
            &format!("{REPOSITORY_URL}/blob/{revision}/LICENSE"),
            &revision
        ));
        for denied in [
            "http://github.com/oscharko-dev/Keiko-Native",
            concat!("https://", "user", "@github.com/oscharko-dev/Keiko-Native"),
            "https://github.com:443/oscharko-dev/Keiko-Native",
            "https://github.com/oscharko-dev/Keiko-Native/",
            "https://github.com/oscharko-dev/Keiko-Native#fragment",
            "https://github.com/oscharko-dev/Keiko-Native%2fblob/main/LICENSE",
            "https://github.com/oscharko-dev/Keiko-Native/blob/main/LICENSE",
            "https://example.com/",
        ] {
            assert!(!is_exact_allowed_url(denied, &revision), "{denied}");
        }
        assert!(!is_exact_allowed_url(REPOSITORY_URL, "bad"));
    }

    #[test]
    fn authenticated_foundation_requests_keep_four_state_policy_and_link_authority() {
        let path = temporary_state();
        let foundation = Mutex::new(FoundationHost::new(path.clone()));
        let (lifecycle, generation, nonce) = session();
        let call = |sequence, operation: &str, opened: bool| {
            let sender = SenderContext {
                window_label: "main".to_owned(),
                origin: "tauri://localhost".to_owned(),
                generation,
                document_nonce: nonce.clone(),
            };
            foundation_request(
                &lifecycle,
                &foundation,
                &sender,
                &request(generation, sequence, operation),
                |_| opened,
            )
        };
        assert!(
            call(1, r#"{"kind":"foundation-load"}"#, true)
                .encoded
                .contains("welcome")
        );
        assert!(
            call(
                2,
                r#"{"kind":"open-foundation-link","destination":"repository"}"#,
                true
            )
            .encoded
            .contains("unauthorized")
        );
        assert!(
            call(3, r#"{"kind":"dismiss-welcome"}"#, true)
                .encoded
                .contains("canvas")
        );
        assert!(
            call(4, r#"{"kind":"show-about"}"#, true)
                .encoded
                .contains("about")
        );
        assert!(
            call(
                5,
                r#"{"kind":"open-foundation-link","destination":"repository"}"#,
                true
            )
            .encoded
            .contains("about")
        );
        assert!(
            call(
                6,
                r#"{"kind":"open-foundation-link","destination":"license"}"#,
                false
            )
            .encoded
            .contains("host-unavailable")
        );
        assert!(
            call(7, r#"{"kind":"show-internal-update"}"#, true)
                .encoded
                .contains("internal-update")
        );
        assert!(call(8, r#"{"kind":"quit-application"}"#, true).quit);
        let _ = fs::remove_file(path);
    }
}
