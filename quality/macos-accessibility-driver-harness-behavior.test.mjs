import assert from "node:assert/strict";
import test from "node:test";

import {
  checkpointBehaviorContract,
  classifyCandidateSubprocessOutcome,
  establishOwnedProcess,
  executeCandidateCheckpoint,
  rejectUnauthenticatedLauncher,
} from "./macos-accessibility-driver-harness.mjs";

const expectedCheckpoints = [
  "workspace-select",
  "workspace-cancel",
  "workspace-permission-deny",
  "task-submit",
  "streaming",
  "normal-completion",
  "run-cancellation",
  "crash-recovery",
  "terminal-summary",
  "keyboard-focus",
  "voiceover-semantics",
  "appearance-contrast",
  "reduce-motion-applicability",
  "scaling",
  "unicode-ime",
  "quit-zero-descendants",
];

test("representative checkpoint contract keeps 16 behavioral semantics", () => {
  assert.deepEqual(
    Object.keys(checkpointBehaviorContract),
    expectedCheckpoints,
  );
  assert.deepEqual(
    checkpointBehaviorContract["workspace-permission-deny"].observations,
    ["workspace:permission-denied"],
  );
  assert.deepEqual(checkpointBehaviorContract["task-submit"].observations, [
    "task:submitted-after-late-state",
  ]);
  assert.deepEqual(
    checkpointBehaviorContract["run-cancellation"].observations,
    ["run:cancelled-late-result-discarded"],
  );
  assert.deepEqual(checkpointBehaviorContract["crash-recovery"].observations, [
    "runtime:crashed",
    "runtime:recovered",
  ]);
  assert.deepEqual(
    checkpointBehaviorContract["appearance-contrast"].observations,
    ["appearance:light", "appearance:dark", "appearance:increase-contrast"],
  );
  assert.deepEqual(
    checkpointBehaviorContract["reduce-motion-applicability"].observations,
    ["motion:reduced", "motion:full"],
  );
});

test("candidate execution exposes a closed behavioral checkpoint boundary", () => {
  const calls = [];
  const passed = executeCandidateCheckpoint({
    candidate: "axuielement",
    checkpoint: "crash-recovery",
    runCandidate: (request) => {
      calls.push(request);
      return {
        exitCode: 0,
        signal: null,
        stderrEmpty: true,
        stdout:
          '{"status":"passed","reasonCode":null,"prompted":false,"checkpointPasses":1}',
        timedOut: false,
      };
    },
    surfacePid: 4100,
  });
  assert.deepEqual(calls, [
    {
      candidate: "axuielement",
      checkpoint: "crash-recovery",
      expectedBehavior: checkpointBehaviorContract["crash-recovery"],
      surfacePid: 4100,
    },
  ]);
  assert.deepEqual(passed, {
    checkpointPasses: 1,
    prompted: false,
    reasonCode: null,
    status: "passed",
  });

  let systemEventsCalls = 0;
  assert.deepEqual(
    executeCandidateCheckpoint({
      candidate: "systemEvents",
      checkpoint: "task-submit",
      runCandidate: () => {
        systemEventsCalls += 1;
        throw new Error("System Events runner must not execute");
      },
      surfacePid: 4100,
    }),
    {
      checkpointPasses: 0,
      prompted: null,
      reasonCode: "authoritative-evidence-unavailable",
      status: "rejected",
    },
  );
  assert.equal(systemEventsCalls, 0);
});

