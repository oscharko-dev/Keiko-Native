import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acceptanceProcessEnvironment,
  acceptanceEnvironmentFailures,
  canonicalRuntimeRoot,
  canonicalRuntimeResources,
  cleanupAcceptanceFixture,
  measureFirstVisibleP95,
  observedSafeguards,
  packageArtifactFailures,
  physicalObservationFailures,
  restorePersistentRuntimeHome,
  selectCommandOutput,
  selectOwnedStagedRuntime,
  snapshotDirectory,
  stageDisposableRuntimeHome,
  verifyOwnedRuntimeGroupsExited,
} from "./codex-tracer-acceptance-io.mjs";
import { acceptancePhysicalContract } from "./codex-tracer-acceptance.mjs";
import { authenticateOwnedProcessGroup } from "./macos-accessibility-driver-harness.mjs";
import { nativeGateTestSupport } from "./native-gate.mjs";

const runtimeSha256 =
  "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590";
const promptSha256 =
  "e1a92579b1ca673135331829beb97792c1289a6bccdfe0303302256c546960f6";

test("directory snapshots bind symlink targets without following them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "keiko-home-snapshot-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, "credentials.json"), "stable", "utf8");
  await symlink("first-target", join(root, "runtime-link"));

  const before = await snapshotDirectory(root);
  await rm(join(root, "runtime-link"));
  await symlink("second-target", join(root, "runtime-link"));
  const after = await snapshotDirectory(root);

  assert.equal(before.entries, 2);
  assert.notEqual(before.sha256, after.sha256);
});

test("acceptance restores the retained home and discards provider writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "keiko-home-swap-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const runtimeHome = join(root, "codex-home");
  const runRoot = join(root, "run");
  await mkdir(runtimeHome, { mode: 0o700 });
  await mkdir(runRoot, { mode: 0o700 });
  await writeFile(join(runtimeHome, "installation_id"), "installation", {
    mode: 0o600,
  });
  await writeFile(join(runtimeHome, "stable"), "retained", "utf8");
  const external = join(root, "external");
  await writeFile(external, "must-not-be-exposed", "utf8");
  await symlink(external, join(runtimeHome, "external-link"));

  const retainedHome = await stageDisposableRuntimeHome(runtimeHome, runRoot);
  await writeFile(
    join(runtimeHome, "installation_id"),
    "provider-write",
    "utf8",
  );
  await writeFile(join(runtimeHome, "cache"), "discarded", "utf8");
  assert.equal(
    await readFile(join(retainedHome, "stable"), "utf8"),
    "retained",
  );
  await assert.rejects(readFile(join(runtimeHome, "stable"), "utf8"));
  await assert.rejects(readFile(join(runtimeHome, "external-link"), "utf8"));

  await restorePersistentRuntimeHome({
    retainedHome,
    runRoot,
    runtimeHome,
  });
  assert.equal(await readFile(join(runtimeHome, "stable"), "utf8"), "retained");
  assert.equal(await readFile(external, "utf8"), "must-not-be-exposed");
  await assert.rejects(readFile(join(runtimeHome, "cache"), "utf8"));
});

test("acceptance rejects a symlinked authentication identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "keiko-home-symlink-auth-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const runtimeHome = join(root, "codex-home");
  const runRoot = join(root, "run");
  const external = join(root, "external-installation-id");
  await mkdir(runtimeHome, { mode: 0o700 });
  await mkdir(runRoot, { mode: 0o700 });
  await writeFile(external, "installation", { mode: 0o600 });
  await symlink(external, join(runtimeHome, "installation_id"));

  await assert.rejects(
    stageDisposableRuntimeHome(runtimeHome, runRoot),
    /ELOOP|symlink|open/iu,
  );
  assert.equal(await readFile(external, "utf8"), "installation");
});

test("acceptance rejects malformed authentication identity files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "keiko-home-invalid-auth-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  for (const [name, prepare] of [
    ["directory", (path) => mkdir(path, { mode: 0o700 })],
    [
      "writable",
      async (path) => {
        await writeFile(path, "installation", { mode: 0o600 });
        await chmod(path, 0o666);
      },
    ],
    ["empty", (path) => writeFile(path, "", { mode: 0o600 })],
    ["oversized", (path) => writeFile(path, "x".repeat(4097), { mode: 0o600 })],
  ]) {
    const runtimeHome = join(root, `${name}-home`);
    const runRoot = join(root, `${name}-run`);
    await mkdir(runtimeHome, { mode: 0o700 });
    await mkdir(runRoot, { mode: 0o700 });
    await prepare(join(runtimeHome, "installation_id"));

    await assert.rejects(
      stageDisposableRuntimeHome(runtimeHome, runRoot),
      /acceptance-auth-identity-invalid/u,
    );
  }
});

