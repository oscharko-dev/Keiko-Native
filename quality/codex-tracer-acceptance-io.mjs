import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import {
  hardenedGitArguments,
  noReplaceGitEnvironment,
} from "./git-integrity.mjs";
import { compareCodeUnits } from "./deterministic-order.mjs";
import { evidenceFailures, redactionMatches } from "./native-contract.mjs";
import {
  acceptanceBudgetLimits,
  acceptanceJourneyContract,
  acceptancePackageInspectionContract,
  acceptancePhysicalContract,
} from "./codex-tracer-acceptance.mjs";
import {
  compileTracerAccessibility,
  percentile95,
  runPackagedTracerJourney,
  waitForTracerAccessibilityAction,
} from "./codex-tracer-accessibility.mjs";
import {
  authenticateOwnedProcessGroup,
  compileProcessGroupInspector,
  processCleanupDependencies,
  terminateOwnedProcess,
} from "./macos-accessibility-driver-harness.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "native/target/keiko-native-package");
const packageExecutable = join(
  packageRoot,
  "Keiko Native.app/Contents/MacOS/keiko-native-desktop",
);
const runtimeBinary = join(
  tmpdir(),
  "keiko-codex-0.145.0-runtime/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
);
const runtimeHome = join(tmpdir(), "keiko-codex-0.145.0-home-v104");
const physicalObservationPath = join(
  tmpdir(),
  "keiko-native-codex-tracer-104-observation.json",
);
const acceptanceProcessEnvironmentKeys = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
  "__CF_USER_TEXT_ENCODING",
]);

const acceptedEnvironment = Object.freeze({
  architecture: "arm64",
  authStatus: "Logged in using ChatGPT",
  nodeVersion: "24.18.0",
  npmVersion: "11.16.0",
  platform: "darwin",
  promptBytes: 182,
  promptSha256:
    "e1a92579b1ca673135331829beb97792c1289a6bccdfe0303302256c546960f6",
  runtimeSha256:
    "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
  runtimeVersion: "codex-cli 0.145.0",
});

const packagePaths = Object.freeze([
  ["Contents/Info.plist", "0644"],
  ["Contents/MacOS/keiko-native-desktop", "0755"],
  ["Contents/Resources/THIRD-PARTY-NOTICES.json", "0644"],
]);

export function acceptanceEnvironmentFailures(environment) {
  const failures = [];
  if (
    typeof environment !== "object" ||
    environment === null ||
    Array.isArray(environment) ||
    JSON.stringify(Object.keys(environment).toSorted(compareCodeUnits)) !==
      JSON.stringify(
        Object.keys(acceptedEnvironment).toSorted(compareCodeUnits),
      )
  ) {
    failures.push("environment-fields");
  }
  for (const [key, value] of Object.entries(acceptedEnvironment)) {
    if (environment?.[key] !== value) failures.push(`environment-${key}`);
  }
  return failures;
}

function manifestFailures(manifest, sourceRevision, executableSha256) {
  const failures = [];
  const expectedKeys = [
    "inventory",
    "platform",
    "policySha256",
    "redaction",
    "schema",
    "sourceRevision",
    "target",
  ].toSorted(compareCodeUnits);
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    JSON.stringify(Object.keys(manifest).toSorted(compareCodeUnits)) !==
      JSON.stringify(expectedKeys)
  ) {
    failures.push("package-manifest-fields");
  }
  if (manifest?.schema !== "keiko-native-package-manifest/v1")
    failures.push("package-manifest-schema");
  if (manifest?.sourceRevision !== sourceRevision)
    failures.push("package-manifest-revision");
  if (manifest?.target !== "keiko-native-desktop")
    failures.push("package-manifest-target");
  if (manifest?.platform !== "macos-arm64")
    failures.push("package-manifest-platform");
  if (!SHA256_PATTERN.test(manifest?.policySha256 ?? ""))
    failures.push("package-manifest-policy-digest");
  if (manifest?.redaction !== "closed")
    failures.push("package-manifest-redaction");
  if (!Array.isArray(manifest?.inventory)) {
    failures.push("package-manifest-inventory");
    return failures;
  }
  if (manifest.inventory.length !== packagePaths.length)
    failures.push("package-manifest-inventory");
  for (const [index, [path, mode]] of packagePaths.entries()) {
    const entry = manifest.inventory[index];
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      JSON.stringify(Object.keys(entry).toSorted(compareCodeUnits)) !==
        JSON.stringify(["mode", "path", "sha256"])
    ) {
      failures.push(`package-manifest-entry-${index}`);
      continue;
    }
    if (
      entry.path !== path ||
      entry.mode !== mode ||
      !SHA256_PATTERN.test(entry.sha256)
    ) {
      failures.push(`package-manifest-entry-${index}`);
    }
  }
  const executable = manifest.inventory.find(
    ({ path }) => path === "Contents/MacOS/keiko-native-desktop",
  );
  if (executable?.sha256 !== executableSha256)
    failures.push("package-executable-binding");
  return failures;
}

