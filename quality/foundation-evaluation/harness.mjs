import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  mkdtempSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const CANDIDATES = ["tauri", "slint"];
export const FULL_COUNTS = { cold: 20, warm: 30 };
export const QUICK_COUNTS = { cold: 1, warm: 1 };
export const MAX_STDOUT_BYTES = 65_536;
export const MAX_EVIDENCE_BYTES = 16_384;
const MAX_PACKAGE_FILES = 8_192;
const RUN_TIMEOUT_MS = 30_000;
const SHUTDOWN_BUDGET_MS = 5_000;
const SESSION_HELPER_SOURCE_SHA256 =
  "d37babdcf3cd0c7358cf99f015abcbc89b42246cceb48c0a44bd74f26e1c2a4c";
const EVIDENCE_SCHEMA_VERSION = 2;
const RETAINED_FIXTURE_KEYS = [
  "accepted",
  "descendantAbsent",
  "escalated",
  "execChanged",
  "groupAbsent",
  "parentReaped",
  "runnerConfirmedDescendantAbsent",
  "runnerObservedDifferentExecutable",
  "runnerObservedMarker",
  "runnerObservedNewProcessGroup",
  "runnerObservedNewSession",
  "sessionIsolated",
];
const ISSUE_READINESS_FINGERPRINT =
  "ee7934be0bfcc74630bfb071ec05c724ed97a2458d4b9238d60561292cc06469";
const HARNESS_FILES = [
  ".github/workflows/foundation-evaluation.yml",
  "package.json",
  "quality/contract.mjs",
  "quality/project.json",
  "quality/foundation-evaluation/cli.mjs",
  "quality/foundation-evaluation/harness.mjs",
  "quality/foundation-evaluation/session-observer.rs",
  "quality/foundation-evaluation.test.mjs",
];
const RELEASE_HOOK_MARKERS = [
  "KEIKO_PRESENTED",
  "KEIKO_EVIDENCE:",
  "KEIKO_SHUTDOWN_START",
  "KEIKO_DIAGNOSTIC_",
  "--evaluation-json",
  "evaluation-hook",
  "evaluation_json",
  "foundation-evaluation",
  "foundation_evaluation",
  "evaluation_dispatch",
  "allow-evaluation-dispatch",
  "renderer-probe-first",
  "system-testing",
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const failureCategories = [
  ["prepared session helper contract", "session_observer_prepared"],
  ["prepared session helper digest", "session_observer_prepared"],
  ["prepared session helper executable", "session_observer_prepared"],
  ["prepared session helper path", "session_observer_prepared"],
  ["prepared session helper root", "session_observer_prepared"],
  ["session helper rustc version", "session_observer_version"],
  ["session helper source binding", "session_observer_source"],
  ["session helper build", "session_observer_build"],
  ["session helper executable", "session_observer_executable"],
  ["session helper observation", "session_observer_observation"],
  ["already has a running candidate", "preexisting_process"],
  ["direct executable did not start", "launch_failed"],
  ["did not start the exact candidate", "launch_failed"],
  ["spawn", "launch_failed"],
  ["wrapper exited unsuccessfully", "launch_failed"],
  ["exceeded its bound", "output_bound"],
  ["hard timeout", "timeout"],
  ["shutdown budget", "shutdown_timeout"],
  ["fixture observation is incomplete", "fixture_observation"],
  ["retained identity string contract mismatch", "identity_contract"],
  ["client diagnostics failed", "client_diagnostics"],
  ["architecture mismatch", "environment_mismatch"],
  ["rss comparability", "process_accounting"],
  ["candidate process-group", "process_ownership"],
  ["pgrep candidate observation", "process_ownership"],
  ["process-tree observation", "process_ownership"],
  ["marker sequence", "marker_sequence"],
  ["preceded", "marker_sequence"],
  ["duplicate", "marker_sequence"],
  ["evidence", "evidence_schema"],
  ["journey", "evidence_schema"],
  ["diagnostic", "evidence_schema"],
  ["process group", "process_ownership"],
  ["survived cleanup", "cleanup_failed"],
  ["truncated", "invalid_output"],
  ["incomplete line", "invalid_output"],
  ["unexpected candidate stdout", "invalid_output"],
];
const failureStages = new Set([
  "checkout",
  "configuration",
  "environment",
  "harness",
  "provenance",
  "session-observer",
]);
const candidateFailureDiagnostics = new Set([
  "frontend-accessibility",
  "frontend-bounded-work",
  "frontend-finish",
  "frontend-fixture-process",
  "frontend-native-dialog",
  "frontend-prepare-renderer",
  "frontend-renderer-cycle",
  "frontend-replay-protection",
  "frontend-request-validation",
  "frontend-runtime-event",
  "frontend-stable-shell",
  "frontend-startup",
  "frontend-synthetic-input",
  "host-evidence-invalid",
  "host-watchdog-accessibility",
  "host-watchdog-bounded-work",
  "host-watchdog-evaluation-failed",
  "host-watchdog-finish",
  "host-watchdog-fixture-process",
  "host-watchdog-idle",
  "host-watchdog-native-dialog",
  "host-watchdog-ping",
  "host-watchdog-prepare-renderer",
  "host-watchdog-renderer-cycle",
  "host-watchdog-runtime-event",
  "host-watchdog-runtime-event-committed",
  "host-watchdog-stable-shell",
  "host-watchdog-startup",
]);

export function closedCandidateDiagnostic(stderr) {
  if (!Buffer.isBuffer(stderr)) return "unavailable";
  const matches = [
    ...stderr
      .toString("utf8")
      .matchAll(/^KEIKO_DIAGNOSTIC_FAILURE:([a-z-]+)\r?$/gmu),
  ]
    .map((match) => match[1])
    .filter((value) => candidateFailureDiagnostics.has(value));
  return matches.length === 1 ? matches[0] : "unavailable";
}

export function candidateOutputSnapshot(stdout, stderr, previousStdoutBytes) {
  invariant(Buffer.isBuffer(stdout), "candidate stdout snapshot is invalid");
  invariant(Buffer.isBuffer(stderr), "candidate stderr snapshot is invalid");
  invariant(
    Number.isSafeInteger(previousStdoutBytes) && previousStdoutBytes >= 0,
    "candidate stdout offset is invalid",
  );
  const truncated = stdout.length < previousStdoutBytes;
  return {
    candidateDiagnostic: closedCandidateDiagnostic(stderr),
    stderrBytes: stderr.length,
    stdoutBytes: truncated ? previousStdoutBytes : stdout.length,
    stdoutDelta: truncated
      ? Buffer.alloc(0)
      : stdout.subarray(previousStdoutBytes),
    truncated,
  };
}

function closedCandidateCode(evidence) {
  const candidates = [
    evidence?.journey?.finish?.code,
    evidence?.journey?.rendererCycle?.portResponse?.code,
    evidence?.journey?.nativeDialog?.code,
    evidence?.journey?.rendererCycle,
    evidence?.journey?.nativeDialog,
  ];
  const code = candidates.find(
    (value) =>
      typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value),
  );
  return code ?? "unavailable";
}

function closedStatus(condition, present) {
  return !present ? "unavailable" : condition ? "accepted" : "rejected";
}

export function closedCandidateDiagnostics(evidence) {
  if (evidence?.candidate !== "slint-femtovg") return undefined;
  const client = evidence?.metrics?.client;
  if (client === null || typeof client !== "object" || Array.isArray(client))
    return {
      appearance: "unavailable",
      composition: "unavailable",
      focus: "unavailable",
      input: "unavailable",
      scale: "unavailable",
    };
  const has = (key) => Object.hasOwn(client, key);
  return {
    appearance: closedStatus(
      client.darkAppearance === true,
      has("darkAppearance"),
    ),
    composition: closedStatus(client.imeValue === "かなa", has("imeValue")),
    focus: closedStatus(client.focusVisible === true, has("focusVisible")),
    input: closedStatus(
      typeof client.inputToPaintMs === "number" &&
        Number.isFinite(client.inputToPaintMs) &&
        client.inputToPaintMs >= 0 &&
        client.inputToPaintMs <= 10_000,
      has("inputToPaintMs"),
    ),
    scale: closedStatus(
      typeof client.scaleFactor === "number" &&
        Number.isFinite(client.scaleFactor) &&
        client.scaleFactor >= 0.5 &&
        client.scaleFactor <= 8,
      has("scaleFactor"),
    ),
  };
}

export function sanitizedFailure(error, context = {}) {
  if (error?.foundationFailure !== undefined) return error.foundationFailure;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const category =
    failureCategories.find(([fragment]) => message.includes(fragment))?.[1] ??
    "unknown";
  const candidate = CANDIDATES.includes(context.candidate)
    ? context.candidate
    : "unavailable";
  const mode = ["cold", "warm"].includes(context.mode)
    ? context.mode
    : "unavailable";
  const failure = {
    app:
      context.appPid === undefined
        ? "missing"
        : context.appExitAt === undefined
          ? "running"
          : "exited",
    candidate,
    category,
    lastCandidateCode: closedCandidateCode(context.evidence),
    markers: {
      evidence: context.evidence === undefined ? "missing" : "seen",
      presented: context.presentedAt === undefined ? "missing" : "seen",
      shutdown: context.shutdownAt === undefined ? "missing" : "seen",
    },
    mode,
    sequence: Number.isSafeInteger(context.sequence) ? context.sequence : null,
    stderr:
      context.stderrBytes === undefined
        ? "unavailable"
        : context.stderrBytes === 0
          ? "empty"
          : context.stderrBytes <= MAX_STDOUT_BYTES
            ? "present"
            : "oversized",
    wrapper:
      context.wrapperError !== undefined
        ? "failed"
        : context.wrapperExit !== undefined
          ? "exited"
          : context.wrapperStarted === true
            ? "running"
            : "missing",
  };
  const candidateDiagnostics = closedCandidateDiagnostics(context.evidence);
  if (candidateDiagnostics !== undefined)
    failure.diagnostics = candidateDiagnostics;
  if (candidateFailureDiagnostics.has(context.candidateDiagnostic))
    failure.diagnostic = context.candidateDiagnostic;
  if (failureStages.has(context.stage)) failure.stage = context.stage;
  return failure;
}

function failureError(error, context) {
  const failure = sanitizedFailure(error, context);
  const wrapped = new Error("foundation evaluation failed");
  wrapped.foundationFailure = failure;
  return wrapped;
}

function stageFailure(error, stage) {
  if (error?.foundationFailure !== undefined) return error;
  return failureError(error, { stage });
}

async function atEvaluationStage(stage, work) {
  try {
    return await work();
  } catch (error) {
    throw stageFailure(error, stage);
  }
}

