use serde::{Deserialize, Serialize};

use crate::runtime::{
    CODEX_RUNTIME_SHA256, CODEX_RUNTIME_VERSION, CONTAINMENT_PROFILE, RuntimeDescriptor,
};

pub const MAX_TASK_BYTES: usize = 4_096;
pub const MAX_AGENT_TEXT_BYTES: usize = 256 * 1_024;
pub const MAX_QUARANTINED_TURN_EVENTS: u16 = 64;
pub const NO_EFFECT_AUTHORITY_PROFILE: &str = "keiko-codex-no-effect-v1";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnState {
    Preflighting,
    Streaming,
    Stopping,
    Completed,
    Cancelled,
    Failed,
    TimedOut,
    ContainmentFailed,
    CleanupFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnReason {
    UserCancelled,
    AppShutdown,
    StaleWorkspace,
    RuntimeUnavailable,
    RuntimeIncompatible,
    AuthenticationRequired,
    ProviderFailed,
    RendererLost,
    ProtocolRejected,
    EffectDenied,
    BufferLimit,
    TimedOut,
    CleanupFailed,
    InternalFailure,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TurnEvidence {
    #[serde(rename = "runtimeVersion")]
    pub runtime_version: String,
    #[serde(rename = "runtimeArtifactSha256")]
    pub runtime_artifact_sha256: String,
    #[serde(rename = "containmentProfile")]
    pub containment_profile: String,
    #[serde(rename = "authorityProfile")]
    pub authority_profile: String,
    #[serde(rename = "messageBytes")]
    pub message_bytes: u32,
    #[serde(rename = "quarantinedEvents")]
    pub quarantined_events: u16,
    #[serde(rename = "acceptedEffects")]
    pub accepted_effects: u8,
    #[serde(rename = "cleanupComplete")]
    pub cleanup_complete: bool,
    #[serde(rename = "terminalState")]
    pub terminal_state: TurnState,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TurnView {
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "workspaceGeneration")]
    pub workspace_generation: u64,
    pub state: TurnState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<TurnReason>,
    #[serde(rename = "agentText")]
    pub agent_text: String,
    #[serde(rename = "providerThreadEstablished")]
    pub provider_thread_established: bool,
    #[serde(rename = "providerTurnEstablished")]
    pub provider_turn_established: bool,
    pub evidence: TurnEvidence,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TurnError {
    InvalidIdentity,
    InvalidTask,
    InvalidTransition,
    DeltaTooLarge,
    QuarantineLimit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnSession {
    task_id: String,
    run_id: String,
    workspace_generation: u64,
    task: String,
    runtime_descriptor: RuntimeDescriptor,
    state: TurnState,
    reason: Option<TurnReason>,
    agent_text: String,
    provider_thread_established: bool,
    provider_turn_established: bool,
    quarantined_events: u16,
    cleanup_complete: bool,
}

impl TurnSession {
    pub fn new(
        renderer_generation: u64,
        request_sequence: u64,
        workspace_generation: u64,
        task: String,
        runtime_descriptor: RuntimeDescriptor,
    ) -> Result<Self, TurnError> {
        if renderer_generation == 0 || request_sequence == 0 || workspace_generation == 0 {
            return Err(TurnError::InvalidIdentity);
        }
        if !valid_task(&task) || runtime_descriptor != RuntimeDescriptor::approved() {
            return Err(TurnError::InvalidTask);
        }
        Ok(Self {
            task_id: format!("task-{renderer_generation:016}-{request_sequence:016}"),
            run_id: format!("run-{renderer_generation:016}-{request_sequence:016}"),
            workspace_generation,
            task,
            runtime_descriptor,
            state: TurnState::Preflighting,
            reason: None,
            agent_text: String::new(),
            provider_thread_established: false,
            provider_turn_established: false,
            quarantined_events: 0,
            cleanup_complete: false,
        })
    }

    pub fn task(&self) -> &str {
        &self.task
    }

    pub fn mark_streaming(&mut self) -> Result<(), TurnError> {
        if self.state != TurnState::Preflighting {
            return Err(TurnError::InvalidTransition);
        }
        self.retain_provider_correlations(true, true)?;
        self.state = TurnState::Streaming;
        Ok(())
    }

    pub fn retain_provider_correlations(
        &mut self,
        thread_established: bool,
        turn_established: bool,
    ) -> Result<(), TurnError> {
        if turn_established && !thread_established {
            return Err(TurnError::InvalidTransition);
        }
        self.provider_thread_established |= thread_established;
        self.provider_turn_established |= turn_established;
        Ok(())
    }

    pub fn append_agent_delta(&mut self, delta: &str) -> Result<(), TurnError> {
        if self.state != TurnState::Streaming || delta.is_empty() {
            return Err(TurnError::InvalidTransition);
        }
        if self.agent_text.len().saturating_add(delta.len()) > MAX_AGENT_TEXT_BYTES {
            return Err(TurnError::DeltaTooLarge);
        }
        self.agent_text.push_str(delta);
        Ok(())
    }

    pub fn quarantine_provider_event(&mut self) -> Result<(), TurnError> {
        if !matches!(self.state, TurnState::Preflighting | TurnState::Streaming) {
            return Err(TurnError::InvalidTransition);
        }
        self.quarantined_events = self
            .quarantined_events
            .checked_add(1)
            .filter(|count| *count <= MAX_QUARANTINED_TURN_EVENTS)
            .ok_or(TurnError::QuarantineLimit)?;
        Ok(())
    }

    pub fn complete(&mut self) -> Result<(), TurnError> {
        if self.state != TurnState::Streaming || self.agent_text.is_empty() {
            return Err(TurnError::InvalidTransition);
        }
        self.state = TurnState::Completed;
        Ok(())
    }

    pub fn request_stop(&mut self, reason: TurnReason) -> Result<(), TurnError> {
        if !matches!(self.state, TurnState::Preflighting | TurnState::Streaming)
            || !matches!(
                reason,
                TurnReason::UserCancelled | TurnReason::RendererLost | TurnReason::AppShutdown
            )
        {
            return Err(TurnError::InvalidTransition);
        }
        self.state = TurnState::Stopping;
        self.reason = Some(reason);
        Ok(())
    }

    pub fn cancel(&mut self, reason: TurnReason) -> Result<(), TurnError> {
        if self.state != TurnState::Stopping || self.reason != Some(reason) {
            return Err(TurnError::InvalidTransition);
        }
        self.state = TurnState::Cancelled;
        Ok(())
    }

    pub fn fail(&mut self, state: TurnState, reason: TurnReason) -> Result<(), TurnError> {
        if !matches!(self.state, TurnState::Preflighting | TurnState::Streaming)
            || !matches!(
                state,
                TurnState::Failed
                    | TurnState::TimedOut
                    | TurnState::ContainmentFailed
                    | TurnState::CleanupFailed
            )
        {
            return Err(TurnError::InvalidTransition);
        }
        self.state = state;
        self.reason = Some(reason);
        Ok(())
    }

    pub fn settle_cleanup(&mut self, cleaned: bool) -> Result<(), TurnError> {
        if self.state == TurnState::Stopping && !cleaned {
            self.cleanup_complete = false;
            self.state = TurnState::CleanupFailed;
            self.reason = Some(TurnReason::CleanupFailed);
            return Ok(());
        }
        if !matches!(
            self.state,
            TurnState::Completed
                | TurnState::Cancelled
                | TurnState::Failed
                | TurnState::TimedOut
                | TurnState::ContainmentFailed
                | TurnState::CleanupFailed
        ) {
            return Err(TurnError::InvalidTransition);
        }
        self.cleanup_complete = cleaned;
        if !cleaned {
            self.state = TurnState::CleanupFailed;
            self.reason = Some(TurnReason::CleanupFailed);
        }
        Ok(())
    }

    pub fn view(&self) -> TurnView {
        TurnView {
            task_id: self.task_id.clone(),
            run_id: self.run_id.clone(),
            workspace_generation: self.workspace_generation,
            state: self.state,
            reason: self.reason,
            agent_text: self.agent_text.clone(),
            provider_thread_established: self.provider_thread_established,
            provider_turn_established: self.provider_turn_established,
            evidence: TurnEvidence {
                runtime_version: self.runtime_descriptor.version.clone(),
                runtime_artifact_sha256: self.runtime_descriptor.artifact_sha256.clone(),
                containment_profile: self.runtime_descriptor.containment_profile.clone(),
                authority_profile: NO_EFFECT_AUTHORITY_PROFILE.to_owned(),
                message_bytes: u32::try_from(self.agent_text.len()).unwrap_or(u32::MAX),
                quarantined_events: self.quarantined_events,
                accepted_effects: 0,
                cleanup_complete: self.cleanup_complete,
                terminal_state: self.state,
            },
        }
    }
}

pub fn valid_task(task: &str) -> bool {
    !task.trim().is_empty()
        && task.len() <= MAX_TASK_BYTES
        && task
            .chars()
            .all(|character| !character.is_control() || matches!(character, '\n' | '\r' | '\t'))
}

pub fn runtime_contract_is_approved(descriptor: &RuntimeDescriptor) -> bool {
    descriptor.version == CODEX_RUNTIME_VERSION
        && descriptor.artifact_sha256 == CODEX_RUNTIME_SHA256
        && descriptor.containment_profile == CONTAINMENT_PROFILE
        && descriptor.fresh_start_required
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(task: &str) -> TurnSession {
        TurnSession::new(7, 11, 13, task.to_owned(), RuntimeDescriptor::approved())
            .expect("turn session")
    }

    #[test]
    fn task_and_identity_contracts_are_bounded_and_distinct() {
        let current = session("Explain one terminal state.");
        let view = current.view();
        assert_ne!(view.task_id, view.run_id);
        assert_eq!(view.workspace_generation, 13);
        assert_eq!(current.task(), "Explain one terminal state.");

        for invalid in [
            String::new(),
            "  \n\t".to_owned(),
            "contains\u{0}control".to_owned(),
            "x".repeat(MAX_TASK_BYTES + 1),
        ] {
            assert_eq!(
                TurnSession::new(1, 1, 1, invalid, RuntimeDescriptor::approved()),
                Err(TurnError::InvalidTask)
            );
        }
        assert!(
            TurnSession::new(
                1,
                1,
                1,
                "é".repeat(MAX_TASK_BYTES / 2),
                RuntimeDescriptor::approved(),
            )
            .is_ok()
        );

        for identity in [(0, 1, 1), (1, 0, 1), (1, 1, 0)] {
            assert_eq!(
                TurnSession::new(
                    identity.0,
                    identity.1,
                    identity.2,
                    "Bounded task.".to_owned(),
                    RuntimeDescriptor::approved(),
                ),
                Err(TurnError::InvalidIdentity)
            );
        }

        let mut drifted = RuntimeDescriptor::approved();
        drifted.artifact_sha256 = "0".repeat(64);
        assert_eq!(
            TurnSession::new(1, 1, 1, "Bounded task.".to_owned(), drifted),
            Err(TurnError::InvalidTask)
        );
    }

    #[test]
    fn one_stream_reaches_one_terminal_state_with_body_free_evidence() {
        let mut current = session("Explain one terminal state.");
        current.quarantine_provider_event().unwrap();
        current.mark_streaming().unwrap();
        current.append_agent_delta("Exactly one ").unwrap();
        current.append_agent_delta("terminal state.").unwrap();
        current.complete().unwrap();
        current.settle_cleanup(true).unwrap();

        let view = current.view();
        assert_eq!(view.state, TurnState::Completed);
        assert_eq!(view.agent_text, "Exactly one terminal state.");
        assert_eq!(view.evidence.message_bytes, 27);
        assert_eq!(view.evidence.quarantined_events, 1);
        assert_eq!(view.evidence.accepted_effects, 0);
        assert!(view.evidence.cleanup_complete);
        assert_eq!(view.evidence.authority_profile, NO_EFFECT_AUTHORITY_PROFILE);
        assert_eq!(view.evidence.terminal_state, TurnState::Completed);
        assert_eq!(current.complete(), Err(TurnError::InvalidTransition));
    }

    #[test]
    fn partial_provider_correlation_is_retained_and_invalid_order_fails_closed() {
        let mut current = session("Retain one established correlation.");

        current
            .retain_provider_correlations(true, false)
            .expect("thread correlation");
        let view = current.view();
        assert!(view.provider_thread_established);
        assert!(!view.provider_turn_established);
        assert_eq!(
            current.retain_provider_correlations(false, true),
            Err(TurnError::InvalidTransition)
        );
        assert!(!current.view().provider_turn_established);
    }

    #[test]
    fn streaming_and_quarantine_limits_fail_closed() {
        let mut current = session("Explain one terminal state.");
        current.mark_streaming().unwrap();
        assert_eq!(
            current.append_agent_delta(&"x".repeat(MAX_AGENT_TEXT_BYTES + 1)),
            Err(TurnError::DeltaTooLarge)
        );
        current
            .fail(TurnState::ContainmentFailed, TurnReason::BufferLimit)
            .unwrap();
        current.settle_cleanup(false).unwrap();
        assert_eq!(current.view().state, TurnState::CleanupFailed);

        let mut quarantined = session("Explain one terminal state.");
        for _ in 0..MAX_QUARANTINED_TURN_EVENTS {
            quarantined.quarantine_provider_event().unwrap();
        }
        assert_eq!(
            quarantined.quarantine_provider_event(),
            Err(TurnError::QuarantineLimit)
        );
    }

    #[test]
    fn invalid_turn_transitions_are_rejected_without_mutating_terminal_state() {
        let mut current = session("Explain one terminal state.");
        assert_eq!(
            current.append_agent_delta("not streaming"),
            Err(TurnError::InvalidTransition)
        );
        assert_eq!(
            current.append_agent_delta(""),
            Err(TurnError::InvalidTransition)
        );
        assert_eq!(current.complete(), Err(TurnError::InvalidTransition));
        assert_eq!(
            current.settle_cleanup(true),
            Err(TurnError::InvalidTransition)
        );

        current.mark_streaming().unwrap();
        assert_eq!(current.mark_streaming(), Err(TurnError::InvalidTransition));
        assert_eq!(
            current.append_agent_delta(""),
            Err(TurnError::InvalidTransition)
        );
        assert_eq!(current.complete(), Err(TurnError::InvalidTransition));
        current.append_agent_delta("answer").unwrap();
        current.complete().unwrap();
        assert_eq!(
            current.quarantine_provider_event(),
            Err(TurnError::InvalidTransition)
        );
        assert_eq!(
            current.fail(TurnState::Failed, TurnReason::ProviderFailed),
            Err(TurnError::InvalidTransition)
        );
        current.settle_cleanup(true).unwrap();
        assert_eq!(current.view().state, TurnState::Completed);

        for invalid_terminal in [
            TurnState::Preflighting,
            TurnState::Streaming,
            TurnState::Completed,
        ] {
            let mut candidate = session("Explain one terminal state.");
            assert_eq!(
                candidate.fail(invalid_terminal, TurnReason::InternalFailure),
                Err(TurnError::InvalidTransition)
            );
        }
    }

    #[test]
    fn cancellation_stops_projection_and_one_terminal_state_wins() {
        for reason in [
            TurnReason::UserCancelled,
            TurnReason::RendererLost,
            TurnReason::AppShutdown,
        ] {
            let mut current = session("Explain one terminal state.");
            current.mark_streaming().unwrap();
            current.append_agent_delta("partial").unwrap();
            current.request_stop(reason).unwrap();
            assert_eq!(current.view().state, TurnState::Stopping);
            assert_eq!(current.view().reason, Some(reason));
            assert_eq!(
                current.append_agent_delta(" late"),
                Err(TurnError::InvalidTransition)
            );
            assert_eq!(
                current.quarantine_provider_event(),
                Err(TurnError::InvalidTransition)
            );
            current.cancel(reason).unwrap();
            current.settle_cleanup(true).unwrap();
            assert_eq!(current.view().state, TurnState::Cancelled);
            assert_eq!(current.view().evidence.terminal_state, TurnState::Cancelled);
            assert_eq!(
                current.complete(),
                Err(TurnError::InvalidTransition),
                "late completion must not replace cancellation"
            );
        }

        let mut completed = session("Explain one terminal state.");
        completed.mark_streaming().unwrap();
        completed.append_agent_delta("answer").unwrap();
        completed.complete().unwrap();
        assert_eq!(
            completed.request_stop(TurnReason::UserCancelled),
            Err(TurnError::InvalidTransition),
            "completion observed first must remain terminal"
        );

        let mut cleanup_failed = session("Explain one terminal state.");
        assert_eq!(
            cleanup_failed.request_stop(TurnReason::TimedOut),
            Err(TurnError::InvalidTransition),
            "only approved stop reasons may enter stopping"
        );
        cleanup_failed
            .request_stop(TurnReason::UserCancelled)
            .unwrap();
        assert_eq!(
            cleanup_failed.cancel(TurnReason::AppShutdown),
            Err(TurnError::InvalidTransition),
            "cancellation must match the recorded stop reason"
        );
        cleanup_failed.cancel(TurnReason::UserCancelled).unwrap();
        cleanup_failed.settle_cleanup(false).unwrap();
        assert_eq!(cleanup_failed.view().state, TurnState::CleanupFailed);

        let first = session("First attempt.").view();
        let retry = TurnSession::new(
            7,
            12,
            13,
            "Fresh retry.".to_owned(),
            RuntimeDescriptor::approved(),
        )
        .unwrap()
        .view();
        assert_ne!(first.task_id, retry.task_id);
        assert_ne!(first.run_id, retry.run_id);
    }

    #[test]
    fn approved_runtime_contract_is_exact() {
        assert!(runtime_contract_is_approved(&RuntimeDescriptor::approved()));
        let mut drifted = RuntimeDescriptor::approved();
        drifted.version = "0.146.0".to_owned();
        assert!(!runtime_contract_is_approved(&drifted));
    }
}
