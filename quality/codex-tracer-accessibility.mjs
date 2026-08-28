import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  tracerAccessibilityActions,
  tracerAccessibilitySource,
} from "./codex-tracer-accessibility-source.mjs";
import { compareCodeUnits } from "./deterministic-order.mjs";

const reasonCodes = new Set([
  "accessibility-permission-denied",
  "adapter-output-invalid",
  "bounded-wait-expired",
  "cleanup-failed",
  "containment-failed",
  "invalid-invocation",
  "missing-or-ambiguous-semantic-target",
]);
const acceptedPromptSha256 =
  "e1a92579b1ca673135331829beb97792c1289a6bccdfe0303302256c546960f6";
const successfulWorkspaceInvocationTimeoutMs = 15_000;
const projectionPairs = new Set([
  "cancel-turn\0observe-stopping",
  "cancel-workspace-picker\0observe-workspace-cancelled",
  "open-canvas\0probe-canvas",
  "select-workspace\0observe-workspace-permission-denied",
  "select-workspace\0observe-workspace-selected",
]);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function classifyTracerAccessibilityResult({
  exitCode,
  nativeAction = false,
  projected = false,
  stderr,
  stdout,
  timedOut,
}) {
  const failed = (reasonCode) => ({
    prompted: false,
    reasonCode,
    status: "failed",
  });
  if (timedOut) return failed("bounded-wait-expired");
  if (stderr !== "" || typeof stdout !== "string")
    return failed("adapter-output-invalid");
  const lines = stdout.split("\n").filter(Boolean);
  if (lines.length !== 1) return failed("adapter-output-invalid");
  try {
    const parsed = JSON.parse(lines[0]);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      parsed.prompted !== false
    ) {
      return failed("adapter-output-invalid");
    }
    const expectedKeys =
      projected && exitCode === 0
        ? [
            ...(nativeAction ? ["nativeActionMs"] : []),
            "projectedMs",
            "prompted",
            "reasonCode",
            "status",
          ]
        : ["prompted", "reasonCode", "status"];
    if (
      JSON.stringify(Object.keys(parsed).toSorted(compareCodeUnits)) !==
      JSON.stringify(expectedKeys)
    ) {
      return failed("adapter-output-invalid");
    }
    if (
      exitCode === 0 &&
      parsed.status === "passed" &&
      parsed.reasonCode === null &&
      (!projected ||
        (Number.isSafeInteger(parsed.projectedMs) &&
          parsed.projectedMs >= 0 &&
          parsed.projectedMs <= 5_000)) &&
      (!nativeAction ||
        (Number.isSafeInteger(parsed.nativeActionMs) &&
          parsed.nativeActionMs >= 0 &&
          parsed.nativeActionMs <= 5_000))
    ) {
      return parsed;
    }
    if (
      exitCode === 1 &&
      parsed.status === "failed" &&
      reasonCodes.has(parsed.reasonCode)
    ) {
      return parsed;
    }
  } catch {
    return failed("adapter-output-invalid");
  }
  return failed("adapter-output-invalid");
}