test("candidate subprocess results fail closed on process-level anomalies", () => {
  const passed = {
    exitCode: 0,
    signal: null,
    stderrEmpty: true,
    stdout:
      '{"status":"passed","reasonCode":null,"prompted":false,"checkpointPasses":1,"hostile":"must-not-propagate"}',
    timedOut: false,
  };
  assert.deepEqual(classifyCandidateSubprocessOutcome(passed), {
    checkpointPasses: 1,
    prompted: false,
    reasonCode: null,
    status: "passed",
  });

  for (const hostile of [
    { ...passed, exitCode: 9 },
    { ...passed, exitCode: null, signal: "SIGKILL" },
    { ...passed, stderrEmpty: false },
  ]) {
    assert.deepEqual(classifyCandidateSubprocessOutcome(hostile), {
      checkpointPasses: 0,
      prompted: false,
      reasonCode: "candidate-process-failed",
      status: "failed",
    });
  }

  assert.deepEqual(
    classifyCandidateSubprocessOutcome({ ...passed, timedOut: true }),
    {
      checkpointPasses: 0,
      prompted: false,
      reasonCode: "bounded-wait-expired",
      status: "failed",
    },
  );

  assert.deepEqual(
    classifyCandidateSubprocessOutcome({
      ...passed,
      stdout:
        '{"status":"permission-denied","reasonCode":"accessibility-permission-denied","prompted":false,"checkpointPasses":0}',
    }),
    {
      checkpointPasses: 0,
      prompted: false,
      reasonCode: "accessibility-permission-denied",
      status: "permission-denied",
    },
  );
  assert.deepEqual(
    classifyCandidateSubprocessOutcome({
      ...passed,
      stdout:
        '{"status":"failed","reasonCode":"checkpoint-observation-failed","prompted":false,"checkpointPasses":0}',
    }),
    {
      checkpointPasses: 0,
      prompted: false,
      reasonCode: "checkpoint-observation-failed",
      status: "failed",
    },
  );

  for (const stdout of [
    "{",
    '{"status":"passed","reasonCode":null,"prompted":false,"checkpointPasses":0}',
    '{"status":"passed","reasonCode":"checkpoint-observation-failed","prompted":false,"checkpointPasses":1}',
    '{"status":"permission-denied","reasonCode":"accessibility-permission-denied","prompted":false,"checkpointPasses":1}',
    '{"status":"permission-denied","reasonCode":"checkpoint-observation-failed","prompted":false,"checkpointPasses":0}',
    '{"status":"failed","reasonCode":null,"prompted":false,"checkpointPasses":0}',
    '{"status":"failed","reasonCode":"checkpoint-observation-failed","prompted":false,"checkpointPasses":1}',
    '{"status":"unknown","reasonCode":null,"prompted":false,"checkpointPasses":1}',
  ]) {
    assert.deepEqual(
      classifyCandidateSubprocessOutcome({ ...passed, stdout }),
      {
        checkpointPasses: 0,
        prompted: false,
        reasonCode: "candidate-output-invalid",
        status: "failed",
      },
    );
  }
});

test("owned process establishment rejects the launcher before propagating authentication failure", async () => {
  const launcher = { pid: 4100 };
  const events = [];
  let releaseCleanup;
  const cleanupReleased = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  let settled = false;
  const establishment = establishOwnedProcess({
    authenticate: async (child) => {
      events.push(["authenticate", child.pid]);
      throw new Error("handshake-invalid");
    },
    launch: () => {
      events.push(["launch", launcher.pid]);
      return launcher;
    },
    reject: async (child) => {
      await cleanupReleased;
      events.push(["reject", child.pid]);
    },
  }).finally(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  releaseCleanup();
  await assert.rejects(establishment, /handshake-invalid/u);
  assert.deepEqual(events, [
    ["launch", 4100],
    ["authenticate", 4100],
    ["reject", 4100],
  ]);
});

test("launcher rejection confirms close after bounded kill escalation", async () => {
  const events = [];
  const waits = [false, true];
  const child = {
    exitCode: null,
    signalCode: null,
    stdin: {
      end: () => events.push("stdin-end"),
    },
    stdout: {
      destroy: () => events.push("stdout-destroy"),
    },
    kill: (signal) => {
      events.push(`kill-${signal}`);
      return true;
    },
  };
  await rejectUnauthenticatedLauncher(child, {
    waitForClose: async (_child, timeoutMs) => {
      events.push(`wait-${timeoutMs}`);
      return waits.shift();
    },
  });
  assert.deepEqual(events, [
    "stdin-end",
    "stdout-destroy",
    "wait-2000",
    "kill-SIGKILL",
    "wait-2000",
  ]);
});
