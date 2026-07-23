use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use keiko_application::{
    FoundationApplication, FoundationError, FoundationIntent, REPOSITORY_URL, application_response,
    current_build_identity,
};
use keiko_ui_port::{
    LinkDestination, Operation, ReasonCode, encode_error, encode_success, request_metadata,
    request_operation,
};
use serde::{Deserialize, Serialize};

use crate::{FoundationCompletion, HostLifecycle, SenderContext};

const MAX_PERSISTED_STATE_BYTES: u64 = 128;
const MAX_IME_STATE_BYTES: u64 = 4096;
const STATE_SCHEMA_VERSION: u8 = 1;
const TEMPORARY_CREATE_ATTEMPTS: usize = 64;
static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(1);

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

#[derive(Debug)]
struct PreparedDispatch {
    output: FoundationRequestOutput,
    effect: Option<PreparedEffect>,
}

#[derive(Debug)]
struct PreparedEffect {
    candidate: FoundationApplication,
    replacement: PreparedReplacement,
}

#[derive(Debug)]
struct PreparedReplacement {
    parent: PathBuf,
    target: PathBuf,
    temporary: Option<PathBuf>,
    #[cfg(test)]
    discard_failure: bool,
    #[cfg(test)]
    parent_sync_failure: bool,
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
    ) -> PreparedDispatch
    where
        F: FnOnce(&str) -> bool,
    {
        let (request_id, _, _) = request_metadata(request);
        let build = current_build_identity();
        let outcome = match request_operation(request).clone() {
            Operation::FoundationLoad => self.application().apply(FoundationIntent::Load, &build),
            Operation::DismissWelcome => {
                let mut candidate = self.application().clone();
                let result = match candidate.apply(FoundationIntent::DismissWelcome, &build) {
                    Ok(result) => result,
                    Err(error) => {
                        return PreparedDispatch::immediate(failed(request_id, reason_for(error)));
                    }
                };
                let effect = match prepare_welcome_effect(&self.state_path, candidate) {
                    Ok(effect) => effect,
                    Err(_) => {
                        return PreparedDispatch::immediate(failed(
                            request_id,
                            ReasonCode::InternalFailure,
                        ));
                    }
                };
                return PreparedDispatch::prepared(
                    FoundationRequestOutput {
                        encoded: encode_success(&application_response(request_id, result)),
                        quit: false,
                    },
                    effect,
                );
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
                let result = match candidate.apply(
                    FoundationIntent::CommitCanvasText(committed_text.clone()),
                    &build,
                ) {
                    Ok(result) => result,
                    Err(error) => {
                        return PreparedDispatch::immediate(failed(request_id, reason_for(error)));
                    }
                };
                let effect =
                    match prepare_ime_effect(&self.ime_state_path, &committed_text, candidate) {
                        Ok(effect) => effect,
                        Err(_) => {
                            return PreparedDispatch::immediate(failed(
                                request_id,
                                ReasonCode::InternalFailure,
                            ));
                        }
                    };
                return PreparedDispatch::prepared(
                    FoundationRequestOutput {
                        encoded: encode_success(&application_response(request_id, result)),
                        quit: false,
                    },
                    effect,
                );
            }
            Operation::OpenFoundationLink { destination } => {
                if !self.application().can_open_foundation_links() {
                    return PreparedDispatch::immediate(failed(
                        request_id,
                        ReasonCode::Unauthorized,
                    ));
                }
                let url = allowed_url(destination, &build.source_revision);
                if !is_exact_allowed_url(&url, &build.source_revision) {
                    return PreparedDispatch::immediate(failed(
                        request_id,
                        ReasonCode::Unauthorized,
                    ));
                }
                if !open_external(&url) {
                    return PreparedDispatch::immediate(failed(
                        request_id,
                        ReasonCode::HostUnavailable,
                    ));
                }
                self.application().view(&build)
            }
            Operation::QuitApplication => {
                return PreparedDispatch::immediate(match self.application().view(&build) {
                    Ok(result) => FoundationRequestOutput {
                        encoded: encode_success(&application_response(request_id, result)),
                        quit: true,
                    },
                    Err(error) => failed(request_id, reason_for(error)),
                });
            }
            Operation::ApplicationHealth => {
                return PreparedDispatch::immediate(failed(
                    request_id,
                    ReasonCode::UnknownOperation,
                ));
            }
        };
        PreparedDispatch::immediate(match outcome {
            Ok(result) => FoundationRequestOutput {
                encoded: encode_success(&application_response(request_id, result)),
                quit: false,
            },
            Err(error) => failed(request_id, reason_for(error)),
        })
    }
}

impl PreparedDispatch {
    fn immediate(output: FoundationRequestOutput) -> Self {
        Self {
            output,
            effect: None,
        }
    }

    fn prepared(output: FoundationRequestOutput, effect: PreparedEffect) -> Self {
        Self {
            output,
            effect: Some(effect),
        }
    }

    fn discard(mut self) -> std::io::Result<()> {
        match self.effect.take() {
            Some(effect) => effect.discard(),
            None => Ok(()),
        }
    }
}

impl PreparedEffect {
    fn commit(self, foundation: &mut FoundationHost) -> std::io::Result<()> {
        let Self {
            candidate,
            mut replacement,
        } = self;
        replacement.rename()?;
        foundation.application = Some(candidate);
        replacement.sync_parent()
    }