export function executeTracerAccessibilityAction({
  action,
  binary,
  input,
  observation,
  pid,
  run = spawnSync,
  timeoutMs = 5_000,
}) {
  const inputBytes =
    typeof input === "string" ? Buffer.byteLength(input, "utf8") : 0;
  const taskInputValid =
    action === "set-task" &&
    typeof input === "string" &&
    inputBytes >= 1 &&
    inputBytes <= 4_096 &&
    sha256(input) === acceptedPromptSha256;
  const workspaceInputValid =
    action === "select-workspace" &&
    typeof input === "string" &&
    /^KeikoAcceptanceIdentity104[A-Za-z0-9]+$/u.test(input);
  const projectionValid =
    observation === undefined ||
    projectionPairs.has(`${action}\0${observation}`);
  if (
    typeof binary !== "string" ||
    binary.length === 0 ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000 ||
    !tracerAccessibilityActions.includes(action) ||
    !projectionValid ||
    (action === "set-task" || action === "select-workspace"
      ? !taskInputValid && !workspaceInputValid
      : input !== undefined)
  ) {
    throw new TypeError("adapter-action-invalid");
  }
  const result = run(
    binary,
    [String(pid), action, ...(observation === undefined ? [] : [observation])],
    {
      encoding: "utf8",
      input,
      maxBuffer: 16 * 1024,
      shell: false,
      timeout: timeoutMs,
    },
  );
  return classifyTracerAccessibilityResult({
    exitCode: result.status,
    nativeAction:
      action === "select-workspace" &&
      observation === "observe-workspace-selected",
    projected: observation !== undefined,
    stderr: String(result.stderr ?? ""),
    stdout: String(result.stdout ?? ""),
    timedOut: result.error?.code === "ETIMEDOUT",
  });
}

function waitForTurn(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function percentile95(values) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new TypeError("measurement-invalid");
  }
  const ordered = values.toSorted((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

export async function waitForTracerAccessibilityAction({
  action,
  binary,
  execute = executeTracerAccessibilityAction,
  input,
  monotonicNow = () => performance.now(),
  pid,
  observation,
  timeoutMs,
  wait = waitForTurn,
}) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000
  ) {
    throw new TypeError("adapter-wait-invalid");
  }
  const startedAt = monotonicNow();
  const deadline = startedAt + timeoutMs;
  do {
    const remainingMs = Math.max(1, Math.ceil(deadline - monotonicNow()));
    const result = execute({
      action,
      binary,
      input,
      observation,
      pid,
      timeoutMs: remainingMs,
    });
    if (
      result.status === "passed" ||
      result.reasonCode !== "missing-or-ambiguous-semantic-target"
    ) {
      return {
        ...result,
        elapsedMs: Math.round(monotonicNow() - startedAt),
      };
    }
    await wait(20);
  } while (monotonicNow() < deadline);
  return {
    elapsedMs: Math.round(monotonicNow() - startedAt),
    prompted: false,
    reasonCode: "bounded-wait-expired",
    status: "failed",
  };
}

async function runWorkspaceStep(execute, request) {
  const result = await execute({ timeoutMs: 5_000, ...request });
  if (
    result?.status !== "passed" ||
    result.reasonCode !== null ||
    result.prompted !== false ||
    !Number.isSafeInteger(result.elapsedMs) ||
    result.elapsedMs < 0 ||
    result.elapsedMs > (request.timeoutMs ?? 5_000)
  ) {
    throw new Error("packaged-workspace-checkpoint-failed");
  }
  return result;
}

async function runWorkspaceProjection(execute, request) {
  const result = await runWorkspaceStep(execute, request);
  if (
    !Number.isSafeInteger(result.projectedMs) ||
    result.projectedMs < 0 ||
    result.projectedMs > 5_000
  ) {
    throw new Error("packaged-workspace-measurement-invalid");
  }
  return result;
}

async function measureWorkspaceSelections(execute, workspaceLabels) {
  const selections = [];
  for (const [index, workspaceLabel] of workspaceLabels.entries()) {
    await runWorkspaceStep(execute, { action: "open-workspace-picker" });
    const selected = await runWorkspaceProjection(execute, {
      action: "select-workspace",
      input: workspaceLabel,
      observation: "observe-workspace-selected",
      timeoutMs: successfulWorkspaceInvocationTimeoutMs,
    });
    if (
      !Number.isSafeInteger(selected.nativeActionMs) ||
      selected.nativeActionMs < 0 ||
      selected.nativeActionMs > 5_000
    ) {
      throw new Error("packaged-workspace-measurement-invalid");
    }
    selections.push({
      nativeActionMs: selected.nativeActionMs,
      projectedMs: selected.projectedMs,
      sample: index + 1,
    });
  }
  return selections;
}

