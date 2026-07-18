use std::sync::Mutex;

use keiko_application::current_build_identity;
use keiko_ui_port::{ReasonCode, dispatch_health, encode_error, encode_success};

use crate::{ExecutionObservation, HostLifecycle};

pub struct ApplicationRequestOutput {
    pub acknowledged: bool,
    pub encoded: String,
}

pub fn application_request(
    lifecycle: &Mutex<HostLifecycle>,
    window_label: &str,
    origin: &str,
    generation: u64,
    document_nonce: &str,
    request: &str,
) -> ApplicationRequestOutput {
    let accepted = {
        let mut lifecycle = match lifecycle.lock() {
            Ok(lifecycle) => lifecycle,
            Err(_) => return failed_output(ReasonCode::InternalFailure),
        };
        let sender =
            lifecycle.sender_for_document(window_label, origin, generation, document_nonce);
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

pub fn application_cancel(
    lifecycle: &Mutex<HostLifecycle>,
    window_label: &str,
    origin: &str,
    generation: u64,
    document_nonce: &str,
    request: &str,
) -> String {
    lifecycle.lock().map_or_else(
        |_| encode_error("unknown-request", ReasonCode::InternalFailure),
        |mut lifecycle| {
            let sender =
                lifecycle.sender_for_document(window_label, origin, generation, document_nonce);
            lifecycle.cancel_application_request(&sender, request.as_bytes())
        },
    )
}

fn failed_output(reason: ReasonCode) -> ApplicationRequestOutput {
    ApplicationRequestOutput {
        acknowledged: false,
        encoded: encode_error("unknown-request", reason),
    }
}
