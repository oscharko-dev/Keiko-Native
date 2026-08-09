import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  acceptanceEvidenceFailures,
  acceptanceBudgetLimits,
  acceptanceIdentityContract,
  acceptanceJourneyContract,
  acceptancePackageInspectionContract,
  acceptancePhysicalContract,
  acceptanceSafeguardContract,
  budgetEvidenceFailures,
  identityBindingFailures,
  journeyEvidenceFailures,
  referenceEnvironmentFailures,
  runCodexTracerAcceptance,
  safeguardEvidenceFailures,
  validateAcceptanceInvocation,
} from "./codex-tracer-acceptance.mjs";

function localProjectionMeasurements() {
  return [
    {
      action: "open-canvas",
      observation: "probe-canvas",
      projectedMs: 40,
    },
    {
      action: "select-workspace",
      observation: "observe-workspace-permission-denied",
      projectedMs: 70,
    },
    {
      action: "select-workspace",
      observation: "observe-workspace-selected",
      projectedMs: 90,
    },
    {
      action: "cancel-turn",
      observation: "observe-stopping",
      projectedMs: 80,
    },
  ];
}

function validEvidence() {
  const expected = {
    packageExecutableSha256: "b".repeat(64),
    packageManifestSha256: "c".repeat(64),
    sourceRevision: "a".repeat(40),
  };
  return {
    evidence: {
      bindings: { ...acceptanceIdentityContract, ...expected },
      budgets: {
        ...acceptanceBudgetLimits,
        cleanupMs: 4_000,
        firstVisibleKeikoOverheadP95Ms: 1_500,
        localProjectionMeasurements: localProjectionMeasurements(),
        localProjectionP95Ms: 90,
        nativePickerCancellationMeasurements: Array.from(
          { length: 20 },
          (_, index) => ({
            launch: index + 1,
            projectedMs: index === 0 ? 1_055 : 539,
          }),
        ),
        nativePickerCancellationP95Ms: 539,
        turnCancellationProjectionMs: 80,
        turnDurationMs: 110_000,
        workspaceSelectionNativeActionMs: 102,
      },
      journey: structuredClone(acceptanceJourneyContract),
      packageInspection: structuredClone(acceptancePackageInspectionContract),
      physical: {
        ...structuredClone(acceptancePhysicalContract),
        packageExecutableSha256: expected.packageExecutableSha256,
        runner: "local-macos",
      },
      redaction: "closed",
      referenceEnvironment: {
        display: "built-in-main-3024x1964-120hz",
        hardware: "apple-m4-16-gib-mac16-1",
        operatingSystem: "macos-26.5.1-25f80",
        power: "ac-power-standard",
        referenceClass: "owner-m4-16gib-macos26",
        scaling: "logical-1512x982-2x-default",
        thermal: "nominal",
      },
      safeguards: structuredClone(acceptanceSafeguardContract),
      schemaVersion: "keiko-native-codex-tracer-acceptance/v2",
      status: "complete",
    },
    expected,
  };
}

test("the tracer acceptance boundary accepts only the canonical no-argument invocation", () => {
  assert.equal(validateAcceptanceInvocation([]), null);

  for (const args of [
    ["--repository", "/private/repository"],
    ["--prompt", "private prompt"],
    ["--endpoint", "private endpoint"],
    ["--runtime", "other runtime"],
    ["--containment", "relaxed"],
    ["--credential", "private credential"],
  ]) {
    const result = validateAcceptanceInvocation(args);

    assert.deepEqual(result, {
      exitCode: 2,
      output: {
        schemaVersion: "keiko-native-codex-tracer-acceptance/v2",
        reasonCode: "invalid-command",
        status: "rejected",
      },
    });
    assert.doesNotMatch(
      JSON.stringify(result),
      /private|repository|prompt|endpoint|runtime|containment|credential/iu,
    );
  }
});

