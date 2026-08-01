import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyTracerAccessibilityResult,
  compileTracerAccessibility,
  executeTracerAccessibilityAction,
  percentile95,
  runPackagedTracerJourney,
  waitForTracerAccessibilityAction,
} from "./codex-tracer-accessibility.mjs";

const acceptedPrompt = await readFile(
  new URL("./fixtures/codex-tracer/no-effect-prompt.txt", import.meta.url),
  "utf8",
);
const checkoutAttributes = await readFile(
  new URL("../.gitattributes", import.meta.url),
  "utf8",
);

test("the digest-bound prompt retains LF checkout bytes on every platform", () => {
  assert.match(
    checkoutAttributes,
    /^\/quality\/fixtures\/codex-tracer\/no-effect-prompt\.txt text eol=lf$/mu,
  );
  assert.equal(acceptedPrompt.includes("\r"), false);
});

test("p95 uses the bounded nearest-rank observation", () => {
  assert.equal(percentile95([100, 5, 20, 10, 15]), 100);
  assert.equal(
    percentile95(Array.from({ length: 20 }, (_, index) => index)),
    18,
  );
  for (const values of [[], [1.5], [-1], [Number.NaN]]) {
    assert.throws(() => percentile95(values), /measurement-invalid/u);
  }
});

test("adapter results accept only one closed semantic outcome", () => {
  assert.deepEqual(
    classifyTracerAccessibilityResult({
      exitCode: 0,
      stdout: '{"status":"passed","reasonCode":null,"prompted":false}\n',
      stderr: "",
      timedOut: false,
    }),
    { prompted: false, reasonCode: null, status: "passed" },
  );
  assert.deepEqual(
    classifyTracerAccessibilityResult({
      exitCode: 1,
      stdout:
        '{"status":"failed","reasonCode":"missing-or-ambiguous-semantic-target","prompted":false}\n',
      stderr: "",
      timedOut: false,
    }),
    {
      prompted: false,
      reasonCode: "missing-or-ambiguous-semantic-target",
      status: "failed",
    },
  );
  for (const hostile of [
    { exitCode: 0, stdout: "not-json", stderr: "", timedOut: false },
    {
      exitCode: 0,
      stdout:
        '{"status":"passed","reasonCode":null,"prompted":false,"extra":true}',
      stderr: "",
      timedOut: false,
    },
    {
      exitCode: 0,
      stdout: '{"status":"passed","reasonCode":null,"prompted":false}\nsecond',
      stderr: "",
      timedOut: false,
    },
    {
      exitCode: 0,
      stdout: '{"status":"passed","reasonCode":null,"prompted":false}',
      stderr: "private value",
      timedOut: false,
    },
    { exitCode: null, stdout: "", stderr: "", timedOut: true },
  ]) {
    assert.deepEqual(classifyTracerAccessibilityResult(hostile), {
      prompted: false,
      reasonCode: hostile.timedOut
        ? "bounded-wait-expired"
        : "adapter-output-invalid",
      status: "failed",
    });
  }
});

test("the action boundary accepts only the frozen task and bounded workspace identities", () => {
  const run = () => assert.fail("must not start a subprocess");
  for (const request of [
    { action: "unknown", input: undefined, pid: 1 },
    { action: "probe-start", input: "unexpected", pid: 1 },
    { action: "set-task", input: "", pid: 1 },
    { action: "set-task", input: "x".repeat(4_097), pid: 1 },
    { action: "set-task", input: "bounded", pid: 1 },
    { action: "set-task", input: `${acceptedPrompt}changed`, pid: 1 },
    { action: "set-task", input: "bounded", pid: 0 },
  ]) {
    assert.throws(
      () =>
        executeTracerAccessibilityAction({
          binary: "/bounded/adapter",
          run,
          ...request,
        }),
      /adapter-action-invalid/u,
    );
  }

  let invocation;
  assert.deepEqual(
    executeTracerAccessibilityAction({
      action: "set-task",
      binary: "/bounded/adapter",
      input: acceptedPrompt,
      pid: 1,
      run: (...args) => {
        invocation = args;
        return {
          status: 0,
          stderr: "",
          stdout: '{"status":"passed","reasonCode":null,"prompted":false}\n',
        };
      },
    }),
    { prompted: false, reasonCode: null, status: "passed" },
  );
  assert.equal(invocation[2].input, acceptedPrompt);
});

