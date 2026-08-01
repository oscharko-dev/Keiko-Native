import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  hardenedGitArguments,
  noReplaceGitEnvironment,
} from "./git-integrity.mjs";
import { evidenceFailures, redactionMatches } from "./native-contract.mjs";
import {
  acceptanceBudgetLimits,
  acceptanceJourneyContract,
  acceptancePackageInspectionContract,
  acceptancePhysicalContract,
  acceptanceSafeguardContract,
} from "./codex-tracer-acceptance.mjs";
import {
  compileTracerAccessibility,
  percentile95,
  runPackagedTracerJourney,
  waitForTracerAccessibilityAction,
} from "./codex-tracer-accessibility.mjs";
import {
  authenticateOwnedProcessGroup,
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
const runtimeBinary =
  "/private/tmp/keiko-codex-0.145.0-runtime/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";
const runtimeHome = "/private/tmp/keiko-codex-0.145.0-home-v104";
const physicalObservationPath =
  "/private/tmp/keiko-native-codex-tracer-104-observation.json";

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
    JSON.stringify(Object.keys(environment).toSorted()) !==
      JSON.stringify(Object.keys(acceptedEnvironment).toSorted())
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
  ].toSorted();
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    JSON.stringify(Object.keys(manifest).toSorted()) !==
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
      JSON.stringify(Object.keys(entry).toSorted()) !==
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
  );
  failures.push(
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
  ].toSorted();
  if (
    typeof observation !== "object" ||
    observation === null ||
    Array.isArray(observation) ||
    JSON.stringify(Object.keys(observation).toSorted()) !==
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: noReplaceGitEnvironment({ ...process.env, ...options.env }),
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

async function inspectEnvironment() {
  const [runtimeBytes, promptBytes] = await Promise.all([
    readFile(runtimeBinary),
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
      runtimeBinary,
      ["-c", 'cli_auth_credentials_store="keyring"', "login", "status"],
      { env: { CODEX_HOME: runtimeHome }, output: "stderr" },
    ),
    nodeVersion: process.versions.node,
    npmVersion: exactNpmVersion(),
    platform: process.platform,
    promptBytes: promptBytes.byteLength,
    promptSha256: sha256(promptBytes),
    runtimeSha256: sha256(runtimeBytes),
    runtimeVersion: run(runtimeBinary, ["--version"]),
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
  return inspected;
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

async function crashOwnedRuntime(appPid) {
  const processes = run("/bin/ps", ["-axo", "pid=,ppid=,pgid=,command="])
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line))
    .filter(Boolean)
    .map((match) => ({
      command: match[4],
      pgid: Number.parseInt(match[3], 10),
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
    }))
    .filter(
      (process) =>
        process.ppid === appPid &&
        process.pgid === process.pid &&
        (process.command === runtimeBinary ||
          process.command.startsWith(`${runtimeBinary} `)),
    );
  if (processes.length !== 1)
    throw new Error("acceptance-runtime-ownership-invalid");
  const [runtime] = processes;
  await authenticateOwnedProcessGroup({ pid: runtime.pid });
  process.kill(-runtime.pgid, "SIGKILL");
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
    env: {
      ...process.env,
      KEIKO_CODEX_0_145_0_BINARY: internal.runtimeBinary,
      KEIKO_CODEX_0_145_0_HOME: internal.runtimeHome,
      KEIKO_CODEX_0_145_0_WORK_ROOT: internal.runtimeWorkRoot,
    },
    stdio: "ignore",
  });
}

async function measureFirstVisibleP95(internal, adapterBinary) {
  const observations = [];
  for (
    let repetition = 0;
    repetition < acceptanceBudgetLimits.firstVisibleKeikoOverheadSamples;
    repetition += 1
  ) {
    const startedAt = performance.now();
    const child = launchPackagedApp(internal);
    const ownership = await authenticateOwnedProcessGroup(child);
    try {
      const visible = await waitForTracerAccessibilityAction({
        action: "probe-start",
        binary: adapterBinary,
        pid: child.pid,
        timeoutMs: 2_000,
      });
      if (visible.status !== "passed")
        throw new Error("acceptance-first-visible-failed");
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0)
        throw new Error("acceptance-first-visible-measurement-invalid");
      observations.push(elapsedMs);
      const quit = await waitForTracerAccessibilityAction({
        action: "quit",
        binary: adapterBinary,
        pid: child.pid,
        timeoutMs: 5_000,
      });
      if (
        quit.status !== "passed" ||
        !(await waitForProcessExit(child.pid, 5_000))
      )
        throw new Error("acceptance-first-visible-cleanup-failed");
    } finally {
      await terminateOwnedProcess(ownership);
    }
  }
  return percentile95(observations);
}

export function createCodexTracerAcceptanceIo() {
  return {
    async preparePackage() {
      const environment = await inspectEnvironment();
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
          packageExecutable,
          packageRoot,
          deniedWorkspaceRoot,
          runRoot,
          runtimeBinary,
          runtimeHome,
          runtimeWorkRoot,
          workspaceRoot,
        },
        packageInspection: structuredClone(acceptancePackageInspectionContract),
      };
    },
    async runProductionJourney() {
      return { safeguards: structuredClone(acceptanceSafeguardContract) };
    },
    async runPhysicalJourney(prepared) {
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
      );
      const child = launchPackagedApp(prepared.internal);
      const ownership = await authenticateOwnedProcessGroup(child);
      let cleaned = false;
      try {
        const journey = await runPackagedTracerJourney({
          crashRuntime: () => crashOwnedRuntime(child.pid),
          deniedWorkspaceLabel: basename(prepared.internal.deniedWorkspaceRoot),
          execute: (request) =>
            waitForTracerAccessibilityAction({
              ...request,
              binary: adapter.binary,
              pid: child.pid,
            }),
          prompt,
          workspaceLabel: basename(prepared.internal.workspaceRoot),
        });
        const cleanupStartedAt = performance.now();
        if (!(await waitForProcessExit(child.pid, 5_000)))
          throw new Error("acceptance-app-quit-failed");
        await terminateOwnedProcess(ownership);
        const cleanupMs = Math.round(performance.now() - cleanupStartedAt);
        cleaned = true;
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
          safeguards: {},
        };
      } finally {
        if (!cleaned) await terminateOwnedProcess(ownership);
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
