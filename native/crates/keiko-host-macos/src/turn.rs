use std::sync::Mutex;
use std::time::{Duration, Instant};

use keiko_application::runtime::RuntimeDescriptor;
use keiko_application::turn::{TurnReason, TurnSession, TurnState, TurnView};
use keiko_ui_port::{
    Operation, ReasonCode, encode_error, request_metadata, request_operation, turn_input,
};

use crate::request_timing::terminal_cutoff_exceeded;
use crate::runtime::{
    HostTurnClaimDisposition, RuntimeHost, TurnRuntimeOutcome, TurnRuntimeUpdate,
};
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
    turn_request_with_channel(lifecycle, workspace, runtime, sender, request, |view, _| {
        update(view);
        true
    })
}

pub(crate) fn turn_request_with_channel(
    lifecycle: &Mutex<HostLifecycle>,
    workspace: &Mutex<WorkspaceHost>,
    runtime: &RuntimeHost,
    sender: &SenderContext,
    request: &str,
    mut update: impl FnMut(TurnView, Option<Instant>) -> bool,
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
    let _ = update(session.view(), None);
    let claim_disposition = runtime.claim_turn_request_for_host_settlement_disposition(&request_id);
    if claim_disposition != HostTurnClaimDisposition::Claimed {
        #[cfg(test)]
        runtime.pause_failed_claim_settlement_for_test();
        let exact_host_acceptance = claim_disposition == HostTurnClaimDisposition::Cancelled;
        let _ = session.fail(
            if exact_host_acceptance {
                TurnState::Failed
            } else {
                TurnState::ContainmentFailed
            },
            TurnReason::InternalFailure,
        );
        let _ = session.settle_cleanup(exact_host_acceptance);
        return finish_turn_with_runtime_classified(
            lifecycle,
            &request_id,
            runtime,
            accepted,
            session.view(),
            true,
            &mut |commit| commit_terminal_update(&mut update, commit),
        );
    }
    let selected_workspace = workspace.lock().ok().and_then(|mut workspace| {
        workspace
            .current_root_for_generation(workspace_generation)
            .ok()
    });
    let Some(selected_workspace) = selected_workspace else {
        let _ = session.fail(TurnState::Failed, TurnReason::StaleWorkspace);
        let _ = session.settle_cleanup(true);
        return finish_turn_with_runtime(
            lifecycle,
            runtime,
            &request_id,
            accepted,
            session.view(),
            &mut |commit| commit_terminal_update(&mut update, commit),
        );
    };

    let mut projection_failed = false;
    let task = session.task().to_owned();
    let outcome = runtime.run_turn_for_host_settlement(
        &request_id,
        workspace_generation,
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
                runtime.defer_containment_failure();
                return;
            }
            let _ = update(session.view(), None);
        },
    );
    settle_session(&mut session, outcome, projection_failed);
    finish_turn_with_runtime(
        lifecycle,
        runtime,
        &request_id,
        accepted,
        session.view(),
        &mut |commit| commit_terminal_update(&mut update, commit),
    )
}

fn commit_terminal_update(
    update: &mut impl FnMut(TurnView, Option<Instant>) -> bool,
    commit: &mut dyn FnMut() -> Result<PreparedTerminalPublication, String>,
) -> bool {
    match commit() {
        Ok(publication) => update(publication.view, publication.terminal_cutoff),
        Err(_) => false,
    }
}

pub(crate) struct PreparedTerminalPublication {
    pub(crate) view: TurnView,
    pub(crate) terminal_cutoff: Option<Instant>,
}

fn containment_failed_publication(mut state: TurnView) -> TurnView {
    state.state = TurnState::ContainmentFailed;
    state.reason = Some(TurnReason::ProtocolRejected);
    state.evidence.cleanup_complete = false;
    state.evidence.terminal_state = TurnState::ContainmentFailed;
    state
}

fn runtime_control_failed_publication(mut state: TurnView) -> TurnView {
    state.state = TurnState::ContainmentFailed;
    state.reason = Some(TurnReason::InternalFailure);
    state.evidence.terminal_state = TurnState::ContainmentFailed;
    state
}

