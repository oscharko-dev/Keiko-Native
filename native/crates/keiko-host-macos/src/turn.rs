use std::sync::Mutex;
use std::time::Duration;

use keiko_application::runtime::RuntimeDescriptor;
use keiko_application::turn::{TurnReason, TurnSession, TurnState, TurnView};
use keiko_application::{ApplicationResult, application_response};
use keiko_ui_port::{
    Operation, ReasonCode, encode_error, encode_success, request_metadata, request_operation,
    turn_input,
};

use crate::runtime::{RuntimeHost, TurnRuntimeOutcome, TurnRuntimeUpdate};
use crate::{AcceptedRequest, HostLifecycle, SenderContext, WorkspaceHost};

#[derive(Debug, Eq, PartialEq)]
pub struct TurnRequestOutput {
    pub encoded: String,
}

pub fn turn_request(
    lifecycle: &Mutex<HostLifecycle>,
    workspace: &Mutex<WorkspaceHost>,
    runtime: &RuntimeHost,
    sender: &SenderContext,
    request: &str,
    mut update: impl FnMut(TurnView),
) -> TurnRequestOutput {
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
    if !matches!(
        request_operation(&accepted.request),
        Operation::CodexTurnStart { .. }
    ) {
        return finish_encoded(
            lifecycle,
            accepted,
            encode_error("unknown-request", ReasonCode::UnknownOperation),
        );
    }
    let (request_id, sequence, timeout_ms) = request_metadata(&accepted.request);
    let request_id = request_id.to_owned();
    let Some((workspace_generation, task)) = turn_input(&accepted.request) else {
        return finish_encoded(
            lifecycle,
            accepted,
            encode_error(&request_id, ReasonCode::InvalidRequest),
        );
    };
    let mut session = match TurnSession::new(
        accepted.generation,
        sequence,
        workspace_generation,
        task.to_owned(),
        RuntimeDescriptor::approved(),
    ) {
        Ok(session) => session,
        Err(_) => {
            return finish_encoded(
                lifecycle,
                accepted,
                encode_error(&request_id, ReasonCode::InvalidRequest),
            );
        }
    };
    update(session.view());
    let selected_workspace = workspace.lock().ok().and_then(|mut workspace| {
        workspace
            .current_root_for_generation(workspace_generation)
            .ok()
    });
    let Some(selected_workspace) = selected_workspace else {
        let _ = session.fail(TurnState::Failed, TurnReason::StaleWorkspace);
        let _ = session.settle_cleanup(true);
        update(session.view());
        return finish_turn(lifecycle, accepted, session.view());
    };

    let mut projection_failed = false;
    let task = session.task().to_owned();
    let outcome = runtime.run_turn(
        &request_id,
        &selected_workspace,
        &task,
        Duration::from_millis(u64::from(timeout_ms)),
        |runtime_update| {
            if projection_failed {
                return;
            }
            let applied = match runtime_update {
                TurnRuntimeUpdate::StreamingStarted => session.mark_streaming(),
                TurnRuntimeUpdate::AgentDelta(delta) => session.append_agent_delta(&delta),
                TurnRuntimeUpdate::ProviderEventQuarantined => session.quarantine_provider_event(),
            };
            if applied.is_err() {
                projection_failed = true;
                runtime.cancel_all();
                return;
            }
            update(session.view());
        },
    );
    settle_session(&mut session, outcome, projection_failed);
    update(session.view());
    finish_turn(lifecycle, accepted, session.view())
}

fn settle_session(session: &mut TurnSession, outcome: TurnRuntimeOutcome, projection_failed: bool) {
    let state_result = if projection_failed {
        session.fail(TurnState::ContainmentFailed, TurnReason::ProtocolRejected)
    } else {
        match outcome.state {
            TurnState::Completed => session.complete(),
            state => session.fail(state, outcome.reason.unwrap_or(TurnReason::InternalFailure)),
        }
    };
    if state_result.is_err() {
        let _ = session.fail(TurnState::ContainmentFailed, TurnReason::ProtocolRejected);
    }
    let _ = session.settle_cleanup(outcome.cleaned);
}

fn finish_turn(
    lifecycle: &Mutex<HostLifecycle>,
    accepted: AcceptedRequest,
    state: TurnView,
) -> TurnRequestOutput {
    let (request_id, _, _) = request_metadata(&accepted.request);
    let encoded = encode_success(&application_response(
        request_id,
        ApplicationResult::CodexTurn { state },
    ));
    finish_encoded(lifecycle, accepted, encoded)
}

