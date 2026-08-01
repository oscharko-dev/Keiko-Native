import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptanceProcessEnvironment,
  acceptanceEnvironmentFailures,
  canonicalRuntimeRoot,
  packageArtifactFailures,
  physicalObservationFailures,
  selectCommandOutput,
} from "./codex-tracer-acceptance-io.mjs";
import { acceptancePhysicalContract } from "./codex-tracer-acceptance.mjs";
import { nativeGateTestSupport } from "./native-gate.mjs";

const runtimeSha256 =
  "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590";
const promptSha256 =
  "e1a92579b1ca673135331829beb97792c1289a6bccdfe0303302256c546960f6";

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