test("bounded semantic waits retry only missing targets and stop on permission denial", async () => {
  let now = 0;
  const results = [
    {
      prompted: false,
      reasonCode: "missing-or-ambiguous-semantic-target",
      status: "failed",
    },
    { prompted: false, reasonCode: null, status: "passed" },
  ];
  const passed = await waitForTracerAccessibilityAction({
    action: "observe-completed",
    binary: "/bounded/adapter",
    execute: () => results.shift(),
    monotonicNow: () => now,
    pid: 42,
    timeoutMs: 500,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  });
  assert.deepEqual(passed, {
    elapsedMs: 20,
    prompted: false,
    reasonCode: null,
    status: "passed",
  });

  let attempts = 0;
  const denied = await waitForTracerAccessibilityAction({
    action: "probe-start",
    binary: "/bounded/adapter",
    execute: () => {
      attempts += 1;
      return {
        prompted: false,
        reasonCode: "accessibility-permission-denied",
        status: "failed",
      };
    },
    monotonicNow: () => 0,
    pid: 42,
    timeoutMs: 500,
    wait: async () => assert.fail("must not retry"),
  });
  assert.equal(attempts, 1);
  assert.equal(denied.reasonCode, "accessibility-permission-denied");
});

test("the packaged journey drives only the fixed semantic sequence", async () => {
  const calls = [];
  let now = 0;
  const result = await runPackagedTracerJourney({
    deniedWorkspaceLabel: "KeikoAcceptanceIdentity104DeniedABC123",
    execute: async (request) => {
      calls.push({ action: request.action, input: request.input });
      now += request.action === "observe-stopping" ? 80 : 10;
      return {
        elapsedMs: request.action === "observe-stopping" ? 80 : 10,
        prompted: false,
        reasonCode: null,
        status: "passed",
      };
    },
    crashRuntime: async () => calls.push({ action: "crash-runtime" }),
    monotonicNow: () => now,
    prompt: acceptedPrompt,
    workspaceLabel: "KeikoAcceptanceIdentity104ABC123",
  });

  assert.deepEqual(
    calls.map(({ action }) => action),
    [
      "probe-start",
      "open-canvas",
      "probe-canvas",
      "open-workspace-picker",
      "cancel-workspace-picker",
      "observe-workspace-cancelled",
      "open-workspace-picker",
      "select-workspace",
      "observe-workspace-permission-denied",
      "open-workspace-picker",
      "select-workspace",
      "observe-workspace-selected",
      "check-runtime",
      "observe-runtime-ready",
      "focus-task",
      "set-unicode",
      "set-task",
      "submit-task",
      "observe-streaming",
      "observe-completed",
      "observe-response-semantics",
      "focus-task",
      "set-task",
      "submit-task",
      "observe-streaming",
      "cancel-turn",
      "observe-stopping",
      "observe-cancelled",
      "focus-task",
      "set-task",
      "submit-task",
      "observe-streaming",
      "crash-runtime",
      "observe-failed",
      "check-runtime",
      "observe-runtime-ready",
      "quit",
    ],
  );
  assert.equal(
    calls.find(({ action }) => action === "set-task").input,
    acceptedPrompt,
  );
  assert.equal(result.cancellationProjectionMs, 80);
  assert.equal(result.localProjectionP95Ms, 80);
  assert.equal(result.localProjectionSamples, 5);
  assert.equal(result.status, "passed");
  assert.equal(result.turnDurationMs, 30);
});

const macArm64Test =
  process.platform === "darwin" && process.arch === "arm64"
    ? test
    : (name, callback) =>
        test(name, { skip: "requires authoritative macOS arm64" }, callback);

macArm64Test(
  "the repository-owned compile step emits an executable digest",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "keiko-tracer-ax-compile-"));
    try {
      const result = await compileTracerAccessibility(root);
      assert.equal(result.status, "compiled");
      assert.match(result.sha256, /^[0-9a-f]{64}$/u);
      assert.ok((await readFile(result.binary)).byteLength > 0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);