function normalizedPath(path) {
  return path.split(sep).join("/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedString(value, label, maximum = 256) {
  invariant(typeof value === "string", `${label} must be a string`);
  invariant(
    value.length > 0 && value.length <= maximum,
    `${label} is out of bounds`,
  );
  return value;
}

function finiteMetric(value, label) {
  invariant(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    `${label} is invalid`,
  );
  return value;
}

function plainObject(value, label) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function execText(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
  invariant(
    result.status === 0,
    `environment observation failed: ${basename(command)}`,
  );
  return result.stdout.trim();
}

const DEFAULT_GENERATED_ROOTS = [
  ".foundation-evaluation",
  "node_modules",
  "experiments/tauri-renderer/frontend",
  "experiments/tauri-renderer/frontend-evaluation",
  "experiments/tauri-renderer/gen",
  "experiments/tauri-renderer/target",
  "experiments/tauri-renderer/web/node_modules",
  "experiments/slint-renderer/target",
];

function gitResult(root, args) {
  return spawnSync("/usr/bin/git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
}

export async function governedCheckout(
  root,
  { allowedGeneratedRoots = DEFAULT_GENERATED_ROOTS } = {},
) {
  const absolute = resolve(root);
  invariant(
    !(await lstat(absolute)).isSymbolicLink(),
    "checkout root must not be a symlink",
  );
  const topLevel = gitResult(absolute, ["rev-parse", "--show-toplevel"]);
  invariant(topLevel.status === 0, "governed checkout is not a git worktree");
  invariant(
    (await realpath(resolve(topLevel.stdout.trim()))) ===
      (await realpath(absolute)),
    "governed checkout root mismatch",
  );
  invariant(
    allowedGeneratedRoots.every(
      (path) =>
        typeof path === "string" &&
        path.length > 0 &&
        !path.startsWith("/") &&
        !path.split("/").includes(".."),
    ),
    "generated-root declaration is invalid",
  );
  const drift = gitResult(absolute, ["diff", "--quiet", "HEAD", "--"]);
  invariant(drift.status === 0, "governed checkout has tracked or index drift");
  const untracked = gitResult(absolute, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ".",
    ...allowedGeneratedRoots.map((path) => `:(exclude,top,literal)${path}`),
  ]);
  invariant(untracked.status === 0, "untracked-input discovery failed");
  const unapproved = untracked.stdout
    .split("\0")
    .filter(Boolean)
    .filter(
      (path) =>
        !allowedGeneratedRoots.some(
          (allowed) => path === allowed || path.startsWith(`${allowed}/`),
        ),
    );
  invariant(
    unapproved.length === 0,
    "governed checkout has unapproved untracked input",
  );
  const commit = gitResult(absolute, ["rev-parse", "HEAD"]);
  const tree = gitResult(absolute, ["rev-parse", "HEAD^{tree}"]);
  invariant(
    commit.status === 0 &&
      tree.status === 0 &&
      /^[0-9a-f]{40}$/u.test(commit.stdout.trim()) &&
      /^[0-9a-f]{40}$/u.test(tree.stdout.trim()),
    "governed checkout identity is invalid",
  );
  return { commit: commit.stdout.trim(), tree: tree.stdout.trim() };
}

export function buildSchedule(counts = FULL_COUNTS) {
  invariant(
    counts.cold > 0 && counts.warm > 0,
    "sample counts must be positive",
  );
  const schedule = [];
  let sequence = 0;
  for (const mode of ["cold", "warm"]) {
    for (let iteration = 0; iteration < counts[mode]; iteration += 1) {
      const order = iteration % 2 === 0 ? CANDIDATES : CANDIDATES.toReversed();
      for (const candidate of order) {
        schedule.push({ candidate, iteration, mode, sequence });
        sequence += 1;
      }
    }
  }
  return schedule;
}

export function percentile(values, percentileValue) {
  invariant(values.length > 0, "a distribution cannot be empty");
  invariant(
    percentileValue > 0 && percentileValue <= 1,
    "percentile is invalid",
  );
  const ordered = values.toSorted((left, right) => left - right);
  return ordered[Math.ceil(percentileValue * ordered.length) - 1];
}

export function distribution(values) {
  for (const value of values) finiteMetric(value, "distribution value");
  const ordered = values.toSorted((left, right) => left - right);
  return {
    count: ordered.length,
    max: ordered.at(-1),
    mean: ordered.reduce((sum, value) => sum + value, 0) / ordered.length,
    min: ordered[0],
    p50: percentile(ordered, 0.5),
    p75: percentile(ordered, 0.75),
    p95: percentile(ordered, 0.95),
  };
}

export function redactionFailures(value, observation = {}) {
  const serialized = JSON.stringify(value);
  const retainedStrings = [];
  const collectStrings = (entry) => {
    if (typeof entry === "string") retainedStrings.push(entry);
    else if (Array.isArray(entry)) entry.forEach(collectStrings);
    else if (entry !== null && typeof entry === "object")
      Object.values(entry).forEach(collectStrings);
  };
  collectStrings(value);
  const forbidden = [
    observation.home,
    observation.hostname,
    observation.username,
  ].filter((entry) => typeof entry === "string" && entry.length >= 3);
  const failures = [];
  if (/\/Users\/|file:\/\/|[A-Za-z]:\\/u.test(serialized))
    failures.push("raw path");
  if (
    /"(?:hostname|username|home|rawPath|secret|password|credential)"\s*:/iu.test(
      serialized,
    )
  )
    failures.push("forbidden field");
  if (forbidden.some((entry) => serialized.includes(entry)))
    failures.push("local identity");
  if (
    retainedStrings.some((entry) => {
      const trimmed = entry.trim();
      return (
        /^\/(?:[^/\0]+\/?)+/u.test(trimmed) ||
        /^[A-Za-z]:[\\/]/u.test(trimmed) ||
        /^\\\\[^\\]+\\/u.test(trimmed)
      );
    })
  )
    failures.push("absolute path");
  if (
    retainedStrings.some((entry) =>
      /(?:^|\s)[a-z][a-z0-9+.-]*:\/\/\S+/iu.test(entry),
    )
  )
    failures.push("URI or endpoint");
  if (
    retainedStrings.some(
      (entry) =>
        /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/u.test(entry) ||
        /\b[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-5][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}\b/u.test(
          entry,
        ),
    )
  )
    failures.push("endpoint or stable identifier");
  return failures;
}

function validateTree(value, depth = 0) {
  invariant(depth <= 8, "candidate evidence is too deeply nested");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    invariant(
      Number.isFinite(value),
      "candidate evidence contains a non-finite number",
    );
    return;
  }
  if (typeof value === "string") {
    invariant(value.length <= 512, "candidate evidence string is too large");
    return;
  }
  if (Array.isArray(value)) {
    invariant(value.length <= 128, "candidate evidence array is too large");
    for (const entry of value) validateTree(entry, depth + 1);
    return;
  }
  plainObject(value, "candidate evidence value");
  const entries = Object.entries(value);
  invariant(entries.length <= 128, "candidate evidence object is too large");
  for (const [key, entry] of entries) {
    invariant(
      /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(key),
      "candidate evidence key is invalid",
    );
    validateTree(entry, depth + 1);
  }
}

function replyHas(value, code, ok) {
  const reply = plainObject(value, "journey reply");
  return reply.code === code && reply.ok === ok;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  return value;
}

function sameJsonValue(left, right) {
  return (
    JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
  );
}

function validateTauriJourney(evidence) {
  const journey = evidence.journey;
  const codes = {
    accessibility: "accepted",
    cancelledWork: "cancelled",
    fixtureProcess: "accepted",
    nativeDialog: "accepted",
    oversized: "payload_too_large",
    ping: "accepted",
    prepareRenderer: "accepted",
    rendererCycle: "accepted",
    replay: "replayed_request",
    runtimeEvent: "accepted",
    runtimeEventCommitted: "accepted",
    stableShell: "accepted",
    timedOutWork: "timed_out",
  };
  for (const [field, code] of Object.entries(codes))
    invariant(journey[field] === code, `Tauri journey failed: ${field}`);
  for (const field of [
    "fixtureDescendantAbsent",
    "fixtureEscalated",
    "fixtureExecChanged",
    "fixtureGroupAbsent",
    "fixtureParentReaped",
    "fixtureSessionIsolated",
    "hostSurvived",
    "probeAclDenied",
    "rendererRecreated",
  ])
    invariant(journey[field] === true, `Tauri journey failed: ${field}`);
  invariant(
    journey.invalidRequestCount >= 2 &&
      journey.axeViolationCount === 0 &&
      Array.isArray(journey.axeRuleIds) &&
      journey.axeRuleIds.length === 0 &&
      journey.firstInstanceId !== journey.secondInstanceId,
    "Tauri negative or accessibility journey is incomplete",
  );
  const diagnostics = evidence.diagnostics;
  invariant(
    diagnostics.appearanceDiagnostic === true &&
      diagnostics.compositionDiagnostic === true &&
      diagnostics.focusDiagnostic === true &&
      finiteMetric(diagnostics.scaleFactorDiagnostic, "Tauri scale") > 0,
    "Tauri client diagnostics failed",
  );
}

function validateSlintJourney(evidence) {
  const journey = evidence.journey;
  for (const field of ["accepted", "finish", "nativeDialog"])
    invariant(
      replyHas(journey[field], "accepted", true),
      `Slint journey failed: ${field}`,
    );
  invariant(
    replyHas(journey.fixture, "accepted", true) &&
      journey.fixture.escalated === true &&
      journey.fixture.parentReaped === true &&
      journey.fixture.groupAbsent === true &&
      journey.fixture.sessionIsolated === true &&
      journey.fixture.execChanged === true &&
      journey.fixture.descendantAbsent === true,
    "Slint fixture cleanup journey failed",
  );
  invariant(
    replyHas(journey.recoveredResponse, "accepted", true),
    "Slint renderer recovery failed",
  );
  invariant(
    replyHas(journey.unavailableResponse, "renderer_unavailable", false),
    "Slint renderer unavailability path failed",
  );
  const cycle = plainObject(journey.rendererCycle, "Slint renderer cycle");
  invariant(
    cycle.ok === true &&
      cycle.firstLoaded === true &&
      cycle.firstDestroyed === true &&
      cycle.secondLoaded === true &&
      cycle.secondDestroyed === true &&
      cycle.hostSurvived === true &&
      cycle.firstInstanceId !== cycle.secondInstanceId &&
      replyHas(cycle.portResponse, "accepted", true),
    "Slint renderer cycle failed",
  );
  const negatives = plainObject(journey.negatives, "Slint negatives");
  for (const [field, code] of Object.entries({
    cancelled: "cancelled",
    hostile: "invalid_request",
    oversized: "payload_too_large",
    replay: "replayed_request",
    timeout: "timed_out",
    unknown: "invalid_request",
  }))
    invariant(
      replyHas(negatives[field], code, false),
      `Slint negative journey failed: ${field}`,
    );
  const client = evidence.metrics.client;
  invariant(
    client.darkAppearance === true &&
      client.focusVisible === true &&
      client.imeValue === "かなa" &&
      finiteMetric(client.scaleFactor, "Slint scale") > 0,
    "Slint client diagnostics failed",
  );
}

function normalizedHardGates(evidence, candidate) {
  if (candidate === "tauri") return {};
  const gates = plainObject(evidence.hardGates, "Slint hard gates");
  const expected = [
    "nativeSemanticTreeAutomation",
    "royaltyFreeLicenceAttribution",
    "signedUpdateRecipe",
  ];
  invariant(
    JSON.stringify(Object.keys(gates).toSorted()) === JSON.stringify(expected),
    "Slint hard-gate schema mismatch",
  );
  return Object.fromEntries(
    expected.map((name) => {
      const gate = plainObject(gates[name], `Slint hard gate ${name}`);
      boundedString(gate.code, `Slint hard gate ${name} code`, 128);
      invariant(
        typeof gate.passed === "boolean",
        `Slint hard gate ${name} result is invalid`,
      );
      if (gate.limitation !== undefined)
        boundedString(
          gate.limitation,
          `Slint hard gate ${name} limitation`,
          256,
        );
      return [
        name,
        {
          code: gate.code,
          ...(gate.limitation === undefined
            ? {}
            : { limitation: gate.limitation }),
          passed: gate.passed,
        },
      ];
    }),
  );
}

const candidateIdentityStrings = {
  tauri: {
    dependencies: {
      frontend: "react-19.2.7-typescript-5.9.3-vite-7.3.6-axe-core-4.12.1",
      host: "tauri-2.11.5",
      renderer: "system-webview",
      rust: "1.92.0",
    },
    processAccounting: {
      definition: "root-process-and-observed-descendants",
      limitation:
        "shared-webkit-xpc-processes-are-not-consistently-attributable",
      rssComparableForWinGate: false,
    },
  },
  slint: {
    dependencies: {
      frontend: "slint-declarative-ui-1.17.1",
      host: "slint-winit-1.17.1",
      renderer: "slint-femtovg-1.17.1",
      rust: "1.92.0",
    },
    processAccounting: {
      definition: "root-process-only-after-fixture-cleanup",
      limitation:
        "cross-candidate-rss-is-invalid-because-tauri-webkit-xpc-processes-are-not-consistently-attributable",
      rssComparableForWinGate: false,
    },
    hardGates: {
      nativeSemanticTreeAutomation: {
        code: "automated_native_semantic_tree_unavailable",
        limitation:
          "source-labels-and-manual-ax-observation-cannot-substitute-for-a-governed-machine-check",
        passed: false,
      },
      royaltyFreeLicenceAttribution: {
        code: "required-about-slint-widget-or-discoverable-badge-not-present-in-prototype",
        passed: false,
      },
      signedUpdateRecipe: {
        code: "no-slint-owned-integrated-signed-updater-recipe",
        passed: false,
      },
    },
  },
};

function validateCandidateIdentityStrings(evidence, candidate) {
  const expected = candidateIdentityStrings[candidate];
  invariant(
    sameJsonValue(evidence.dependencies, expected.dependencies) &&
      sameJsonValue(evidence.processAccounting, expected.processAccounting) &&
      (candidate === "tauri" ||
        sameJsonValue(evidence.hardGates, expected.hardGates)) &&
      evidence.environment.referenceClass === "owner-m4-16gib-macos26",
    `${candidate} retained identity string contract mismatch`,
  );
}

