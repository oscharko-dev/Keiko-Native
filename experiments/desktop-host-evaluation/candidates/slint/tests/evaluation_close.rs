#![cfg(feature = "evaluation-hooks")]

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const READY_MARKER: &[u8] = b"keiko-stable-rendered-shell-v1\n";
const CLOSE_MARKER: &[u8] = b"keiko-close-request-v1\n";

struct CandidateProcess(Option<Child>);

impl Drop for CandidateProcess {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[test]
fn evaluation_binary_closes_cleanly_after_atomic_request() {
    let root = std::env::temp_dir();
    let suffix = std::process::id();
    let ready_file = root.join(format!("keiko-slint-ready-{suffix}"));
    let close_file = root.join(format!("keiko-slint-close-{suffix}"));
    let close_temporary = root.join(format!("keiko-slint-close-{suffix}.temporary"));
    for path in [&ready_file, &close_file, &close_temporary] {
        let _ = std::fs::remove_file(path);
    }

    let child = Command::new(env!("CARGO_BIN_EXE_keiko-slint-prototype"))
        .env("KEIKO_EVAL_READY_FILE", &ready_file)
        .env("KEIKO_EVAL_CLOSE_FILE", &close_file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("evaluation candidate must start");
    let mut child = CandidateProcess(Some(child));

    wait_for_marker(&mut child, &ready_file, READY_MARKER);
    write_atomically(&close_temporary, &close_file, CLOSE_MARKER);

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child
            .0
            .as_mut()
            .expect("candidate must be present")
            .try_wait()
            .expect("candidate status must be readable")
        {
            assert!(status.success(), "candidate must exit cleanly");
            child.0 = None;
            break;
        }
        assert!(Instant::now() < deadline, "candidate must exit within 5s");
        std::thread::sleep(Duration::from_millis(10));
    }

    std::fs::remove_file(ready_file).expect("ready marker must be removable");
    std::fs::remove_file(close_file).expect("close marker must be removable");
}

fn wait_for_marker(child: &mut CandidateProcess, path: &std::path::Path, expected: &[u8]) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && !path.exists() {
        assert_eq!(
            child
                .0
                .as_mut()
                .expect("candidate must be present")
                .try_wait()
                .expect("candidate status must be readable"),
            None,
            "candidate exited before reporting readiness"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        std::fs::read(path).expect("ready marker must be published"),
        expected
    );
}

fn write_atomically(temporary: &std::path::Path, target: &std::path::Path, bytes: &[u8]) {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary)
        .expect("temporary close request must be fresh");
    file.write_all(bytes)
        .expect("close marker must be writable");
    file.sync_all().expect("close marker must be durable");
    drop(file);
    std::fs::rename(temporary, target).expect("close marker must publish atomically");
}
