import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  runCodexTracerWorkspaceAcceptance,
  workspaceAcceptanceBudgetLimits,
  workspaceAcceptanceEvidenceFailures,
  workspaceAcceptanceIdentityContract,
  workspaceAcceptanceJourneyContract,
  workspaceAcceptanceSafeguardContract,
} from "./codex-tracer-acceptance.mjs";

const command = fileURLToPath(
  new URL("./codex-tracer-workspace-acceptance.mjs", import.meta.url),
);

function validWorkspaceFixture() {
  const expected = {
    packageExecutableSha256: "b".repeat(64),
    packageManifestSha256: "c".repeat(64),
    sourceRevision: "a".repeat(40),
  };
  const prepared = {
    expected,
    packageInspection: {
      adapterCodePresent: false,
      policyFailures: 0,
      productionModules: "exact-packaged-modules",
      testHookMarkers: 0,
      unexpectedFiles: 0,
    },
    workspaceBindings: { ...workspaceAcceptanceIdentityContract, ...expected },
  };
  const workspace = {
    budgets: {
      ...workspaceAcceptanceBudgetLimits,
      cleanupMs: 200,
      nativePickerCancellationMeasurements: Array.from(
        { length: 20 },
        (_, index) => ({ launch: index + 1, projectedMs: 400 }),
      ),
      nativePickerCancellationP95Ms: 400,
      workspaceProjectionMeasurements: Array.from(
        { length: 4 },
        (_, index) => ({ sample: index + 1, projectedMs: 40 }),
      ),
      workspaceProjectionP95Ms: 40,
      workspaceSelectionNativeActionMeasurements: Array.from(
        { length: 4 },
        (_, index) => ({ nativeActionMs: 120, sample: index + 1 }),
      ),
    },
    journey: structuredClone(workspaceAcceptanceJourneyContract),
    referenceEnvironment: {
      display: "built-in-main-3024x1964-120hz",
      hardware: "apple-m4-16-gib-mac16-1",
      operatingSystem: "macos-26.5.2-25f84",
      power: "ac-power-standard",
      referenceClass: "owner-m4-16gib-macos26",
      scaling: "logical-1512x982-2x-default",
      thermal: "nominal",
    },
    safeguards: structuredClone(workspaceAcceptanceSafeguardContract),
  };
  return { expected, prepared, workspace };
}

test("workspace evidence uses stable repository-owned identity instead of readiness fingerprints", () => {
  assert.deepEqual(workspaceAcceptanceIdentityContract, {
    acceptanceContract: "keiko-native-workspace-projection/v1",
    issueNumber: "187",
    parentIssueNumber: "98",
  });

  const { expected, prepared, workspace } = validWorkspaceFixture();
  const evidence = {
    bindings: prepared.workspaceBindings,
    budgets: workspace.budgets,
    journey: workspace.journey,
    packageInspection: prepared.packageInspection,
    redaction: "closed",
    referenceEnvironment: workspace.referenceEnvironment,
    safeguards: workspace.safeguards,
    schemaVersion: "keiko-native-codex-tracer-workspace-acceptance/v1",
    status: "complete",
  };
  for (const legacyKey of [
    "issueReadinessFingerprint",
    "parentReadinessFingerprint",
  ]) {
    const stale = structuredClone(evidence);
    stale.bindings[legacyKey] = "d".repeat(64);
    assert.ok(
      workspaceAcceptanceEvidenceFailures(stale, expected).includes(
        "workspace-identity-fields",
      ),
      legacyKey,
    );
  }
  for (const [key, value] of [
    ["acceptanceContract", "other-contract/v1"],
    ["issueNumber", "188"],
    ["parentIssueNumber", "99"],
  ]) {
    const relabeled = structuredClone(evidence);
    relabeled.bindings[key] = value;
    assert.ok(
      workspaceAcceptanceEvidenceFailures(relabeled, expected).includes(
        `workspace-identity-${key}`,
      ),
      key,
    );
  }

  const callerRelabeled = structuredClone(evidence);
  callerRelabeled.bindings.issueNumber = "188";
  assert.ok(
    workspaceAcceptanceEvidenceFailures(callerRelabeled, {
      ...expected,
      issueNumber: "188",
    }).includes("workspace-identity-issueNumber"),
  );
});

test("workspace identity expectations cannot widen the six-key contract", () => {
  const { expected, prepared, workspace } = validWorkspaceFixture();
  const evidence = {
    bindings: prepared.workspaceBindings,
    budgets: workspace.budgets,
    journey: workspace.journey,
    packageInspection: prepared.packageInspection,
    redaction: "closed",
    referenceEnvironment: workspace.referenceEnvironment,
    safeguards: workspace.safeguards,
    schemaVersion: "keiko-native-codex-tracer-workspace-acceptance/v1",
    status: "complete",
  };
  for (const key of [
    "issueReadinessFingerprint",
    "parentReadinessFingerprint",
    "unexpectedIdentity",
  ]) {
    const hostileExpected = { ...expected, [key]: "d".repeat(64) };
    const hostileEvidence = structuredClone(evidence);
    hostileEvidence.bindings[key] = "d".repeat(64);
    assert.ok(
      workspaceAcceptanceEvidenceFailures(
        hostileEvidence,
        hostileExpected,
      ).includes("workspace-identity-fields"),
      key,
    );
  }
});