fn finish_encoded(
    lifecycle: &Mutex<HostLifecycle>,
    accepted: AcceptedRequest,
    encoded: String,
) -> TurnRequestOutput {
    let encoded = lifecycle.lock().map_or_else(
        |_| encode_error("unknown-request", ReasonCode::InternalFailure),
        |mut lifecycle| {
            lifecycle
                .complete_foundation_request(accepted, encoded, false)
                .encoded
        },
    );
    TurnRequestOutput { encoded }
}

fn failed(request_id: &str, reason: ReasonCode) -> TurnRequestOutput {
    TurnRequestOutput {
        encoded: encode_error(request_id, reason),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    use keiko_ui_port::canonical_request_id;
    use serde_json::json;

    use super::*;
    use crate::FolderPickerResult;

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);

    fn session() -> (Mutex<HostLifecycle>, SenderContext) {
        let nonce = "a".repeat(64);
        let mut lifecycle = HostLifecycle::default();
        let generation = lifecycle
            .begin_renderer_session(nonce.clone())
            .expect("renderer generation");
        let sender = lifecycle.sender_for_document("main", "tauri://localhost", generation, &nonce);
        (Mutex::new(lifecycle), sender)
    }

    fn request(generation: u64, workspace_generation: u64, task: &str) -> String {
        serde_json::to_string(&json!({
            "schemaVersion": 1,
            "requestId": canonical_request_id(generation, 1).unwrap(),
            "sequence": 1,
            "timeoutMs": 120_000,
            "operation": {
                "kind": "codex-turn-start",
                "workspaceGeneration": workspace_generation,
                "task": task
            }
        }))
        .unwrap()
    }

    #[test]
    fn stale_workspace_finishes_body_free_without_starting_a_runtime() {
        let (lifecycle, sender) = session();
        let workspace = Mutex::new(WorkspaceHost::default());
        let runtime = RuntimeHost::unavailable_for_test();
        let task = "Do not retain this task body.";
        let mut updates = Vec::new();
        let output = turn_request(
            &lifecycle,
            &workspace,
            &runtime,
            &sender,
            &request(sender.generation, 9, task),
            |view| updates.push(view),
        );
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].state, TurnState::Preflighting);
        assert_eq!(updates[1].state, TurnState::Failed);
        assert_eq!(updates[1].reason, Some(TurnReason::StaleWorkspace));
        assert!(updates[1].evidence.cleanup_complete);
        assert!(!output.encoded.contains(task));
        assert!(output.encoded.contains(r#""acceptedEffects":0"#));
        assert!(output.encoded.contains(r#""stale-workspace""#));
    }

    #[test]
    fn current_workspace_reaches_a_bounded_runtime_unavailable_terminal() {
        let root = std::env::temp_dir().join(format!(
            "keiko-turn-host-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join(".git")).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let mut workspace = WorkspaceHost::default();
        let bound = workspace
            .select(FolderPickerResult::Selected(root.clone()))
            .unwrap();
        let generation = match bound {
            keiko_application::workspace::WorkspaceView::Bound { generation, .. } => generation,
            _ => panic!("bound workspace"),
        };
        let (lifecycle, sender) = session();
        let mut updates = Vec::new();
        let output = turn_request(
            &lifecycle,
            &Mutex::new(workspace),
            &RuntimeHost::unavailable_for_test(),
            &sender,
            &request(sender.generation, generation, "Bounded task."),
            |view| updates.push(view),
        );
        assert_eq!(updates.last().unwrap().state, TurnState::Failed);
        assert_eq!(
            updates.last().unwrap().reason,
            Some(TurnReason::RuntimeUnavailable)
        );
        assert!(output.encoded.contains(r#""runtime-unavailable""#));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn turn_command_rejects_every_other_closed_operation() {
        let (lifecycle, sender) = session();
        let request = format!(
            r#"{{"schemaVersion":1,"requestId":"{}","sequence":1,"timeoutMs":5000,"operation":{{"kind":"runtime-readiness"}}}}"#,
            canonical_request_id(sender.generation, 1).unwrap()
        );
        let output = turn_request(
            &lifecycle,
            &Mutex::new(WorkspaceHost::default()),
            &RuntimeHost::unavailable_for_test(),
            &sender,
            &request,
            |_| panic!("no turn update"),
        );
        assert!(output.encoded.contains(r#""unknown-operation""#));
    }
}
