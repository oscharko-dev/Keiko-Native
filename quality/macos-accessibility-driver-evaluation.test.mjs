import assert from "node:assert/strict";
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
  authenticateOwnedProcessGroup,
  capturePhysicalMatrixPhase,
  compileAndProbeEvaluation,
  compileProcessGroupInspector,
  createEvaluationArtifacts,
  evaluationArtifactRoot,
  inspectEvaluationArtifacts,
  permissionProbeResult,
  preparePhysicalMatrix,
  processCleanupDependencies,
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
  assert.deepEqual(result.output.absoluteFailures.systemEvents, [
    "authoritative-evidence-unavailable",
  ]);
  assert.ok(
    result.output.weightedScores.axuielement >
      result.output.weightedScores.systemEvents,
  );
  assert.equal(result.output.weightedScores.systemEvents, 260);
  assert.equal(result.output.weightedScores.noDriver, 260);
});

test("never selects statically rejected System Events", () => {
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

  assert.equal(result.exitCode, 2);
  assert.equal(result.output.reasonCode, "no-candidate-passed-absolute-gates");
});

test("requires zero-activity System Events rejection evidence", () => {
  const attempted = completedEvidence();
  attempted.options.systemEvents.physicalRepetitions = 1;
  attempted.options.systemEvents.permissionMatrix.allowed.repetitions = 1;

  const result = evaluateMacosAccessibilityDriver(
    retainedEvaluationInput(attempted),
  );

  assert.equal(result.exitCode, 2);
  assert.equal(result.output.reasonCode, "evaluation-evidence-invalid");
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
    const systemEvents = await readFile(created.systemEventsSource, "utf8");
    assert.match(systemEvents, /authoritative-evidence-unavailable/u);
    assert.match(systemEvents, /"prompted\\":null/u);
    assert.doesNotMatch(systemEvents, /tell application/iu);
    assert.doesNotMatch(systemEvents, /-1743/u);
    assert.doesNotMatch(systemEvents, /UI elements enabled/u);
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

test("permission probes reject System Events without claiming prompt state", () => {
  assert.deepEqual(permissionProbeResult("axuielement", false), {
    candidate: "axuielement",
    status: "permission-denied",
    reasonCode: "accessibility-permission-denied",
    prompted: false,
  });
  assert.deepEqual(permissionProbeResult("systemEvents", true), {
    candidate: "systemEvents",
    status: "rejected",
    reasonCode: "authoritative-evidence-unavailable",
    prompted: null,
  });
  assert.throws(
    () => permissionProbeResult("other", true),
    /unknown-candidate/u,
  );
});

test("System Events physical execution is statically rejected before process activity", async () => {
  assert.deepEqual(
    await runPhysicalCandidate({
      candidate: "systemEvents",
      includeTimings: true,
      phase: "allowed",
      repetition: 1,
      root: "/path-that-must-not-be-read",
    }),
    {
      candidate: "systemEvents",
      repetition: 1,
      status: "rejected",
      checkpointPasses: 0,
      boundedWait: true,
      cleanupOwnedDescendants: 0,
      reasonCode: "authoritative-evidence-unavailable",
      timings: { checkpoints: [], elapsedMs: 0 },
    },
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

test("cleanup deterministically terminates a surviving owned process after its root exits", async () => {
  const rootIdentity = Object.freeze({
    processGroupId: 4100,
    pid: 4100,
    startIdentity: "root-start",
  });
  const descendant = Object.freeze({
    processGroupId: 4100,
    pid: 4101,
    startIdentity: "descendant-start",
  });
  let members = [rootIdentity];
  let monotonicMs = 0;
  const signals = [];
  const dependencies = {
    listProcessGroup: () => structuredClone(members),
    monotonicNow: () => monotonicMs,
    readProcessIdentity: (pid) =>
      members.find((entry) => entry.pid === pid) ?? null,
    signalProcess: (identity, signal) => {
      signals.push({ identity, signal });
      if (signal !== "SIGKILL") return;
      members = members.filter((entry) => entry.pid !== identity.pid);
      if (identity.pid === 4101)
        members.push(
          Object.freeze({
            processGroupId: 4100,
            pid: 4102,
            startIdentity: "late-descendant-start",
          }),
        );
    },
    waitForTurn: async (milliseconds) => {
      monotonicMs += milliseconds;
    },
  };
  const ownership = await authenticateOwnedProcessGroup(
    { pid: 4100 },
    dependencies,
  );
  members = [descendant];

  assert.equal(await terminateOwnedProcess(ownership, dependencies), 0);
  assert.deepEqual(signals, [
    {
      identity: descendant,
      signal: "SIGTERM",
    },
    {
      identity: descendant,
      signal: "SIGKILL",
    },
    {
      identity: {
        processGroupId: 4100,
        pid: 4102,
        startIdentity: "late-descendant-start",
      },
      signal: "SIGKILL",
    },
  ]);
  assert.ok(monotonicMs >= 2_040);
});

test("cleanup rejects unauthenticated and reused process identities without signaling", async () => {
  const signals = [];
  const original = Object.freeze({
    processGroupId: 4200,
    pid: 4200,
    startIdentity: "original-start",
  });
  let members = [original];
  let monotonicMs = 0;
  const dependencies = {
    listProcessGroup: () => structuredClone(members),
    monotonicNow: () => monotonicMs,
    readProcessIdentity: (pid) =>
      members.find((entry) => entry.pid === pid) ?? null,
    signalProcess: (identity, signal) => {
      signals.push({ identity, signal });
    },
    waitForTurn: async (milliseconds) => {
      monotonicMs += milliseconds;
    },
  };

  await assert.rejects(
    terminateOwnedProcess(
      { pid: 4200, processGroupId: 4200, startIdentity: "forged" },
      dependencies,
    ),
    /process-cleanup-identity-invalid/u,
  );
  const ownership = await authenticateOwnedProcessGroup(
    { pid: 4200 },
    dependencies,
  );
  members = [{ ...original, startIdentity: "reused-start" }];
  await assert.rejects(
    terminateOwnedProcess(ownership, dependencies),
    /process-cleanup-identity-conflict/u,
  );
  assert.deepEqual(signals, []);
});

test("tracer cleanup owns a freshly compiled process inspector", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-process-inspector-"));
  try {
    const binary = await compileProcessGroupInspector(
      root,
      (command, args) => {
        assert.equal(command, "/usr/bin/xcrun");
        assert.deepEqual(args, [
          "clang",
          join(root, "ProcessGroupLauncher.c"),
          "-o",
          join(root, "ProcessGroupLauncher"),
        ]);
        return { exitCode: 0, signal: null, timedOut: false };
      },
      (command, args, timeoutMs) => {
        assert.equal(command, join(root, "ProcessGroupLauncher"));
        assert.deepEqual(args, ["--inspect"]);
        assert.equal(timeoutMs, 5_000);
        return { exitCode: 0, signal: null, timedOut: false };
      },
    );
    assert.equal(binary, join(root, "ProcessGroupLauncher"));
    assert.match(
      await readFile(join(root, "ProcessGroupLauncher.c"), "utf8"),
      /proc_pidinfo/u,
    );
    assert.deepEqual(Object.keys(processCleanupDependencies(root)).toSorted(), [
      "listProcessGroup",
      "monotonicNow",
      "readProcessIdentity",
      "signalProcess",
      "waitForTurn",
    ]);
    await assert.rejects(
      compileProcessGroupInspector(root, () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
      })),
      /process-inspector-compile-failed/u,
    );
    await assert.rejects(
      compileProcessGroupInspector(
        root,
        () => ({ exitCode: 0, signal: null, timedOut: false }),
        () => ({ exitCode: 1, signal: null, timedOut: false }),
      ),
      /process-inspector-preflight-failed/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

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
    assert.equal(calls, 20);
    assert.equal(
      allowed.schemaVersion,
      "keiko-native-macos-accessibility-driver-capture/v2",
    );
    assert.equal(allowed.predecessor, null);
    assert.equal(allowed.options.axuielement.repetitions, 20);
    assert.deepEqual(allowed.options.systemEvents, {
      status: "allowed",
      repetitions: 0,
      successfulRepetitions: 0,
      checkpointPasses: 0,
      boundedWaits: true,
      unexplainedFailures: 0,
      reasonCode: "authoritative-evidence-unavailable",
      cleanupOwnedDescendants: 0,
    });
    assert.deepEqual(allowed.timings.systemEvents, []);

    await assert.rejects(
      capturePhysicalMatrixPhase(root, {
        phase: "denied",
        prepared,
        priorCapture: null,
        runCandidate: async () => {
          throw new Error("must-not-run");
        },
      }),
      /capture-predecessor-invalid/u,
    );

    await assert.rejects(
      capturePhysicalMatrixPhase(root, {
        phase: "allowed",
        prepared,
        priorCapture: allowed,
        runCandidate: async () => {
          throw new Error("must-not-run");
        },
      }),
      /capture-predecessor-unexpected/u,
    );

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
    assert.equal(failedCalls, 1);
    assert.equal(failed.options.axuielement.repetitions, 1);
    assert.equal(failed.options.systemEvents.repetitions, 0);

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
      /capture-predecessor-invalid/u,
    );

    await assert.rejects(
      capturePhysicalMatrixPhase(root, {
        phase: "recovered",
        prepared,
        priorCapture: allowed,
        runCandidate: async () => {
          throw new Error("must-not-run");
        },
      }),
      /capture-predecessor-invalid/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test(
  "the compiled surface exposes the 16 checkpoints to AXUIElement only",
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
      assert.deepEqual(compiled.candidateProbes.systemEvents, {
        candidate: "systemEvents",
        prompted: null,
        reasonCode: "authoritative-evidence-unavailable",
        status: "rejected",
      });
      const result = await runPhysicalCandidate({
        candidate: "axuielement",
        phase: "allowed",
        repetition: 1,
        root,
      });
      assert.deepEqual(result, {
        candidate: "axuielement",
        repetition: 1,
        status: "passed",
        checkpointPasses: 16,
        boundedWait: true,
        cleanupOwnedDescendants: 0,
        reasonCode: null,
      });
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