fn settle_session(session: &mut TurnSession, outcome: TurnRuntimeOutcome, projection_failed: bool) {
    let terminal_cutoff_exceeded = outcome
        .cancellation
        .is_some_and(|window| terminal_cutoff_exceeded(Instant::now(), window.terminal_cutoff));
    session.record_repository_context_bytes_to_runtime(outcome.repository_context_bytes_to_runtime);
    let projection_failed = projection_failed
        || outcome.repository_context_bytes_to_runtime > 0
        || session
            .retain_provider_correlations(
                outcome.provider_thread_established,
                outcome.provider_turn_established,
            )
            .is_err();
    let state_result = if projection_failed || (terminal_cutoff_exceeded && outcome.cleaned) {
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

#[cfg(test)]
fn finish_turn(
    lifecycle: &Mutex<HostLifecycle>,
    accepted: AcceptedRequest,
    state: TurnView,
    runtime_acceptance: Option<crate::request_timing::AcceptedCancellation>,
    update: &mut impl FnMut(TurnView),
) -> TurnRequestOutput {
    let published = lifecycle.lock().map_or_else(
        |_| Err(encode_error("unknown-request", ReasonCode::InternalFailure)),
        |lifecycle| {
            lifecycle.prepare_turn_request_publication(&accepted, state.clone(), runtime_acceptance)
        },
    );
    if let Ok(published) = &published {
        update(published.view.clone());
    }
    let encoded = lifecycle.lock().map_or_else(
        |_| encode_error("unknown-request", ReasonCode::InternalFailure),
        |mut lifecycle| {
            lifecycle.finalize_turn_request_publication(&accepted, published, runtime_acceptance)
        },
    );
    TurnRequestOutput { encoded }
}

pub(crate) fn finish_turn_with_runtime(
    lifecycle: &Mutex<HostLifecycle>,
    runtime: &RuntimeHost,
    request_id: &str,
    accepted: AcceptedRequest,
    state: TurnView,
    update: &mut impl FnMut(&mut dyn FnMut() -> Result<PreparedTerminalPublication, String>) -> bool,
) -> TurnRequestOutput {
    finish_turn_with_runtime_classified(
        lifecycle, request_id, runtime, accepted, state, false, update,
    )
}

fn finish_turn_with_runtime_classified(
    lifecycle: &Mutex<HostLifecycle>,
    request_id: &str,
    runtime: &RuntimeHost,
    accepted: AcceptedRequest,
    state: TurnView,
    failed_claim: bool,
    update: &mut impl FnMut(&mut dyn FnMut() -> Result<PreparedTerminalPublication, String>) -> bool,
) -> TurnRequestOutput {
    runtime.settle_host_turn(
        request_id,
        |refresh_runtime_acceptance, runtime_control_failed| {
            let runtime_acceptance_before_publication = refresh_runtime_acceptance();
            let state_before_publication = settlement_publication_state(
                state.clone(),
                runtime_control_failed,
                failed_claim,
                runtime_acceptance_before_publication,
            );
            let prepared = lifecycle.lock().map_or_else(
                |_| Err(encode_error("unknown-request", ReasonCode::InternalFailure)),
                |lifecycle| {
                    lifecycle.prepare_turn_request_publication(
                        &accepted,
                        state_before_publication.clone(),
                        runtime_acceptance_before_publication,
                    )
                },
            );
            prepared?;
            let publication_succeeded = update(&mut || {
                let runtime_acceptance = refresh_runtime_acceptance();
                let publication_state = settlement_publication_state(
                    state.clone(),
                    runtime_control_failed,
                    failed_claim,
                    runtime_acceptance,
                );
                lifecycle.lock().map_or_else(
                    |_| Err(encode_error("unknown-request", ReasonCode::InternalFailure)),
                    |lifecycle| {
                        lifecycle.prepare_turn_request_publication(
                            &accepted,
                            publication_state,
                            runtime_acceptance,
                        )
                    },
                )
            });
            let runtime_acceptance_after_publication = refresh_runtime_acceptance();
            let state_after_publication = settlement_publication_state(
                state.clone(),
                runtime_control_failed,
                failed_claim,
                runtime_acceptance_after_publication,
            );
            let final_state = if publication_succeeded
                || runtime_acceptance_after_publication != runtime_acceptance_before_publication
            {
                state_after_publication
            } else {
                containment_failed_publication(state_after_publication)
            };
            lifecycle.lock().map_or_else(
                |_| Err(encode_error("unknown-request", ReasonCode::InternalFailure)),
                |lifecycle| {
                    lifecycle.prepare_turn_request_publication(
                        &accepted,
                        final_state,
                        runtime_acceptance_after_publication,
                    )
                },
            )
        },
        |published, runtime_acceptance| {
            let encoded = lifecycle.lock().map_or_else(
                |_| encode_error("unknown-request", ReasonCode::InternalFailure),
                |mut lifecycle| {
                    lifecycle.finalize_turn_request_publication(
                        &accepted,
                        published,
                        runtime_acceptance,
                    )
                },
            );
            TurnRequestOutput { encoded }
        },
    )
}

fn settlement_publication_state(
    mut state: TurnView,
    runtime_control_failed: bool,
    failed_claim: bool,
    runtime_acceptance: Option<crate::request_timing::AcceptedCancellation>,
) -> TurnView {
    if failed_claim && runtime_acceptance.is_some() {
        state.state = TurnState::Failed;
        state.reason = Some(TurnReason::InternalFailure);
        state.evidence.cleanup_complete = true;
        state.evidence.terminal_state = TurnState::Failed;
        state
    } else if runtime_control_failed {
        runtime_control_failed_publication(state)
    } else {
        state
    }
}

#[cfg(test)]
pub(crate) fn finish_turn_with_envelope_for_test(
    lifecycle: &Mutex<HostLifecycle>,
    accepted: AcceptedRequest,
    state: TurnView,
    _runtime_acceptance: Option<crate::request_timing::AcceptedCancellation>,
    before_publication: impl FnOnce(&mut HostLifecycle),
    update: &mut impl FnMut(TurnView),
) -> TurnRequestOutput {
    if let Ok(mut lifecycle) = lifecycle.lock() {
        before_publication(&mut lifecycle);
    } else {
        return failed("unknown-request", ReasonCode::InternalFailure);
    }
    finish_turn(lifecycle, accepted, state, _runtime_acceptance, update)
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
    use std::sync::{Arc, mpsc};

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

    fn host_cancellation(
        lifecycle: &Mutex<HostLifecycle>,
    ) -> Option<crate::request_timing::AcceptedCancellation> {
        lifecycle
            .lock()
            .unwrap()
            .in_flight
            .values()
            .find_map(|request| request.accepted_cancellation)
    }

    #[test]
    fn stale_workspace_terminal_attempt_revalidates_renderer_loss_after_callback() {
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
            |view| {
                if view.state == TurnState::Failed {
                    let records = lifecycle.lock().unwrap().renderer_lost();
                    runtime.defer_host_cancellations(&records);
                }
                updates.push(view);
            },
        );
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].state, TurnState::Preflighting);
        assert_eq!(updates[1].state, TurnState::Failed);
        assert_eq!(updates[1].reason, Some(TurnReason::StaleWorkspace));
        assert!(updates[1].evidence.cleanup_complete);
        assert!(!output.encoded.contains(task));
        assert!(output.encoded.contains(r#""acceptedEffects":0"#));
        assert!(output.encoded.contains(r#""state":"cancelled""#));
        assert!(output.encoded.contains(r#""renderer-lost""#));
        assert!(!output.encoded.contains(r#""stale-workspace""#));
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
        assert!(output.encoded.contains(r#""runtime-unavailable""#));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn host_capacity_rejection_precedes_runtime_and_provider_effects() {
        let (lifecycle, sender) = session();
        let mut accepted = Vec::new();
        {
            let mut host = lifecycle.lock().expect("capacity Host");
            for sequence in 1..=crate::MAX_IN_FLIGHT_REQUESTS as u64 {
                let request_id = canonical_request_id(sender.generation, sequence).unwrap();
                let encoded = serde_json::to_vec(&json!({
                    "schemaVersion": 1,
                    "requestId": request_id,
                    "sequence": sequence,
                    "timeoutMs": 1_000,
                    "operation": { "kind": "application-health" }
                }))
                .unwrap();
                accepted.push(
                    host.begin_application_request(&sender, &encoded)
                        .expect("request within Host capacity"),
                );
            }
        }
        let sequence = crate::MAX_IN_FLIGHT_REQUESTS as u64 + 1;
        let request_id = canonical_request_id(sender.generation, sequence).unwrap();
        let encoded = serde_json::to_string(&json!({
            "schemaVersion": 1,
            "requestId": request_id,
            "sequence": sequence,
            "timeoutMs": 120_000,
            "operation": {
                "kind": "codex-turn-start",
                "workspaceGeneration": 1,
                "task": "Must not reach Runtime."
            }
        }))
        .unwrap();
        let runtime = RuntimeHost::unavailable_for_test();
        let mut updates = Vec::new();

        let output = turn_request(
            &lifecycle,
            &Mutex::new(WorkspaceHost::default()),
            &runtime,
            &sender,
            &encoded,
            |view| updates.push(view),
        );

        assert!(output.encoded.contains(r#""internal-failure""#));
        assert!(updates.is_empty());
        assert!(runtime.has_no_runtime_effects_for_test());
        assert_eq!(
            lifecycle
                .lock()
                .expect("unchanged Host capacity")
                .in_flight
                .len(),
            crate::MAX_IN_FLIGHT_REQUESTS
        );
        drop(accepted);
    }

    #[test]
    fn late_exact_host_cancel_reclassifies_failed_claim_inside_settlement_lock() {
        let (lifecycle, sender) = session();
        let lifecycle = Arc::new(lifecycle);
        let workspace = Arc::new(Mutex::new(WorkspaceHost::default()));
        let runtime = RuntimeHost::unavailable_for_test();
        runtime.set_active_request_for_test("request-unrelated-runtime-owner");
        let (settlement_entered, release_settlement) =
            runtime.install_failed_claim_settlement_hook_for_test();
        let updates = Arc::new(Mutex::new(Vec::new()));
        let request = request(sender.generation, 1, "Must not reach Runtime.");
        let request_id = canonical_request_id(sender.generation, 1).unwrap();
        let requesting_lifecycle = Arc::clone(&lifecycle);
        let requesting_workspace = Arc::clone(&workspace);
        let requesting_runtime = runtime.clone();
        let requesting_updates = Arc::clone(&updates);
        let request_thread = std::thread::spawn(move || {
            turn_request_with_channel(
                &requesting_lifecycle,
                &requesting_workspace,
                &requesting_runtime,
                &sender,
                &request,
                |view, cutoff| {
                    requesting_updates
                        .lock()
                        .expect("turn updates")
                        .push((view, cutoff));
                    true
                },
            )
        });
        settlement_entered
            .recv_timeout(Duration::from_secs(1))
            .expect("failed claim paused before settlement");
        let records = lifecycle
            .lock()
            .expect("late Host cancellation")
            .renderer_lost();
        let record = records
            .iter()
            .find(|record| record.request_id == request_id)
            .expect("exact late Host cancellation")
            .clone();
        runtime.defer_host_cancellations(&records);
        let (released, wake) = &*release_settlement;
        *released.lock().expect("settlement release") = true;
        wake.notify_all();

        let output = request_thread.join().expect("settled turn request");
        assert!(output.encoded.contains(r#""state":"cancelled""#));
        assert!(!output.encoded.contains(r#""state":"cleanup-failed""#));
        let updates = updates.lock().expect("settled updates");
        let (terminal, cutoff) = updates.last().expect("terminal update");
        assert_eq!(terminal.state, TurnState::Cancelled);
        assert!(terminal.evidence.cleanup_complete);
        assert_eq!(
            *cutoff,
            Some(record.accepted.accepted_at + Duration::from_secs(5))
        );
        drop(updates);
        assert!(runtime.owns_request_for_test("request-unrelated-runtime-owner"));
        assert!(runtime.cancellation_window_for_test().is_none());
        runtime.finish_active_request_for_test();
    }

    #[test]
    fn post_compute_runtime_control_poison_fails_turn_settlement_closed_then_recovers() {
        let (lifecycle, sender) = session();
        let accepted_request = lifecycle
            .lock()
            .unwrap()
            .begin_application_request(
                &sender,
                request(sender.generation, 3, "Bounded task.").as_bytes(),
            )
            .unwrap();
        let request_id = canonical_request_id(sender.generation, 1).unwrap();
        let runtime = RuntimeHost::unavailable_for_test();
        runtime.set_active_request_for_test(&request_id);
        let mut completed = TurnSession::new(
            sender.generation,
            1,
            3,
            "Bounded task.".to_owned(),
            RuntimeDescriptor::approved(),
        )
        .unwrap();
        completed.mark_streaming().unwrap();
        completed.append_agent_delta("answer").unwrap();
        completed.complete().unwrap();
        completed.settle_cleanup(true).unwrap();
        let computed = completed.view();
        runtime.poison_control_for_test();
        let mut terminal = Vec::new();

        let output = finish_turn_with_runtime(
            &lifecycle,
            &runtime,
            &request_id,
            accepted_request,
            computed,
            &mut |commit| {
                commit().is_ok_and(|publication| {
                    terminal.push(publication.view);
                    true
                })
            },
        );

        assert_eq!(terminal.len(), 1);
        assert_eq!(terminal[0].state, TurnState::ContainmentFailed);
        assert_eq!(terminal[0].reason, Some(TurnReason::InternalFailure));
        assert!(terminal[0].evidence.cleanup_complete);
        assert!(output.encoded.contains(r#""state":"containment-failed""#));
        assert!(
            runtime.claim_turn_request_for_host_settlement("request-after-turn-settlement-poison")
        );
        assert!(runtime.cancellation_window_for_test().is_none());
        runtime.finish_active_request_for_test();
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
    fn a151_t1_turn_channel_rejects_a_non_turn_operation_before_runtime_claim() {
        let (lifecycle, sender) = session();
        let request_id = canonical_request_id(sender.generation, 1).expect("request ID");
        let request = format!(
            r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":1,"timeoutMs":5000,"operation":{{"kind":"runtime-readiness"}}}}"#,
        );
        let runtime = RuntimeHost::unavailable_for_test();
        let output = turn_request_with_channel(
            &lifecycle,
            &Mutex::new(WorkspaceHost::default()),
            &runtime,
            &sender,
            &request,
            |_, _| panic!("non-turn request must not publish a turn view"),
        );
        assert!(output.encoded.contains(r#""unknown-operation""#));
        assert!(runtime.has_no_runtime_effects_for_test());
    }

    #[test]
    fn a151_t2_turn_channel_failed_claim_settles_without_runtime_effect() {
        let (lifecycle, sender) = session();
        let runtime = RuntimeHost::unavailable_for_test();
        runtime.set_active_request_for_test("a151-t2-owner");
        let mut updates = Vec::new();
        let output = turn_request_with_channel(
            &lifecycle,
            &Mutex::new(WorkspaceHost::default()),
            &runtime,
            &sender,
            &request(sender.generation, 1, "Must not reach Runtime."),
            |view, cutoff| {
                updates.push((view, cutoff));
                true
            },
        );
        assert!(output.encoded.contains(r#""state":"cleanup-failed""#));
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[1].0.state, TurnState::CleanupFailed);
        assert_eq!(updates[1].0.reason, Some(TurnReason::CleanupFailed));
        assert!(!updates[1].0.evidence.cleanup_complete);
        assert_eq!(updates[1].1, None);
        assert!(runtime.owns_request_for_test("a151-t2-owner"));
        runtime.finish_active_request_for_test();
    }

    #[test]
    fn a151_t3_turn_channel_missing_workspace_settles_stale_and_cleans_claim() {
        let (lifecycle, sender) = session();
        let runtime = RuntimeHost::unavailable_for_test();
        let mut updates = Vec::new();
        let output = turn_request_with_channel(
            &lifecycle,
            &Mutex::new(WorkspaceHost::default()),
            &runtime,
            &sender,
            &request(sender.generation, 1, "Bounded task."),
            |view, cutoff| {
                updates.push((view, cutoff));
                true
            },
        );
        assert!(output.encoded.contains(r#""stale-workspace""#));
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[1].0.state, TurnState::Failed);
        assert_eq!(updates[1].0.reason, Some(TurnReason::StaleWorkspace));
        assert_eq!(updates[1].1, None);
        assert!(runtime.has_no_runtime_effects_for_test());
    }

    #[test]
    fn a76_turn_channel_rejects_missing_turn_input_after_exact_admission() {
        let (lifecycle, sender) = session();
        let request_id = canonical_request_id(sender.generation, 1).expect("request ID");
        let encoded = serde_json::to_string(&json!({
            "schemaVersion": 1,
            "requestId": request_id,
            "sequence": 1,
            "timeoutMs": 5_000,
            "operation": {
                "kind": "codex-turn-start",
                "workspaceGeneration": 1
            }
        }))
        .expect("invalid turn request");
        let runtime = RuntimeHost::unavailable_for_test();
        let output = turn_request_with_channel(
            &lifecycle,
            &Mutex::new(WorkspaceHost::default()),
            &runtime,
            &sender,
            &encoded,
            |_, _| panic!("invalid turn must not publish"),
        );
        assert!(output.encoded.contains(r#""invalid-request""#));
        assert!(runtime.has_no_runtime_effects_for_test());
    }

    #[test]
    fn a76_healthy_terminal_publication_keeps_the_computed_state() {
        let (lifecycle, sender) = session();
        let encoded = request(sender.generation, 1, "Bounded task.");
        let accepted = lifecycle
            .lock()
            .expect("Host admission")
            .begin_application_request(&sender, encoded.as_bytes())
            .expect("accepted turn");
        let request_id = canonical_request_id(sender.generation, 1).expect("request ID");
        let runtime = RuntimeHost::unavailable_for_test();
        runtime.set_active_request_for_test(&request_id);
        let mut terminal = TurnSession::new(
            sender.generation,
            1,
            1,
            "Bounded task.".to_owned(),
            RuntimeDescriptor::approved(),
        )
        .expect("turn session");
        terminal
            .fail(TurnState::Failed, TurnReason::ProviderFailed)
            .expect("terminal");
        terminal.settle_cleanup(true).expect("cleanup");
        let mut published = Vec::new();
        let output = finish_turn_with_runtime(
            &lifecycle,
            &runtime,
            &request_id,
            accepted,
            terminal.view(),
            &mut |commit| {
                published.push(commit().expect("prepared terminal").view);
                true
            },
        );
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].state, TurnState::Failed);
        assert!(output.encoded.contains(r#""provider-failed""#));
        assert!(runtime.has_no_runtime_effects_for_test());
    }

    #[test]
    fn b71_late_exact_acceptance_overrides_failed_publication_result() {
        let (lifecycle, sender) = session();
        let encoded = request(sender.generation, 1, "Bounded task.");
        let accepted = lifecycle
            .lock()
            .expect("Host admission")
            .begin_application_request(&sender, encoded.as_bytes())
            .expect("accepted turn");
        let request_id = canonical_request_id(sender.generation, 1).expect("request ID");
        let runtime = RuntimeHost::unavailable_for_test();
        runtime.set_active_request_for_test(&request_id);
        let mut terminal = TurnSession::new(
            sender.generation,
            1,
            1,
            "Bounded task.".to_owned(),
            RuntimeDescriptor::approved(),
        )
        .expect("turn session");
        terminal
            .fail(TurnState::Failed, TurnReason::ProviderFailed)
            .expect("terminal");
        terminal.settle_cleanup(true).expect("cleanup");
        let record = crate::HostCancellationRecord {
            request_id: request_id.clone(),
            accepted: crate::request_timing::AcceptedCancellation {
                accepted_at: Instant::now(),
                source: crate::request_timing::CancellationSource::RendererLost,
            },
        };
        let output = finish_turn_with_runtime(
            &lifecycle,
            &runtime,
            &request_id,
            accepted,
            terminal.view(),
            &mut |_| {
                runtime.defer_host_cancellations(std::slice::from_ref(&record));
                false
            },
        );
        assert!(output.encoded.contains(r#""state":"containment-failed""#));
        assert!(output.encoded.contains(r#""cleanupComplete":true"#));
        assert!(runtime.has_no_runtime_effects_for_test());
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
            repository_context_bytes_to_runtime: 0,
            cleaned,
            cancellation: None,
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

        let mut repository_context_rejected = new_session();
        let mut leaked = outcome(TurnState::Completed, None, true);
        leaked.repository_context_bytes_to_runtime = 7;
        settle_session(&mut repository_context_rejected, leaked, false);
        let rejected_view = repository_context_rejected.view();
        assert_eq!(rejected_view.state, TurnState::ContainmentFailed);
        assert_eq!(
            rejected_view.evidence.repository_context_bytes_to_runtime,
            7
        );

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

        let mut partial_correlation = new_session();
        settle_session(
            &mut partial_correlation,
            TurnRuntimeOutcome {
                state: TurnState::Failed,
                reason: Some(TurnReason::ProviderFailed),
                agent_text: String::new(),
                provider_thread_established: true,
                provider_turn_established: false,
                quarantined_events: 0,
                repository_context_bytes_to_runtime: 0,
                cleaned: true,
                cancellation: None,
            },
            false,
        );
        let partial_view = partial_correlation.view();
        assert!(partial_view.provider_thread_established);
        assert!(!partial_view.provider_turn_established);
    }

    #[test]
    fn a151_settlement_state_matrix_covers_cutoff_claim_and_control_failure() {
        let new_session = || {
            TurnSession::new(
                1,
                1,
                1,
                "Bounded task.".to_owned(),
                RuntimeDescriptor::approved(),
            )
            .expect("turn session")
        };
        let base = new_session().view();
        let acceptance = crate::request_timing::AcceptedCancellation {
            accepted_at: Instant::now(),
            source: crate::request_timing::CancellationSource::RendererLost,
        };
        let ordinary = settlement_publication_state(base.clone(), false, false, None);
        assert_eq!(ordinary.state, TurnState::Preflighting);
        assert!(!ordinary.evidence.cleanup_complete);
        let control_failed = settlement_publication_state(base.clone(), true, false, None);
        assert_eq!(control_failed.state, TurnState::ContainmentFailed);
        assert!(!control_failed.evidence.cleanup_complete);
        let cancelled = settlement_publication_state(base.clone(), false, true, Some(acceptance));
        assert_eq!(cancelled.state, TurnState::Failed);
        assert!(cancelled.evidence.cleanup_complete);
        let failed_claim = settlement_publication_state(base.clone(), false, true, None);
        assert_eq!(failed_claim.state, TurnState::Preflighting);
        assert!(!failed_claim.evidence.cleanup_complete);

        let mut crossed = new_session();
        crossed.mark_streaming().expect("streaming");
        crossed.append_agent_delta("answer").expect("delta");
        let accepted_at = Instant::now() - Duration::from_secs(6);
        let cancellation_runtime = RuntimeHost::unavailable_for_test();
        cancellation_runtime.set_active_request_for_test("a151-crossed-cutoff");
        cancellation_runtime.accept_request_cancellation(
            "a151-crossed-cutoff",
            crate::request_timing::AcceptedCancellation {
                accepted_at,
                source: crate::request_timing::CancellationSource::AppShutdown,
            },
        );
        settle_session(
            &mut crossed,
            TurnRuntimeOutcome {
                state: TurnState::Completed,
                reason: None,
                agent_text: "answer".to_owned(),
                provider_thread_established: false,
                provider_turn_established: false,
                quarantined_events: 0,
                repository_context_bytes_to_runtime: 0,
                cleaned: true,
                cancellation: cancellation_runtime.cancellation_window_for_test(),
            },
            false,
        );
        cancellation_runtime.finish_active_request_for_test();
        assert_eq!(crossed.view().state, TurnState::ContainmentFailed);
        assert_eq!(crossed.view().reason, Some(TurnReason::ProtocolRejected));
    }

    #[test]
    fn a151_failed_terminal_prepare_does_not_emit_a_projection() {
        let (lifecycle, sender) = session();
        let accepted = lifecycle
            .lock()
            .expect("Host lifecycle")
            .begin_application_request(
                &sender,
                request(sender.generation, 3, "Bounded task.").as_bytes(),
            )
            .expect("accepted turn");
        let terminal = TurnSession::new(
            sender.generation,
            1,
            3,
            "Bounded task.".to_owned(),
            RuntimeDescriptor::approved(),
        )
        .expect("turn session")
        .view();
        std::thread::scope(|scope| {
            let lifecycle = &lifecycle;
            assert!(
                scope
                    .spawn(move || {
                        let _guard = lifecycle.lock().expect("poison lifecycle");
                        panic!("injected Host lifecycle poison");
                    })
                    .join()
                    .is_err()
            );
        });
        let mut updates = Vec::new();

        let output = finish_turn(&lifecycle, accepted, terminal, None, &mut |view| {
            updates.push(view)
        });

        assert!(updates.is_empty());
        assert!(output.encoded.contains(r#""internal-failure""#));
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

        let (projected_lifecycle, projected_sender) = session();
        let projected_request = request(projected_sender.generation, 3, "Bounded task.");
        let projected_accepted = projected_lifecycle
            .lock()
            .unwrap()
            .begin_application_request(&projected_sender, projected_request.as_bytes())
            .unwrap();
        let projected_cancellation = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "requestId": canonical_request_id(projected_sender.generation, 1).unwrap()
        }))
        .unwrap();
        assert!(
            projected_lifecycle
                .lock()
                .unwrap()
                .cancel_application_request(&projected_sender, &projected_cancellation)
                .contains("cancelled")
        );
        let mut projected_updates = Vec::new();
        let projected = finish_turn(
            &projected_lifecycle,
            projected_accepted,
            raced.view(),
            host_cancellation(&projected_lifecycle),
            &mut |view| projected_updates.push(view),
        );
        assert!(projected.encoded.contains(r#""state":"cancelled""#));
        assert_eq!(projected_updates.len(), 1);
        assert_eq!(projected_updates[0].state, TurnState::Cancelled);
        assert_eq!(projected_updates[0].reason, Some(TurnReason::UserCancelled));

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
    fn accepted_cancel_publishes_authoritative_terminal_after_runtime_settlement() {
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

        let mut stopping = TurnSession::new(
            sender.generation,
            1,
            3,
            "Bounded task.".to_owned(),
            RuntimeDescriptor::approved(),
        )
        .unwrap();
        stopping.request_stop(TurnReason::UserCancelled).unwrap();
        let mut updates = vec![stopping.view()];

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
        let output = finish_turn(
            &lifecycle,
            accepted,
            raced.view(),
            host_cancellation(&lifecycle),
            &mut |view| updates.push(view),
        );

        assert!(output.encoded.contains(r#""state":"cancelled""#));
        assert_eq!(
            updates.last().map(|view| view.state),
            Some(TurnState::Cancelled),
            "the last semantic publication must use lifecycle cancellation precedence"
        );
    }

    #[test]
    fn host_final_publication_enforces_the_literal_cancel_terminal_cutoff() {
        let (lifecycle, sender) = session();
        lifecycle.lock().unwrap().set_test_now_ms(0);
        let encoded_request = request(sender.generation, 3, "Bounded task.");
        let accepted = lifecycle
            .lock()
            .unwrap()
            .begin_application_request(&sender, encoded_request.as_bytes())
            .unwrap();
        lifecycle.lock().unwrap().set_test_now_ms(1);
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
        lifecycle.lock().unwrap().set_test_now_ms(5_002);

        let output = finish_turn(
            &lifecycle,
            accepted,
            raced.view(),
            host_cancellation(&lifecycle),
            &mut |_| {},
        );
        assert!(output.encoded.contains(r#""state":"containment-failed""#));
        assert!(output.encoded.contains(r#""reason":"protocol-rejected""#));
        assert!(!output.encoded.contains(r#""state":"cancelled""#));
    }

    #[test]
    fn runtime_token_mismatch_and_delayed_callback_fail_the_publication_envelope() {
        for mismatch in [false, true] {
            let (lifecycle, sender) = session();
            lifecycle.lock().unwrap().set_test_now_ms(0);
            let encoded_request = request(sender.generation, 3, "Bounded task.");
            let accepted_request = lifecycle
                .lock()
                .unwrap()
                .begin_application_request(&sender, encoded_request.as_bytes())
                .unwrap();
            lifecycle.lock().unwrap().set_test_now_ms(1);
            let cancellation = serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "requestId": canonical_request_id(sender.generation, 1).unwrap()
            }))
            .unwrap();
            let host_acceptance = lifecycle
                .lock()
                .unwrap()
                .cancel_application_request_with_acceptance(&sender, &cancellation)
                .accepted
                .expect("Host token");
            let runtime_acceptance = mismatch
                .then_some(crate::request_timing::AcceptedCancellation {
                    accepted_at: host_acceptance.accepted_at + Duration::from_millis(1),
                    source: host_acceptance.source,
                })
                .or(Some(host_acceptance));
            lifecycle.lock().unwrap().set_test_now_ms(4_999);
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
            let mut updates = Vec::new();
            let output = finish_turn_with_envelope_for_test(
                &lifecycle,
                accepted_request,
                raced.view(),
                runtime_acceptance,
                |lifecycle| {
                    if !mismatch {
                        lifecycle.set_test_now_ms(5_002);
                    }
                },
                &mut |view| updates.push(view),
            );
            assert!(output.encoded.contains(r#""state":"containment-failed""#));
            assert_eq!(
                updates.last().map(|view| view.state),
                Some(TurnState::ContainmentFailed)
            );
        }
    }

    #[test]
    fn terminal_callback_and_response_use_the_inclusive_host_deadline_after_cleanup() {
        for (publication_at_ms, expected_state) in [
            (4_999, TurnState::CleanupFailed),
            (5_000, TurnState::CleanupFailed),
            (5_001, TurnState::ContainmentFailed),
        ] {
            let (lifecycle, sender) = session();
            lifecycle.lock().unwrap().set_test_now_ms(0);
            let encoded_request = request(sender.generation, 3, "Bounded task.");
            let accepted_request = lifecycle
                .lock()
                .unwrap()
                .begin_application_request(&sender, encoded_request.as_bytes())
                .unwrap();
            lifecycle.lock().unwrap().set_test_now_ms(1);
            let cancellation = serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "requestId": canonical_request_id(sender.generation, 1).unwrap()
            }))
            .unwrap();
            let host_acceptance = lifecycle
                .lock()
                .unwrap()
                .cancel_application_request_with_acceptance(&sender, &cancellation)
                .accepted
                .expect("Host token");
            let request_id = canonical_request_id(sender.generation, 1).unwrap();
            let runtime = RuntimeHost::unavailable_for_test();
            runtime.set_active_request_for_test(&request_id);
            runtime.accept_request_cancellation(&request_id, host_acceptance);
            lifecycle
                .lock()
                .unwrap()
                .set_test_now_ms(publication_at_ms + 1);
            let mut stopping = TurnSession::new(
                sender.generation,
                1,
                3,
                "Bounded task.".to_owned(),
                RuntimeDescriptor::approved(),
            )
            .unwrap();
            stopping.request_stop(TurnReason::UserCancelled).unwrap();
            stopping.settle_cleanup(false).unwrap();
            let mut terminal_updates = Vec::new();
            let output = finish_turn_with_runtime(
                &lifecycle,
                &runtime,
                &request_id,
                accepted_request,
                stopping.view(),
                &mut |commit| {
                    commit().is_ok_and(|publication| {
                        terminal_updates.push(publication.view);
                        true
                    })
                },
            );

            assert_eq!(terminal_updates.len(), 1);
            assert_eq!(terminal_updates[0].state, expected_state);
            assert!(output.encoded.contains(&format!(
                r#""state":"{}""#,
                match expected_state {
                    TurnState::CleanupFailed => "cleanup-failed",
                    TurnState::ContainmentFailed => "containment-failed",
                    _ => unreachable!(),
                }
            )));
        }
    }

    #[test]
    fn successful_terminal_callback_revalidates_after_effect_completion() {
        let (lifecycle, sender) = session();
        lifecycle.lock().unwrap().set_test_now_ms(0);
        let encoded_request = request(sender.generation, 3, "Bounded task.");
        let accepted_request = lifecycle
            .lock()
            .unwrap()
            .begin_application_request(&sender, encoded_request.as_bytes())
            .unwrap();
        lifecycle.lock().unwrap().set_test_now_ms(1);
        let cancellation = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "requestId": canonical_request_id(sender.generation, 1).unwrap()
        }))
        .unwrap();
        let host_acceptance = lifecycle
            .lock()
            .unwrap()
            .cancel_application_request_with_acceptance(&sender, &cancellation)
            .accepted
            .expect("Host token");
        let request_id = canonical_request_id(sender.generation, 1).unwrap();
        let runtime = RuntimeHost::unavailable_for_test();
        runtime.set_active_request_for_test(&request_id);
        runtime.accept_request_cancellation(&request_id, host_acceptance);
        lifecycle.lock().unwrap().set_test_now_ms(5_000);
        let mut stopping = TurnSession::new(
            sender.generation,
            1,
            3,
            "Bounded task.".to_owned(),
            RuntimeDescriptor::approved(),
        )
        .unwrap();
        stopping.request_stop(TurnReason::UserCancelled).unwrap();
        stopping.settle_cleanup(false).unwrap();
        let mut terminal_updates = Vec::new();

        let output = finish_turn_with_runtime(
            &lifecycle,
            &runtime,
            &request_id,
            accepted_request,
            stopping.view(),
            &mut |commit| {
                commit().is_ok_and(|publication| {
                    terminal_updates.push(publication.view);
                    lifecycle.lock().unwrap().set_test_now_ms(5_002);
                    true
                })
            },
        );

        assert_eq!(terminal_updates.len(), 1);
        assert_eq!(terminal_updates[0].state, TurnState::CleanupFailed);
        assert!(output.encoded.contains(r#""state":"containment-failed""#));
        assert!(!output.encoded.contains(r#""state":"cleanup-failed""#));
    }

    #[test]
    fn deferred_terminal_callback_is_provisional_and_response_fails_closed() {
        let (lifecycle, sender) = session();
        let accepted_request = lifecycle
            .lock()
            .unwrap()
            .begin_application_request(
                &sender,
                request(sender.generation, 3, "Bounded task.").as_bytes(),
            )
            .unwrap();
        let request_id = canonical_request_id(sender.generation, 1).unwrap();
        let runtime = RuntimeHost::unavailable_for_test();
        runtime.set_active_request_for_test(&request_id);
        let mut completed = TurnSession::new(
            sender.generation,
            1,
            3,
            "Bounded task.".to_owned(),
            RuntimeDescriptor::approved(),
        )
        .unwrap();
        completed.mark_streaming().unwrap();
        completed.append_agent_delta("answer").unwrap();
        completed.complete().unwrap();
        completed.settle_cleanup(true).unwrap();
        let (publication_started, publication_entered) = mpsc::sync_channel(1);
        let (release_publication, publication_release) = mpsc::sync_channel(1);
        let mut publication_release = Some(publication_release);
        let mut provisional = Vec::new();

        let output = finish_turn_with_runtime(
            &lifecycle,
            &runtime,
            &request_id,
            accepted_request,
            completed.view(),
            &mut |commit| {
                let Ok(publication) = commit() else {
                    return false;
                };
                provisional.push(publication.view);
                let publication_cutoff = publication
                    .terminal_cutoff
                    .unwrap_or_else(|| Instant::now() + Duration::from_millis(100));
                let publication_started = publication_started.clone();
                let publication_release = publication_release
                    .take()
                    .expect("single terminal publication");
                matches!(
                    runtime.publish_terminal_update_until(publication_cutoff, move || {
                        publication_started.send(()).expect("publication entered");
                        publication_release
                            .recv_timeout(Duration::from_secs(1))
                            .expect("publication released");
                        true
                    }),
                    crate::runtime::TerminalPublicationOutcome::Completed(true)
                )
            },
        );
        publication_entered
            .recv_timeout(Duration::from_secs(1))
            .expect("publication worker entered callback");
        release_publication.send(()).expect("release publication");

        assert_eq!(provisional.len(), 1);
        assert_eq!(provisional[0].state, TurnState::Completed);
        assert!(output.encoded.contains(r#""state":"cleanup-failed""#));
        assert!(!output.encoded.contains(r#""state":"completed""#));
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
            session
                .fail(TurnState::CleanupFailed, TurnReason::CleanupFailed)
                .unwrap();
            session.settle_cleanup(true).unwrap();
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

    #[test]
    fn incomplete_cleanup_cannot_be_rewritten_as_clean_cancellation() {
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
        lifecycle
            .lock()
            .unwrap()
            .cancel_application_request(&sender, &cancellation);

        let mut completed = TurnSession::new(
            sender.generation,
            1,
            3,
            "Bounded task.".to_owned(),
            RuntimeDescriptor::approved(),
        )
        .unwrap();
        completed.mark_streaming().unwrap();
        completed.append_agent_delta("late completion").unwrap();
        completed.complete().unwrap();
        completed.settle_cleanup(true).unwrap();
        let mut inconsistent = completed.view();
        inconsistent.evidence.cleanup_complete = false;

        let encoded = lifecycle
            .lock()
            .unwrap()
            .complete_turn_request(accepted, inconsistent);
        assert!(encoded.contains(r#""state":"cleanup-failed""#));
        assert!(encoded.contains(r#""reason":"cleanup-failed""#));
        assert!(encoded.contains(r#""cleanupComplete":false"#));
    }

    #[test]
    fn duplicate_turn_completion_fails_closed() {
        let (lifecycle, sender) = session();
        let encoded_request = request(sender.generation, 3, "Bounded task.");
        let accepted = lifecycle
            .lock()
            .unwrap()
            .begin_application_request(&sender, encoded_request.as_bytes())
            .unwrap();
        let duplicate = AcceptedRequest {
            generation: accepted.generation,
            request: accepted.request.clone(),
        };
        let mut completed = TurnSession::new(
            sender.generation,
            1,
            3,
            "Bounded task.".to_owned(),
            RuntimeDescriptor::approved(),
        )
        .unwrap();
        completed.mark_streaming().unwrap();
        completed.append_agent_delta("answer").unwrap();
        completed.complete().unwrap();
        completed.settle_cleanup(true).unwrap();

        let first = lifecycle
            .lock()
            .unwrap()
            .complete_turn_request(accepted, completed.view());
        assert!(first.contains(r#""kind":"codex-turn""#));
        let second = lifecycle
            .lock()
            .unwrap()
            .complete_turn_request(duplicate, completed.view());
        assert!(second.contains(r#""code":"internal-failure""#));
    }

    #[test]
    fn host_identity_mismatch_retires_the_exact_accepted_turn() {
        let (lifecycle, sender) = session();
        let encoded_request = request(sender.generation, 3, "Bounded task.");
        let accepted = lifecycle
            .lock()
            .unwrap()
            .begin_application_request(&sender, encoded_request.as_bytes())
            .unwrap();
        let mismatched = AcceptedRequest {
            generation: accepted.generation + 1,
            request: accepted.request.clone(),
        };
        let mut completed = TurnSession::new(
            sender.generation,
            1,
            3,
            "Bounded task.".to_owned(),
            RuntimeDescriptor::approved(),
        )
        .unwrap();
        completed.mark_streaming().unwrap();
        completed.append_agent_delta("answer").unwrap();
        completed.complete().unwrap();
        completed.settle_cleanup(true).unwrap();

        let mismatch = lifecycle
            .lock()
            .unwrap()
            .complete_turn_request(mismatched, completed.view());
        assert!(mismatch.contains(r#""code":"internal-failure""#));

        let replay = lifecycle
            .lock()
            .unwrap()
            .complete_turn_request(accepted, completed.view());
        assert!(
            replay.contains(r#""code":"internal-failure""#),
            "the mismatched terminal attempt must retire the exact accepted request"
        );
    }
}
