import { spawn, spawnSync } from "node:child_process";

const ACKNOWLEDGEMENT = "keiko-native-health-ack/v1 sequence=2";
export const FUNCTIONAL_ACKNOWLEDGEMENT_WATCHDOG_MS = 30_000;
export const SHUTDOWN_BUDGET_MS = 5_000;

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
    const onExit = (code, signal) =>
      fail(
        new Error(
          `Packaged shell exited before acknowledgement (${exitCause(code, signal)})`,
        ),
      );
    const onError = (error) =>
      fail(
        new Error(
          `Packaged shell failed to start (spawn:${error?.code ?? "unknown"})`,
        ),
      );
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
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      timers.clearTimeout(timer);
      child.off("exit", onExit);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const timer = timers.setTimeout(() => {
      cleanup();
      reject(new Error("Packaged shell did not shut down within 5000 ms"));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function exitCause(code, signal) {
  return signal === null || signal === undefined
    ? `status:${code ?? "unknown"}`
    : `signal:${signal}`;
}

function forceCleanup(processControl, pid) {
  let remaining = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    processControl.killGroup(pid);
    remaining = processControl.descendantCount(pid);
    if (remaining === 0) return 0;
  }
  return remaining;
}

function lifecycleFailureClass(error) {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Packaged health acknowledgement timed out"))
    return "acknowledgement-timeout";
  if (message.startsWith("Packaged shell exited before acknowledgement"))
    return "pre-acknowledgement-exit";
  if (message.startsWith("Packaged shell failed to start"))
    return "launch-failed";
  if (message.startsWith("Packaged shell did not shut down"))
    return "shutdown-timeout";
  if (message.startsWith("Packaged shell quit helper exceeded"))
    return "shutdown-deadline-exceeded";
  if (message.startsWith("Packaged shell shutdown was not normal"))
    return "abnormal-shutdown";
  if (message.startsWith("Packaged shell left owned descendants"))
    return "owned-descendant-leak";
  return "lifecycle-failed";
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
  let failure;
  let cleanupFailureClass;
  try {
    await waitForAcknowledgement(
      child,
      FUNCTIONAL_ACKNOWLEDGEMENT_WATCHDOG_MS,
      timers,
    );
    const acknowledgedAt = clock.now();
    acknowledgementMs = Math.round(acknowledgedAt - startedAt);
    const deadline = acknowledgedAt + SHUTDOWN_BUDGET_MS;
    const exited = waitForExit(child, SHUTDOWN_BUDGET_MS, timers);
    if (child.exitCode === null && child.signalCode === null) {
      const remainingMs = Math.max(0, Math.round(deadline - clock.now()));
      await Promise.race([
        Promise.resolve().then(() =>
          processControl.terminate(child.pid, remainingMs),
        ),
        exited,
      ]);
    }
    if (clock.now() > deadline)
      throw new Error("Packaged shell quit helper exceeded shutdown deadline");
    const exit = await exited;
    if (exit.code !== 0 || exit.signal !== null)
      throw new Error(
        `Packaged shell shutdown was not normal (${exitCause(exit.code, exit.signal)})`,
      );
    shutdownMs = Math.round(clock.now() - acknowledgedAt);
    if (processControl.descendantCount(child.pid) !== 0)
      throw new Error(
        "Packaged shell left owned descendants after normal leader exit",
      );
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (forceCleanup(processControl, child.pid) !== 0)
        cleanupFailureClass = "cleanup-non-convergent";
    } catch {
      cleanupFailureClass = "cleanup-control-failed";
    }
  }
  if (failure && cleanupFailureClass)
    throw new Error(
      `Packaged shell lifecycle and cleanup failed (${lifecycleFailureClass(failure)}; ${cleanupFailureClass})`,
    );
  if (failure) throw failure;
  if (cleanupFailureClass)
    throw new Error(`Packaged shell cleanup failed (${cleanupFailureClass})`);
  return { acknowledgementMs, cleanupOwnedDescendants: 0, shutdownMs };
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
