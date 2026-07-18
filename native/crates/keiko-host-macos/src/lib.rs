use std::collections::{HashMap, VecDeque};

use keiko_application::current_build_identity;
use keiko_ui_port::{
    ReasonCode, UiRequest, cancel_request_id, dispatch_health, encode_cancelled, encode_error,
    encode_success, parse_cancel, parse_request, request_metadata,
};

const REPLAY_WINDOW: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SenderContext {
    pub window_label: String,
    pub origin: String,
    pub generation: u64,
}

#[derive(Debug)]
struct RendererSession {
    generation: u64,
    last_sequence: u64,
    replayed_ids: VecDeque<String>,
}

#[derive(Debug)]
struct InFlight {
    cancelled: bool,
    generation: u64,
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

#[derive(Clone, Copy)]
struct ExecutionObservation {
    cancelled_at_ms: Option<u16>,
    completed_at_ms: Option<u16>,
    host_available: bool,
}

impl ExecutionObservation {
    const HEALTHY: Self = Self {
        cancelled_at_ms: None,
        completed_at_ms: Some(0),
        host_available: true,
    };
}

#[derive(Debug)]
pub struct HostLifecycle {
    accepting: bool,
    generation: u64,
    in_flight: HashMap<String, InFlight>,
    session: Option<RendererSession>,
}

impl Default for HostLifecycle {
    fn default() -> Self {
        Self {
            accepting: true,
            generation: 0,
            in_flight: HashMap::new(),
            session: None,
        }
    }
}

impl HostLifecycle {
    pub fn begin_renderer_session(&mut self) -> u64 {
        self.cancel_generation();
        self.generation = self.generation.saturating_add(1);
        self.session = Some(RendererSession {
            generation: self.generation,
            last_sequence: 0,
            replayed_ids: VecDeque::with_capacity(REPLAY_WINDOW),
        });
        self.generation
    }

    pub fn renderer_lost(&mut self) {
        self.cancel_generation();
        self.session = None;
    }

    pub fn shutdown(&mut self) {
        self.accepting = false;
        for request in self.in_flight.values_mut() {
            request.cancelled = true;
        }
        self.session = None;
    }

    pub fn sender_for_generation(
        &self,
        window_label: &str,
        origin: &str,
        generation: u64,
    ) -> SenderContext {
        SenderContext {
            window_label: window_label.to_owned(),
            origin: origin.to_owned(),
            generation,
        }
    }

    pub fn current_generation(&self) -> Option<u64> {
        self.session.as_ref().map(|session| session.generation)
    }

    pub fn begin_application_request(
        &mut self,
        context: &SenderContext,
        bytes: &[u8],
    ) -> Result<AcceptedRequest, (String, ReasonCode)> {
        self.validate_sender(context)?;
        let request =
            parse_request(bytes).map_err(|reason| ("unknown-request".to_owned(), reason))?;
        let (request_id, sequence, _) = request_metadata(&request);
        let request_id = request_id.to_owned();
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
                cancelled: false,
                generation: context.generation,
            },
        );
        Ok(AcceptedRequest {
            generation: context.generation,
            request,
        })
    }

    pub fn complete_application_request(&mut self, accepted: AcceptedRequest) -> String {
        self.complete_observed(accepted, ExecutionObservation::HEALTHY)
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
        let Some(in_flight) = self.in_flight.get_mut(request_id) else {
            return encode_error(request_id, ReasonCode::Unauthorized);
        };
        if in_flight.generation != context.generation {
            return encode_error(request_id, ReasonCode::Unauthorized);
        }
        in_flight.cancelled = true;
        encode_cancelled(request_id)
    }

    fn complete_observed(
        &mut self,
        accepted: AcceptedRequest,
        observation: ExecutionObservation,
    ) -> String {
        let encoded = encode_success(&dispatch_health(
            accepted.request.clone(),
            current_build_identity(),
        ));
        self.complete_with_encoded(accepted, observation, encoded)
    }

    fn complete_with_encoded(
        &mut self,
        accepted: AcceptedRequest,
        observation: ExecutionObservation,
        encoded: String,
    ) -> String {
        let (request_id, _, timeout_ms) = request_metadata(&accepted.request);
        let request_id = request_id.to_owned();
        let Some(in_flight) = self.in_flight.remove(&request_id) else {
            return encode_error(&request_id, ReasonCode::InternalFailure);
        };
        let cancelled = in_flight.cancelled || in_flight.generation != accepted.generation;
        if let Some(reason) = terminal_reason(observation, timeout_ms, cancelled) {
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
        if self.session.as_ref().map(|session| session.generation) != Some(context.generation) {
            return Err(("unknown-request".to_owned(), ReasonCode::Unauthorized));
        }
        Ok(())
    }

    fn cancel_generation(&mut self) {
        let generation = self.session.as_ref().map(|session| session.generation);
        for request in self.in_flight.values_mut() {
            if Some(request.generation) == generation {
                request.cancelled = true;
            }
        }
    }
}