export function packageArtifactFailures({
  executableSha256,
  manifest,
  packageManifestSha256,
  shellEvidence,
  sourceRevision,
}) {
  const failures = [];
  if (!REVISION_PATTERN.test(sourceRevision ?? ""))
    failures.push("package-source-revision");
  if (!SHA256_PATTERN.test(executableSha256 ?? ""))
    failures.push("package-executable-digest");
  if (!SHA256_PATTERN.test(packageManifestSha256 ?? ""))
    failures.push("package-manifest-digest");
  failures.push(
    ...manifestFailures(manifest, sourceRevision, executableSha256),
    ...evidenceFailures(shellEvidence, {
      cargoLockSha256: shellEvidence?.cargoLockSha256,
      foundationReadinessFingerprint:
        shellEvidence?.foundationReadinessFingerprint,
      npmLockSha256: shellEvidence?.npmLockSha256,
      packageManifestSha256,
      readinessFingerprint: shellEvidence?.readinessFingerprint,
      sourceRevision,
    }).map((failure) => `foundation-${failure}`),
  );
  return failures;
}

export function physicalObservationFailures(
  observation,
  expected,
  nowMs = Date.now(),
) {
  const failures = [];
  const expectedKeys = [
    "appearance",
    "observedAt",
    "observations",
    "packageExecutableSha256",
    "redaction",
    "schemaVersion",
    "sourceRevision",
  ].toSorted(compareCodeUnits);
  if (
    typeof observation !== "object" ||
    observation === null ||
    Array.isArray(observation) ||
    JSON.stringify(Object.keys(observation).toSorted(compareCodeUnits)) !==
      JSON.stringify(expectedKeys)
  ) {
    failures.push("physical-observation-fields");
  }
  if (
    observation?.schemaVersion !==
    "keiko-native-codex-tracer-physical-observation/v1"
  ) {
    failures.push("physical-observation-schema");
  }
  if (observation?.sourceRevision !== expected?.sourceRevision)
    failures.push("physical-observation-revision-binding");
  if (
    observation?.packageExecutableSha256 !== expected?.packageExecutableSha256
  ) {
    failures.push("physical-observation-package-binding");
  }
  const observedAtMs = Date.parse(observation?.observedAt ?? "");
  if (
    !Number.isSafeInteger(observedAtMs) ||
    new Date(observedAtMs).toISOString() !== observation?.observedAt ||
    observedAtMs < nowMs - 60 * 60 * 1_000 ||
    observedAtMs > nowMs + 5 * 60 * 1_000
  ) {
    failures.push("physical-observation-freshness");
  }
  if (
    JSON.stringify(observation?.appearance) !==
    JSON.stringify(acceptancePhysicalContract.appearance)
  ) {
    failures.push("physical-observation-appearance");
  }
  const expectedObservations =
    acceptancePhysicalContract.irreducibleObservations.map((checkpoint) => ({
      checkpoint,
      status: "observed",
    }));
  if (
    JSON.stringify(observation?.observations) !==
    JSON.stringify(expectedObservations)
  ) {
    failures.push("physical-observation-checkpoints");
  }
  if (observation?.redaction !== "closed")
    failures.push("physical-observation-redaction");
  if (redactionMatches(JSON.stringify(observation)).length > 0)
    failures.push("physical-observation-sensitive-content");
  return failures;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function selectCommandOutput(result, channel = "stdout") {
  if (channel !== "stdout" && channel !== "stderr")
    throw new TypeError("acceptance-output-channel-invalid");
  return String(result?.[channel] ?? "").trim();
}

export function acceptanceProcessEnvironment(
  environment = process.env,
  explicitBindings = {},
) {
  const selected = {};
  for (const key of acceptanceProcessEnvironmentKeys) {
    const value = environment[key];
    if (typeof value === "string" && value.length > 0) selected[key] = value;
  }
  for (const [key, value] of Object.entries(explicitBindings)) {
    if (typeof value !== "string" || value.length === 0)
      throw new TypeError("acceptance-process-environment-invalid");
    selected[key] = value;
  }
  return selected;
}

function run(command, args, options = {}) {
  const environment =
    options.inheritEnvironment === false
      ? acceptanceProcessEnvironment(process.env, options.env)
      : { ...process.env, ...options.env };
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: noReplaceGitEnvironment(environment),
    maxBuffer: 50 * 1024 * 1024,
    shell: false,
  });
  if (result.status !== 0 || result.error)
    throw new Error("acceptance-subprocess-failed");
  return selectCommandOutput(result, options.output);
}

