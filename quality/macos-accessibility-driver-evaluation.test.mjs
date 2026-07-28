import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  evaluateMacosAccessibilityDriver,
  evaluationProfile,
  scoreOption,
} from "./macos-accessibility-driver-evaluation.mjs";
import {
  capturePhysicalMatrixPhase,
  compileAndProbeEvaluation,
  createEvaluationArtifacts,
  evaluationArtifactRoot,
  inspectEvaluationArtifacts,
  permissionProbeResult,
  preparePhysicalMatrix,
  runPhysicalCandidate,
  summarizePhysicalRuns,
  terminateOwnedProcess,
} from "./macos-accessibility-driver-harness.mjs";
import {
  completedEvidence,
  evidenceFixture as evidence,
  replaceRetainedArtifact,
  retainedEvaluationInput,
} from "./macos-accessibility-driver-test-fixture.mjs";

test("stays incomplete while any physical permission state is pending", () => {
  const pending = completedEvidence();
  pending.options.systemEvents.evidenceStatus = "pending";
  pending.pendingEvidence = ["accessibility-recovered"];
  const result = evaluateMacosAccessibilityDriver(
    retainedEvaluationInput(pending),
  );

  assert.equal(result.exitCode, 3);
  assert.equal(result.output.status, "incomplete");
  assert.equal(result.output.decision, "pending");
  assert.equal(result.output.reasonCode, "physical-matrix-incomplete");
  assert.deepEqual(result.output.pendingEvidence, ["accessibility-recovered"]);
});

test("holds every option to one exact profile", () => {
  assert.equal(evaluationProfile.repetitions, 20);
  assert.equal(evaluationProfile.checkpoints.length, 16);
  assert.deepEqual(evaluationProfile.permissionStates, [
    "allowed",
    "denied",
    "revoked",
  ]);
  assert.deepEqual(
    evidence.commonProfile.checkpoints,
    evaluationProfile.checkpoints,
  );
  assert.equal(evaluationProfile.options.length, 3);
});

test("selects deterministically only after complete absolute-gate evidence", () => {
  const result = evaluateMacosAccessibilityDriver(retainedEvaluationInput());

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.status, "complete");
  assert.equal(result.output.decision, "select");
  assert.equal(result.output.selectedOption, "axuielement");
  assert.equal(result.output.recommendation, "external-axuielement-adapter");
  assert.ok(
    result.output.weightedScores.axuielement >
      result.output.weightedScores.systemEvents,
  );
  assert.equal(result.output.weightedScores.noDriver, 260);
});

test("rejects a viable candidate with an absolute failure", () => {
  const completed = completedEvidence();
  completed.options.axuielement.absoluteFailures = ["package-inclusion"];
  completed.options.axuielement.matrixScores = scoreOption(
    completed.options.axuielement,
    completed,
    {
      foundationPackageAuthenticated: true,
      representativePackageAuthenticated: true,
    },
  );

  const result = evaluateMacosAccessibilityDriver(
    retainedEvaluationInput(completed),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.selectedOption, "systemEvents");
});

test("rejects submitted matrix scores that do not match fixed scoring", () => {
  const tampered = completedEvidence();
  for (const criterion of Object.keys(
    tampered.options.axuielement.matrixScores,
  ))
    tampered.options.axuielement.matrixScores[criterion] = 1;
  for (const criterion of Object.keys(
    tampered.options.systemEvents.matrixScores,
  ))
    tampered.options.systemEvents.matrixScores[criterion] = 5;

  const result = evaluateMacosAccessibilityDriver(
    retainedEvaluationInput(tampered),
  );

  assert.equal(result.exitCode, 2);
  assert.equal(result.output.status, "invalid");
  assert.equal(result.output.reasonCode, "evaluation-evidence-invalid");
});

