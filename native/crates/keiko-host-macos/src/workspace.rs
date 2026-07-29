use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use keiko_application::workspace::{
    MAX_WORKSPACE_DISPLAY_LABEL_BYTES, ValidatedWorkspace, WorkspaceApplication,
    WorkspaceClosedReason, WorkspaceError, WorkspaceRootIdentity, WorkspaceView,
};
use keiko_application::{ApplicationResult, application_response};
use keiko_ui_port::{
    Operation, ReasonCode, encode_error, encode_success, request_metadata, request_operation,
};

use crate::{AcceptedRequest, HostLifecycle, SenderContext};

#[derive(Debug, Eq, PartialEq)]
pub enum FolderPickerResult {
    Selected(PathBuf),
    Cancelled,
    Unavailable,
}

#[derive(Debug, Eq, PartialEq)]
struct InspectedWorkspace {
    canonical_root: PathBuf,
    display_label: String,
    root_identity: WorkspaceRootIdentity,
}

#[derive(Debug, Default)]
pub struct WorkspaceHost {
    application: WorkspaceApplication,
    bound_root: Option<InspectedWorkspace>,
}

fn retire_bound_root_after<T>(
    bound_root: &mut Option<InspectedWorkspace>,
    transition: impl FnOnce() -> Result<T, WorkspaceError>,
) -> Result<T, WorkspaceError> {
    let result = transition()?;
    *bound_root = None;
    Ok(result)
}

impl WorkspaceHost {
    pub(crate) fn bound_root_for_isolation(&self) -> Option<PathBuf> {
        self.bound_root
            .as_ref()
            .map(|bound| bound.canonical_root.clone())
    }

    fn begin_selection(&mut self) -> Result<u64, WorkspaceError> {
        retire_bound_root_after(&mut self.bound_root, || self.application.begin_selection())
    }

    fn finish_selection(
        &mut self,
        generation: u64,
        picker_result: FolderPickerResult,
    ) -> Result<WorkspaceView, WorkspaceError> {
        match picker_result {
            FolderPickerResult::Selected(path) => match inspect_workspace_root(&path) {
                Ok(inspected) => {
                    let selection = ValidatedWorkspace::new(
                        inspected.root_identity,
                        inspected.display_label.clone(),
                    )?;
                    self.application.accept_selection(generation, selection)?;
                    self.bound_root = Some(inspected);
                }
                Err(reason) => self.application.close_selection(generation, reason)?,
            },
            FolderPickerResult::Cancelled => self
                .application
                .close_selection(generation, WorkspaceClosedReason::Cancelled)?,
            FolderPickerResult::Unavailable => self
                .application
                .close_selection(generation, WorkspaceClosedReason::Unavailable)?,
        }
        Ok(self.application.view())
    }

    pub fn select(
        &mut self,
        picker_result: FolderPickerResult,
    ) -> Result<WorkspaceView, WorkspaceError> {
        let generation = self.begin_selection()?;
        self.finish_selection(generation, picker_result)
    }

    pub fn status(&mut self) -> Result<WorkspaceView, WorkspaceError> {
        let Some(bound) = self.bound_root.as_ref() else {
            return Ok(self.application.view());
        };
        let generation = self.application.current_generation();
        let revalidated = inspect_workspace_root(&bound.canonical_root);
        let reason = match revalidated {
            Ok(current) if current.root_identity == bound.root_identity => {
                return Ok(self.application.view());
            }
            Ok(_) => WorkspaceClosedReason::Unsafe,
            Err(reason) => reason,
        };
        self.application.close_binding(generation, reason)?;
        self.bound_root = None;
        Ok(self.application.view())
    }

    pub fn clear(&mut self) -> Result<WorkspaceView, WorkspaceError> {
        retire_bound_root_after(&mut self.bound_root, || self.application.clear())?;
        Ok(self.application.view())
    }

