use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha256};

use crate::benchmark::Candidate;
use crate::package::ExternalRuntime;
use crate::runner::RunnerError;
use crate::runner_evidence::PackageEvidence;
use crate::runner_support::isolated_cargo_target_dir;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SourceBinding {
    pub commit: String,
    pub lock_sha256: String,
    tauri_source_sha256: String,
    slint_source_sha256: String,
}

impl SourceBinding {
    fn candidate_source(&self, candidate: Candidate) -> &str {
        match candidate {
            Candidate::Tauri => &self.tauri_source_sha256,
            Candidate::Slint => &self.slint_source_sha256,
        }
    }
}

pub(crate) fn source_binding() -> Result<SourceBinding, RunnerError> {
    if !source_tree_clean()? {
        return Err(RunnerError::DirtySource);
    }
    Ok(SourceBinding {
        commit: source_commit()?,
        lock_sha256: digest_file(&manifest_dir().join("Cargo.lock"))?,
        tauri_source_sha256: digest_tree(&candidate_dir(Candidate::Tauri))?.0,
        slint_source_sha256: digest_tree(&candidate_dir(Candidate::Slint))?.0,
    })
}

pub(crate) fn validate_source_binding(expected: &SourceBinding) -> Result<(), RunnerError> {
    (source_binding()? == *expected)
        .then_some(())
        .ok_or(RunnerError::DirtySource)
}

pub(crate) fn prepare_packages(
    platform: &str,
    source: &SourceBinding,
) -> Result<Vec<PackageEvidence>, RunnerError> {
    let root = package_root(platform);
    if root.exists() {
        fs::remove_dir_all(&root)?;
    }
    [Candidate::Tauri, Candidate::Slint]
        .into_iter()
        .map(|candidate| prepare_package(platform, candidate, source))
        .collect()
}

fn prepare_package(
    platform: &str,
    candidate: Candidate,
    source: &SourceBinding,
) -> Result<PackageEvidence, RunnerError> {
    let package = package_dir(platform, candidate);
    fs::create_dir_all(&package)?;
    let destination = packaged_executable(platform, candidate);
    fs::copy(release_executable(candidate)?, &destination)?;
    validate_package_contents(&package, candidate)?;
    let record = package_evidence(candidate, &package, source)?;
    write_package_record(platform, &record)?;
    Ok(record)
}

pub(crate) fn existing_packages(
    platform: &str,
    source: &SourceBinding,
) -> Result<Vec<PackageEvidence>, RunnerError> {
    [Candidate::Tauri, Candidate::Slint]
        .into_iter()
        .map(|candidate| validate_existing_package(platform, candidate, source))
        .collect()
}

fn validate_existing_package(
    platform: &str,
    candidate: Candidate,
    source: &SourceBinding,
) -> Result<PackageEvidence, RunnerError> {
    let record = fs::read(record_path(platform, candidate))?;
    let record: PackageEvidence = serde_json::from_slice(&record)?;
    validate_package_contents(&package_dir(platform, candidate), candidate)?;
    let current = package_evidence(candidate, &package_dir(platform, candidate), source)?;
    if record != current {
        return Err(RunnerError::StalePackage);
    }
    Ok(record)
}

fn validate_package_contents(package: &Path, candidate: Candidate) -> Result<(), RunnerError> {
    let expected = executable_name(candidate_binary(candidate));
    let entries: Vec<_> = fs::read_dir(package)?.collect::<Result<_, _>>()?;
    let valid = entries.len() == 1
        && entries[0].file_type()?.is_file()
        && entries[0].file_name() == std::ffi::OsStr::new(&expected);
    valid
        .then_some(())
        .ok_or(RunnerError::UnexpectedPackageContent)
}

fn package_evidence(
    candidate: Candidate,
    package: &Path,
    source: &SourceBinding,
) -> Result<PackageEvidence, RunnerError> {
    let (artifact_sha256, bytes) = digest_tree(package)?;
    Ok(PackageEvidence {
        candidate,
        format: "diagnostic_executable_directory".into(),
        release_like: false,
        evaluation_hooks_present: true,
        artifact_sha256,
        source_commit: source.commit.clone(),
        dependency_lock_sha256: source.lock_sha256.clone(),
        candidate_source_sha256: source.candidate_source(candidate).into(),
        packed_bytes: None,
        unpacked_bytes: bytes,
        external_runtime: match candidate {
            Candidate::Tauri => ExternalRuntime::SystemWebView,
            Candidate::Slint => ExternalRuntime::BundledNativeRenderer,
        },
    })
}

fn write_package_record(platform: &str, record: &PackageEvidence) -> Result<(), RunnerError> {
    let path = record_path(platform, record.candidate);
    fs::create_dir_all(path.parent().ok_or(RunnerError::InvalidOutput)?)?;
    fs::write(path, serde_json::to_vec_pretty(record)?)?;
    Ok(())
}

