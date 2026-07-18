use keiko_application::{ApplicationResponse, BuildIdentity, HealthRequest, health_response};
use serde::{Deserialize, Serialize};

pub const MAX_REQUEST_BYTES: usize = 4096;
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReasonCode {
    InvalidRequest,
    PayloadTooLarge,
    UnsupportedSchema,
    UnknownOperation,
    ReplayedRequest,
    StaleRequest,
    TimedOut,
    Cancelled,
    HostUnavailable,
    ShuttingDown,
    InternalFailure,
    UnauthenticatedOrigin,
    UnauthenticatedSender,
    Unauthorized,
}

impl ReasonCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid-request",
            Self::PayloadTooLarge => "payload-too-large",
            Self::UnsupportedSchema => "unsupported-schema",
            Self::UnknownOperation => "unknown-operation",
            Self::ReplayedRequest => "replayed-request",
            Self::StaleRequest => "stale-request",
            Self::TimedOut => "timed-out",
            Self::Cancelled => "cancelled",
            Self::HostUnavailable => "host-unavailable",
            Self::ShuttingDown => "shutting-down",
            Self::InternalFailure => "internal-failure",
            Self::UnauthenticatedOrigin => "unauthenticated-origin",
            Self::UnauthenticatedSender => "unauthenticated-sender",
            Self::Unauthorized => "unauthorized",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UiRequest {
    #[serde(rename = "schemaVersion")]
    schema_version: u8,
    #[serde(rename = "requestId")]
    request_id: String,
    sequence: u64,
    #[serde(rename = "timeoutMs")]
    timeout_ms: u16,
    operation: Operation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CancelRequest {
    #[serde(rename = "schemaVersion")]
    schema_version: u8,
    #[serde(rename = "requestId")]
    request_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Operation {
    #[serde(rename = "application-health")]
    ApplicationHealth,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ErrorBody {
    pub code: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ErrorResponse {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u8,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub error: ErrorBody,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CancelResult {
    pub kind: String,
    pub status: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CancelResponse {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u8,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub result: CancelResult,
}

pub fn parse_request(bytes: &[u8]) -> Result<UiRequest, ReasonCode> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(ReasonCode::PayloadTooLarge);
    }
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| ReasonCode::InvalidRequest)?;
    if value
        .get("operation")
        .and_then(|operation| operation.get("kind"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|kind| kind != "application-health")
    {
        return Err(ReasonCode::UnknownOperation);
    }
    let request: UiRequest =
        serde_json::from_slice(bytes).map_err(|_| ReasonCode::InvalidRequest)?;
    if request.schema_version != 1 {
        return Err(ReasonCode::UnsupportedSchema);
    }
    if !valid_request_id(&request.request_id)
        || request.timeout_ms == 0
        || request.timeout_ms > 1000
    {
        return Err(ReasonCode::InvalidRequest);
    }
    if request.sequence == 0 || request.sequence > MAX_SEQUENCE {
        return Err(ReasonCode::StaleRequest);
    }
    Ok(request)
}

pub fn request_metadata(request: &UiRequest) -> (&str, u64, u16) {
    (&request.request_id, request.sequence, request.timeout_ms)
}

pub fn parse_cancel(bytes: &[u8]) -> Result<CancelRequest, ReasonCode> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(ReasonCode::PayloadTooLarge);
    }
    let request: CancelRequest =
        serde_json::from_slice(bytes).map_err(|_| ReasonCode::InvalidRequest)?;
    if request.schema_version != 1 {
        return Err(ReasonCode::UnsupportedSchema);
    }
    if !valid_request_id(&request.request_id) {
        return Err(ReasonCode::InvalidRequest);
    }
    Ok(request)
}

pub fn cancel_request_id(request: &CancelRequest) -> &str {
    &request.request_id
}

pub fn dispatch_health(request: UiRequest, build: BuildIdentity) -> ApplicationResponse {
    match request.operation {
        Operation::ApplicationHealth => health_response(
            HealthRequest {
                request_id: request.request_id,
            },
            build,
        ),
    }
}

pub fn encode_success(response: &ApplicationResponse) -> String {
    serde_json::to_string(response).expect("closed response schema serializes")
}

pub fn encode_error(request_id: &str, reason: ReasonCode) -> String {
    serde_json::to_string(&ErrorResponse {
        schema_version: 1,
        request_id: request_id.to_owned(),
        error: ErrorBody {
            code: reason.as_str().to_owned(),
        },
    })
    .expect("closed error schema serializes")
}

pub fn encode_cancelled(request_id: &str) -> String {
    serde_json::to_string(&CancelResponse {
        schema_version: 1,
        request_id: request_id.to_owned(),
        result: CancelResult {
            kind: "application-cancel".to_owned(),
            status: "cancelled".to_owned(),
        },
    })
    .expect("closed cancellation response serializes")
}

fn valid_request_id(value: &str) -> bool {
    (16..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical() -> Vec<u8> {
        br#"{"schemaVersion":1,"requestId":"request-00000001","sequence":1,"timeoutMs":1000,"operation":{"kind":"application-health"}}"#.to_vec()
    }

    #[test]
    fn accepts_only_the_closed_health_operation() {
        let request = parse_request(&canonical()).expect("canonical request");
        assert_eq!(request_metadata(&request), ("request-00000001", 1, 1000));
    }

    #[test]
    fn rejects_unknown_fields_and_oversized_payloads() {
        let mut unknown = canonical();
        unknown.splice(1..1, b"\"extra\":true,".iter().copied());
        assert_eq!(parse_request(&unknown), Err(ReasonCode::InvalidRequest));
        let duplicate = br#"{"schemaVersion":1,"requestId":"request-00000001","requestId":"request-00000002","sequence":1,"timeoutMs":1000,"operation":{"kind":"application-health"}}"#;
        assert_eq!(parse_request(duplicate), Err(ReasonCode::InvalidRequest));
        assert_eq!(
            parse_request(&vec![b' '; MAX_REQUEST_BYTES + 1]),
            Err(ReasonCode::PayloadTooLarge)
        );
    }

    #[test]
    fn rejects_unsupported_schema_and_bounds() {
        let bad_schema = br#"{"schemaVersion":2,"requestId":"request-00000001","sequence":1,"timeoutMs":1000,"operation":{"kind":"application-health"}}"#;
        let stale = br#"{"schemaVersion":1,"requestId":"request-00000001","sequence":0,"timeoutMs":1000,"operation":{"kind":"application-health"}}"#;
        let bad_timeout = br#"{"schemaVersion":1,"requestId":"request-00000001","sequence":1,"timeoutMs":0,"operation":{"kind":"application-health"}}"#;
        assert_eq!(
            parse_request(bad_schema),
            Err(ReasonCode::UnsupportedSchema)
        );
        assert_eq!(parse_request(stale), Err(ReasonCode::StaleRequest));
        assert_eq!(parse_request(bad_timeout), Err(ReasonCode::InvalidRequest));
    }

    #[test]
    fn rejects_unknown_operation_malformed_and_empty_input() {
        let unknown = br#"{"schemaVersion":1,"requestId":"request-00000001","sequence":1,"timeoutMs":1000,"operation":{"kind":"generic-ping"}}"#;
        assert_eq!(parse_request(unknown), Err(ReasonCode::UnknownOperation));
        assert_eq!(parse_request(b""), Err(ReasonCode::InvalidRequest));
        assert_eq!(parse_request(b"not-json"), Err(ReasonCode::InvalidRequest));
    }

    #[test]
    fn enforces_request_identifier_sequence_and_timeout_boundaries() {
        let request = |request_id: &str, sequence: u64, timeout_ms: u16| {
            format!(
                r#"{{"schemaVersion":1,"requestId":"{request_id}","sequence":{sequence},"timeoutMs":{timeout_ms},"operation":{{"kind":"application-health"}}}}"#,
            )
        };
        assert!(parse_request(request("1234567890123456", MAX_SEQUENCE, 1).as_bytes()).is_ok());
        assert_eq!(
            parse_request(request("123456789012345", 1, 1).as_bytes()),
            Err(ReasonCode::InvalidRequest)
        );
        assert_eq!(
            parse_request(request(&"a".repeat(65), 1, 1).as_bytes()),
            Err(ReasonCode::InvalidRequest)
        );
        assert_eq!(
            parse_request(request("1234567890123456", MAX_SEQUENCE + 1, 1).as_bytes()),
            Err(ReasonCode::StaleRequest)
        );
        assert_eq!(
            parse_request(request("1234567890123456", 1, 1001).as_bytes()),
            Err(ReasonCode::InvalidRequest)
        );
    }

    #[test]
    fn accepts_only_the_closed_cancellation_transport() {
        let request = parse_cancel(br#"{"schemaVersion":1,"requestId":"request-00000001"}"#)
            .expect("closed cancellation");
        assert_eq!(cancel_request_id(&request), "request-00000001");
        assert!(encode_cancelled(cancel_request_id(&request)).contains("application-cancel"));
        assert_eq!(
            parse_cancel(br#"{"schemaVersion":1,"requestId":"request-00000001","payload":true}"#,),
            Err(ReasonCode::InvalidRequest)
        );
        assert_eq!(parse_cancel(b"{}"), Err(ReasonCode::InvalidRequest));
        assert_eq!(
            parse_cancel(br#"{"schemaVersion":1,"requestId":"short"}"#),
            Err(ReasonCode::InvalidRequest)
        );
        assert_eq!(
            parse_cancel(br#"{"schemaVersion":2,"requestId":"request-00000001"}"#,),
            Err(ReasonCode::UnsupportedSchema)
        );
        assert_eq!(
            parse_cancel(&vec![b'x'; MAX_REQUEST_BYTES + 1]),
            Err(ReasonCode::PayloadTooLarge)
        );
    }

    #[test]
    fn every_bounded_reason_has_a_stable_wire_value() {
        let values = [
            (ReasonCode::InvalidRequest, "invalid-request"),
            (ReasonCode::PayloadTooLarge, "payload-too-large"),
            (ReasonCode::UnsupportedSchema, "unsupported-schema"),
            (ReasonCode::UnknownOperation, "unknown-operation"),
            (ReasonCode::ReplayedRequest, "replayed-request"),
            (ReasonCode::StaleRequest, "stale-request"),
            (ReasonCode::TimedOut, "timed-out"),
            (ReasonCode::Cancelled, "cancelled"),
            (ReasonCode::HostUnavailable, "host-unavailable"),
            (ReasonCode::ShuttingDown, "shutting-down"),
            (ReasonCode::InternalFailure, "internal-failure"),
            (ReasonCode::UnauthenticatedOrigin, "unauthenticated-origin"),
            (ReasonCode::UnauthenticatedSender, "unauthenticated-sender"),
            (ReasonCode::Unauthorized, "unauthorized"),
        ];
        for (reason, expected) in values {
            assert_eq!(reason.as_str(), expected);
            assert!(encode_error("request-00000001", reason).contains(expected));
        }
    }
}
