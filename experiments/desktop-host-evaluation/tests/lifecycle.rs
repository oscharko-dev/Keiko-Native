use std::process::Command;
use std::time::Duration;

use keiko_eval::lifecycle::{ProcessSupervisor, Termination};

#[test]
fn fixture_tree_can_stop_and_timeout_without_orphans() {
    let fixture = env!("CARGO_BIN_EXE_keiko-fixture-child");
    let mut supervisor = ProcessSupervisor::spawn(Command::new(fixture)).unwrap();
    let resources = (0..10)
        .map(|_| {
            supervisor
                .sample_resources_after_settle(Duration::from_millis(1), Duration::from_millis(20))
        })
        .find(|sample| sample.process_count >= 2)
        .expect("fixture must contain a descendant");
    assert_eq!(resources.process_count, resources.processes.len());
    assert!(resources.tracked_process_count >= resources.process_count);
    assert!(!resources.shared_service_processes_included);
    assert_eq!(
        supervisor.stop(Duration::from_secs(2)).unwrap(),
        Termination::Stopped
    );
    assert!(!supervisor.process_tree_remains());

    let mut timed = ProcessSupervisor::spawn(Command::new(fixture)).unwrap();
    assert_eq!(
        timed.wait_or_terminate(Duration::from_millis(20)).unwrap(),
        Termination::TimedOut
    );
    assert!(!timed.process_tree_remains());

    let mut exiting_command = Command::new(fixture);
    exiting_command.arg("--exit-root");
    let mut exiting = ProcessSupervisor::spawn(exiting_command).unwrap();
    assert_eq!(
        exiting
            .wait_or_terminate(Duration::from_millis(100))
            .unwrap(),
        Termination::TimedOut
    );
    assert!(!exiting.process_tree_remains());
}
