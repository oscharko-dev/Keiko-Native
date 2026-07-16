#![cfg(feature = "evaluation-hooks")]

use std::io::Write;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const CLOSE_MARKER: &[u8] = b"keiko-close-request-v1\n";
const READY_MARKER: &[u8] = b"keiko-stable-rendered-shell-v1\n";

struct CandidateProcess(Child);

impl Drop for CandidateProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn evaluation_binary_reports_readiness_and_closes_its_real_window() {
    let directory = std::env::temp_dir().join(format!(
        "keiko-tauri-process-contract-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir(&directory).expect("process contract directory must be created");
    let ready_file = directory.join("ready");
    let close_file = directory.join("close");
    let _ = std::fs::remove_file(&ready_file);
    let _ = std::fs::remove_file(&close_file);

    let child = Command::new(env!("CARGO_BIN_EXE_keiko-tauri-prototype"))
        .env("KEIKO_EVAL_READY_FILE", &ready_file)
        .env("KEIKO_EVAL_CLOSE_FILE", &close_file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("evaluation candidate must start");
    let mut child = CandidateProcess(child);

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && !ready_file.exists() {
        assert_eq!(
            child
                .0
                .try_wait()
                .expect("candidate status must be readable"),
            None,
            "candidate exited before reporting readiness"
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    let marker =
        std::fs::read(&ready_file).expect("stable rendered shell marker must be published");
    assert_eq!(marker, READY_MARKER);
    std::fs::remove_file(&ready_file).expect("ready marker must be removable");

    let shutdown_started = Instant::now();
    publish_close_request(&close_file);
    let status = wait_for_exit(&mut child.0, shutdown_started + Duration::from_secs(5));
    assert!(status.success(), "candidate must exit cleanly: {status}");
    std::fs::remove_file(close_file).expect("close marker must be removable");
    std::fs::remove_dir(directory).expect("process contract directory must be removable");
}

fn publish_close_request(path: &std::path::Path) {
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .expect("fresh close marker temporary file must be created");
    file.write_all(CLOSE_MARKER)
        .expect("close marker must be written");
    file.sync_all().expect("close marker must be durable");
    std::fs::rename(&temporary, path).expect("close marker must be atomically published");
}

fn wait_for_exit(child: &mut Child, deadline: Instant) -> ExitStatus {
    loop {
        if let Some(status) = child.try_wait().expect("candidate status must be readable") {
            return status;
        }
        assert!(Instant::now() < deadline, "candidate did not close in 5s");
        std::thread::sleep(Duration::from_millis(10));
    }
}