test("the workspace acceptance command rejects hostile arguments as closed metadata", () => {
  const result = spawnSync(
    process.execPath,
    [command, "--repository", "/private/repository"],
    { encoding: "utf8", shell: false },
  );

  assert.equal(result.status, 2);
  assert.equal(
    result.stderr,
    '[KEIKO-WORKSPACE-ACCEPTANCE] {"lastCompleted":null,"lastStarted":null,"status":"rejected"}\n',
  );
  assert.deepEqual(JSON.parse(result.stdout), {
    reasonCode: "invalid-command",
    schemaVersion: "keiko-native-codex-tracer-workspace-acceptance/v1",
    status: "rejected",
  });
  assert.equal(result.stdout.split("\n").filter(Boolean).length, 1);
  assert.doesNotMatch(result.stdout, /private|repository/iu);
});

test("the workspace acceptance runner emits only validated exact-head evidence", async () => {
  const calls = [];
  const { prepared, workspace } = validWorkspaceFixture();
  const result = await runCodexTracerWorkspaceAcceptance({
    args: [],
    io: {
      cleanupWorkspacePackage(value) {
        calls.push(["cleanup", value]);
      },
      prepareWorkspacePackage() {
        calls.push(["prepare"]);
        return prepared;
      },
      runWorkspaceJourney(value) {
        calls.push(["workspace", value]);
        return workspace;
      },
      writeWorkspaceEvidence(evidence, value) {
        calls.push(["write", evidence, value]);
      },
    },
  });

  assert.deepEqual(
    { calls: calls.map(([name]) => name), result },
    {
      calls: ["prepare", "workspace", "cleanup", "write"],
      result: {
        exitCode: 0,
        output: {
          bindings: prepared.workspaceBindings,
          budgets: workspace.budgets,
          journey: workspace.journey,
          packageInspection: prepared.packageInspection,
          redaction: "closed",
          referenceEnvironment: workspace.referenceEnvironment,
          safeguards: workspace.safeguards,
          schemaVersion: "keiko-native-codex-tracer-workspace-acceptance/v1",
          status: "complete",
        },
      },
    },
  );
});

test("workspace evidence rejects stale malformed over-budget and sensitive claims", () => {
  const { expected, prepared, workspace } = validWorkspaceFixture();
  const evidence = {
    bindings: prepared.workspaceBindings,
    budgets: workspace.budgets,
    journey: workspace.journey,
    packageInspection: prepared.packageInspection,
    redaction: "closed",
    referenceEnvironment: workspace.referenceEnvironment,
    safeguards: workspace.safeguards,
    schemaVersion: "keiko-native-codex-tracer-workspace-acceptance/v1",
    status: "complete",
  };
  assert.deepEqual(workspaceAcceptanceEvidenceFailures(evidence, expected), []);
  assert.notDeepEqual(workspaceAcceptanceEvidenceFailures(null, expected), []);

  const mutations = [
    [
      "source identity",
      (value) => (value.bindings.sourceRevision = "d".repeat(40)),
      "workspace-identity-sourceRevision",
    ],
    [
      "repository-owned identity",
      (value) => (value.bindings.issueNumber = "188"),
      "workspace-identity-issueNumber",
    ],
    [
      "projection count",
      (value) => value.budgets.workspaceProjectionMeasurements.pop(),
      "workspace-budget-projection-measurements",
    ],
    [
      "projection order",
      (value) => (value.budgets.workspaceProjectionMeasurements[0].sample = 2),
      "workspace-budget-projection-measurements",
    ],
    [
      "projection p95",
      (value) => (value.budgets.workspaceProjectionP95Ms = 41),
      "workspace-budget-projection-p95-consistency",
    ],
    [
      "projection maximum",
      (value) =>
        (value.budgets.workspaceProjectionMeasurements[0].projectedMs = 101),
      "workspace-budget-projection-measurements",
    ],
    [
      "native action",
      (value) =>
        (value.budgets.workspaceSelectionNativeActionMeasurements[0].nativeActionMs =
          -1),
      "workspace-budget-native-action-measurements",
    ],
    [
      "picker count",
      (value) => value.budgets.nativePickerCancellationMeasurements.pop(),
      "budget-native-picker-measurements",
    ],
    [
      "picker p95",
      (value) => (value.budgets.nativePickerCancellationP95Ms = 401),
      "budget-native-picker-p95-consistency",
    ],
    [
      "schema",
      (value) => (value.schemaVersion = "unknown"),
      "workspace-evidence-schema",
    ],
    [
      "status",
      (value) => (value.status = "pending"),
      "workspace-evidence-status",
    ],
    [
      "redaction",
      (value) => (value.redaction = "/Users/private/evidence"),
      "workspace-evidence-sensitive-content",
    ],
    [
      "journey",
      (value) => (value.journey.checkpointResults[0].status = "failed"),
      "workspace-journey-checkpointResults",
    ],
    [
      "package",
      (value) => (value.packageInspection.testHookMarkers = 1),
      "package-inspection-testHookMarkers",
    ],
    [
      "safeguards",
      (value) => (value.safeguards.residualProcesses = 1),
      "workspace-safeguard-residualProcesses",
    ],
    [
      "unknown field",
      (value) => (value.unexpected = "field"),
      "workspace-evidence-fields",
    ],
    [
      "reference environment",
      (value) => (value.referenceEnvironment.displaySerial = "sensitive"),
      "reference-environment-fields",
    ],
  ];
  for (const [name, mutate, expectedFailure] of mutations) {
    const hostile = structuredClone(evidence);
    mutate(hostile);
    assert.ok(
      workspaceAcceptanceEvidenceFailures(hostile, expected).includes(
        expectedFailure,
      ),
      name,
    );
  }
});