fn source_tree_clean() -> Result<bool, RunnerError> {
    let output = Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=all"])
        .current_dir(manifest_dir())
        .output()?;
    Ok(output.status.success() && output.stdout.is_empty())
}

fn source_commit() -> Result<String, RunnerError> {
    let output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(manifest_dir())
        .output()?;
    let commit = String::from_utf8(output.stdout).map_err(|_| RunnerError::InvalidOutput)?;
    Ok(commit.trim().into())
}

fn digest_tree(root: &Path) -> Result<(String, u64), RunnerError> {
    let mut files = Vec::new();
    collect_files(root, root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hasher = Sha256::new();
    let mut bytes = 0;
    for (relative, path) in files {
        let contents = fs::read(path)?;
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(&contents);
        bytes += contents.len() as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), bytes))
}

fn collect_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<(String, PathBuf)>,
) -> io::Result<()> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            collect_files(root, &entry.path(), files)?;
        } else {
            let path = entry.path();
            let relative = path.strip_prefix(root).map_err(io::Error::other)?;
            files.push((relative.to_string_lossy().replace('\\', "/"), path));
        }
    }
    Ok(())
}

fn digest_file(path: &Path) -> Result<String, RunnerError> {
    Ok(format!("{:x}", Sha256::digest(fs::read(path)?)))
}

pub(crate) fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn release_dir() -> Result<PathBuf, RunnerError> {
    Ok(isolated_cargo_target_dir()?.join("release"))
}

fn candidate_dir(candidate: Candidate) -> PathBuf {
    manifest_dir()
        .join("candidates")
        .join(candidate_name(candidate))
}

fn package_root(platform: &str) -> PathBuf {
    manifest_dir()
        .join("target")
        .join("evaluation-packages")
        .join(platform)
}

fn package_dir(platform: &str, candidate: Candidate) -> PathBuf {
    package_root(platform).join(candidate_name(candidate))
}

fn record_path(platform: &str, candidate: Candidate) -> PathBuf {
    package_root(platform)
        .join("records")
        .join(format!("{}.json", candidate_name(candidate)))
}

pub(crate) fn packaged_executable(platform: &str, candidate: Candidate) -> PathBuf {
    package_dir(platform, candidate).join(executable_name(candidate_binary(candidate)))
}

fn release_executable(candidate: Candidate) -> Result<PathBuf, RunnerError> {
    Ok(release_dir()?.join(executable_name(candidate_binary(candidate))))
}

fn executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    }
}

pub(crate) fn candidate_name(candidate: Candidate) -> &'static str {
    match candidate {
        Candidate::Tauri => "tauri",
        Candidate::Slint => "slint",
    }
}

fn candidate_binary(candidate: Candidate) -> &'static str {
    match candidate {
        Candidate::Tauri => "keiko-tauri-prototype",
        Candidate::Slint => "keiko-slint-prototype",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> SourceBinding {
        SourceBinding {
            commit: "a".repeat(40),
            lock_sha256: "b".repeat(64),
            tauri_source_sha256: "c".repeat(64),
            slint_source_sha256: "d".repeat(64),
        }
    }

    #[test]
    fn diagnostic_directory_is_not_release_package_evidence() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("candidate"), b"binary").unwrap();
        let evidence = package_evidence(Candidate::Tauri, directory.path(), &source()).unwrap();
        assert!(!evidence.release_like);
        assert!(evidence.evaluation_hooks_present);
        assert_eq!(evidence.packed_bytes, None);
        assert_eq!(evidence.unpacked_bytes, 6);
    }

    #[test]
    fn artifact_mutation_changes_the_bound_digest() {
        let directory = tempfile::tempdir().unwrap();
        let artifact = directory.path().join("candidate");
        fs::write(&artifact, b"first").unwrap();
        let first = package_evidence(Candidate::Slint, directory.path(), &source()).unwrap();
        fs::write(artifact, b"second").unwrap();
        let second = package_evidence(Candidate::Slint, directory.path(), &source()).unwrap();
        assert_ne!(first.artifact_sha256, second.artifact_sha256);
    }

    #[test]
    fn candidate_package_copies_from_the_isolated_build_tree() {
        let source = release_executable(Candidate::Tauri).unwrap();
        assert!(source.starts_with(isolated_cargo_target_dir().unwrap()));
        assert_eq!(source.parent(), Some(release_dir().unwrap().as_path()));

        let retained = packaged_executable("windows", Candidate::Tauri);
        assert!(!retained.starts_with(isolated_cargo_target_dir().unwrap()));
        assert!(retained.starts_with(package_root("windows")));
    }

    #[test]
    fn fixture_or_helper_is_rejected_from_candidate_package() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory
                .path()
                .join(executable_name(candidate_binary(Candidate::Tauri))),
            b"candidate",
        )
        .unwrap();
        fs::write(directory.path().join("fixture"), b"fixture").unwrap();
        assert!(matches!(
            validate_package_contents(directory.path(), Candidate::Tauri),
            Err(RunnerError::UnexpectedPackageContent)
        ));
    }
}