export function validateCandidateEvidence(value, expected) {
  const evidence = plainObject(value, "candidate evidence");
  validateTree(evidence);
  invariant(
    evidence.schemaVersion === 1,
    "candidate evidence schema is unsupported",
  );
  const candidateIdentity =
    expected.candidate === "tauri" ? "tauri-system-webview" : "slint-femtovg";
  invariant(
    evidence.candidate === candidateIdentity,
    "candidate evidence identity mismatch",
  );
  invariant(
    evidence.mode === expected.mode,
    "candidate evidence mode mismatch",
  );
  const environment = plainObject(
    evidence.environment,
    "candidate environment",
  );
  invariant(
    environment.osFamily === "macos",
    "candidate evidence is not macOS evidence",
  );
  invariant(
    ["aarch64", "arm64"].includes(environment.architecture),
    "candidate architecture mismatch",
  );
  const accounting = plainObject(
    evidence.processAccounting,
    "process accounting",
  );
  invariant(
    accounting.rssComparableForWinGate === false,
    "RSS comparability must fail closed",
  );
  boundedString(accounting.limitation, "RSS limitation", 256);
  plainObject(evidence.dependencies, "candidate dependencies");
  plainObject(evidence.journey, "candidate journey");
  validateCandidateIdentityStrings(evidence, expected.candidate);

  let inputToPaintMs;
  let runtimeToUiMs;
  let candidateRssBytes = null;
  if (expected.candidate === "tauri") {
    inputToPaintMs = finiteMetric(
      plainObject(evidence.diagnostics, "Tauri diagnostics").inputDiagnosticMs,
      "input-to-paint",
    );
    runtimeToUiMs = finiteMetric(
      evidence.journey.runtimeToUiMs,
      "runtime-to-UI",
    );
    validateTauriJourney(evidence);
  } else {
    const metrics = plainObject(evidence.metrics, "Slint metrics");
    const client = plainObject(metrics.client, "Slint client metrics");
    inputToPaintMs = finiteMetric(client.inputToPaintMs, "input-to-paint");
    runtimeToUiMs = finiteMetric(client.runtimeToUiMs, "runtime-to-UI");
    if (metrics.rssBytes !== null)
      candidateRssBytes = finiteMetric(metrics.rssBytes, "candidate RSS");
    validateSlintJourney(evidence);
  }
  invariant(
    redactionFailures(evidence, expected.observation).length === 0,
    "candidate evidence contains prohibited local data",
  );
  return {
    candidateHardGates: normalizedHardGates(evidence, expected.candidate),
    candidateRssBytes,
    inputToPaintMs,
    runtimeToUiMs,
  };
}

function accepted(value) {
  return value === "accepted" || replyHas(value, "accepted", true);
}

export function sanitizeCandidateEvidence(value, expected) {
  const evidence = plainObject(value, "candidate evidence");
  const metrics = validateCandidateEvidence(evidence, expected);
  const processAccounting = { ...evidence.processAccounting };
  const common = {
    candidate: expected.candidate,
    candidateHardGates: metrics.candidateHardGates,
    dependencies: {
      frontend: evidence.dependencies.frontend,
      host: evidence.dependencies.host,
      renderer: evidence.dependencies.renderer,
      rust: evidence.dependencies.rust,
    },
    environment: {
      architecture:
        expected.observation?.architecture ?? evidence.environment.architecture,
      osFamily: expected.observation?.osFamily ?? evidence.environment.osFamily,
      referenceClass:
        expected.observation?.referenceClass ??
        evidence.environment.referenceClass,
    },
    mode: expected.mode,
    performance: {
      candidateRssBytes: metrics.candidateRssBytes,
      inputToPaintMs: metrics.inputToPaintMs,
      runtimeToUiMs: metrics.runtimeToUiMs,
    },
    processAccounting,
    schemaVersion: 2,
  };
  if (expected.candidate === "tauri") {
    const { diagnostics, journey } = evidence;
    return {
      ...common,
      accessibility: {
        axeRuleIds: [],
        axeViolationCount: journey.axeViolationCount,
        semanticJourneyAccepted: accepted(journey.accessibility),
      },
      capabilities: {
        pingAccepted: accepted(journey.ping),
        rendererPrepared: accepted(journey.prepareRenderer),
        shellStable: accepted(journey.stableShell),
      },
      diagnostics: {
        appearanceAccepted: diagnostics.appearanceDiagnostic,
        compositionAccepted: diagnostics.compositionDiagnostic,
        focusAccepted: diagnostics.focusDiagnostic,
        scaleFactor: diagnostics.scaleFactorDiagnostic,
      },
      fixture: {
        accepted: accepted(journey.fixtureProcess),
        descendantAbsent: journey.fixtureDescendantAbsent,
        escalated: journey.fixtureEscalated,
        execChanged: journey.fixtureExecChanged,
        groupAbsent: journey.fixtureGroupAbsent,
        parentReaped: journey.fixtureParentReaped,
        sessionIsolated: journey.fixtureSessionIsolated,
        ...expected.runnerFixture,
      },
      lifecycle: {
        hostSurvived: journey.hostSurvived,
        instanceDistinct: journey.firstInstanceId !== journey.secondInstanceId,
        rendererCycleAccepted: accepted(journey.rendererCycle),
        rendererRecreated: journey.rendererRecreated,
      },
      nativeDialog: { accepted: accepted(journey.nativeDialog) },
      recovery: {
        runtimeEventAccepted: accepted(journey.runtimeEvent),
        runtimeEventCommitted: accepted(journey.runtimeEventCommitted),
      },
      security: {
        cancelled: journey.cancelledWork === "cancelled",
        invalidRequestCount: journey.invalidRequestCount,
        oversizedRejected: journey.oversized === "payload_too_large",
        probeAclDenied: journey.probeAclDenied,
        replayRejected: journey.replay === "replayed_request",
        timedOut: journey.timedOutWork === "timed_out",
      },
    };
  }
  const { client } = evidence.metrics;
  const { journey } = evidence;
  return {
    ...common,
    accessibility: {
      nativeSemanticTreeAutomation:
        metrics.candidateHardGates.nativeSemanticTreeAutomation,
    },
    capabilities: {
      accepted: accepted(journey.accepted),
      finishAccepted: accepted(journey.finish),
    },
    diagnostics: {
      appearanceAccepted: client.darkAppearance,
      compositionAccepted: client.imeValue === "かなa",
      focusAccepted: client.focusVisible,
      scaleFactor: client.scaleFactor,
    },
    fixture: {
      accepted: accepted(journey.fixture),
      descendantAbsent: journey.fixture.descendantAbsent,
      escalated: journey.fixture.escalated,
      execChanged: journey.fixture.execChanged,
      groupAbsent: journey.fixture.groupAbsent,
      parentReaped: journey.fixture.parentReaped,
      sessionIsolated: journey.fixture.sessionIsolated,
      ...expected.runnerFixture,
    },
    lifecycle: {
      firstDestroyed: journey.rendererCycle.firstDestroyed,
      firstLoaded: journey.rendererCycle.firstLoaded,
      hostSurvived: journey.rendererCycle.hostSurvived,
      instanceDistinct:
        journey.rendererCycle.firstInstanceId !==
        journey.rendererCycle.secondInstanceId,
      portAccepted: accepted(journey.rendererCycle.portResponse),
      secondDestroyed: journey.rendererCycle.secondDestroyed,
      secondLoaded: journey.rendererCycle.secondLoaded,
    },
    nativeDialog: { accepted: accepted(journey.nativeDialog) },
    recovery: {
      recovered: accepted(journey.recoveredResponse),
      unavailableFailedClosed: replyHas(
        journey.unavailableResponse,
        "renderer_unavailable",
        false,
      ),
    },
    security: Object.fromEntries(
      Object.entries({
        cancelled: "cancelled",
        hostile: "invalid_request",
        oversized: "payload_too_large",
        replay: "replayed_request",
        timeout: "timed_out",
        unknown: "invalid_request",
      }).map(([name, code]) => [
        name,
        replyHas(journey.negatives[name], code, false),
      ]),
    ),
  };
}

async function walk(root, directory = root, { excludeBuild = false } = {}) {
  const rows = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    if (entry.name === ".DS_Store") continue;
    if (
      excludeBuild &&
      [".tools", "node_modules", "target"].includes(entry.name)
    )
      continue;
    const path = join(directory, entry.name);
    const relativePath = normalizedPath(relative(root, path));
    const info = await lstat(path);
    if (info.isDirectory())
      rows.push(...(await walk(root, path, { excludeBuild })));
    else if (info.isSymbolicLink()) {
      const target = await readlink(path);
      const packageRoot = await realpath(root);
      const resolvedTarget = await realpath(resolve(dirname(path), target));
      invariant(
        resolvedTarget === packageRoot ||
          resolvedTarget.startsWith(`${packageRoot}${sep}`),
        "package symlink escapes its package",
      );
      rows.push({
        bytes: Buffer.byteLength(target),
        kind: "symlink",
        path: relativePath,
        sha256: sha256(target),
      });
    } else if (info.isFile()) {
      rows.push({
        bytes: info.size,
        kind: "file",
        path: relativePath,
        sha256: sha256(await readFile(path)),
      });
    }
  }
  return rows;
}

function inventoryDigest(rows) {
  return sha256(
    rows
      .map((row) => `${row.kind}\0${row.path}\0${row.bytes}\0${row.sha256}\n`)
      .join(""),
  );
}

export async function inventory(path, { source = false } = {}) {
  const absolute = resolve(path);
  invariant(
    !(await lstat(absolute)).isSymbolicLink(),
    "inventory root must not be a symlink",
  );
  const info = await stat(absolute);
  let rows;
  if (info.isDirectory())
    rows = await walk(absolute, absolute, { excludeBuild: source });
  else
    rows = [
      {
        bytes: info.size,
        kind: "file",
        path: basename(absolute),
        sha256: sha256(await readFile(absolute)),
      },
    ];
  if (source)
    rows = rows.filter(
      (row) => !["Cargo.lock", "web/package-lock.json"].includes(row.path),
    );
  invariant(
    rows.length > 0 && rows.length <= MAX_PACKAGE_FILES,
    "inventory file count is out of bounds",
  );
  invariant(
    rows.every(
      (row) => !row.path.startsWith("/") && !row.path.split("/").includes(".."),
    ),
    "inventory contains an unsafe path",
  );
  return {
    digest: inventoryDigest(rows),
    fileCount: rows.length,
    files: rows,
    totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
  };
}

async function lockBindings(root, candidate) {
  const names =
    candidate === "tauri"
      ? ["Cargo.lock", "web/package-lock.json"]
      : ["Cargo.lock"];
  return Promise.all(
    names.map(async (name) => ({
      name,
      sha256: sha256(await readFile(join(root, name))),
    })),
  );
}

async function fileContainsMarker(path, marker) {
  const needle = Buffer.from(marker);
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, {
    highWaterMark: 64 * 1024,
  })) {
    const combined = Buffer.concat([tail, chunk]);
    if (combined.includes(needle)) return true;
    tail = combined.subarray(Math.max(0, combined.length - needle.length + 1));
  }
  return false;
}

async function releaseHookFailures(packageRoot, packageInventory) {
  const failures = [];
  for (const row of packageInventory.files.filter(
    (entry) => entry.kind === "file",
  )) {
    const path = (await stat(packageRoot)).isDirectory()
      ? join(packageRoot, row.path)
      : packageRoot;
    for (const marker of RELEASE_HOOK_MARKERS) {
      if (await fileContainsMarker(path, marker))
        failures.push({ marker: sha256(marker), path: row.path });
    }
  }
  return failures;
}

export async function releaseHookScan(packageRoot, packageInventory) {
  const failures = await releaseHookFailures(packageRoot, packageInventory);
  return {
    findingCount: failures.length,
    markerSetSha256: sha256(RELEASE_HOOK_MARKERS.toSorted().join("\0")),
    scannedBytes: packageInventory.totalBytes,
    scannedFileCount: packageInventory.files.filter(
      (entry) => entry.kind === "file",
    ).length,
    schemaVersion: 1,
    status: failures.length === 0 ? "passed" : "failed",
  };
}

const releasePackagePaths = {
  tauri: [
    "Contents/Info.plist",
    "Contents/MacOS/keiko-foundation-tauri-evaluation",
    "Contents/Resources/Keiko Foundation Tauri Evaluation.icns",
  ],
  slint: [
    "Contents/Info.plist",
    "Contents/MacOS/keiko-foundation-slint-evaluation",
  ],
};

export function validateReleaseCompositionManifest(candidate, manifest) {
  invariant(CANDIDATES.includes(candidate), "release candidate is invalid");
  const validDigest = (value) =>
    typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
  invariant(
    manifest.capabilityConfigClosed === true &&
      manifest.compileFeatureDefaultEmpty === true &&
      manifest.evaluationSourceGuarded === true &&
      validDigest(manifest.instrumentedPackageDigest) &&
      validDigest(manifest.releasePackageDigest) &&
      validDigest(manifest.sourceGuardDigest) &&
      manifest.instrumentedPackageDigest !== manifest.releasePackageDigest &&
      manifest.symbolFindingCount === 0 &&
      sameJson(manifest.packagePaths, releasePackagePaths[candidate]),
    `${candidate} release composition proof failed`,
  );
  return {
    capabilityConfig: "closed",
    compileFeature: "absent-by-default-and-source-guarded",
    instrumentedDistinct: true,
    packageAllowlist: "matched",
    schemaVersion: 1,
    sourceGuardSha256: manifest.sourceGuardDigest,
    status: "passed",
    symbolFindingCount: 0,
  };
}

