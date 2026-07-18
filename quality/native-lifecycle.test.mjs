import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runPackagedLifecycle } from "./native-lifecycle.mjs";

class Stream extends EventEmitter {
  setEncoding() {}
}

function fixture({ descendantCount = 0, descendantCounts, terminate } = {}) {
  const child = new EventEmitter();
  child.pid = 42;
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = new Stream();
  const calls = [];
  const control = {
    descendantCount: (pid) => {
      calls.push(["descendants", pid]);
      return descendantCounts?.shift() ?? descendantCount;
    },
    killGroup: (pid) => calls.push(["kill", pid]),
    spawn: (...args) => {
      calls.push(["spawn", ...args]);
      return child;
    },
    terminate:
      terminate ??
      (async (pid, timeout) => {
        calls.push(["terminate", pid, timeout]);
        child.exitCode = 0;
        child.emit("exit", 0, null);
      }),
  };
  return { calls, child, control };
}

function acknowledge(child) {
  child.stderr.emit("data", "keiko-native-health-ack/v1 sequence=2\n");
}

test("lifecycle binds normal quit and cleanup to the spawned exact PID", async () => {
  const { calls, child, control } = fixture();
  const pending = runPackagedLifecycle({
    clock: { now: () => 10 },
    executable: "/package/app",
    packageRoot: "/package",
    processControl: control,
  });
  acknowledge(child);
  assert.deepEqual(await pending, {
    acknowledgementMs: 0,
    cleanupOwnedDescendants: 0,
    shutdownMs: 0,
  });
  assert.ok(calls.some((call) => call[0] === "terminate" && call[1] === 42));
  assert.ok(!JSON.stringify(calls).includes("bundle"));
});

test("fast exit before acknowledgement fails and still cleans its group", async () => {
  const { calls, child, control } = fixture();
  const pending = runPackagedLifecycle({
    executable: "/package/app",
    packageRoot: "/package",
    processControl: control,
  });
  child.exitCode = 1;
  child.emit("exit", 1, null);
  await assert.rejects(pending, /before acknowledgement \(status:1\)/u);
  assert.ok(calls.some((call) => call[0] === "kill"));
});

test("shutdown listener is armed before an immediate helper exit", async () => {
  const { child, control } = fixture();
  control.terminate = async () => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
  };
  const pending = runPackagedLifecycle({
    executable: "/package/app",
    packageRoot: "/package",
    processControl: control,
  });
  acknowledge(child);
  await pending;
});

test("an acknowledged leader that already exited does not invoke the quit helper", async () => {
  const { calls, child, control } = fixture();
  const pending = runPackagedLifecycle({
    executable: "/package/app",
    packageRoot: "/package",
    processControl: control,
  });
  acknowledge(child);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  await pending;
  assert.ok(!calls.some((call) => call[0] === "terminate"));
  assert.ok(calls.some((call) => call[0] === "kill"));
});

test("hung helper obeys the absolute shutdown deadline without wall sleeps", async () => {
  const timers = {
    clearTimeout() {},
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    },
  };
  const { calls, child, control } = fixture({
    terminate: () => new Promise(() => {}),
  });
  const pending = runPackagedLifecycle({
    executable: "/package/app",
    packageRoot: "/package",
    processControl: control,
    timers,
  });
  acknowledge(child);
  await assert.rejects(pending, /did not shut down/u);
  assert.ok(calls.some((call) => call[0] === "kill"));
});

test("leader exit never skips descendant cleanup or verification", async () => {
  const { calls, child, control } = fixture();
  const pending = runPackagedLifecycle({
    executable: "/package/app",
    packageRoot: "/package",
    processControl: control,
  });
  acknowledge(child);
  await pending;
  assert.ok(calls.some((call) => call[0] === "kill" && call[1] === 42));
  assert.ok(calls.some((call) => call[0] === "descendants" && call[1] === 42));
});

test("remaining owned descendants fail closed when cleanup cannot converge", async () => {
  const { child, control } = fixture({
    descendantCount: 1,
    descendantCounts: [0],
  });
  const pending = runPackagedLifecycle({
    executable: "/package/app",
    packageRoot: "/package",
    processControl: control,
  });
  acknowledge(child);
  await assert.rejects(pending, /cleanup did not converge/u);
});

test("cleanup failure never replaces the primary lifecycle failure", async () => {
  const { child, control } = fixture({ descendantCount: 1 });
  const pending = runPackagedLifecycle({
    executable: "/package/app",
    packageRoot: "/package",
    processControl: control,
  });
  child.exitCode = 2;
  child.emit("exit", 2, null);
  await assert.rejects(pending, /before acknowledgement \(status:2\)/u);
});

test("nonzero and signalled leader exits never become normal shutdown", async () => {
  for (const exit of [
    { code: 9, signal: null, expected: /status:9/u },
    { code: null, signal: "SIGTERM", expected: /signal:SIGTERM/u },
  ]) {
    const { child, control } = fixture({
      terminate: async () => {
        child.exitCode = exit.code;
        child.signalCode = exit.signal;
        child.emit("exit", exit.code, exit.signal);
      },
    });
    const pending = runPackagedLifecycle({
      executable: "/package/app",
      packageRoot: "/package",
      processControl: control,
    });
    acknowledge(child);
    await assert.rejects(pending, exit.expected);
  }
});

test("leader-exit leaks fail evidence before finally cleanup", async () => {
  const { child, control } = fixture({ descendantCounts: [1, 0] });
  const pending = runPackagedLifecycle({
    executable: "/package/app",
    packageRoot: "/package",
    processControl: control,
  });
  acknowledge(child);
  await assert.rejects(pending, /after normal leader exit/u);
});

test("finally cleanup polls boundedly without sleeps until descendants are reaped", async () => {
  const { calls, child, control } = fixture({ descendantCounts: [0, 2, 1, 0] });
  const pending = runPackagedLifecycle({
    executable: "/package/app",
    packageRoot: "/package",
    processControl: control,
  });
  acknowledge(child);
  await pending;
  assert.equal(calls.filter((call) => call[0] === "kill").length, 3);
});
