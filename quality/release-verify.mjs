import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildReleaseBundle,
  verifyPublishedRelease,
} from "./release-system.mjs";
import {
  hardenedGitArguments,
  noReplaceGitEnvironment,
} from "./git-integrity.mjs";
import { decodeReleaseText } from "./release-io.mjs";
import { internalReleaseWorkflowFailures } from "./internal-release-workflow.mjs";
import {
  loadReleaseInputs,
  loadReleaseInputsFromRevision,
} from "./release-inputs.mjs";
import { createReleaseNativeFilesystem } from "./release-native-fs.mjs";
import {
  commandFailure,
  isDirectInvocation,
  sanitizeDiagnostic,
} from "./native-process.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hex40 = /^[0-9a-f]{40}$/u;

export function parseReleaseArguments(args) {
  if (args.length === 0) return { mode: "build" };
  if (
    args.length === 4 &&
    args[0] === "--verify-only" &&
    args[2] === "--expected-head" &&
    args[1] &&
    hex40.test(args[3])
  )
    return { directory: args[1], expectedHead: args[3], mode: "verify" };
  throw new Error("release-arguments-rejected");
}

export function dependenciesFromPolicy(policy) {
  if (
    !Array.isArray(policy?.cargoInventory) ||
    !Array.isArray(policy?.npmInventory)
  )
    throw new Error("release-dependencies-rejected");
  const entries = [
    ...policy.cargoInventory,
    ...policy.npmInventory.filter(({ dev }) => dev !== true),
  ].map(({ license, name, version }) => ({ license, name, version }));
  if (
    entries.length === 0 ||
    entries.some(
      ({ license, name, version }) =>
        !boundedText(license) || !boundedText(name) || !boundedText(version),
    )
  )
    throw new Error("release-dependencies-rejected");
  return entries.toSorted((left, right) =>
    `${left.name}@${left.version}`.localeCompare(
      `${right.name}@${right.version}`,
    ),
  );
}

export async function main(args, runtime) {
  const execution = runtime ?? defaultRuntime();
  const releaseArguments = args ?? process.argv.slice(2);
  if (execution.platform !== "darwin" || execution.architecture !== "arm64")
    throw new Error("release-platform-rejected");
  const options = parseReleaseArguments(releaseArguments);
  const revision =
    options.mode === "verify"
      ? options.expectedHead
      : await execution.runCommand(
          "git",
          hardenedGitArguments(["rev-parse", "HEAD"]),
          { capture: true },
        );
  if (!hex40.test(revision))
    throw new Error("release-source-identity-rejected");
  const workflow = decodeReleaseText(
    await execution.readWorkflow(revision),
    128 * 1024,
  );
  if (internalReleaseWorkflowFailures(workflow).length > 0)
    throw new Error("release-workflow-rejected");
  const ownedFilesystem = execution.openFilesystem
    ? await execution.openFilesystem(revision)
    : {
        close() {},
        filesystem: execution.filesystem,
        workspaceRoot: execution.workspaceRoot,
      };
  if (!ownedFilesystem.filesystem || !ownedFilesystem.workspaceRoot)
    throw new Error("release-filesystem-rejected");
  try {
    const inputs = await execution.loadInputs(
      ownedFilesystem.filesystem,
      revision,
    );
    const dependencies = dependenciesFromPolicy(inputs.policy);
    if (options.mode === "verify") {
      const expectedSourceEpoch = await sourceEpochFor(
        revision,
        execution.runCommand,
      );
      const directory = resolve(execution.repositoryRoot, options.directory);
      if (
        directory !==
        join(
          resolve(execution.repositoryRoot),
          "native/target/keiko-native-internal-release",
        )
      )
        throw new Error("release-directory-rejected");
      await execution.verify({
        directory,
        expectedRevision: revision,
        expectedSourceEpoch,
        expectedDependencies: dependencies,
        expectedInputEvidence: inputs.evidence,
        filesystem: ownedFilesystem.filesystem,
        repositoryRoot: execution.repositoryRoot,
        run: execution.runDiskImage,
        cleanupRun: execution.runDiskImageCleanup,
        workspaceRoot: ownedFilesystem.workspaceRoot,
      });
      return;
    }
    const sourceEpoch = await sourceEpochFor(revision, execution.runCommand);
    const outputRoot = join(
      execution.repositoryRoot,
      "native/target/keiko-native-internal-release",
    );
    await execution.build({
      buildPackage: () =>
        execution.runCommand("npm", ["run", "native:package"]),
      dependencies,
      inputEvidence: inputs.evidence,
      filesystem: ownedFilesystem.filesystem,
      packageRoot: join(
        execution.repositoryRoot,
        "native/target/keiko-native-package",
      ),
      revision,
      repositoryRoot: execution.repositoryRoot,
      run: execution.runDiskImage,
      cleanupRun: execution.runDiskImageCleanup,
      signal: execution.signal,
      sourceEpoch,
      workspaceRoot: ownedFilesystem.workspaceRoot,
    });
    await execution.verify({
      directory: outputRoot,
      expectedDependencies: dependencies,
      expectedInputEvidence: inputs.evidence,
      expectedRevision: revision,
      expectedSourceEpoch: sourceEpoch,
      filesystem: ownedFilesystem.filesystem,
      repositoryRoot: execution.repositoryRoot,
      run: execution.runDiskImage,
      cleanupRun: execution.runDiskImageCleanup,
      workspaceRoot: ownedFilesystem.workspaceRoot,
    });
  } finally {
    ownedFilesystem.close();
  }
}