test("validates every retained hash and exact nested evidence shape", () => {
  const bindingNames = [
    "allowedCaptureSha256",
    "axuielementCandidateSha256",
    "deniedCaptureSha256",
    "evaluationSourceSha256",
    "foundationEvidenceSha256",
    "foundationPackageSha256",
    "preparedEvidenceSha256",
    "recoveredCaptureSha256",
    "representativePackageSha256",
    "revokedCaptureSha256",
    "systemEventsCandidateSha256",
  ];
  const malformed = bindingNames.map((name) => {
    const input = retainedEvaluationInput();
    input.evidence.bindings[name] = "not-a-sha256";
    return input;
  });
  for (const name of ["evaluationHead", "frozenBaseHead"]) {
    const input = retainedEvaluationInput();
    input.evidence.bindings[name] = "not-a-head";
    malformed.push(input);
  }

  const nullOption = retainedEvaluationInput();
  nullOption.evidence.options.axuielement = null;
  malformed.push(nullOption);

  const extraSourceField = retainedEvaluationInput();
  extraSourceField.evidence.sources.systemEvents.privateValue = "not allowed";
  malformed.push(extraSourceField);

  const invalidPackageBinding = retainedEvaluationInput();
  invalidPackageBinding.evidence.packageBindings.foundation.selfAssertedExclusion =
    "true";
  malformed.push(invalidPackageBinding);

  const unknownAbsoluteFailure = retainedEvaluationInput();
  unknownAbsoluteFailure.evidence.options.axuielement.absoluteFailures = [
    "unknown-gate",
  ];
  malformed.push(unknownAbsoluteFailure);

  for (const input of malformed) {
    const result = evaluateMacosAccessibilityDriver(input);
    assert.equal(result.exitCode, 2);
    assert.equal(result.output.status, "invalid");
    assert.equal(result.output.reasonCode, "evaluation-evidence-invalid");
  }
});

test("requires current source and exact retained artifact digests", () => {
  const staleSource = retainedEvaluationInput();
  staleSource.currentSourceDigest = "f".repeat(64);

  const missingCapture = retainedEvaluationInput();
  delete missingCapture.retainedArtifacts.revoked;

  const changedBytes = retainedEvaluationInput();
  changedBytes.retainedArtifacts.allowed += " ";

  for (const input of [staleSource, missingCapture, changedBytes]) {
    const result = evaluateMacosAccessibilityDriver(input);
    assert.equal(result.exitCode, 2);
    assert.equal(result.output.status, "invalid");
    assert.equal(result.output.reasonCode, "evaluation-evidence-invalid");
  }
});

test("validates retained prepared identity, aggregates, and timing shape after digest verification", () => {
  const wrongPreparedIdentity = retainedEvaluationInput();
  replaceRetainedArtifact(wrongPreparedIdentity, "prepared", (prepared) => {
    prepared.candidateDigests.axuielement = "f".repeat(64);
  });

  const wrongCaptureIdentity = retainedEvaluationInput();
  replaceRetainedArtifact(wrongCaptureIdentity, "denied", (capture) => {
    capture.prepared.sourceHead = "f".repeat(40);
  });

  const wrongAggregate = retainedEvaluationInput();
  replaceRetainedArtifact(wrongAggregate, "allowed", (capture) => {
    capture.options.axuielement.checkpointPasses = 319;
  });

  const unboundedTiming = retainedEvaluationInput();
  replaceRetainedArtifact(unboundedTiming, "allowed", (capture) => {
    capture.timings.axuielement[0].checkpoints[0].elapsedMs = 7_001;
  });

  for (const input of [
    wrongPreparedIdentity,
    wrongCaptureIdentity,
    wrongAggregate,
    unboundedTiming,
  ]) {
    const result = evaluateMacosAccessibilityDriver(input);
    assert.equal(result.exitCode, 2);
    assert.equal(result.output.status, "invalid");
    assert.equal(result.output.reasonCode, "evaluation-evidence-invalid");
  }
});