    fn abort_selection(&mut self, generation: u64) {
        if self
            .application
            .close_if_current(generation, WorkspaceClosedReason::Unavailable)
        {
            self.bound_root = None;
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct WorkspaceRequestOutput {
    pub encoded: String,
    pub acknowledged_status: bool,
}

pub fn workspace_request(
    lifecycle: &Mutex<HostLifecycle>,
    workspace: &Mutex<WorkspaceHost>,
    sender: &SenderContext,
    request: &str,
    picker: Box<dyn FnOnce() -> FolderPickerResult + '_>,
) -> WorkspaceRequestOutput {
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
    match request_operation(&accepted.request) {
        Operation::WorkspaceSelect => select_workspace(lifecycle, workspace, accepted, picker),
        Operation::WorkspaceStatus => finish_immediate(
            lifecycle,
            accepted,
            workspace.lock().map_or_else(
                |_| Err(WorkspaceError::StaleGeneration),
                |mut workspace| workspace.status(),
            ),
            true,
        ),
        Operation::WorkspaceClear => finish_immediate(
            lifecycle,
            accepted,
            workspace.lock().map_or_else(
                |_| Err(WorkspaceError::StaleGeneration),
                |mut workspace| workspace.clear(),
            ),
            false,
        ),
        _ => finish_encoded(
            lifecycle,
            accepted,
            encode_error("unknown-request", ReasonCode::UnknownOperation),
        ),
    }
}

fn select_workspace(
    lifecycle: &Mutex<HostLifecycle>,
    workspace: &Mutex<WorkspaceHost>,
    accepted: AcceptedRequest,
    picker: Box<dyn FnOnce() -> FolderPickerResult + '_>,
) -> WorkspaceRequestOutput {
    let generation = match workspace.lock() {
        Ok(mut workspace) => match workspace.begin_selection() {
            Ok(generation) => generation,
            Err(_) => {
                return finish_encoded(
                    lifecycle,
                    accepted,
                    encode_error("unknown-request", ReasonCode::InternalFailure),
                );
            }
        },
        Err(_) => {
            return finish_encoded(
                lifecycle,
                accepted,
                encode_error("unknown-request", ReasonCode::InternalFailure),
            );
        }
    };
    let picker_result = picker();
    let resumed = lifecycle
        .lock()
        .is_ok_and(|mut lifecycle| lifecycle.resume_after_user_interaction(&accepted));
    if !resumed {
        if let Ok(mut workspace) = workspace.lock() {
            workspace.abort_selection(generation);
        }
        return failed("unknown-request", ReasonCode::InternalFailure);
    }
    let mut workspace = match workspace.lock() {
        Ok(workspace) => workspace,
        Err(_) => {
            return finish_encoded(
                lifecycle,
                accepted,
                encode_error("unknown-request", ReasonCode::InternalFailure),
            );
        }
    };
    let view = match workspace.finish_selection(generation, picker_result) {
        Ok(view) => view,
        Err(_) => {
            workspace.abort_selection(generation);
            return finish_encoded(
                lifecycle,
                accepted,
                encode_error("unknown-request", ReasonCode::InternalFailure),
            );
        }
    };
    let encoded = encode_workspace(&accepted, view);
    let completion = match lifecycle.lock() {
        Ok(mut lifecycle) => lifecycle.complete_foundation_request(accepted, encoded, false),
        Err(_) => {
            workspace.abort_selection(generation);
            return failed("unknown-request", ReasonCode::InternalFailure);
        }
    };
    if !completion.live {
        workspace.abort_selection(generation);
    }
    WorkspaceRequestOutput {
        encoded: completion.encoded,
        acknowledged_status: false,
    }
}

fn finish_immediate(
    lifecycle: &Mutex<HostLifecycle>,
    accepted: AcceptedRequest,
    view: Result<WorkspaceView, WorkspaceError>,
    acknowledge_status: bool,
) -> WorkspaceRequestOutput {
    match view {
        Ok(view) => {
            let encoded = encode_workspace(&accepted, view);
            finish_encoded_with_status_acknowledgement(
                lifecycle,
                accepted,
                encoded,
                acknowledge_status,
            )
        }
        Err(_) => finish_encoded(
            lifecycle,
            accepted,
            encode_error("unknown-request", ReasonCode::InternalFailure),
        ),
    }
}

fn finish_encoded(
    lifecycle: &Mutex<HostLifecycle>,
    accepted: AcceptedRequest,
    encoded: String,
) -> WorkspaceRequestOutput {
    finish_encoded_with_status_acknowledgement(lifecycle, accepted, encoded, false)
}

fn finish_encoded_with_status_acknowledgement(
    lifecycle: &Mutex<HostLifecycle>,
    accepted: AcceptedRequest,
    encoded: String,
    acknowledge_status: bool,
) -> WorkspaceRequestOutput {
    let (request_id, _, _) = request_metadata(&accepted.request);
    let request_id = request_id.to_owned();
    match lifecycle.lock() {
        Ok(mut lifecycle) => {
            let completion = lifecycle.complete_foundation_request(accepted, encoded, false);
            WorkspaceRequestOutput {
                acknowledged_status: acknowledge_status && completion.live,
                encoded: completion.encoded,
            }
        }
        Err(_) => failed(&request_id, ReasonCode::InternalFailure),
    }
}

fn encode_workspace(accepted: &AcceptedRequest, state: WorkspaceView) -> String {
    let (request_id, _, _) = request_metadata(&accepted.request);
    encode_success(&application_response(
        request_id,
        ApplicationResult::Workspace { state },
    ))
}

fn failed(request_id: &str, reason: ReasonCode) -> WorkspaceRequestOutput {
    WorkspaceRequestOutput {
        encoded: encode_error(request_id, reason),
        acknowledged_status: false,
    }
}

fn inspect_workspace_root(path: &Path) -> Result<InspectedWorkspace, WorkspaceClosedReason> {
    if !path.is_absolute() {
        return Err(WorkspaceClosedReason::Invalid);
    }
    let selected_metadata = fs::symlink_metadata(path).map_err(classify_io_error)?;
    if selected_metadata.file_type().is_symlink() {
        return Err(WorkspaceClosedReason::Unsafe);
    }
    if !selected_metadata.is_dir() {
        return Err(WorkspaceClosedReason::Invalid);
    }
    let canonical_root = fs::canonicalize(path).map_err(classify_io_error)?;
    if canonical_root != path && !is_macos_private_var_alias(path, &canonical_root) {
        return Err(WorkspaceClosedReason::Unsafe);
    }

    let git_marker = canonical_root.join(".git");
    let git_metadata = fs::symlink_metadata(&git_marker).map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            WorkspaceClosedReason::Invalid
        } else {
            classify_io_error(error)
        }
    })?;
    if git_metadata.file_type().is_symlink() {
        return Err(WorkspaceClosedReason::Unsafe);
    }
    if !git_metadata.is_dir() {
        return Err(WorkspaceClosedReason::Invalid);
    }
    let canonical_git = fs::canonicalize(&git_marker).map_err(classify_io_error)?;
    if canonical_git != git_marker || !canonical_git.starts_with(&canonical_root) {
        return Err(WorkspaceClosedReason::Unsafe);
    }