test("acceptance restores the authenticated home before fallible fixture removal", async () => {
  const calls = [];
  await assert.rejects(
    cleanupAcceptanceFixture(
      { internal: {} },
      {
        chmodDeniedWorkspace: async () => calls.push("chmod"),
        removeDeniedWorkspace: async () => calls.push("remove-denied"),
        removeObservation: async () => calls.push("remove-observation"),
        removeRunRoot: async () => calls.push("remove-run-root"),
        removeWorkspace: async () => {
          calls.push("remove-workspace");
          throw new Error("fixture removal failed");
        },
        restoreRuntimeHome: async () => calls.push("restore-home"),
      },
    ),
    /fixture removal failed/u,
  );
  assert.equal(calls[0], "restore-home");
});

test("acceptance retains the authenticated backup when restoration fails", async () => {
  const calls = [];
  await assert.rejects(
    cleanupAcceptanceFixture(
      { internal: {} },
      {
        chmodDeniedWorkspace: async () => calls.push("chmod"),
        removeDeniedWorkspace: async () => calls.push("remove-denied"),
        removeObservation: async () => calls.push("remove-observation"),
        removeRunRoot: async () => calls.push("remove-run-root"),
        removeWorkspace: async () => calls.push("remove-workspace"),
        restoreRuntimeHome: async () => {
          calls.push("restore-home");
          throw new Error("restore failed");
        },
      },
    ),
    /restore failed/u,
  );
  assert.equal(calls[0], "restore-home");
  assert.equal(calls.includes("remove-run-root"), false);
});

test("first-visible p95 permits one bounded cold-launch outlier", async () => {
  let now = 0;
  let launches = 0;
  const observed = [];
  const p95 = await measureFirstVisibleP95(
    {},
    "/bounded/adapter",
    {},
    {
      authenticate: async ({ pid }) => ({ pid }),
      launch: () => ({ pid: (launches += 1) }),
      monotonicNow: () => now,
      observe: async (request) => {
        observed.push(request);
        if (request.action === "probe-start")
          now += request.pid === 1 ? 2_500 : 1_000;
        return { prompted: false, reasonCode: null, status: "passed" };
      },
      terminate: async () => undefined,
      waitForExit: async () => true,
    },
  );

  assert.equal(p95, 1_000);
  assert.equal(launches, 20);
  assert.ok(
    observed
      .filter(({ action }) => action === "probe-start")
      .every(({ timeoutMs }) => timeoutMs === 5_000),
  );
});

test("crash recovery selects only one exact staged runtime owned by the app", () => {
  const appPid = 42;
  const runtimeWorkRoot = "/private/tmp/keiko-runtime-work";
  const valid = {
    command: `${runtimeWorkRoot}/turn-42-3/verified-codex-runtime app-server`,
    pgid: 51,
    pid: 51,
    ppid: appPid,
  };
  assert.deepEqual(
    selectOwnedStagedRuntime([valid], { appPid, runtimeWorkRoot }),
    {
      ...valid,
      executable: `${runtimeWorkRoot}/turn-42-3/verified-codex-runtime`,
    },
  );
  for (const processes of [
    [{ ...valid, ppid: 41 }],
    [{ ...valid, pgid: 50 }],
    [
      {
        ...valid,
        command: "/private/tmp/installed-codex app-server",
      },
    ],
    [
      {
        ...valid,
        command: `${runtimeWorkRoot}/turn-41-3/verified-codex-runtime app-server`,
      },
    ],
    [
      {
        ...valid,
        command: `${runtimeWorkRoot}/turn-42-3/nested/verified-codex-runtime app-server`,
      },
    ],
    [valid, { ...valid, pid: 52, pgid: 52 }],
  ]) {
    assert.equal(
      selectOwnedStagedRuntime(processes, { appPid, runtimeWorkRoot }),
      null,
    );
  }
});

test("final runtime cleanup evidence fails before signaling an authenticated survivor", async () => {
  let now = 0;
  const identity = {
    pid: 51,
    processGroupId: 51,
    startIdentity: "10:20",
  };
  let survivor = identity;
  const dependencies = {
    listProcessGroup: () => (survivor === null ? [] : [survivor]),
    monotonicNow: () => now,
    readProcessIdentity: () => survivor,
    signalProcess: () => assert.fail("verification must not signal"),
    waitForTurn: async (milliseconds) => {
      now += milliseconds;
    },
  };
  const ownership = await authenticateOwnedProcessGroup(
    { pid: identity.pid },
    dependencies,
  );

  await assert.rejects(
    verifyOwnedRuntimeGroupsExited([ownership], dependencies),
    /acceptance-owned-runtime-residual/u,
  );
  survivor = null;
  assert.equal(
    await verifyOwnedRuntimeGroupsExited([ownership], dependencies),
    1,
  );
});

