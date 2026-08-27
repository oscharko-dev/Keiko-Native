import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyTracerAccessibilityResult,
  compileTracerAccessibility,
  executeTracerAccessibilityAction,
  percentile95,
  runPackagedTracerJourney,
  runPackagedWorkspaceJourney,
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
      exitCode: 0,
      projected: true,
      stdout:
        '{"status":"passed","reasonCode":null,"prompted":false,"projectedMs":42}\n',
      stderr: "",
      timedOut: false,
    }),
    {
      projectedMs: 42,
      prompted: false,
      reasonCode: null,
      status: "passed",
    },
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
  assert.deepEqual(
    classifyTracerAccessibilityResult({
      exitCode: 1,
      stdout:
        '{"status":"failed","reasonCode":"containment-failed","prompted":false}\n',
      stderr: "",
      timedOut: false,
    }),
    {
      prompted: false,
      reasonCode: "containment-failed",
      status: "failed",
    },
  );
  assert.deepEqual(
    classifyTracerAccessibilityResult({
      exitCode: 1,
      stdout:
        '{"status":"failed","reasonCode":"cleanup-failed","prompted":false}\n',
      stderr: "",
      timedOut: false,
    }),
    {
      prompted: false,
      reasonCode: "cleanup-failed",
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
      projected: true,
      stdout: '{"status":"passed","reasonCode":null,"prompted":false}',
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

test("fast cancellation failures stop the first semantic wait truthfully", async () => {
  for (const reasonCode of ["cleanup-failed", "containment-failed"]) {
    const classified = classifyTracerAccessibilityResult({
      exitCode: 1,
      stdout: `${JSON.stringify({
        status: "failed",
        reasonCode,
        prompted: false,
      })}\n`,
      stderr: "",
      timedOut: false,
    });
    assert.equal(classified.reasonCode, reasonCode);
    let waits = 0;
    const result = await waitForTracerAccessibilityAction({
      action: "observe-stopping",
      binary: "/bounded/adapter",
      execute: () => classified,
      monotonicNow: () => 0,
      pid: 42,
      timeoutMs: 5_000,
      wait: async () => {
        waits += 1;
      },
    });
    assert.deepEqual(result, {
      elapsedMs: 0,
      prompted: false,
      reasonCode,
      status: "failed",
    });
    assert.equal(waits, 0, "truthful terminal failure must not be retried");
  }
});

test("workspace projection keeps native action duration separate", () => {
  assert.deepEqual(
    classifyTracerAccessibilityResult({
      exitCode: 0,
      nativeAction: true,
      projected: true,
      stderr: "",
      stdout:
        '{"status":"passed","reasonCode":null,"prompted":false,"projectedMs":28,"nativeActionMs":102}\n',
      timedOut: false,
    }),
    {
      nativeActionMs: 102,
      projectedMs: 28,
      prompted: false,
      reasonCode: null,
      status: "passed",
    },
  );
  assert.equal(
    classifyTracerAccessibilityResult({
      exitCode: 0,
      nativeAction: true,
      projected: true,
      stderr: "",
      stdout:
        '{"status":"passed","reasonCode":null,"prompted":false,"projectedMs":28}\n',
      timedOut: false,
    }).reasonCode,
    "adapter-output-invalid",
  );
  for (const nativeActionMs of [-1, 1.5, 5_001]) {
    assert.equal(
      classifyTracerAccessibilityResult({
        exitCode: 0,
        nativeAction: true,
        projected: true,
        stderr: "",
        stdout: `${JSON.stringify({
          nativeActionMs,
          projectedMs: 28,
          prompted: false,
          reasonCode: null,
          status: "passed",
        })}\n`,
        timedOut: false,
      }).reasonCode,
      "adapter-output-invalid",
    );
  }
});

test("the action boundary accepts only the frozen task and bounded workspace identities", () => {
  const run = () => assert.fail("must not start a subprocess");
  for (const request of [
    { action: "unknown", input: undefined, pid: 1 },
    { action: "probe-start", input: "unexpected", pid: 1 },
    {
      action: "probe-start",
      input: undefined,
      observation: "probe-canvas",
      pid: 1,
    },
    {
      action: "cancel-turn",
      input: undefined,
      observation: "observe-workspace-selected",
      pid: 1,
    },
    { action: "observe-workspace-selected", input: undefined, pid: 1 },
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
  assert.equal(invocation[2].timeout, 5_000);

  assert.deepEqual(
    executeTracerAccessibilityAction({
      action: "cancel-turn",
      binary: "/bounded/adapter",
      observation: "observe-stopping",
      pid: 1,
      run: (...args) => {
        invocation = args;
        return {
          status: 0,
          stderr: "",
          stdout:
            '{"status":"passed","reasonCode":null,"prompted":false,"projectedMs":31}\n',
        };
      },
    }),
    {
      projectedMs: 31,
      prompted: false,
      reasonCode: null,
      status: "passed",
    },
  );
  assert.deepEqual(invocation[1], ["1", "cancel-turn", "observe-stopping"]);

  assert.deepEqual(
    executeTracerAccessibilityAction({
      action: "select-workspace",
      binary: "/bounded/adapter",
      input: "KeikoAcceptanceIdentity104ABC123",
      observation: "observe-workspace-selected",
      pid: 1,
      run: (...args) => {
        invocation = args;
        return {
          status: 0,
          stderr: "",
          stdout:
            '{"status":"passed","reasonCode":null,"prompted":false,"projectedMs":28,"nativeActionMs":102}\n',
        };
      },
    }),
    {
      nativeActionMs: 102,
      projectedMs: 28,
      prompted: false,
      reasonCode: null,
      status: "passed",
    },
  );
  assert.deepEqual(invocation[1], [
    "1",
    "select-workspace",
    "observe-workspace-selected",
  ]);

  assert.deepEqual(
    executeTracerAccessibilityAction({
      action: "select-workspace",
      binary: "/bounded/adapter",
      input: "KeikoAcceptanceIdentity104DeniedABC123",
      observation: "observe-workspace-permission-denied",
      pid: 1,
      run: () => ({
        status: 0,
        stderr: "",
        stdout:
          '{"status":"passed","reasonCode":null,"prompted":false,"projectedMs":90}\n',
      }),
    }),
    {
      projectedMs: 90,
      prompted: false,
      reasonCode: null,
      status: "passed",
    },
  );
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
    execute: (request) => {
      assert.equal(request.timeoutMs, 500 - now);
      return results.shift();
    },
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

  const cleanupFailed = await waitForTracerAccessibilityAction({
    action: "observe-cancelled",
    binary: "/bounded/adapter",
    execute: () => ({
      prompted: false,
      reasonCode: "cleanup-failed",
      status: "failed",
    }),
    monotonicNow: () => 0,
    pid: 42,
    timeoutMs: 5_000,
    wait: async () => assert.fail("must not retry a truthful terminal"),
  });
  assert.deepEqual(cleanupFailed, {
    elapsedMs: 0,
    prompted: false,
    reasonCode: "cleanup-failed",
    status: "failed",
  });

  const containmentFailed = await waitForTracerAccessibilityAction({
    action: "observe-cancelled",
    binary: "/bounded/adapter",
    execute: () => ({
      prompted: false,
      reasonCode: "containment-failed",
      status: "failed",
    }),
    monotonicNow: () => 0,
    pid: 42,
    timeoutMs: 5_000,
    wait: async () => assert.fail("must not retry a truthful terminal"),
  });
  assert.deepEqual(containmentFailed, {
    elapsedMs: 0,
    prompted: false,
    reasonCode: "containment-failed",
    status: "failed",
  });
});

test("the packaged journey drives the fixed sequence and excludes observer startup", async () => {
  const calls = [];
  let now = 0;
  const result = await runPackagedTracerJourney({
    deniedWorkspaceLabel: "KeikoAcceptanceIdentity104DeniedABC123",
    execute: async (request) => {
      calls.push({
        action: request.action,
        input: request.input,
        observation: request.observation,
        timeoutMs: request.timeoutMs,
      });
      const elapsedMs =
        request.action === "probe-start"
          ? 1_000
          : request.observation === "observe-stopping"
            ? 80
            : 10;
      now += elapsedMs;
      return {
        elapsedMs,
        ...(request.observation === undefined
          ? {}
          : {
              ...(request.observation === "observe-workspace-selected"
                ? { nativeActionMs: 102 }
                : {}),
              projectedMs:
                request.observation === "observe-workspace-cancelled"
                  ? 500
                  : request.observation === "observe-stopping"
                    ? 80
                    : 10,
            }),
        prompted: false,
        reasonCode: null,
        status: "passed",
      };
    },
    inspectWindowDisplayBinding: async () => {
      calls.push({ action: "inspect-window-display-binding" });
      return {
        displayClass: "internal",
        displayIdentity: "1",
        matchedDisplayCount: 1,
        semanticWindowCount: 1,
        windowIdentity: "2",
        windowPosition: "10.000:20.000",
      };
    },
    crashRuntime: async () => calls.push({ action: "crash-runtime" }),
    monotonicNow: () => now,
    observeRuntime: async () => calls.push({ action: "observe-runtime" }),
    prompt: acceptedPrompt,
    workspaceLabel: "KeikoAcceptanceIdentity104ABC123",
  });

  assert.deepEqual(
    calls.map(({ action }) => action),
    [
      "probe-start",
      "inspect-window-display-binding",
      "open-canvas",
      "open-workspace-picker",
      "cancel-workspace-picker",
      "open-workspace-picker",
      "select-workspace",
      "open-workspace-picker",
      "select-workspace",
      "check-runtime",
      "observe-runtime-ready",
      "focus-task",
      "set-unicode",
      "set-task",
      "submit-task",
      "observe-streaming",
      "observe-runtime",
      "observe-completed",
      "observe-response-semantics",
      "focus-task",
      "set-task",
      "submit-task",
      "observe-streaming",
      "observe-runtime",
      "cancel-turn",
      "observe-cancelled",
      "inspect-window-display-binding",
      "focus-task",
      "set-task",
      "submit-task",
      "observe-streaming",
      "observe-runtime",
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
  assert.deepEqual(
    calls
      .filter(({ observation }) => observation !== undefined)
      .map(({ action, observation }) => `${action}->${observation}`),
    [
      "open-canvas->probe-canvas",
      "cancel-workspace-picker->observe-workspace-cancelled",
      "select-workspace->observe-workspace-permission-denied",
      "select-workspace->observe-workspace-selected",
      "cancel-turn->observe-stopping",
    ],
  );
  assert.equal(
    calls.find(
      ({ action, observation }) =>
        action === "select-workspace" &&
        observation === "observe-workspace-selected",
    ).timeoutMs,
    15_000,
  );
  assert.ok(
    calls
      .filter(
        ({ action, observation }) =>
          observation !== undefined &&
          (action !== "select-workspace" ||
            observation !== "observe-workspace-selected"),
      )
      .every(({ timeoutMs }) => timeoutMs === 5_000),
  );
  assert.equal(result.nativePickerCancellationProjectionMs, 500);
  assert.deepEqual(result.localProjectionMeasurements, [
    {
      action: "open-canvas",
      observation: "probe-canvas",
      projectedMs: 10,
    },
    {
      action: "select-workspace",
      observation: "observe-workspace-permission-denied",
      projectedMs: 10,
    },
    {
      action: "select-workspace",
      observation: "observe-workspace-selected",
      projectedMs: 10,
    },
    {
      action: "cancel-turn",
      observation: "observe-stopping",
      projectedMs: 80,
    },
  ]);
  assert.equal(result.localProjectionP95Ms, 80);
  assert.equal(result.localProjectionSamples, 4);
  assert.equal(result.status, "passed");
  assert.equal(result.turnCancellationProjectionMs, 80);
  assert.deepEqual(result.turnCancellationTerminal, {
    boundary: "cancel-action-start-to-terminal",
    elapsedMs: 90,
    stoppingElapsedMs: 80,
    terminalState: "cancelled",
  });
  assert.equal(result.turnDurationMs, 30);
  assert.equal(result.workspaceSelectionNativeActionMs, 102);
  assert.equal(result.windowDisplayBinding.displayClass, "internal");
});

test("the packaged journey rejects cancellation-time display binding drift", async () => {
  let bindingSample = 0;
  await assert.rejects(
    runPackagedTracerJourney({
      deniedWorkspaceLabel: "KeikoAcceptanceIdentity104DeniedABC123",
      execute: async (request) => ({
        elapsedMs: 1,
        ...(request.observation === undefined
          ? {}
          : {
              ...(request.observation === "observe-workspace-selected"
                ? { nativeActionMs: 1 }
                : {}),
              projectedMs: 1,
            }),
        prompted: false,
        reasonCode: null,
        status: "passed",
      }),
      inspectWindowDisplayBinding: async () => {
        bindingSample += 1;
        return {
          displayClass: bindingSample === 1 ? "external" : "internal",
          displayIdentity: "1",
          matchedDisplayCount: 1,
          semanticWindowCount: 1,
          windowIdentity: "2",
          windowPosition: "10.000:20.000",
        };
      },
      crashRuntime: async () => undefined,
      monotonicNow: () => 0,
      observeRuntime: async () => undefined,
      prompt: acceptedPrompt,
      workspaceLabel: "KeikoAcceptanceIdentity104ABC123",
    }),
    /packaged-journey-window-display-binding-changed/u,
  );
  assert.equal(
    bindingSample,
    2,
    "binding must be inspected after cancellation",
  );
});

test("the packaged journey rejects same-class window movement or replacement without persisting identity", async () => {
  for (const drift of ["position", "window", "display"]) {
    let bindingSample = 0;
    await assert.rejects(
      runPackagedTracerJourney({
        deniedWorkspaceLabel: "KeikoAcceptanceIdentity104DeniedABC123",
        execute: async (request) => ({
          elapsedMs: 1,
          ...(request.observation === undefined
            ? {}
            : {
                ...(request.observation === "observe-workspace-selected"
                  ? { nativeActionMs: 1 }
                  : {}),
                projectedMs: 1,
              }),
          prompted: false,
          reasonCode: null,
          status: "passed",
        }),
        inspectWindowDisplayBinding: async () => {
          bindingSample += 1;
          return {
            displayClass: "external",
            displayIdentity:
              drift === "display" && bindingSample === 2 ? "3" : "1",
            matchedDisplayCount: 1,
            semanticWindowCount: 1,
            windowIdentity:
              drift === "window" && bindingSample === 2 ? "4" : "2",
            windowPosition:
              drift === "position" && bindingSample === 2
                ? "11.000:20.000"
                : "10.000:20.000",
          };
        },
        crashRuntime: async () => undefined,
        monotonicNow: () => 0,
        observeRuntime: async () => undefined,
        prompt: acceptedPrompt,
        workspaceLabel: "KeikoAcceptanceIdentity104ABC123",
      }),
      /packaged-journey-window-display-binding-changed/u,
    );
    assert.equal(
      bindingSample,
      2,
      `${drift} must be compared after cancellation`,
    );
  }
});

test("the packaged cancellation coordinator rejects sequential stopping and terminal waits beyond one deadline", async () => {
  let now = 0;
  await assert.rejects(
    runPackagedTracerJourney({
      deniedWorkspaceLabel: "KeikoAcceptanceIdentity104DeniedABC123",
      execute: async (request) => {
        const elapsedMs =
          request.action === "cancel-turn"
            ? 100
            : request.action === "observe-cancelled"
              ? 5_000
              : 1;
        now += elapsedMs;
        return {
          elapsedMs,
          ...(request.observation === undefined
            ? {}
            : {
                ...(request.observation === "observe-workspace-selected"
                  ? { nativeActionMs: 1 }
                  : {}),
                projectedMs:
                  request.observation === "observe-stopping" ? 100 : 1,
              }),
          prompted: false,
          reasonCode: null,
          status: "passed",
        };
      },
      inspectWindowDisplayBinding: async () => ({
        displayClass: "external",
        displayIdentity: "1",
        matchedDisplayCount: 1,
        semanticWindowCount: 1,
        windowIdentity: "2",
        windowPosition: "10.000:20.000",
      }),
      crashRuntime: async () => undefined,
      monotonicNow: () => now,
      observeRuntime: async () => undefined,
      prompt: acceptedPrompt,
      workspaceLabel: "KeikoAcceptanceIdentity104ABC123",
    }),
    /packaged-journey-checkpoint-failed/u,
  );
});

test("the packaged cancellation observer enforces the inclusive terminal boundary without a zero timeout", async () => {
  for (const terminalElapsedMs of [4_999.5, 5_000, 5_000.1]) {
    let now = 0;
    let cancellationStartedAt = 0;
    let postStoppingClockReads = 0;
    let cancellationActive = false;
    let delayNextDisplayInspection = false;
    const observedTimeouts = [];
    const journey = runPackagedTracerJourney({
      deniedWorkspaceLabel: "KeikoAcceptanceIdentity104DeniedABC123",
      execute: async (request) => {
        if (request.action === "cancel-turn") {
          cancellationStartedAt = now;
          now += 80;
          cancellationActive = true;
        } else if (request.action === "observe-cancelled") {
          observedTimeouts.push(request.timeoutMs);
          if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)
            throw new Error("observer-timeout-invalid");
          cancellationActive = false;
          now = cancellationStartedAt + terminalElapsedMs;
          delayNextDisplayInspection = true;
        } else {
          now += 1;
        }
        return {
          elapsedMs: request.action === "cancel-turn" ? 80 : 1,
          ...(request.observation === undefined
            ? {}
            : {
                ...(request.observation === "observe-workspace-selected"
                  ? { nativeActionMs: 1 }
                  : {}),
                projectedMs:
                  request.observation === "observe-stopping" ? 80 : 1,
              }),
          prompted: false,
          reasonCode: null,
          status: "passed",
        };
      },
      inspectWindowDisplayBinding: async () => {
        if (delayNextDisplayInspection) {
          delayNextDisplayInspection = false;
          now += 1_000;
        }
        return {
          displayClass: "external",
          displayIdentity: "1",
          matchedDisplayCount: 1,
          semanticWindowCount: 1,
          windowIdentity: "2",
          windowPosition: "10.000:20.000",
        };
      },
      crashRuntime: async () => undefined,
      monotonicNow: () => {
        if (!cancellationActive) return now;
        postStoppingClockReads += 1;
        if (postStoppingClockReads === 1) return cancellationStartedAt + 80;
        if (postStoppingClockReads === 2 && terminalElapsedMs > 5_000)
          return cancellationStartedAt + 4_999.5;
        return cancellationStartedAt + terminalElapsedMs;
      },
      observeRuntime: async () => undefined,
      prompt: acceptedPrompt,
      workspaceLabel: "KeikoAcceptanceIdentity104ABC123",
    });

    if (terminalElapsedMs > 5_000) {
      await assert.rejects(journey, /packaged-journey-measurement-invalid/u);
      assert.deepEqual(observedTimeouts, [1]);
      continue;
    }
    const result = await journey;
    assert.deepEqual(observedTimeouts, [1]);
    assert.equal(result.turnCancellationTerminal.elapsedMs, 5_000);
  }
});

test("the packaged cancellation observer rejects time beyond the inclusive boundary before observing", async () => {
  let now = 0;
  let cancellationStartedAt = 0;
  let postStoppingClockReads = 0;
  let cancellationActive = false;
  let terminalObserved = false;
  await assert.rejects(
    runPackagedTracerJourney({
      deniedWorkspaceLabel: "KeikoAcceptanceIdentity104DeniedABC123",
      execute: async (request) => {
        if (request.action === "cancel-turn") {
          cancellationStartedAt = now;
          now += 80;
          cancellationActive = true;
        } else if (request.action === "observe-cancelled") {
          terminalObserved = true;
        } else {
          now += 1;
        }
        return {
          elapsedMs: request.action === "cancel-turn" ? 80 : 1,
          ...(request.observation === undefined
            ? {}
            : {
                ...(request.observation === "observe-workspace-selected"
                  ? { nativeActionMs: 1 }
                  : {}),
                projectedMs:
                  request.observation === "observe-stopping" ? 80 : 1,
              }),
          prompted: false,
          reasonCode: null,
          status: "passed",
        };
      },
      inspectWindowDisplayBinding: async () => ({
        displayClass: "external",
        displayIdentity: "1",
        matchedDisplayCount: 1,
        semanticWindowCount: 1,
        windowIdentity: "2",
        windowPosition: "10.000:20.000",
      }),
      crashRuntime: async () => undefined,
      monotonicNow: () => {
        if (!cancellationActive) return now;
        postStoppingClockReads += 1;
        return postStoppingClockReads === 1
          ? cancellationStartedAt + 80
          : cancellationStartedAt + 5_000.1;
      },
      observeRuntime: async () => undefined,
      prompt: acceptedPrompt,
      workspaceLabel: "KeikoAcceptanceIdentity104ABC123",
    }),
    /packaged-journey-measurement-invalid/u,
  );
  assert.equal(terminalObserved, false);
});

test("the workspace tranche stops after four exact successful projections", async () => {
  const calls = [];
  const result = await runPackagedWorkspaceJourney({
    deniedWorkspaceLabel: "KeikoAcceptanceIdentity104DeniedABC123",
    execute: async (request) => {
      calls.push(request);
      const successfulSelection =
        request.action === "select-workspace" &&
        request.observation === "observe-workspace-selected";
      return {
        elapsedMs: 10,
        ...(request.observation === undefined
          ? {}
          : {
              ...(successfulSelection ? { nativeActionMs: 120 } : {}),
              projectedMs: successfulSelection ? 40 : 20,
            }),
        prompted: false,
        reasonCode: null,
        status: "passed",
      };
    },
    workspaceLabels: Array.from(
      { length: 4 },
      (_, index) => `KeikoAcceptanceIdentity104Sample${index + 1}ABC123`,
    ),
  });

  assert.deepEqual(
    {
      actions: calls.map(
        ({ action, observation }) =>
          `${action}${observation === undefined ? "" : `->${observation}`}`,
      ),
      nativeActions: result.workspaceSelectionNativeActionMeasurements,
      p95: result.workspaceProjectionP95Ms,
      projections: result.workspaceProjectionMeasurements,
    },
    {
      actions: [
        "probe-start",
        "open-canvas->probe-canvas",
        "open-workspace-picker",
        "cancel-workspace-picker->observe-workspace-cancelled",
        "open-workspace-picker",
        "select-workspace->observe-workspace-permission-denied",
        "open-workspace-picker",
        "select-workspace->observe-workspace-selected",
        "open-workspace-picker",
        "select-workspace->observe-workspace-selected",
        "open-workspace-picker",
        "select-workspace->observe-workspace-selected",
        "open-workspace-picker",
        "select-workspace->observe-workspace-selected",
        "quit",
      ],
      nativeActions: Array.from({ length: 4 }, (_, index) => ({
        nativeActionMs: 120,
        sample: index + 1,
      })),
      p95: 40,
      projections: Array.from({ length: 4 }, (_, index) => ({
        projectedMs: 40,
        sample: index + 1,
      })),
    },
  );
  assert.equal(
    calls.some(({ action }) =>
      ["check-runtime", "submit-task", "cancel-turn"].includes(action),
    ),
    false,
  );
  assert.ok(
    calls
      .filter(
        ({ action, observation }) =>
          action === "select-workspace" &&
          observation === "observe-workspace-selected",
      )
      .every(({ timeoutMs }) => timeoutMs === 15_000),
  );
  assert.deepEqual(
    calls
      .filter(
        ({ action, observation }) =>
          action === "select-workspace" &&
          observation === "observe-workspace-selected",
      )
      .map(({ input }) => input),
    Array.from(
      { length: 4 },
      (_, index) => `KeikoAcceptanceIdentity104Sample${index + 1}ABC123`,
    ),
  );
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

test("the accessibility compiler requires a bounded subprocess runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-tracer-ax-runner-"));
  try {
    let invocation;
    await compileTracerAccessibility(root, async (command, args, options) => {
      invocation = { command, args, options };
      await writeFile(join(root, "KeikoTracerAX"), "compiled", {
        mode: 0o700,
      });
      return { error: undefined, status: 0 };
    });
    assert.equal(invocation.command, "/usr/bin/xcrun");
    assert.equal(invocation.options.timeoutMs, 10_000);
    assert.equal(invocation.options.shell, false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
