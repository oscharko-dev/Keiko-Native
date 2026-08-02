import { createHash } from "node:crypto";

import { compareCodeUnits } from "./deterministic-order.mjs";
import { representativeInspectionValid } from "./macos-accessibility-driver-harness.mjs";
import { isAuthenticatedFoundationPackage } from "./macos-accessibility-foundation-attestation.mjs";

const SCHEMA_VERSION = "keiko-native-macos-accessibility-driver-evaluation/v1";
const EVIDENCE_SCHEMA_VERSION =
  "keiko-native-macos-accessibility-driver-evidence/v1";
const PROFILE_ID = "epic-98-packaged-journey/v1";
const READINESS_FINGERPRINT =
  "6d95dc95700c17a2d29850d1f517ad45c53df4a95318e3ae482f7d32d5dc75d7";

const checkpoints = Object.freeze([
  "workspace-select",
  "workspace-cancel",
  "workspace-permission-deny",
  "task-submit",
  "streaming",
  "normal-completion",
  "run-cancellation",
  "crash-recovery",
  "terminal-summary",
  "keyboard-focus",
  "voiceover-semantics",
  "appearance-contrast",
  "reduce-motion-applicability",
  "scaling",
  "unicode-ime",
  "quit-zero-descendants",
]);
const permissionStates = Object.freeze(["allowed", "denied", "revoked"]);
const absoluteGates = Object.freeze([
  "product-hook",
  "private-api",
  "content-leak",
  "package-inclusion",
  "unexplained-failed-repetition",
  "missing-automatable-checkpoint",
  "unbounded-wait",
  "authoritative-evidence-unavailable",
]);
const evidenceFields = Object.freeze([
  "checkpointCoverage",
  "permissionStates",
  "repetitions",
  "boundedWaits",
  "diagnostics",
  "packageIsolation",
  "dependencyInventory",
  "licenseInventory",
  "macosOwner",
  "windowsBoundary",
  "migration",
  "removal",
]);
const optionIds = Object.freeze(["axuielement", "systemEvents", "noDriver"]);
const candidateIds = Object.freeze(["axuielement", "systemEvents"]);
const sha256Pattern = /^[0-9a-f]{64}$/u;
const headPattern = /^[0-9a-f]{40}$/u;
const retainedArtifactIds = Object.freeze([
  "prepared",
  "allowed",
  "denied",
  "revoked",
  "recovered",
]);
const captureArtifactIds = Object.freeze(retainedArtifactIds.slice(1));
const MAX_RETAINED_ARTIFACT_BYTES = 1_000_000;
const MAX_CHECKPOINT_ELAPSED_MS = 7_000;
const MAX_RUN_ELAPSED_MS = 40_000;
const bindingKeys = Object.freeze([
  "allowedCaptureSha256",
  "axuielementCandidateSha256",
  "contractVersion",
  "deniedCaptureSha256",
  "evaluationHead",
  "evaluationSourceSha256",
  "foundationEvidenceSha256",
  "foundationPackageSha256",
  "frozenBaseHead",
  "issue",
  "preparedEvidenceSha256",
  "readinessFingerprint",
  "recoveredCaptureSha256",
  "representativePackageSha256",
  "revokedCaptureSha256",
  "systemEventsCandidateSha256",
]);
const sha256BindingKeys = Object.freeze(
  bindingKeys.filter((key) => key.endsWith("Sha256")),
);
const candidateOptionKeys = Object.freeze([
  "absoluteFailures",
  "dependencyInventory",
  "diagnostics",
  "evidenceStatus",
  "licenseInventory",
  "macosOwner",
  "matrixScores",
  "mechanism",
  "migration",
  "permissionMatrix",
  "physicalRepetitions",
  "removal",
  "windowsBoundary",
]);

export const evaluationProfile = Object.freeze({
  absoluteGates,
  checkpoints,
  evidenceFields,
  options: optionIds.map((id) => ({ id, profileId: PROFILE_ID })),
  permissionStates,
  profileId: PROFILE_ID,
  repetitions: 20,
});

