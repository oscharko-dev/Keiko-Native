#![cfg(feature = "evaluation-hooks")]

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const READY_MARKER: &[u8] = b"keiko-stable-rendered-shell-v1\n";

struct CandidateProcess(Child);

impl Drop for CandidateProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn evaluation_binary_reports_the_real_stable_rendered_shell() {
    let ready_file = std::env::temp_dir().join(format!("keiko-tauri-ready-{}", std::process::id()));
    let _ = std::fs::remove_file(&ready_file);

    let child = Command::new(env!("CARGO_BIN_EXE_keiko-tauri-prototype"))
        .env("KEIKO_EVAL_READY_FILE", &ready_file)
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
    std::fs::remove_file(ready_file).expect("ready marker must be removable");
}
