import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  tracerAccessibilityActions,
  tracerAccessibilitySource,
} from "./codex-tracer-accessibility-source.mjs";

const reasonCodes = new Set([
  "accessibility-permission-denied",
  "adapter-output-invalid",
  "bounded-wait-expired",
  "invalid-invocation",
  "missing-or-ambiguous-semantic-target",
]);
const acceptedPromptSha256 =
  "e1a92579b1ca673135331829beb97792c1289a6bccdfe0303302256c546960f6";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function classifyTracerAccessibilityResult({
  exitCode,
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
      JSON.stringify(Object.keys(parsed).toSorted()) !==
        JSON.stringify(["prompted", "reasonCode", "status"]) ||
      parsed.prompted !== false
    ) {
      return failed("adapter-output-invalid");
    }
    if (
      exitCode === 0 &&
      parsed.status === "passed" &&
      parsed.reasonCode === null
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
  pid,
  run = spawnSync,
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
  if (
    typeof binary !== "string" ||
    binary.length === 0 ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !tracerAccessibilityActions.includes(action) ||
    (action === "set-task" || action === "select-workspace"
      ? !taskInputValid && !workspaceInputValid
      : input !== undefined)
  ) {
    throw new TypeError("adapter-action-invalid");
  }
  const result = run(binary, [String(pid), action], {
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024,
    shell: false,
    timeout: 2_000,
  });
  return classifyTracerAccessibilityResult({
    exitCode: result.status,
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
    const result = execute({ action, binary, input, pid });
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

export async function runPackagedTracerJourney({
  crashRuntime,
  deniedWorkspaceLabel,
  execute,
  monotonicNow = () => performance.now(),
  prompt,
  workspaceLabel,
}) {
  const labelPattern = /^KeikoAcceptanceIdentity104[A-Za-z0-9]+$/u;
  const promptBytes =
    typeof prompt === "string" ? Buffer.byteLength(prompt, "utf8") : 0;
  if (
    typeof crashRuntime !== "function" ||
    typeof execute !== "function" ||
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
  const step = async (action, input, timeoutMs = 5_000) => {
    const result = await execute({ action, input, timeoutMs });
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
  const project = async (action, observation, input) => {
    const startedAt = monotonicNow();
    await step(action, input);
    await step(observation);
    const elapsedMs = Math.round(monotonicNow() - startedAt);
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0)
      throw new Error("packaged-journey-measurement-invalid");
    localProjectionMeasurements.push(elapsedMs);
    return elapsedMs;
  };

  await step("probe-welcome");
  await project("open-foundation", "probe-canvas");

  await step("open-workspace-picker");
  await project("cancel-workspace-picker", "observe-workspace-cancelled");

  await step("open-workspace-picker");
  await project(
    "select-workspace",
    "observe-workspace-permission-denied",
    deniedWorkspaceLabel,
  );

  await step("open-workspace-picker");
  await project(
    "select-workspace",
    "observe-workspace-selected",
    workspaceLabel,
  );

  await step("check-runtime");
  await step("observe-runtime-ready");
  await step("focus-task");
  await step("set-unicode");

  await step("set-task", prompt);
  const turnStartedAt = monotonicNow();
  await step("submit-task");
  await step("observe-streaming", undefined, 120_000);
  await step("observe-completed", undefined, 120_000);
  const turnDurationMs = Math.round(monotonicNow() - turnStartedAt);
  await step("observe-response-semantics");

  await step("focus-task");
  await step("set-task", prompt);
  await step("submit-task");
  await step("observe-streaming", undefined, 120_000);
  const cancellationProjectionMs = await project(
    "cancel-turn",
    "observe-stopping",
  );
  await step("observe-cancelled");

  await step("focus-task");
  await step("set-task", prompt);
  await step("submit-task");
  await step("observe-streaming", undefined, 120_000);
  await crashRuntime();
  await step("observe-failed");
  await step("check-runtime");
  await step("observe-runtime-ready");
  await step("quit");

  return {
    cancellationProjectionMs,
    localProjectionP95Ms: percentile95(localProjectionMeasurements),
    localProjectionSamples: localProjectionMeasurements.length,
    status: "passed",
    timings,
    turnDurationMs,
  };
}

export async function compileTracerAccessibility(root) {
  await mkdir(root, { recursive: true });
  const source = join(root, "KeikoTracerAX.m");
  const binary = join(root, "KeikoTracerAX");
  await writeFile(source, tracerAccessibilitySource, {
    encoding: "utf8",
    mode: 0o600,
  });
  const result = spawnSync(
    "/usr/bin/xcrun",
    [
      "clang",
      "-fobjc-arc",
      "-framework",
      "ApplicationServices",
      "-framework",
      "Foundation",
      source,
      "-o",
      binary,
    ],
    { encoding: "utf8", shell: false },
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
