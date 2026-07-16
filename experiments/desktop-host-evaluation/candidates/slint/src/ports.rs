use std::io;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use keiko_eval::lifecycle::ProcessSupervisor;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FolderSelection {
    Cancelled,
    Selected,
}

pub trait FolderPicker {
    fn pick_folder(&mut self) -> FolderSelection;
}

pub trait FixtureProcess {
    fn start(&mut self) -> io::Result<()>;
    fn stop(&mut self) -> io::Result<()>;
    fn cleanup(&mut self);
}

#[derive(Default)]
pub struct NativeFolderPicker;

impl FolderPicker for NativeFolderPicker {
    fn pick_folder(&mut self) -> FolderSelection {
        match rfd::FileDialog::new()
            .set_title("Choose evaluation workspace")
            .pick_folder()
        {
            Some(_) => FolderSelection::Selected,
            None => FolderSelection::Cancelled,
        }
    }
}

#[derive(Default)]
pub struct NativeFixtureProcess {
    supervisor: Option<ProcessSupervisor>,
}

impl NativeFixtureProcess {
    fn fixture_path() -> io::Result<PathBuf> {
        let executable = std::env::current_exe()?;
        let name = if cfg!(windows) {
            "keiko-fixture-child.exe"
        } else {
            "keiko-fixture-child"
        };
        Ok(executable.with_file_name(name))
    }
}

impl FixtureProcess for NativeFixtureProcess {
    fn start(&mut self) -> io::Result<()> {
        if self.supervisor.is_some() {
            return Ok(());
        }
        let path = Self::fixture_path()?;
        if !path.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "packaged fixture child is unavailable",
            ));
        }
        self.supervisor = Some(ProcessSupervisor::spawn(Command::new(path))?);
        Ok(())
    }

    fn stop(&mut self) -> io::Result<()> {
        let Some(mut supervisor) = self.supervisor.take() else {
            return Ok(());
        };
        supervisor.stop(Duration::from_secs(5)).map(|_| ())
    }

    fn cleanup(&mut self) {
        let _ = self.stop();
    }
}

impl Drop for NativeFixtureProcess {
    fn drop(&mut self) {
        self.cleanup();
    }
}