test("workspace acceptance cleans up and never persists partial evidence", async () => {
  const calls = [];
  const { prepared } = validWorkspaceFixture();
  const result = await runCodexTracerWorkspaceAcceptance({
    args: [],
    io: {
      cleanupWorkspacePackage() {
        calls.push("cleanup");
      },
      prepareWorkspacePackage() {
        calls.push("prepare");
        return prepared;
      },
      runWorkspaceJourney(_prepared, reportProgress) {
        calls.push("workspace");
        reportProgress("started", "workspace:observe-workspace-selected:2");
        throw new Error("private-path-and-content");
      },
      writeWorkspaceEvidence() {
        calls.push("write");
      },
    },
  });

  assert.deepEqual(calls, ["prepare", "workspace", "cleanup"]);
  assert.deepEqual(result, {
    diagnostic: {
      lastCompleted: "prepare",
      lastStarted: "workspace:observe-workspace-selected:2",
      status: "rejected",
    },
    exitCode: 2,
    output: {
      reasonCode: "acceptance-check-failed",
      schemaVersion: "keiko-native-codex-tracer-workspace-acceptance/v1",
      status: "rejected",
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /private|path|content/iu);

  const { workspace } = validWorkspaceFixture();
  const cleanupFailureCalls = [];
  const cleanupFailure = await runCodexTracerWorkspaceAcceptance({
    args: [],
    io: {
      cleanupWorkspacePackage() {
        cleanupFailureCalls.push("cleanup");
        throw new Error("cleanup-failed");
      },
      prepareWorkspacePackage() {
        cleanupFailureCalls.push("prepare");
        return prepared;
      },
      runWorkspaceJourney() {
        cleanupFailureCalls.push("workspace");
        return workspace;
      },
      writeWorkspaceEvidence() {
        cleanupFailureCalls.push("write");
      },
    },
  });
  assert.deepEqual(cleanupFailureCalls, ["prepare", "workspace", "cleanup"]);
  assert.equal(cleanupFailure.exitCode, 2);
  assert.deepEqual(cleanupFailure.diagnostic, {
    lastCompleted: "workspace-journey",
    lastStarted: "cleanup:fixture",
    status: "rejected",
  });

  const writeFailureCalls = [];
  const writeFailure = await runCodexTracerWorkspaceAcceptance({
    args: [],
    io: {
      cleanupWorkspacePackage() {
        writeFailureCalls.push("cleanup");
      },
      prepareWorkspacePackage() {
        return prepared;
      },
      runWorkspaceJourney() {
        return workspace;
      },
      writeWorkspaceEvidence() {
        writeFailureCalls.push("write");
        throw new Error("write-failed");
      },
    },
  });
  assert.deepEqual(writeFailureCalls, ["cleanup", "write"]);
  assert.deepEqual(writeFailure.diagnostic, {
    lastCompleted: "validate",
    lastStarted: "write",
    status: "rejected",
  });
});

test("workspace diagnostics reject hostile checkpoints without reflecting them", async () => {
  const { prepared } = validWorkspaceFixture();
  for (const checkpoint of ["workspace:/Users/private/repository:1", null]) {
    const result = await runCodexTracerWorkspaceAcceptance({
      args: [],
      io: {
        cleanupWorkspacePackage() {},
        prepareWorkspacePackage() {
          return prepared;
        },
        runWorkspaceJourney(_value, reportProgress) {
          reportProgress("started", checkpoint);
        },
        writeWorkspaceEvidence() {},
      },
    });

    assert.deepEqual(result.diagnostic, {
      lastCompleted: "prepare",
      lastStarted: "workspace-journey",
      status: "rejected",
    });
    assert.doesNotMatch(JSON.stringify(result), /Users|private|repository/iu);
  }
});
