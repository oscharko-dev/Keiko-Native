use std::collections::{HashMap, VecDeque};

use keiko_application::runtime::{RuntimeReadinessState, RuntimeReadinessView};
use keiko_application::turn::{TurnReason, TurnState, TurnView};
use keiko_application::{ApplicationResult, application_response, current_build_identity};
#[cfg(test)]
use keiko_ui_port::canonical_request_id;
use keiko_ui_port::{
    MAX_SEQUENCE, Operation, ReasonCode, UiRequest, cancel_request_id, dispatch_health,
    encode_cancelled, encode_error, encode_success, parse_cancel, parse_request,
    request_id_matches, request_metadata, request_operation,
};

mod acknowledgement;
pub mod document_nonce;
mod foundation;
#[cfg(feature = "tauri-host")]
mod request_adapter;
mod request_timing;
mod runtime;
mod sha256;
#[cfg(feature = "tauri-host")]
pub mod tauri_adapter;
mod turn;
mod workspace;
use acknowledgement::AcknowledgementState;
pub use foundation::{FoundationHost, FoundationRequestOutput, foundation_request};
#[cfg(feature = "tauri-host")]
pub use request_adapter::{
    ApplicationCancelOutput, ApplicationRequestOutput, application_cancel, application_request,
};
use request_timing::{
    AcceptedCancellation, CancellationSource, InFlight, MonotonicClock, terminal_cutoff_exceeded,
    terminal_reason,
};
pub use runtime::{RuntimeHost, RuntimeRequestOutput, runtime_request};
pub use turn::{TurnRequestOutput, turn_request};
pub use workspace::{FolderPickerResult, WorkspaceHost, WorkspaceRequestOutput, workspace_request};

const REPLAY_WINDOW: usize = 64;
const MAX_IN_FLIGHT_REQUESTS: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SenderContext {
    pub window_label: String,
    pub origin: String,
    pub generation: u64,
    pub document_nonce: String,
}

#[derive(Debug)]
struct RendererSession {
    acknowledgement: AcknowledgementState,
    generation: u64,
    document_nonce: String,
    last_sequence: u64,
    replayed_ids: VecDeque<String>,
}