async function releaseCompositionProof(candidate, definition) {
  const sourceFiles = ["Cargo.toml", "build.rs", "src/main.rs"];
  if (candidate === "tauri") sourceFiles.push("tauri.conf.json");
  const source = await Promise.all(
    sourceFiles.map(async (path) => ({
      path,
      text: await readFile(join(definition.sourceRoot, path), "utf8"),
    })),
  );
  const byPath = Object.fromEntries(
    source.map((entry) => [entry.path, entry.text]),
  );
  const cargo = byPath["Cargo.toml"];
  const main = byPath["src/main.rs"];
  const build = byPath["build.rs"];
  const compileFeatureDefaultEmpty =
    /\[features\][\s\S]*?default\s*=\s*\[\][\s\S]*?evaluation-hook\s*=\s*\[\]/u.test(
      cargo,
    );
  const evaluationSourceGuarded =
    main.includes('#[cfg(feature = "evaluation-hook")]\nmod evaluation;') &&
    main.includes(
      '#[cfg(feature = "evaluation-hook")]\n    if evaluation::requested()',
    ) &&
    build.includes("CARGO_FEATURE_EVALUATION_HOOK");
  let capabilityConfigClosed = candidate === "slint";
  if (candidate === "tauri") {
    const config = JSON.parse(byPath["tauri.conf.json"]);
    capabilityConfigClosed =
      config.build?.frontendDist === "frontend" &&
      config.app?.withGlobalTauri === false &&
      sameJson(config.app?.security?.capabilities, []) &&
      config.app?.security?.csp?.includes("connect-src 'none'");
  }
  const symbols = spawnSync(
    "/usr/bin/nm",
    ["-gj", definition.releaseExecutable],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    },
  );
  invariant(symbols.status === 0, `${candidate} release symbol scan failed`);
  const symbolFindingCount = symbols.stdout
    .split("\n")
    .filter((line) =>
      /keiko_evaluation|evaluation_dispatch|foundation_evaluation/iu.test(line),
    ).length;
  return validateReleaseCompositionManifest(candidate, {
    capabilityConfigClosed,
    compileFeatureDefaultEmpty,
    evaluationSourceGuarded,
    instrumentedPackageDigest: definition.package.digest,
    packagePaths: definition.releasePackage.files.map((entry) => entry.path),
    releasePackageDigest: definition.releasePackage.digest,
    sourceGuardDigest: sha256(
      source.map((entry) => `${entry.path}\0${sha256(entry.text)}\n`).join(""),
    ),
    symbolFindingCount,
  });
}