test("acceptance-owned processes receive only non-secret system context and explicit bindings", () => {
  const environment = acceptanceProcessEnvironment(
    {
      HOME: "/Users/acceptance",
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/private/tmp/acceptance/",
      GH_TOKEN: "must-not-cross",
      OPENAI_API_KEY: "must-not-cross",
      SSH_AUTH_SOCK: "/private/tmp/agent.sock",
    },
    {
      CODEX_HOME: "/private/tmp/codex-home",
      KEIKO_CODEX_0_145_0_BINARY: "/private/tmp/codex",
    },
  );

  assert.deepEqual(environment, {
    CODEX_HOME: "/private/tmp/codex-home",
    HOME: "/Users/acceptance",
    KEIKO_CODEX_0_145_0_BINARY: "/private/tmp/codex",
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin",
    TMPDIR: "/private/tmp/acceptance/",
  });
  assert.equal(JSON.stringify(environment).includes("must-not-cross"), false);
  assert.equal("SSH_AUTH_SOCK" in environment, false);
  assert.throws(
    () => acceptanceProcessEnvironment({}, { CODEX_HOME: "" }),
    /acceptance-process-environment-invalid/u,
  );
});

test("runtime work roots use their canonical macOS identity", async () => {
  const alias = "/var/folders/private-run";
  const canonical = "/private/var/folders/private-run";
  assert.equal(
    await canonicalRuntimeRoot(alias, async (root) => {
      assert.equal(root, alias);
      return canonical;
    }),
    canonical,
  );
});

test("runtime resources use their canonical macOS identities", async () => {
  const aliases = {
    binary: "/var/folders/runtime/bin/codex",
    home: "/var/folders/runtime/home",
  };
  const canonical = {
    binary: "/private/var/folders/runtime/bin/codex",
    home: "/private/var/folders/runtime/home",
  };
  assert.deepEqual(
    await canonicalRuntimeResources(aliases, async (path) => {
      assert.ok(Object.values(aliases).includes(path));
      return `/private${path}`;
    }),
    canonical,
  );
});

test("the exact auth probe reads the CLI status stream without merging output", () => {
  const result = {
    stderr: "Logged in using ChatGPT\n",
    stdout: "",
  };
  assert.equal(
    selectCommandOutput(result, "stderr"),
    "Logged in using ChatGPT",
  );
  assert.equal(selectCommandOutput(result, "stdout"), "");
  assert.throws(() => selectCommandOutput(result, "combined"));
});

test("the external environment is the exact authoritative toolchain, runtime, prompt, and auth class", () => {
  const environment = {
    architecture: "arm64",
    authStatus: "Logged in using ChatGPT",
    nodeVersion: "24.18.0",
    npmVersion: "11.16.0",
    platform: "darwin",
    promptBytes: 182,
    promptSha256,
    runtimeSha256,
    runtimeVersion: "codex-cli 0.145.0",
  };

  assert.deepEqual(acceptanceEnvironmentFailures(environment), []);
  for (const key of Object.keys(environment)) {
    const changed = structuredClone(environment);
    changed[key] = typeof changed[key] === "number" ? 0 : "drifted";
    assert.ok(
      acceptanceEnvironmentFailures(changed).length > 0,
      `changed ${key}`,
    );
  }
  assert.ok(
    acceptanceEnvironmentFailures({ ...environment, extra: true }).length > 0,
  );
});

test("packaged artifacts bind the exact source, manifest, executable, and foundation acceptance", () => {
  const sourceRevision = "a".repeat(40);
  const packageManifestSha256 = "b".repeat(64);
  const executableSha256 = "c".repeat(64);
  const manifest = {
    schema: "keiko-native-package-manifest/v1",
    sourceRevision,
    target: "keiko-native-desktop",
    platform: "macos-arm64",
    policySha256: "d".repeat(64),
    inventory: [
      {
        mode: "0644",
        path: "Contents/Info.plist",
        sha256: "e".repeat(64),
      },
      {
        mode: "0755",
        path: "Contents/MacOS/keiko-native-desktop",
        sha256: executableSha256,
      },
      {
        mode: "0644",
        path: "Contents/Resources/THIRD-PARTY-NOTICES.json",
        sha256: "f".repeat(64),
      },
    ],
    redaction: "closed",
  };
  const shellEvidence = nativeGateTestSupport.packagedShellEvidence({
    architecture: "arm64",
    cargoLockSha256: "1".repeat(64),
    lifecycle: {
      acknowledgementMs: 20,
      cleanupOwnedDescendants: 0,
      shutdownMs: 40,
      workspaceAcknowledgementMs: 10,
    },
    npmLockSha256: "2".repeat(64),
    packageManifestSha256,
    revision: sourceRevision,
    runner: "local-macos",
  });
  const input = {
    executableSha256,
    manifest,
    packageManifestSha256,
    shellEvidence,
    sourceRevision,
  };

  assert.deepEqual(packageArtifactFailures(input), []);
  for (const changed of [
    { ...input, executableSha256: "0".repeat(64) },
    { ...input, packageManifestSha256: "0".repeat(64) },
    { ...input, sourceRevision: "0".repeat(40) },
    { ...input, manifest: { ...manifest, extra: true } },
    {
      ...input,
      manifest: { ...manifest, inventory: manifest.inventory.slice(1) },
    },
    {
      ...input,
      shellEvidence: { ...shellEvidence, cleanupOwnedDescendants: 1 },
    },
  ]) {
    assert.ok(packageArtifactFailures(changed).length > 0);
  }
});