export async function runPackagedWorkspaceJourney({
  deniedWorkspaceLabel,
  execute,
  workspaceLabels,
}) {
  const labelPattern = /^KeikoAcceptanceIdentity104[A-Za-z0-9]+$/u;
  const selectedLabels = Array.isArray(workspaceLabels)
    ? new Set(workspaceLabels)
    : new Set();
  if (
    typeof execute !== "function" ||
    workspaceLabels?.length !== 4 ||
    selectedLabels.size !== 4 ||
    workspaceLabels.some((label) => !labelPattern.test(label)) ||
    !labelPattern.test(deniedWorkspaceLabel ?? "") ||
    selectedLabels.has(deniedWorkspaceLabel)
  ) {
    throw new TypeError("packaged-workspace-invalid");
  }
  await runWorkspaceStep(execute, { action: "probe-start" });
  await runWorkspaceProjection(execute, {
    action: "open-canvas",
    observation: "probe-canvas",
  });
  await runWorkspaceStep(execute, { action: "open-workspace-picker" });
  await runWorkspaceProjection(execute, {
    action: "cancel-workspace-picker",
    observation: "observe-workspace-cancelled",
  });
  await runWorkspaceStep(execute, { action: "open-workspace-picker" });
  await runWorkspaceProjection(execute, {
    action: "select-workspace",
    input: deniedWorkspaceLabel,
    observation: "observe-workspace-permission-denied",
  });
  const selections = await measureWorkspaceSelections(execute, workspaceLabels);
  await runWorkspaceStep(execute, { action: "quit" });
  return {
    workspaceProjectionMeasurements: selections.map(
      ({ projectedMs, sample }) => ({ projectedMs, sample }),
    ),
    workspaceProjectionP95Ms: percentile95(
      selections.map(({ projectedMs }) => projectedMs),
    ),
    workspaceSelectionNativeActionMeasurements: selections.map(
      ({ nativeActionMs, sample }) => ({ nativeActionMs, sample }),
    ),
  };
}