async function resolveExecutable(packagePath) {
  const absolute = resolve(packagePath);
  const info = await stat(absolute);
  if (info.isFile()) return absolute;
  const macos = join(absolute, "Contents", "MacOS");
  const entries = await readdir(macos, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  invariant(
    files.length === 1,
    "application package must contain exactly one main executable",
  );
  return join(macos, files[0].name);
}

function requiredPath(environment, name) {
  return boundedString(environment[name], name, 4_096);
}

const candidatePackageSuffixes = {
  tauri: {
    packagePath:
      "target/evaluation/release/bundle/macos/Keiko Foundation Tauri Evaluation.app",
    releasePackagePath:
      "target/release-like/release/bundle/macos/Keiko Foundation Tauri Evaluation.app",
  },
  slint: {
    packagePath:
      "target/issue11-instrumented/release/bundle/osx/Keiko Foundation Slint Evaluation.app",
    releasePackagePath:
      "target/issue11-release-like/release/bundle/osx/Keiko Foundation Slint Evaluation.app",
  },
};

export async function validateCandidatePackagePaths(root, candidate, paths) {
  invariant(
    CANDIDATES.includes(candidate),
    "candidate path identity is invalid",
  );
  const candidateRoot = resolve(root, "experiments", `${candidate}-renderer`);
  const rootInfo = await lstat(candidateRoot);
  invariant(
    rootInfo.isDirectory() && !rootInfo.isSymbolicLink(),
    "candidate root must be a real directory",
  );
  const resolved = {};
  for (const field of ["packagePath", "releasePackagePath"]) {
    const expected = resolve(
      candidateRoot,
      candidatePackageSuffixes[candidate][field],
    );
    const supplied = resolve(root, paths[field]);
    const suppliedInfo = await lstat(supplied);
    invariant(
      suppliedInfo.isDirectory() &&
        !suppliedInfo.isSymbolicLink() &&
        (await realpath(supplied)) === (await realpath(expected)) &&
        supplied === expected,
      `${candidate} ${field} is not the exact governed package path`,
    );
    resolved[field] = supplied;
  }
  return { candidateRoot, ...resolved };
}

export async function loadConfiguration(root, environment = process.env) {
  const definitions = {
    tauri: {
      packagePath: requiredPath(environment, "KEIKO_FOUNDATION_TAURI_PACKAGE"),
      releasePackagePath: requiredPath(
        environment,
        "KEIKO_FOUNDATION_TAURI_RELEASE_PACKAGE",
      ),
      sourceRoot: join(root, "experiments", "tauri-renderer"),
    },
    slint: {
      packagePath: requiredPath(environment, "KEIKO_FOUNDATION_SLINT_PACKAGE"),
      releasePackagePath: requiredPath(
        environment,
        "KEIKO_FOUNDATION_SLINT_RELEASE_PACKAGE",
      ),
      sourceRoot: join(root, "experiments", "slint-renderer"),
    },
  };
  for (const candidate of CANDIDATES) {
    const definition = definitions[candidate];
    const paths = await validateCandidatePackagePaths(
      root,
      candidate,
      definition,
    );
    definition.packagePath = paths.packagePath;
    definition.releasePackagePath = paths.releasePackagePath;
    definition.sourceRoot = paths.candidateRoot;
    definition.executable = await resolveExecutable(definition.packagePath);
    definition.releaseExecutable = await resolveExecutable(
      definition.releasePackagePath,
    );
    definition.source = await inventory(definition.sourceRoot, {
      source: true,
    });
    definition.locks = await lockBindings(definition.sourceRoot, candidate);
    definition.package = await inventory(definition.packagePath);
    definition.releasePackage = await inventory(definition.releasePackagePath);
    definition.releaseHookScan = await releaseHookScan(
      definition.releasePackagePath,
      definition.releasePackage,
    );
    invariant(
      definition.releaseHookScan.findingCount === 0,
      `${candidate} release-like package retains evaluation hooks`,
    );
    definition.releaseCompositionProof = await releaseCompositionProof(
      candidate,
      definition,
    );
  }
  return definitions;
}

export function validateAuthorityObservation(observed, environment) {
  invariant(
    environment.KEIKO_FOUNDATION_AUTHORITY === "owner-m4-16gib-macos26",
    "authoritative owner M4 authority assertion is missing",
  );
  invariant(
    observed.architecture === "arm64" &&
      observed.virtual === false &&
      /^26\./u.test(observed.osPatch) &&
      observed.memoryClassGiB >= 15 &&
      observed.memoryClassGiB <= 17,
    "authoritative owner M4 observation mismatch",
  );
  return {
    architecture: observed.architecture,
    authority: "authoritative-owner-m4",
    memoryClassGiB: observed.memoryClassGiB,
    osFamily: "macos",
    osPatch: observed.osPatch,
    referenceClass: "owner-m4-16gib-macos26",
    virtual: false,
  };
}

export function observeEnvironment(options = {}) {
  const { diagnostic = false, environment = process.env } = options;
  invariant(
    process.platform === "darwin",
    "authoritative foundation benchmarking requires macOS",
  );
  const osPatch = execText("/usr/bin/sw_vers", ["-productVersion"]);
  const architecture = execText("/usr/bin/uname", ["-m"]);
  const memoryBytes = Number(
    execText("/usr/sbin/sysctl", ["-n", "hw.memsize"]),
  );
  const virtual =
    execText("/usr/sbin/sysctl", ["-n", "kern.hv_vmm_present"]) === "1";
  invariant(/^\d+\.\d+(?:\.\d+)?$/u.test(osPatch), "macOS patch is invalid");
  invariant(architecture === "arm64", "reference architecture must be arm64");
  invariant(
    Number.isSafeInteger(memoryBytes) && memoryBytes > 0,
    "memory observation is invalid",
  );
  const rawObservation = {
    architecture,
    memoryClassGiB: Math.round(memoryBytes / 2 ** 30),
    osPatch,
    virtual,
  };
  if (!diagnostic)
    return validateAuthorityObservation(rawObservation, environment);
  const observation = {
    ...rawObservation,
    authority: "diagnostic-runner",
    osFamily: "macos",
    referenceClass: "diagnostic-github-runner",
  };
  if (diagnostic) {
    const architectureCommand = execText("/usr/bin/arch", []);
    invariant(
      environment.RUNNER_ARCH === "ARM64",
      "diagnostic runner architecture must be ARM64",
    );
    invariant(
      architectureCommand === "arm64",
      "diagnostic arch command must report arm64",
    );
    invariant(
      ["macos-14", "macos-26"].includes(
        environment.KEIKO_FOUNDATION_RUNNER_LABEL,
      ),
      "diagnostic runner label is unsupported",
    );
    observation.runnerImage = {
      architecture: architectureCommand,
      label: environment.KEIKO_FOUNDATION_RUNNER_LABEL,
      os: boundedString(environment.ImageOS, "ImageOS", 64),
      version: boundedString(environment.ImageVersion, "ImageVersion", 128),
    };
  }
  return observation;
}

function processGroupMembers(group) {
  const result = spawnSync("/usr/bin/pgrep", ["-g", String(group)], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (result.status === 1) return [];
  invariant(result.status === 0, "pgrep process-group observation failed");
  return result.stdout.trim().split(/\s+/u).filter(Boolean).map(Number);
}

function matchingProcesses(executable) {
  const pattern = executable.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const result = spawnSync("/usr/bin/pgrep", ["-f", pattern], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (result.status === 1) return [];
  invariant(result.status === 0, "pgrep candidate observation failed");
  return result.stdout
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map(Number)
    .filter((pid) => pid !== process.pid);
}

function rssForGroup(group) {
  const result = spawnSync("/bin/ps", ["-axo", "pgid=,rss="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (result.status !== 0) return null;
  const rssKib = result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .filter(([pgid, rss]) => pgid === group && Number.isFinite(rss))
    .reduce((sum, [, rss]) => sum + rss, 0);
  return rssKib > 0 ? rssKib * 1_024 : null;
}

function killGroup(group, signal) {
  try {
    process.kill(-group, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function killProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function appGroupIsOwned(appPid, appGroup, wrapperGroup) {
  return appGroup === appPid || appGroup === wrapperGroup;
}

const launchEnvironment = [
  "LANG=en_US.UTF-8",
  "LC_ALL=en_US.UTF-8",
  "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
  "RUST_BACKTRACE=0",
  "TMPDIR=/tmp",
];

function launchEnvironmentFor(candidate) {
  invariant(CANDIDATES.includes(candidate), "launch candidate is invalid");
  return [
    ...launchEnvironment,
    ...(candidate === "slint" ? ["SLINT_BACKEND=winit-femtovg"] : []),
  ];
}

function launchEnvironmentObject(candidate) {
  return Object.fromEntries(
    launchEnvironmentFor(candidate).map((entry) => {
      const separator = entry.indexOf("=");
      invariant(separator > 0, "launch environment entry is invalid");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}

function candidateArguments({
  fixtureAck,
  fixtureCleanupAck,
  fixtureEscalationAck,
  fixtureMarker,
  mode,
}) {
  invariant(["cold", "warm"].includes(mode), "launch mode is invalid");
  invariant(
    fixtureMarker === undefined || /^[0-9a-f]{32}$/u.test(fixtureMarker),
    "fixture marker is invalid",
  );
  invariant(
    fixtureAck === undefined ||
      (fixtureAck.startsWith("/var/") &&
        fixtureCleanupAck?.startsWith("/var/") &&
        fixtureEscalationAck?.startsWith("/var/")),
    "fixture acknowledgement path is invalid",
  );
  return [
    "--evaluation-json",
    "--mode",
    mode,
    ...(fixtureMarker === undefined
      ? []
      : [
          "--fixture-marker",
          fixtureMarker,
          "--fixture-ack",
          fixtureAck,
          "--fixture-escalation-ack",
          fixtureEscalationAck,
          "--fixture-cleanup-ack",
          fixtureCleanupAck,
        ]),
  ];
}

export function launchServicesArguments({
  candidate = "tauri",
  fixtureAck,
  fixtureCleanupAck,
  fixtureEscalationAck,
  fixtureMarker,
  mode,
  packagePath,
  stderrPath,
  stdoutPath,
}) {
  return [
    "-n",
    "-F",
    "-W",
    "--stdout",
    stdoutPath,
    "--stderr",
    stderrPath,
    ...launchEnvironmentFor(candidate).flatMap((value) => ["--env", value]),
    packagePath,
    "--args",
    ...candidateArguments({
      fixtureAck,
      fixtureCleanupAck,
      fixtureEscalationAck,
      fixtureMarker,
      mode,
    }),
  ];
}

function safeLauncherEnvironment() {
  return {
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: "/tmp",
  };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function processGroupFor(pid) {
  invariant(
    Number.isSafeInteger(pid) && pid > 0,
    "candidate process-group discovery failed",
  );
  const result = spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1_000,
  });
  invariant(result.status === 0, "candidate process-group discovery failed");
  const group = Number(result.stdout.trim());
  invariant(
    Number.isSafeInteger(group) && group > 0,
    "candidate process group is invalid",
  );
  return group;
}

function processSnapshot() {
  const result = spawnSync(
    "/bin/ps",
    ["-axo", "pid=,ppid=,pgid=,comm=,command="],
    { encoding: "utf8", timeout: 1_000 },
  );
  invariant(result.status === 0, "process-tree observation failed");
  return result.stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line))
    .filter(Boolean)
    .map(([, pid, parentPid, group, executable, command]) => ({
      command: command.trim(),
      executable,
      group: Number(group),
      parentPid: Number(parentPid),
      pid: Number(pid),
    }));
}

function markerProcessRows(marker, snapshot = processSnapshot()) {
  return snapshot.filter(({ command }) =>
    command.split(/\s+/u).includes(marker),
  );
}

export function buildDarwinSessionObserver(
  repositoryRoot,
  {
    architecture = process.arch,
    platform = process.platform,
    prepared,
    rustcPath,
    run = spawnSync,
  } = {},
) {
  invariant(
    platform === "darwin" && architecture === "arm64",
    "session helper platform is unauthorized",
  );
  const options = {
    encoding: "utf8",
    env: safeLauncherEnvironment(),
    maxBuffer: 4_096,
    timeout: 30_000,
  };
  const source = join(
    repositoryRoot,
    "quality/foundation-evaluation/session-observer.rs",
  );
  invariant(
    sha256(readFileSync(source)) === SESSION_HELPER_SOURCE_SHA256,
    "session helper source binding is invalid",
  );
  if (prepared !== undefined) {
    invariant(
      prepared !== null &&
        typeof prepared === "object" &&
        typeof prepared.root === "string" &&
        prepared.root.startsWith("/") &&
        typeof prepared.executable === "string" &&
        prepared.executable.startsWith("/") &&
        typeof prepared.executableSha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(prepared.executableSha256),
      "prepared session helper contract is invalid",
    );
    const preparedRoot = realpathSync(prepared.root);
    const preparedRootInfo = lstatSync(prepared.root);
    invariant(
      preparedRootInfo.isDirectory() &&
        !preparedRootInfo.isSymbolicLink() &&
        (preparedRootInfo.mode & 0o777) === 0o700,
      "prepared session helper root is invalid",
    );
    const executable = realpathSync(prepared.executable);
    const relativeExecutable = relative(preparedRoot, executable);
    invariant(
      relativeExecutable !== "" &&
        relativeExecutable !== ".." &&
        !relativeExecutable.startsWith(`..${sep}`),
      "prepared session helper path is unauthorized",
    );
    const executableInfo = lstatSync(prepared.executable);
    invariant(
      executableInfo.isFile() &&
        !executableInfo.isSymbolicLink() &&
        executableInfo.nlink === 1 &&
        (executableInfo.mode & 0o777) === 0o700 &&
        sha256(readFileSync(executable)) === prepared.executableSha256,
      "prepared session helper executable is invalid",
    );
    return sessionObserverForExecutable(executable, run, options, {
      binding: {
        executableSha256: prepared.executableSha256,
        kind: "workflow-prepared",
        sourceSha256: SESSION_HELPER_SOURCE_SHA256,
      },
      dispose: () => {},
    });
  }
  invariant(
    typeof rustcPath === "string" && rustcPath.startsWith("/"),
    "session helper rustc path is invalid",
  );
  rustcPath = realpathSync(rustcPath);
  const version = run(rustcPath, ["--version", "--verbose"], options);
  invariant(
    version.status === 0 &&
      version.signal === null &&
      version.error === undefined &&
      version.stderr === "" &&
      /^rustc 1\.92\.0 \(ded5c06cf 2025-12-08\)\nbinary: rustc\ncommit-hash: ded5c06cf21d2b93bffd5d884aa6e96934ee4234\ncommit-date: 2025-12-08\nhost: aarch64-apple-darwin\nrelease: 1\.92\.0\nLLVM version: 21\.1\.3\n$/u.test(
        version.stdout,
      ),
    "session helper rustc version is unauthorized",
  );
  const generatedRoot = mkdtempSync(join(tmpdir(), "keiko-session-observer-"));
  const executable = join(generatedRoot, "session-observer");
  try {
    const build = run(
      rustcPath,
      ["--edition=2021", "-O", "-o", executable, source],
      options,
    );
    invariant(
      build.status === 0 &&
        build.signal === null &&
        build.error === undefined &&
        build.stderr === "",
      "session helper build failed",
    );
    let executableInfo = lstatSync(executable);
    invariant(
      executableInfo.isFile() &&
        !executableInfo.isSymbolicLink() &&
        executableInfo.nlink === 1,
      "session helper executable is invalid",
    );
    chmodSync(executable, 0o700);
    executableInfo = lstatSync(executable);
    invariant(
      executableInfo.isFile() &&
        !executableInfo.isSymbolicLink() &&
        executableInfo.nlink === 1 &&
        (executableInfo.mode & 0o777) === 0o700,
      "session helper executable mode is invalid",
    );
  } catch (error) {
    rmSync(generatedRoot, { force: true, recursive: true });
    throw error;
  }
  return sessionObserverForExecutable(executable, run, options, {
    binding: {
      executableSha256: sha256(readFileSync(executable)),
      kind: "locally-compiled",
      sourceSha256: SESSION_HELPER_SOURCE_SHA256,
    },
    dispose: () => rmSync(generatedRoot, { force: true, recursive: true }),
  });
}

function sessionObserverForExecutable(
  executable,
  run,
  options,
  { binding, dispose },
) {
  return {
    binding,
    dispose,
    sessionFor(pid) {
      invariant(Number.isSafeInteger(pid) && pid > 0, "session PID is invalid");
      const result = run(executable, [String(pid)], {
        ...options,
        timeout: 1_000,
      });
      if (
        result.status === 65 &&
        result.signal === null &&
        result.error === undefined &&
        result.stderr === "" &&
        result.stdout === ""
      )
        return undefined;
      invariant(
        result.status === 0 &&
          result.signal === null &&
          result.error === undefined &&
          result.stderr === "" &&
          /^[1-9]\d*\n$/u.test(result.stdout),
        "session helper observation failed",
      );
      const session = Number(result.stdout.trim());
      invariant(
        Number.isSafeInteger(session) && session <= 2_147_483_647,
        "session helper observation is invalid",
      );
      return session;
    },
  };
}

export async function withDarwinSessionObserver(
  repositoryRoot,
  options,
  work,
  build = buildDarwinSessionObserver,
) {
  const observer = build(repositoryRoot, options);
  try {
    return await work(observer);
  } finally {
    observer.dispose();
  }
}

function authoritativeFixtureRows(marker, appPid, appExecutable, sessionFor) {
  return markerProcessRows(marker).filter(
    (row) =>
      row.pid !== appPid &&
      row.parentPid === appPid &&
      row.group === row.pid &&
      sessionFor(row.pid) === row.pid &&
      row.executable !== appExecutable,
  );
}

function signalRecordedFixture(
  marker,
  { executable, group, pid },
  sessionFor,
  signal,
) {
  const rows = markerProcessRows(marker).filter(
    (row) =>
      row.pid === pid &&
      row.group === group &&
      row.executable === executable &&
      sessionFor(row.pid) === row.pid,
  );
  for (const row of rows) killGroup(row.group, signal);
  return rows.length;
}

async function boundedOutput(path, maximum, label) {
  const info = await stat(path);
  invariant(info.size <= maximum, `${label} exceeded its bound`);
  return readFile(path);
}

async function pause(milliseconds = 10) {
  await new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}

export async function runCandidate(
  definition,
  entry,
  observation,
  {
    launchMode = "launch-services",
    openPath = "/usr/bin/open",
    requireFixtureObservation = openPath === "/usr/bin/open" ||
      launchMode === "direct-executable",
    sessionObserver,
    timeoutMs = RUN_TIMEOUT_MS,
  } = {},
) {
  invariant(
    ["launch-services", "direct-executable"].includes(launchMode),
    "candidate launch mode is invalid",
  );
  invariant(
    sessionObserver !== undefined &&
      typeof sessionObserver.sessionFor === "function",
    "session observer is required",
  );
  const fixtureMarker = randomBytes(16).toString("hex");
  invariant(
    markerProcessRows(fixtureMarker).length === 0,
    "fixture marker already exists",
  );
  if (matchingProcesses(definition.executable).length !== 0)
    throw failureError(
      new Error(`${entry.candidate} already has a running candidate process`),
      {
        candidate: entry.candidate,
        mode: entry.mode,
        sequence: entry.sequence,
      },
    );
  const outputRoot = await mkdtemp(join(tmpdir(), "keiko-foundation-run-"));
  const stdoutPath = join(outputRoot, "stdout");
  const stderrPath = join(outputRoot, "stderr");
  const fixtureAck = join(outputRoot, "fixture-observed");
  const fixtureCleanupAck = join(outputRoot, "fixture-cleanup-observed");
  const fixtureEscalationAck = join(outputRoot, "fixture-escalation-observed");
  await Promise.all([
    writeFile(stdoutPath, "", { mode: 0o600 }),
    writeFile(stderrPath, "", { mode: 0o600 }),
  ]);
  const started = process.hrtime.bigint();
  const directExecutable = launchMode === "direct-executable";
  const wrapper = directExecutable
    ? (() => {
        const stdoutFd = openSync(stdoutPath, "a");
        const stderrFd = openSync(stderrPath, "a");
        try {
          return spawn(
            definition.executable,
            candidateArguments({
              mode: entry.mode,
              fixtureAck,
              fixtureCleanupAck,
              fixtureEscalationAck,
              fixtureMarker,
            }),
            {
              detached: true,
              env: launchEnvironmentObject(entry.candidate),
              stdio: ["ignore", stdoutFd, stderrFd],
            },
          );
        } finally {
          closeSync(stdoutFd);
          closeSync(stderrFd);
        }
      })()
    : spawn(
        openPath,
        launchServicesArguments({
          candidate: entry.candidate,
          mode: entry.mode,
          packagePath: definition.packagePath,
          fixtureAck,
          fixtureCleanupAck,
          fixtureEscalationAck,
          fixtureMarker,
          stderrPath,
          stdoutPath,
        }),
        {
          detached: true,
          env: safeLauncherEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
  const wrapperGroup =
    Number.isSafeInteger(wrapper.pid) && wrapper.pid > 0
      ? wrapper.pid
      : undefined;
  let fixtureGroup;
  let fixturePid;
  let fixtureExecutable;
  let appExecutable;
  let fixtureObservedAt;
  let fixtureEscalationRequested = false;
  let fixtureCleanupRequested = false;
  let runnerObservedCleanup = false;
  let runnerObservedEscalation = false;
  let runnerObservedDifferentExecutable = false;
  let runnerObservedMarker = false;
  let runnerObservedNewProcessGroup = false;
  let runnerObservedNewSession = false;
  const observeFixture = () => {
    const snapshot = processSnapshot();
    const appRow = snapshot.find(({ pid }) => pid === appPid);
    if (appRow !== undefined) appExecutable = appRow.executable;
    const rows =
      appRow === undefined
        ? []
        : markerProcessRows(fixtureMarker, snapshot).filter(
            (row) =>
              row.parentPid === appPid &&
              row.group === row.pid &&
              sessionObserver.sessionFor(row.pid) === row.pid &&
              row.executable !== appRow.executable &&
              (fixturePid === undefined || row.pid === fixturePid),
          );
    invariant(rows.length <= 1, "multiple authoritative fixtures appeared");
    for (const row of rows) {
      runnerObservedMarker = true;
      runnerObservedDifferentExecutable = true;
      runnerObservedNewProcessGroup = true;
      runnerObservedNewSession = true;
      fixtureGroup = row.group;
      fixturePid = row.pid;
      fixtureExecutable = row.executable;
      if (fixtureObservedAt === undefined) {
        fixtureObservedAt = process.hrtime.bigint();
        writeFileSync(fixtureAck, "", { flag: "wx", mode: 0o600 });
      }
    }
    if (
      fixtureEscalationRequested &&
      fixturePid !== undefined &&
      authoritativeFixtureRows(
        fixtureMarker,
        appPid,
        appRow?.executable,
        sessionObserver.sessionFor,
      ).some(({ pid }) => pid === fixturePid) &&
      !runnerObservedEscalation
    ) {
      runnerObservedEscalation = true;
      writeFileSync(fixtureEscalationAck, "", { flag: "wx", mode: 0o600 });
    }
    if (
      fixtureCleanupRequested &&
      fixturePid !== undefined &&
      fixtureGroup !== undefined &&
      fixtureExecutable !== undefined &&
      appRow !== undefined &&
      !processExists(fixturePid) &&
      processGroupMembers(fixtureGroup).length === 0 &&
      markerProcessRows(fixtureMarker, snapshot).filter((row) => {
        if (row.pid === appPid) return false;
        if (Number.isSafeInteger(wrapper.pid) && row.pid === wrapper.pid)
          return false;
        return true;
      }).length === 0 &&
      !runnerObservedCleanup
    ) {
      runnerObservedCleanup = true;
      writeFileSync(fixtureCleanupAck, "", { flag: "wx", mode: 0o600 });
    }
  };
  let wrapperExit;
  let wrapperError;
  let wrapperOutputBytes = 0;
  if (wrapper.stdout !== null)
    wrapper.stdout.on("data", (chunk) => {
      wrapperOutputBytes += chunk.length;
    });
  if (wrapper.stderr !== null)
    wrapper.stderr.on("data", (chunk) => {
      wrapperOutputBytes += chunk.length;
    });
  wrapper.once("error", (error) => {
    wrapperError = error;
  });
  wrapper.once("exit", (code, signal) => {
    wrapperExit = { code, signal };
  });

  let appPid;
  let appGroup;
  let appExitAt;
  let evidence;
  let escalationAt;
  let escalationReason;
  let maxTrackedRssBytes = 0;
  let outputFailure;
  let presentedAt;
  let shutdownAt;
  let stdoutBytes = 0;
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBytes = 0;
  let candidateDiagnostic = "unavailable";
  let completedSuccessfully = false;
  const signalApp = (signal) => {
    if (appPid === undefined) return;
    if (
      appGroup !== undefined &&
      appGroupIsOwned(appPid, appGroup, wrapperGroup)
    )
      killGroup(appGroup, signal);
    else killProcess(appPid, signal);
  };
  const signalWrapper = (signal) => {
    if (wrapperGroup === undefined || !Number.isSafeInteger(wrapper.pid))
      return;
    if (appPid !== undefined && appGroup === wrapperGroup) return;
    if (processExists(wrapper.pid)) killGroup(wrapperGroup, signal);
  };
  const escalate = (reason) => {
    if (escalationReason !== undefined) return;
    escalationReason = reason;
    escalationAt = process.hrtime.bigint();
    signalApp("SIGTERM");
    signalWrapper("SIGTERM");
  };
  const consumeLines = (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    for (;;) {
      const newline = stdoutBuffer.indexOf(10);
      if (newline === -1) break;
      const line = stdoutBuffer
        .subarray(0, newline)
        .toString("utf8")
        .replace(/\r$/u, "");
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      const now = process.hrtime.bigint();
      try {
        if (line === "KEIKO_PRESENTED") {
          invariant(presentedAt === undefined, "duplicate presented marker");
          presentedAt = now;
        } else if (line.startsWith("KEIKO_EVIDENCE:")) {
          invariant(
            presentedAt !== undefined,
            "evidence preceded presentation",
          );
          invariant(evidence === undefined, "duplicate evidence marker");
          const json = line.slice("KEIKO_EVIDENCE:".length);
          invariant(
            Buffer.byteLength(json) <= MAX_EVIDENCE_BYTES,
            "candidate evidence is oversized",
          );
          evidence = JSON.parse(json);
        } else if (line === "KEIKO_SHUTDOWN_START") {
          invariant(evidence !== undefined, "shutdown preceded evidence");
          invariant(shutdownAt === undefined, "duplicate shutdown marker");
          shutdownAt = now;
        } else if (line === "KEIKO_FIXTURE_ESCALATED") {
          invariant(
            fixtureObservedAt !== undefined,
            "fixture escalation preceded observation",
          );
          invariant(
            !fixtureEscalationRequested,
            "duplicate fixture escalation marker",
          );
          fixtureEscalationRequested = true;
        } else if (line === "KEIKO_FIXTURE_CLEANED") {
          invariant(
            runnerObservedEscalation,
            "fixture cleanup preceded escalation observation",
          );
          invariant(
            !fixtureCleanupRequested,
            "duplicate fixture cleanup marker",
          );
          fixtureCleanupRequested = true;
        } else if (line !== "") throw new Error("unexpected candidate stdout");
      } catch (error) {
        outputFailure ??= error;
        escalate("invalid candidate output");
      }
    }
  };
  const captureOutput = async () => {
    const snapshot = candidateOutputSnapshot(
      await boundedOutput(stdoutPath, MAX_STDOUT_BYTES, "candidate stdout"),
      await boundedOutput(stderrPath, MAX_STDOUT_BYTES, "candidate stderr"),
      stdoutBytes,
    );
    stderrBytes = snapshot.stderrBytes;
    candidateDiagnostic = snapshot.candidateDiagnostic;
    if (snapshot.truncated) {
      outputFailure ??= new Error("candidate stdout was truncated");
      escalate("candidate stdout was truncated");
    } else if (snapshot.stdoutDelta.length > 0) {
      consumeLines(snapshot.stdoutDelta);
      stdoutBytes = snapshot.stdoutBytes;
    }
  };
  const failureContext = () => ({
    appPid,
    appExitAt,
    candidate: entry.candidate,
    candidateDiagnostic,
    evidence,
    mode: entry.mode,
    presentedAt,
    sequence: entry.sequence,
    shutdownAt,
    stderrBytes,
    wrapperError,
    wrapperExit,
    wrapperStarted: wrapperGroup !== undefined,
  });
  let pendingFailure;

  try {
    if (directExecutable) {
      invariant(
        Number.isSafeInteger(wrapper.pid) && wrapper.pid > 0,
        `${entry.candidate} direct executable did not start`,
      );
      appPid = wrapper.pid;
      appGroup = processGroupFor(appPid);
    }
    const terminalDeadline = started + BigInt(timeoutMs + 2_000) * 1_000_000n;
    while (process.hrtime.bigint() < terminalDeadline) {
      observeFixture();
      if (wrapperError !== undefined) throw wrapperError;
      invariant(
        wrapperOutputBytes <= 4_096,
        "LaunchServices wrapper output exceeded its bound",
      );

      await captureOutput();

      if (appPid === undefined) {
        const matches = matchingProcesses(definition.executable).filter(
          (pid) => pid !== wrapper.pid,
        );
        invariant(matches.length <= 1, "multiple candidate processes appeared");
        if (matches.length === 1) {
          appPid = matches[0];
          appGroup = processGroupFor(appPid);
          if (!appGroupIsOwned(appPid, appGroup, wrapperGroup)) {
            outputFailure ??= new Error(
              "candidate process group is not exclusively owned",
            );
            escalate("candidate process group is not exclusively owned");
          }
        }
      } else if (!processExists(appPid) && appExitAt === undefined) {
        appExitAt = process.hrtime.bigint();
      }

      if (appGroup !== undefined) {
        const rss = rssForGroup(appGroup);
        if (rss !== null)
          maxTrackedRssBytes = Math.max(maxTrackedRssBytes, rss);
      }

      const now = process.hrtime.bigint();
      if (now - started > BigInt(timeoutMs) * 1_000_000n)
        escalate("candidate run exceeded its hard timeout");
      if (
        shutdownAt !== undefined &&
        appExitAt === undefined &&
        now - shutdownAt > BigInt(SHUTDOWN_BUDGET_MS) * 1_000_000n
      )
        escalate("candidate exceeded the shutdown budget");
      if (escalationAt !== undefined && now - escalationAt > 1_000_000_000n) {
        signalApp("SIGKILL");
        signalWrapper("SIGKILL");
      }

      if (
        wrapperExit !== undefined &&
        appPid !== undefined &&
        appExitAt !== undefined
      ) {
        invariant(
          stderrBytes <= MAX_STDOUT_BYTES,
          "candidate stderr exceeded its bound",
        );
        break;
      }
      await pause();
    }

    await captureOutput();

    invariant(
      appPid !== undefined && appGroup !== undefined,
      "LaunchServices did not start the exact candidate executable",
    );
    invariant(appExitAt !== undefined, "candidate process did not exit");
    invariant(wrapperExit !== undefined, "LaunchServices wrapper did not exit");
    invariant(
      appGroupIsOwned(appPid, appGroup, wrapperGroup),
      "candidate process group is not exclusively owned",
    );
    invariant(
      processGroupMembers(appGroup).length === 0,
      "candidate descendants survived cleanup",
    );
    invariant(
      matchingProcesses(definition.executable).length === 0,
      "exact candidate executable survived cleanup",
    );
    const markerSurvivors = markerProcessRows(fixtureMarker);
    invariant(
      markerSurvivors.length === 0,
      "candidate descendants survived cleanup",
    );
    const runnerConfirmedDescendantAbsent = runnerObservedCleanup;
    const runnerObservedParentReaped = runnerObservedCleanup;
    const runnerObservedGroupAbsent = runnerObservedCleanup;
    const runnerFixture = {
      accepted:
        runnerObservedMarker &&
        runnerObservedEscalation &&
        runnerConfirmedDescendantAbsent &&
        runnerObservedGroupAbsent &&
        runnerObservedParentReaped &&
        runnerObservedDifferentExecutable &&
        runnerObservedNewProcessGroup &&
        runnerObservedNewSession,
      descendantAbsent: runnerConfirmedDescendantAbsent,
      escalated: runnerObservedEscalation,
      execChanged: runnerObservedDifferentExecutable,
      groupAbsent: runnerObservedGroupAbsent,
      parentReaped: runnerObservedParentReaped,
      runnerConfirmedDescendantAbsent,
      runnerObservedDifferentExecutable,
      runnerObservedMarker,
      runnerObservedNewProcessGroup,
      runnerObservedNewSession,
      sessionIsolated: runnerObservedNewSession,
    };
    if (requireFixtureObservation)
      invariant(
        Object.values(runnerFixture).every(Boolean),
        "candidate fixture observation is incomplete",
      );
    invariant(escalationReason === undefined, escalationReason);
    if (outputFailure) throw outputFailure;
    invariant(
      wrapperExit.code === 0 && wrapperExit.signal === null,
      `${entry.candidate} LaunchServices wrapper exited unsuccessfully code=${String(wrapperExit.code)} signal=${String(wrapperExit.signal)}`,
    );
    invariant(
      stdoutBuffer.length === 0,
      "candidate stdout ended with an incomplete line",
    );
    invariant(
      presentedAt !== undefined &&
        shutdownAt !== undefined &&
        evidence !== undefined,
      "candidate marker sequence is incomplete",
    );
    const launchMs = Number(presentedAt - started) / 1e6;
    const shutdownMs = Number(appExitAt - shutdownAt) / 1e6;
    invariant(
      shutdownMs <= SHUTDOWN_BUDGET_MS,
      "candidate exceeded the shutdown budget",
    );
    const expectedEvidence = {
      ...entry,
      observation,
      runnerFixture,
    };
    const metrics = validateCandidateEvidence(evidence, expectedEvidence);
    const evidencePayload = sanitizeCandidateEvidence(
      evidence,
      expectedEvidence,
    );
    const sample = {
      candidate: entry.candidate,
      candidateEvidenceSha256: sha256(JSON.stringify(evidencePayload)),
      candidateHardGates: metrics.candidateHardGates,
      candidateRssBytes: metrics.candidateRssBytes,
      inputToPaintMs: metrics.inputToPaintMs,
      iteration: entry.iteration,
      launchMs,
      mode: entry.mode,
      runtimeToUiMs: metrics.runtimeToUiMs,
      sequence: entry.sequence,
      shutdownMs,
      trackedRssBytes: maxTrackedRssBytes || null,
    };
    completedSuccessfully = true;
    return { evidencePayload, sample };
  } catch (error) {
    pendingFailure = failureError(error, failureContext());
    throw pendingFailure;
  } finally {
    let cleanupFailure;
    try {
      if (
        fixturePid !== undefined &&
        fixtureGroup !== undefined &&
        fixtureExecutable !== undefined
      )
        signalRecordedFixture(
          fixtureMarker,
          {
            executable: fixtureExecutable,
            group: fixtureGroup,
            pid: fixturePid,
          },
          sessionObserver.sessionFor,
          "SIGKILL",
        );
      if (
        appPid !== undefined &&
        appGroup !== undefined &&
        appGroupIsOwned(appPid, appGroup, wrapperGroup) &&
        processGroupMembers(appGroup).length > 0
      )
        killGroup(appGroup, "SIGKILL");
      else if (appPid !== undefined && processExists(appPid))
        killProcess(appPid, "SIGKILL");
      signalWrapper("SIGKILL");
      const lateDeadline =
        process.hrtime.bigint() +
        BigInt(completedSuccessfully ? 100 : 1_500) * 1_000_000n;
      while (process.hrtime.bigint() < lateDeadline) {
        if (
          fixturePid !== undefined &&
          fixtureGroup !== undefined &&
          fixtureExecutable !== undefined
        )
          signalRecordedFixture(
            fixtureMarker,
            {
              executable: fixtureExecutable,
              group: fixtureGroup,
              pid: fixturePid,
            },
            sessionObserver.sessionFor,
            "SIGKILL",
          );
        const lateMatches = matchingProcesses(definition.executable).filter(
          (pid) => pid !== process.pid,
        );
        for (const pid of lateMatches) killProcess(pid, "SIGKILL");
        if (
          completedSuccessfully &&
          lateMatches.length === 0 &&
          markerProcessRows(fixtureMarker).length === 0
        )
          break;
        await pause(25);
      }
      invariant(
        matchingProcesses(definition.executable).length === 0,
        "exact candidate executable survived cleanup",
      );
      invariant(
        markerProcessRows(fixtureMarker).length === 0,
        "candidate descendants survived cleanup",
      );
    } catch (error) {
      cleanupFailure = error;
    } finally {
      try {
        await rm(outputRoot, { force: true, recursive: true });
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (cleanupFailure !== undefined) {
      if (pendingFailure !== undefined) throw pendingFailure;
      throw failureError(cleanupFailure, failureContext());
    }
  }
}

function compactBindings(configuration) {
  return Object.fromEntries(
    CANDIDATES.map((candidate) => {
      const definition = configuration[candidate];
      return [
        candidate,
        {
          locks: definition.locks,
          package: definition.package,
          releasePackage: definition.releasePackage,
          releaseHookScan: definition.releaseHookScan,
          releaseCompositionProof: definition.releaseCompositionProof,
          source: definition.source,
        },
      ];
    }),
  );
}

function samplesFor(samples, candidate, mode) {
  return samples.filter(
    (sample) =>
      sample.candidate === candidate &&
      (mode === undefined || sample.mode === mode),
  );
}

export function summarize(samples, bindings) {
  const candidates = Object.fromEntries(
    CANDIDATES.map((candidate) => {
      const all = samplesFor(samples, candidate);
      const candidateHardGates = all[0].candidateHardGates ?? {};
      invariant(
        all.every((sample) =>
          sameJson(sample.candidateHardGates ?? {}, candidateHardGates),
        ),
        `${candidate} hard-gate observations changed between samples`,
      );
      return [
        candidate,
        {
          absoluteHardGates: {
            coldP50:
              distribution(
                samplesFor(samples, candidate, "cold").map(
                  (sample) => sample.launchMs,
                ),
              ).p50 <= 1_500,
            coldP95:
              distribution(
                samplesFor(samples, candidate, "cold").map(
                  (sample) => sample.launchMs,
                ),
              ).p95 <= 3_000,
            inputP75:
              distribution(all.map((sample) => sample.inputToPaintMs)).p75 <=
              33,
            inputP95:
              distribution(all.map((sample) => sample.inputToPaintMs)).p95 <=
              50,
            runtimeToUiP95:
              distribution(all.map((sample) => sample.runtimeToUiMs)).p95 <=
              100,
            shutdownMax:
              distribution(all.map((sample) => sample.shutdownMs)).max <=
              SHUTDOWN_BUDGET_MS,
            warmP95:
              distribution(
                samplesFor(samples, candidate, "warm").map(
                  (sample) => sample.launchMs,
                ),
              ).p95 <= 1_000,
            zeroOrphan: true,
          },
          candidateHardGates,
          coldLaunchMs: distribution(
            samplesFor(samples, candidate, "cold").map(
              (sample) => sample.launchMs,
            ),
          ),
          inputToPaintMs: distribution(
            all.map((sample) => sample.inputToPaintMs),
          ),
          packagedPayloadBytes: bindings[candidate].releasePackage.totalBytes,
          runtimeToUiMs: distribution(
            all.map((sample) => sample.runtimeToUiMs),
          ),
          shutdownMs: distribution(all.map((sample) => sample.shutdownMs)),
          trackedRssBytes: distribution(
            all
              .map((sample) => sample.trackedRssBytes)
              .filter((value) => value !== null),
          ),
          warmLaunchMs: distribution(
            samplesFor(samples, candidate, "warm").map(
              (sample) => sample.launchMs,
            ),
          ),
        },
      ];
    }),
  );
  return {
    candidates,
    formulas: {
      distribution:
        "nearest-rank percentile: sorted[ceil(p * n) - 1]; mean is arithmetic mean",
      slintImprovement: "(tauri - slint) / tauri",
      slintRegression: "(slint - tauri) / tauri",
    },
    rssComparison: {
      comparableForWinGate: false,
      reason:
        "Tauri shared WebKit XPC processes cannot be consistently attributed; tracked RSS is retained as diagnostic only.",
    },
  };
}

function stableResultIdentity(value) {
  return sha256(JSON.stringify(value));
}

async function harnessBinding(root) {
  const files = await Promise.all(
    HARNESS_FILES.map(async (repositoryPath) => {
      const bytes = await readFile(join(root, repositoryPath));
      return {
        bytes: bytes.length,
        path: repositoryPath,
        sha256: sha256(bytes),
      };
    }),
  );
  return {
    digest: stableResultIdentity(files),
    files,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
  };
}

export async function auditedHarnessBinding(
  root,
  rustcPath,
  build = buildDarwinSessionObserver,
) {
  return withDarwinSessionObserver(
    root,
    { rustcPath },
    async (sessionObserver) => ({
      ...(await harnessBinding(root)),
      sessionObserver: sessionObserver.binding,
    }),
    build,
  );
}

export function validateDiagnosticProvenance(environment, checkout) {
  const expected = {
    artifactFile: `.foundation-evaluation/diagnostic-${environment.KEIKO_FOUNDATION_RUNNER_LABEL}.json`,
    artifactName: `foundation-diagnostic-${environment.KEIKO_FOUNDATION_RUNNER_LABEL}`,
    commit: checkout.commit,
    kind: "github-actions-diagnostic",
    ref: "refs/heads/codex/11-foundation-macos-decision",
    repository: "oscharko-dev/Keiko-Native",
    workflowSha: checkout.commit,
  };
  const actual = {
    artifactFile: environment.KEIKO_FOUNDATION_ARTIFACT_FILE,
    artifactName: environment.KEIKO_FOUNDATION_ARTIFACT_NAME,
    commit: environment.GITHUB_SHA,
    kind: "github-actions-diagnostic",
    ref: environment.GITHUB_REF,
    repository: environment.GITHUB_REPOSITORY,
    workflowSha: environment.KEIKO_FOUNDATION_WORKFLOW_SHA,
  };
  invariant(
    sameJson(actual, expected),
    "diagnostic workflow provenance is unauthorized",
  );
  boundedString(environment.GITHUB_WORKFLOW_REF, "GITHUB_WORKFLOW_REF", 256);
  invariant(
    environment.GITHUB_WORKFLOW_REF.startsWith(
      `${expected.repository}/.github/workflows/foundation-evaluation.yml@${expected.ref}`,
    ),
    "diagnostic workflow ref is unauthorized",
  );
  invariant(/^\d+$/u.test(environment.GITHUB_RUN_ID), "run ID is invalid");
  invariant(
    /^[1-9]\d*$/u.test(environment.GITHUB_RUN_ATTEMPT),
    "run attempt is invalid",
  );
  return {
    ...actual,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
    runId: environment.GITHUB_RUN_ID,
    workflowRef: environment.GITHUB_WORKFLOW_REF,
  };
}

export function preparedSessionObserverFromEnvironment(environment) {
  const executable = boundedString(
    environment.KEIKO_FOUNDATION_SESSION_OBSERVER,
    "KEIKO_FOUNDATION_SESSION_OBSERVER",
    1_024,
  );
  const executableSha256 = boundedString(
    environment.KEIKO_FOUNDATION_SESSION_OBSERVER_SHA256,
    "KEIKO_FOUNDATION_SESSION_OBSERVER_SHA256",
    64,
  );
  const runnerTemp = boundedString(
    environment.RUNNER_TEMP,
    "RUNNER_TEMP",
    1_024,
  );
  invariant(
    executable.startsWith("/") && runnerTemp.startsWith("/"),
    "prepared session helper path is invalid",
  );
  invariant(
    /^[a-f0-9]{64}$/u.test(executableSha256),
    "prepared session helper digest is invalid",
  );
  const root = dirname(executable);
  const runnerRoot = realpathSync(runnerTemp);
  const preparedRoot = realpathSync(root);
  const relativeRoot = relative(runnerRoot, preparedRoot);
  invariant(
    relativeRoot !== "" &&
      relativeRoot !== ".." &&
      !relativeRoot.startsWith(`..${sep}`),
    "prepared session helper root is unauthorized",
  );
  return {
    executable,
    executableSha256,
    root,
  };
}

async function experimentBinding(
  root,
  checkout,
  { diagnostic = false, environment = process.env } = {},
) {
  const provenance = diagnostic
    ? validateDiagnosticProvenance(environment, checkout)
    : {
        authorityAssertion: "owner-m4-16gib-macos26",
        kind: "local-owner-authoritative",
      };
  return {
    checkoutTree: checkout.tree,
    contractVersion: 2,
    gitCommit: checkout.commit,
    issue: 11,
    provenance,
    readinessFingerprint: ISSUE_READINESS_FINGERPRINT,
  };
}

async function writeJsonAtomic(path, value, mode) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, path);
}

export async function benchmark(
  root,
  {
    diagnostic = false,
    quick = false,
    environment = process.env,
    onProgress = () => {},
  } = {},
) {
  invariant(!diagnostic || quick, "diagnostic timing must remain short");
  const checkout = await atEvaluationStage("checkout", () =>
    governedCheckout(root),
  );
  const counts = quick ? QUICK_COUNTS : FULL_COUNTS;
  const schedule = buildSchedule(counts);
  const observation = await atEvaluationStage("environment", () =>
    observeEnvironment({ diagnostic, environment }),
  );
  invariant(
    quick || !observation.virtual,
    "virtual timing cannot be authoritative",
  );
  const configuration = await atEvaluationStage("configuration", () =>
    loadConfiguration(root, environment),
  );
  const bindings = compactBindings(configuration);
  const experiment = await atEvaluationStage("provenance", () =>
    experimentBinding(root, checkout, {
      diagnostic,
      environment,
    }),
  );
  const harness = await atEvaluationStage("harness", () =>
    harnessBinding(root),
  );
  const candidateEvidence = {};
  const samples = [];
  const resultPath = resolve(
    environment.KEIKO_FOUNDATION_RESULT ??
      join(root, ".foundation-evaluation", "results.json"),
  );
  const partialPath = `${resultPath}.partial`;
  const rustcPath = boundedString(
    environment.KEIKO_FOUNDATION_RUSTC,
    "KEIKO_FOUNDATION_RUSTC",
    1_024,
  );
  invariant(rustcPath.startsWith("/"), "session helper rustc path is invalid");
  const prepared = diagnostic
    ? preparedSessionObserverFromEnvironment(environment)
    : undefined;
  return atEvaluationStage("session-observer", () =>
    withDarwinSessionObserver(
      root,
      { prepared, rustcPath },
      async (sessionObserver) => {
        harness.sessionObserver = sessionObserver.binding;
        for (const entry of schedule) {
          try {
            const run = await runCandidate(
              configuration[entry.candidate],
              entry,
              observation,
              {
                launchMode: diagnostic
                  ? "direct-executable"
                  : "launch-services",
                sessionObserver,
              },
            );
            candidateEvidence[run.sample.candidateEvidenceSha256] =
              run.evidencePayload;
            samples.push(run.sample);
          } catch (error) {
            const failure = sanitizedFailure(error, entry);
            await writeJsonAtomic(
              partialPath,
              {
                bindings,
                candidateEvidence,
                counts,
                environment: observation,
                evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
                experiment,
                failure,
                incomplete: true,
                quick,
                samples,
                schedule,
                harness,
              },
              0o600,
            );
            throw failureError(error, entry);
          }
          const completedPairs = samples.length / CANDIDATES.length;
          await writeJsonAtomic(
            partialPath,
            {
              bindings,
              candidateEvidence,
              counts,
              environment: observation,
              evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
              experiment,
              harness,
              incomplete: true,
              quick,
              samples,
              schedule,
            },
            0o600,
          );
          if (
            Number.isInteger(completedPairs) &&
            !quick &&
            completedPairs % 10 === 0
          )
            onProgress({
              completedPairs,
              totalPairs: schedule.length / CANDIDATES.length,
            });
        }
        const completedCheckout = await governedCheckout(root);
        invariant(
          sameJson(completedCheckout, checkout),
          "governed checkout changed during evaluation",
        );
        const resultCore = {
          bindings,
          candidateEvidence,
          counts,
          environment: observation,
          evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
          experiment,
          harness,
          quick,
          samples,
          schedule,
          summary: summarize(samples, bindings),
        };
        const result = {
          benchmarkId: stableResultIdentity(resultCore),
          ...resultCore,
        };
        invariant(
          redactionFailures(result, {
            home: userInfo().homedir,
            hostname: hostname(),
            username: userInfo().username,
          }).length === 0,
          "retained result failed redaction",
        );
        await writeJsonAtomic(resultPath, result, 0o600);
        await rm(partialPath, { force: true });
        return { result, resultPath };
      },
    ),
  );
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateRetainedSample(sample, expected) {
  plainObject(sample, "retained sample");
  invariant(
    sameJson(Object.keys(sample).toSorted(), [
      "candidate",
      "candidateEvidenceSha256",
      "candidateHardGates",
      "candidateRssBytes",
      "inputToPaintMs",
      "iteration",
      "launchMs",
      "mode",
      "runtimeToUiMs",
      "sequence",
      "shutdownMs",
      "trackedRssBytes",
    ]),
    "retained sample schema is not closed",
  );
  invariant(
    sample.sequence === expected.sequence,
    "retained sample sequence mismatch",
  );
  plainObject(sample.candidateHardGates, "retained candidate hard gates");
  validateTree(sample.candidateHardGates);
  invariant(
    sample.candidate === expected.candidate,
    "retained sample candidate mismatch",
  );
  invariant(sample.mode === expected.mode, "retained sample mode mismatch");
  invariant(
    sample.iteration === expected.iteration,
    "retained sample iteration mismatch",
  );
  invariant(
    typeof sample.candidateEvidenceSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(sample.candidateEvidenceSha256),
    "retained sample evidence digest is invalid",
  );
  for (const field of [
    "inputToPaintMs",
    "launchMs",
    "runtimeToUiMs",
    "shutdownMs",
  ])
    finiteMetric(sample[field], `retained sample ${field}`);
  invariant(
    sample.trackedRssBytes === null ||
      (Number.isSafeInteger(sample.trackedRssBytes) &&
        sample.trackedRssBytes > 0),
    "retained sample tracked RSS is invalid",
  );
  invariant(
    sample.candidateRssBytes === null ||
      (Number.isSafeInteger(sample.candidateRssBytes) &&
        sample.candidateRssBytes > 0),
    "retained sample candidate RSS is invalid",
  );
}

function closedKeys(value, keys, label) {
  plainObject(value, label);
  invariant(
    sameJson(Object.keys(value).toSorted(), keys.toSorted()),
    `${label} schema is not closed`,
  );
}

function allTrue(value, label) {
  plainObject(value, label);
  invariant(
    Object.values(value).every((entry) => entry === true),
    `${label} contains a failed outcome`,
  );
}

function closedAllTrue(value, keys, label) {
  closedKeys(value, keys, label);
  allTrue(value, label);
}

function validateRetainedHardGate(value, label) {
  const keys =
    value?.limitation === undefined
      ? ["code", "passed"]
      : ["code", "limitation", "passed"];
  closedKeys(value, keys, label);
  boundedString(value.code, `${label} code`, 128);
  invariant(typeof value.passed === "boolean", `${label} result is invalid`);
  if (value.limitation !== undefined)
    boundedString(value.limitation, `${label} limitation`, 256);
}

function validateSanitizedCandidateEvidence(payload, expected) {
  const commonKeys = [
    "accessibility",
    "candidate",
    "candidateHardGates",
    "capabilities",
    "dependencies",
    "diagnostics",
    "environment",
    "fixture",
    "lifecycle",
    "mode",
    "nativeDialog",
    "performance",
    "processAccounting",
    "recovery",
    "schemaVersion",
    "security",
  ];
  closedKeys(payload, commonKeys, "sanitized candidate evidence");
  invariant(
    payload.schemaVersion === EVIDENCE_SCHEMA_VERSION,
    "sanitized candidate evidence schema is unsupported",
  );
  invariant(
    payload.candidate === expected.candidate && payload.mode === expected.mode,
    "sanitized candidate evidence schedule mismatch",
  );
  closedKeys(
    payload.environment,
    ["architecture", "osFamily", "referenceClass"],
    "sanitized candidate environment",
  );
  invariant(
    ["aarch64", "arm64"].includes(payload.environment.architecture) &&
      payload.environment.osFamily === "macos",
    "sanitized candidate environment mismatch",
  );
  boundedString(
    payload.environment.referenceClass,
    "sanitized reference class",
    128,
  );
  closedKeys(
    payload.performance,
    ["candidateRssBytes", "inputToPaintMs", "runtimeToUiMs"],
    "sanitized candidate performance",
  );
  finiteMetric(payload.performance.inputToPaintMs, "retained input-to-paint");
  finiteMetric(payload.performance.runtimeToUiMs, "retained runtime-to-UI");
  invariant(
    payload.performance.candidateRssBytes === null ||
      (Number.isSafeInteger(payload.performance.candidateRssBytes) &&
        payload.performance.candidateRssBytes > 0),
    "retained candidate RSS is invalid",
  );
  closedKeys(
    payload.dependencies,
    ["frontend", "host", "renderer", "rust"],
    "sanitized candidate dependencies",
  );
  for (const [name, value] of Object.entries(payload.dependencies))
    boundedString(value, `sanitized candidate dependency ${name}`, 128);
  closedKeys(
    payload.processAccounting,
    ["definition", "limitation", "rssComparableForWinGate"],
    "sanitized process accounting",
  );
  invariant(
    payload.processAccounting.rssComparableForWinGate === false,
    "sanitized RSS comparability must fail closed",
  );
  validateTree(payload.candidateHardGates);
  if (expected.candidate === "tauri") {
    closedKeys(
      payload.accessibility,
      ["axeRuleIds", "axeViolationCount", "semanticJourneyAccepted"],
      "Tauri accessibility evidence",
    );
    invariant(
      payload.accessibility.axeViolationCount === 0 &&
        sameJson(payload.accessibility.axeRuleIds, []) &&
        payload.accessibility.semanticJourneyAccepted === true,
      "Tauri accessibility evidence failed",
    );
    closedAllTrue(
      payload.capabilities,
      ["pingAccepted", "rendererPrepared", "shellStable"],
      "Tauri capability evidence",
    );
    closedAllTrue(
      payload.fixture,
      RETAINED_FIXTURE_KEYS,
      "Tauri fixture evidence",
    );
    closedAllTrue(
      payload.lifecycle,
      [
        "hostSurvived",
        "instanceDistinct",
        "rendererCycleAccepted",
        "rendererRecreated",
      ],
      "Tauri lifecycle evidence",
    );
    closedAllTrue(
      payload.nativeDialog,
      ["accepted"],
      "Tauri native-dialog evidence",
    );
    closedAllTrue(
      payload.recovery,
      ["runtimeEventAccepted", "runtimeEventCommitted"],
      "Tauri recovery evidence",
    );
    closedKeys(
      payload.security,
      [
        "cancelled",
        "invalidRequestCount",
        "oversizedRejected",
        "probeAclDenied",
        "replayRejected",
        "timedOut",
      ],
      "Tauri security evidence",
    );
    invariant(
      payload.security.invalidRequestCount >= 2,
      "Tauri invalid-request evidence is incomplete",
    );
    allTrue(
      Object.fromEntries(
        Object.entries(payload.security).filter(
          ([name]) => name !== "invalidRequestCount",
        ),
      ),
      "Tauri security evidence",
    );
    invariant(
      sameJson(payload.candidateHardGates, {}),
      "Tauri candidate gates are invalid",
    );
  } else {
    closedKeys(
      payload.accessibility,
      ["nativeSemanticTreeAutomation"],
      "Slint accessibility evidence",
    );
    closedAllTrue(
      payload.capabilities,
      ["accepted", "finishAccepted"],
      "Slint capability evidence",
    );
    closedAllTrue(
      payload.fixture,
      RETAINED_FIXTURE_KEYS,
      "Slint fixture evidence",
    );
    closedAllTrue(
      payload.lifecycle,
      [
        "firstDestroyed",
        "firstLoaded",
        "hostSurvived",
        "instanceDistinct",
        "portAccepted",
        "secondDestroyed",
        "secondLoaded",
      ],
      "Slint lifecycle evidence",
    );
    closedAllTrue(
      payload.nativeDialog,
      ["accepted"],
      "Slint native-dialog evidence",
    );
    closedAllTrue(
      payload.recovery,
      ["recovered", "unavailableFailedClosed"],
      "Slint recovery evidence",
    );
    closedAllTrue(
      payload.security,
      ["cancelled", "hostile", "oversized", "replay", "timeout", "unknown"],
      "Slint security evidence",
    );
    closedKeys(
      payload.candidateHardGates,
      [
        "nativeSemanticTreeAutomation",
        "royaltyFreeLicenceAttribution",
        "signedUpdateRecipe",
      ],
      "Slint candidate hard gates",
    );
    invariant(
      sameJson(
        payload.accessibility.nativeSemanticTreeAutomation,
        payload.candidateHardGates.nativeSemanticTreeAutomation,
      ),
      "Slint accessibility hard gate is inconsistent",
    );
    for (const [name, gate] of Object.entries(payload.candidateHardGates))
      validateRetainedHardGate(gate, `Slint hard gate ${name}`);
  }
  closedKeys(
    payload.diagnostics,
    [
      "appearanceAccepted",
      "compositionAccepted",
      "focusAccepted",
      "scaleFactor",
    ],
    "client diagnostic evidence",
  );
  invariant(
    payload.diagnostics.appearanceAccepted === true &&
      payload.diagnostics.compositionAccepted === true &&
      payload.diagnostics.focusAccepted === true &&
      finiteMetric(payload.diagnostics.scaleFactor, "retained scale") > 0,
    "client diagnostic evidence failed",
  );
  invariant(
    redactionFailures(payload).length === 0,
    "sanitized candidate evidence contains prohibited local data",
  );
}

export function validateCandidateEvidenceMap(
  candidateEvidence,
  samples,
  schedule,
) {
  plainObject(candidateEvidence, "candidate evidence map");
  const referenced = new Set();
  samples.forEach((sample, index) => {
    const digest = sample.candidateEvidenceSha256;
    const payload = candidateEvidence[digest];
    invariant(payload !== undefined, "retained candidate evidence is missing");
    invariant(
      sha256(JSON.stringify(payload)) === digest,
      "retained candidate evidence digest mismatch",
    );
    validateSanitizedCandidateEvidence(payload, schedule[index]);
    invariant(
      sameJson(payload.candidateHardGates, sample.candidateHardGates) &&
        payload.performance.candidateRssBytes === sample.candidateRssBytes &&
        payload.performance.inputToPaintMs === sample.inputToPaintMs &&
        payload.performance.runtimeToUiMs === sample.runtimeToUiMs,
      "retained candidate evidence does not match its sample",
    );
    referenced.add(digest);
  });
  invariant(
    referenced.size === Object.keys(candidateEvidence).length,
    "retained candidate evidence contains unreferenced payloads",
  );
}

export async function audit(root, environment = process.env) {
  const checkout = await governedCheckout(root);
  const resultPath = resolve(
    environment.KEIKO_FOUNDATION_RESULT ??
      join(root, ".foundation-evaluation", "results.json"),
  );
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  closedKeys(
    result,
    [
      "benchmarkId",
      "bindings",
      "candidateEvidence",
      "counts",
      "environment",
      "evidenceSchemaVersion",
      "experiment",
      "harness",
      "quick",
      "samples",
      "schedule",
      "summary",
    ],
    "retained benchmark",
  );
  invariant(
    result.evidenceSchemaVersion === EVIDENCE_SCHEMA_VERSION,
    "retained evidence schema is unsupported",
  );
  invariant(result.quick === false, "quick evidence cannot satisfy the audit");
  invariant(
    sameJson(result.counts, FULL_COUNTS),
    "retained sample counts are not authoritative",
  );
  const schedule = buildSchedule(FULL_COUNTS);
  invariant(
    sameJson(result.schedule, schedule),
    "retained schedule is stale or mismatched",
  );
  invariant(
    result.samples.length === schedule.length,
    "retained sample total is incomplete",
  );
  result.samples.forEach((sample, index) =>
    validateRetainedSample(sample, schedule[index]),
  );
  validateCandidateEvidenceMap(
    result.candidateEvidence,
    result.samples,
    schedule,
  );
  const observation = observeEnvironment({ environment });
  invariant(
    !observation.virtual && sameJson(result.environment, observation),
    "retained environment is stale or non-authoritative",
  );
  const configuration = await loadConfiguration(root, environment);
  const bindings = compactBindings(configuration);
  invariant(
    sameJson(result.bindings, bindings),
    "retained source, lock, or package bindings are stale",
  );
  const currentExperiment = await experimentBinding(root, checkout, {
    environment,
  });
  const rustcPath = boundedString(
    environment.KEIKO_FOUNDATION_RUSTC,
    "KEIKO_FOUNDATION_RUSTC",
    1_024,
  );
  invariant(rustcPath.startsWith("/"), "session helper rustc path is invalid");
  const currentHarness = await auditedHarnessBinding(root, rustcPath);
  invariant(
    sameJson(result.experiment, currentExperiment),
    "retained experiment commit or readiness fingerprint is stale",
  );
  invariant(
    sameJson(result.harness, currentHarness),
    "retained harness or schema binding is stale",
  );
  invariant(
    sameJson(result.summary, summarize(result.samples, bindings)),
    "retained distributions or formulas are stale",
  );
  const { benchmarkId, ...resultCore } = result;
  invariant(
    benchmarkId === stableResultIdentity(resultCore),
    "retained benchmark identity mismatch",
  );
  invariant(
    redactionFailures(result, {
      home: userInfo().homedir,
      hostname: hostname(),
      username: userInfo().username,
    }).length === 0,
    "retained result failed redaction",
  );
  const exportPath = resolve(
    environment.KEIKO_FOUNDATION_EXPORT ??
      join(root, "docs", "evaluation", "foundation-benchmark.json"),
  );
  await writeJsonAtomic(exportPath, result, 0o644);
  return { exportPath, result };
}

export async function verify(root, environment = process.env) {
  await governedCheckout(root);
  const configuration = await loadConfiguration(root, environment);
  return {
    candidates: Object.fromEntries(
      CANDIDATES.map((candidate) => [
        candidate,
        {
          lockCount: configuration[candidate].locks.length,
          packageDigest: configuration[candidate].package.digest,
          releaseHookScan: configuration[candidate].releaseHookScan,
          releaseCompositionProof:
            configuration[candidate].releaseCompositionProof,
          releasePackageDigest: configuration[candidate].releasePackage.digest,
          sourceDigest: configuration[candidate].source.digest,
        },
      ]),
    ),
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
  };
}
