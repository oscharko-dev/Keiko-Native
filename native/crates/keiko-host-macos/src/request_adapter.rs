use std::sync::Mutex;

use keiko_application::current_build_identity;
use keiko_ui_port::{ReasonCode, dispatch_health, encode_error, encode_success};

use crate::HostLifecycle;

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
    let encoded = dispatch_health(accepted.request.clone(), current_build_identity())
        .map(|response| encode_success(&response))
        .unwrap_or_else(|| encode_error("unknown-request", ReasonCode::UnknownOperation));
    let (encoded, acknowledged) = lifecycle.lock().map_or_else(
        |_| {
            (
                encode_error("unknown-request", ReasonCode::InternalFailure),
                false,
            )
        },
        |mut lifecycle| lifecycle.complete_with_acknowledgement(accepted, encoded),
    );
    ApplicationRequestOutput {
        acknowledged,
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