test("creates both candidate sources and one representative package outside productive roots", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "keiko-accessibility-evaluation-test-"),
  );
  try {
    const created = await createEvaluationArtifacts(root);
    const inspection = await inspectEvaluationArtifacts(root);

    assert.deepEqual(created.candidates, ["axuielement", "systemEvents"]);
    assert.equal(inspection.status, "prepared");
    assert.deepEqual(inspection.missingCheckpoints, []);
    assert.equal(inspection.productHooks, 0);
    assert.equal(inspection.privateApis, 0);
    assert.equal(inspection.candidateFilesInsidePackage, 0);
    assert.deepEqual(
      inspection.packageFiles,
      inspection.packageFiles.toSorted(),
    );
    assert.match(
      await readFile(created.axuielementSource, "utf8"),
      /AXUIElement/u,
    );
    assert.match(
      await readFile(created.systemEventsSource, "utf8"),
      /systemevents/iu,
    );
    assert.match(
      await readFile(created.systemEventsSource, "utf8"),
      /UI elements enabled/u,
    );
    const injectedCandidate = join(
      created.packageRoot,
      "Contents",
      "Resources",
      "InjectedCandidate.m",
    );
    await writeFile(injectedCandidate, "evaluation-only", "utf8");
    const contaminated = await inspectEvaluationArtifacts(root);
    assert.equal(contaminated.status, "invalid");
    assert.equal(contaminated.candidateFilesInsidePackage, 1);
    await rm(injectedCandidate);
    await writeFile(
      join(created.packageRoot, "Contents", "Resources", "Marker.txt"),
      "remote-debugging AXUIElementCreateSystemWidePrivate",
      "utf8",
    );
    const prohibited = await inspectEvaluationArtifacts(root);
    assert.equal(prohibited.status, "invalid");
    assert.equal(prohibited.productHooks, 1);
    assert.equal(prohibited.privateApis, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("permission probes are closed and never prompt", () => {
  assert.deepEqual(permissionProbeResult("axuielement", false), {
    candidate: "axuielement",
    status: "permission-denied",
    reasonCode: "accessibility-permission-denied",
    prompted: false,
  });
  assert.deepEqual(permissionProbeResult("systemEvents", true), {
    candidate: "systemEvents",
    status: "ready",
    reasonCode: null,
    prompted: false,
  });
  assert.throws(
    () => permissionProbeResult("other", true),
    /unknown-candidate/u,
  );
});

test("physical run summaries require all checkpoints, cleanup, and zero unexplained failures", () => {
  const passed = Array.from({ length: 20 }, (_, index) => ({
    repetition: index + 1,
    status: "passed",
    checkpointPasses: 16,
    boundedWait: true,
    cleanupOwnedDescendants: 0,
    reasonCode: null,
  }));
  assert.deepEqual(summarizePhysicalRuns("allowed", passed), {
    status: "allowed",
    repetitions: 20,
    successfulRepetitions: 20,
    checkpointPasses: 320,
    boundedWaits: true,
    unexplainedFailures: 0,
    reasonCode: null,
    cleanupOwnedDescendants: 0,
  });

  const denied = summarizePhysicalRuns("revoked", [
    {
      repetition: 1,
      status: "permission-denied",
      checkpointPasses: 0,
      boundedWait: true,
      cleanupOwnedDescendants: 0,
      reasonCode: "accessibility-permission-denied",
    },
  ]);
  assert.equal(denied.status, "revoked");
  assert.equal(denied.unexplainedFailures, 0);
  assert.equal(denied.reasonCode, "accessibility-permission-denied");
});

test(
  "cleanup terminates and verifies a stubborn owned descendant tree",
  {
    skip:
      process.platform === "darwin"
        ? false
        : "the bounded process-tree implementation is macOS-only",
  },
  async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
        const { spawn } = require("node:child_process");
        process.on("SIGTERM", () => {});
        const descendant = spawn(
          process.execPath,
          ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
          { stdio: "ignore" },
        );
        descendant.once("spawn", () => process.send({ descendant: descendant.pid }));
        setInterval(() => {}, 1000);
      `,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    let descendantPid;
    try {
      const [message] = await once(child, "message", {
        signal: AbortSignal.timeout(5_000),
      });
      descendantPid = message.descendant;
      assert.equal(await terminateOwnedProcess(child), 0);
      for (const pid of [child.pid, descendantPid])
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      for (const pid of [descendantPid, child.pid]) {
        if (!Number.isSafeInteger(pid)) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
    }
  },
);

test("operator phases retain one exact identity and run 20 allowed repetitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-operator-seam-"));
  try {
    const prepared = await preparePhysicalMatrix(root, {
      compile: async () => ({
        compileStatus: "passed",
        candidateDigests: {
          axuielement: "a".repeat(64),
          systemEvents: "b".repeat(64),
        },
        inspection: {
          candidateFilesInsidePackage: 0,
          missingCheckpoints: [],
          packageFiles: [
            "Contents/Info.plist",
            "Contents/MacOS/KeikoAccessibilityEvaluation",
          ],
          privateApis: 0,
          productHooks: 0,
          status: "prepared",
        },
        representativePackageSha256: "c".repeat(64),
      }),
      sourceHead: "d".repeat(40),
      sourceDigest: "e".repeat(64),
    });
    assert.equal(evaluationArtifactRoot.endsWith("issue-111-v3"), true);
    assert.equal(
      prepared.schemaVersion,
      "keiko-native-macos-accessibility-driver-prepared/v1",
    );

    let calls = 0;
    const allowed = await capturePhysicalMatrixPhase(root, {
      phase: "allowed",
      prepared,
      runCandidate: async ({ candidate, repetition }) => {
        calls += 1;
        return {
          candidate,
          repetition,
          status: "passed",
          checkpointPasses: 16,
          boundedWait: true,
          cleanupOwnedDescendants: 0,
          reasonCode: null,
        };
      },
    });
    assert.equal(calls, 40);
    assert.equal(allowed.options.axuielement.repetitions, 20);
    assert.equal(allowed.options.systemEvents.checkpointPasses, 320);

    let failedCalls = 0;
    const failed = await capturePhysicalMatrixPhase(root, {
      phase: "allowed",
      prepared,
      runCandidate: async ({ candidate, repetition }) => {
        failedCalls += 1;
        return {
          candidate,
          repetition,
          status: "failed",
          checkpointPasses: 0,
          boundedWait: true,
          cleanupOwnedDescendants: 0,
          reasonCode: "surface-unavailable",
        };
      },
    });
    assert.equal(failedCalls, 2);
    assert.equal(failed.options.axuielement.repetitions, 1);
    assert.equal(failed.options.systemEvents.repetitions, 1);

    const mismatched = structuredClone(prepared);
    mismatched.sourceHead = "f".repeat(40);
    await assert.rejects(
      capturePhysicalMatrixPhase(root, {
        phase: "recovered",
        prepared: mismatched,
        priorCapture: allowed,
        runCandidate: async () => {
          throw new Error("must-not-run");
        },
      }),
      /capture-identity-mismatch/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test(
  "the compiled surface exposes the same 16 checkpoints to both candidates",
  {
    skip:
      process.platform !== "darwin" ||
      process.env.KEIKO_MACOS_ACCESSIBILITY_PHYSICAL !== "1",
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "keiko-physical-surface-"));
    try {
      const compiled = await compileAndProbeEvaluation(root);
      assert.equal(compiled.compileStatus, "passed");
      for (const candidate of ["axuielement", "systemEvents"]) {
        const result = await runPhysicalCandidate({
          candidate,
          phase: "allowed",
          repetition: 1,
          root,
        });
        assert.deepEqual(result, {
          candidate,
          repetition: 1,
          status: "passed",
          checkpointPasses: 16,
          boundedWait: true,
          cleanupOwnedDescendants: 0,
          reasonCode: null,
        });
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);

test("rejects malformed evidence and command arguments without echoing input", () => {
  const hostile = structuredClone(evidence);
  hostile.privateValue = "selected repository path";

  for (const result of [
    evaluateMacosAccessibilityDriver({ args: [], evidence: hostile }),
    evaluateMacosAccessibilityDriver({
      args: ["selected repository path"],
      evidence,
    }),
  ]) {
    assert.equal(result.exitCode, 2);
    assert.equal(result.output.status, "invalid");
    assert.doesNotMatch(JSON.stringify(result.output), /repository|path/u);
  }
});