function exactNpmVersion() {
  const npmExecPath = process.env.npm_execpath;
  if (typeof npmExecPath !== "string" || npmExecPath.length === 0)
    throw new Error("acceptance-npm-unavailable");
  return run(process.execPath, [npmExecPath, "--version"]);
}

function packageAcceptance() {
  const npmExecPath = process.env.npm_execpath;
  if (typeof npmExecPath !== "string" || npmExecPath.length === 0)
    throw new Error("acceptance-npm-unavailable");
  run(process.execPath, [npmExecPath, "run", "--silent", "acceptance:macos"]);
}

async function inspectEnvironment({ binary, home }) {
  const [runtimeBytes, promptBytes] = await Promise.all([
    readFile(binary),
    readFile(
      join(
        repositoryRoot,
        "quality/fixtures/codex-tracer/no-effect-prompt.txt",
      ),
    ),
  ]);
  return {
    architecture: process.arch,
    authStatus: run(
      binary,
      ["-c", 'cli_auth_credentials_store="keyring"', "login", "status"],
      {
        env: { CODEX_HOME: home },
        inheritEnvironment: false,
        output: "stderr",
      },
    ),
    nodeVersion: process.versions.node,
    npmVersion: exactNpmVersion(),
    platform: process.platform,
    promptBytes: promptBytes.byteLength,
    promptSha256: sha256(promptBytes),
    runtimeSha256: sha256(runtimeBytes),
    runtimeVersion: run(binary, ["--version"], {
      inheritEnvironment: false,
    }),
  };
}

async function inspectPackage(sourceRevision) {
  const [manifestBytes, shellEvidenceBytes, executableBytes] =
    await Promise.all([
      readFile(join(packageRoot, "package-manifest.json")),
      readFile(join(packageRoot, "acceptance-evidence.json")),
      readFile(packageExecutable),
    ]);
  const inspected = {
    executableSha256: sha256(executableBytes),
    manifest: JSON.parse(manifestBytes),
    packageManifestSha256: sha256(manifestBytes),
    shellEvidence: JSON.parse(shellEvidenceBytes),
    sourceRevision,
  };
  if (packageArtifactFailures(inspected).length > 0)
    throw new Error("acceptance-package-invalid");
  const packageText = Buffer.concat([
    manifestBytes,
    shellEvidenceBytes,
    executableBytes,
  ]).toString("latin1");
  for (const marker of [
    "AXUIElement",
    "macos-accessibility-driver",
    "run-codex-tracer-acceptance",
    "KeikoAccessibilityEvaluation",
  ]) {
    if (packageText.includes(marker))
      throw new Error("acceptance-package-test-hook");
  }
  const containmentMarkers = [
    "features.multi_agent=false",
    "features.multi_agent_v2=false",
    "tools.experimental_request_user_input.enabled=false",
    "runtimeWorkspaceRoots",
    "dynamicTools",
    "selectedCapabilityRoots",
  ];
  if (containmentMarkers.some((marker) => !packageText.includes(marker)))
    throw new Error("acceptance-package-containment-unbound");
  return { ...inspected, containmentMarkers };
}

