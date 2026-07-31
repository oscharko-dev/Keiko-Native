use std::sync::Mutex;
use std::time::Duration;

use keiko_application::runtime::RuntimeDescriptor;
use keiko_application::turn::{TurnReason, TurnSession, TurnState, TurnView};
use keiko_ui_port::{
    Operation, ReasonCode, encode_error, request_metadata, request_operation, turn_input,
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
                TurnRuntimeUpdate::Stopping(reason) => session.request_stop(reason),
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
            TurnState::Cancelled => {
                session.cancel(outcome.reason.unwrap_or(TurnReason::InternalFailure))
            }
            TurnState::CleanupFailed if session.view().state == TurnState::Stopping => {
                session.settle_cleanup(false)
            }
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
    let encoded = lifecycle.lock().map_or_else(
        |_| encode_error("unknown-request", ReasonCode::InternalFailure),
        |mut lifecycle| lifecycle.complete_turn_request(accepted, state),
    );
    TurnRequestOutput { encoded }
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

    #[test]
    fn settlement_enforces_each_cancellation_terminal_precedence() {
        let outcome = |state, reason, cleaned| TurnRuntimeOutcome {
            state,
            reason,
            agent_text: String::new(),
            provider_thread_established: false,
            provider_turn_established: false,
            quarantined_events: 0,
            cleaned,
        };
        let new_session = || {
            TurnSession::new(
                1,
                1,
                1,
                "Bounded task.".to_owned(),
                RuntimeDescriptor::approved(),
            )
            .unwrap()
        };

        let mut completed = new_session();
        completed.mark_streaming().unwrap();
        completed.append_agent_delta("answer").unwrap();
        settle_session(
            &mut completed,
            outcome(TurnState::Completed, None, true),
            false,
        );
        assert_eq!(completed.view().state, TurnState::Completed);

        let mut cancelled = new_session();
        cancelled.request_stop(TurnReason::UserCancelled).unwrap();
        settle_session(
            &mut cancelled,
            outcome(TurnState::Cancelled, Some(TurnReason::UserCancelled), true),
            false,
        );
        assert_eq!(cancelled.view().state, TurnState::Cancelled);

        let mut cleanup_failed = new_session();
        cleanup_failed
            .request_stop(TurnReason::AppShutdown)
            .unwrap();
        settle_session(
            &mut cleanup_failed,
            outcome(
                TurnState::CleanupFailed,
                Some(TurnReason::CleanupFailed),
                false,
            ),
            false,
        );
        assert_eq!(cleanup_failed.view().state, TurnState::CleanupFailed);

        let mut projection_failed = new_session();
        settle_session(
            &mut projection_failed,
            outcome(TurnState::Completed, None, true),
            true,
        );
        assert_eq!(projection_failed.view().state, TurnState::ContainmentFailed);

        let mut invalid_completion = new_session();
        settle_session(
            &mut invalid_completion,
            outcome(TurnState::Completed, None, true),
            false,
        );
        assert_eq!(
            invalid_completion.view().state,
            TurnState::ContainmentFailed
        );
    }

    #[test]
    fn accepted_cancel_wins_a_raced_runtime_completion() {
        let (lifecycle, sender) = session();
        let encoded_request = request(sender.generation, 3, "Bounded task.");
        let accepted = lifecycle
            .lock()
            .unwrap()
            .begin_application_request(&sender, encoded_request.as_bytes())
            .unwrap();
        let cancellation = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "requestId": canonical_request_id(sender.generation, 1).unwrap()
        }))
        .unwrap();
        assert!(
            lifecycle
                .lock()
                .unwrap()
                .cancel_application_request(&sender, &cancellation)
                .contains("cancelled")
        );

        let mut raced = TurnSession::new(
            sender.generation,
            1,
            3,
            "Bounded task.".to_owned(),
            RuntimeDescriptor::approved(),
        )
        .unwrap();
        raced.mark_streaming().unwrap();
        raced.append_agent_delta("late completion").unwrap();
        raced.complete().unwrap();
        raced.settle_cleanup(true).unwrap();
        let encoded = lifecycle
            .lock()
            .unwrap()
            .complete_turn_request(accepted, raced.view());
        assert!(encoded.contains(r#""state":"cancelled""#));
        assert!(encoded.contains(r#""reason":"user-cancelled""#));
        assert!(encoded.contains(r#""cleanupComplete":true"#));
        assert!(!encoded.contains(r#""state":"completed""#));

        let (settled_lifecycle, settled_sender) = session();
        let settled_request = request(settled_sender.generation, 3, "Bounded task.");
        let settled_accepted = settled_lifecycle
            .lock()
            .unwrap()
            .begin_application_request(&settled_sender, settled_request.as_bytes())
            .unwrap();
        let settled_cancellation = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "requestId": canonical_request_id(settled_sender.generation, 1).unwrap()
        }))
        .unwrap();
        settled_lifecycle
            .lock()
            .unwrap()
            .cancel_application_request(&settled_sender, &settled_cancellation);
        let mut settled = TurnSession::new(
            settled_sender.generation,
            1,
            3,
            "Bounded task.".to_owned(),
            RuntimeDescriptor::approved(),
        )
        .unwrap();
        settled.request_stop(TurnReason::UserCancelled).unwrap();
        settled.cancel(TurnReason::UserCancelled).unwrap();
        settled.settle_cleanup(true).unwrap();
        let settled_encoded = settled_lifecycle
            .lock()
            .unwrap()
            .complete_turn_request(settled_accepted, settled.view());
        assert!(settled_encoded.contains(r#""state":"cancelled""#));
        assert!(settled_encoded.contains(r#""reason":"user-cancelled""#));
    }

    #[test]
    fn renderer_loss_and_shutdown_classify_raced_completion() {
        for (shutdown, expected_reason) in [(false, "renderer-lost"), (true, "app-shutdown")] {
            let (lifecycle, sender) = session();
            let encoded_request = request(sender.generation, 3, "Bounded task.");
            let accepted = lifecycle
                .lock()
                .unwrap()
                .begin_application_request(&sender, encoded_request.as_bytes())
                .unwrap();
            if shutdown {
                lifecycle.lock().unwrap().shutdown();
            } else {
                lifecycle.lock().unwrap().renderer_lost();
            }

            let mut raced = TurnSession::new(
                sender.generation,
                1,
                3,
                "Bounded task.".to_owned(),
                RuntimeDescriptor::approved(),
            )
            .unwrap();
            raced.mark_streaming().unwrap();
            raced.append_agent_delta("late completion").unwrap();
            raced.complete().unwrap();
            raced.settle_cleanup(true).unwrap();
            let encoded = lifecycle
                .lock()
                .unwrap()
                .complete_turn_request(accepted, raced.view());
            assert!(encoded.contains(r#""state":"cancelled""#));
            assert!(encoded.contains(&format!(r#""reason":"{expected_reason}""#)));
        }
    }

    #[test]
    fn cleanup_failure_outweighs_cancel_and_timeout_completion() {
        let cleanup_view = || {
            let mut session = TurnSession::new(
                1,
                1,
                3,
                "Bounded task.".to_owned(),
                RuntimeDescriptor::approved(),
            )
            .unwrap();
            session.request_stop(TurnReason::UserCancelled).unwrap();
            session.cancel(TurnReason::UserCancelled).unwrap();
            session.settle_cleanup(false).unwrap();
            session.view()
        };

        let (cancelled_lifecycle, cancelled_sender) = session();
        let cancelled_request = request(cancelled_sender.generation, 3, "Bounded task.");
        let cancelled_accepted = cancelled_lifecycle
            .lock()
            .unwrap()
            .begin_application_request(&cancelled_sender, cancelled_request.as_bytes())
            .unwrap();
        let cancellation = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "requestId": canonical_request_id(cancelled_sender.generation, 1).unwrap()
        }))
        .unwrap();
        cancelled_lifecycle
            .lock()
            .unwrap()
            .cancel_application_request(&cancelled_sender, &cancellation);
        let cancelled_encoded = cancelled_lifecycle
            .lock()
            .unwrap()
            .complete_turn_request(cancelled_accepted, cleanup_view());
        assert!(cancelled_encoded.contains(r#""state":"cleanup-failed""#));

        let (timed_lifecycle, timed_sender) = session();
        let timed_request = request(timed_sender.generation, 3, "Bounded task.");
        let timed_accepted = timed_lifecycle
            .lock()
            .unwrap()
            .begin_application_request(&timed_sender, timed_request.as_bytes())
            .unwrap();
        timed_lifecycle.lock().unwrap().set_test_now_ms(120_000);
        let timed_encoded = timed_lifecycle
            .lock()
            .unwrap()
            .complete_turn_request(timed_accepted, cleanup_view());
        assert!(timed_encoded.contains(r#""state":"cleanup-failed""#));

        let (ordinary_timeout_lifecycle, ordinary_timeout_sender) = session();
        let ordinary_timeout_request =
            request(ordinary_timeout_sender.generation, 3, "Bounded task.");
        let ordinary_timeout_accepted = ordinary_timeout_lifecycle
            .lock()
            .unwrap()
            .begin_application_request(
                &ordinary_timeout_sender,
                ordinary_timeout_request.as_bytes(),
            )
            .unwrap();
        ordinary_timeout_lifecycle
            .lock()
            .unwrap()
            .set_test_now_ms(120_000);
        let mut failed = TurnSession::new(
            1,
            1,
            3,
            "Bounded task.".to_owned(),
            RuntimeDescriptor::approved(),
        )
        .unwrap();
        failed
            .fail(TurnState::Failed, TurnReason::ProviderFailed)
            .unwrap();
        failed.settle_cleanup(true).unwrap();
        let ordinary_timeout_encoded = ordinary_timeout_lifecycle
            .lock()
            .unwrap()
            .complete_turn_request(ordinary_timeout_accepted, failed.view());
        assert!(ordinary_timeout_encoded.contains(r#""state":"timed-out""#));
    }
}