test("the command rejects hostile extras as one closed metadata line", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("./run-codex-tracer-acceptance.mjs", import.meta.url),
      ),
      "--endpoint",
      "private-endpoint-value",
    ],
    { encoding: "utf8", shell: false },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: "keiko-native-codex-tracer-acceptance/v2",
    reasonCode: "invalid-command",
    status: "rejected",
  });
  assert.equal(result.stdout.split("\n").filter(Boolean).length, 1);
  assert.doesNotMatch(result.stdout, /private|endpoint/iu);
});

test("identity evidence is closed and binds the exact accepted composition", () => {
  const expected = {
    packageExecutableSha256: "b".repeat(64),
    packageManifestSha256: "c".repeat(64),
    sourceRevision: "a".repeat(40),
  };
  const bindings = {
    ...acceptanceIdentityContract,
    ...expected,
  };

  assert.deepEqual(identityBindingFailures(bindings, expected), []);
  assert.equal(
    acceptanceIdentityContract.issueReadinessFingerprint,
    "1a0be864b3855b81c649c5843e936828ebaeb27477463ccf0af86f9da61d3391",
  );
  assert.equal(
    acceptanceIdentityContract.parentReadinessFingerprint,
    "261b5711a21e76f79987d955960a7c7fbf46561c8ff34188ed38f54eec19d7b5",
  );

  for (const key of Object.keys(bindings)) {
    const missing = structuredClone(bindings);
    delete missing[key];
    assert.ok(
      identityBindingFailures(missing, expected).length > 0,
      `missing ${key}`,
    );
  }

  for (const changed of [
    { ...bindings, extra: "private value" },
    { ...bindings, sourceRevision: "d".repeat(40) },
    { ...bindings, packageManifestSha256: "e".repeat(64) },
    { ...bindings, packageExecutableSha256: "f".repeat(64) },
    { ...bindings, runtimeVersion: "0.146.0" },
    { ...bindings, containmentProfile: "relaxed" },
    { ...bindings, authProfileClass: "api-key" },
    { ...bindings, promptSha256: "0".repeat(64) },
  ]) {
    assert.ok(identityBindingFailures(changed, expected).length > 0);
  }
});

test("journey evidence requires every accepted scenario and AXUIElement checkpoint", () => {
  const journey = structuredClone(acceptanceJourneyContract);

  assert.deepEqual(journeyEvidenceFailures(journey), []);

  for (const key of Object.keys(journey)) {
    const missing = structuredClone(journey);
    delete missing[key];
    assert.ok(journeyEvidenceFailures(missing).length > 0, `missing ${key}`);
  }

  for (const changed of [
    { ...journey, extra: true },
    { ...journey, automationMechanism: "product-hook" },
    { ...journey, scenarios: journey.scenarios.slice(1) },
    {
      ...journey,
      checkpointResults: journey.checkpointResults.slice(1),
    },
    {
      ...journey,
      checkpointResults: journey.checkpointResults.map((checkpoint, index) =>
        index === 0 ? { ...checkpoint, status: "manual" } : checkpoint,
      ),
    },
    { ...journey, manualOnlyAutomatableCheckpoints: 1 },
    { ...journey, mockOnlyClaims: 1 },
  ]) {
    assert.ok(journeyEvidenceFailures(changed).length > 0);
  }
});

