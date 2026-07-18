use std::collections::{HashMap, VecDeque};

use keiko_application::current_build_identity;
#[cfg(test)]
use keiko_ui_port::canonical_request_id;
use keiko_ui_port::{
    MAX_SEQUENCE, ReasonCode, UiRequest, cancel_request_id, dispatch_health, encode_cancelled,
    encode_error, encode_success, parse_cancel, parse_request, request_id_matches,
    request_metadata,
};

pub mod document_nonce;
#[cfg(feature = "tauri-host")]
mod request_adapter;
mod request_timing;
#[cfg(feature = "tauri-host")]
pub mod tauri_adapter;
#[cfg(feature = "tauri-host")]
pub use request_adapter::{ApplicationRequestOutput, application_cancel, application_request};
use request_timing::{InFlight, MonotonicClock, terminal_reason};

const REPLAY_WINDOW: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SenderContext {
    pub window_label: String,
    pub origin: String,
    pub generation: u64,
    pub document_nonce: String,
}

#[derive(Debug)]
struct RendererSession {
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

impl AcceptedRequest {
    pub fn sequence(&self) -> u64 {
        request_metadata(&self.request).1
    }
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
        if self.pending_page_loads > 0 {
            self.page_load_ambiguous = true;
        }
        self.pending_page_loads = self.pending_page_loads.saturating_add(1);
        activate_renderer_document(self, nonce_producer)
    }

    pub fn finish_renderer_page_load(&mut self) -> Option<(u64, String)> {
        if self.pending_page_loads == 0 {
            self.renderer_lost();
            return None;
        }
        self.pending_page_loads -= 1;
        if self.page_load_ambiguous {
            self.retire_renderer_authority();
            if self.pending_page_loads == 0 {
                self.page_load_ambiguous = false;
            }
            return None;
        }
        if self.pending_page_loads != 0 {
            self.page_load_ambiguous = true;
            self.retire_renderer_authority();
            return None;
        }
        self.current_document_authority()
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
            generation: self.generation,
            document_nonce,
            last_sequence: 0,
            replayed_ids: VecDeque::with_capacity(REPLAY_WINDOW),
        });
        Some(self.generation)
    }

    pub fn renderer_lost(&mut self) {
        self.retire_renderer_authority();
        self.page_load_ambiguous = false;
        self.pending_page_loads = 0;
    }

    fn retire_renderer_authority(&mut self) {
        self.cancel_generation();
        self.session = None;
    }

    pub fn shutdown(&mut self) {
        self.accepting = false;
        let now_ms = self.clock.now_ms();
        for request in self.in_flight.values_mut() {
            request.cancelled_at_ms.get_or_insert(now_ms);
        }
        self.page_load_ambiguous = false;
        self.pending_page_loads = 0;
        self.session = None;
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
        session.last_sequence = sequence;
        if session.replayed_ids.len() == REPLAY_WINDOW {
            session.replayed_ids.pop_front();
        }
        session.replayed_ids.push_back(request_id.clone());
        self.in_flight.insert(
            request_id,
            InFlight {
                cancelled_at_ms: None,
                generation: context.generation,
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
        let encoded = encode_success(&dispatch_health(
            accepted.request.clone(),
            current_build_identity(),
        ));
        self.complete_with_encoded(accepted, encoded)
    }

    pub fn cancel_application_request(&mut self, context: &SenderContext, bytes: &[u8]) -> String {
        if let Err((request_id, reason)) = self.validate_sender(context) {
            return encode_error(&request_id, reason);
        }
        let request = match parse_cancel(bytes) {
            Ok(request) => request,
            Err(reason) => return encode_error("unknown-request", reason),
        };
        let request_id = cancel_request_id(&request);
        let now_ms = self.clock.now_ms();
        let Some(in_flight) = self.in_flight.get_mut(request_id) else {
            return encode_error(request_id, ReasonCode::Unauthorized);
        };
        if in_flight.generation != context.generation {
            return encode_error(request_id, ReasonCode::Unauthorized);
        }
        let cancelled_at_ms = *in_flight.cancelled_at_ms.get_or_insert(now_ms);
        if cancelled_at_ms.saturating_sub(in_flight.started_at_ms)
            >= u64::from(in_flight.timeout_ms)
        {
            encode_error(request_id, ReasonCode::TimedOut)
        } else {
            encode_cancelled(request_id)
        }
    }

    fn complete_with_encoded(&mut self, accepted: AcceptedRequest, encoded: String) -> String {
        self.complete_with_availability(accepted, encoded, true)
    }

    fn complete_with_availability(
        &mut self,
        accepted: AcceptedRequest,
        encoded: String,
        host_available: bool,
    ) -> String {
        let completed_at_ms = self.clock.now_ms();
        let (request_id, _, _) = request_metadata(&accepted.request);
        let request_id = request_id.to_owned();
        let Some(in_flight) = self.in_flight.remove(&request_id) else {
            return encode_error(&request_id, ReasonCode::InternalFailure);
        };
        if let Some(reason) = terminal_reason(&in_flight, completed_at_ms, host_available) {
            return encode_error(&request_id, reason);
        }
        encoded
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

    fn cancel_generation(&mut self) {
        let generation = self.session.as_ref().map(|session| session.generation);
        let now_ms = self.clock.now_ms();
        for request in self.in_flight.values_mut() {
            if Some(request.generation) == generation {
                request.cancelled_at_ms.get_or_insert(now_ms);
            }
        }
    }

    #[cfg(test)]
    fn set_test_now_ms(&mut self, now_ms: u64) {
        self.clock.set_test_now_ms(now_ms);
    }

    #[cfg(test)]
    fn complete_unavailable(&mut self, accepted: AcceptedRequest) -> String {
        let encoded = encode_success(&dispatch_health(
            accepted.request.clone(),
            current_build_identity(),
        ));
        self.complete_with_availability(accepted, encoded, false)
    }
}

pub fn activate_renderer_document<F>(lifecycle: &mut HostLifecycle, nonce_producer: F) -> bool
where
    F: FnOnce(&HostLifecycle) -> Option<String>,
{
    lifecycle.retire_renderer_authority();
    nonce_producer(lifecycle)
        .and_then(|nonce| lifecycle.begin_renderer_session(nonce))
        .is_some()
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