async function snapshotDirectory(root) {
  const digest = createHash("sha256");
  let bytes = 0;
  let entries = 0;
  async function visit(directory, prefix = "") {
    const children = (
      await readdir(directory, { withFileTypes: true })
    ).toSorted((left, right) => compareCodeUnits(left.name, right.name));
    for (const child of children) {
      const relativePath =
        prefix === "" ? child.name : `${prefix}/${child.name}`;
      digest.update(relativePath, "utf8");
      digest.update("\0", "utf8");
      entries += 1;
      if (child.isDirectory()) {
        digest.update("directory\0", "utf8");
        await visit(join(directory, child.name), relativePath);
      } else if (child.isFile()) {
        const content = await readFile(join(directory, child.name));
        bytes += content.length;
        digest.update("file\0", "utf8");
        digest.update(content);
      } else {
        throw new Error("acceptance-snapshot-entry-invalid");
      }
      digest.update("\0", "utf8");
    }
  }
  await visit(root);
  return { bytes, entries, sha256: digest.digest("hex") };
}

export function observedSafeguards({
  containmentMarkers,
  journey,
  packageInspection,
  residualProcesses,
  runtimeAfter,
  runtimeBefore,
  workspaceAfter,
  workspaceBefore,
}) {
  const journeyRows = journey.timings.map(({ action }) => action);
  const serializedJourney = JSON.stringify(journey);
  const repositoryContextBytes = Buffer.byteLength(serializedJourney, "utf8");
  const fixedJourneyRows = 36;
  const cleanRuntime = conditionsMet(
    runtimeBefore.entries === 0,
    runtimeAfter.entries === 0,
    runtimeBefore.bytes === 0,
    runtimeAfter.bytes === 0,
  );
  const unchangedWorkspace = conditionsMet(
    workspaceBefore.sha256 === workspaceAfter.sha256,
    workspaceBefore.entries === workspaceAfter.entries,
    workspaceBefore.bytes === workspaceAfter.bytes,
  );
  return {
    acceptedEffects: failureCount(
      journey.status === "passed",
      unchangedWorkspace,
    ),
    configurableMultiAgentCapabilities: failureCount(
      containmentMarkers.includes("features.multi_agent=false"),
      containmentMarkers.includes("features.multi_agent_v2=false"),
    ),
    environmentTools: failureCount(
      containmentMarkers.includes("runtimeWorkspaceRoots"),
      containmentMarkers.includes("dynamicTools"),
      containmentMarkers.includes("selectedCapabilityRoots"),
    ),
    hiddenRetries: failureCount(journeyRows.length === fixedJourneyRows),
    inputRequestCapabilities: failureCount(
      containmentMarkers.includes(
        "tools.experimental_request_user_input.enabled=false",
      ),
    ),
    localToolRequests: failureCount(cleanRuntime, unchangedWorkspace),
    manualOnlyAutomatableCheckpoints:
      acceptanceJourneyContract.manualOnlyAutomatableCheckpoints,
    missingJourneyRows: Math.abs(fixedJourneyRows - journeyRows.length),
    mockOnlyClaims: acceptanceJourneyContract.mockOnlyClaims,
    packageTestHooks: packageInspection.testHookMarkers,
    providerEffectOwnerCrossings: failureCount(
      cleanRuntime,
      unchangedWorkspace,
      residualProcesses === 0,
    ),
    providerEventQuarantineMaximum: 64,
    redactionMatches: redactionMatches(serializedJourney).length,
    repositoryBytesInEvidence: repositoryEvidenceBytes(
      serializedJourney,
      repositoryContextBytes,
    ),
    repositoryContextBytesToRuntime: unchangedWorkspace
      ? 0
      : workspaceAfter.bytes,
    residualProcesses,
    unquarantinedProviderEvents: failureCount(
      journey.status === "passed",
      cleanRuntime,
    ),
  };
}

