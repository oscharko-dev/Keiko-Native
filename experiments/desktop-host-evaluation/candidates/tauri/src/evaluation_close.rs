use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tauri::WebviewWindow;

const CLOSE_MARKER: &[u8] = b"keiko-close-request-v1\n";
const MAX_PATH_BYTES: usize = 4_096;
const POLL_INTERVAL: Duration = Duration::from_millis(10);

pub struct CloseWatcher {
    signal: Arc<StopSignal>,
    thread: Option<JoinHandle<()>>,
}

struct StopSignal {
    stopped: Mutex<bool>,
    wake: Condvar,
}

enum RequestState {
    Pending,
    Authorized,
    Rejected,
}

impl CloseWatcher {
    pub fn start(window: WebviewWindow) -> io::Result<Option<Self>> {
        let Some(configured) = std::env::var_os("KEIKO_EVAL_CLOSE_FILE") else {
            return Ok(None);
        };
        let path = authorize_fresh_path(PathBuf::from(configured))?;
        let signal = Arc::new(StopSignal {
            stopped: Mutex::new(false),
            wake: Condvar::new(),
        });
        let thread_signal = Arc::clone(&signal);
        let thread = thread::Builder::new()
            .name("keiko-eval-close".into())
            .spawn(move || watch(path, window, thread_signal))?;
        Ok(Some(Self {
            signal,
            thread: Some(thread),
        }))
    }

    pub fn stop(&self) {
        if let Ok(mut stopped) = self.signal.stopped.lock() {
            *stopped = true;
            self.signal.wake.notify_all();
        }
    }
}

impl Drop for CloseWatcher {
    fn drop(&mut self) {
        self.stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn authorize_fresh_path(path: PathBuf) -> io::Result<PathBuf> {
    if !path.is_absolute() || path.as_os_str().len() > MAX_PATH_BYTES {
        return Err(invalid_request());
    }
    let parent = path.parent().ok_or_else(invalid_request)?;
    let parent_metadata = std::fs::symlink_metadata(parent)?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err(invalid_request());
    }
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(path),
        _ => Err(invalid_request()),
    }
}

fn watch(path: PathBuf, window: WebviewWindow, signal: Arc<StopSignal>) {
    loop {
        if is_stopped_or_wait(&signal) {
            return;
        }
        match read_request(&path) {
            RequestState::Pending => {}
            RequestState::Rejected => return,
            RequestState::Authorized => {
                let close_window = window.clone();
                let _ = window.run_on_main_thread(move || {
                    let _ = close_window.close();
                });
                return;
            }
        }
    }
}

fn is_stopped_or_wait(signal: &StopSignal) -> bool {
    let Ok(stopped) = signal.stopped.lock() else {
        return true;
    };
    if *stopped {
        return true;
    }
    match signal.wake.wait_timeout(stopped, POLL_INTERVAL) {
        Ok((stopped, _)) => *stopped,
        Err(_) => true,
    }
}

fn read_request(path: &Path) -> RequestState {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return RequestState::Pending,
        Err(_) => return RequestState::Rejected,
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() != CLOSE_MARKER.len() as u64
    {
        return RequestState::Rejected;
    }
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return RequestState::Rejected,
    };
    let opened_metadata = match file.metadata() {
        Ok(opened) if same_file(&metadata, &opened) => opened,
        _ => return RequestState::Rejected,
    };
    let mut bytes = Vec::with_capacity(CLOSE_MARKER.len() + 1);
    if file
        .by_ref()
        .take(CLOSE_MARKER.len() as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return RequestState::Rejected;
    }
    let unchanged = std::fs::symlink_metadata(path)
        .map(|current| {
            !current.file_type().is_symlink()
                && current.is_file()
                && current.len() == opened_metadata.len()
                && same_file(&opened_metadata, &current)
        })
        .unwrap_or(false);
    if unchanged && bytes == CLOSE_MARKER {
        RequestState::Authorized
    } else {
        RequestState::Rejected
    }
}

#[cfg(unix)]
fn same_file(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(windows)]
fn same_file(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    left.volume_serial_number().is_some()
        && left.volume_serial_number() == right.volume_serial_number()
        && left.file_index().is_some()
        && left.file_index() == right.file_index()
}

#[cfg(not(any(unix, windows)))]
fn same_file(_: &std::fs::Metadata, _: &std::fs::Metadata) -> bool {
    false
}

fn invalid_request() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid evaluation close request",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn request_requires_an_exact_fresh_regular_file() {
        let directory =
            std::env::temp_dir().join(format!("keiko-tauri-close-contract-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("request");
        assert_eq!(authorize_fresh_path(path.clone()).unwrap(), path);
        assert!(matches!(read_request(&path), RequestState::Pending));

        let mut file = File::create(&path).unwrap();
        file.write_all(CLOSE_MARKER).unwrap();
        file.sync_all().unwrap();
        assert!(matches!(read_request(&path), RequestState::Authorized));

        std::fs::write(&path, b"keiko-close-request-v0\n").unwrap();
        assert!(matches!(read_request(&path), RequestState::Rejected));
        assert!(authorize_fresh_path(path.clone()).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn request_rejects_a_symlink() {
        use std::os::unix::fs::symlink;

        let directory =
            std::env::temp_dir().join(format!("keiko-tauri-close-symlink-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir(&directory).unwrap();
        let target = directory.join("target");
        let request = directory.join("request");
        std::fs::write(&target, CLOSE_MARKER).unwrap();
        symlink(&target, &request).unwrap();
        assert!(matches!(read_request(&request), RequestState::Rejected));
        assert!(authorize_fresh_path(request).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
