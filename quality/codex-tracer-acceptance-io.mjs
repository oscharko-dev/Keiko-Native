import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  readlink,
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
  acceptanceIdentityContract,
  acceptanceJourneyContract,
  acceptancePackageInspectionContract,
  acceptancePhysicalContract,
  referenceEnvironmentFailures,
  workspaceAcceptanceBudgetLimits,
  workspaceAcceptanceIdentityContract,
  workspaceAcceptanceJourneyContract,
  workspaceAcceptanceSafeguardContract,
} from "./codex-tracer-acceptance.mjs";
import {
  compileTracerAccessibility,
  percentile95,
  runPackagedTracerJourney,
  runPackagedWorkspaceJourney,
  waitForTracerAccessibilityAction,
} from "./codex-tracer-accessibility.mjs";
import {
  authenticateOwnedProcessGroup,
  compileProcessGroupInspector,
  establishOwnedProcess,
  processCleanupDependencies,
  rejectUnauthenticatedLauncher,
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
const providerLocalProfilePaths = Object.freeze([
  "models_cache.json",
  "tmp/arg0",
]);
const providerArg0EntryNames = Object.freeze([
  ".lock",
  "apply_patch",
  "applypatch",
  "codex-execve-wrapper",
]);
const providerArg0DirectoryPattern = /^codex-arg0[A-Za-z0-9]{6}$/u;
const providerArg0MaxDirectories = 64;
const providerModelCacheMaxBytes = 1_048_576;
const providerProfileSnapshotLimits = Object.freeze({
  maxBytes: 8 * 1_048_576,
  maxDepth: 16,
  maxEntries: 2_048,
  timeoutMs: 5_000,
});
const acceptanceSubprocessTimeouts = Object.freeze({
  acceptance: 10 * 60 * 1_000,
  inspection: 10_000,
});
const referenceEnvironmentCommands = Object.freeze([
  [
    "/usr/sbin/sysctl",
    ["-n", "machdep.cpu.brand_string", "hw.memsize", "hw.model"],
  ],
  ["/usr/bin/sw_vers", ["-productVersion"]],
  ["/usr/bin/sw_vers", ["-buildVersion"]],
  [
    "/usr/sbin/system_profiler",
    ["SPDisplaysDataType", "-json", "-detailLevel", "mini"],
  ],
  ["/usr/bin/pmset", ["-g", "batt"]],
  ["/usr/bin/pmset", ["-g", "custom"]],
  ["/usr/bin/pmset", ["-g", "therm"]],
]);
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

function defaultAcceptanceSubprocessDependencies() {
  return {
    clearDeadline: clearTimeout,
    groupExists(processGroupId) {
      try {
        process.kill(-processGroupId, 0);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
      }
    },
    launch: spawn,
    monotonicNow: () => performance.now(),
    scheduleDeadline: setTimeout,
    signalGroup(processGroupId, signal) {
      process.kill(-processGroupId, signal);
    },
    waitForTurn: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

async function stopAcceptanceSubprocessTree(processGroupId, dependencies) {
  try {
    dependencies.signalGroup(processGroupId, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const deadline = dependencies.monotonicNow() + 5_000;
  while (dependencies.monotonicNow() < deadline) {
    if (!dependencies.groupExists(processGroupId)) return;
    await dependencies.waitForTurn(10);
  }
  if (dependencies.groupExists(processGroupId))
    throw new Error("acceptance-subprocess-cleanup-failed");
}

export async function runAcceptanceSubprocess(
  command,
  args,
  options = {},
  providedDependencies = {},
) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    throw new TypeError("acceptance-subprocess-timeout-invalid");
  const maxOutputBytes = options.maxOutputBytes ?? 50 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 50 * 1024 * 1024
  ) {
    throw new TypeError("acceptance-subprocess-output-bound-invalid");
  }
  const dependencies = {
    ...defaultAcceptanceSubprocessDependencies(),
    ...providedDependencies,
  };
  const environment =
    options.inheritEnvironment === false
      ? acceptanceProcessEnvironment(process.env, options.env)
      : { ...process.env, ...options.env };
  const child = dependencies.launch(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    detached: true,
    env: noReplaceGitEnvironment(environment),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    child.once?.("error", () => undefined);
    throw new Error("acceptance-subprocess-failed");
  }
  let stdout = "";
  let stderr = "";
  let outputExceeded = false;
  let treeSignalFailed = false;
  const signalOwnedGroup = () => {
    try {
      dependencies.signalGroup(child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code === "ESRCH") return;
      treeSignalFailed = true;
      child.kill?.("SIGKILL");
    }
  };
  const append = (channel, chunk) => {
    if (outputExceeded) return channel;
    const next = channel + chunk.toString("utf8");
    if (Buffer.byteLength(next, "utf8") > maxOutputBytes) {
      outputExceeded = true;
      signalOwnedGroup();
      return channel;
    }
    return next;
  };
  child.stdout?.on("data", (chunk) => {
    stdout = append(stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = append(stderr, chunk);
  });
  let timedOut = false;
  const completion = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error, status: null }));
    child.once("close", (status, signal) => resolve({ signal, status }));
  });
  const deadline = dependencies.scheduleDeadline(() => {
    timedOut = true;
    signalOwnedGroup();
  }, options.timeoutMs);
  const result = await completion;
  dependencies.clearDeadline(deadline);
  const groupRemains = dependencies.groupExists(child.pid);
  if (
    timedOut ||
    outputExceeded ||
    treeSignalFailed ||
    result.status !== 0 ||
    result.error ||
    groupRemains
  )
    await stopAcceptanceSubprocessTree(child.pid, dependencies);
  if (timedOut) throw new Error("acceptance-subprocess-timed-out");
  if (
    outputExceeded ||
    treeSignalFailed ||
    result.status !== 0 ||
    result.error ||
    groupRemains
  )
    throw new Error("acceptance-subprocess-failed");
  return selectCommandOutput({ stderr, stdout }, options.output);
}

async function run(command, args, options = {}) {
  return runAcceptanceSubprocess(command, args, options);
}

async function exactNpmVersion() {
  const npmExecPath = process.env.npm_execpath;
  if (typeof npmExecPath !== "string" || npmExecPath.length === 0)
    throw new Error("acceptance-npm-unavailable");
  return run(process.execPath, [npmExecPath, "--version"], {
    timeoutMs: acceptanceSubprocessTimeouts.inspection,
  });
}

export async function packageAcceptance(dependencies = {}) {
  const npmExecPath = dependencies.npmExecPath ?? process.env.npm_execpath;
  if (typeof npmExecPath !== "string" || npmExecPath.length === 0)
    throw new Error("acceptance-npm-unavailable");
  await (dependencies.run ?? run)(
    process.execPath,
    [npmExecPath, "run", "--silent", "acceptance:macos"],
    { timeoutMs: acceptanceSubprocessTimeouts.acceptance },
  );
}