function failureCount(...conditions) {
  return Number(!conditionsMet(...conditions));
}

function conditionsMet(...conditions) {
  return conditions.every(Boolean);
}

function repositoryEvidenceBytes(serializedJourney, bytes) {
  return bytes > 0 && !serializedJourney.includes("KeikoAcceptanceIdentity104")
    ? 0
    : bytes;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processExists(pid);
}

function parseProcessRow(line) {
  const [pidText, ppidText, pgidText, ...commandParts] = line
    .trim()
    .split(/\s+/u);
  if (
    !/^\d+$/u.test(pidText ?? "") ||
    !/^\d+$/u.test(ppidText ?? "") ||
    !/^\d+$/u.test(pgidText ?? "") ||
    commandParts.length === 0
  ) {
    return null;
  }
  return {
    command: commandParts.join(" "),
    pgid: Number.parseInt(pgidText, 10),
    pid: Number.parseInt(pidText, 10),
    ppid: Number.parseInt(ppidText, 10),
  };
}

export function selectOwnedStagedRuntime(
  processes,
  { appPid, runtimeWorkRoot },
) {
  const matches = processes.flatMap((process) => {
    const separator = process.command.indexOf(" ");
    const executable =
      separator === -1 ? process.command : process.command.slice(0, separator);
    const parts = posix.relative(runtimeWorkRoot, executable).split("/");
    const ownedTurn = new RegExp(`^turn-${appPid}-[1-9][0-9]*$`, "u");
    return process.ppid === appPid &&
      process.pgid === process.pid &&
      parts.length === 2 &&
      ownedTurn.test(parts[0]) &&
      parts[1] === "verified-codex-runtime"
      ? [{ ...process, executable }]
      : [];
  });
  return matches.length === 1 ? matches[0] : null;
}

export async function verifyOwnedRuntimeGroupsExited(
  ownerships,
  cleanupDependencies,
) {
  if (!Array.isArray(ownerships) || ownerships.length === 0)
    throw new TypeError("acceptance-owned-runtime-evidence-invalid");
  const verificationDependencies = {
    ...cleanupDependencies,
    signalProcess: () => {
      throw new Error("acceptance-owned-runtime-residual");
    },
  };
  for (const ownership of ownerships) {
    if (
      (await terminateOwnedProcess(ownership, verificationDependencies)) !== 0
    ) {
      throw new Error("acceptance-owned-runtime-residual");
    }
  }
  return ownerships.length;
}

async function authenticateOwnedStagedRuntime({
  appPid,
  cleanupDependencies,
  expectedRuntimeSha256,
  runtimeWorkRoot,
}) {
  const processes = run("/bin/ps", ["-axo", "pid=,ppid=,pgid=,command="])
    .split("\n")
    .map(parseProcessRow)
    .filter(Boolean);
  const runtime = selectOwnedStagedRuntime(processes, {
    appPid,
    runtimeWorkRoot,
  });
  if (runtime === null) throw new Error("acceptance-runtime-ownership-invalid");
  const canonicalExecutable = await realpath(runtime.executable).catch(
    () => null,
  );
  if (
    canonicalExecutable !== runtime.executable ||
    sha256(await readFile(runtime.executable)) !== expectedRuntimeSha256
  ) {
    throw new Error("acceptance-runtime-ownership-invalid");
  }
  return authenticateOwnedProcessGroup(
    { pid: runtime.pid },
    cleanupDependencies,
  );
}