#[derive(Debug, Eq, PartialEq)]
pub struct AcceptedRequest {
    generation: u64,
    request: UiRequest,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HostCancelOutcome {
    accepted: Option<AcceptedCancellation>,
    encoded: String,
    request_id: Option<String>,
    runtime_owned: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HostCancellationRecord {
    pub(crate) accepted: AcceptedCancellation,
    pub(crate) request_id: String,
}

#[derive(Debug, Eq, PartialEq)]
struct FoundationCompletion {
    encoded: String,
    live: bool,
    quit: bool,
}

#[derive(Debug)]
pub struct HostLifecycle {
    accepting: bool,
    clock: MonotonicClock,
    generation: u64,
    in_flight: HashMap<String, InFlight>,
    page_load_ambiguous: bool,
    pending_page_loads: u32,
    session: Option<RendererSession>,
}

impl Default for HostLifecycle {
    fn default() -> Self {
        Self {
            accepting: true,
            clock: MonotonicClock::default(),
            generation: 0,
            in_flight: HashMap::new(),
            page_load_ambiguous: false,
            pending_page_loads: 0,
            session: None,
        }
    }
}

impl HostLifecycle {
    pub fn begin_renderer_page_load<F>(&mut self, nonce_producer: F) -> bool
    where
        F: FnOnce(&HostLifecycle) -> Option<String>,
    {
        self.begin_renderer_page_load_with_cancellations(nonce_producer)
            .0
    }

    pub(crate) fn begin_renderer_page_load_with_cancellations<F>(
        &mut self,
        nonce_producer: F,
    ) -> (bool, Vec<HostCancellationRecord>)
    where
        F: FnOnce(&HostLifecycle) -> Option<String>,
    {
        let cancellations = self.prepare_renderer_page_load_replacement();
        let started = self.start_renderer_page_load(nonce_producer);
        (started, cancellations)
    }

    pub(crate) fn prepare_renderer_page_load_replacement(&mut self) -> Vec<HostCancellationRecord> {
        if self.pending_page_loads > 0 {
            self.page_load_ambiguous = true;
        }
        self.pending_page_loads = self.pending_page_loads.saturating_add(1);
        self.retire_renderer_authority()
    }

    pub(crate) fn start_renderer_page_load<F>(&mut self, nonce_producer: F) -> bool
    where
        F: FnOnce(&HostLifecycle) -> Option<String>,
    {
        nonce_producer(self)
            .and_then(|nonce| self.begin_renderer_session(nonce))
            .is_some()
    }

    pub fn finish_renderer_page_load(&mut self) -> Option<(u64, String)> {
        self.finish_renderer_page_load_with_cancellations().0
    }

    pub(crate) fn finish_renderer_page_load_with_cancellations(
        &mut self,
    ) -> (Option<(u64, String)>, Vec<HostCancellationRecord>) {
        if self.pending_page_loads == 0 {
            return (None, self.renderer_lost());
        }
        self.pending_page_loads -= 1;
        if self.page_load_ambiguous {
            let cancellations = self.retire_renderer_authority();
            if self.pending_page_loads == 0 {
                self.page_load_ambiguous = false;
            }
            return (None, cancellations);
        }
        if self.pending_page_loads != 0 {
            self.page_load_ambiguous = true;
            return (None, self.retire_renderer_authority());
        }
        (self.current_document_authority(), Vec::new())
    }

    pub fn begin_renderer_session(&mut self, document_nonce: String) -> Option<u64> {
        self.cancel_generation();
        if !valid_document_nonce(&document_nonce) {
            self.session = None;
            return None;
        }
        let Some(generation) = self
            .generation
            .checked_add(1)
            .filter(|generation| *generation <= MAX_SEQUENCE)
        else {
            self.session = None;
            return None;
        };
        self.generation = generation;
        self.session = Some(RendererSession {
            acknowledgement: AcknowledgementState::default(),
            generation: self.generation,
            document_nonce,
            last_sequence: 0,
            replayed_ids: VecDeque::with_capacity(REPLAY_WINDOW),
        });
        Some(self.generation)
    }

    pub(crate) fn renderer_lost(&mut self) -> Vec<HostCancellationRecord> {
        let cancellations = self.retire_renderer_authority();
        self.page_load_ambiguous = false;
        self.pending_page_loads = 0;
        cancellations
    }

    fn retire_renderer_authority(&mut self) -> Vec<HostCancellationRecord> {
        let cancellations = self.cancel_generation();
        self.session = None;
        cancellations
    }

    pub(crate) fn shutdown(&mut self) -> Vec<HostCancellationRecord> {
        self.accepting = false;
        let now_ms = self.clock.now_ms();
        let accepted_at = self.clock.now();
        let cancellations = self
            .in_flight
            .iter_mut()
            .filter_map(|(request_id, request)| {
                let accepted = request.cancel(now_ms, accepted_at, CancellationSource::AppShutdown);
                request.runtime_owned.then(|| HostCancellationRecord {
                    accepted,
                    request_id: request_id.clone(),
                })
            })
            .collect();
        self.page_load_ambiguous = false;
        self.pending_page_loads = 0;
        self.session = None;
        cancellations
    }

    pub fn sender_for_document(
        &self,
        window_label: &str,
        origin: &str,
        generation: u64,
        document_nonce: &str,
    ) -> SenderContext {
        SenderContext {
            window_label: window_label.to_owned(),
            origin: origin.to_owned(),
            generation,
            document_nonce: document_nonce.to_owned(),
        }
    }

    pub fn current_document_authority(&self) -> Option<(u64, String)> {
        self.session
            .as_ref()
            .map(|session| (session.generation, session.document_nonce.clone()))
    }

    pub fn begin_application_request(
        &mut self,
        context: &SenderContext,
        bytes: &[u8],
    ) -> Result<AcceptedRequest, (String, ReasonCode)> {
        self.validate_sender(context)?;
        let request =
            parse_request(bytes).map_err(|reason| ("unknown-request".to_owned(), reason))?;
        let (request_id, sequence, timeout_ms) = request_metadata(&request);
        let request_id = request_id.to_owned();
        if !request_id_matches(&request_id, context.generation, sequence) {
            return Err((request_id, ReasonCode::InvalidRequest));
        }
        let started_at_ms = self.clock.now_ms();
        let runtime_owned = matches!(
            request_operation(&request),
            Operation::CodexTurnStart { .. } | Operation::RuntimeReadiness
        );
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| (request_id.clone(), ReasonCode::HostUnavailable))?;
        if session
            .replayed_ids
            .iter()
            .any(|known| known == &request_id)
            || self.in_flight.contains_key(&request_id)
        {
            return Err((request_id, ReasonCode::ReplayedRequest));
        }
        if sequence <= session.last_sequence {
            return Err((request_id, ReasonCode::StaleRequest));
        }
        if self.in_flight.len() >= MAX_IN_FLIGHT_REQUESTS {
            return Err((request_id, ReasonCode::InternalFailure));
        }
        session.last_sequence = sequence;
        if session.replayed_ids.len() == REPLAY_WINDOW {
            session.replayed_ids.pop_front();
        }
        session.replayed_ids.push_back(request_id.clone());
        self.in_flight.insert(
            request_id,
            InFlight {
                accepted_cancellation: None,
                cancelled_at_ms: None,
                cancellation_source: None,
                generation: context.generation,
                runtime_owned,
                started_at_ms,
                timeout_ms,
            },
        );
        Ok(AcceptedRequest {
            generation: context.generation,
            request,
        })
    }

    pub fn complete_application_request(&mut self, accepted: AcceptedRequest) -> String {
        let encoded = dispatch_health(accepted.request.clone(), current_build_identity())
            .map(|response| encode_success(&response))
            .unwrap_or_else(|| encode_error("unknown-request", ReasonCode::UnknownOperation));
        self.complete_with_encoded(accepted, encoded)
    }

    fn resume_after_user_interaction(&mut self, accepted: &AcceptedRequest) -> bool {
        let (request_id, _, _) = request_metadata(&accepted.request);
        let now_ms = self.clock.now_ms();
        self.in_flight.get_mut(request_id).is_some_and(|request| {
            if request.generation != accepted.generation {
                return false;
            }
            request.started_at_ms = now_ms;
            true
        })
    }

    pub fn cancel_application_request(&mut self, context: &SenderContext, bytes: &[u8]) -> String {
        self.cancel_application_request_with_acceptance(context, bytes)
            .encoded
    }

    pub(crate) fn cancel_application_request_with_acceptance(
        &mut self,
        context: &SenderContext,
        bytes: &[u8],
    ) -> HostCancelOutcome {
        self.cancel_application_request_with_acceptance_before_mutation_impl(context, bytes, |_| {})
    }

    #[cfg(test)]
    pub(crate) fn cancel_application_request_with_acceptance_before_mutation(
        &mut self,
        context: &SenderContext,
        bytes: &[u8],
        before_mutation: impl FnOnce(&mut Self),
    ) -> HostCancelOutcome {
        self.cancel_application_request_with_acceptance_before_mutation_impl(
            context,
            bytes,
            before_mutation,
        )
    }

    fn cancel_application_request_with_acceptance_before_mutation_impl(
        &mut self,
        context: &SenderContext,
        bytes: &[u8],
        before_mutation: impl FnOnce(&mut Self),
    ) -> HostCancelOutcome {
        if let Err((request_id, reason)) = self.validate_sender(context) {
            return HostCancelOutcome {
                accepted: None,
                encoded: encode_error(&request_id, reason),
                request_id: None,
                runtime_owned: false,
            };
        }
        let request = match parse_cancel(bytes) {
            Ok(request) => request,
            Err(reason) => {
                return HostCancelOutcome {
                    accepted: None,
                    encoded: encode_error("unknown-request", reason),
                    request_id: None,
                    runtime_owned: false,
                };
            }
        };
        let request_id = cancel_request_id(&request);
        let now_ms = self.clock.now_ms();
        let Some(in_flight) = self.in_flight.get(request_id) else {
            return HostCancelOutcome {
                accepted: None,
                encoded: encode_error(request_id, ReasonCode::Unauthorized),
                request_id: None,
                runtime_owned: false,
            };
        };
        if in_flight.generation != context.generation {
            return HostCancelOutcome {
                accepted: None,
                encoded: encode_error(request_id, ReasonCode::Unauthorized),
                request_id: None,
                runtime_owned: false,
            };
        }
        if let Some(accepted) = in_flight.accepted_cancellation {
            return HostCancelOutcome {
                accepted: Some(accepted),
                encoded: encode_cancelled(request_id),
                request_id: Some(request_id.to_owned()),
                runtime_owned: in_flight.runtime_owned,
            };
        }
        if now_ms.saturating_sub(in_flight.started_at_ms) >= u64::from(in_flight.timeout_ms) {
            return HostCancelOutcome {
                accepted: None,
                encoded: encode_error(request_id, ReasonCode::TimedOut),
                request_id: None,
                runtime_owned: false,
            };
        }
        before_mutation(self);
        let accepted_at = self.clock.now();
        let in_flight = self
            .in_flight
            .get_mut(request_id)
            .expect("validated request remains present during one Host mutation");
        let accepted = in_flight.cancel(now_ms, accepted_at, CancellationSource::User);
        HostCancelOutcome {
            accepted: Some(accepted),
            encoded: encode_cancelled(request_id),
            request_id: Some(request_id.to_owned()),
            runtime_owned: in_flight.runtime_owned,
        }
    }

    #[cfg(test)]
    pub(crate) fn current_instant_for_test(&self) -> std::time::Instant {
        self.clock.now()
    }

    fn complete_with_encoded(&mut self, accepted: AcceptedRequest, encoded: String) -> String {
        self.complete_with_acknowledgement(accepted, encoded).0
    }

    fn complete_foundation_request(
        &mut self,
        accepted: AcceptedRequest,
        encoded: String,
        quit_requested: bool,
    ) -> FoundationCompletion {
        self.complete_foundation_request_with_availability(accepted, encoded, quit_requested, true)
    }

    #[cfg(test)]
    fn complete_turn_request(&mut self, accepted: AcceptedRequest, state: TurnView) -> String {
        let (request_id, _, _) = request_metadata(&accepted.request);
        let runtime_acceptance = self
            .in_flight
            .get(request_id)
            .and_then(|request| request.accepted_cancellation);
        self.complete_turn_request_with_publication(
            accepted,
            state,
            runtime_acceptance,
            |_| {},
            |_| {},
        )
    }

    #[cfg(test)]
    fn complete_turn_request_with_publication(
        &mut self,
        accepted: AcceptedRequest,
        state: TurnView,
        runtime_acceptance: Option<AcceptedCancellation>,
        before_publication: impl FnOnce(&mut Self),
        mut update: impl FnMut(TurnView),
    ) -> String {
        before_publication(self);
        let publication =
            self.prepare_turn_request_publication(&accepted, state, runtime_acceptance);
        if let Ok(publication) = &publication {
            update(publication.view.clone());
        }
        self.finalize_turn_request_publication(&accepted, publication, runtime_acceptance)
    }

    pub(crate) fn prepare_turn_request_publication(
        &self,
        accepted: &AcceptedRequest,
        mut state: TurnView,
        runtime_acceptance: Option<AcceptedCancellation>,
    ) -> Result<crate::turn::PreparedTerminalPublication, String> {
        let completed_at_ms = self.clock.now_ms();
        let (request_id, _, _) = request_metadata(&accepted.request);
        let Some(in_flight) = self.in_flight.get(request_id) else {
            return Err(encode_error(request_id, ReasonCode::InternalFailure));
        };
        if in_flight.generation != accepted.generation {
            return Err(encode_error(request_id, ReasonCode::InternalFailure));
        }
        // Turn shutdown first records AppShutdown on every in-flight request.
        // Treating completion as unavailable here would erase that precise
        // terminal outcome and replace it with a generic host failure.
        let terminal_reason = terminal_reason(in_flight, completed_at_ms, true);
        let cancellation_mismatch = in_flight.accepted_cancellation != runtime_acceptance;
        if !state.evidence.cleanup_complete {
            state.state = TurnState::CleanupFailed;
            state.reason = Some(TurnReason::CleanupFailed);
            state.evidence.terminal_state = TurnState::CleanupFailed;
        } else if cancellation_mismatch {
            state.state = TurnState::ContainmentFailed;
            state.reason = Some(TurnReason::ProtocolRejected);
            state.evidence.terminal_state = TurnState::ContainmentFailed;
        } else if state.state != TurnState::ContainmentFailed {
            match terminal_reason {
                None => {}
                Some(ReasonCode::Cancelled) => {
                    if state.state != TurnState::CleanupFailed {
                        if state.state != TurnState::Cancelled {
                            state.reason = Some(match in_flight.cancellation_source {
                                Some(CancellationSource::RendererLost) => TurnReason::RendererLost,
                                Some(CancellationSource::AppShutdown) => TurnReason::AppShutdown,
                                Some(CancellationSource::User) | None => TurnReason::UserCancelled,
                            });
                        }
                        state.state = TurnState::Cancelled;
                        state.evidence.terminal_state = TurnState::Cancelled;
                    }
                }
                Some(ReasonCode::TimedOut) => {
                    if state.state != TurnState::CleanupFailed {
                        state.state = TurnState::TimedOut;
                        state.reason = Some(TurnReason::TimedOut);
                        state.evidence.terminal_state = TurnState::TimedOut;
                    }
                }
                Some(reason) => return Err(encode_error(request_id, reason)),
            }
        }
        if in_flight.accepted_cancellation.is_some_and(|accepted| {
            terminal_cutoff_exceeded(
                self.clock.now(),
                accepted.accepted_at + std::time::Duration::from_secs(5),
            )
        }) {
            state.state = TurnState::ContainmentFailed;
            state.reason = Some(TurnReason::ProtocolRejected);
            state.evidence.terminal_state = TurnState::ContainmentFailed;
        }
        Ok(crate::turn::PreparedTerminalPublication {
            view: state,
            terminal_cutoff: in_flight
                .accepted_cancellation
                .map(|accepted| accepted.accepted_at + std::time::Duration::from_secs(5)),
        })
    }

    pub(crate) fn finalize_turn_request_publication(
        &mut self,
        accepted: &AcceptedRequest,
        publication: Result<crate::turn::PreparedTerminalPublication, String>,
        runtime_acceptance: Option<AcceptedCancellation>,
    ) -> String {
        let publication = publication.and_then(|publication| {
            self.prepare_turn_request_publication(accepted, publication.view, runtime_acceptance)
        });
        let (request_id, _, _) = request_metadata(&accepted.request);
        let request_id = request_id.to_owned();
        if self.in_flight.remove(&request_id).is_none() {
            return encode_error(&request_id, ReasonCode::InternalFailure);
        }
        match publication {
            Ok(publication) => encode_success(&application_response(
                &request_id,
                ApplicationResult::CodexTurn {
                    state: publication.view,
                },
            )),
            Err(encoded) => encoded,
        }
    }

    fn complete_runtime_request(
        &mut self,
        accepted: AcceptedRequest,
        state: RuntimeReadinessView,
    ) -> String {
        let completed_at_ms = self.clock.now_ms();
        let (request_id, sequence, _) = request_metadata(&accepted.request);
        let request_id = request_id.to_owned();
        let Some(in_flight) = self.in_flight.remove(&request_id) else {
            return encode_error(&request_id, ReasonCode::InternalFailure);
        };
        if state.state != RuntimeReadinessState::CleanupFailed
            && let Some(reason) = terminal_reason(&in_flight, completed_at_ms, true)
        {
            return encode_error(&request_id, reason);
        }
        let _acknowledged = self.session.as_mut().is_some_and(|session| {
            session.generation == accepted.generation
                && session.acknowledgement.record_success(sequence)
        });
        encode_success(&application_response(
            &request_id,
            ApplicationResult::RuntimeReadiness { state },
        ))
    }

    fn complete_foundation_request_with_availability(
        &mut self,
        accepted: AcceptedRequest,
        encoded: String,
        quit_requested: bool,
        host_available: bool,
    ) -> FoundationCompletion {
        let (encoded, _acknowledged, live) =
            self.complete_with_availability(accepted, encoded, host_available);
        FoundationCompletion {
            encoded,
            live,
            quit: quit_requested && live,
        }
    }

    fn complete_with_acknowledgement(
        &mut self,
        accepted: AcceptedRequest,
        encoded: String,
    ) -> (String, bool) {
        let (encoded, acknowledged, _live) =
            self.complete_with_availability(accepted, encoded, true);
        (encoded, acknowledged)
    }

    fn complete_with_availability(
        &mut self,
        accepted: AcceptedRequest,
        encoded: String,
        host_available: bool,
    ) -> (String, bool, bool) {
        let completed_at_ms = self.clock.now_ms();
        let (request_id, _, _) = request_metadata(&accepted.request);
        let request_id = request_id.to_owned();
        let Some(in_flight) = self.in_flight.remove(&request_id) else {
            return (
                encode_error(&request_id, ReasonCode::InternalFailure),
                false,
                false,
            );
        };
        if let Some(reason) = terminal_reason(&in_flight, completed_at_ms, host_available) {
            return (encode_error(&request_id, reason), false, false);
        }
        let (_, sequence, _) = request_metadata(&accepted.request);
        let acknowledged = self.session.as_mut().is_some_and(|session| {
            if session.generation != accepted.generation {
                return false;
            }
            session.acknowledgement.record_success(sequence)
        });
        (encoded, acknowledged, true)
    }

    fn validate_sender(&self, context: &SenderContext) -> Result<(), (String, ReasonCode)> {
        if !self.accepting {
            return Err(("unknown-request".to_owned(), ReasonCode::ShuttingDown));
        }
        if context.window_label != "main" {
            return Err((
                "unknown-request".to_owned(),
                ReasonCode::UnauthenticatedSender,
            ));
        }
        if !is_bundled_origin(&context.origin) {
            return Err((
                "unknown-request".to_owned(),
                ReasonCode::UnauthenticatedOrigin,
            ));
        }
        if self.session.as_ref().is_none_or(|session| {
            session.generation != context.generation
                || session.document_nonce != context.document_nonce
        }) {
            return Err(("unknown-request".to_owned(), ReasonCode::Unauthorized));
        }
        Ok(())
    }

    fn cancel_generation(&mut self) -> Vec<HostCancellationRecord> {
        let generation = self.session.as_ref().map(|session| session.generation);
        let now_ms = self.clock.now_ms();
        let accepted_at = self.clock.now();
        self.in_flight
            .iter_mut()
            .filter(|(_, request)| Some(request.generation) == generation)
            .filter_map(|(request_id, request)| {
                let accepted =
                    request.cancel(now_ms, accepted_at, CancellationSource::RendererLost);
                request.runtime_owned.then(|| HostCancellationRecord {
                    accepted,
                    request_id: request_id.clone(),
                })
            })
            .collect()
    }

    #[cfg(test)]
    fn set_test_now_ms(&mut self, now_ms: u64) {
        self.clock.set_test_now_ms(now_ms);
    }

    #[cfg(test)]
    fn complete_unavailable(&mut self, accepted: AcceptedRequest) -> String {
        let encoded = dispatch_health(accepted.request.clone(), current_build_identity())
            .map(|response| encode_success(&response))
            .unwrap_or_else(|| encode_error("unknown-request", ReasonCode::UnknownOperation));
        self.complete_with_availability(accepted, encoded, false).0
    }
}

pub fn activate_renderer_document<F>(lifecycle: &mut HostLifecycle, nonce_producer: F) -> bool
where
    F: FnOnce(&HostLifecycle) -> Option<String>,
{
    activate_renderer_document_with_cancellations(lifecycle, nonce_producer).0
}

fn activate_renderer_document_with_cancellations<F>(
    lifecycle: &mut HostLifecycle,
    nonce_producer: F,
) -> (bool, Vec<HostCancellationRecord>)
where
    F: FnOnce(&HostLifecycle) -> Option<String>,
{
    let cancellations = lifecycle.retire_renderer_authority();
    let started = nonce_producer(lifecycle)
        .and_then(|nonce| lifecycle.begin_renderer_session(nonce))
        .is_some();
    (started, cancellations)
}

fn valid_document_nonce(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn is_bundled_origin(origin: &str) -> bool {
    matches!(origin, "tauri://localhost" | "http://tauri.localhost")
}

#[cfg(feature = "tauri-host")]
pub fn canonical_origin(url: Option<&tauri::Url>) -> String {
    let exact_authority = url.is_some_and(|url| {
        url.username().is_empty() && url.password().is_none() && url.port().is_none()
    });
    match url.map(|url| (url.scheme(), url.host_str(), exact_authority)) {
        Some(("tauri", Some("localhost"), true)) => "tauri://localhost".to_owned(),
        Some(("http", Some("tauri.localhost"), true)) => "http://tauri.localhost".to_owned(),
        _ => String::new(),
    }
}

#[cfg(feature = "tauri-host")]
pub fn is_bundled_navigation(url: &tauri::Url) -> bool {
    is_bundled_origin(&canonical_origin(Some(url)))
        && matches!(url.path(), "" | "/" | "/index.html")
        && url.query().is_none()
        && url.fragment().is_none()
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod timing_tests;

#[cfg(all(test, feature = "tauri-host"))]
mod adapter_tests;
