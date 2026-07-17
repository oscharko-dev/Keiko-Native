import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FULL_COUNTS,
  buildSchedule,
  buildDarwinSessionObserver,
  distribution,
  governedCheckout,
  inventory,
  launchServicesArguments,
  percentile,
  redactionFailures,
  releaseHookScan,
  runCandidate,
  sanitizeCandidateEvidence,
  sanitizedFailure,
  summarize,
  validateCandidateEvidence,
  validateCandidateEvidenceMap,
  validateAuthorityObservation,
  validateCandidatePackagePaths,
  validateDiagnosticProvenance,
  validateReleaseCompositionManifest,
  withDarwinSessionObserver,
} from "./foundation-evaluation/harness.mjs";

function validTauriEvidence(mode) {
  return {
    candidate: "tauri-system-webview",
    dependencies: {
      frontend: "react-19.2.7-typescript-5.9.3-vite-7.3.6-axe-core-4.12.1",
      host: "tauri-2.11.5",
      renderer: "system-webview",
      rust: "1.92.0",
    },
    diagnostics: {
      appearanceDiagnostic: true,
      compositionDiagnostic: true,
      focusDiagnostic: true,
      inputDiagnosticMs: 12,
      scaleFactorDiagnostic: 2,
    },
    environment: {
      architecture: "aarch64",
      osFamily: "macos",
      referenceClass: "owner-m4-16gib-macos26",
    },
    journey: {
      accessibility: "accepted",
      axeRuleIds: [],
      axeViolationCount: 0,
      cancelledWork: "cancelled",
      firstInstanceId: "first",
      fixtureEscalated: true,
      fixtureDescendantAbsent: true,
      fixtureExecChanged: true,
      fixtureGroupAbsent: true,
      fixtureParentReaped: true,
      fixtureSessionIsolated: true,
      fixtureProcess: "accepted",
      hostSurvived: true,
      invalidRequestCount: 2,
      nativeDialog: "accepted",
      oversized: "payload_too_large",
      ping: "accepted",
      prepareRenderer: "accepted",
      probeAclDenied: true,
      rendererCycle: "accepted",
      rendererRecreated: true,
      replay: "replayed_request",
      runtimeEvent: "accepted",
      runtimeEventCommitted: "accepted",
      runtimeToUiMs: 20,
      secondInstanceId: "second",
      stableShell: "accepted",
      timedOutWork: "timed_out",
    },
    mode,
    processAccounting: {
      definition: "root-process-and-observed-descendants",
      limitation:
        "shared-webkit-xpc-processes-are-not-consistently-attributable",
      rssComparableForWinGate: false,
    },
    schemaVersion: 1,
  };
}

const runnerFixture = Object.fromEntries(
  [
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
  ].map((key) => [key, true]),
);
const unitSessionObserver = { sessionFor: (pid) => pid };
const exactRustcVersion = `rustc 1.92.0 (ded5c06cf 2025-12-08)
binary: rustc
commit-hash: ded5c06cf21d2b93bffd5d884aa6e96934ee4234
commit-date: 2025-12-08
host: aarch64-apple-darwin
release: 1.92.0
LLVM version: 21.1.3
`;

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function launcherFixture(scenario) {
  const root = await mkdtemp(join(tmpdir(), "foundation-launcher-"));
  const packagePath = join(root, "Candidate.app");
  const executable = join(packagePath, "Contents", "MacOS", "fixture-app");
  const openPath = join(root, "fake-open");
  const lateHelper = join(root, "late-helper.mjs");
  const escapeHelper = join(root, "escape-helper.mjs");
  const escapeWorker = join(root, "escape-worker.mjs");
  await mkdir(join(packagePath, "Contents", "MacOS"), { recursive: true });
  const evidence = JSON.stringify(validTauriEvidence("cold"));
  const success = [
    `printf '%s\\n' 'KEIKO_PRESENTED'`,
    `printf '%s\\n' ${shellQuote(`KEIKO_EVIDENCE:${evidence}`)}`,
    `printf '%s\\n' 'KEIKO_SHUTDOWN_START'`,
  ].join("\n");
  const behavior =
    scenario === "success" || scenario === "escaped"
      ? [
          ...(scenario === "escaped"
            ? [
                `${shellQuote(process.execPath)} ${shellQuote(escapeHelper)} ${shellQuote(escapeWorker)} "$5"`,
              ]
            : []),
          success,
        ].join("\n")
      : scenario === "oversized"
        ? 'sleep 0.2\ni=0\nwhile [ "$i" -lt 7000 ]; do printf 0123456789; i=$((i+1)); done\nwhile :; do sleep 1; done'
        : "trap '' TERM\nwhile :; do sleep 1; done";
  if (scenario === "escaped" || scenario === "abandoned") {
    await writeFile(
      executable,
      `#!${process.execPath}
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const child = spawn("/bin/sh", ["-c", "trap '' TERM; while IFS= read -r _; do :; done", ${JSON.stringify(escapeWorker)}, value("--fixture-marker")], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
const waitFor = async (path) => { for (let index = 0; index < 2_000 && !existsSync(path); index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };
await waitFor(value("--fixture-ack"));
${scenario === "abandoned" ? "process.exit(0);" : ""}
process.kill(-child.pid, "SIGTERM");
await new Promise((resolve) => setTimeout(resolve, 125));
console.log("KEIKO_FIXTURE_ESCALATED");
await waitFor(value("--fixture-escalation-ack"));
process.kill(-child.pid, "SIGKILL");
await new Promise((resolve) => child.exitCode === null && child.signalCode === null ? child.once("exit", resolve) : resolve());
console.log("KEIKO_FIXTURE_CLEANED");
await waitFor(value("--fixture-cleanup-ack"));
console.log("KEIKO_PRESENTED");
console.log(${JSON.stringify(`KEIKO_EVIDENCE:${evidence}`)});
console.log("KEIKO_SHUTDOWN_START");
`,
    );
  } else await writeFile(executable, `#!/bin/sh\n${behavior}\n`);
  await writeFile(
    lateHelper,
    `import { openSync } from "node:fs";
import { spawn } from "node:child_process";
const [mode, executable, stdout, stderr, ...args] = process.argv.slice(2);
if (mode === "parent") {
  spawn(process.execPath, [import.meta.filename, "child", executable, stdout, stderr, ...args], {
    detached: true,
    stdio: "ignore",
  }).unref();
} else {
  await new Promise((resolve) => setTimeout(resolve, 200));
  const output = openSync(stdout, "w");
  const errors = openSync(stderr, "w");
  spawn(executable, args, { detached: true, stdio: ["ignore", output, errors] }).unref();
}
`,
  );
  await writeFile(
    escapeHelper,
    `import { spawn } from "node:child_process";
const [worker, marker] = process.argv.slice(2);
spawn(process.execPath, [worker, marker], { detached: true, stdio: "ignore" }).unref();
`,
  );
  await writeFile(
    escapeWorker,
    `process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`,
  );
  const launch =
    scenario === "delayed"
      ? `${shellQuote(process.execPath)} ${shellQuote(lateHelper)} parent "$executable" "$stdout" "$stderr" "$@"\nexit 1`
      : `"$executable" "$@" >"$stdout" 2>"$stderr" &
child=$!
wait "$child"`;
  await writeFile(
    openPath,
    `#!/bin/sh
stdout=
stderr=
app=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --stdout) stdout=$2; shift 2 ;;
    --stderr) stderr=$2; shift 2 ;;
    --env) shift 2 ;;
    --args) shift; break ;;
    -n|-F|-W) shift ;;
    *) app=$1; shift ;;
  esac
done
for executable in "$app"/Contents/MacOS/*; do
  [ -f "$executable" ] && break
done
${launch}
`,
  );
  await Promise.all([chmod(executable, 0o700), chmod(openPath, 0o700)]);
  return { escapeWorker, executable, openPath, packagePath, root };
}

