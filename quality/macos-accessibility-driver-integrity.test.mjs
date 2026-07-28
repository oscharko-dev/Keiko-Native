import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { evaluateMacosAccessibilityDriver } from "./macos-accessibility-driver-evaluation.mjs";
import { physicalEvaluationSourceNames } from "./macos-accessibility-driver-source.mjs";
import {
  replaceRetainedArtifact,
  replaceRetainedPreparedArtifactEverywhere,
  retainedEvaluationInput,
} from "./macos-accessibility-driver-test-fixture.mjs";

const integrityBoundRepositoryPaths = Object.freeze([
  "docs/evaluation/macos-accessibility-driver-capture-allowed.json",
  "docs/evaluation/macos-accessibility-driver-capture-denied.json",
  "docs/evaluation/macos-accessibility-driver-capture-recovered.json",
  "docs/evaluation/macos-accessibility-driver-capture-revoked.json",
  "docs/evaluation/macos-accessibility-driver-evidence.json",
  "docs/evaluation/macos-accessibility-driver-foundation-acceptance.json",
  "docs/evaluation/macos-accessibility-driver-foundation-package-manifest.json",
  "docs/evaluation/macos-accessibility-driver-prepared.json",
  "native/package-policy.json",
  ...physicalEvaluationSourceNames.map((name) => `quality/${name}`),
  "quality/fixtures/macos-accessibility-foundation-acceptance.json",
  "quality/fixtures/macos-accessibility-foundation-package-manifest.json",
]);

async function equalWorkloadInput() {
  return retainedEvaluationInput();
}

function replaceRetainedCapture(input, id, mutate) {
  replaceRetainedArtifact(input, id, mutate);
}

test("pins every integrity-bound repository text input to LF checkout bytes", () => {
  const fields = execFileSync(
    "git",
    ["check-attr", "-z", "eol", "--", ...integrityBoundRepositoryPaths],
    {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter(Boolean);
  assert.equal(fields.length, integrityBoundRepositoryPaths.length * 3);
  for (let index = 0; index < fields.length; index += 3) {
    assert.equal(fields[index], integrityBoundRepositoryPaths[index / 3]);
    assert.equal(fields[index + 1], "eol");
    assert.equal(fields[index + 2], "lf");
  }
});

test("holds the rejected no-driver baseline to the same permission workload", async () => {
  const result = evaluateMacosAccessibilityDriver(await equalWorkloadInput());

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.status, "complete");
  assert.deepEqual(result.output.absoluteFailures.noDriver, [
    "missing-automatable-checkpoint",
  ]);
});

test("does not award package isolation to forged Foundation attestations", async () => {
  for (const foundationPackageAttestation of [
    { authenticated: false },
    {
      authenticated: true,
      packageManifestSha256: "c".repeat(64),
      packagePolicySha256: "d".repeat(64),
      reasonCode: null,
      sourceRevision: "a".repeat(40),
    },
  ]) {
    const input = await equalWorkloadInput();
    input.foundationPackageAttestation = foundationPackageAttestation;

    const result = evaluateMacosAccessibilityDriver(input);

    assert.notEqual(result.exitCode, 0);
    assert.notEqual(result.output.status, "complete");
  }
});

test("derives representative package isolation from every retained inspection invariant", async () => {
  const proseOnly = await equalWorkloadInput();
  proseOnly.evidence.packageBindings.representative.selfAssertedProductExclusion = false;
  assert.equal(
    evaluateMacosAccessibilityDriver(proseOnly).output.status,
    "complete",
  );

  for (const mutateInspection of [
    (inspection) => {
      inspection.candidateFilesInsidePackage = 1;
    },
    (inspection) => {
      inspection.missingCheckpoints.push("workspace-select");
    },
    (inspection) => {
      inspection.packageFiles.push("Contents/MacOS/AXUIElementCandidate");
    },
    (inspection) => {
      inspection.privateApis = 1;
    },
    (inspection) => {
      inspection.productHooks = 1;
    },
    (inspection) => {
      inspection.status = "contaminated";
    },
  ]) {
    const contaminated = await equalWorkloadInput();
    replaceRetainedPreparedArtifactEverywhere(
      contaminated,
      ({ representativeInspection }) => {
        mutateInspection(representativeInspection);
      },
    );
    const result = evaluateMacosAccessibilityDriver(contaminated);
    assert.equal(result.exitCode, 2);
    assert.equal(result.output.status, "invalid");
  }
});

test("reports an incomplete no-driver workload instead of silently omitting it", async () => {
  const input = await equalWorkloadInput();
  input.evidence.options.noDriver.permissionMatrix.allowed.repetitions = 19;

  const result = evaluateMacosAccessibilityDriver(input);

  assert.equal(result.exitCode, 3);
  assert.equal(result.output.status, "incomplete");
  assert.deepEqual(result.output.pendingOptions, ["noDriver"]);
});

test("rejects incomplete, failed, and internally inconsistent retained timings", async () => {
  const failedCheckpoint = await equalWorkloadInput();
  replaceRetainedCapture(failedCheckpoint, "allowed", (capture) => {
    capture.timings.axuielement[0].checkpoints[0].status = "failed";
  });

  const incompleteJourney = await equalWorkloadInput();
  replaceRetainedCapture(incompleteJourney, "allowed", (capture) => {
    capture.timings.axuielement[0].checkpoints.pop();
  });

  const undercountedRun = await equalWorkloadInput();
  replaceRetainedCapture(undercountedRun, "allowed", (capture) => {
    capture.timings.axuielement[0].elapsedMs = 0;
  });

  const systemEventsProcessActivity = await equalWorkloadInput();
  replaceRetainedCapture(systemEventsProcessActivity, "allowed", (capture) => {
    capture.timings.systemEvents.push({
      checkpoints: [],
      elapsedMs: 1,
      repetition: 1,
    });
  });

  const deniedWithCheckpoint = await equalWorkloadInput();
  replaceRetainedCapture(deniedWithCheckpoint, "denied", (capture) => {
    capture.timings.axuielement[0].checkpoints.push({
      checkpoint: "workspace-select",
      elapsedMs: 1,
      status: "permission-denied",
    });
  });

  for (const input of [
    failedCheckpoint,
    incompleteJourney,
    undercountedRun,
    systemEventsProcessActivity,
    deniedWithCheckpoint,
  ]) {
    const result = evaluateMacosAccessibilityDriver(input);
    assert.equal(result.exitCode, 2);
    assert.equal(result.output.status, "invalid");
    assert.equal(result.output.reasonCode, "evaluation-evidence-invalid");
  }
});
