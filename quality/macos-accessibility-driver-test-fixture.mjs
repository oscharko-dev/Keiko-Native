import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  evaluationProfile,
  scoreOption,
} from "./macos-accessibility-driver-evaluation.mjs";
import { authenticateFoundationPackage } from "./macos-accessibility-foundation-attestation.mjs";

export const evidenceFixture = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/macos-accessibility-driver-evidence.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const [foundationAcceptanceRaw, foundationManifestRaw, packagePolicyRaw] =
  await Promise.all([
    readFile(
      new URL(
        "./fixtures/macos-accessibility-foundation-acceptance.json",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "./fixtures/macos-accessibility-foundation-package-manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../native/package-policy.json", import.meta.url), "utf8"),
  ]);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function completeState(status, repetitions = 20) {
  return {
    status,
    repetitions,
    successfulRepetitions: status === "allowed" ? repetitions : 0,
    checkpointPasses:
      status === "allowed"
        ? repetitions * evaluationProfile.checkpoints.length
        : 0,
    boundedWaits: true,
    unexplainedFailures: 0,
    reasonCode: status === "allowed" ? null : "accessibility-permission-denied",
    cleanupOwnedDescendants: 0,
  };
}

export function completedEvidence() {
  const completed = structuredClone(evidenceFixture);
  completed.bindings.evaluationSourceSha256 = "b".repeat(64);
  completed.bindings.representativePackageSha256 = "e".repeat(64);
  completed.authority.physicalAccessibility = "complete";
  completed.authority.physicalRepetitions = 40;
  completed.packageBindings.foundation.status = "complete";
  completed.packageBindings.foundation.selfAssertedExclusion = true;
  completed.packageBindings.representative.status = "complete";
  completed.packageBindings.representative.selfAssertedProductExclusion = true;
  for (const id of ["axuielement", "systemEvents"]) {
    const option = completed.options[id];
    option.evidenceStatus = "complete";
    option.physicalRepetitions = 20;
    option.permissionMatrix = {
      allowed: completeState("allowed"),
      denied: completeState("denied", 1),
      revoked: completeState("revoked", 1),
      recovered: completeState("allowed", 1),
    };
    option.absoluteFailures = [];
    option.matrixScores = scoreOption(option, completed, {
      foundationPackageAuthenticated: true,
      representativePackageAuthenticated: true,
    });
  }
  completed.pendingEvidence = [];
  return completed;
}

export function retainedEvaluationInput(evidence = completedEvidence()) {
  const prepared = {
    schemaVersion: "keiko-native-macos-accessibility-driver-prepared/v1",
    sourceHead: evidence.bindings.evaluationHead,
    sourceDigest: evidence.bindings.evaluationSourceSha256,
    bundleIdentifier: "dev.oscharko.keiko-native.evaluation.accessibility",
    representativePackageSha256: evidence.bindings.representativePackageSha256,
    representativeInspection: {
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
    candidateDigests: {
      axuielement: evidence.bindings.axuielementCandidateSha256,
      systemEvents: evidence.bindings.systemEventsCandidateSha256,
    },
  };
  const retainedArtifacts = {
    prepared: `${JSON.stringify(prepared, null, 2)}\n`,
  };
  for (const phase of ["allowed", "denied", "revoked", "recovered"]) {
    const repetitions = phase === "allowed" ? 20 : 1;
    const timings = Object.fromEntries(
      ["axuielement", "systemEvents"].map((candidate) => [
        candidate,
        Array.from({ length: repetitions }, (_, index) => ({
          checkpoints:
            phase === "allowed" || phase === "recovered"
              ? evaluationProfile.checkpoints.map((checkpoint) => ({
                  checkpoint,
                  elapsedMs: 1,
                  status: "passed",
                }))
              : [],
          elapsedMs:
            phase === "allowed" || phase === "recovered"
              ? evaluationProfile.checkpoints.length
              : 1,
          repetition: index + 1,
        })),
      ]),
    );
    const capture = {
      schemaVersion: "keiko-native-macos-accessibility-driver-capture/v1",
      phase,
      prepared,
      options: Object.fromEntries(
        ["axuielement", "systemEvents"].map((candidate) => [
          candidate,
          evidence.options[candidate].permissionMatrix[phase],
        ]),
      ),
      timings,
    };
    retainedArtifacts[phase] = `${JSON.stringify(capture, null, 2)}\n`;
  }
  for (const [id, binding] of Object.entries({
    prepared: "preparedEvidenceSha256",
    allowed: "allowedCaptureSha256",
    denied: "deniedCaptureSha256",
    revoked: "revokedCaptureSha256",
    recovered: "recoveredCaptureSha256",
  }))
    evidence.bindings[binding] = sha256(retainedArtifacts[id]);
  return {
    args: [],
    currentSourceDigest: evidence.bindings.evaluationSourceSha256,
    evidence,
    foundationPackageAttestation: authenticateFoundationPackage({
      acceptanceEvidenceRaw: foundationAcceptanceRaw,
      bindings: {
        evaluationHead: evidence.bindings.evaluationHead,
        foundationEvidenceSha256: evidence.bindings.foundationEvidenceSha256,
        foundationPackageSha256: evidence.bindings.foundationPackageSha256,
      },
      packageManifestRaw: foundationManifestRaw,
      packagePolicyRaw,
    }),
    retainedArtifacts,
  };
}

export function replaceRetainedArtifact(input, id, mutate) {
  const artifact = JSON.parse(input.retainedArtifacts[id]);
  mutate(artifact);
  input.retainedArtifacts[id] = `${JSON.stringify(artifact, null, 2)}\n`;
  input.evidence.bindings[
    {
      prepared: "preparedEvidenceSha256",
      allowed: "allowedCaptureSha256",
      denied: "deniedCaptureSha256",
      revoked: "revokedCaptureSha256",
      recovered: "recoveredCaptureSha256",
    }[id]
  ] = sha256(input.retainedArtifacts[id]);
}

export function replaceRetainedPreparedArtifactEverywhere(input, mutate) {
  const prepared = JSON.parse(input.retainedArtifacts.prepared);
  mutate(prepared);
  input.retainedArtifacts.prepared = `${JSON.stringify(prepared, null, 2)}\n`;
  input.evidence.bindings.preparedEvidenceSha256 = sha256(
    input.retainedArtifacts.prepared,
  );
  for (const [id, binding] of Object.entries({
    allowed: "allowedCaptureSha256",
    denied: "deniedCaptureSha256",
    revoked: "revokedCaptureSha256",
    recovered: "recoveredCaptureSha256",
  })) {
    const capture = JSON.parse(input.retainedArtifacts[id]);
    capture.prepared = structuredClone(prepared);
    input.retainedArtifacts[id] = `${JSON.stringify(capture, null, 2)}\n`;
    input.evidence.bindings[binding] = sha256(input.retainedArtifacts[id]);
  }
}
