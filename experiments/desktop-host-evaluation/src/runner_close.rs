use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::benchmark::ScheduledLaunch;
use crate::runner::RunnerError;
use crate::runner_package::{candidate_name, manifest_dir};

const CLOSE_REQUEST: &[u8] = b"keiko-close-request-v1\n";
static CLOSE_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn fresh_close_request_path(launch: ScheduledLaunch) -> Result<PathBuf, RunnerError> {
    let directory = manifest_dir().join("target/evaluation-close-requests");
    fs::create_dir_all(&directory)?;
    require_plain_directory(&directory)?;
    let sequence = CLOSE_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = directory.join(format!(
        "{}-{:?}-{}-{}-{}-{sequence}.request",
        candidate_name(launch.candidate),
        launch.start_class,
        launch.round,
        launch.position,
        std::process::id()
    ));
    require_absent(&path)?;
    require_absent(&close_request_temporary(&path))?;
    Ok(path)
}

pub(crate) fn publish_close_request(path: &Path) -> Result<(), RunnerError> {
    require_plain_directory(path.parent().ok_or(RunnerError::InvalidCloseRequest)?)?;
    require_absent(path)?;
    let temporary = close_request_temporary(path);
    require_absent(&temporary)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(CLOSE_REQUEST)?;
    file.sync_all()?;
    drop(file);
    match fs::hard_link(&temporary, path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Err(RunnerError::StaleCloseRequest);
        }
        Err(error) => return Err(error.into()),
    }
    fs::remove_file(&temporary)?;
    close_request_ready(path)
        .then_some(())
        .ok_or(RunnerError::InvalidCloseRequest)
}

pub(crate) fn remove_close_request(path: &Path) -> Result<(), RunnerError> {
    remove_exact_close_file(path)?;
    remove_exact_close_file(&close_request_temporary(path))
}

pub(crate) fn close_request_ready(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.file_type().is_file() && fs::read(path).is_ok_and(|bytes| bytes == CLOSE_REQUEST)
    })
}

fn remove_exact_close_file(path: &Path) -> Result<(), RunnerError> {
    match fs::symlink_metadata(path) {
        Ok(_) if !close_request_ready(path) => Err(RunnerError::InvalidCloseRequest),
        Ok(_) => fs::remove_file(path).map_err(Into::into),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn require_absent(path: &Path) -> Result<(), RunnerError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => Err(RunnerError::StaleCloseRequest),
    }
}

fn require_plain_directory(path: &Path) -> Result<(), RunnerError> {
    fs::symlink_metadata(path)?
        .file_type()
        .is_dir()
        .then_some(())
        .ok_or(RunnerError::InvalidCloseRequest)
}

fn close_request_temporary(path: &Path) -> PathBuf {
    path.with_extension("request.tmp")
}