async function crashOwnedRuntime(options) {
  const ownership = await authenticateOwnedStagedRuntime(options);
  process.kill(-ownership.processGroupId, "SIGKILL");
}

async function createIdentityWorkspace(prefix) {
  const root = await mkdtemp(join(homedir(), "Documents", prefix));
  await chmod(root, 0o700);
  await mkdir(join(root, ".git"), { mode: 0o700 });
  return root;
}

function launchPackagedApp(internal) {
  return spawn(internal.packageExecutable, [], {
    detached: true,
    env: acceptanceProcessEnvironment(process.env, {
      KEIKO_CODEX_0_145_0_BINARY: internal.runtimeBinary,
      KEIKO_CODEX_0_145_0_HOME: internal.runtimeHome,
      KEIKO_CODEX_0_145_0_WORK_ROOT: internal.runtimeWorkRoot,
    }),
    stdio: "ignore",
  });
}

export async function measureFirstVisibleP95(
  internal,
  adapterBinary,
  cleanupDependencies,
  dependencies = {},
) {
  const authenticate =
    dependencies.authenticate ?? authenticateOwnedProcessGroup;
  const launch = dependencies.launch ?? launchPackagedApp;
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const observe = dependencies.observe ?? waitForTracerAccessibilityAction;
  const terminate = dependencies.terminate ?? terminateOwnedProcess;
  const waitForExit = dependencies.waitForExit ?? waitForProcessExit;
  const observations = [];
  for (
    let repetition = 0;
    repetition < acceptanceBudgetLimits.firstVisibleKeikoOverheadSamples;
    repetition += 1
  ) {
    const startedAt = monotonicNow();
    const child = launch(internal);
    const ownership = await authenticate(child, cleanupDependencies);
    try {
      const visible = await observe({
        action: "probe-start",
        binary: adapterBinary,
        pid: child.pid,
        timeoutMs: 5_000,
      });
      if (visible.status !== "passed")
        throw new Error("acceptance-first-visible-failed");
      const elapsedMs = Math.round(monotonicNow() - startedAt);
      if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0)
        throw new Error("acceptance-first-visible-measurement-invalid");
      observations.push(elapsedMs);
      const quit = await observe({
        action: "quit",
        binary: adapterBinary,
        pid: child.pid,
        timeoutMs: 5_000,
      });
      if (quit.status !== "passed" || !(await waitForExit(child.pid, 5_000)))
        throw new Error("acceptance-first-visible-cleanup-failed");
    } finally {
      await terminate(ownership, cleanupDependencies);
    }
  }
  return percentile95(observations);
}

