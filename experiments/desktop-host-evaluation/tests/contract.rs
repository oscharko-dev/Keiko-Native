use std::path::PathBuf;

use keiko_eval::contract::{Authority, HostBoundary, Intent, Request, Sender};

fn boundary() -> HostBoundary {
    HostBoundary::new(
        Sender::new("main", "keiko://localhost", "eval-session"),
        Authority::synthetic(PathBuf::from("synthetic-workspace")),
    )
}

#[test]
fn authorized_bounded_intent_is_accepted() {
    let request = Request::new(
        Sender::new("main", "keiko://localhost", "eval-session"),
        Intent::CancelFolderPicker,
    );
    assert!(boundary().authorize(&request).is_ok());
}

#[test]
fn wrong_sender_origin_and_auth_fail_closed() {
    for sender in [
        Sender::new("other", "keiko://localhost", "eval-session"),
        Sender::new("main", "https://remote.invalid", "eval-session"),
        Sender::new("main", "keiko://localhost", "expired"),
    ] {
        let request = Request::new(sender, Intent::CancelFolderPicker);
        assert!(boundary().authorize(&request).is_err());
    }
}

#[test]
fn malformed_oversized_unknown_and_workspace_escape_are_rejected() {
    let malformed = br#"{"version":1,"sender":[]}"#;
    assert!(boundary().parse_and_authorize(malformed).is_err());

    let oversized = vec![b'x'; 65_537];
    assert!(boundary().parse_and_authorize(&oversized).is_err());

    let escape = Request::new(
        Sender::new("main", "keiko://localhost", "eval-session"),
        Intent::InspectSyntheticPath(PathBuf::from("../private")),
    );
    assert!(boundary().authorize(&escape).is_err());
}