const matrixWeights = Object.freeze({
  checkpointCoverage: 25,
  determinism: 20,
  packageIsolation: 20,
  permissionDiagnostics: 15,
  dependencyCost: 10,
  platformBoundary: 10,
});

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).toSorted(compareCodeUnits).join("\0") ===
      keys.toSorted(compareCodeUnits).join("\0")
  );
}

function hasExactValues(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function isScoreSet(value) {
  return (
    hasExactKeys(value, Object.keys(matrixWeights)) &&
    Object.values(value).every(
      (score) => Number.isInteger(score) && score >= 1 && score <= 5,
    )
  );
}

function hasUniqueStrings(value, { allowEmpty = true } = {}) {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0) &&
    new Set(value).size === value.length
  );
}

function hasOnlyKnownAbsoluteFailures(value) {
  return (
    hasUniqueStrings(value) &&
    value.every((failure) => absoluteGates.includes(failure))
  );
}

function physicalStateShapeValid(state) {
  return (
    hasExactKeys(state, [
      "boundedWaits",
      "checkpointPasses",
      "cleanupOwnedDescendants",
      "reasonCode",
      "repetitions",
      "status",
      "successfulRepetitions",
      "unexplainedFailures",
    ]) &&
    ["allowed", "denied", "revoked"].includes(state.status) &&
    Number.isInteger(state.repetitions) &&
    state.repetitions >= 0 &&
    Number.isInteger(state.successfulRepetitions) &&
    state.successfulRepetitions >= 0 &&
    Number.isInteger(state.checkpointPasses) &&
    state.checkpointPasses >= 0 &&
    typeof state.boundedWaits === "boolean" &&
    Number.isInteger(state.unexplainedFailures) &&
    state.unexplainedFailures >= 0 &&
    (state.reasonCode === null ||
      (typeof state.reasonCode === "string" && state.reasonCode.length > 0)) &&
    Number.isInteger(state.cleanupOwnedDescendants) &&
    state.cleanupOwnedDescendants >= 0
  );
}