async function sourceEpochFor(revision, runCommand) {
  const sourceEpoch = Number(
    await runCommand(
      "git",
      hardenedGitArguments(["show", "-s", "--format=%ct", revision]),
      { capture: true },
    ),
  );
  if (!Number.isSafeInteger(sourceEpoch) || sourceEpoch <= 0)
    throw new Error("release-source-identity-rejected");
  return sourceEpoch;
}

export async function runReleaseCli({
  args = process.argv.slice(2),
  processApi = process,
  runtime,
} = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  processApi.once("SIGINT", abort);
  processApi.once("SIGTERM", abort);
  try {
    const execution = runtime ?? defaultRuntime(controller.signal);
    return await main(args, {
      ...execution,
      signal: controller.signal,
    });
  } finally {
    processApi.off("SIGINT", abort);
    processApi.off("SIGTERM", abort);
  }
}

function defaultRuntime(signal) {
  return {
    architecture: process.arch,
    build: buildReleaseBundle,
    platform: process.platform,
    loadInputs: (filesystem, revision) =>
      revision
        ? loadReleaseInputsFromRevision(revision, (head, path) =>
            run("git", hardenedGitArguments(["show", `${head}:${path}`]), {
              binary: true,
              capture: true,
              signal,
            }),
          )
        : loadReleaseInputs(repositoryRoot, filesystem),
    openFilesystem: (revision) =>
      createReleaseNativeFilesystem(
        repositoryRoot,
        (command, commandArgs, options) =>
          run(command, commandArgs, { ...options, signal }),
        { revision },
      ),
    readWorkflow: (revision) =>
      run(
        "git",
        hardenedGitArguments([
          "show",
          `${revision}:.github/workflows/internal-release.yml`,
        ]),
        {
          binary: true,
          capture: true,
          signal,
        },
      ),
    repositoryRoot,
    runCommand: (command, commandArgs, options) =>
      run(command, commandArgs, { ...options, signal }),
    runDiskImage: (command, commandArgs) =>
      run(command, commandArgs, { signal }),
    runDiskImageCleanup: (command, commandArgs) =>
      run(command, commandArgs, { signal: AbortSignal.timeout(15_000) }),
    verify: verifyPublishedRelease,
  };
}

export function runCancellableCommand(
  command,
  args,
  {
    binary = false,
    capture = false,
    cwd = repositoryRoot,
    signal,
    terminationGraceMs = 250,
  } = {},
) {
  return new Promise((resolveCommand, rejectCommand) => {
    if (signal?.aborted) {
      rejectCommand(new Error("release-cancelled"));
      return;
    }
    const commandArgs = command === "git" ? hardenedGitArguments(args) : args;
    const child = spawn(command, commandArgs, {
      cwd,
      detached: process.platform !== "win32",
      env: noReplaceGitEnvironment(process.env),
      stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let closeStatus;
    let leaderClosed = false;
    let settled = false;
    let spawnError;
    let terminationReason;
    let terminationTimer;
    let reapTimer;
    const ownsProcessGroup =
      process.platform !== "win32" && Number.isSafeInteger(child.pid);
    const killOwned = (kind) => {
      try {
        if (!ownsProcessGroup) child.kill(kind);
        else process.kill(-child.pid, kind);
      } catch (error) {
        if (error?.code !== "ESRCH") spawnError ??= error;
      }
    };
    const ownedProcessesRemain = () => {
      if (!ownsProcessGroup) return !leaderClosed;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        spawnError ??= error;
        return true;
      }
    };
    const finish = () => {
      if (settled || !leaderClosed) return;
      if (terminationReason && ownedProcessesRemain()) return;
      settled = true;
      clearTimeout(terminationTimer);
      clearTimeout(reapTimer);
      signal?.removeEventListener("abort", abort);
      if (terminationReason === "release-cancelled")
        rejectCommand(new Error(terminationReason));
      else if (terminationReason === "release-process-group-remained")
        rejectCommand(new Error(terminationReason));
      else if (spawnError || closeStatus !== 0 || bytes > 30 * 1024 * 1024)
        rejectCommand(
          commandFailure(command, commandArgs, {
            error: spawnError,
            status: closeStatus,
            stderr: Buffer.concat(stderr),
            stdout: Buffer.concat(stdout),
          }),
        );
      else if (!capture) resolveCommand(undefined);
      else {
        const value = Buffer.concat(stdout);
        resolveCommand(binary ? value : value.toString("utf8").trim());
      }
    };
    const pollForGroupExit = () => {
      if (!terminationReason || settled) return;
      if (!ownedProcessesRemain()) {
        finish();
        return;
      }
      reapTimer = setTimeout(pollForGroupExit, 10);
    };
    const escalate = () => {
      killOwned("SIGKILL");
      pollForGroupExit();
    };
    const terminateOwned = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      killOwned("SIGTERM");
      terminationTimer = setTimeout(escalate, terminationGraceMs);
    };
    const abort = () => terminateOwned("release-cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const collect = (chunks) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 30 * 1024 * 1024) terminateOwned("release-output-limit");
      else chunks.push(chunk);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (status) => {
      closeStatus = status;
      leaderClosed = true;
      if (!terminationReason && ownedProcessesRemain())
        terminateOwned("release-process-group-remained");
      finish();
    });
  });
}

const run = runCancellableCommand;

function boundedText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

if (isDirectInvocation(process.argv[1], fileURLToPath(import.meta.url))) {
  runReleaseCli().catch((error) => {
    console.error(sanitizeDiagnostic(error?.message ?? String(error)));
    process.exitCode = 1;
  });
}