async function inspectEnvironment({ binary, home }) {
  const [runtimeBytes, promptBytes, authStatus, npmVersion, runtimeVersion] =
    await Promise.all([
      readFile(binary),
      readFile(
        join(
          repositoryRoot,
          "quality/fixtures/codex-tracer/no-effect-prompt.txt",
        ),
      ),
      run(
        binary,
        ["-c", 'cli_auth_credentials_store="keyring"', "login", "status"],
        {
          env: { CODEX_HOME: home },
          inheritEnvironment: false,
          output: "stderr",
          timeoutMs: acceptanceSubprocessTimeouts.inspection,
        },
      ),
      exactNpmVersion(),
      run(binary, ["--version"], {
        inheritEnvironment: false,
        timeoutMs: acceptanceSubprocessTimeouts.inspection,
      }),
    ]);
  return {
    architecture: process.arch,
    authStatus,
    nodeVersion: process.versions.node,
    npmVersion,
    platform: process.platform,
    promptBytes: promptBytes.byteLength,
    promptSha256: sha256(promptBytes),
    runtimeSha256: sha256(runtimeBytes),
    runtimeVersion,
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

export async function snapshotDirectory(root, options = {}) {
  const excludedRelativePaths = new Set(options.excludedRelativePaths ?? []);
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
  const timeoutMs = options.timeoutMs ?? Number.POSITIVE_INFINITY;
  if (maxBytes < 0 || maxDepth < 0 || maxEntries < 0 || timeoutMs <= 0) {
    throw new Error("acceptance-snapshot-bounds-exceeded");
  }
  const digest = createHash("sha256");
  const startedAt = performance.now();
  let bytes = 0;
  let entries = 0;
  function enforceBounds(depth) {
    if (
      bytes > maxBytes ||
      entries > maxEntries ||
      depth > maxDepth ||
      performance.now() - startedAt >= timeoutMs
    ) {
      throw new Error("acceptance-snapshot-bounds-exceeded");
    }
  }
  async function digestFile(path, depth) {
    const stream = createReadStream(path, { highWaterMark: 64 * 1_024 });
    try {
      for await (const chunk of stream) {
        bytes += chunk.byteLength;
        enforceBounds(depth);
        digest.update(chunk);
      }
    } finally {
      stream.destroy();
    }
  }
  async function visit(directory, prefix = "", depth = 0) {
    enforceBounds(depth);
    const children = [];
    const handle = await opendir(directory);
    for await (const child of handle) {
      children.push(child);
      if (entries + children.length > maxEntries)
        throw new Error("acceptance-snapshot-bounds-exceeded");
      enforceBounds(depth);
    }
    children.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const child of children) {
      enforceBounds(depth);
      const relativePath =
        prefix === "" ? child.name : `${prefix}/${child.name}`;
      if (excludedRelativePaths.has(relativePath)) continue;
      digest.update(relativePath, "utf8");
      digest.update("\0", "utf8");
      entries += 1;
      enforceBounds(depth);
      if (child.isDirectory()) {
        digest.update("directory\0", "utf8");
        await visit(join(directory, child.name), relativePath, depth + 1);
      } else if (child.isFile()) {
        digest.update("file\0", "utf8");
        await digestFile(join(directory, child.name), depth);
      } else if (child.isSymbolicLink()) {
        const target = await readlink(join(directory, child.name), "buffer");
        bytes += target.length;
        enforceBounds(depth);
        digest.update("symlink\0", "utf8");
        digest.update(target);
      } else {
        throw new Error("acceptance-snapshot-entry-invalid");
      }
      digest.update("\0", "utf8");
    }
  }
  await visit(root);
  return { bytes, entries, sha256: digest.digest("hex") };
}

async function optionalEntry(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function validateProviderArg0(root, expectedRuntimeBinary) {
  const arg0Path = join(root, "tmp/arg0");
  const arg0Entry = await optionalEntry(arg0Path);
  if (arg0Entry === null) return;
  if (!arg0Entry.isDirectory())
    throw new Error("acceptance-runtime-profile-arg0-invalid");

  const directories = [];
  const arg0Handle = await opendir(arg0Path);
  for await (const directory of arg0Handle) {
    directories.push(directory);
    if (directories.length > providerArg0MaxDirectories)
      throw new Error("acceptance-runtime-profile-arg0-invalid");
  }
  directories.sort((left, right) => compareCodeUnits(left.name, right.name));
  const canonicalRuntimeBinary = await realpath(expectedRuntimeBinary);
  for (const directory of directories) {
    if (
      !directory.isDirectory() ||
      !providerArg0DirectoryPattern.test(directory.name)
    ) {
      throw new Error("acceptance-runtime-profile-arg0-invalid");
    }
    const directoryPath = join(arg0Path, directory.name);
    const entries = [];
    const directoryHandle = await opendir(directoryPath);
    for await (const entry of directoryHandle) {
      entries.push(entry);
      if (entries.length > providerArg0EntryNames.length)
        throw new Error("acceptance-runtime-profile-arg0-invalid");
    }
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    if (
      JSON.stringify(entries.map(({ name }) => name)) !==
      JSON.stringify(providerArg0EntryNames)
    ) {
      throw new Error("acceptance-runtime-profile-arg0-invalid");
    }
    const lock = entries[0];
    const lockEntry = await lstat(join(directoryPath, lock.name));
    if (!lock.isFile() || lockEntry.size !== 0)
      throw new Error("acceptance-runtime-profile-arg0-invalid");
    for (const alias of entries.slice(1)) {
      if (
        !alias.isSymbolicLink() ||
        (await realpath(join(directoryPath, alias.name))) !==
          canonicalRuntimeBinary
      ) {
        throw new Error("acceptance-runtime-profile-arg0-invalid");
      }
    }
  }
}

export async function snapshotProtectedRuntimeProfile(root, options = {}) {
  const cachePath = join(root, "models_cache.json");
  const cacheEntry = await optionalEntry(cachePath);
  if (cacheEntry !== null) {
    if (!cacheEntry.isFile() || cacheEntry.size > providerModelCacheMaxBytes)
      throw new Error("acceptance-runtime-profile-cache-invalid");
    try {
      const cache = JSON.parse(await readFile(cachePath, "utf8"));
      if (typeof cache !== "object" || cache === null || Array.isArray(cache))
        throw new Error("acceptance-runtime-profile-cache-invalid");
    } catch {
      throw new Error("acceptance-runtime-profile-cache-invalid");
    }
  }

  await validateProviderArg0(
    root,
    options.expectedRuntimeBinary ?? runtimeBinary,
  );

  return snapshotDirectory(root, {
    excludedRelativePaths: providerLocalProfilePaths,
    ...providerProfileSnapshotLimits,
  });
}

export async function cleanupAcceptanceFixture(prepared, dependencies = {}) {
  const internal = prepared.internal;
  const actions = [
    dependencies.chmodDeniedWorkspace ??
      (() => chmod(internal.deniedWorkspaceRoot, 0o700).catch(() => undefined)),
    dependencies.removeWorkspace ??
      (() => rm(internal.workspaceRoot, { force: true, recursive: true })),
    dependencies.removeDeniedWorkspace ??
      (() =>
        rm(internal.deniedWorkspaceRoot, { force: true, recursive: true })),
    dependencies.removeObservation ??
      (() => rm(physicalObservationPath, { force: true })),
    dependencies.removeRunRoot ??
      (() => rm(internal.runRoot, { force: true, recursive: true })),
  ];
  let firstFailure;
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}

export function observedSafeguards({
  containmentMarkers,
  homeAfter,
  homeBefore,
  journey,
  packageInspection,
  repositoryEvidenceCanaries,
  residualProcesses,
  runtimeAfter,
  runtimeBefore,
  workspaceAfter,
  workspaceBefore,
}) {
  const journeyRows = journey.timings.map(({ action }) => action);
  const serializedJourney = JSON.stringify(journey);
  const fixedJourneyRows = 36;
  const cleanRuntime = conditionsMet(
    runtimeBefore.entries === 0,
    runtimeAfter.entries === 0,
    runtimeBefore.bytes === 0,
    runtimeAfter.bytes === 0,
    homeBefore.sha256 === homeAfter.sha256,
    homeBefore.entries === homeAfter.entries,
    homeBefore.bytes === homeAfter.bytes,
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
      repositoryEvidenceCanaries,
    ),
    repositoryContextBytesToRuntime: journey.repositoryContextBytesToRuntime,
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

function repositoryEvidenceBytes(serializedJourney, canaries) {
  return canaries.reduce((bytes, canary) => {
    if (canary.length === 0) return bytes;
    return (
      bytes +
      serializedJourney.split(canary).length *
        Buffer.byteLength(canary, "utf8") -
      Buffer.byteLength(canary, "utf8")
    );
  }, 0);
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
  const processes = (
    await run("/bin/ps", ["-axo", "pid=,ppid=,pgid=,command="], {
      timeoutMs: acceptanceSubprocessTimeouts.inspection,
    })
  )
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

export async function createIdentityWorkspace(prefix, dependencies = {}) {
  if (!/^KeikoAcceptanceIdentity104[A-Za-z0-9]*$/u.test(prefix))
    throw new TypeError("acceptance-workspace-prefix-invalid");
  const createTemporaryDirectory = dependencies.mkdtemp ?? mkdtemp;
  const setMode = dependencies.chmod ?? chmod;
  const createDirectory = dependencies.mkdir ?? mkdir;
  const write = dependencies.writeFile ?? writeFile;
  const remove = dependencies.rm ?? rm;
  let root;
  try {
    root = await createTemporaryDirectory(join(homedir(), "Documents", prefix));
    await setMode(root, 0o700);
    await createDirectory(join(root, ".git"), { mode: 0o700 });
    await write(
      join(root, "repository-context-canary.txt"),
      "KeikoRepositoryContextCanary104",
      { encoding: "utf8", mode: 0o600 },
    );
    return root;
  } catch {
    if (root !== undefined) {
      try {
        await remove(root, { force: true, recursive: true });
      } catch {
        throw new Error("acceptance-workspace-fixture-cleanup-failed");
      }
    }
    throw new Error("acceptance-workspace-fixture-unavailable");
  }
}

export async function createAcceptanceRunRoot(prefix, dependencies = {}) {
  if (
    !["keiko-native-codex-tracer-104-", "keiko-native-workspace-187-"].includes(
      prefix,
    )
  ) {
    throw new TypeError("acceptance-run-root-prefix-invalid");
  }
  const createTemporaryDirectory = dependencies.mkdtemp ?? mkdtemp;
  const canonicalize = dependencies.canonicalize ?? realpath;
  const setMode = dependencies.chmod ?? chmod;
  const remove = dependencies.rm ?? rm;
  let root;
  try {
    root = await createTemporaryDirectory(join(tmpdir(), prefix));
    const canonicalRoot = await canonicalRuntimeRoot(root, canonicalize);
    await setMode(canonicalRoot, 0o700);
    return canonicalRoot;
  } catch {
    if (root !== undefined) {
      try {
        await remove(root, { force: true, recursive: true });
      } catch {
        throw new Error("acceptance-run-root-cleanup-failed");
      }
    }
    throw new Error("acceptance-run-root-unavailable");
  }
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

function launchWorkspacePackagedApp(internal) {
  return spawn(internal.packageExecutable, [], {
    detached: true,
    env: acceptanceProcessEnvironment(process.env, {
      KEIKO_CODEX_0_145_0_WORK_ROOT: internal.runtimeWorkRoot,
    }),
    stdio: "ignore",
  });
}

async function removeWorkspaceRoots(workspaceRoots) {
  let firstFailure;
  for (const workspaceRoot of workspaceRoots) {
    try {
      await rm(workspaceRoot, { force: true, recursive: true });
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}

export async function cleanupWorkspacePreparation(
  { deniedWorkspaceRoot, runRoot, workspaceRoots },
  dependencies = {},
) {
  const actions = [
    () =>
      (dependencies.removeWorkspaceRoots ?? removeWorkspaceRoots)(
        workspaceRoots,
      ),
    ...(deniedWorkspaceRoot === undefined
      ? []
      : [
          () => (dependencies.chmod ?? chmod)(deniedWorkspaceRoot, 0o700),
          () =>
            (dependencies.rm ?? rm)(deniedWorkspaceRoot, {
              force: true,
              recursive: true,
            }),
        ]),
    () => (dependencies.rm ?? rm)(runRoot, { force: true, recursive: true }),
  ];
  let failed = false;
  for (const action of actions) {
    try {
      await action();
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("acceptance-workspace-fixture-cleanup-failed");
}

const workspaceEvidencePublisherSource = String.raw`
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

static void fail(const char *reason) {
  fprintf(stderr, "workspace-publisher:%s\n", reason);
  exit(1);
}

static int same(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode && left->st_size == right->st_size;
}

static int same_object(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode;
}

static unsigned long long number(const char *value) {
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno || !end || *end) fail("identity");
  return parsed;
}

static void restore_replaced(int parent, const char *stage_name,
                             const char *final_name,
                             const struct stat *staged,
                             const struct stat *prior) {
  struct stat restored_stage, restored_final;
  if (renameatx_np(parent, stage_name, parent, final_name, RENAME_SWAP) ||
      fstatat(parent, stage_name, &restored_stage, AT_SYMLINK_NOFOLLOW) ||
      fstatat(parent, final_name, &restored_final, AT_SYMLINK_NOFOLLOW) ||
      !same(staged, &restored_stage) || !same(prior, &restored_final) ||
      fsync(parent))
    fail("rollback");
}

static void restore_created(int parent, const char *stage_name,
                            const char *final_name,
                            const struct stat *staged) {
  struct stat restored_stage, unexpected_final;
  if (renameat(parent, final_name, parent, stage_name) ||
      fstatat(parent, stage_name, &restored_stage, AT_SYMLINK_NOFOLLOW) ||
      !same(staged, &restored_stage) ||
      (!fstatat(parent, final_name, &unexpected_final, AT_SYMLINK_NOFOLLOW) ||
       errno != ENOENT) ||
      fsync(parent))
    fail("rollback");
}

int main(int argc, char **argv) {
  if (argc != 10) fail("usage");
  int parent = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat parent_descriptor, parent_named;
  if (parent < 0 || fstat(parent, &parent_descriptor) ||
      lstat(argv[1], &parent_named) || !same(&parent_descriptor, &parent_named))
    fail("parent-identity");
  int stage = openat(parent, argv[2], O_RDONLY | O_NOFOLLOW);
  struct stat staged;
  if (stage < 0 || fstat(stage, &staged) || !S_ISREG(staged.st_mode) ||
      (staged.st_mode & 0777) != 0600 ||
      (unsigned long long)staged.st_dev != number(argv[4]) ||
      (unsigned long long)staged.st_ino != number(argv[5]) ||
      (unsigned long long)staged.st_size != number(argv[6]))
    fail("stage-identity");
  int prior = openat(parent, argv[3], O_RDONLY | O_NOFOLLOW);
  struct stat prior_identity;
  int replaced = prior >= 0;
  if (!replaced && errno != ENOENT) fail("final-open");
  if (replaced &&
      (fstat(prior, &prior_identity) || !S_ISREG(prior_identity.st_mode)))
    fail("final-type");

  int build = open(argv[7], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat build_descriptor, build_named;
  if (build < 0 || fstat(build, &build_descriptor) ||
      lstat(argv[7], &build_named) ||
      !same_object(&build_descriptor, &build_named) ||
      (unsigned long long)build_descriptor.st_dev != number(argv[8]) ||
      (unsigned long long)build_descriptor.st_ino != number(argv[9]) ||
      unlinkat(build, "publisher", 0) || fsync(build) || close(build) ||
      rmdir(argv[7]))
    fail("build-cleanup");

  if (lstat(argv[1], &parent_named) ||
      !same_object(&parent_descriptor, &parent_named))
    fail("parent-identity");
  struct stat staged_named, prior_named;
  if (fstatat(parent, argv[2], &staged_named, AT_SYMLINK_NOFOLLOW) ||
      !same(&staged, &staged_named))
    fail("stage-identity");
  if (replaced) {
    if (fstatat(parent, argv[3], &prior_named, AT_SYMLINK_NOFOLLOW) ||
        !same(&prior_identity, &prior_named))
      fail("final-identity");
  } else {
    errno = 0;
    if (!fstatat(parent, argv[3], &prior_named, AT_SYMLINK_NOFOLLOW) ||
        errno != ENOENT)
      fail("final-identity");
  }
  if (replaced) {
    if (renameatx_np(parent, argv[2], parent, argv[3], RENAME_SWAP))
      fail("swap");
  } else {
    if (renameatx_np(parent, argv[2], parent, argv[3], RENAME_EXCL))
      fail("rename");
  }
  struct stat published, retained;
  int valid = !fstatat(parent, argv[3], &published, AT_SYMLINK_NOFOLLOW) &&
              same(&staged, &published);
  if (replaced)
    valid = valid &&
            !fstatat(parent, argv[2], &retained, AT_SYMLINK_NOFOLLOW) &&
            same(&prior_identity, &retained);
  if (!valid || fsync(parent)) {
    if (replaced) restore_replaced(parent, argv[2], argv[3], &staged,
                                   &prior_identity);
    else restore_created(parent, argv[2], argv[3], &staged);
    fail("postcondition");
  }
  if (replaced && unlinkat(parent, argv[2], 0)) {
    restore_replaced(parent, argv[2], argv[3], &staged, &prior_identity);
    fail("retained-cleanup");
  }
  close(stage);
  if (prior >= 0) close(prior);
  close(parent);
  return 0;
}
`;

async function publishBoundWorkspaceEvidence(
  stagePath,
  finalPath,
  expected,
  dependencies = {},
) {
  if (process.platform !== "darwin")
    throw new Error("workspace-evidence-publication-platform");
  const buildRoot = await (dependencies.mkdtemp ?? mkdtemp)(
    join(tmpdir(), "keiko-workspace-publisher-"),
  );
  const helper = join(buildRoot, "publisher");
  let published = false;
  try {
    const invoke = dependencies.spawnSync ?? spawnSync;
    const compile = invoke(
      "/usr/bin/cc",
      [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        "-x",
        "c",
        "-",
        "-o",
        helper,
      ],
      {
        encoding: "utf8",
        input: workspaceEvidencePublisherSource,
        maxBuffer: 1024 * 1024,
      },
    );
    if (compile.status !== 0 || compile.error)
      throw new Error("workspace-evidence-publication-compile");
    await (dependencies.chmod ?? chmod)(helper, 0o700);
    const buildIdentity = await (dependencies.lstat ?? lstat)(buildRoot);
    if (buildIdentity.isSymbolicLink() || !buildIdentity.isDirectory())
      throw new Error("workspace-evidence-publication-build-root");
    const execute = invoke(
      helper,
      [
        dirname(finalPath),
        basename(stagePath),
        basename(finalPath),
        String(expected.dev),
        String(expected.ino),
        String(expected.size),
        buildRoot,
        String(buildIdentity.dev),
        String(buildIdentity.ino),
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    if (execute.status !== 0 || execute.error)
      throw new Error("workspace-evidence-publication-rejected");
    published = true;
  } finally {
    if (!published)
      await (dependencies.rm ?? rm)(buildRoot, {
        force: true,
        recursive: true,
      });
  }
}

function sameWorkspaceFileIdentity(left, right) {
  return sameWorkspaceObjectIdentity(left, right) && left.size === right.size;
}

function sameWorkspaceObjectIdentity(left, right) {
  return (
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  );
}

async function workspaceEvidenceSettled(
  stagePath,
  finalPath,
  stageIdentity,
  dependencies,
) {
  const inspect = dependencies.lstat ?? lstat;
  const finalEntry = await inspect(finalPath);
  const retainedStage = await inspect(stagePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  return (
    retainedStage === null &&
    finalEntry.isFile() &&
    !finalEntry.isSymbolicLink() &&
    sameWorkspaceFileIdentity(stageIdentity, finalEntry)
  );
}

export async function publishWorkspaceEvidenceAtomically(
  contents,
  finalPath,
  dependencies = {},
) {
  const stageName =
    dependencies.stageName ??
    `.${basename(finalPath)}.workspace-evidence-${String(process.pid)}.tmp`;
  const stagePath = join(dirname(finalPath), stageName);
  const encoded =
    typeof contents === "string" ? Buffer.from(contents, "utf8") : null;
  let handle;
  let stageIdentity;
  let stageOwned = false;
  let published = false;
  let failed = false;
  try {
    if (
      encoded === null ||
      stageName.length === 0 ||
      basename(stageName) !== stageName ||
      stagePath === finalPath
    ) {
      throw new Error("workspace-evidence-publication-invalid");
    }
    handle = await (dependencies.open ?? open)(stagePath, "wx", 0o600);
    stageOwned = true;
    stageIdentity = await handle.stat();
    const stagedEntry = await (dependencies.lstat ?? lstat)(stagePath);
    if (
      stagedEntry.isSymbolicLink() ||
      !stagedEntry.isFile() ||
      (stagedEntry.mode & 0o777) !== 0o600 ||
      !sameWorkspaceFileIdentity(stageIdentity, stagedEntry)
    ) {
      throw new Error("workspace-evidence-publication-stage-invalid");
    }
    await handle.writeFile(encoded);
    await handle.sync();
    stageIdentity = await handle.stat();
    await handle.close();
    handle = undefined;
    const readBack = await (dependencies.readFile ?? readFile)(stagePath);
    const readBackEntry = await (dependencies.lstat ?? lstat)(stagePath);
    if (
      !Buffer.isBuffer(readBack) ||
      !readBack.equals(encoded) ||
      !sameWorkspaceFileIdentity(stageIdentity, readBackEntry)
    )
      throw new Error("workspace-evidence-publication-readback-invalid");
    let finalEntry;
    try {
      finalEntry = await (dependencies.lstat ?? lstat)(finalPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (
      finalEntry !== undefined &&
      (finalEntry.isSymbolicLink() || !finalEntry.isFile())
    ) {
      throw new Error("workspace-evidence-publication-final-invalid");
    }
    try {
      await (dependencies.publish ?? publishBoundWorkspaceEvidence)(
        stagePath,
        finalPath,
        stageIdentity,
        dependencies,
      );
      published = true;
    } catch {
      published = await workspaceEvidenceSettled(
        stagePath,
        finalPath,
        stageIdentity,
        dependencies,
      ).catch(() => false);
      failed = !published;
    }
  } catch {
    failed = true;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        failed = true;
      }
    }
    if (stageOwned && !published) {
      try {
        const retained = await (dependencies.lstat ?? lstat)(stagePath).catch(
          (error) => {
            if (error?.code === "ENOENT") return null;
            throw error;
          },
        );
        if (
          retained !== null &&
          sameWorkspaceObjectIdentity(stageIdentity, retained)
        ) {
          await (dependencies.rm ?? rm)(stagePath, { force: true });
        }
      } catch {
        failed = true;
      }
    }
  }
  if (failed) throw new Error("workspace-evidence-publication-failed");
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
  const reject = dependencies.reject ?? rejectUnauthenticatedLauncher;
  const waitForExit = dependencies.waitForExit ?? waitForProcessExit;
  return percentile95(
    await measureFreshLaunches({
      adapterBinary,
      authenticate,
      cleanupDependencies,
      internal,
      launch,
      measure: async ({ child, startedAt }) => {
        const visible = await observe({
          action: "probe-start",
          binary: adapterBinary,
          pid: child.pid,
          timeoutMs: 5_000,
        });
        if (visible.status !== "passed")
          throw new Error("acceptance-first-visible-failed");
        return Math.round(monotonicNow() - startedAt);
      },
      monotonicNow,
      observe,
      reject,
      samples: acceptanceBudgetLimits.firstVisibleKeikoOverheadSamples,
      terminate,
      waitForExit,
    }),
  );
}

async function measureFreshLaunches({
  adapterBinary,
  authenticate,
  cleanupDependencies,
  internal,
  launch,
  measure,
  monotonicNow,
  observe,
  reject,
  samples,
  terminate,
  waitForExit,
}) {
  const observations = [];
  for (let repetition = 0; repetition < samples; repetition += 1) {
    const startedAt = monotonicNow();
    const { child, ownership } = await establishOwnedProcess({
      authenticate: (candidate) => authenticate(candidate, cleanupDependencies),
      launch: () => launch(internal),
      reject,
    });
    try {
      const elapsedMs = await measure({ child, startedAt });
      if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0)
        throw new Error("acceptance-projection-measurement-invalid");
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
  return observations;
}

export async function measureNativePickerCancellationDistribution(
  internal,
  adapterBinary,
  cleanupDependencies,
  dependencies = {},
) {
  const observe = dependencies.observe ?? waitForTracerAccessibilityAction;
  const passed = async (request) => {
    const result = await observe({
      ...request,
      binary: adapterBinary,
      timeoutMs: 5_000,
    });
    if (result.status !== "passed")
      throw new Error("acceptance-picker-cancellation-failed");
    return result;
  };
  const measurements = await measureFreshLaunches({
    adapterBinary,
    authenticate: dependencies.authenticate ?? authenticateOwnedProcessGroup,
    cleanupDependencies,
    internal,
    launch: dependencies.launch ?? launchPackagedApp,
    measure: async ({ child }) => {
      await passed({ action: "probe-start", pid: child.pid });
      await passed({
        action: "open-canvas",
        observation: "probe-canvas",
        pid: child.pid,
      });
      await passed({ action: "open-workspace-picker", pid: child.pid });
      const cancelled = await passed({
        action: "cancel-workspace-picker",
        observation: "observe-workspace-cancelled",
        pid: child.pid,
      });
      return cancelled.projectedMs;
    },
    monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
    observe,
    reject: dependencies.reject ?? rejectUnauthenticatedLauncher,
    samples: acceptanceBudgetLimits.nativePickerCancellationSamples,
    terminate: dependencies.terminate ?? terminateOwnedProcess,
    waitForExit: dependencies.waitForExit ?? waitForProcessExit,
  });
  return {
    measurements: measurements.map((projectedMs, index) => ({
      launch: index + 1,
      projectedMs,
    })),
    p95Ms: percentile95(measurements),
  };
}

const displayDimensionPattern = /^([1-9][0-9]{0,4}) x ([1-9][0-9]{0,4})$/u;
const displayModePattern =
  /^([1-9][0-9]{0,4}) x ([1-9][0-9]{0,4}) @ ([1-9][0-9]{0,3})(?:\.([0-9]{1,3}))?Hz$/u;
const maximumReferenceDisplays = 16;

function greatestCommonDivisor(left, right) {
  let divisor = right;
  let remainder = left;
  while (divisor !== 0) {
    [remainder, divisor] = [divisor, remainder % divisor];
  }
  return remainder;
}

function normalizedRefresh(integer, fraction = "") {
  const trimmedFraction = fraction.replace(/0+$/u, "");
  return trimmedFraction.length === 0
    ? integer
    : `${integer}.${trimmedFraction}`;
}

function normalizedDisplayKind(connection) {
  if (connection === "spdisplays_internal") return "internal";
  if ([undefined, null, "spdisplays_external"].includes(connection))
    return "external";
  return null;
}

function normalizedDisplayEntry(display) {
  if (
    typeof display !== "object" ||
    display === null ||
    Array.isArray(display) ||
    display.spdisplays_online !== "spdisplays_yes"
  ) {
    return null;
  }
  const physicalValue = display._spdisplays_pixels;
  const logicalValue = display._spdisplays_resolution;
  if (typeof physicalValue !== "string" || typeof logicalValue !== "string")
    return null;
  const physical = displayDimensionPattern.exec(physicalValue);
  const logical = displayModePattern.exec(logicalValue);
  const main = display.spdisplays_main;
  if (
    physical === null ||
    logical === null ||
    ![undefined, null, "spdisplays_no", "spdisplays_yes"].includes(main)
  ) {
    return null;
  }
  const dimensions = [...physical.slice(1), ...logical.slice(1, 3)].map(Number);
  const [physicalWidth, physicalHeight, logicalWidth, logicalHeight] =
    dimensions;
  if (
    dimensions.some((value) => value > 32_768) ||
    physicalWidth * logicalHeight !== physicalHeight * logicalWidth
  ) {
    return null;
  }
  const divisor = greatestCommonDivisor(physicalWidth, logicalWidth);
  const numerator = physicalWidth / divisor;
  const denominator = logicalWidth / divisor;
  if (numerator < denominator || numerator > 99 || denominator > 99)
    return null;
  const kind = normalizedDisplayKind(display.spdisplays_connection_type);
  if (kind === null) return null;
  const role = main === "spdisplays_yes" ? "main" : "secondary";
  const scale =
    denominator === 1 ? `${numerator}` : `${numerator}/${denominator}`;
  return {
    display: `${kind}-${role}-${physicalWidth}x${physicalHeight}`,
    main: role === "main",
    mode: `${logicalWidth}x${logicalHeight}@${normalizedRefresh(logical[3], logical[4])}hz-${scale}x`,
  };
}

function normalizedDisplay(serialized) {
  try {
    if (typeof serialized !== "string" || serialized.length > 64 * 1024)
      return null;
    const profile = JSON.parse(serialized);
    if (
      typeof profile !== "object" ||
      profile === null ||
      Array.isArray(profile) ||
      JSON.stringify(Object.keys(profile)) !==
        JSON.stringify(["SPDisplaysDataType"]) ||
      !Array.isArray(profile.SPDisplaysDataType) ||
      profile.SPDisplaysDataType.length === 0 ||
      profile.SPDisplaysDataType.length > maximumReferenceDisplays
    ) {
      return null;
    }
    const drivers = profile.SPDisplaysDataType.map(
      (group) => group?.spdisplays_ndrvs,
    );
    if (drivers.some((entries) => !Array.isArray(entries))) return null;
    const displays = drivers.flat();
    if (displays.length === 0 || displays.length > maximumReferenceDisplays)
      return null;
    const normalized = displays.map(normalizedDisplayEntry);
    if (normalized.some((entry) => entry === null)) return null;
    if (normalized.filter(({ main }) => main).length !== 1) return null;
    // This multiset preserves multiplicity while erasing physical identity. A main-role
    // exchange is therefore stable only when the exchanged panels are indistinguishable.
    const ordered = normalized.toSorted((left, right) =>
      compareCodeUnits(
        `${left.display}|${left.mode}`,
        `${right.display}|${right.mode}`,
      ),
    );
    return {
      display: `topology-v1:${ordered.map((entry) => entry.display).join(",")}`,
      scaling: `modes-v1:${ordered.map((entry) => entry.mode).join(",")}`,
    };
  } catch {
    return null;
  }
}

export async function inspectReferenceEnvironment(runCommand = run) {
  const options = {
    inheritEnvironment: false,
    maxOutputBytes: 64 * 1024,
    timeoutMs: acceptanceSubprocessTimeouts.inspection,
  };
  const outputs = await Promise.all(
    referenceEnvironmentCommands.map(([command, args]) =>
      runCommand(command, args, options),
    ),
  );
  const environment = normalizedReferenceEnvironment(outputs);
  if (referenceEnvironmentFailures(environment).length > 0)
    throw new Error("acceptance-reference-environment-invalid");
  return environment;
}

export function assertStableReferenceEnvironment(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("acceptance-reference-environment-changed");
  return before;
}

function sameSnapshot(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

export function observedWorkspaceSafeguards({
  packageInspection,
  residualProcesses,
  runtimeAfter,
  runtimeBefore,
  workspaceAfter,
  workspaceBefore,
}) {
  return {
    ...workspaceAcceptanceSafeguardContract,
    packageTestHooks: packageInspection.testHookMarkers,
    residualProcesses,
    unexpectedWorkspaceMutations:
      sameSnapshot(runtimeBefore, runtimeAfter) &&
      sameSnapshot(workspaceBefore, workspaceAfter)
        ? 0
        : 1,
  };
}

async function prepareWorkspaceJourney(prepared, reportProgress) {
  const processInspectorRoot = join(
    prepared.internal.runRoot,
    "workspace-process-inspector",
  );
  await compileProcessGroupInspector(processInspectorRoot);
  const cleanupDependencies = processCleanupDependencies(processInspectorRoot);
  const adapter = await compileTracerAccessibility(
    join(prepared.internal.runRoot, "workspace-accessibility"),
    (command, args, options) =>
      runAcceptanceSubprocess(command, args, {
        output: "stdout",
        timeoutMs: options.timeoutMs,
      }).then(() => ({ error: undefined, status: 0 })),
  );
  reportProgress("started", "post-observation:reference-environment");
  const referenceEnvironmentBefore = await inspectReferenceEnvironment();
  reportProgress("completed", "post-observation:reference-environment");
  const [runtimeBefore, workspaceBefore] = await Promise.all([
    snapshotDirectory(prepared.internal.runtimeWorkRoot),
    Promise.all(
      prepared.internal.workspaceRoots.map((root) => snapshotDirectory(root)),
    ),
  ]);
  let cancellationSample = 0;
  const nativePickerCancellation =
    await measureNativePickerCancellationDistribution(
      prepared.internal,
      adapter.binary,
      cleanupDependencies,
      {
        launch: (internal) => {
          cancellationSample += 1;
          reportProgress(
            "started",
            `picker-cancellation:launch:${cancellationSample}`,
          );
          return launchWorkspacePackagedApp(internal);
        },
        observe: async (request) => {
          const checkpoint = `picker-cancellation:${request.observation ?? request.action}:${cancellationSample}`;
          reportProgress("started", checkpoint);
          const result = await waitForTracerAccessibilityAction(request);
          if (result.status === "passed")
            reportProgress("completed", checkpoint);
          return result;
        },
      },
    );
  const launched = await establishOwnedProcess({
    authenticate: (candidate) =>
      authenticateOwnedProcessGroup(candidate, cleanupDependencies),
    launch: () => launchWorkspacePackagedApp(prepared.internal),
    reject: rejectUnauthenticatedLauncher,
  });
  return {
    ...launched,
    adapter,
    cleanupDependencies,
    nativePickerCancellation,
    referenceEnvironmentBefore,
    runtimeBefore,
    workspaceBefore,
  };
}

async function executeWorkspaceJourney(prepared, resources, reportProgress) {
  const { child, cleanupDependencies, ownership } = resources;
  let cleaned = false;
  let selectionSample = 0;
  try {
    const journey = await runPackagedWorkspaceJourney({
      deniedWorkspaceLabel: basename(prepared.internal.deniedWorkspaceRoot),
      execute: async (request) => {
        if (request.observation === "observe-workspace-selected")
          selectionSample += 1;
        const checkpoint = `workspace:${request.observation ?? request.action}:${selectionSample}`;
        reportProgress("started", checkpoint);
        const result = await waitForTracerAccessibilityAction({
          ...request,
          binary: resources.adapter.binary,
          pid: child.pid,
        });
        if (result.status === "passed") reportProgress("completed", checkpoint);
        return result;
      },
      workspaceLabels: prepared.internal.workspaceRoots.map((root) =>
        basename(root),
      ),
    });
    const cleanupStartedAt = performance.now();
    reportProgress("started", "cleanup:application");
    if (!(await waitForProcessExit(child.pid, 5_000)))
      throw new Error("workspace-acceptance-app-quit-failed");
    await terminateOwnedProcess(ownership, cleanupDependencies);
    reportProgress("completed", "cleanup:application");
    const cleanupMs = Math.round(performance.now() - cleanupStartedAt);
    cleaned = true;
    reportProgress("started", "post-observation:reference-environment");
    const [referenceEnvironmentAfter, runtimeAfter, workspaceAfter] =
      await Promise.all([
        inspectReferenceEnvironment(),
        snapshotDirectory(prepared.internal.runtimeWorkRoot),
        Promise.all(
          prepared.internal.workspaceRoots.map((root) =>
            snapshotDirectory(root),
          ),
        ),
      ]);
    reportProgress("completed", "post-observation:reference-environment");
    return {
      cleanupMs,
      journey,
      referenceEnvironmentAfter,
      runtimeAfter,
      workspaceAfter,
    };
  } finally {
    if (!cleaned) await terminateOwnedProcess(ownership, cleanupDependencies);
  }
}

export async function runWorkspaceAcceptanceJourney(
  prepared,
  reportProgress = () => undefined,
) {
  const resources = await prepareWorkspaceJourney(prepared, reportProgress);
  const completed = await executeWorkspaceJourney(
    prepared,
    resources,
    reportProgress,
  );
  return {
    budgets: {
      ...workspaceAcceptanceBudgetLimits,
      cleanupMs: completed.cleanupMs,
      nativePickerCancellationMeasurements:
        resources.nativePickerCancellation.measurements,
      nativePickerCancellationP95Ms: resources.nativePickerCancellation.p95Ms,
      workspaceProjectionMeasurements:
        completed.journey.workspaceProjectionMeasurements,
      workspaceProjectionP95Ms: completed.journey.workspaceProjectionP95Ms,
      workspaceSelectionNativeActionMeasurements:
        completed.journey.workspaceSelectionNativeActionMeasurements,
    },
    journey: structuredClone(workspaceAcceptanceJourneyContract),
    referenceEnvironment: assertStableReferenceEnvironment(
      resources.referenceEnvironmentBefore,
      completed.referenceEnvironmentAfter,
    ),
    safeguards: observedWorkspaceSafeguards({
      packageInspection: prepared.packageInspection,
      residualProcesses: processExists(resources.child.pid) ? 1 : 0,
      runtimeAfter: completed.runtimeAfter,
      runtimeBefore: resources.runtimeBefore,
      workspaceAfter: completed.workspaceAfter,
      workspaceBefore: resources.workspaceBefore,
    }),
  };
}

function normalizedReferenceEnvironment([
  hardware,
  version,
  build,
  displayOutput,
  powerOutput,
  powerProfiles,
  thermalOutput,
]) {
  const display = normalizedDisplay(displayOutput);
  const powerMatch = /^Now drawing from '(AC|Battery) Power'(?:\n|$)/u.exec(
    powerOutput,
  );
  const activePower = powerMatch?.[1];
  const activeProfile = new RegExp(
    `(?:^|\\n)${activePower} Power:\\n([\\s\\S]*?)(?=\\n(?:AC|Battery) Power:|$)`,
    "u",
  ).exec(powerProfiles)?.[1];
  const lowPowerMode = /(?:^|\n)\s*lowpowermode\s+([01])(?:\n|$)/u.exec(
    activeProfile ?? "",
  )?.[1];
  const nominalThermal = [
    "Note: No thermal warning level has been recorded",
    "Note: No performance warning level has been recorded",
    "Note: No CPU power status has been recorded",
  ].join("\n");
  return {
    ...display,
    hardware:
      hardware === "Apple M4\n17179869184\nMac16,1"
        ? "apple-m4-16-gib-mac16-1"
        : null,
    operatingSystem:
      version === "26.5.2" && build === "25F84" ? "macos-26.5.2-25f84" : null,
    power:
      lowPowerMode === "0" && activePower === "AC"
        ? "ac-power-standard"
        : lowPowerMode === "0" && activePower === "Battery"
          ? "battery-power-standard"
          : null,
    referenceClass: "owner-m4-16gib-macos26",
    thermal: thermalOutput === nominalThermal ? "nominal" : null,
  };
}

export function createCodexTracerAcceptanceIo() {
  return {
    async prepareWorkspacePackage() {
      const runRoot = await createAcceptanceRunRoot(
        "keiko-native-workspace-187-",
      );
      const workspaceRoots = [];
      let deniedWorkspaceRoot;
      try {
        const sourceRevision = await run(
          "git",
          hardenedGitArguments(["rev-parse", "HEAD"]),
          { timeoutMs: acceptanceSubprocessTimeouts.inspection },
        );
        if (!REVISION_PATTERN.test(sourceRevision))
          throw new Error("acceptance-source-revision-invalid");
        const inspected = await inspectPackage(sourceRevision);
        const runtimeWorkRoot = join(runRoot, "runtime-work");
        await mkdir(runtimeWorkRoot, { mode: 0o700 });
        for (let sample = 1; sample <= 4; sample += 1) {
          workspaceRoots.push(
            await createIdentityWorkspace(
              `KeikoAcceptanceIdentity104Sample${sample}`,
            ),
          );
        }
        deniedWorkspaceRoot = await createIdentityWorkspace(
          "KeikoAcceptanceIdentity104Denied",
        );
        await chmod(deniedWorkspaceRoot, 0o000);
        const expected = {
          packageExecutableSha256: inspected.executableSha256,
          packageManifestSha256: inspected.packageManifestSha256,
          sourceRevision,
        };
        return {
          expected,
          internal: {
            packageExecutable,
            packageRoot,
            deniedWorkspaceRoot,
            runRoot,
            runtimeWorkRoot,
            workspaceRoots,
          },
          packageInspection: structuredClone(
            acceptancePackageInspectionContract,
          ),
          workspaceBindings: {
            ...workspaceAcceptanceIdentityContract,
            ...expected,
          },
        };
      } catch {
        try {
          await cleanupWorkspacePreparation({
            deniedWorkspaceRoot,
            runRoot,
            workspaceRoots,
          });
        } catch {
          throw new Error("acceptance-workspace-fixture-cleanup-failed");
        }
        throw new Error("acceptance-workspace-fixture-unavailable");
      }
    },
    async preparePackage() {
      const runtime = await canonicalRuntimeResources({
        binary: runtimeBinary,
        home: runtimeHome,
      });
      const runRoot = await createAcceptanceRunRoot(
        "keiko-native-codex-tracer-104-",
      );
      let workspaceRoot;
      let deniedWorkspaceRoot;
      try {
        const environment = await inspectEnvironment(runtime);
        if (acceptanceEnvironmentFailures(environment).length > 0)
          throw new Error("acceptance-environment-invalid");
        const sourceRevision = await run(
          "git",
          hardenedGitArguments(["rev-parse", "HEAD"]),
          { timeoutMs: acceptanceSubprocessTimeouts.inspection },
        );
        if (!REVISION_PATTERN.test(sourceRevision))
          throw new Error("acceptance-source-revision-invalid");
        await packageAcceptance();
        const inspected = await inspectPackage(sourceRevision);
        const runtimeWorkRoot = join(runRoot, "runtime-work");
        await mkdir(runtimeWorkRoot, { mode: 0o700 });
        workspaceRoot = await createIdentityWorkspace(
          "KeikoAcceptanceIdentity104",
        );
        deniedWorkspaceRoot = await createIdentityWorkspace(
          "KeikoAcceptanceIdentity104Denied",
        );
        await chmod(deniedWorkspaceRoot, 0o000);
        const expected = {
          packageExecutableSha256: inspected.executableSha256,
          packageManifestSha256: inspected.packageManifestSha256,
          sourceRevision,
        };
        return {
          bindings: {
            ...acceptanceIdentityContract,
            ...expected,
          },
          expected,
          internal: {
            containmentMarkers: inspected.containmentMarkers,
            packageExecutable,
            packageRoot,
            deniedWorkspaceRoot,
            persistentRuntimeHome: runtime.home,
            repositoryEvidenceCanaries: [
              workspaceRoot,
              basename(workspaceRoot),
              "KeikoRepositoryContextCanary104",
            ],
            runRoot,
            runtimeBinary: runtime.binary,
            runtimeHome: runtime.home,
            runtimeWorkRoot,
            workspaceRoot,
          },
          packageInspection: structuredClone(
            acceptancePackageInspectionContract,
          ),
        };
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
    },
    async runProductionJourney(prepared) {
      return {
        homeBefore: await snapshotProtectedRuntimeProfile(
          prepared.internal.persistentRuntimeHome,
        ),
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
        (command, args, options) =>
          runAcceptanceSubprocess(command, args, {
            output: "stdout",
            timeoutMs: options.timeoutMs,
          }).then(() => ({ error: undefined, status: 0 })),
      );
      const prompt = await readFile(
        join(
          repositoryRoot,
          "quality/fixtures/codex-tracer/no-effect-prompt.txt",
        ),
        "utf8",
      );
      const referenceEnvironmentBefore = await inspectReferenceEnvironment();
      const firstVisibleKeikoOverheadP95Ms = await measureFirstVisibleP95(
        prepared.internal,
        adapter.binary,
        cleanupDependencies,
      );
      const nativePickerCancellation =
        await measureNativePickerCancellationDistribution(
          prepared.internal,
          adapter.binary,
          cleanupDependencies,
        );
      const { child, ownership } = await establishOwnedProcess({
        authenticate: (candidate) =>
          authenticateOwnedProcessGroup(candidate, cleanupDependencies),
        launch: () => launchPackagedApp(prepared.internal),
        reject: rejectUnauthenticatedLauncher,
      });
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
        const [homeAfter, runtimeAfter, workspaceAfter] = await Promise.all([
          snapshotProtectedRuntimeProfile(
            prepared.internal.persistentRuntimeHome,
          ),
          snapshotDirectory(prepared.internal.runtimeWorkRoot),
          snapshotDirectory(prepared.internal.workspaceRoot),
        ]);
        const referenceEnvironment = assertStableReferenceEnvironment(
          referenceEnvironmentBefore,
          await inspectReferenceEnvironment(),
        );
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
            cleanupMs,
            firstVisibleKeikoOverheadP95Ms,
            localProjectionMeasurements: journey.localProjectionMeasurements,
            localProjectionP95Ms: journey.localProjectionP95Ms,
            localProjectionSamples: journey.localProjectionSamples,
            nativePickerCancellationMeasurements:
              nativePickerCancellation.measurements,
            nativePickerCancellationP95Ms: nativePickerCancellation.p95Ms,
            turnCancellationProjectionMs: journey.turnCancellationProjectionMs,
            turnDurationMs: journey.turnDurationMs,
            workspaceSelectionNativeActionMs:
              journey.workspaceSelectionNativeActionMs,
          },
          journey: structuredClone(acceptanceJourneyContract),
          physical: {
            ...structuredClone(acceptancePhysicalContract),
            packageExecutableSha256: prepared.expected.packageExecutableSha256,
            runner: process.env.ImageOS
              ? `${process.env.ImageOS}-${process.env.ImageVersion ?? "current"}`
              : "local-macos",
          },
          referenceEnvironment,
          safeguards: observedSafeguards({
            containmentMarkers: prepared.internal.containmentMarkers,
            homeAfter,
            homeBefore: production.homeBefore,
            journey,
            packageInspection: prepared.packageInspection,
            repositoryEvidenceCanaries:
              prepared.internal.repositoryEvidenceCanaries,
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
      await cleanupAcceptanceFixture(prepared);
    },
    async cleanupWorkspacePackage(prepared) {
      await cleanupAcceptanceFixture(prepared, {
        removeObservation: async () => undefined,
        removeWorkspace: async () =>
          removeWorkspaceRoots(prepared.internal.workspaceRoots),
      });
    },
    async runWorkspaceJourney(prepared, reportProgress) {
      return runWorkspaceAcceptanceJourney(prepared, reportProgress);
    },
    async writeWorkspaceEvidence(evidence) {
      await publishWorkspaceEvidenceAtomically(
        `${JSON.stringify(evidence, null, 2)}\n`,
        join(packageRoot, "codex-tracer-workspace-acceptance-evidence.json"),
      );
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