test("numeric evidence enforces every accepted performance and resource budget", () => {
  const nativePickerCancellationMeasurements = Array.from(
    { length: 20 },
    (_, index) => ({
      launch: index + 1,
      projectedMs: index === 0 ? 1_055 : 539,
    }),
  );
  const budgets = {
    ...acceptanceBudgetLimits,
    cleanupMs: 4_000,
    firstVisibleKeikoOverheadP95Ms: 1_500,
    localProjectionMeasurements: localProjectionMeasurements(),
    localProjectionP95Ms: 90,
    nativePickerCancellationMeasurements,
    nativePickerCancellationP95Ms: 539,
    turnCancellationProjectionMs: 80,
    turnDurationMs: 110_000,
    workspaceSelectionNativeActionMs: 102,
  };

  assert.deepEqual(budgetEvidenceFailures(budgets), []);

  for (const key of Object.keys(budgets)) {
    const partial = structuredClone(budgets);
    delete partial[key];
    assert.ok(budgetEvidenceFailures(partial).length > 0, `missing ${key}`);
  }

  for (const changed of [
    { ...budgets, extra: 0 },
    { ...budgets, taskBytes: 0 },
    { ...budgets, taskBytes: 4_097 },
    { ...budgets, frameMaxBytes: 1_048_577 },
    { ...budgets, queueMaxBytes: 4_194_305 },
    { ...budgets, queueMaxFrames: 257 },
    { ...budgets, turnDeadlineMs: 120_001 },
    { ...budgets, turnDurationMs: 120_001 },
    { ...budgets, localProjectionP95Ms: 101 },
    {
      ...budgets,
      localProjectionMeasurements: budgets.localProjectionMeasurements.slice(1),
    },
    {
      ...budgets,
      localProjectionMeasurements: budgets.localProjectionMeasurements.map(
        (sample, index) =>
          index === 2 ? { ...sample, projectedMs: 101 } : sample,
      ),
    },
    {
      ...budgets,
      localProjectionMeasurements: budgets.localProjectionMeasurements.map(
        (sample, index) =>
          index === 2
            ? { ...sample, observation: "observe-workspace-cancelled" }
            : sample,
      ),
    },
    {
      ...budgets,
      localProjectionMeasurements: budgets.localProjectionMeasurements.map(
        (sample, index) =>
          index === 2 ? { ...sample, projectedMs: 89 } : sample,
      ),
    },
    { ...budgets, nativePickerCancellationP95Ms: 751 },
    { ...budgets, nativePickerCancellationSamples: 19 },
    {
      ...budgets,
      nativePickerCancellationMeasurements:
        nativePickerCancellationMeasurements.slice(1),
    },
    {
      ...budgets,
      nativePickerCancellationMeasurements:
        nativePickerCancellationMeasurements.map((sample, index) =>
          index === 1 ? { ...sample, launch: 1 } : sample,
        ),
    },
    {
      ...budgets,
      nativePickerCancellationMeasurements:
        nativePickerCancellationMeasurements.map((sample, index) =>
          index === 0 ? { ...sample, projectedMs: 5_001 } : sample,
        ),
    },
    {
      ...budgets,
      nativePickerCancellationMeasurements:
        nativePickerCancellationMeasurements.map((sample, index) =>
          index === 0 ? { ...sample, projectedMs: 1.5 } : sample,
        ),
    },
    {
      ...budgets,
      nativePickerCancellationMeasurements:
        nativePickerCancellationMeasurements.map((sample, index) =>
          index === 0 ? { ...sample, extra: 0 } : sample,
        ),
    },
    { ...budgets, nativePickerCancellationP95Ms: 538 },
    { ...budgets, firstVisibleKeikoOverheadP95Ms: 2_001 },
    { ...budgets, turnCancellationProjectionMs: 101 },
    { ...budgets, workspaceSelectionNativeActionMs: 5_001 },
    { ...budgets, cleanupMs: 5_001 },
    { ...budgets, providerLatencyExcluded: false },
  ]) {
    assert.ok(budgetEvidenceFailures(changed).length > 0);
  }
});

test("reference environment evidence is closed, normalized, and bound to the declared Mac", () => {
  const referenceEnvironment = validEvidence().evidence.referenceEnvironment;

  assert.deepEqual(referenceEnvironmentFailures(referenceEnvironment), []);
  for (const key of Object.keys(referenceEnvironment)) {
    const partial = structuredClone(referenceEnvironment);
    delete partial[key];
    assert.ok(
      referenceEnvironmentFailures(partial).length > 0,
      `missing ${key}`,
    );
  }
  for (const changed of [
    null,
    [],
    { ...referenceEnvironment, extra: "private" },
    { ...referenceEnvironment, hardware: "unknown" },
    { ...referenceEnvironment, operatingSystem: "macos-current" },
    { ...referenceEnvironment, display: "external" },
    { ...referenceEnvironment, scaling: "unknown" },
    { ...referenceEnvironment, power: "battery-power-standard" },
    { ...referenceEnvironment, power: "unknown" },
    { ...referenceEnvironment, thermal: "warning" },
  ]) {
    assert.ok(referenceEnvironmentFailures(changed).length > 0);
  }
});

