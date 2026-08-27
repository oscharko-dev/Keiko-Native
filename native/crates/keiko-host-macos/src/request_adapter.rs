use std::sync::Mutex;

use keiko_application::current_build_identity;
use keiko_ui_port::{ReasonCode, dispatch_health, encode_error, encode_success};

use crate::HostLifecycle;
use crate::request_timing::AcceptedCancellation;

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

pub struct ApplicationCancelOutput {
    pub(crate) accepted: Option<AcceptedCancellation>,
    pub cancelled_request_id: Option<String>,
    pub encoded: String,
    pub(crate) host_control_failed: bool,
    pub(crate) runtime_owned: bool,
}

pub fn application_cancel(
    lifecycle: &Mutex<HostLifecycle>,
    window_label: &str,
    origin: &str,
    generation: u64,
    document_nonce: &str,
    request: &str,
) -> ApplicationCancelOutput {
    let (outcome, host_control_failed) = match lifecycle.lock() {
        Err(_) => (
            crate::HostCancelOutcome {
                accepted: None,
                encoded: encode_error("unknown-request", ReasonCode::InternalFailure),
                request_id: None,
                runtime_owned: false,
            },
            true,
        ),
        Ok(mut lifecycle) => {
            let sender =
                lifecycle.sender_for_document(window_label, origin, generation, document_nonce);
            (
                lifecycle.cancel_application_request_with_acceptance(&sender, request.as_bytes()),
                false,
            )
        }
    };
    ApplicationCancelOutput {
        accepted: outcome.accepted,
        cancelled_request_id: outcome.request_id,
        encoded: outcome.encoded,
        host_control_failed,
        runtime_owned: outcome.runtime_owned,
    }
}

fn failed_output(reason: ReasonCode) -> ApplicationRequestOutput {
    ApplicationRequestOutput {
        acknowledged: false,
        encoded: encode_error("unknown-request", reason),
    }
}