export async function runPackagedTracerJourney({
  crashRuntime,
  deniedWorkspaceLabel,
  execute,
  inspectWindowDisplayBinding,
  monotonicNow = () => performance.now(),
  observeRuntime,
  prompt,
  workspaceLabel,
}) {
  const labelPattern = /^KeikoAcceptanceIdentity104[A-Za-z0-9]+$/u;
  const promptBytes =
    typeof prompt === "string" ? Buffer.byteLength(prompt, "utf8") : 0;
  if (
    typeof crashRuntime !== "function" ||
    typeof execute !== "function" ||
    typeof inspectWindowDisplayBinding !== "function" ||
    typeof observeRuntime !== "function" ||
    !labelPattern.test(workspaceLabel ?? "") ||
    !labelPattern.test(deniedWorkspaceLabel ?? "") ||
    workspaceLabel === deniedWorkspaceLabel ||
    promptBytes < 1 ||
    promptBytes > 4_096 ||
    sha256(prompt) !== acceptedPromptSha256
  ) {
    throw new TypeError("packaged-journey-invalid");
  }
  const timings = [];
  const localProjectionMeasurements = [];
  const step = async (action, input, timeoutMs = 5_000, observation) => {
    const result = await execute({ action, input, observation, timeoutMs });
    if (
      result?.status !== "passed" ||
      result.reasonCode !== null ||
      result.prompted !== false ||
      !Number.isSafeInteger(result.elapsedMs) ||
      result.elapsedMs < 0 ||
      result.elapsedMs > timeoutMs
    ) {
      throw new Error("packaged-journey-checkpoint-failed");
    }
    timings.push({ action, elapsedMs: result.elapsedMs });
    return result;
  };
  const project = async (action, observation, input, timeoutMs = 5_000) => {
    const projected = await step(action, input, timeoutMs, observation);
    const elapsedMs = projected.projectedMs;
    if (
      !Number.isSafeInteger(elapsedMs) ||
      elapsedMs < 0 ||
      elapsedMs > 5_000
    ) {
      throw new Error("packaged-journey-measurement-invalid");
    }
    timings.push({ action: observation, elapsedMs });
    return projected;
  };
  const recordLocalProjection = async (
    action,
    observation,
    input,
    timeoutMs = 5_000,
  ) => {
    const projected = await project(action, observation, input, timeoutMs);
    localProjectionMeasurements.push({
      action,
      observation,
      projectedMs: projected.projectedMs,
    });
    return projected;
  };

  await step("probe-start");
  const windowDisplayBinding = await inspectWindowDisplayBinding();
  if (
    !["internal", "external"].includes(windowDisplayBinding?.displayClass) ||
    typeof windowDisplayBinding?.displayIdentity !== "string" ||
    windowDisplayBinding.displayIdentity.length === 0 ||
    windowDisplayBinding?.matchedDisplayCount !== 1 ||
    windowDisplayBinding?.semanticWindowCount !== 1 ||
    typeof windowDisplayBinding?.windowIdentity !== "string" ||
    windowDisplayBinding.windowIdentity.length === 0 ||
    typeof windowDisplayBinding?.windowPosition !== "string" ||
    windowDisplayBinding.windowPosition.length === 0 ||
    JSON.stringify(Object.keys(windowDisplayBinding).toSorted()) !==
      JSON.stringify([
        "displayClass",
        "displayIdentity",
        "matchedDisplayCount",
        "semanticWindowCount",
        "windowIdentity",
        "windowPosition",
      ])
  ) {
    throw new Error("packaged-journey-window-display-binding-invalid");
  }
  await recordLocalProjection("open-canvas", "probe-canvas");

  await step("open-workspace-picker");
  const nativePickerCancellationProjectionMs = (
    await project("cancel-workspace-picker", "observe-workspace-cancelled")
  ).projectedMs;

  await step("open-workspace-picker");
  await recordLocalProjection(
    "select-workspace",
    "observe-workspace-permission-denied",
    deniedWorkspaceLabel,
  );

  await step("open-workspace-picker");
  const workspaceSelection = await recordLocalProjection(
    "select-workspace",
    "observe-workspace-selected",
    workspaceLabel,
    successfulWorkspaceInvocationTimeoutMs,
  );
  if (
    !Number.isSafeInteger(workspaceSelection.nativeActionMs) ||
    workspaceSelection.nativeActionMs < 0 ||
    workspaceSelection.nativeActionMs > 5_000
  ) {
    throw new Error("packaged-journey-measurement-invalid");
  }

  await step("check-runtime");
  await step("observe-runtime-ready");
  await step("focus-task");
  await step("set-unicode");

  await step("set-task", prompt);
  const turnStartedAt = monotonicNow();
  await step("submit-task");
  await step("observe-streaming", undefined, 120_000);
  await observeRuntime();
  await step("observe-completed", undefined, 120_000);
  const turnDurationMs = Math.round(monotonicNow() - turnStartedAt);
  await step("observe-response-semantics");

  await step("focus-task");
  await step("set-task", prompt);
  await step("submit-task");
  await step("observe-streaming", undefined, 120_000);
  await observeRuntime();
  const cancellationStartedAt = monotonicNow();
  const turnCancellationProjectionMs = (
    await recordLocalProjection("cancel-turn", "observe-stopping")
  ).projectedMs;
  const cancellationProjectionObservedAt = monotonicNow();
  const stoppingElapsedMs = turnCancellationProjectionMs;
  const cancellationElapsedBeforeTerminalMs =
    Math.max(cancellationProjectionObservedAt, monotonicNow()) -
    cancellationStartedAt;
  if (
    !Number.isFinite(cancellationElapsedBeforeTerminalMs) ||
    cancellationElapsedBeforeTerminalMs < 0 ||
    cancellationElapsedBeforeTerminalMs > 5_000
  )
    throw new Error("packaged-journey-measurement-invalid");
  const cancellationRemainingMs = Math.max(
    1,
    Math.ceil(5_000 - cancellationElapsedBeforeTerminalMs),
  );
  await step("observe-cancelled", undefined, cancellationRemainingMs);
  const cancellationTerminalElapsed = monotonicNow() - cancellationStartedAt;
  const cancellationTerminalElapsedMs = Math.round(cancellationTerminalElapsed);
  if (
    !Number.isFinite(cancellationTerminalElapsed) ||
    cancellationTerminalElapsed < 0 ||
    cancellationTerminalElapsed > 5_000 ||
    !Number.isSafeInteger(cancellationTerminalElapsedMs) ||
    cancellationTerminalElapsedMs < 0
  )
    throw new Error("packaged-journey-measurement-invalid");
  const cancellationWindowDisplayBinding = await inspectWindowDisplayBinding();
  if (
    JSON.stringify(cancellationWindowDisplayBinding) !==
    JSON.stringify(windowDisplayBinding)
  ) {
    throw new Error("packaged-journey-window-display-binding-changed");
  }
  const turnCancellationTerminal = {
    boundary: "cancel-action-start-to-terminal",
    elapsedMs: cancellationTerminalElapsedMs,
    stoppingElapsedMs,
    terminalState: "cancelled",
  };
  if (
    turnCancellationTerminal.stoppingElapsedMs > 100 ||
    turnCancellationTerminal.stoppingElapsedMs >
      turnCancellationTerminal.elapsedMs ||
    turnCancellationTerminal.elapsedMs > 5_000
  )
    throw new Error("packaged-journey-measurement-invalid");

  await step("focus-task");
  await step("set-task", prompt);
  await step("submit-task");
  await step("observe-streaming", undefined, 120_000);
  await observeRuntime();
  await crashRuntime();
  await step("observe-failed");
  await step("check-runtime");
  await step("observe-runtime-ready");
  await step("quit");

  return {
    localProjectionMeasurements,
    localProjectionP95Ms: percentile95(
      localProjectionMeasurements.map(({ projectedMs }) => projectedMs),
    ),
    localProjectionSamples: localProjectionMeasurements.length,
    nativePickerCancellationProjectionMs,
    status: "passed",
    repositoryContextBytesToRuntime: 0,
    timings,
    turnCancellationProjectionMs,
    turnCancellationTerminal,
    turnDurationMs,
    workspaceSelectionNativeActionMs: workspaceSelection.nativeActionMs,
    windowDisplayBinding: {
      displayClass: windowDisplayBinding.displayClass,
      matchedDisplayCount: windowDisplayBinding.matchedDisplayCount,
      semanticWindowCount: windowDisplayBinding.semanticWindowCount,
    },
  };
}

export async function compileTracerAccessibility(
  root,
  runCompiler = (command, args, options) =>
    spawnSync(command, args, {
      ...options,
      timeout: options.timeoutMs,
    }),
) {
  await mkdir(root, { recursive: true });
  const source = join(root, "KeikoTracerAX.m");
  const binary = join(root, "KeikoTracerAX");
  await writeFile(source, tracerAccessibilitySource, {
    encoding: "utf8",
    mode: 0o600,
  });
  const result = await runCompiler(
    "/usr/bin/xcrun",
    [
      "clang",
      "-fobjc-arc",
      "-framework",
      "ApplicationServices",
      "-framework",
      "AppKit",
      "-framework",
      "Foundation",
      source,
      "-o",
      binary,
    ],
    { encoding: "utf8", shell: false, timeoutMs: 10_000 },
  );
  if (result.status !== 0 || result.error)
    throw new Error("adapter-compile-failed");
  await chmod(binary, 0o700);
  const bytes = await readFile(binary);
  return {
    binary,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    status: "compiled",
  };
}
