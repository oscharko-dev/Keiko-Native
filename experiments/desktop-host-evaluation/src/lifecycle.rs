use std::io;
use std::process::Command;
use std::time::Duration;

use command_group::{CommandGroup, GroupChild};
use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessesToUpdate, System};
use wait_timeout::ChildExt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Termination {
    Exited,
    Stopped,
    TimedOut,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupervisionBackend {
    UnixProcessGroup,
    WindowsJobObject,
}

pub const fn supervision_backend() -> SupervisionBackend {
    #[cfg(windows)]
    {
        SupervisionBackend::WindowsJobObject
    }
    #[cfg(unix)]
    {
        SupervisionBackend::UnixProcessGroup
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ProcessResource {
    pub process_index: usize,
    pub rss_bytes: u64,
    pub cpu_percent: f32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ProcessTreeResources {
    pub process_count: usize,
    pub tracked_process_count: usize,
    pub unobserved_tracked_process_count: usize,
    pub shared_service_processes_included: bool,
    pub total_rss_bytes: u64,
    pub total_cpu_percent: f32,
    pub processes: Vec<ProcessResource>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourcePhase {
    Idle,
    Peak,
    PostRecovery,
    PostClose,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ResourceObservation {
    pub phase: ResourcePhase,
    pub sampling_interval_ms: u64,
    pub resources: ProcessTreeResources,
}

pub struct ProcessSupervisor {
    child: GroupChild,
    root_pid: u32,
    tracked_pids: Vec<u32>,
    group_reaped: bool,
}

impl ProcessSupervisor {
    pub fn spawn(mut command: Command) -> io::Result<Self> {
        let child = command.group_spawn()?;
        let root_pid = child.id();
        let mut supervisor = Self {
            child,
            root_pid,
            tracked_pids: vec![root_pid],
            group_reaped: false,
        };
        supervisor.refresh_tracked();
        Ok(supervisor)
    }

    pub fn root_pid(&self) -> u32 {
        self.root_pid
    }

    pub fn stop(&mut self, deadline: Duration) -> io::Result<Termination> {
        self.refresh_tracked();
        if self.child.inner().try_wait()?.is_some() {
            self.terminate_group()?;
            self.ensure_no_tracked_processes()?;
            return Ok(Termination::Exited);
        }
        self.kill_and_wait()?;
        self.wait_for_cleanup(deadline)?;
        Ok(Termination::Stopped)
    }

    pub fn wait_or_terminate(&mut self, deadline: Duration) -> io::Result<Termination> {
        if let Some(remaining) = self.wait_for_root(deadline)? {
            if !self.wait_for_natural_cleanup(remaining) {
                self.kill_and_wait()?;
                self.wait_for_cleanup(deadline)?;
                return Ok(Termination::TimedOut);
            }
            self.terminate_group()?;
            self.wait_for_cleanup(deadline)?;
            return Ok(Termination::Exited);
        }
        self.refresh_tracked();
        self.kill_and_wait()?;
        self.wait_for_cleanup(deadline)?;
        Ok(Termination::TimedOut)
    }

    pub fn sample_resources_after_settle(
        &mut self,
        settle: Duration,
        interval: Duration,
    ) -> ProcessTreeResources {
        std::thread::sleep(settle);
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::All, true);
        std::thread::sleep(interval);
        system.refresh_processes(ProcessesToUpdate::All, true);
        let pids = process_tree_pids(&system, self.root_pid);
        self.tracked_pids.extend(pids.iter().copied());
        self.tracked_pids.sort_unstable();
        self.tracked_pids.dedup();
        resources_for(&system, &pids, self.tracked_pids.len())
    }

    pub fn process_tree_remains(&self) -> bool {
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::All, true);
        self.tracked_pids
            .iter()
            .any(|pid| system.process(Pid::from_u32(*pid)).is_some())
            || platform_process_group_exists(self.root_pid)
    }

    fn wait_for_root(&mut self, deadline: Duration) -> io::Result<Option<Duration>> {
        let started = std::time::Instant::now();
        while started.elapsed() < deadline {
            self.refresh_tracked();
            let slice = Duration::from_millis(20).min(deadline.saturating_sub(started.elapsed()));
            if self.child.inner().wait_timeout(slice)?.is_some() {
                self.refresh_tracked();
                return Ok(Some(deadline.saturating_sub(started.elapsed())));
            }
        }
        Ok(None)
    }

    fn wait_for_natural_cleanup(&mut self, deadline: Duration) -> bool {
        let started = std::time::Instant::now();
        loop {
            self.refresh_tracked();
            if !self.process_tree_remains() {
                return true;
            }
            if started.elapsed() >= deadline {
                return false;
            }
            std::thread::yield_now();
        }
    }

    fn terminate_group(&mut self) -> io::Result<()> {
        if self.group_reaped {
            return Ok(());
        }
        if let Err(error) = self.child.kill()
            && self.child.inner().try_wait()?.is_none()
        {
            return Err(error);
        }
        self.child.wait()?;
        self.group_reaped = true;
        Ok(())
    }

    fn kill_and_wait(&mut self) -> io::Result<()> {
        self.child.kill()?;
        self.child.wait()?;
        self.group_reaped = true;
        Ok(())
    }

    fn wait_for_cleanup(&mut self, deadline: Duration) -> io::Result<()> {
        let started = std::time::Instant::now();
        loop {
            self.refresh_tracked();
            if self.ensure_no_tracked_processes().is_ok() {
                return Ok(());
            }
            if started.elapsed() >= deadline {
                return self.ensure_no_tracked_processes();
            }
            std::thread::yield_now();
        }
    }

    fn refresh_tracked(&mut self) {
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::All, true);
        self.tracked_pids
            .extend(process_tree_pids(&system, self.root_pid));
        self.tracked_pids.sort_unstable();
        self.tracked_pids.dedup();
    }

    fn ensure_no_tracked_processes(&self) -> io::Result<()> {
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::All, true);
        let orphaned = self
            .tracked_pids
            .iter()
            .any(|pid| system.process(Pid::from_u32(*pid)).is_some());
        if orphaned || platform_process_group_exists(self.root_pid) {
            return Err(io::Error::other("supervised process tree still exists"));
        }
        Ok(())
    }
}

impl Drop for ProcessSupervisor {
    fn drop(&mut self) {
        self.refresh_tracked();
        let _ = self.terminate_group();
    }
}

fn process_tree_pids(system: &System, root_pid: u32) -> Vec<u32> {
    let root = Pid::from_u32(root_pid);
    let mut pids: Vec<_> = system
        .processes()
        .keys()
        .filter(|pid| **pid == root || is_descendant(system, **pid, root))
        .map(|pid| pid.as_u32())
        .collect();
    pids.sort_unstable_by_key(|pid| (*pid != root_pid, *pid));
    pids
}

fn is_descendant(system: &System, mut pid: Pid, root: Pid) -> bool {
    for _ in 0..64 {
        let Some(parent) = system.process(pid).and_then(|process| process.parent()) else {
            return false;
        };
        if parent == root {
            return true;
        }
        pid = parent;
    }
    false
}

fn resources_for(system: &System, pids: &[u32], tracked_count: usize) -> ProcessTreeResources {
    let processes: Vec<_> = pids
        .iter()
        .filter_map(|pid| system.process(Pid::from_u32(*pid)))
        .enumerate()
        .map(|(process_index, process)| ProcessResource {
            process_index,
            rss_bytes: process.memory(),
            cpu_percent: process.cpu_usage(),
        })
        .collect();
    ProcessTreeResources {
        process_count: processes.len(),
        tracked_process_count: tracked_count,
        unobserved_tracked_process_count: tracked_count.saturating_sub(processes.len()),
        shared_service_processes_included: false,
        total_rss_bytes: processes.iter().map(|process| process.rss_bytes).sum(),
        total_cpu_percent: processes.iter().map(|process| process.cpu_percent).sum(),
        processes,
    }
}

#[cfg(unix)]
fn platform_process_group_exists(root_pid: u32) -> bool {
    let Ok(output) = Command::new("/bin/ps").args(["-axo", "pgid="]).output() else {
        return true;
    };
    let expected = root_pid.to_string();
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| line.trim() == expected)
}

#[cfg(windows)]
fn platform_process_group_exists(root_pid: u32) -> bool {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    system.process(Pid::from_u32(root_pid)).is_some()
}