export function createCodexTracerAcceptanceIo() {
  return {
    async preparePackage() {
      const runtime = await canonicalRuntimeResources({
        binary: runtimeBinary,
        home: runtimeHome,
      });
      const environment = await inspectEnvironment(runtime);
      if (acceptanceEnvironmentFailures(environment).length > 0)
        throw new Error("acceptance-environment-invalid");
      const sourceRevision = run(
        "git",
        hardenedGitArguments(["rev-parse", "HEAD"]),
      );
      if (!REVISION_PATTERN.test(sourceRevision))
        throw new Error("acceptance-source-revision-invalid");
      packageAcceptance();
      const inspected = await inspectPackage(sourceRevision);
      const runRoot = await canonicalRuntimeRoot(
        await mkdtemp(join(tmpdir(), "keiko-native-codex-tracer-104-")),
      );
      await chmod(runRoot, 0o700);
      const runtimeWorkRoot = join(runRoot, "runtime-work");
      await mkdir(runtimeWorkRoot, { mode: 0o700 });
      let workspaceRoot;
      let deniedWorkspaceRoot;
      try {
        workspaceRoot = await createIdentityWorkspace(
          "KeikoAcceptanceIdentity104",
        );
        deniedWorkspaceRoot = await createIdentityWorkspace(
          "KeikoAcceptanceIdentity104Denied",
        );
        await chmod(deniedWorkspaceRoot, 0o000);
      } catch {
        if (workspaceRoot !== undefined)
          await rm(workspaceRoot, { force: true, recursive: true });
        if (deniedWorkspaceRoot !== undefined) {
          await chmod(deniedWorkspaceRoot, 0o700).catch(() => undefined);
          await rm(deniedWorkspaceRoot, { force: true, recursive: true });
        }
        await rm(runRoot, { force: true, recursive: true });
        throw new Error("acceptance-workspace-fixture-unavailable");
      }
      const expected = {
        packageExecutableSha256: inspected.executableSha256,
        packageManifestSha256: inspected.packageManifestSha256,
        sourceRevision,
      };
      return {
        bindings: {
          authProfileClass: "human-provisioned-chatgpt-keyring",
          authorityProfile: "keiko-codex-no-effect-v1",
          containmentProfile: "keiko-codex-readiness-v1",
          experimentalSchemaSha256:
            "46c4414f08cdbb20e66ce4153ee1edcb865ed5fda67e59511a78939ddb7a82d1",
          issueReadinessFingerprint:
            "54a50110230af03db88acc3d503f038cb2e4a9557094fcff48ab19c01ee0af24",
          packageExecutableSha256: inspected.executableSha256,
          packageManifestSha256: inspected.packageManifestSha256,
          parentReadinessFingerprint:
            "ff404fd8d0f7b336b997da77e55c5a5abc8c8cab1639b8e708f0b5792c283347",
          promptSha256: acceptedEnvironment.promptSha256,
          runtimeArtifactSha256: acceptedEnvironment.runtimeSha256,
          runtimePackage: "@openai/codex",
          runtimeVersion: "0.145.0",
          sourceRevision,
          stableSchemaSha256:
            "27fc5257cdd29b97b2abb064caadec32a72b7567d6df26a7f82c5f452c8bdfb9",
        },
        expected,
        internal: {
          containmentMarkers: inspected.containmentMarkers,
          packageExecutable,
          packageRoot,
          deniedWorkspaceRoot,
          runRoot,
          runtimeBinary: runtime.binary,
          runtimeHome: runtime.home,
          runtimeWorkRoot,
          workspaceRoot,
        },
        packageInspection: structuredClone(acceptancePackageInspectionContract),
      };
    },
    async runProductionJourney(prepared) {
      return {
        runtimeBefore: await snapshotDirectory(
          prepared.internal.runtimeWorkRoot,
        ),
        safeguards: {},
        workspaceBefore: await snapshotDirectory(
          prepared.internal.workspaceRoot,
        ),
      };
    },
    async runPhysicalJourney(prepared, production) {
      const processInspectorRoot = join(
        prepared.internal.runRoot,
        "process-inspector",
      );
      await compileProcessGroupInspector(processInspectorRoot);
      const cleanupDependencies =
        processCleanupDependencies(processInspectorRoot);
      const adapter = await compileTracerAccessibility(
        join(prepared.internal.runRoot, "accessibility"),
      );
      const prompt = await readFile(
        join(
          repositoryRoot,
          "quality/fixtures/codex-tracer/no-effect-prompt.txt",
        ),
        "utf8",
      );
      const firstVisibleKeikoOverheadP95Ms = await measureFirstVisibleP95(
        prepared.internal,
        adapter.binary,
        cleanupDependencies,
      );
      const child = launchPackagedApp(prepared.internal);
      const ownership = await authenticateOwnedProcessGroup(
        child,
        cleanupDependencies,
      );
      const runtimeOwnerships = [];
      let cleaned = false;
      try {
        const journey = await runPackagedTracerJourney({
          crashRuntime: () =>
            crashOwnedRuntime({
              appPid: child.pid,
              cleanupDependencies,
              expectedRuntimeSha256: prepared.bindings.runtimeArtifactSha256,
              runtimeWorkRoot: prepared.internal.runtimeWorkRoot,
            }),
          deniedWorkspaceLabel: basename(prepared.internal.deniedWorkspaceRoot),
          execute: (request) =>
            waitForTracerAccessibilityAction({
              ...request,
              binary: adapter.binary,
              pid: child.pid,
            }),
          observeRuntime: async () => {
            runtimeOwnerships.push(
              await authenticateOwnedStagedRuntime({
                appPid: child.pid,
                cleanupDependencies,
                expectedRuntimeSha256: prepared.bindings.runtimeArtifactSha256,
                runtimeWorkRoot: prepared.internal.runtimeWorkRoot,
              }),
            );
          },
          prompt,
          workspaceLabel: basename(prepared.internal.workspaceRoot),
        });
        const cleanupStartedAt = performance.now();
        if (!(await waitForProcessExit(child.pid, 5_000)))
          throw new Error("acceptance-app-quit-failed");
        await terminateOwnedProcess(ownership, cleanupDependencies);
        await verifyOwnedRuntimeGroupsExited(
          runtimeOwnerships,
          cleanupDependencies,
        );
        const cleanupMs = Math.round(performance.now() - cleanupStartedAt);
        cleaned = true;
        const [runtimeAfter, workspaceAfter] = await Promise.all([
          snapshotDirectory(prepared.internal.runtimeWorkRoot),
          snapshotDirectory(prepared.internal.workspaceRoot),
        ]);
        const physicalObservation = JSON.parse(
          await readFile(physicalObservationPath, "utf8"),
        );
        if (
          physicalObservationFailures(physicalObservation, prepared.expected)
            .length > 0
        ) {
          throw new Error("acceptance-physical-observation-invalid");
        }
        return {
          budgets: {
            ...acceptanceBudgetLimits,
            cancellationProjectionMs: journey.cancellationProjectionMs,
            cleanupMs,
            firstVisibleKeikoOverheadP95Ms,
            localProjectionP95Ms: journey.localProjectionP95Ms,
            localProjectionSamples: journey.localProjectionSamples,
            turnDurationMs: journey.turnDurationMs,
          },
          journey: structuredClone(acceptanceJourneyContract),
          physical: {
            ...structuredClone(acceptancePhysicalContract),
            packageExecutableSha256: prepared.expected.packageExecutableSha256,
            runner: process.env.ImageOS
              ? `${process.env.ImageOS}-${process.env.ImageVersion ?? "current"}`
              : "local-macos",
          },
          safeguards: observedSafeguards({
            containmentMarkers: prepared.internal.containmentMarkers,
            journey,
            packageInspection: prepared.packageInspection,
            residualProcesses: processExists(child.pid) ? 1 : 0,
            runtimeAfter,
            runtimeBefore: production.runtimeBefore,
            workspaceAfter,
            workspaceBefore: production.workspaceBefore,
          }),
        };
      } finally {
        if (!cleaned) {
          for (const runtimeOwnership of runtimeOwnerships) {
            await terminateOwnedProcess(
              runtimeOwnership,
              cleanupDependencies,
            ).catch(() => undefined);
          }
          await terminateOwnedProcess(ownership, cleanupDependencies);
        }
      }
    },
    async cleanup(prepared) {
      await chmod(prepared.internal.deniedWorkspaceRoot, 0o700).catch(
        () => undefined,
      );
      await rm(prepared.internal.workspaceRoot, {
        force: true,
        recursive: true,
      });
      await rm(prepared.internal.deniedWorkspaceRoot, {
        force: true,
        recursive: true,
      });
      await rm(prepared.internal.runRoot, { force: true, recursive: true });
      await rm(physicalObservationPath, { force: true });
    },
    async writeEvidence(evidence) {
      await writeFile(
        join(packageRoot, "codex-tracer-acceptance-evidence.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
        { mode: 0o600 },
      );
    },
  };
}

export async function canonicalRuntimeRoot(root, canonicalize = realpath) {
  return canonicalize(root);
}

export async function canonicalRuntimeResources(
  { binary, home },
  canonicalize = realpath,
) {
  const [canonicalBinary, canonicalHome] = await Promise.all([
    canonicalize(binary),
    canonicalize(home),
  ]);
  return { binary: canonicalBinary, home: canonicalHome };
}