    let display_label = safe_display_label(&canonical_root);
    Ok(InspectedWorkspace {
        canonical_root,
        display_label,
        root_identity: WorkspaceRootIdentity::new(selected_metadata.dev(), selected_metadata.ino()),
    })
}

fn is_macos_private_var_alias(selected: &Path, canonical: &Path) -> bool {
    let Ok(suffix) = selected.strip_prefix("/var") else {
        return false;
    };
    canonical == Path::new("/private/var").join(suffix)
}

fn classify_io_error(error: std::io::Error) -> WorkspaceClosedReason {
    match error.kind() {
        ErrorKind::PermissionDenied => WorkspaceClosedReason::PermissionDenied,
        ErrorKind::NotFound => WorkspaceClosedReason::Unavailable,
        ErrorKind::InvalidInput | ErrorKind::NotADirectory => WorkspaceClosedReason::Invalid,
        _ => WorkspaceClosedReason::Unavailable,
    }
}

fn safe_display_label(root: &Path) -> String {
    let Some(label) = root.file_name().and_then(|label| label.to_str()) else {
        return "Local repository".to_owned();
    };
    if label.trim().is_empty() || label.chars().any(char::is_control) {
        return "Local repository".to_owned();
    }
    let mut bounded = String::new();
    for character in label.chars() {
        if bounded.len() + character.len_utf8() > MAX_WORKSPACE_DISPLAY_LABEL_BYTES {
            break;
        }
        bounded.push(character);
    }
    bounded
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::fs::symlink;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    use keiko_ui_port::canonical_request_id;

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "keiko-native-workspace-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).expect("sanitized fixture");
            Self { root }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn request(generation: u64, sequence: u64, operation: &str) -> String {
        format!(
            r#"{{"schemaVersion":1,"requestId":"{}","sequence":{sequence},"timeoutMs":1000,"operation":{{"kind":"{operation}"}}}}"#,
            canonical_request_id(generation, sequence).expect("request identifier")
        )
    }

    fn session() -> (Mutex<HostLifecycle>, SenderContext) {
        let nonce = "a".repeat(64);
        let mut lifecycle = HostLifecycle::default();
        let generation = lifecycle
            .begin_renderer_session(nonce.clone())
            .expect("renderer generation");
        let sender = lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce);
        (Mutex::new(lifecycle), sender)
    }

    #[test]
    fn bounded_metadata_checks_accept_one_git_root_and_reject_non_roots_and_symlinks() {
        let repository = Fixture::new();
        fs::create_dir(repository.root.join(".git")).expect("Git marker");
        let inspected = inspect_workspace_root(&repository.root).expect("valid Git root");
        assert_eq!(
            inspected.display_label,
            repository.root.file_name().unwrap().to_string_lossy()
        );

        let non_repository = Fixture::new();
        assert_eq!(
            inspect_workspace_root(&non_repository.root),
            Err(WorkspaceClosedReason::Invalid)
        );

        let alias_parent = Fixture::new();
        let alias = alias_parent.root.join("alias");
        symlink(&repository.root, &alias).expect("symlink fixture");
        assert_eq!(
            inspect_workspace_root(&alias),
            Err(WorkspaceClosedReason::Unsafe)
        );
    }

    #[test]
    fn malformed_unavailable_and_unauthorized_roots_have_distinct_closed_reasons() {
        assert_eq!(safe_display_label(Path::new("/")), "Local repository");
        assert_eq!(
            safe_display_label(Path::new("/tmp/unsafe\nlabel")),
            "Local repository"
        );
        assert_eq!(
            safe_display_label(Path::new(&format!(
                "/tmp/{}",
                "x".repeat(MAX_WORKSPACE_DISPLAY_LABEL_BYTES + 1)
            )))
            .len(),
            MAX_WORKSPACE_DISPLAY_LABEL_BYTES
        );
        assert_eq!(
            inspect_workspace_root(Path::new("relative")),
            Err(WorkspaceClosedReason::Invalid)
        );
        let missing = std::env::temp_dir().join(format!(
            "keiko-native-missing-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        assert_eq!(
            inspect_workspace_root(&missing),
            Err(WorkspaceClosedReason::Unavailable)
        );

        let file_root = Fixture::new();
        let file = file_root.root.join("file");
        fs::write(&file, b"not a repository").expect("file fixture");
        assert_eq!(
            inspect_workspace_root(&file),
            Err(WorkspaceClosedReason::Invalid)
        );

        let marker_file = Fixture::new();
        fs::write(marker_file.root.join(".git"), b"gitdir: elsewhere").expect("marker fixture");
        assert_eq!(
            inspect_workspace_root(&marker_file.root),
            Err(WorkspaceClosedReason::Invalid)
        );

        let marker_alias = Fixture::new();
        let external_marker = Fixture::new();
        symlink(&external_marker.root, marker_alias.root.join(".git"))
            .expect("marker symlink fixture");
        assert_eq!(
            inspect_workspace_root(&marker_alias.root),
            Err(WorkspaceClosedReason::Unsafe)
        );

        let denied = Fixture::new();
        fs::create_dir(denied.root.join(".git")).expect("Git marker");
        fs::set_permissions(&denied.root, fs::Permissions::from_mode(0o000)).expect("deny fixture");
        let denied_result = inspect_workspace_root(&denied.root);
        fs::set_permissions(&denied.root, fs::Permissions::from_mode(0o700))
            .expect("restore fixture");
        assert_eq!(denied_result, Err(WorkspaceClosedReason::PermissionDenied));
    }

    #[test]
    fn moved_and_replaced_roots_fail_closed_without_a_stale_binding() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.root.join(".git")).expect("Git marker");
        let moved = fixture.root.with_file_name(format!(
            "keiko-native-workspace-moved-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut host = WorkspaceHost::default();
        assert!(matches!(
            host.select(FolderPickerResult::Selected(fixture.root.clone()))
                .expect("selection"),
            WorkspaceView::Bound { generation: 1, .. }
        ));

        fs::rename(&fixture.root, &moved).expect("move fixture");
        assert_eq!(
            host.status().expect("moved root status"),
            WorkspaceView::Closed {
                generation: 1,
                reason: WorkspaceClosedReason::Unavailable,
            }
        );
        fs::rename(&moved, &fixture.root).expect("restore fixture");

        assert!(matches!(
            host.select(FolderPickerResult::Selected(fixture.root.clone()))
                .expect("selection"),
            WorkspaceView::Bound { generation: 2, .. }
        ));
        let replaced = fixture.root.with_file_name(format!(
            "keiko-native-workspace-replaced-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::rename(&fixture.root, &replaced).expect("retain original root");
        fs::create_dir(&fixture.root).expect("replacement root");
        fs::create_dir(fixture.root.join(".git")).expect("replacement marker");
        assert_eq!(
            host.status().expect("replaced root status"),
            WorkspaceView::Closed {
                generation: 2,
                reason: WorkspaceClosedReason::Unsafe,
            }
        );
        fs::remove_dir_all(replaced).expect("remove retained fixture");
    }

    #[test]
    fn unchanged_roots_revalidate_and_stale_completions_are_rejected() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.root.join(".git")).expect("Git marker");
        let mut host = WorkspaceHost::default();
        let bound = host
            .select(FolderPickerResult::Selected(fixture.root.clone()))
            .expect("selection");
        assert_eq!(host.status().expect("unchanged status"), bound);

        let stale_generation = host.begin_selection().expect("next selection");
        host.clear().expect("clear selection");
        assert_eq!(
            host.finish_selection(stale_generation, FolderPickerResult::Cancelled),
            Err(WorkspaceError::StaleGeneration)
        );
    }

    #[test]
    fn failed_application_transition_preserves_bound_root_metadata() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.root.join(".git")).expect("Git marker");
        let mut bound_root =
            Some(inspect_workspace_root(&fixture.root).expect("inspected workspace"));

        let result = retire_bound_root_after(&mut bound_root, || {
            Err::<u64, WorkspaceError>(WorkspaceError::GenerationExhausted)
        });

        assert_eq!(result, Err(WorkspaceError::GenerationExhausted));
        assert!(bound_root.is_some());
    }

    #[test]
    fn stale_picker_completion_preserves_the_newer_state_and_reports_failure() {
        let (lifecycle, sender) = session();
        let host = Mutex::new(WorkspaceHost::default());

        let output = workspace_request(
            &lifecycle,
            &host,
            &sender,
            &request(sender.generation, 1, "workspace-select"),
            Box::new(|| {
                host.lock()
                    .expect("workspace during picker")
                    .clear()
                    .expect("newer clear");
                FolderPickerResult::Cancelled
            }),
        );

        assert!(output.encoded.contains(r#""code":"internal-failure""#));
        let host = host.lock().expect("workspace after stale completion");
        assert!(host.bound_root.is_none());
        assert_eq!(
            host.application.view(),
            WorkspaceView::Empty { generation: 2 }
        );
    }

    #[test]
    fn revalidation_transition_error_is_propagated_without_dropping_root_metadata() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.root.join(".git")).expect("Git marker");
        let moved = fixture.root.with_file_name(format!(
            "keiko-native-workspace-transition-error-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut host = WorkspaceHost::default();
        host.select(FolderPickerResult::Selected(fixture.root.clone()))
            .expect("selection");
        host.application.clear().expect("simulate newer transition");
        fs::rename(&fixture.root, &moved).expect("move fixture");
        let (lifecycle, sender) = session();
        let host = Mutex::new(host);

        let output = workspace_request(
            &lifecycle,
            &host,
            &sender,
            &request(sender.generation, 1, "workspace-status"),
            Box::new(|| panic!("status must not open the picker")),
        );

        assert!(output.encoded.contains(r#""code":"internal-failure""#));
        assert!(
            host.lock()
                .expect("workspace after transition error")
                .bound_root
                .is_some()
        );
        fs::rename(&moved, &fixture.root).expect("restore fixture");
    }

    #[test]
    fn poisoned_host_owners_abort_selection_without_retaining_authority() {
        let (lifecycle, sender) = session();
        let host = Mutex::new(WorkspaceHost::default());
        let lifecycle_failure = workspace_request(
            &lifecycle,
            &host,
            &sender,
            &request(sender.generation, 1, "workspace-select"),
            Box::new(|| {
                let _ = catch_unwind(AssertUnwindSafe(|| {
                    let _guard = lifecycle.lock().expect("lifecycle before poison");
                    panic!("poison lifecycle");
                }));
                FolderPickerResult::Cancelled
            }),
        );
        assert!(
            lifecycle_failure
                .encoded
                .contains(r#""code":"internal-failure""#)
        );
        assert!(host.lock().expect("workspace host").bound_root.is_none());
        assert!(matches!(
            host.lock().expect("workspace host").application.view(),
            WorkspaceView::Closed {
                reason: WorkspaceClosedReason::Unavailable,
                ..
            }
        ));

        let (lifecycle, sender) = session();
        let host = Mutex::new(WorkspaceHost::default());
        let workspace_failure = workspace_request(
            &lifecycle,
            &host,
            &sender,
            &request(sender.generation, 1, "workspace-select"),
            Box::new(|| {
                let _ = catch_unwind(AssertUnwindSafe(|| {
                    let _guard = host.lock().expect("workspace before poison");
                    panic!("poison workspace");
                }));
                FolderPickerResult::Cancelled
            }),
        );
        assert!(
            workspace_failure
                .encoded
                .contains(r#""code":"internal-failure""#)
        );
        assert!(!workspace_failure.acknowledged_status);

        let poisoned_status = workspace_request(
            &lifecycle,
            &host,
            &sender,
            &request(sender.generation, 2, "workspace-status"),
            Box::new(|| panic!("status must not open the picker")),
        );
        assert!(
            poisoned_status
                .encoded
                .contains(r#""code":"internal-failure""#)
        );
        assert!(!poisoned_status.acknowledged_status);

        let poisoned_clear = workspace_request(
            &lifecycle,
            &host,
            &sender,
            &request(sender.generation, 3, "workspace-clear"),
            Box::new(|| panic!("clear must not open the picker")),
        );
        assert!(
            poisoned_clear
                .encoded
                .contains(r#""code":"internal-failure""#)
        );
        assert!(!poisoned_clear.acknowledged_status);

        let (lifecycle, sender) = session();
        let host = Mutex::new(WorkspaceHost::default());
        let both_failure = workspace_request(
            &lifecycle,
            &host,
            &sender,
            &request(sender.generation, 1, "workspace-select"),
            Box::new(|| {
                let _ = catch_unwind(AssertUnwindSafe(|| {
                    let _guard = lifecycle.lock().expect("lifecycle before poison");
                    panic!("poison lifecycle");
                }));
                let _ = catch_unwind(AssertUnwindSafe(|| {
                    let _guard = host.lock().expect("workspace before poison");
                    panic!("poison workspace");
                }));
                FolderPickerResult::Cancelled
            }),
        );
        assert!(
            both_failure
                .encoded
                .contains(r#""code":"internal-failure""#)
        );
        assert!(!both_failure.acknowledged_status);
    }

    #[test]
    fn authenticated_workspace_request_opens_the_picker_without_accepting_a_path_payload() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.root.join(".git")).expect("Git marker");
        let (lifecycle, sender) = session();
        let host = Mutex::new(WorkspaceHost::default());
        for (denied_sender, reason) in [
            (
                SenderContext {
                    window_label: "other".to_owned(),
                    ..sender.clone()
                },
                "unauthenticated-sender",
            ),
            (
                SenderContext {
                    origin: "https://untrusted.invalid".to_owned(),
                    ..sender.clone()
                },
                "unauthenticated-origin",
            ),
            (
                SenderContext {
                    generation: sender.generation + 1,
                    ..sender.clone()
                },
                "unauthorized",
            ),
            (
                SenderContext {
                    document_nonce: "b".repeat(64),
                    ..sender.clone()
                },
                "unauthorized",
            ),
        ] {
            let picker_called = AtomicBool::new(false);
            let denied = workspace_request(
                &lifecycle,
                &host,
                &denied_sender,
                &request(denied_sender.generation, 1, "workspace-select"),
                Box::new(|| {
                    picker_called.store(true, Ordering::Relaxed);
                    FolderPickerResult::Selected(fixture.root.clone())
                }),
            );
            assert!(!picker_called.load(Ordering::Relaxed));
            assert!(denied.encoded.contains(reason));
            assert!(!denied.acknowledged_status);
        }

        let accepted = workspace_request(
            &lifecycle,
            &host,
            &sender,
            &request(sender.generation, 1, "workspace-select"),
            Box::new(|| FolderPickerResult::Selected(fixture.root.clone())),
        );
        assert!(accepted.encoded.contains(r#""kind":"bound""#));
        assert!(accepted.encoded.contains(r#""displayLabel":"#));
        assert!(
            !accepted
                .encoded
                .contains(fixture.root.to_string_lossy().as_ref())
        );
        assert!(!accepted.acknowledged_status);

        let cancelled = workspace_request(
            &lifecycle,
            &host,
            &sender,
            &request(sender.generation, 2, "workspace-select"),
            Box::new(|| FolderPickerResult::Cancelled),
        );
        assert!(cancelled.encoded.contains(r#""reason":"cancelled""#));
        assert!(host.lock().expect("workspace host").bound_root.is_none());
        assert!(!cancelled.acknowledged_status);

        let unavailable = workspace_request(
            &lifecycle,
            &host,
            &sender,
            &request(sender.generation, 3, "workspace-select"),
            Box::new(|| FolderPickerResult::Unavailable),
        );
        assert!(unavailable.encoded.contains(r#""reason":"unavailable""#));
        assert!(!unavailable.acknowledged_status);

        let status = workspace_request(
            &lifecycle,
            &host,
            &sender,
            &request(sender.generation, 4, "workspace-status"),
            Box::new(|| panic!("status must not open the picker")),
        );
        assert!(status.encoded.contains(r#""kind":"closed""#));
        assert!(status.acknowledged_status);

        let cleared = workspace_request(
            &lifecycle,
            &host,
            &sender,
            &request(sender.generation, 5, "workspace-clear"),
            Box::new(|| panic!("clear must not open the picker")),
        );
        assert!(cleared.encoded.contains(r#""kind":"empty""#));
        assert!(!cleared.acknowledged_status);
    }

    #[test]
    fn picker_wait_is_not_an_ipc_timeout_and_cancellation_retains_no_authority() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.root.join(".git")).expect("Git marker");
        let (lifecycle, sender) = session();
        lifecycle.lock().expect("lifecycle").set_test_now_ms(0);
        let host = Mutex::new(WorkspaceHost::default());
        let completed = workspace_request(
            &lifecycle,
            &host,
            &sender,
            &request(sender.generation, 1, "workspace-select"),
            Box::new(|| {
                lifecycle.lock().expect("lifecycle").set_test_now_ms(60_000);
                FolderPickerResult::Selected(fixture.root.clone())
            }),
        );
        assert!(completed.encoded.contains(r#""kind":"bound""#));

        let cancellation_id =
            canonical_request_id(sender.generation, 2).expect("request identifier");
        let cancelled = workspace_request(
            &lifecycle,
            &host,
            &sender,
            &request(sender.generation, 2, "workspace-select"),
            Box::new(|| {
                let cancellation =
                    format!(r#"{{"schemaVersion":1,"requestId":"{cancellation_id}"}}"#);
                lifecycle
                    .lock()
                    .expect("lifecycle")
                    .cancel_application_request(&sender, cancellation.as_bytes());
                FolderPickerResult::Selected(fixture.root.clone())
            }),
        );
        assert!(cancelled.encoded.contains(r#""code":"cancelled""#));
        assert!(host.lock().expect("workspace host").bound_root.is_none());
    }
}
