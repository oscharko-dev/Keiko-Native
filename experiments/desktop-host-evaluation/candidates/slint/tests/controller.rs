use std::cell::RefCell;
use std::collections::VecDeque;
use std::io;
use std::rc::Rc;

use keiko_eval::contract::Sender;
use keiko_slint_prototype::AppController;
use keiko_slint_prototype::ports::{FixtureProcess, FolderPicker, FolderSelection};

struct Picker {
    results: VecDeque<FolderSelection>,
}

impl FolderPicker for Picker {
    fn pick_folder(&mut self) -> FolderSelection {
        self.results.pop_front().expect("test picker result")
    }
}

#[derive(Default)]
struct FixtureState {
    running: bool,
    cleanup_calls: usize,
}

struct Fixture {
    state: Rc<RefCell<FixtureState>>,
}

impl FixtureProcess for Fixture {
    fn start(&mut self) -> io::Result<()> {
        self.state.borrow_mut().running = true;
        Ok(())
    }

    fn stop(&mut self) -> io::Result<()> {
        self.state.borrow_mut().running = false;
        Ok(())
    }

    fn cleanup(&mut self) {
        let mut state = self.state.borrow_mut();
        state.running = false;
        state.cleanup_calls += 1;
    }
}

fn controller(
    selections: impl IntoIterator<Item = FolderSelection>,
) -> (AppController, Rc<RefCell<FixtureState>>) {
    let fixture = Rc::new(RefCell::new(FixtureState::default()));
    let picker = Picker {
        results: selections.into_iter().collect(),
    };
    let controller = AppController::new(
        Box::new(picker),
        Box::new(Fixture {
            state: fixture.clone(),
        }),
    );
    (controller, fixture)
}

#[test]
fn cancel_and_selection_never_disclose_a_path() {
    let (mut controller, _) = controller([FolderSelection::Cancelled, FolderSelection::Selected]);
    controller.choose_folder();
    assert!(controller.state().status.contains("cancelled"));
    controller.choose_folder();
    assert_eq!(
        controller.state().status,
        "Folder selected without reading or retaining its path."
    );
}

#[test]
fn typed_fixture_port_starts_stops_and_cleans_on_drop() {
    let (mut controller, fixture) = controller([]);
    controller.start_fixture();
    assert!(controller.state().fixture_running);
    assert!(fixture.borrow().running);
    controller.stop_fixture();
    assert!(!controller.state().fixture_running);
    drop(controller);
    assert_eq!(fixture.borrow().cleanup_calls, 1);
}

#[test]
fn all_hostile_requests_are_rejected() {
    let (mut controller, _) = controller([]);
    controller.exercise_rejections();
    assert_eq!(controller.state().rejection_count, 3);
}

#[test]
fn renderer_failure_has_an_explicit_recovery_transition() {
    let (mut controller, _) = controller([]);
    controller.simulate_renderer_unavailable();
    assert!(!controller.state().renderer_available);
    assert_eq!(controller.state().renderer_status, "Unavailable");
    controller.recover_renderer();
    assert!(controller.state().renderer_available);
    assert_eq!(controller.state().renderer_status, "Available");
    assert!(controller.state().status.contains("usable"));
}

#[test]
fn actual_callback_path_rejects_untrusted_host_context_before_effect() {
    let fixture = Rc::new(RefCell::new(FixtureState::default()));
    let mut controller = AppController::with_sender(
        Box::new(Picker {
            results: VecDeque::new(),
        }),
        Box::new(Fixture {
            state: fixture.clone(),
        }),
        Sender::new("secondary", "keiko://localhost", "eval-session"),
    );

    controller.start_fixture();

    assert!(!controller.state().fixture_running);
    assert!(!fixture.borrow().running);
    assert!(controller.state().status.contains("rejected"));
}

#[test]
fn each_journey_state_remains_separately_queryable() {
    let (mut controller, _) = controller([FolderSelection::Cancelled]);
    controller.choose_folder();
    controller.exercise_rejections();
    assert_eq!(controller.state().folder_status, "Cancelled");
    assert_eq!(controller.state().fixture_status, "Stopped");
    assert_eq!(controller.state().probe_status, "3 rejected");
    assert_eq!(controller.state().renderer_status, "Available");
}