function exactProcessCount(executable) {
  const pattern = executable.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const result = spawnSync("/usr/bin/pgrep", ["-f", pattern]);
  return result.status === 1
    ? 0
    : result.stdout.toString("utf8").trim().split(/\s+/u).filter(Boolean)
        .length;
}

test("keeps the release-like Tauri input editable without an evaluation hook", () => {
  const release = readFileSync(
    join(
      import.meta.dirname,
      "../experiments/tauri-renderer/web/release/src/main.tsx",
    ),
    "utf8",
  );
  assert.match(release, /useState\("ready"\)/u);
  assert.match(release, /onInput=\{/u);
  assert.doesNotMatch(release, /evaluation|invoke|dispatch/u);
});

test("uses the exact governed LaunchServices package invocation", () => {
  const arguments_ = launchServicesArguments({
    mode: "cold",
    packagePath: "/tmp/Candidate.app",
    stderrPath: "/tmp/stderr",
    stdoutPath: "/tmp/stdout",
  });
  assert.deepEqual(arguments_.slice(0, 7), [
    "-n",
    "-F",
    "-W",
    "--stdout",
    "/tmp/stdout",
    "--stderr",
    "/tmp/stderr",
  ]);
  assert.ok(arguments_.includes("--env"));
  assert.equal(arguments_.includes("-o"), false);
  assert.deepEqual(arguments_.slice(-5), [
    "/tmp/Candidate.app",
    "--args",
    "--evaluation-json",
    "--mode",
    "cold",
  ]);
});

test("failure reporting is closed and never exposes raw diagnostics or paths", () => {
  const failure = sanitizedFailure(
    new Error("/Users/local/private credential raw stderr"),
    {
      appPid: 42,
      candidate: "tauri",
      mode: "warm",
      sequence: 55,
      stderrBytes: 12,
      wrapperStarted: true,
    },
  );
  assert.deepEqual(failure, {
    app: "running",
    candidate: "tauri",
    category: "unknown",
    lastCandidateCode: "unavailable",
    markers: {
      evidence: "missing",
      presented: "missing",
      shutdown: "missing",
    },
    mode: "warm",
    sequence: 55,
    stderr: "present",
    wrapper: "running",
  });
  assert.doesNotMatch(JSON.stringify(failure), /Users|credential|raw stderr/u);
  assert.equal(
    sanitizedFailure(
      new Error("tauri retained identity string contract mismatch"),
    ).category,
    "identity_contract",
  );
  assert.equal(
    sanitizedFailure(new Error("raw environment details"), {
      stage: "provenance",
    }).stage,
    "provenance",
  );
  for (const [message, category] of [
    [
      "session helper rustc version is unauthorized",
      "session_observer_version",
    ],
    ["session helper source binding is invalid", "session_observer_source"],
    ["session helper build failed", "session_observer_build"],
    ["session helper executable is invalid", "session_observer_executable"],
    ["session helper observation failed", "session_observer_observation"],
  ])
    assert.equal(sanitizedFailure(new Error(message)).category, category);
  assert.equal(
    "stage" in
      sanitizedFailure(new Error("raw environment details"), {
        stage: "not-allowlisted",
      }),
    false,
  );
});

test("LaunchServices runner tracks the exact packaged process and bounded markers", async () => {
  const fixture = await launcherFixture("success");
  try {
    const { evidencePayload, sample } = await runCandidate(
      {
        executable: fixture.executable,
        packagePath: fixture.packagePath,
      },
      { candidate: "tauri", iteration: 0, mode: "cold", sequence: 0 },
      {},
      {
        openPath: fixture.openPath,
        sessionObserver: unitSessionObserver,
        timeoutMs: 1_000,
      },
    );
    assert.equal(sample.candidate, "tauri");
    assert.equal(evidencePayload.lifecycle.instanceDistinct, true);
    assert.equal(sample.mode, "cold");
    assert.equal(exactProcessCount(fixture.executable), 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("LaunchServices runner bounds output and escalates timed-out process cleanup", async () => {
  for (const [scenario, pattern] of [
    ["oversized", "output_bound"],
    ["timeout", "timeout"],
  ]) {
    const fixture = await launcherFixture(scenario);
    try {
      await assert.rejects(
        () =>
          runCandidate(
            {
              executable: fixture.executable,
              packagePath: fixture.packagePath,
            },
            { candidate: "tauri", iteration: 0, mode: "cold", sequence: 0 },
            {},
            {
              openPath: fixture.openPath,
              sessionObserver: unitSessionObserver,
              timeoutMs: scenario === "oversized" ? 1_000 : 500,
            },
          ),
        (error) => sanitizedFailure(error).category === pattern,
      );
      assert.equal(exactProcessCount(fixture.executable), 0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("LaunchServices runner rejects stale and cleans delayed exact executables", async () => {
  const staleFixture = await launcherFixture("timeout");
  const stale = spawn(staleFixture.executable, [], {
    detached: true,
    stdio: "ignore",
  });
  try {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    await assert.rejects(
      () =>
        runCandidate(
          {
            executable: staleFixture.executable,
            packagePath: staleFixture.packagePath,
          },
          { candidate: "tauri", iteration: 0, mode: "cold", sequence: 0 },
          {},
          {
            openPath: staleFixture.openPath,
            sessionObserver: unitSessionObserver,
            timeoutMs: 100,
          },
        ),
      (error) => sanitizedFailure(error).category === "preexisting_process",
    );
  } finally {
    process.kill(-stale.pid, "SIGKILL");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    await rm(staleFixture.root, { recursive: true, force: true });
  }

  const delayedFixture = await launcherFixture("delayed");
  try {
    await assert.rejects(() =>
      runCandidate(
        {
          executable: delayedFixture.executable,
          packagePath: delayedFixture.packagePath,
        },
        { candidate: "tauri", iteration: 0, mode: "cold", sequence: 0 },
        {},
        {
          openPath: delayedFixture.openPath,
          sessionObserver: unitSessionObserver,
          timeoutMs: 100,
        },
      ),
    );
    assert.equal(exactProcessCount(delayedFixture.executable), 0);
  } finally {
    await rm(delayedFixture.root, { recursive: true, force: true });
  }
});

test("observes and cleans a fixture that escapes its original process session", async () => {
  const fixture = await launcherFixture("escaped");
  try {
    const result = await runCandidate(
      {
        executable: fixture.executable,
        packagePath: fixture.packagePath,
      },
      { candidate: "tauri", iteration: 0, mode: "cold", sequence: 0 },
      {},
      {
        openPath: fixture.openPath,
        requireFixtureObservation: true,
        sessionObserver: unitSessionObserver,
        timeoutMs: 15_000,
      },
    );
    assert.deepEqual(result.evidencePayload.fixture, runnerFixture);
  } finally {
    for (const pid of spawnSync("/usr/bin/pgrep", ["-f", fixture.escapeWorker])
      .stdout.toString("utf8")
      .trim()
      .split(/\s+/u)
      .filter(Boolean))
      try {
        process.kill(-Number(pid), "SIGKILL");
      } catch {
        process.kill(Number(pid), "SIGKILL");
      }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cleans an observed fixture abandoned by its candidate", async () => {
  const fixture = await launcherFixture("abandoned");
  try {
    await assert.rejects(() =>
      runCandidate(
        {
          executable: fixture.executable,
          packagePath: fixture.packagePath,
        },
        { candidate: "tauri", iteration: 0, mode: "cold", sequence: 0 },
        {},
        {
          openPath: fixture.openPath,
          requireFixtureObservation: true,
          sessionObserver: unitSessionObserver,
          timeoutMs: 1_000,
        },
      ),
    );
    assert.equal(exactProcessCount(fixture.escapeWorker), 0);
  } finally {
    for (const pid of spawnSync("/usr/bin/pgrep", ["-f", fixture.escapeWorker])
      .stdout.toString("utf8")
      .trim()
      .split(/\s+/u)
      .filter(Boolean))
      try {
        process.kill(-Number(pid), "SIGKILL");
      } catch {
        process.kill(Number(pid), "SIGKILL");
      }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("allows internal relative symlinks and rejects resolved package escapes", async () => {
  const parent = await mkdtemp(join(tmpdir(), "foundation-inventory-"));
  try {
    const root = join(parent, "package");
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "bin", "tool"), "owned");
    await symlink("bin/tool", join(root, "tool"));
    assert.equal((await inventory(root)).files.length, 2);

    await writeFile(join(parent, "outside"), "private");
    await symlink("../../outside", join(root, "bin", "escape"));
    await assert.rejects(() => inventory(root), /symlink escapes/u);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("contains candidate packages at their exact governed target suffixes", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-paths-"));
  try {
    const candidateRoot = join(root, "experiments", "tauri-renderer");
    const packagePath = join(
      candidateRoot,
      "target/evaluation/release/bundle/macos/Keiko Foundation Tauri Evaluation.app",
    );
    const releasePackagePath = join(
      candidateRoot,
      "target/release-like/release/bundle/macos/Keiko Foundation Tauri Evaluation.app",
    );
    await Promise.all([
      mkdir(packagePath, { recursive: true }),
      mkdir(releasePackagePath, { recursive: true }),
    ]);
    await assert.doesNotReject(() =>
      validateCandidatePackagePaths(root, "tauri", {
        packagePath,
        releasePackagePath,
      }),
    );
    const outside = join(root, "outside.app");
    await mkdir(outside);
    await assert.rejects(
      () =>
        validateCandidatePackagePaths(root, "tauri", {
          packagePath: outside,
          releasePackagePath,
        }),
      /exact governed package path/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binds diagnostic evidence to the exact authorized workflow run", () => {
  const commit = "a".repeat(40);
  const environment = {
    GITHUB_REF: "refs/heads/codex/11-foundation-macos-decision",
    GITHUB_REPOSITORY: "oscharko-dev/Keiko-Native",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_RUN_ID: "123456",
    GITHUB_SHA: commit,
    GITHUB_WORKFLOW_REF:
      "oscharko-dev/Keiko-Native/.github/workflows/foundation-evaluation.yml@refs/heads/codex/11-foundation-macos-decision",
    KEIKO_FOUNDATION_ARTIFACT_FILE:
      ".foundation-evaluation/diagnostic-macos-26.json",
    KEIKO_FOUNDATION_ARTIFACT_NAME: "foundation-diagnostic-macos-26",
    KEIKO_FOUNDATION_RUNNER_LABEL: "macos-26",
    KEIKO_FOUNDATION_WORKFLOW_SHA: commit,
  };
  assert.equal(
    validateDiagnosticProvenance(environment, { commit }).runId,
    "123456",
  );
  assert.throws(
    () =>
      validateDiagnosticProvenance(
        { ...environment, KEIKO_FOUNDATION_WORKFLOW_SHA: "b".repeat(40) },
        { commit },
      ),
    /provenance is unauthorized/u,
  );
  assert.throws(
    () =>
      validateDiagnosticProvenance(
        { ...environment, GITHUB_REF: "refs/heads/dev" },
        { commit },
      ),
    /provenance is unauthorized/u,
  );
});

test(
  "binds the Darwin session observer to exact Rust identity and source",
  {
    skip:
      process.platform !== "darwin" ||
      process.arch !== "arm64" ||
      !process.env.KEIKO_FOUNDATION_RUSTC,
  },
  async () => {
    const root = join(import.meta.dirname, "..");
    const rustcPath = process.env.KEIKO_FOUNDATION_RUSTC;
    assert.ok(rustcPath?.startsWith("/"));
    const observer = buildDarwinSessionObserver(root, { rustcPath });
    const child = spawn("/usr/bin/tail", ["-f", "/dev/null"], {
      detached: true,
      stdio: "ignore",
    });
    try {
      assert.equal(observer.sessionFor(child.pid), child.pid);
    } finally {
      const exited = new Promise((resolveExit) =>
        child.once("exit", resolveExit),
      );
      process.kill(-child.pid, "SIGKILL");
      await exited;
      assert.equal(
        spawnSync("/usr/bin/pgrep", ["-g", String(child.pid)]).status,
        1,
      );
      observer.dispose();
    }
  },
);

test("reuses only an exact governed prepared session observer", async () => {
  const repositoryRoot = join(import.meta.dirname, "..");
  const preparedRoot = await mkdtemp(join(tmpdir(), "prepared-observer-"));
  const executable = join(preparedRoot, "session-observer");
  await writeFile(executable, "prepared fixture", { mode: 0o700 });
  const executableSha256 = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  const resolvedExecutable = await realpath(executable);
  const result = (status, stdout = "", stderr = "", overrides = {}) => ({
    error: undefined,
    signal: null,
    status,
    stderr,
    stdout,
    ...overrides,
  });
  const observer = buildDarwinSessionObserver(repositoryRoot, {
    architecture: "arm64",
    platform: "darwin",
    prepared: {
      executable,
      executableSha256,
      root: preparedRoot,
    },
    run: (command, arguments_) => {
      assert.equal(command, resolvedExecutable);
      assert.deepEqual(arguments_, ["17"]);
      return result(0, "17\n");
    },
  });
  try {
    assert.equal(observer.sessionFor(17), 17);
    assert.deepEqual(observer.binding, {
      executableSha256,
      kind: "workflow-prepared",
      sourceSha256:
        "d37babdcf3cd0c7358cf99f015abcbc89b42246cceb48c0a44bd74f26e1c2a4c",
    });
  } finally {
    observer.dispose();
    assert.equal(existsSync(executable), true);
    const preparedOptions = (overrides = {}) => ({
      architecture: "arm64",
      platform: "darwin",
      prepared: {
        executable,
        executableSha256,
        root: preparedRoot,
        ...overrides,
      },
      run: () => result(0, "17\n"),
    });
    await chmod(executable, 0o600);
    assert.throws(
      () => buildDarwinSessionObserver(repositoryRoot, preparedOptions()),
      /prepared session helper executable is invalid/u,
    );
    await chmod(executable, 0o700);
    assert.throws(
      () =>
        buildDarwinSessionObserver(
          repositoryRoot,
          preparedOptions({ executableSha256: "0".repeat(64) }),
        ),
      /prepared session helper executable is invalid/u,
    );
    const containedRoot = join(preparedRoot, "contained");
    await mkdir(containedRoot, { mode: 0o700 });
    assert.throws(
      () =>
        buildDarwinSessionObserver(
          repositoryRoot,
          preparedOptions({ root: containedRoot }),
        ),
      /prepared session helper path is unauthorized/u,
    );
    const symlinkPath = join(preparedRoot, "observer-link");
    await symlink(executable, symlinkPath);
    assert.throws(
      () =>
        buildDarwinSessionObserver(
          repositoryRoot,
          preparedOptions({ executable: symlinkPath }),
        ),
      /prepared session helper executable is invalid/u,
    );
    await rm(preparedRoot, { force: true, recursive: true });
  }
});

test("treats an observer target that exited after discovery as absent", async () => {
  const repositoryRoot = join(import.meta.dirname, "..");
  const preparedRoot = await mkdtemp(join(tmpdir(), "prepared-observer-race-"));
  const executable = join(preparedRoot, "session-observer");
  await writeFile(executable, "prepared fixture", { mode: 0o700 });
  const executableSha256 = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  const observer = buildDarwinSessionObserver(repositoryRoot, {
    architecture: "arm64",
    platform: "darwin",
    prepared: {
      executable,
      executableSha256,
      root: preparedRoot,
    },
    run: () => ({
      error: undefined,
      signal: null,
      status: 65,
      stderr: "",
      stdout: "",
    }),
  });
  try {
    assert.equal(observer.sessionFor(17), undefined);
  } finally {
    observer.dispose();
    await rm(preparedRoot, { force: true, recursive: true });
  }
});

test("fails closed for compiler, source, build, and observer drift", async () => {
  const root = join(import.meta.dirname, "..");
  const rustcPath = "/bin/sh";
  const build = (options) =>
    buildDarwinSessionObserver(root, {
      architecture: "arm64",
      platform: "darwin",
      rustcPath,
      ...options,
    });
  const result = (status, stdout = "", stderr = "", overrides = {}) => ({
    error: undefined,
    signal: null,
    status,
    stderr,
    stdout,
    ...overrides,
  });
  for (const version of [
    result(1),
    result(0, exactRustcVersion, "warning"),
    result(0, exactRustcVersion, "", { error: new Error("unavailable") }),
    result(0, exactRustcVersion, "", { signal: "SIGTERM" }),
  ])
    assert.throws(
      () =>
        build({
          run: () => version,
        }),
      /version is unauthorized/u,
    );

  const tamperedRoot = await mkdtemp(join(tmpdir(), "session-source-"));
  try {
    await mkdir(join(tamperedRoot, "quality/foundation-evaluation"), {
      recursive: true,
    });
    await writeFile(
      join(tamperedRoot, "quality/foundation-evaluation/session-observer.rs"),
      "fn main() {}\n",
    );
    assert.throws(
      () =>
        buildDarwinSessionObserver(tamperedRoot, {
          architecture: "arm64",
          platform: "darwin",
          run: () => result(0, exactRustcVersion),
          rustcPath,
        }),
      /source binding is invalid/u,
    );
  } finally {
    await rm(tamperedRoot, { force: true, recursive: true });
  }

  for (const buildResult of [
    result(1),
    result(0, "", "warning"),
    result(0, "", "", { error: new Error("failed") }),
    result(0, "", "", { signal: "SIGKILL" }),
  ]) {
    let generatedRoot;
    assert.throws(
      () =>
        build({
          run: (_command, arguments_) => {
            if (arguments_[0] === "--version")
              return result(0, exactRustcVersion);
            generatedRoot = join(
              arguments_[arguments_.indexOf("-o") + 1],
              "..",
            );
            return buildResult;
          },
        }),
      /build failed/u,
    );
    assert.equal(existsSync(generatedRoot), false);
  }

  for (const outputKind of ["directory", "symlink"]) {
    let generatedRoot;
    assert.throws(
      () =>
        build({
          run: (_command, arguments_) => {
            if (arguments_[0] === "--version")
              return result(0, exactRustcVersion);
            const output = arguments_[arguments_.indexOf("-o") + 1];
            generatedRoot = join(output, "..");
            if (outputKind === "directory") mkdirSync(output);
            else {
              const target = join(generatedRoot, "disposable-target");
              writeFileSync(target, "fixture", { mode: 0o600 });
              symlinkSync(target, output);
            }
            return result(0);
          },
        }),
      /executable is invalid/u,
    );
    assert.equal(existsSync(generatedRoot), false);
  }

  for (const observation of [
    result(1),
    result(0, "1\n", "warning"),
    result(0, "1\n", "", { error: new Error("failed") }),
    result(0, "1\n", "", { signal: "SIGTERM" }),
    result(0, "not-a-session\n"),
    result(0, "2147483648\n"),
    result(0, "1\n2\n"),
  ]) {
    let generatedRoot;
    const observer = build({
      run: (_command, arguments_) => {
        if (arguments_[0] === "--version") return result(0, exactRustcVersion);
        const outputIndex = arguments_.indexOf("-o");
        if (outputIndex !== -1) {
          writeFileSync(arguments_[outputIndex + 1], "fixture", {
            mode: 0o700,
          });
          generatedRoot = join(arguments_[outputIndex + 1], "..");
          return result(0);
        }
        return observation;
      },
    });
    try {
      assert.throws(() => observer.sessionFor(1), /session helper/u);
    } finally {
      observer.dispose();
      assert.equal(existsSync(generatedRoot), false);
    }
  }
});

test("builds one observer across samples and disposes on success or failure", async () => {
  for (const shouldFail of [false, true]) {
    let builds = 0;
    let disposals = 0;
    const work = withDarwinSessionObserver(
      "/repository",
      { rustcPath: "/rustc" },
      async (observer) => {
        for (const pid of [11, 12, 13])
          assert.equal(observer.sessionFor(pid), pid);
        if (shouldFail) throw new Error("sample failed");
        return "complete";
      },
      () => {
        builds += 1;
        return {
          dispose: () => {
            disposals += 1;
          },
          sessionFor: (pid) => pid,
        };
      },
    );
    if (shouldFail) await assert.rejects(work, /sample failed/u);
    else assert.equal(await work, "complete");
    assert.equal(builds, 1);
    assert.equal(disposals, 1);
  }
});

test("source bindings ignore generated build and installed dependency trees", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-source-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "main.rs"), "fn main() {}\n");
    const before = await inventory(root, { source: true });
    for (const directory of [".tools", "node_modules", "target"]) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, "generated.rs"), "generated\n");
    }
    assert.deepEqual(await inventory(root, { source: true }), before);
    assert.equal((await inventory(root)).fileCount, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binds evidence only to a clean exact git checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-checkout-"));
  const git = (...args) =>
    spawnSync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8" });
  try {
    assert.equal(git("init", "-q").status, 0);
    assert.equal(git("config", "user.email", "test@example.invalid").status, 0);
    assert.equal(git("config", "user.name", "Test").status, 0);
    await writeFile(join(root, "input.txt"), "governed\n");
    assert.equal(git("add", "input.txt").status, 0);
    assert.equal(git("commit", "-qm", "fixture").status, 0);
    const clean = await governedCheckout(root, {
      allowedGeneratedRoots: ["build"],
    });
    assert.match(clean.commit, /^[0-9a-f]{40}$/u);
    assert.match(clean.tree, /^[0-9a-f]{40}$/u);

    await writeFile(join(root, "input.txt"), "dirty\n");
    await assert.rejects(
      () => governedCheckout(root, { allowedGeneratedRoots: ["build"] }),
      /tracked or index drift/u,
    );
    await writeFile(join(root, "input.txt"), "governed\n");
    await writeFile(join(root, "unapproved.txt"), "untracked\n");
    await assert.rejects(
      () => governedCheckout(root, { allowedGeneratedRoots: ["build"] }),
      /unapproved untracked input/u,
    );
    await rm(join(root, "unapproved.txt"));
    await mkdir(join(root, "build"));
    await writeFile(join(root, "build", "result.bin"), "generated\n");
    for (let start = 0; start < 4_300; start += 100)
      await Promise.all(
        Array.from({ length: Math.min(100, 4_300 - start) }, (_, offset) =>
          writeFile(
            join(
              root,
              "build",
              `${String(start + offset).padStart(5, "0")}-${"x".repeat(235)}`,
            ),
            "",
          ),
        ),
      );
    await assert.doesNotReject(() =>
      governedCheckout(root, { allowedGeneratedRoots: ["build"] }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains a structured body-free release-hook scan result", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-release-scan-"));
  try {
    await writeFile(join(root, "candidate"), "release bytes");
    const clean = await releaseHookScan(root, await inventory(root));
    assert.deepEqual(Object.keys(clean).toSorted(), [
      "findingCount",
      "markerSetSha256",
      "scannedBytes",
      "scannedFileCount",
      "schemaVersion",
      "status",
    ]);
    assert.equal(clean.status, "passed");
    await writeFile(join(root, "candidate"), "KEIKO_EVIDENCE:raw");
    const rejected = await releaseHookScan(root, await inventory(root));
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.findingCount, 1);
    assert.doesNotMatch(JSON.stringify(rejected), /candidate|KEIKO_EVIDENCE/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proves release-hook absence from closed composition evidence", () => {
  const manifest = {
    capabilityConfigClosed: true,
    compileFeatureDefaultEmpty: true,
    evaluationSourceGuarded: true,
    instrumentedPackageDigest: "a".repeat(64),
    packagePaths: [
      "Contents/Info.plist",
      "Contents/MacOS/keiko-foundation-slint-evaluation",
    ],
    releasePackageDigest: "b".repeat(64),
    sourceGuardDigest: "c".repeat(64),
    symbolFindingCount: 0,
  };
  assert.deepEqual(validateReleaseCompositionManifest("slint", manifest), {
    capabilityConfig: "closed",
    compileFeature: "absent-by-default-and-source-guarded",
    instrumentedDistinct: true,
    packageAllowlist: "matched",
    schemaVersion: 1,
    sourceGuardSha256: "c".repeat(64),
    status: "passed",
    symbolFindingCount: 0,
  });
  assert.throws(
    () =>
      validateReleaseCompositionManifest("slint", {
        ...manifest,
        symbolFindingCount: 1,
      }),
    /release composition proof failed/u,
  );
  assert.throws(
    () =>
      validateReleaseCompositionManifest("slint", {
        ...manifest,
        packagePaths: [...manifest.packagePaths, "Contents/evaluation-hook"],
      }),
    /release composition proof failed/u,
  );
});

test("builds the frozen alternating 20 cold and 30 warm schedule", () => {
  const schedule = buildSchedule();
  assert.equal(schedule.length, 100);
  for (const candidate of ["tauri", "slint"]) {
    assert.equal(
      schedule.filter(
        (entry) => entry.candidate === candidate && entry.mode === "cold",
      ).length,
      FULL_COUNTS.cold,
    );
    assert.equal(
      schedule.filter(
        (entry) => entry.candidate === candidate && entry.mode === "warm",
      ).length,
      FULL_COUNTS.warm,
    );
  }
  assert.deepEqual(
    schedule
      .slice(0, 4)
      .map(({ candidate, iteration }) => [candidate, iteration]),
    [
      ["tauri", 0],
      ["slint", 0],
      ["slint", 1],
      ["tauri", 1],
    ],
  );
});

test("authorizes only the exact physical owner M4 reference class", () => {
  const observed = {
    architecture: "arm64",
    memoryClassGiB: 16,
    osPatch: "26.1",
    virtual: false,
  };
  assert.deepEqual(
    validateAuthorityObservation(observed, {
      KEIKO_FOUNDATION_AUTHORITY: "owner-m4-16gib-macos26",
    }),
    {
      architecture: "arm64",
      authority: "authoritative-owner-m4",
      memoryClassGiB: 16,
      osFamily: "macos",
      osPatch: "26.1",
      referenceClass: "owner-m4-16gib-macos26",
      virtual: false,
    },
  );
  for (const invalid of [
    { ...observed, architecture: "x86_64" },
    { ...observed, memoryClassGiB: 32 },
    { ...observed, osPatch: "25.6" },
    { ...observed, virtual: true },
  ])
    assert.throws(
      () =>
        validateAuthorityObservation(invalid, {
          KEIKO_FOUNDATION_AUTHORITY: "owner-m4-16gib-macos26",
        }),
      /authoritative owner M4/u,
    );
  assert.throws(
    () => validateAuthorityObservation(observed, {}),
    /authority assertion/u,
  );
});

test("uses the declared nearest-rank distribution formula", () => {
  assert.equal(percentile([5, 1, 4, 3, 2], 0.95), 5);
  assert.deepEqual(distribution([1, 2, 3, 4]), {
    count: 4,
    max: 4,
    mean: 2.5,
    min: 1,
    p50: 2,
    p75: 3,
    p95: 4,
  });
});

test("rejects identities, modes, oversized trees, and local data in candidate evidence", () => {
  const base = validTauriEvidence("cold");
  assert.deepEqual(
    validateCandidateEvidence(base, {
      candidate: "tauri",
      mode: "cold",
      observation: {},
    }),
    {
      candidateHardGates: {},
      candidateRssBytes: null,
      inputToPaintMs: 12,
      runtimeToUiMs: 20,
    },
  );
  const processAccountingInCandidateOrder = {
    definition: base.processAccounting.definition,
    rssComparableForWinGate: base.processAccounting.rssComparableForWinGate,
    limitation: base.processAccounting.limitation,
  };
  assert.deepEqual(
    validateCandidateEvidence(
      { ...base, processAccounting: processAccountingInCandidateOrder },
      { candidate: "tauri", mode: "cold", observation: {} },
    ),
    {
      candidateHardGates: {},
      candidateRssBytes: null,
      inputToPaintMs: 12,
      runtimeToUiMs: 20,
    },
  );
  assert.throws(
    () =>
      validateCandidateEvidence(
        { ...base, candidate: "slint-femtovg" },
        { candidate: "tauri", mode: "cold", observation: {} },
      ),
    /identity mismatch/u,
  );
  assert.throws(
    () =>
      validateCandidateEvidence(
        { ...base, mode: "warm" },
        { candidate: "tauri", mode: "cold", observation: {} },
      ),
    /mode mismatch/u,
  );
  assert.throws(
    () =>
      validateCandidateEvidence(
        { ...base, note: "/Users/person/private" },
        { candidate: "tauri", mode: "cold", observation: {} },
      ),
    /prohibited local data/u,
  );
});

test("retains a closed sanitized Tauri journey without raw instance identities", () => {
  const retained = sanitizeCandidateEvidence(validTauriEvidence("cold"), {
    candidate: "tauri",
    mode: "cold",
    observation: {},
    runnerFixture,
  });
  assert.equal(retained.schemaVersion, 2);
  assert.equal(retained.candidate, "tauri");
  assert.equal(retained.lifecycle.instanceDistinct, true);
  assert.equal(retained.security.invalidRequestCount, 2);
  assert.equal(retained.accessibility.axeViolationCount, 0);
  assert.equal(retained.diagnostics.compositionAccepted, true);
  assert.equal(retained.fixture.escalated, true);
  assert.equal(retained.recovery.runtimeEventCommitted, true);
  assert.deepEqual(retained.candidateHardGates, {});
  assert.doesNotMatch(
    JSON.stringify(retained),
    /firstInstanceId|secondInstanceId|"first"|"second"/u,
  );
});

test("rejects candidate-controlled retained identity strings", () => {
  const base = validTauriEvidence("cold");
  for (const mutation of [
    { ...base, dependencies: { ...base.dependencies, host: "tauri-device-7" } },
    {
      ...base,
      environment: { ...base.environment, referenceClass: "device-owner-7" },
    },
    {
      ...base,
      processAccounting: {
        ...base.processAccounting,
        limitation: "renderer-id-7",
      },
    },
  ])
    assert.throws(
      () =>
        sanitizeCandidateEvidence(mutation, {
          candidate: "tauri",
          mode: "cold",
          observation: {
            architecture: "arm64",
            osFamily: "macos",
            referenceClass: "owner-m4-16gib-macos26",
          },
          runnerFixture,
        }),
      /identity string/u,
    );
});

test("revalidates retained payload digests, completeness, and sample binding", () => {
  const payload = sanitizeCandidateEvidence(validTauriEvidence("cold"), {
    candidate: "tauri",
    mode: "cold",
    observation: {},
    runnerFixture,
  });
  const digest = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  const sample = {
    candidate: "tauri",
    candidateEvidenceSha256: digest,
    candidateHardGates: {},
    candidateRssBytes: null,
    inputToPaintMs: 12,
    iteration: 0,
    launchMs: 10,
    mode: "cold",
    runtimeToUiMs: 20,
    sequence: 0,
    shutdownMs: 1,
    trackedRssBytes: 100,
  };
  const schedule = [
    { candidate: "tauri", iteration: 0, mode: "cold", sequence: 0 },
  ];
  assert.doesNotThrow(() =>
    validateCandidateEvidenceMap({ [digest]: payload }, [sample], schedule),
  );
  assert.throws(
    () => validateCandidateEvidenceMap({}, [sample], schedule),
    /missing/u,
  );
  assert.throws(
    () =>
      validateCandidateEvidenceMap(
        { [digest]: { ...payload, mode: "warm" } },
        [sample],
        schedule,
      ),
    /digest mismatch/u,
  );
});

test("accepts Slint journey evidence while retaining failed replacement gates", () => {
  const reply = (code, ok) => ({ code, ok });
  const evidence = {
    candidate: "slint-femtovg",
    dependencies: {
      frontend: "slint-declarative-ui-1.17.1",
      host: "slint-winit-1.17.1",
      renderer: "slint-femtovg-1.17.1",
      rust: "1.92.0",
    },
    environment: {
      architecture: "aarch64",
      osFamily: "macos",
      referenceClass: "owner-m4-16gib-macos26",
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
    journey: {
      accepted: reply("accepted", true),
      finish: reply("accepted", true),
      fixture: {
        ...reply("accepted", true),
        escalated: true,
        parentReaped: true,
        groupAbsent: true,
        sessionIsolated: true,
        execChanged: true,
        descendantAbsent: true,
      },
      nativeDialog: reply("accepted", true),
      negatives: {
        cancelled: reply("cancelled", false),
        hostile: reply("invalid_request", false),
        oversized: reply("payload_too_large", false),
        replay: reply("replayed_request", false),
        timeout: reply("timed_out", false),
        unknown: reply("invalid_request", false),
      },
      recoveredResponse: reply("accepted", true),
      rendererCycle: {
        firstDestroyed: true,
        firstInstanceId: "first",
        firstLoaded: true,
        hostSurvived: true,
        ok: true,
        portResponse: reply("accepted", true),
        secondDestroyed: true,
        secondInstanceId: "second",
        secondLoaded: true,
      },
      unavailableResponse: reply("renderer_unavailable", false),
    },
    metrics: {
      client: {
        darkAppearance: true,
        focusVisible: true,
        imeValue: "かなa",
        inputToPaintMs: 20,
        runtimeToUiMs: 30,
        scaleFactor: 2,
      },
      rssBytes: 100,
    },
    mode: "warm",
    processAccounting: {
      definition: "root-process-only-after-fixture-cleanup",
      limitation:
        "cross-candidate-rss-is-invalid-because-tauri-webkit-xpc-processes-are-not-consistently-attributable",
      rssComparableForWinGate: false,
    },
    schemaVersion: 1,
  };
  const result = validateCandidateEvidence(evidence, {
    candidate: "slint",
    mode: "warm",
    observation: {},
    runnerFixture,
  });
  assert.equal(result.inputToPaintMs, 20);
  assert.equal(result.runtimeToUiMs, 30);
  assert.equal(result.candidateRssBytes, 100);
  assert.equal(result.candidateHardGates.signedUpdateRecipe.passed, false);
  const retained = sanitizeCandidateEvidence(evidence, {
    candidate: "slint",
    mode: "warm",
    observation: {},
  });
  assert.equal(retained.lifecycle.instanceDistinct, true);
  assert.equal(retained.diagnostics.compositionAccepted, true);
  assert.equal(retained.security.hostile, true);
  assert.equal(
    retained.candidateHardGates.nativeSemanticTreeAutomation.passed,
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(retained),
    /firstInstanceId|secondInstanceId|imeValue|かなa/u,
  );
});

test("detects retained identity and path fields", () => {
  assert.deepEqual(redactionFailures({ ok: true }), []);
  assert.ok(redactionFailures({ username: "person" }).length > 0);
  assert.ok(redactionFailures({ value: "/Users/person/work" }).length > 0);
  assert.ok(
    redactionFailures({ value: "machine-name" }, { hostname: "machine-name" })
      .length > 0,
  );
  for (const leaked of [
    "/private/tmp/customer-id",
    "/Volumes/Secret/customer",
    "/home/runner/work/repo",
    "ssh://internal.example",
    "https://internal.example/api",
    "C:\\Users\\person\\secret",
    "\\\\server\\share\\secret",
  ])
    assert.ok(
      redactionFailures({ value: leaked }).length > 0,
      `expected retained leak rejection: ${leaked}`,
    );
});

test("retains diagnostic RSS without a cross-candidate win comparison", () => {
  const samples = [];
  for (const candidate of ["tauri", "slint"]) {
    for (const mode of ["cold", "warm"])
      samples.push({
        candidate,
        mode,
        launchMs: 10,
        inputToPaintMs: 5,
        runtimeToUiMs: 6,
        shutdownMs: 2,
        trackedRssBytes: 100,
      });
  }
  const bindings = {
    tauri: { releasePackage: { totalBytes: 200 } },
    slint: { releasePackage: { totalBytes: 100 } },
  };
  const result = summarize(samples, bindings);
  assert.equal(result.rssComparison.comparableForWinGate, false);
  assert.equal(result.candidates.tauri.trackedRssBytes.p95, 100);
  assert.equal(result.candidates.slint.packagedPayloadBytes, 100);
});