    fn discard(self) -> std::io::Result<()> {
        let Self {
            candidate: _,
            mut replacement,
        } = self;
        replacement.discard()
    }

    #[cfg(test)]
    fn temporary_path(&self) -> Option<&Path> {
        self.replacement.temporary.as_deref()
    }

    #[cfg(test)]
    fn inject_discard_failure(&mut self) {
        self.replacement.discard_failure = true;
    }

    #[cfg(test)]
    fn inject_parent_sync_failure(&mut self) {
        self.replacement.parent_sync_failure = true;
    }
}

impl PreparedReplacement {
    fn prepare(target: &Path, bytes: &[u8]) -> std::io::Result<Self> {
        Self::prepare_with_sequence_source(target, bytes, || {
            NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed)
        })
    }

    fn prepare_with_sequence_source<F>(
        target: &Path,
        bytes: &[u8],
        mut next_sequence: F,
    ) -> std::io::Result<Self>
    where
        F: FnMut() -> u64,
    {
        let parent = target
            .parent()
            .ok_or_else(|| std::io::Error::other("state parent unavailable"))?;
        fs::create_dir_all(parent)?;
        let name = target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("state");
        for _ in 0..TEMPORARY_CREATE_ATTEMPTS {
            let sequence = next_sequence();
            let temporary = parent.join(format!(".{name}.{}.{}.tmp", std::process::id(), sequence));
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            options.mode(0o600);
            let file = match options.open(&temporary) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            };
            let replacement = Self {
                parent: parent.to_owned(),
                target: target.to_owned(),
                temporary: Some(temporary),
                #[cfg(test)]
                discard_failure: false,
                #[cfg(test)]
                parent_sync_failure: false,
            };
            write_and_sync(file, bytes)?;
            return Ok(replacement);
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "unique temporary state path unavailable",
        ))
    }

    fn rename(&mut self) -> std::io::Result<()> {
        let temporary = self
            .temporary
            .as_ref()
            .ok_or_else(|| std::io::Error::other("temporary state unavailable"))?;
        fs::rename(temporary, &self.target)?;
        self.temporary = None;
        Ok(())
    }

    fn sync_parent(&self) -> std::io::Result<()> {
        #[cfg(test)]
        if self.parent_sync_failure {
            return Err(std::io::Error::other(
                "injected parent-directory fsync failure",
            ));
        }
        File::open(&self.parent)?.sync_all()
    }

    fn discard(&mut self) -> std::io::Result<()> {
        #[cfg(test)]
        if self.discard_failure {
            return Err(std::io::Error::other("injected discard failure"));
        }
        let Some(temporary) = self.temporary.take() else {
            return Ok(());
        };
        match fs::remove_file(&temporary) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => {
                self.temporary = Some(temporary);
                Err(error)
            }
        }
    }
}

impl Drop for PreparedReplacement {
    fn drop(&mut self) {
        if let Some(temporary) = self.temporary.take() {
            match fs::remove_file(temporary) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => eprintln!("{}", drop_cleanup_failure_diagnostic()),
            }
        }
    }
}

fn discard_cleanup_failure_diagnostic(request_id: &str) -> String {
    format!("keiko-foundation-stage-discard-failed request={request_id}")
}

fn drop_cleanup_failure_diagnostic() -> &'static str {
    "keiko-foundation-stage-drop-cleanup-failed"
}

fn report_discard_cleanup_failure(request_id: &str) {
    eprintln!("{}", discard_cleanup_failure_diagnostic(request_id));
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
    let mut foundation = match foundation.lock() {
        Ok(foundation) => foundation,
        Err(_) => {
            let (request_id, _, _) = request_metadata(&accepted.request);
            let output = failed(request_id, ReasonCode::InternalFailure);
            return complete_immediate_dispatch(lifecycle, accepted, output);
        }
    };

    let dispatch = foundation.dispatch(&accepted.request, open_external);
    complete_prepared_dispatch(lifecycle, &mut foundation, accepted, dispatch)
}

fn complete_immediate_dispatch(
    lifecycle: &Mutex<HostLifecycle>,
    accepted: crate::AcceptedRequest,
    output: FoundationRequestOutput,
) -> FoundationRequestOutput {
    let (request_id, _, _) = request_metadata(&accepted.request);
    let request_id = request_id.to_owned();
    match lifecycle.lock() {
        Ok(mut lifecycle) => {
            let completion =
                lifecycle.complete_foundation_request(accepted, output.encoded, output.quit);
            FoundationRequestOutput {
                encoded: completion.encoded,
                quit: completion.quit,
            }
        }
        Err(_) => failed(&request_id, ReasonCode::InternalFailure),
    }
}

fn complete_prepared_dispatch(
    lifecycle: &Mutex<HostLifecycle>,
    foundation: &mut FoundationHost,
    accepted: crate::AcceptedRequest,
    dispatch: PreparedDispatch,
) -> FoundationRequestOutput {
    let (request_id, _, _) = request_metadata(&accepted.request);
    let request_id = request_id.to_owned();
    let completion = match lifecycle.lock() {
        Ok(mut lifecycle) => lifecycle.complete_foundation_request(
            accepted,
            dispatch.output.encoded.clone(),
            dispatch.output.quit,
        ),
        Err(_) => {
            if dispatch.discard().is_err() {
                report_discard_cleanup_failure(&request_id);
            }
            return failed(&request_id, ReasonCode::InternalFailure);
        }
    };
    finish_foundation_dispatch(foundation, dispatch, completion, &request_id)
}