function permissionMatrixShapeValid(matrix) {
  return (
    hasExactKeys(matrix, ["allowed", "denied", "recovered", "revoked"]) &&
    Object.values(matrix).every(physicalStateShapeValid)
  );
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function physicalStateComplete(state, expectedState, repetitions) {
  if (
    !hasExactKeys(state, [
      "boundedWaits",
      "checkpointPasses",
      "cleanupOwnedDescendants",
      "reasonCode",
      "repetitions",
      "status",
      "successfulRepetitions",
      "unexplainedFailures",
    ]) ||
    state.status !== expectedState ||
    state.repetitions !== repetitions ||
    state.boundedWaits !== true ||
    state.unexplainedFailures !== 0 ||
    state.cleanupOwnedDescendants !== 0
  )
    return false;
  return expectedState === "allowed"
    ? state.successfulRepetitions === repetitions &&
        state.checkpointPasses === repetitions * checkpoints.length &&
        state.reasonCode === null
    : state.successfulRepetitions === 0 &&
        state.checkpointPasses === 0 &&
        state.reasonCode === "accessibility-permission-denied";
}

function optionMatrixComplete(option) {
  return (
    hasExactKeys(option?.permissionMatrix, [
      "allowed",
      "denied",
      "recovered",
      "revoked",
    ]) &&
    physicalStateComplete(option.permissionMatrix.allowed, "allowed", 20) &&
    physicalStateComplete(option.permissionMatrix.denied, "denied", 1) &&
    physicalStateComplete(option.permissionMatrix.revoked, "revoked", 1) &&
    physicalStateComplete(option.permissionMatrix.recovered, "allowed", 1)
  );
}

function rejectedSystemEventsStateComplete(state, expectedState) {
  return (
    physicalStateShapeValid(state) &&
    state.status === expectedState &&
    state.repetitions === 0 &&
    state.successfulRepetitions === 0 &&
    state.checkpointPasses === 0 &&
    state.boundedWaits === true &&
    state.unexplainedFailures === 0 &&
    state.reasonCode === "authoritative-evidence-unavailable" &&
    state.cleanupOwnedDescendants === 0
  );
}

function systemEventsRejectionComplete(option) {
  return (
    hasExactValues(option?.absoluteFailures, [
      "authoritative-evidence-unavailable",
    ]) &&
    option.evidenceStatus === "complete" &&
    option.physicalRepetitions === 0 &&
    hasExactKeys(option.permissionMatrix, [
      "allowed",
      "denied",
      "recovered",
      "revoked",
    ]) &&
    rejectedSystemEventsStateComplete(
      option.permissionMatrix.allowed,
      "allowed",
    ) &&
    rejectedSystemEventsStateComplete(
      option.permissionMatrix.denied,
      "denied",
    ) &&
    rejectedSystemEventsStateComplete(
      option.permissionMatrix.revoked,
      "revoked",
    ) &&
    rejectedSystemEventsStateComplete(
      option.permissionMatrix.recovered,
      "allowed",
    )
  );
}

function noDriverStateComplete(state, expectedState, repetitions, reasonCode) {
  return (
    physicalStateShapeValid(state) &&
    state.status === expectedState &&
    state.repetitions === repetitions &&
    state.successfulRepetitions === 0 &&
    state.checkpointPasses === 0 &&
    state.boundedWaits === true &&
    state.unexplainedFailures === 0 &&
    state.reasonCode === reasonCode &&
    state.cleanupOwnedDescendants === 0
  );
}

function noDriverMatrixComplete(option) {
  return (
    hasExactKeys(option?.permissionMatrix, [
      "allowed",
      "denied",
      "recovered",
      "revoked",
    ]) &&
    noDriverStateComplete(
      option.permissionMatrix.allowed,
      "allowed",
      20,
      "missing-automatable-checkpoint",
    ) &&
    noDriverStateComplete(
      option.permissionMatrix.denied,
      "denied",
      1,
      "accessibility-permission-denied",
    ) &&
    noDriverStateComplete(
      option.permissionMatrix.revoked,
      "revoked",
      1,
      "accessibility-permission-denied",
    ) &&
    noDriverStateComplete(
      option.permissionMatrix.recovered,
      "allowed",
      1,
      "missing-automatable-checkpoint",
    )
  );
}

export function scoreOption(
  option,
  evidence,
  {
    foundationPackageAuthenticated = false,
    representativePackageAuthenticated = false,
  } = {},
) {
  const complete = optionMatrixComplete(option);
  const mechanism =
    typeof option?.mechanism === "string" ? option.mechanism : "";
  const noDriver =
    mechanism === "existing-packaged-shell-and-manual-observation";
  let permissionDiagnostics = 1;
  if (complete)
    permissionDiagnostics = mechanism.includes("system-events") ? 4 : 5;
  return {
    checkpointCoverage: complete ? 5 : 1,
    determinism: complete ? 5 : 1,
    packageIsolation:
      foundationPackageAuthenticated && representativePackageAuthenticated
        ? 5
        : 1,
    permissionDiagnostics,
    dependencyCost: mechanism.includes("system-events") || noDriver ? 5 : 4,
    platformBoundary:
      noDriver ||
      (typeof option?.windowsBoundary === "string" &&
        option.windowsBoundary.includes("separate"))
        ? 5
        : 1,
  };
}

function expectedCaptureRepetitions(candidate, phase) {
  if (candidate === "systemEvents") return 0;
  return phase === "allowed" ? 20 : 1;
}

function weightedScore(scores) {
  return Object.entries(matrixWeights).reduce(
    (total, [criterion, weight]) => total + scores[criterion] * weight,
    0,
  );
}

function bindingsValid(bindings) {
  return (
    hasExactKeys(bindings, bindingKeys) &&
    bindings.issue === 111 &&
    bindings.contractVersion === "v3" &&
    bindings.readinessFingerprint === READINESS_FINGERPRINT &&
    headPattern.test(bindings.frozenBaseHead) &&
    headPattern.test(bindings.evaluationHead) &&
    sha256BindingKeys.every((key) => sha256Pattern.test(bindings[key]))
  );
}

function commonProfileValid(profile) {
  return (
    hasExactKeys(profile, [
      "absoluteGates",
      "checkpoints",
      "evidenceFields",
      "permissionStates",
      "profileId",
      "repetitions",
    ]) &&
    profile.profileId === PROFILE_ID &&
    hasExactValues(profile.checkpoints, checkpoints) &&
    hasExactValues(profile.permissionStates, permissionStates) &&
    hasExactValues(profile.absoluteGates, absoluteGates) &&
    hasExactValues(profile.evidenceFields, evidenceFields) &&
    profile.repetitions === 20
  );
}

function authorityValid(authority) {
  return (
    hasExactKeys(authority, [
      "architecture",
      "physicalAccessibility",
      "physicalRepetitions",
      "platform",
    ]) &&
    authority.platform === "macos" &&
    authority.architecture === "arm64" &&
    ["complete", "pending"].includes(authority.physicalAccessibility) &&
    Number.isInteger(authority.physicalRepetitions) &&
    authority.physicalRepetitions >= 0 &&
    authority.physicalRepetitions <= 40
  );
}

function packageBindingsValid(packageBindings) {
  const foundation = packageBindings?.foundation;
  const representative = packageBindings?.representative;
  return (
    hasExactKeys(packageBindings, ["foundation", "representative"]) &&
    hasExactKeys(foundation, [
      "bundleIdentifier",
      "evidenceProducer",
      "packageName",
      "selfAssertedExclusion",
      "status",
      "targetTriple",
    ]) &&
    ["complete", "pending"].includes(foundation.status) &&
    foundation.packageName === "keiko-native-desktop" &&
    foundation.bundleIdentifier === "dev.oscharko.keiko-native" &&
    foundation.targetTriple === "aarch64-apple-darwin" &&
    foundation.evidenceProducer === "acceptance:macos" &&
    typeof foundation.selfAssertedExclusion === "boolean" &&
    hasExactKeys(representative, [
      "bundleIdentifier",
      "evidenceProducer",
      "selfAssertedProductExclusion",
      "status",
    ]) &&
    ["complete", "pending"].includes(representative.status) &&
    representative.bundleIdentifier ===
      "dev.oscharko.keiko-native.evaluation.accessibility" &&
    representative.evidenceProducer === "evaluate:macos-accessibility-driver" &&
    typeof representative.selfAssertedProductExclusion === "boolean"
  );
}

function sourceValid(source, { api, component }) {
  return (
    hasExactKeys(source, [
      "api",
      "component",
      "distribution",
      "documentation",
      "licence",
      "privateApi",
      "publicApi",
    ]) &&
    source.api === api &&
    source.component === component &&
    typeof source.documentation === "string" &&
    source.documentation.startsWith("https://developer.apple.com/") &&
    source.publicApi === true &&
    source.privateApi === false &&
    typeof source.distribution === "string" &&
    source.distribution.length > 0 &&
    typeof source.licence === "string" &&
    source.licence.length > 0
  );
}

function sourcesValid(sources) {
  return (
    hasExactKeys(sources, ["axuielement", "systemEvents"]) &&
    sourceValid(sources.axuielement, {
      api: "AXUIElement",
      component: "macOS ApplicationServices framework",
    }) &&
    sourceValid(sources.systemEvents, {
      api: "System Events",
      component:
        "System Events.app through the documented AppleScript UI automation interface",
    })
  );
}

function commonOptionFieldsValid(option, keys, expectedMechanism) {
  return (
    hasExactKeys(option, keys) &&
    option.mechanism === expectedMechanism &&
    ["complete", "pending"].includes(option.evidenceStatus) &&
    hasOnlyKnownAbsoluteFailures(option.absoluteFailures) &&
    isScoreSet(option.matrixScores) &&
    Number.isInteger(option.physicalRepetitions) &&
    option.physicalRepetitions >= 0 &&
    option.physicalRepetitions <= 20 &&
    typeof option.diagnostics === "string" &&
    option.diagnostics.length > 0 &&
    hasUniqueStrings(option.dependencyInventory) &&
    hasUniqueStrings(option.licenseInventory) &&
    typeof option.macosOwner === "string" &&
    option.macosOwner.length > 0 &&
    typeof option.windowsBoundary === "string" &&
    option.windowsBoundary.length > 0 &&
    typeof option.migration === "string" &&
    option.migration.length > 0 &&
    typeof option.removal === "string" &&
    option.removal.length > 0
  );
}

function optionsValid(options) {
  return (
    hasExactKeys(options, optionIds) &&
    commonOptionFieldsValid(
      options.axuielement,
      candidateOptionKeys,
      "external-axuielement-adapter",
    ) &&
    permissionMatrixShapeValid(options.axuielement.permissionMatrix) &&
    commonOptionFieldsValid(
      options.systemEvents,
      candidateOptionKeys,
      "bounded-system-events-extension",
    ) &&
    permissionMatrixShapeValid(options.systemEvents.permissionMatrix) &&
    commonOptionFieldsValid(
      options.noDriver,
      candidateOptionKeys,
      "existing-packaged-shell-and-manual-observation",
    ) &&
    permissionMatrixShapeValid(options.noDriver.permissionMatrix)
  );
}

function commonEvidenceValid(evidence) {
  return (
    hasExactKeys(evidence, [
      "authority",
      "availableEvidence",
      "bindings",
      "commonProfile",
      "options",
      "packageBindings",
      "pendingEvidence",
      "profileId",
      "schemaVersion",
      "sources",
    ]) &&
    evidence.schemaVersion === EVIDENCE_SCHEMA_VERSION &&
    evidence.profileId === PROFILE_ID &&
    bindingsValid(evidence.bindings) &&
    commonProfileValid(evidence.commonProfile) &&
    authorityValid(evidence.authority) &&
    packageBindingsValid(evidence.packageBindings) &&
    sourcesValid(evidence.sources) &&
    optionsValid(evidence.options) &&
    hasUniqueStrings(evidence.availableEvidence, { allowEmpty: false }) &&
    hasUniqueStrings(evidence.pendingEvidence)
  );
}

function scoreSetsEqual(left, right) {
  return (
    isScoreSet(left) &&
    isScoreSet(right) &&
    Object.keys(matrixWeights).every(
      (criterion) => left[criterion] === right[criterion],
    )
  );
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseRetainedArtifacts(retainedArtifacts) {
  if (!hasExactKeys(retainedArtifacts, retainedArtifactIds)) return null;
  const parsed = {};
  for (const id of retainedArtifactIds) {
    const raw = retainedArtifacts[id];
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      Buffer.byteLength(raw, "utf8") > MAX_RETAINED_ARTIFACT_BYTES
    )
      return null;
    try {
      parsed[id] = { raw, value: JSON.parse(raw) };
    } catch {
      return null;
    }
  }
  return parsed;
}

function preparedArtifactValid(prepared, evidence, currentSourceDigest) {
  return (
    hasExactKeys(prepared, [
      "bundleIdentifier",
      "candidateDigests",
      "representativeInspection",
      "representativePackageSha256",
      "schemaVersion",
      "sourceDigest",
      "sourceHead",
    ]) &&
    prepared.schemaVersion ===
      "keiko-native-macos-accessibility-driver-prepared/v1" &&
    prepared.sourceHead === evidence.bindings.evaluationHead &&
    prepared.sourceDigest === currentSourceDigest &&
    prepared.sourceDigest === evidence.bindings.evaluationSourceSha256 &&
    prepared.bundleIdentifier ===
      "dev.oscharko.keiko-native.evaluation.accessibility" &&
    prepared.representativePackageSha256 ===
      evidence.bindings.representativePackageSha256 &&
    representativeInspectionValid(prepared.representativeInspection) &&
    hasExactKeys(prepared.candidateDigests, candidateIds) &&
    prepared.candidateDigests.axuielement ===
      evidence.bindings.axuielementCandidateSha256 &&
    prepared.candidateDigests.systemEvents ===
      evidence.bindings.systemEventsCandidateSha256
  );
}

function timingEntryValid(entry, expectedRepetition, expectedCheckpoints) {
  if (
    !hasExactKeys(entry, ["checkpoints", "elapsedMs", "repetition"]) ||
    entry.repetition !== expectedRepetition ||
    !Number.isInteger(entry.elapsedMs) ||
    entry.elapsedMs < 0 ||
    entry.elapsedMs > MAX_RUN_ELAPSED_MS ||
    !Array.isArray(entry.checkpoints) ||
    entry.checkpoints.length !== (expectedCheckpoints ? checkpoints.length : 0)
  )
    return false;
  const checkpointsValid = entry.checkpoints.every(
    (checkpoint, index) =>
      hasExactKeys(checkpoint, ["checkpoint", "elapsedMs", "status"]) &&
      checkpoint.checkpoint === checkpoints[index] &&
      Number.isInteger(checkpoint.elapsedMs) &&
      checkpoint.elapsedMs >= 0 &&
      checkpoint.elapsedMs <= MAX_CHECKPOINT_ELAPSED_MS &&
      checkpoint.status === "passed",
  );
  return (
    checkpointsValid &&
    entry.checkpoints.reduce(
      (total, checkpoint) => total + checkpoint.elapsedMs,
      0,
    ) <= entry.elapsedMs
  );
}

function captureArtifactValid(capture, expectedPhase, prepared, evidence) {
  if (
    !hasExactKeys(capture, [
      "options",
      "phase",
      "prepared",
      "schemaVersion",
      "timings",
    ]) ||
    capture.schemaVersion !==
      "keiko-native-macos-accessibility-driver-capture/v1" ||
    capture.phase !== expectedPhase ||
    !jsonEqual(capture.prepared, prepared) ||
    !hasExactKeys(capture.options, candidateIds) ||
    !hasExactKeys(capture.timings, candidateIds)
  )
    return false;
  const matrixKey = expectedPhase;
  return candidateIds.every((candidate) => {
    const rejected = candidate === "systemEvents";
    const expectedRepetitions = expectedCaptureRepetitions(
      candidate,
      expectedPhase,
    );
    const aggregate = capture.options[candidate];
    const retainedAggregate =
      evidence.options[candidate].permissionMatrix[matrixKey];
    const timings = capture.timings[candidate];
    const expectedCheckpoints =
      !rejected &&
      (expectedPhase === "allowed" || expectedPhase === "recovered");
    const timingShapeValid =
      Array.isArray(timings) &&
      timings.length === expectedRepetitions &&
      timings.every((timing, index) =>
        timingEntryValid(timing, index + 1, expectedCheckpoints),
      );
    const derivedCheckpointPasses = timingShapeValid
      ? timings.reduce((total, timing) => total + timing.checkpoints.length, 0)
      : -1;
    const derivedSuccessfulRepetitions = timingShapeValid
      ? timings.filter(
          (timing) =>
            expectedCheckpoints &&
            timing.checkpoints.length === checkpoints.length,
        ).length
      : -1;
    return (
      physicalStateShapeValid(aggregate) &&
      aggregate.repetitions === expectedRepetitions &&
      jsonEqual(aggregate, retainedAggregate) &&
      timingShapeValid &&
      aggregate.checkpointPasses === derivedCheckpointPasses &&
      aggregate.successfulRepetitions === derivedSuccessfulRepetitions
    );
  });
}

function authenticateRetainedArtifacts({
  currentSourceDigest,
  evidence,
  retainedArtifacts,
}) {
  if (
    !sha256Pattern.test(currentSourceDigest) ||
    currentSourceDigest !== evidence.bindings.evaluationSourceSha256
  )
    return null;
  const parsed = parseRetainedArtifacts(retainedArtifacts);
  if (parsed === null) return null;
  const digestBindings = {
    prepared: "preparedEvidenceSha256",
    allowed: "allowedCaptureSha256",
    denied: "deniedCaptureSha256",
    revoked: "revokedCaptureSha256",
    recovered: "recoveredCaptureSha256",
  };
  if (
    retainedArtifactIds.some(
      (id) => sha256(parsed[id].raw) !== evidence.bindings[digestBindings[id]],
    )
  )
    return null;
  const prepared = parsed.prepared.value;
  return preparedArtifactValid(prepared, evidence, currentSourceDigest) &&
    captureArtifactIds.every((phase) =>
      captureArtifactValid(parsed[phase].value, phase, prepared, evidence),
    )
    ? parsed
    : null;
}

function invalid(reasonCode) {
  return {
    exitCode: 2,
    output: {
      schemaVersion: SCHEMA_VERSION,
      status: "invalid",
      decision: "pending",
      reasonCode,
    },
  };
}

export function evaluateMacosAccessibilityDriver({
  args,
  currentSourceDigest,
  evidence,
  foundationPackageAttestation,
  retainedArtifacts,
}) {
  if (!Array.isArray(args) || args.length !== 0)
    return invalid("invalid-command");
  if (!commonEvidenceValid(evidence))
    return invalid("evaluation-evidence-invalid");
  const authenticatedRetainedArtifacts = authenticateRetainedArtifacts({
    currentSourceDigest,
    evidence,
    retainedArtifacts,
  });
  if (authenticatedRetainedArtifacts === null)
    return invalid("evaluation-evidence-invalid");
  const foundationPackageAuthenticated =
    isAuthenticatedFoundationPackage(foundationPackageAttestation) &&
    foundationPackageAttestation.sourceRevision ===
      evidence.bindings.evaluationHead &&
    foundationPackageAttestation.packageManifestSha256 ===
      evidence.bindings.foundationPackageSha256;
  const representativePackageAuthenticated = representativeInspectionValid(
    authenticatedRetainedArtifacts.prepared.value.representativeInspection,
  );

  const fixedScores = Object.fromEntries(
    optionIds.map((id) => [
      id,
      scoreOption(evidence.options[id], evidence, {
        foundationPackageAuthenticated,
        representativePackageAuthenticated,
      }),
    ]),
  );
  if (
    optionIds.some(
      (id) =>
        !scoreSetsEqual(evidence.options[id].matrixScores, fixedScores[id]),
    )
  )
    return invalid("evaluation-evidence-invalid");

  const complete =
    evidence.pendingEvidence.length === 0 &&
    foundationPackageAuthenticated &&
    representativePackageAuthenticated &&
    evidence.authority.physicalAccessibility === "complete" &&
    evidence.authority.physicalRepetitions === 20 &&
    evidence.packageBindings.foundation.status === "complete" &&
    evidence.packageBindings.representative.status === "complete" &&
    evidence.options.axuielement.evidenceStatus === "complete" &&
    evidence.options.axuielement.physicalRepetitions === 20 &&
    optionMatrixComplete(evidence.options.axuielement) &&
    systemEventsRejectionComplete(evidence.options.systemEvents) &&
    evidence.options.noDriver.evidenceStatus === "complete" &&
    evidence.options.noDriver.physicalRepetitions === 20 &&
    noDriverMatrixComplete(evidence.options.noDriver) &&
    hasExactValues(evidence.options.noDriver.absoluteFailures, [
      "missing-automatable-checkpoint",
    ]);
  if (!complete) {
    return {
      exitCode: 3,
      output: {
        schemaVersion: SCHEMA_VERSION,
        profileId: PROFILE_ID,
        status: "incomplete",
        decision: "pending",
        recommendation: null,
        reasonCode: "physical-matrix-incomplete",
        selectedOption: null,
        pendingOptions: [
          ...(optionMatrixComplete(evidence.options.axuielement)
            ? []
            : ["axuielement"]),
          ...(systemEventsRejectionComplete(evidence.options.systemEvents)
            ? []
            : ["systemEvents"]),
          ...(noDriverMatrixComplete(evidence.options.noDriver)
            ? []
            : ["noDriver"]),
        ],
        pendingEvidence: [...evidence.pendingEvidence],
      },
    };
  }

  const weightedScores = Object.fromEntries(
    optionIds.map((id) => [id, weightedScore(fixedScores[id])]),
  );
  const eligible = candidateIds
    .filter((id) => evidence.options[id].absoluteFailures.length === 0)
    .toSorted(
      (left, right) =>
        weightedScores[right] - weightedScores[left] ||
        candidateIds.indexOf(left) - candidateIds.indexOf(right),
    );
  if (eligible.length === 0)
    return invalid("no-candidate-passed-absolute-gates");
  const selectedOption = eligible[0];
  return {
    exitCode: 0,
    output: {
      schemaVersion: SCHEMA_VERSION,
      profileId: PROFILE_ID,
      status: "complete",
      decision: "select",
      recommendation: evidence.options[selectedOption].mechanism,
      selectedOption,
      weightedScores,
      absoluteFailures: Object.fromEntries(
        optionIds.map((id) => [id, evidence.options[id].absoluteFailures]),
      ),
    },
  };
}