test("physical observations are closed and digest-bound to the exact packaged head", () => {
  const expected = {
    packageExecutableSha256: "a".repeat(64),
    sourceRevision: "b".repeat(40),
  };
  const observation = {
    appearance: structuredClone(acceptancePhysicalContract.appearance),
    observedAt: "2026-08-01T12:00:00.000Z",
    observations: acceptancePhysicalContract.irreducibleObservations.map(
      (checkpoint) => ({ checkpoint, status: "observed" }),
    ),
    packageExecutableSha256: expected.packageExecutableSha256,
    redaction: "closed",
    schemaVersion: "keiko-native-codex-tracer-physical-observation/v1",
    sourceRevision: expected.sourceRevision,
  };

  const observedAtMs = Date.parse(observation.observedAt);
  assert.deepEqual(
    physicalObservationFailures(observation, expected, observedAtMs),
    [],
  );
  for (const key of Object.keys(observation)) {
    const missing = structuredClone(observation);
    delete missing[key];
    assert.ok(
      physicalObservationFailures(missing, expected, observedAtMs).length > 0,
      `missing ${key}`,
    );
  }
  for (const changed of [
    { ...observation, extra: true },
    { ...observation, sourceRevision: "c".repeat(40) },
    { ...observation, packageExecutableSha256: "d".repeat(64) },
    { ...observation, observedAt: "not-a-date" },
    { ...observation, observedAt: "2026-08-01T10:59:59.999Z" },
    { ...observation, observedAt: "2026-08-01T12:05:00.001Z" },
    { ...observation, observations: observation.observations.slice(1) },
    {
      ...observation,
      observations: observation.observations.map((entry, index) =>
        index === 0 ? { ...entry, status: "manual-only" } : entry,
      ),
    },
    { ...observation, redaction: "open" },
  ]) {
    assert.ok(
      physicalObservationFailures(changed, expected, observedAtMs).length > 0,
    );
  }
});

test("safeguards are derived from observed containment, journey, filesystem, and process state", () => {
  const snapshot = { bytes: 0, entries: 1, sha256: "a".repeat(64) };
  const input = {
    containmentMarkers: [
      "features.multi_agent=false",
      "features.multi_agent_v2=false",
      "tools.experimental_request_user_input.enabled=false",
      "runtimeWorkspaceRoots",
      "dynamicTools",
      "selectedCapabilityRoots",
    ],
    journey: {
      status: "passed",
      timings: Array.from({ length: 36 }, (_, index) => ({
        action: `checkpoint-${index}`,
        elapsedMs: 1,
      })),
    },
    packageInspection: { testHookMarkers: 0 },
    residualProcesses: 0,
    homeBefore: { bytes: 1, entries: 1, sha256: "e".repeat(64) },
    homeAfter: { bytes: 1, entries: 1, sha256: "e".repeat(64) },
    runtimeBefore: { bytes: 0, entries: 0, sha256: "b".repeat(64) },
    runtimeAfter: { bytes: 0, entries: 0, sha256: "b".repeat(64) },
    workspaceBefore: snapshot,
    workspaceAfter: snapshot,
  };
  const measured = observedSafeguards(input);
  assert.equal(measured.acceptedEffects, 0);
  assert.equal(measured.localToolRequests, 0);
  assert.equal(measured.providerEffectOwnerCrossings, 0);
  assert.equal(measured.residualProcesses, 0);

  const changed = observedSafeguards({
    ...input,
    residualProcesses: 1,
    homeAfter: { bytes: 2, entries: 2, sha256: "f".repeat(64) },
    runtimeAfter: { bytes: 1, entries: 1, sha256: "c".repeat(64) },
    workspaceAfter: { bytes: 1, entries: 2, sha256: "d".repeat(64) },
  });
  assert.equal(changed.acceptedEffects, 1);
  assert.equal(changed.localToolRequests, 1);
  assert.equal(changed.providerEffectOwnerCrossings, 1);
  assert.equal(changed.repositoryContextBytesToRuntime, 1);
  assert.equal(changed.residualProcesses, 1);
});