fn terminal_reason(
    observation: ExecutionObservation,
    timeout_ms: u16,
    cancelled: bool,
) -> Option<ReasonCode> {
    if !observation.host_available {
        return Some(ReasonCode::HostUnavailable);
    }
    if observation
        .cancelled_at_ms
        .is_some_and(|at| at < timeout_ms)
        || cancelled
    {
        return Some(ReasonCode::Cancelled);
    }
    if observation
        .completed_at_ms
        .is_none_or(|at| at >= timeout_ms)
    {
        return Some(ReasonCode::TimedOut);
    }
    None
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

#[cfg(feature = "tauri-host")]
pub struct ApplicationRequestOutput {
    pub acknowledged: bool,
    pub encoded: String,
}

#[cfg(feature = "tauri-host")]
pub fn application_request(
    lifecycle: &std::sync::Mutex<HostLifecycle>,
    window_label: &str,
    origin: &str,
    generation: u64,
    request: &str,
) -> ApplicationRequestOutput {
    let accepted = {
        let mut lifecycle = match lifecycle.lock() {
            Ok(lifecycle) => lifecycle,
            Err(_) => return failed_output(ReasonCode::InternalFailure),
        };
        let sender = lifecycle.sender_for_generation(window_label, origin, generation);
        match lifecycle.begin_application_request(&sender, request.as_bytes()) {
            Ok(accepted) => accepted,
            Err((request_id, reason)) => {
                return ApplicationRequestOutput {
                    acknowledged: false,
                    encoded: encode_error(&request_id, reason),
                };
            }
        }
    };
    let acknowledged = accepted.sequence() == 2;
    let started = std::time::Instant::now();
    let encoded = encode_success(&dispatch_health(
        accepted.request.clone(),
        current_build_identity(),
    ));
    let completed_at_ms = u16::try_from(started.elapsed().as_millis()).unwrap_or(u16::MAX);
    std::thread::yield_now();
    let encoded = lifecycle.lock().map_or_else(
        |_| encode_error("unknown-request", ReasonCode::InternalFailure),
        |mut lifecycle| {
            lifecycle.complete_with_encoded(
                accepted,
                ExecutionObservation {
                    cancelled_at_ms: None,
                    completed_at_ms: Some(completed_at_ms),
                    host_available: true,
                },
                encoded,
            )
        },
    );
    ApplicationRequestOutput {
        acknowledged: acknowledged && encoded.contains("\"status\":\"healthy\""),
        encoded,
    }
}

#[cfg(feature = "tauri-host")]
pub fn application_cancel(
    lifecycle: &std::sync::Mutex<HostLifecycle>,
    window_label: &str,
    origin: &str,
    generation: u64,
    request: &str,
) -> String {
    lifecycle.lock().map_or_else(
        |_| encode_error("unknown-request", ReasonCode::InternalFailure),
        |mut lifecycle| {
            let sender = lifecycle.sender_for_generation(window_label, origin, generation);
            lifecycle.cancel_application_request(&sender, request.as_bytes())
        },
    )
}

#[cfg(feature = "tauri-host")]
fn failed_output(reason: ReasonCode) -> ApplicationRequestOutput {
    ApplicationRequestOutput {
        acknowledged: false,
        encoded: encode_error("unknown-request", reason),
    }
}

#[cfg(test)]
mod tests;

#[cfg(all(test, feature = "tauri-host"))]
mod adapter_tests;
