import { spawn, spawnSync } from "node:child_process";

const ACKNOWLEDGEMENT = "keiko-native-health-ack/v1 sequence=2";

function boundedTail(value) {
  return value.slice(-1024);
}

function waitForAcknowledgement(child, timeoutMs, timers) {
  return new Promise((resolve, reject) => {
    let output = "";
    const cleanup = () => {
      timers.clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      output = boundedTail(`${output}${chunk}`);
      if (!output.includes(ACKNOWLEDGEMENT)) return;
      cleanup();
      resolve();
    };
    const onExit = () =>
      fail(new Error("Packaged shell exited before acknowledgement"));
    const onError = () => fail(new Error("Packaged shell failed to start"));
    const timer = timers.setTimeout(
      () => fail(new Error("Packaged health acknowledgement timed out")),
      timeoutMs,
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function waitForExit(child, timeoutMs, timers) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      timers.clearTimeout(timer);
      child.off("exit", onExit);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };
    const timer = timers.setTimeout(() => {
      cleanup();
      reject(new Error("Packaged shell did not shut down within 5000 ms"));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

export async function runPackagedLifecycle({
  clock = performance,
  executable,
  packageRoot,
  processControl,
  timers = globalThis,
}) {
  const child = processControl.spawn(executable, [], {
    cwd: packageRoot,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const startedAt = clock.now();
  let acknowledgementMs;
  let shutdownMs;
  try {
    await waitForAcknowledgement(child, 5000, timers);
    const acknowledgedAt = clock.now();
    acknowledgementMs = Math.round(acknowledgedAt - startedAt);
    const exited = waitForExit(child, 5000, timers);
    if (child.exitCode === null) {
      await Promise.race([
        Promise.resolve().then(() => processControl.terminate(child.pid, 5000)),
        exited,
      ]);
    }
    if (clock.now() - acknowledgedAt > 5000)
      throw new Error("Packaged shell quit helper exceeded shutdown deadline");
    await exited;
    shutdownMs = Math.round(clock.now() - acknowledgedAt);
  } finally {
    processControl.killGroup(child.pid);
  }
  const cleanupOwnedDescendants = processControl.descendantCount(child.pid);
  if (cleanupOwnedDescendants !== 0)
    throw new Error("Packaged shell left owned descendants after cleanup");
  return { acknowledgementMs, cleanupOwnedDescendants, shutdownMs };
}

function terminateByPid(pid, timeoutMs) {
  const script = [
    'ObjC.import("AppKit")',
    `const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid})`,
    'if (!app) throw new Error("target process is not running")',
    'if (!app.terminate) throw new Error("target process cannot terminate")',
  ].join("; ");
  const result = spawnSync("osascript", ["-l", "JavaScript", "-e", script], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.status !== 0) throw new Error("Exact-PID quit helper failed");
}

function descendantCount(processGroup) {
  const result = spawnSync("pgrep", ["-g", String(processGroup)], {
    encoding: "utf8",
  });
  if (result.status === 1) return 0;
  if (result.status !== 0) throw new Error("Process cleanup inspection failed");
  return result.stdout.trim().split("\n").filter(Boolean).length;
}

function killGroup(processGroup) {
  try {
    process.kill(-processGroup, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export const defaultProcessControl = {
  descendantCount,
  killGroup,
  spawn,
  terminate: terminateByPid,
};