test("safeguard evidence proves quarantine and zero repository, tool, effect, leak, and residue crossings", () => {
  const safeguards = {
    ...acceptanceSafeguardContract,
  };

  assert.deepEqual(safeguardEvidenceFailures(safeguards), []);

  for (const key of Object.keys(safeguards)) {
    const missing = structuredClone(safeguards);
    delete missing[key];
    assert.ok(safeguardEvidenceFailures(missing).length > 0, `missing ${key}`);
  }
  for (const changed of [
    { ...safeguards, extra: 0 },
    ...Object.keys(acceptanceSafeguardContract).map((key) => ({
      ...safeguards,
      [key]: key === "providerEventQuarantineMaximum" ? 65 : 1,
    })),
  ]) {
    assert.ok(safeguardEvidenceFailures(changed).length > 0);
  }
});

test("the complete evidence schema rejects partial, unknown, sensitive, package-hook, and nonphysical claims", () => {
  const { evidence, expected } = validEvidence();

  assert.deepEqual(acceptanceEvidenceFailures(evidence, expected), []);

  for (const key of Object.keys(evidence)) {
    const missing = structuredClone(evidence);
    delete missing[key];
    assert.ok(
      acceptanceEvidenceFailures(missing, expected).length > 0,
      `missing ${key}`,
    );
  }

  for (const changed of [
    { ...evidence, extra: true },
    { ...evidence, status: "partial" },
    { ...evidence, redaction: "open" },
    { ...evidence, task: "raw task" },
    {
      ...evidence,
      physical: { ...evidence.physical, runner: "fixture-only" },
    },
    {
      ...evidence,
      packageInspection: {
        ...evidence.packageInspection,
        adapterCodePresent: true,
      },
    },
    {
      ...evidence,
      packageInspection: {
        ...evidence.packageInspection,
        inspectedArtifact: "/Users/operator/private.app",
      },
    },
  ]) {
    assert.ok(acceptanceEvidenceFailures(changed, expected).length > 0);
  }
});

test("the orchestrator runs package, production, physical, validation, and persistence in order", async () => {
  const { evidence, expected } = validEvidence();
  const calls = [];
  let written = null;
  const result = await runCodexTracerAcceptance({
    args: [],
    io: {
      preparePackage: async () => {
        calls.push("package");
        return {
          bindings: evidence.bindings,
          expected,
          packageInspection: evidence.packageInspection,
        };
      },
      runProductionJourney: async () => {
        calls.push("production");
        return { safeguards: {} };
      },
      runPhysicalJourney: async () => {
        calls.push("physical");
        return {
          budgets: evidence.budgets,
          journey: evidence.journey,
          physical: evidence.physical,
          referenceEnvironment: evidence.referenceEnvironment,
          safeguards: acceptanceSafeguardContract,
        };
      },
      cleanup: async () => {
        calls.push("cleanup");
      },
      writeEvidence: async (value) => {
        calls.push("write");
        written = value;
      },
    },
  });

  assert.deepEqual(calls, [
    "package",
    "production",
    "physical",
    "cleanup",
    "write",
  ]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output, evidence);
  assert.deepEqual(written, evidence);
});

test("the orchestrator fails closed without leaking thrown values or writing partial evidence", async () => {
  let wrote = false;
  const result = await runCodexTracerAcceptance({
    args: [],
    io: {
      preparePackage: async () => {
        throw new Error("credential=private-value /Users/operator/repository");
      },
      runProductionJourney: async () => assert.fail("must not continue"),
      runPhysicalJourney: async () => assert.fail("must not continue"),
      cleanup: async () => assert.fail("nothing was prepared"),
      writeEvidence: async () => {
        wrote = true;
      },
    },
  });

  assert.deepEqual(result, {
    exitCode: 2,
    output: {
      schemaVersion: "keiko-native-codex-tracer-acceptance/v2",
      reasonCode: "acceptance-check-failed",
      status: "rejected",
    },
  });
  assert.equal(wrote, false);
  assert.doesNotMatch(JSON.stringify(result), /private|Users|repository/iu);
});
