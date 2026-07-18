import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runPackagedLifecycle } from "./native-lifecycle.mjs";

class Stream extends EventEmitter {
  setEncoding() {}
}

function fixture({ descendantCount = 0, terminate } = {}) {
  const child = new EventEmitter();
  child.pid = 42;
  child.exitCode = null;
  child.stderr = new Stream();
  const calls = [];
  const control = {
    descendantCount: (pid) => {
      calls.push(["descendants", pid]);
      return descendantCount;
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
        child.emit("exit", 0);
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
  child.emit("exit", 1);
  await assert.rejects(pending, /before acknowledgement/u);
  assert.deepEqual(calls.at(-1), ["kill", 42]);
});

test("shutdown listener is armed before an immediate helper exit", async () => {
  const { child, control } = fixture();
  control.terminate = async () => {
    child.exitCode = 0;
    child.emit("exit", 0);
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
  child.emit("exit", 0);
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
  assert.deepEqual(calls.at(-1), ["kill", 42]);
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

test("remaining owned descendants fail closed after cleanup", async () => {
  const { child, control } = fixture({ descendantCount: 1 });
  const pending = runPackagedLifecycle({
    executable: "/package/app",
    packageRoot: "/package",
    processControl: control,
  });
  acknowledge(child);
  await assert.rejects(pending, /left owned descendants/u);
});