fn finish_foundation_dispatch(
    foundation: &mut FoundationHost,
    dispatch: PreparedDispatch,
    completion: FoundationCompletion,
    request_id: &str,
) -> FoundationRequestOutput {
    if !completion.live {
        if dispatch.discard().is_err() {
            report_discard_cleanup_failure(request_id);
            return failed(request_id, ReasonCode::InternalFailure);
        }
        return FoundationRequestOutput {
            encoded: completion.encoded,
            quit: completion.quit,
        };
    }
    if dispatch
        .effect
        .is_some_and(|effect| effect.commit(foundation).is_err())
    {
        return failed(request_id, ReasonCode::InternalFailure);
    }
    FoundationRequestOutput {
        encoded: completion.encoded,
        quit: completion.quit,
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

#[cfg(test)]
fn write_welcome_state(path: &Path) -> std::io::Result<()> {
    let bytes = welcome_state_bytes()?;
    durable_replace(path, &bytes)
}

fn prepare_welcome_effect(
    path: &Path,
    candidate: FoundationApplication,
) -> std::io::Result<PreparedEffect> {
    let bytes = welcome_state_bytes()?;
    Ok(PreparedEffect {
        candidate,
        replacement: PreparedReplacement::prepare(path, &bytes)?,
    })
}

fn welcome_state_bytes() -> std::io::Result<Vec<u8>> {
    let bytes = serde_json::to_vec(&WelcomeState {
        schema_version: STATE_SCHEMA_VERSION,
        dismissed: true,
    })
    .map_err(std::io::Error::other)?;
    if bytes.len() as u64 > MAX_PERSISTED_STATE_BYTES {
        return Err(std::io::Error::other("welcome state exceeds boundary"));
    }
    Ok(bytes)
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

#[cfg(test)]
fn write_ime_state(path: &Path, committed_text: &str) -> std::io::Result<()> {
    let bytes = ime_state_bytes(committed_text)?;
    durable_replace(path, &bytes)
}

fn prepare_ime_effect(
    path: &Path,
    committed_text: &str,
    candidate: FoundationApplication,
) -> std::io::Result<PreparedEffect> {
    let bytes = ime_state_bytes(committed_text)?;
    Ok(PreparedEffect {
        candidate,
        replacement: PreparedReplacement::prepare(path, &bytes)?,
    })
}

fn ime_state_bytes(committed_text: &str) -> std::io::Result<Vec<u8>> {
    let bytes = serde_json::to_vec(&ImeState {
        schema_version: STATE_SCHEMA_VERSION,
        committed_text: committed_text.to_owned(),
    })
    .map_err(std::io::Error::other)?;
    if bytes.len() as u64 > MAX_IME_STATE_BYTES {
        return Err(std::io::Error::other("IME state exceeds boundary"));
    }
    Ok(bytes)
}

#[cfg(test)]
fn durable_replace(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut replacement = PreparedReplacement::prepare(path, bytes)?;
    replacement.rename()?;
    replacement.sync_parent()
}

fn write_and_sync(mut file: File, bytes: &[u8]) -> std::io::Result<()> {
    file.write_all(bytes)?;
    file.sync_all()
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
    use crate::AcceptedRequest;
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
            r#"{"schemaVersion":1,"dismissed":false}"#,
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

        let directory = temporary_state();
        fs::create_dir(&directory).expect("directory fixture");
        assert!(!read_welcome_state(&directory));
        fs::remove_dir(directory).expect("remove fixture");
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

        let directory = temporary_state();
        fs::create_dir(&directory).expect("directory fixture");
        assert_eq!(read_ime_state(&directory), None);
        fs::remove_dir(directory).expect("remove fixture");

        let state_path = temporary_state();
        let mut host = FoundationHost::new(state_path.clone());
        write_ime_state(&host.ime_state_path, "wiederhergestellt").expect("IME state");
        assert!(matches!(
            host.application().view(&current_build_identity()),
            Ok(keiko_application::ApplicationResult::Welcome { .. })
        ));
        assert!(matches!(
            host.application()
                .apply(FoundationIntent::ShowCanvas, &current_build_identity()),
            Ok(keiko_application::ApplicationResult::Canvas { committed_text })
                if committed_text == "wiederhergestellt"
        ));
        let _ = fs::remove_file(host.ime_state_path);
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
        assert!(!is_exact_allowed_url(REPOSITORY_URL, &"g".repeat(40)));
        assert!(!is_exact_allowed_url(REPOSITORY_URL, &"A".repeat(40)));
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
        assert!(
            call(8, r#"{"kind":"show-canvas"}"#, true)
                .encoded
                .contains("canvas")
        );
        assert!(
            call(
                9,
                r#"{"kind":"commit-canvas-text","committedText":"Grüße かな 😀"}"#,
                true
            )
            .encoded
            .contains("Grüße かな 😀")
        );
        let oversized = format!(
            r#"{{"kind":"commit-canvas-text","committedText":"{}"}}"#,
            "x".repeat(keiko_application::MAX_COMMITTED_TEXT_BYTES + 1)
        );
        assert!(
            call(10, &oversized, true)
                .encoded
                .contains("payload-too-large")
        );
        assert!(
            call(11, r#"{"kind":"application-health"}"#, true)
                .encoded
                .contains("unknown-operation")
        );
        assert!(call(12, r#"{"kind":"quit-application"}"#, true).quit);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn terminal_completion_withholds_quit_and_reports_the_terminal_reason() {
        let path = temporary_state();
        let foundation = Mutex::new(FoundationHost::new(path.clone()));
        let (lifecycle, generation, nonce) = session();
        let sender = SenderContext {
            window_label: "main".to_owned(),
            origin: "tauri://localhost".to_owned(),
            generation,
            document_nonce: nonce.clone(),
        };
        let cancellation = |sequence: u64| {
            format!(
                r#"{{"schemaVersion":1,"requestId":"{}"}}"#,
                canonical_request_id(generation, sequence).expect("request ID")
            )
            .into_bytes()
        };
        let quit = |sequence: u64| request(generation, sequence, r#"{"kind":"quit-application"}"#);
        let dispatch_quit = |accepted: &AcceptedRequest| {
            let mut host = foundation.lock().expect("foundation");
            host.dispatch(&accepted.request, |_| true)
        };
        let mut lifecycle = lifecycle.lock().expect("lifecycle");

        lifecycle.set_test_now_ms(0);
        let accepted = lifecycle
            .begin_application_request(&sender, quit(1).as_bytes())
            .expect("accepted");
        let output = dispatch_quit(&accepted);
        assert!(
            output.output.quit,
            "dispatch reports quit before completion"
        );
        assert!(
            lifecycle
                .cancel_application_request(&sender, &cancellation(1))
                .contains("cancelled")
        );
        let completion = lifecycle.complete_foundation_request(
            accepted,
            output.output.encoded,
            output.output.quit,
        );
        assert!(completion.encoded.contains("cancelled"));
        assert!(
            !completion.quit,
            "cancelled completion must withhold the exit"
        );

        lifecycle.set_test_now_ms(1000);
        let accepted = lifecycle
            .begin_application_request(&sender, quit(2).as_bytes())
            .expect("accepted");
        let output = dispatch_quit(&accepted);
        assert!(output.output.quit);
        lifecycle.set_test_now_ms(2000);
        let completion = lifecycle.complete_foundation_request(
            accepted,
            output.output.encoded,
            output.output.quit,
        );
        assert!(completion.encoded.contains("timed-out"));
        assert!(
            !completion.quit,
            "timed-out completion must withhold the exit"
        );

        lifecycle.set_test_now_ms(3000);
        let accepted = lifecycle
            .begin_application_request(&sender, quit(3).as_bytes())
            .expect("accepted");
        let output = dispatch_quit(&accepted);
        let quit_requested = output.output.quit;
        let completion =
            lifecycle.complete_foundation_request(accepted, output.output.encoded, quit_requested);
        assert!(!completion.encoded.contains("cancelled"));
        assert!(!completion.encoded.contains("timed-out"));
        assert!(completion.quit, "a live quit stays honored");

        drop(lifecycle);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn persistence_failures_are_bounded_and_do_not_publish_partial_state() {
        let blocking_parent = temporary_state();
        fs::write(&blocking_parent, "blocking file").expect("fixture");
        let foundation = Mutex::new(FoundationHost::new(blocking_parent.join("state.json")));
        let (lifecycle, generation, nonce) = session();
        let sender = SenderContext {
            window_label: "main".to_owned(),
            origin: "tauri://localhost".to_owned(),
            generation,
            document_nonce: nonce,
        };
        let dismiss = foundation_request(
            &lifecycle,
            &foundation,
            &sender,
            &request(generation, 1, r#"{"kind":"dismiss-welcome"}"#),
            |_| true,
        );
        assert!(dismiss.encoded.contains("internal-failure"));
        let commit = foundation_request(
            &lifecycle,
            &foundation,
            &sender,
            &request(
                generation,
                2,
                r#"{"kind":"commit-canvas-text","committedText":"safe"}"#,
            ),
            |_| true,
        );
        assert!(commit.encoded.contains("internal-failure"));
        assert_eq!(
            reason_for(FoundationError::InvalidBuildIdentity),
            ReasonCode::InternalFailure
        );
        let _ = fs::remove_file(blocking_parent);
    }

    fn sender(generation: u64, nonce: &str) -> SenderContext {
        SenderContext {
            window_label: "main".to_owned(),
            origin: "tauri://localhost".to_owned(),
            generation,
            document_nonce: nonce.to_owned(),
        }
    }

    fn cancel(lifecycle: &mut HostLifecycle, sender: &SenderContext, sequence: u64) {
        let cancellation = format!(
            r#"{{"schemaVersion":1,"requestId":"{}"}}"#,
            canonical_request_id(sender.generation, sequence).expect("request ID")
        );
        assert!(
            lifecycle
                .cancel_application_request(sender, cancellation.as_bytes())
                .contains("cancelled")
        );
    }

    fn prepared_temporary(dispatch: &PreparedDispatch) -> PathBuf {
        dispatch
            .effect
            .as_ref()
            .and_then(PreparedEffect::temporary_path)
            .expect("prepared temporary")
            .to_owned()
    }

    #[test]
    fn completion_gate_discards_cancelled_and_timed_out_welcome_effects() {
        for (sequence, terminal_reason) in [(1, "cancelled"), (2, "timed-out")] {
            let path = temporary_state();
            let mut foundation = FoundationHost::new(path.clone());
            let before = foundation.application().clone();
            let (lifecycle, generation, nonce) = session();
            let sender = sender(generation, &nonce);
            let dismiss = request(generation, sequence, r#"{"kind":"dismiss-welcome"}"#);

            let accepted = {
                let mut lifecycle = lifecycle.lock().expect("lifecycle");
                lifecycle.set_test_now_ms(0);
                lifecycle
                    .begin_application_request(&sender, dismiss.as_bytes())
                    .expect("accepted")
            };
            let dispatch = foundation.dispatch(&accepted.request, |_| true);
            let temporary = prepared_temporary(&dispatch);
            assert!(!path.exists(), "preparation must not replace the target");
            assert!(temporary.exists(), "preparation owns a staged file");

            let completion = {
                let mut lifecycle = lifecycle.lock().expect("lifecycle");
                if terminal_reason == "cancelled" {
                    cancel(&mut lifecycle, &sender, sequence);
                } else {
                    lifecycle.set_test_now_ms(1000);
                }
                lifecycle.complete_foundation_request(
                    accepted,
                    dispatch.output.encoded.clone(),
                    dispatch.output.quit,
                )
            };
            let output = finish_foundation_dispatch(
                &mut foundation,
                dispatch,
                completion,
                &canonical_request_id(generation, sequence).expect("request ID"),
            );

            assert!(output.encoded.contains(terminal_reason));
            assert_eq!(foundation.application, Some(before));
            assert!(!path.exists(), "terminal completion must preserve old disk");
            assert!(
                !temporary.exists(),
                "terminal completion must clean the stage"
            );
            let mut relaunched = FoundationHost::new(path.clone());
            assert!(matches!(
                relaunched.application().view(&current_build_identity()),
                Ok(keiko_application::ApplicationResult::Welcome { .. })
            ));
            let _ = fs::remove_file(path);
        }
    }

    #[test]
    fn completion_gate_discards_cancelled_and_timed_out_ime_effects() {
        for (sequence, terminal_reason) in [(1, "cancelled"), (2, "timed-out")] {
            let path = temporary_state();
            write_welcome_state(&path).expect("dismissed fixture");
            let mut foundation = FoundationHost::new(path.clone());
            write_ime_state(&foundation.ime_state_path, "old").expect("IME fixture");
            let before = foundation.application().clone();
            let (lifecycle, generation, nonce) = session();
            let sender = sender(generation, &nonce);
            let commit = request(
                generation,
                sequence,
                r#"{"kind":"commit-canvas-text","committedText":"new"}"#,
            );

            let accepted = {
                let mut lifecycle = lifecycle.lock().expect("lifecycle");
                lifecycle.set_test_now_ms(0);
                lifecycle
                    .begin_application_request(&sender, commit.as_bytes())
                    .expect("accepted")
            };
            let dispatch = foundation.dispatch(&accepted.request, |_| true);
            let temporary = prepared_temporary(&dispatch);
            assert_eq!(
                read_ime_state(&foundation.ime_state_path).as_deref(),
                Some("old")
            );

            let completion = {
                let mut lifecycle = lifecycle.lock().expect("lifecycle");
                if terminal_reason == "cancelled" {
                    cancel(&mut lifecycle, &sender, sequence);
                } else {
                    lifecycle.set_test_now_ms(1000);
                }
                lifecycle.complete_foundation_request(
                    accepted,
                    dispatch.output.encoded.clone(),
                    dispatch.output.quit,
                )
            };
            let output = finish_foundation_dispatch(
                &mut foundation,
                dispatch,
                completion,
                &canonical_request_id(generation, sequence).expect("request ID"),
            );

            assert!(output.encoded.contains(terminal_reason));
            assert_eq!(foundation.application, Some(before));
            assert_eq!(
                read_ime_state(&foundation.ime_state_path).as_deref(),
                Some("old")
            );
            assert!(
                !temporary.exists(),
                "terminal completion must clean the stage"
            );
            assert!(matches!(
                foundation
                    .application()
                    .apply(FoundationIntent::ShowCanvas, &current_build_identity()),
                Ok(keiko_application::ApplicationResult::Canvas { committed_text })
                    if committed_text == "old"
            ));
            let mut relaunched = FoundationHost::new(path.clone());
            assert!(matches!(
                relaunched.application().view(&current_build_identity()),
                Ok(keiko_application::ApplicationResult::Canvas { committed_text })
                    if committed_text == "old"
            ));
            let _ = fs::remove_file(foundation.ime_state_path);
            let _ = fs::remove_file(path);
        }
    }

    #[test]
    fn unavailable_and_poisoned_completion_discard_prepared_effects() {
        let path = temporary_state();
        let mut foundation = FoundationHost::new(path.clone());
        let before = foundation.application().clone();
        let (lifecycle, generation, nonce) = session();
        let sender = sender(generation, &nonce);
        let dismiss = request(generation, 1, r#"{"kind":"dismiss-welcome"}"#);
        let accepted = {
            let mut lifecycle = lifecycle.lock().expect("lifecycle");
            lifecycle
                .begin_application_request(&sender, dismiss.as_bytes())
                .expect("accepted")
        };
        let dispatch = foundation.dispatch(&accepted.request, |_| true);
        let temporary = prepared_temporary(&dispatch);
        let completion = lifecycle
            .lock()
            .expect("lifecycle")
            .complete_foundation_request_with_availability(
                accepted,
                dispatch.output.encoded.clone(),
                dispatch.output.quit,
                false,
            );
        let output = finish_foundation_dispatch(
            &mut foundation,
            dispatch,
            completion,
            &canonical_request_id(generation, 1).expect("request ID"),
        );
        assert!(output.encoded.contains("host-unavailable"));
        assert_eq!(foundation.application, Some(before));
        assert!(!path.exists());
        assert!(!temporary.exists());

        let ime_path = foundation.ime_state_path.clone();
        write_ime_state(&ime_path, "old").expect("IME fixture");
        let commit = request(
            generation,
            2,
            r#"{"kind":"commit-canvas-text","committedText":"new"}"#,
        );
        let before_poison = foundation.application().clone();
        let accepted = lifecycle
            .lock()
            .expect("lifecycle")
            .begin_application_request(&sender, commit.as_bytes())
            .expect("accepted");
        let mut dispatch = foundation.dispatch(&accepted.request, |_| true);
        let temporary = prepared_temporary(&dispatch);
        dispatch
            .effect
            .as_mut()
            .expect("prepared effect")
            .inject_discard_failure();
        let _ = std::panic::catch_unwind(|| {
            let lifecycle_guard = lifecycle.lock().expect("lifecycle");
            assert!(lifecycle_guard.accepting);
            panic!("poison lifecycle");
        });
        let output = complete_prepared_dispatch(&lifecycle, &mut foundation, accepted, dispatch);
        assert!(
            output
                .encoded
                .contains(&canonical_request_id(generation, 2).expect("request ID"))
        );
        assert!(output.encoded.contains("internal-failure"));
        assert_eq!(read_ime_state(&ime_path).as_deref(), Some("old"));
        assert_eq!(foundation.application, Some(before_poison));
        assert!(!temporary.exists());
        let _ = fs::remove_file(ime_path);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn poisoned_completion_reports_failure_after_successful_discard() {
        let path = temporary_state();
        let mut foundation = FoundationHost::new(path.clone());
        let before = foundation.application().clone();
        let (lifecycle, generation, nonce) = session();
        let sender = sender(generation, &nonce);
        let dismiss = request(generation, 1, r#"{"kind":"dismiss-welcome"}"#);
        let accepted = lifecycle
            .lock()
            .expect("lifecycle")
            .begin_application_request(&sender, dismiss.as_bytes())
            .expect("accepted");
        let dispatch = foundation.dispatch(&accepted.request, |_| true);
        let temporary = prepared_temporary(&dispatch);
        let _ = std::panic::catch_unwind(|| {
            let lifecycle_guard = lifecycle.lock().expect("lifecycle");
            assert!(lifecycle_guard.accepting);
            panic!("poison lifecycle");
        });

        let output = complete_prepared_dispatch(&lifecycle, &mut foundation, accepted, dispatch);

        assert!(output.encoded.contains("internal-failure"));
        assert_eq!(foundation.application, Some(before));
        assert!(!path.exists());
        assert!(!temporary.exists());
    }

    #[test]
    fn foundation_lock_failure_occurs_after_request_registration() {
        let path = temporary_state();
        let foundation = Mutex::new(FoundationHost::new(path.clone()));
        let (lifecycle, generation, nonce) = session();
        let sender = sender(generation, &nonce);
        let _ = std::panic::catch_unwind(|| {
            let foundation_guard = foundation.lock().expect("foundation");
            assert!(foundation_guard.application.is_none());
            panic!("poison foundation");
        });

        let output = foundation_request(
            &lifecycle,
            &foundation,
            &sender,
            &request(generation, 1, r#"{"kind":"dismiss-welcome"}"#),
            |_| true,
        );
        let request_id = canonical_request_id(generation, 1).expect("request ID");
        assert!(output.encoded.contains(&request_id));
        assert!(output.encoded.contains("internal-failure"));
        assert!(
            lifecycle.lock().expect("lifecycle").in_flight.is_empty(),
            "registered request must still complete exactly once"
        );
        assert!(!path.exists());
    }

    #[test]
    fn timeout_accounting_starts_before_foundation_host_acquisition() {
        let path = temporary_state();
        let mut foundation = FoundationHost::new(path.clone());
        let (lifecycle, generation, nonce) = session();
        let sender = sender(generation, &nonce);
        let dismiss = request(generation, 1, r#"{"kind":"dismiss-welcome"}"#);
        let accepted = {
            let mut lifecycle = lifecycle.lock().expect("lifecycle");
            lifecycle.set_test_now_ms(0);
            lifecycle
                .begin_application_request(&sender, dismiss.as_bytes())
                .expect("registered before host acquisition")
        };

        lifecycle.lock().expect("lifecycle").set_test_now_ms(1000);
        let dispatch = foundation.dispatch(&accepted.request, |_| true);
        let temporary = prepared_temporary(&dispatch);
        let completion = lifecycle
            .lock()
            .expect("lifecycle")
            .complete_foundation_request(
                accepted,
                dispatch.output.encoded.clone(),
                dispatch.output.quit,
            );
        let output = finish_foundation_dispatch(
            &mut foundation,
            dispatch,
            completion,
            &canonical_request_id(generation, 1).expect("request ID"),
        );

        assert!(output.encoded.contains("timed-out"));
        assert!(!path.exists());
        assert!(!temporary.exists());
    }

    #[test]
    fn discard_failure_is_request_bound_and_drop_still_cleans_the_stage() {
        let path = temporary_state();
        let mut foundation = FoundationHost::new(path.clone());
        let (lifecycle, generation, nonce) = session();
        let sender = sender(generation, &nonce);
        let dismiss = request(generation, 1, r#"{"kind":"dismiss-welcome"}"#);
        let accepted = {
            let mut lifecycle = lifecycle.lock().expect("lifecycle");
            lifecycle
                .begin_application_request(&sender, dismiss.as_bytes())
                .expect("accepted")
        };
        let mut dispatch = foundation.dispatch(&accepted.request, |_| true);
        let temporary = prepared_temporary(&dispatch);
        dispatch
            .effect
            .as_mut()
            .expect("prepared effect")
            .inject_discard_failure();
        let completion = {
            let mut lifecycle = lifecycle.lock().expect("lifecycle");
            cancel(&mut lifecycle, &sender, 1);
            lifecycle.complete_foundation_request(
                accepted,
                dispatch.output.encoded.clone(),
                dispatch.output.quit,
            )
        };
        let request_id = canonical_request_id(generation, 1).expect("request ID");
        let output = finish_foundation_dispatch(&mut foundation, dispatch, completion, &request_id);

        assert!(output.encoded.contains(&request_id));
        assert!(output.encoded.contains("internal-failure"));
        assert!(!path.exists());
        assert!(!temporary.exists(), "Drop remains the best-effort fallback");
    }

    #[test]
    fn temporary_name_collision_retries_without_deleting_the_collision() {
        let path = temporary_state();
        let parent = path.parent().expect("state parent");
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("name");
        let collision = parent.join(format!(".{name}.{}.7.tmp", std::process::id()));
        fs::write(&collision, "unrelated").expect("collision fixture");
        let mut sequences = [7, 8].into_iter();

        let replacement =
            PreparedReplacement::prepare_with_sequence_source(&path, b"candidate", || {
                sequences.next().expect("bounded retry")
            })
            .expect("collision-safe stage");
        assert_eq!(
            fs::read_to_string(&collision).expect("collision preserved"),
            "unrelated"
        );
        assert_ne!(replacement.temporary.as_deref(), Some(collision.as_path()));
        drop(replacement);
        assert!(collision.exists(), "unrelated collision remains untouched");

        let _ = fs::remove_file(collision);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn discard_handles_immediate_already_discarded_and_missing_stages() {
        PreparedDispatch::immediate(failed("request", ReasonCode::InternalFailure))
            .discard()
            .expect("immediate dispatch has no effect");

        let path = temporary_state();
        let mut discarded =
            PreparedReplacement::prepare(&path, b"discarded").expect("prepared stage");
        discarded.discard().expect("first discard");
        discarded.discard().expect("already discarded");

        let mut missing = PreparedReplacement::prepare(&path, b"missing").expect("prepared stage");
        let temporary = missing.temporary.as_deref().expect("temporary").to_owned();
        fs::remove_file(temporary).expect("externally removed stage");
        missing
            .discard()
            .expect("missing stage is already discarded");

        let mut blocked = PreparedReplacement::prepare(&path, b"blocked").expect("prepared stage");
        let temporary = blocked.temporary.as_deref().expect("temporary").to_owned();
        fs::remove_file(&temporary).expect("replace stage fixture");
        fs::create_dir(&temporary).expect("blocking directory fixture");
        blocked
            .discard()
            .expect_err("non-file cleanup fails closed");
        assert_eq!(blocked.temporary.as_deref(), Some(temporary.as_path()));
        fs::remove_dir(temporary).expect("remove blocking directory");
    }

    #[test]
    fn cleanup_failure_diagnostics_are_correlated_and_redacted() {
        assert_eq!(
            discard_cleanup_failure_diagnostic("request-1"),
            "keiko-foundation-stage-discard-failed request=request-1"
        );
        assert_eq!(
            drop_cleanup_failure_diagnostic(),
            "keiko-foundation-stage-drop-cleanup-failed"
        );
    }

    #[test]
    fn drop_cleanup_failure_preserves_the_unknown_entry() {
        let path = temporary_state();
        let replacement =
            PreparedReplacement::prepare(&path, b"candidate").expect("prepared stage");
        let temporary = replacement
            .temporary
            .as_deref()
            .expect("temporary")
            .to_owned();
        fs::remove_file(&temporary).expect("replace staged file");
        fs::create_dir(&temporary).expect("unknown entry fixture");

        drop(replacement);

        assert!(
            temporary.is_dir(),
            "fallback cleanup must not remove an unknown non-file entry"
        );
        fs::remove_dir(temporary).expect("remove unknown entry fixture");
    }

    #[test]
    fn drop_treats_an_already_missing_stage_as_cleaned() {
        let path = temporary_state();
        let replacement =
            PreparedReplacement::prepare(&path, b"candidate").expect("prepared stage");
        let temporary = replacement
            .temporary
            .as_deref()
            .expect("temporary")
            .to_owned();
        fs::remove_file(&temporary).expect("externally removed stage");

        drop(replacement);

        assert!(!temporary.exists());
    }

    #[test]
    fn temporary_collision_exhaustion_and_open_failure_are_bounded() {
        let path = temporary_state();
        let parent = path.parent().expect("state parent");
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("name");
        let collision = parent.join(format!(".{name}.{}.11.tmp", std::process::id()));
        fs::write(&collision, "unrelated").expect("collision fixture");
        let exhausted =
            PreparedReplacement::prepare_with_sequence_source(&path, b"candidate", || 11)
                .expect_err("bounded collisions fail closed");
        assert_eq!(exhausted.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read_to_string(&collision).expect("collision preserved"),
            "unrelated"
        );

        let overlong_target = parent.join("x".repeat(256));
        let open_failure = PreparedReplacement::prepare_with_sequence_source(
            &overlong_target,
            b"candidate",
            || 12,
        )
        .expect_err("overlong stage name fails to open");
        assert_ne!(
            open_failure.kind(),
            std::io::ErrorKind::AlreadyExists,
            "open failure must take the non-collision branch"
        );

        let _ = fs::remove_file(collision);
    }

    #[test]
    fn live_completion_commits_both_mutators_and_relaunches_the_new_state() {
        let path = temporary_state();
        let foundation = Mutex::new(FoundationHost::new(path.clone()));
        let (lifecycle, generation, nonce) = session();
        let sender = sender(generation, &nonce);

        let dismiss = foundation_request(
            &lifecycle,
            &foundation,
            &sender,
            &request(generation, 1, r#"{"kind":"dismiss-welcome"}"#),
            |_| true,
        );
        assert!(dismiss.encoded.contains("canvas"));
        assert!(read_welcome_state(&path));

        let commit = foundation_request(
            &lifecycle,
            &foundation,
            &sender,
            &request(
                generation,
                2,
                r#"{"kind":"commit-canvas-text","committedText":"new"}"#,
            ),
            |_| true,
        );
        assert!(commit.encoded.contains(r#""committedText":"new""#));
        let ime_path = foundation
            .lock()
            .expect("foundation")
            .ime_state_path
            .clone();
        assert_eq!(read_ime_state(&ime_path).as_deref(), Some("new"));

        let mut relaunched = FoundationHost::new(path.clone());
        assert!(matches!(
            relaunched.application().view(&current_build_identity()),
            Ok(keiko_application::ApplicationResult::Canvas { committed_text })
                if committed_text == "new"
        ));
        let _ = fs::remove_file(ime_path);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rename_boundary_reconciles_pre_and_post_commit_failures() {
        let path = temporary_state();
        let mut foundation = FoundationHost::new(path.clone());
        let before = foundation.application().clone();
        let (lifecycle, generation, nonce) = session();
        let sender = sender(generation, &nonce);
        let dismiss = request(generation, 1, r#"{"kind":"dismiss-welcome"}"#);
        let accepted = lifecycle
            .lock()
            .expect("lifecycle")
            .begin_application_request(&sender, dismiss.as_bytes())
            .expect("accepted");
        let dispatch = foundation.dispatch(&accepted.request, |_| true);
        let temporary = prepared_temporary(&dispatch);
        fs::remove_file(&temporary).expect("inject pre-rename failure");
        let completion = lifecycle
            .lock()
            .expect("lifecycle")
            .complete_foundation_request(
                accepted,
                dispatch.output.encoded.clone(),
                dispatch.output.quit,
            );
        let request_id = canonical_request_id(generation, 1).expect("request ID");
        let output = finish_foundation_dispatch(&mut foundation, dispatch, completion, &request_id);
        assert!(output.encoded.contains(&request_id));
        assert!(output.encoded.contains("internal-failure"));
        assert_eq!(foundation.application, Some(before));
        assert!(!path.exists());

        write_welcome_state(&path).expect("dismissed fixture");
        write_ime_state(&foundation.ime_state_path, "old").expect("IME fixture");
        foundation.application = None;
        let commit = request(
            generation,
            2,
            r#"{"kind":"commit-canvas-text","committedText":"new"}"#,
        );
        let accepted = lifecycle
            .lock()
            .expect("lifecycle")
            .begin_application_request(&sender, commit.as_bytes())
            .expect("accepted");
        let mut dispatch = foundation.dispatch(&accepted.request, |_| true);
        let temporary = prepared_temporary(&dispatch);
        let completion = lifecycle
            .lock()
            .expect("lifecycle")
            .complete_foundation_request(
                accepted,
                dispatch.output.encoded.clone(),
                dispatch.output.quit,
            );
        assert!(completion.live);
        dispatch
            .effect
            .as_mut()
            .expect("prepared effect")
            .inject_parent_sync_failure();
        let request_id = canonical_request_id(generation, 2).expect("request ID");
        let output = finish_foundation_dispatch(&mut foundation, dispatch, completion, &request_id);
        assert!(
            output.encoded.contains(&request_id),
            "post-commit failure remains request-bound"
        );
        assert!(output.encoded.contains("internal-failure"));
        assert_eq!(
            read_ime_state(&foundation.ime_state_path).as_deref(),
            Some("new")
        );
        assert!(!temporary.exists(), "renamed stage is no longer owned");
        assert!(matches!(
            foundation.application().view(&current_build_identity()),
            Ok(keiko_application::ApplicationResult::Canvas { committed_text })
                if committed_text == "new"
        ));
        let _ = fs::remove_file(foundation.ime_state_path);
        let _ = fs::remove_file(path);
    }
}
