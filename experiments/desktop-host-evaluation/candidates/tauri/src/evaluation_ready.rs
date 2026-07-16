use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const MAX_REQUEST_BYTES: usize = 4_096;
const READY_MARKER: &[u8] = b"keiko-stable-rendered-shell-v1\n";
const TRUSTED_WINDOW: &str = "main";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReadyRequest {
    window: String,
    path: PathBuf,
}

pub fn write_for_window(window: &str) -> Result<(), String> {
    let configured = std::env::var_os("KEIKO_EVAL_READY_FILE")
        .map(PathBuf::from)
        .ok_or_else(|| "evaluation ready path is unavailable".to_string())?;
    let payload = serde_json::to_vec(&ReadyRequest {
        window: window.into(),
        path: configured.clone(),
    })
    .map_err(|_| "evaluation ready request is invalid".to_string())?;
    let path = authorize_request(&payload, &configured)?;
    write_atomically(&path).map_err(|_| "evaluation ready marker could not be written".into())
}

fn authorize_request(payload: &[u8], configured: &PathBuf) -> Result<PathBuf, String> {
    if payload.len() > MAX_REQUEST_BYTES {
        return Err("evaluation ready request is oversized".into());
    }
    let request: ReadyRequest = serde_json::from_slice(payload)
        .map_err(|_| "evaluation ready request is malformed".to_string())?;
    if request.window != TRUSTED_WINDOW || request.path != *configured || request.path.exists() {
        return Err("evaluation ready request is not authorized".into());
    }
    Ok(request.path)
}

fn write_atomically(path: &PathBuf) -> std::io::Result<()> {
    let temporary = path.with_extension(format!("keiko-ready-{}", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(READY_MARKER)?;
    file.sync_all()?;
    let published = std::fs::hard_link(&temporary, path);
    let removed = std::fs::remove_file(temporary);
    published?;
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_request_requires_trusted_window_and_exact_fresh_path() {
        let path = std::env::temp_dir().join("keiko-tauri-ready-contract");
        let trusted = serde_json::to_vec(&ReadyRequest {
            window: TRUSTED_WINDOW.into(),
            path: path.clone(),
        })
        .unwrap();
        assert_eq!(authorize_request(&trusted, &path).unwrap(), path);

        let untrusted = trusted
            .windows(TRUSTED_WINDOW.len())
            .position(|value| value == TRUSTED_WINDOW.as_bytes())
            .map(|index| {
                let mut payload = trusted.clone();
                payload[index..index + TRUSTED_WINDOW.len()].fill(b'x');
                payload
            })
            .unwrap();
        assert!(authorize_request(&untrusted, &path).is_err());
    }
}
