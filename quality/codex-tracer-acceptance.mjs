import { checkpointBehaviorContract } from "./macos-accessibility-driver-harness.mjs";
import { redactionMatches } from "./native-contract.mjs";

const SCHEMA_VERSION = "keiko-native-codex-tracer-acceptance/v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;

export const acceptanceIdentityContract = Object.freeze({
  authProfileClass: "human-provisioned-chatgpt-keyring",
  authorityProfile: "keiko-codex-no-effect-v1",
  containmentProfile: "keiko-codex-readiness-v1",
  experimentalSchemaSha256:
    "46c4414f08cdbb20e66ce4153ee1edcb865ed5fda67e59511a78939ddb7a82d1",
  issueReadinessFingerprint:
    "54a50110230af03db88acc3d503f038cb2e4a9557094fcff48ab19c01ee0af24",
  parentReadinessFingerprint:
    "ff404fd8d0f7b336b997da77e55c5a5abc8c8cab1639b8e708f0b5792c283347",
  promptSha256:
    "e1a92579b1ca673135331829beb97792c1289a6bccdfe0303302256c546960f6",
  runtimeArtifactSha256:
    "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
  runtimePackage: "@openai/codex",
  runtimeVersion: "0.145.0",
  stableSchemaSha256:
    "27fc5257cdd29b97b2abb064caadec32a72b7567d6df26a7f82c5f452c8bdfb9",
});

export const acceptanceJourneyContract = Object.freeze({
  automationMechanism: "AXUIElement",
  checkpointResults: Object.freeze(
    Object.keys(checkpointBehaviorContract).map((checkpoint) =>
      Object.freeze({ checkpoint, status: "passed" }),
    ),
  ),
  manualOnlyAutomatableCheckpoints: 0,
  mockOnlyClaims: 0,
  scenarios: Object.freeze([
    "workspace-selection",
    "workspace-picker-cancellation",
    "workspace-permission-denial",
    "runtime-readiness",
    "turn-streaming-completion",
    "turn-cancellation",
    "runtime-crash-recovery",
    "application-quit",
  ]),
});

export const acceptanceBudgetLimits = Object.freeze({
  firstVisibleKeikoOverheadSamples: 20,
  frameMaxBytes: 1_048_576,
  localProjectionSamples: 5,
  providerLatencyExcluded: true,
  queueMaxBytes: 4_194_304,
  queueMaxFrames: 256,
  taskBytes: 182,
  taskMaxBytes: 4_096,
  taskMinBytes: 1,
  turnDeadlineMs: 120_000,
});

export const acceptanceSafeguardContract = Object.freeze({
  acceptedEffects: 0,
  configurableMultiAgentCapabilities: 0,
  environmentTools: 0,
  hiddenRetries: 0,
  inputRequestCapabilities: 0,
  localToolRequests: 0,
  manualOnlyAutomatableCheckpoints: 0,
  missingJourneyRows: 0,
  mockOnlyClaims: 0,
  packageTestHooks: 0,
  providerEffectOwnerCrossings: 0,
  providerEventQuarantineMaximum: 64,
  redactionMatches: 0,
  repositoryBytesInEvidence: 0,
  repositoryContextBytesToRuntime: 0,
  residualProcesses: 0,
  unquarantinedProviderEvents: 0,
});

export const acceptancePackageInspectionContract = Object.freeze({
  adapterCodePresent: false,
  policyFailures: 0,
  productionModules: "exact-packaged-modules",
  testHookMarkers: 0,
  unexpectedFiles: 0,
});

export const acceptancePhysicalContract = Object.freeze({
  appearance: Object.freeze({
    dark: "observed",
    increaseContrast: "observed",
    light: "observed",
    reduceMotion: "not-applicable-no-nonessential-motion",
  }),
  irreducibleObservations: Object.freeze([
    "keyboard-focus",
    "voiceover-semantics",
    "streaming-readability",
    "appearance-light",
    "appearance-dark",
    "appearance-increase-contrast",
    "reduce-motion-applicability",
    "readable-scaling",
    "unicode-ime",
    "folder-permission",
    "cancellation",
    "crash-recovery",
    "zero-residual-processes",
  ]),
  observationMode: "physical-packaged-macos",
  platform: "macos-arm64",
});

const budgetMeasurementLimits = Object.freeze({
  cancellationProjectionMs: 100,
  cleanupMs: 5_000,
  firstVisibleKeikoOverheadP95Ms: 2_000,
  localProjectionP95Ms: 100,
  turnDurationMs: 120_000,
});

const identityBindingKeys = Object.freeze(
  [
    ...Object.keys(acceptanceIdentityContract),
    "packageExecutableSha256",
    "packageManifestSha256",
    "sourceRevision",
  ].toSorted(),
);

export function identityBindingFailures(bindings, expected) {
  const failures = [];
  if (
    typeof bindings !== "object" ||
    bindings === null ||
    Array.isArray(bindings) ||
    JSON.stringify(Object.keys(bindings).toSorted()) !==
      JSON.stringify(identityBindingKeys)
  ) {
    failures.push("identity-fields");
  }
  for (const [key, value] of Object.entries(acceptanceIdentityContract)) {
    if (bindings?.[key] !== value) failures.push(`identity-${key}`);
  }
  if (!REVISION_PATTERN.test(bindings?.sourceRevision ?? ""))
    failures.push("identity-source-revision");
  if (bindings?.sourceRevision !== expected?.sourceRevision)
    failures.push("identity-source-revision-binding");
  for (const key of ["packageExecutableSha256", "packageManifestSha256"]) {
    if (!SHA256_PATTERN.test(bindings?.[key] ?? ""))
      failures.push(`identity-${key}`);
    if (bindings?.[key] !== expected?.[key])
      failures.push(`identity-${key}-binding`);
  }
  return failures;
}

export function journeyEvidenceFailures(journey) {
  const failures = [];
  if (
    typeof journey !== "object" ||
    journey === null ||
    Array.isArray(journey) ||
    JSON.stringify(Object.keys(journey).toSorted()) !==
      JSON.stringify(Object.keys(acceptanceJourneyContract).toSorted())
  ) {
    failures.push("journey-fields");
  }
  for (const key of Object.keys(acceptanceJourneyContract)) {
    if (
      JSON.stringify(journey?.[key]) !==
      JSON.stringify(acceptanceJourneyContract[key])
    ) {
      failures.push(`journey-${key}`);
    }
  }
  return failures;
}

export function budgetEvidenceFailures(budgets) {
  const failures = [];
  const expectedKeys = [
    ...Object.keys(acceptanceBudgetLimits),
    ...Object.keys(budgetMeasurementLimits),
  ].toSorted();
  if (
    typeof budgets !== "object" ||
    budgets === null ||
    Array.isArray(budgets) ||
    JSON.stringify(Object.keys(budgets).toSorted()) !==
      JSON.stringify(expectedKeys)
  ) {
    failures.push("budget-fields");
  }
  for (const [key, value] of Object.entries(acceptanceBudgetLimits)) {
    if (budgets?.[key] !== value) failures.push(`budget-${key}`);
  }
  for (const [key, maximum] of Object.entries(budgetMeasurementLimits)) {
    const observed = budgets?.[key];
    if (!Number.isSafeInteger(observed) || observed < 0 || observed > maximum) {
      failures.push(`budget-${key}`);
    }
  }
  return failures;
}

export function safeguardEvidenceFailures(safeguards) {
  const failures = [];
  const expectedKeys = Object.keys(acceptanceSafeguardContract).toSorted();
  if (
    typeof safeguards !== "object" ||
    safeguards === null ||
    Array.isArray(safeguards) ||
    JSON.stringify(Object.keys(safeguards).toSorted()) !==
      JSON.stringify(expectedKeys)
  ) {
    failures.push("safeguard-fields");
  }
  for (const [key, value] of Object.entries(acceptanceSafeguardContract)) {
    if (safeguards?.[key] !== value) failures.push(`safeguard-${key}`);
  }
  return failures;
}

function packageInspectionFailures(inspection) {
  const failures = [];
  if (
    typeof inspection !== "object" ||
    inspection === null ||
    Array.isArray(inspection) ||
    JSON.stringify(Object.keys(inspection).toSorted()) !==
      JSON.stringify(
        Object.keys(acceptancePackageInspectionContract).toSorted(),
      )
  ) {
    failures.push("package-inspection-fields");
  }
  for (const [key, value] of Object.entries(
    acceptancePackageInspectionContract,
  )) {
    if (inspection?.[key] !== value) failures.push(`package-inspection-${key}`);
  }
  return failures;
}

function physicalEvidenceFailures(physical, expected) {
  const failures = [];
  const expectedKeys = [
    ...Object.keys(acceptancePhysicalContract),
    "packageExecutableSha256",
    "runner",
  ].toSorted();
  if (
    typeof physical !== "object" ||
    physical === null ||
    Array.isArray(physical) ||
    JSON.stringify(Object.keys(physical).toSorted()) !==
      JSON.stringify(expectedKeys)
  ) {
    failures.push("physical-fields");
  }
  for (const [key, value] of Object.entries(acceptancePhysicalContract)) {
    if (JSON.stringify(physical?.[key]) !== JSON.stringify(value))
      failures.push(`physical-${key}`);
  }
  if (physical?.packageExecutableSha256 !== expected?.packageExecutableSha256) {
    failures.push("physical-package-binding");
  }
  if (
    !/^(?:local-macos|macos(?:14|26)-[A-Za-z0-9._-]+)$/u.test(
      physical?.runner ?? "",
    )
  ) {
    failures.push("physical-runner");
  }
  return failures;
}

export function acceptanceEvidenceFailures(evidence, expected) {
  const failures = [];
  const expectedKeys = [
    "bindings",
    "budgets",
    "journey",
    "packageInspection",
    "physical",
    "redaction",
    "safeguards",
    "schemaVersion",
    "status",
  ].toSorted();
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    Array.isArray(evidence) ||
    JSON.stringify(Object.keys(evidence).toSorted()) !==
      JSON.stringify(expectedKeys)
  ) {
    failures.push("evidence-fields");
  }
  if (evidence?.schemaVersion !== SCHEMA_VERSION)
    failures.push("evidence-schema");
  if (evidence?.status !== "complete") failures.push("evidence-status");
  if (evidence?.redaction !== "closed") failures.push("evidence-redaction");
  failures.push(...identityBindingFailures(evidence?.bindings, expected));
  failures.push(...budgetEvidenceFailures(evidence?.budgets));
  failures.push(...journeyEvidenceFailures(evidence?.journey));
  failures.push(...packageInspectionFailures(evidence?.packageInspection));
  failures.push(...physicalEvidenceFailures(evidence?.physical, expected));
  failures.push(...safeguardEvidenceFailures(evidence?.safeguards));
  if (redactionMatches(JSON.stringify(evidence)).length > 0)
    failures.push("evidence-sensitive-content");
  return failures;
}

function closedRejection(reasonCode) {
  return {
    exitCode: 2,
    output: {
      schemaVersion: SCHEMA_VERSION,
      reasonCode,
      status: "rejected",
    },
  };
}

export async function runCodexTracerAcceptance({ args, io }) {
  const invalid = validateAcceptanceInvocation(args);
  if (invalid !== null) return invalid;
  let prepared;
  let cleanupAttempted = false;
  try {
    prepared = await io.preparePackage();
    const production = await io.runProductionJourney(prepared);
    const physical = await io.runPhysicalJourney(prepared);
    const evidence = {
      bindings: prepared.bindings,
      budgets: physical.budgets,
      journey: physical.journey,
      packageInspection: prepared.packageInspection,
      physical: physical.physical,
      redaction: "closed",
      safeguards: { ...production.safeguards, ...physical.safeguards },
      schemaVersion: SCHEMA_VERSION,
      status: "complete",
    };
    cleanupAttempted = true;
    await io.cleanup(prepared);
    if (acceptanceEvidenceFailures(evidence, prepared.expected).length > 0)
      return closedRejection("acceptance-evidence-invalid");
    await io.writeEvidence(evidence, prepared);
    return { exitCode: 0, output: evidence };
  } catch {
    if (prepared !== undefined && !cleanupAttempted) {
      try {
        cleanupAttempted = true;
        await io.cleanup(prepared);
      } catch {
        return closedRejection("acceptance-check-failed");
      }
    }
    return closedRejection("acceptance-check-failed");
  }
}

export function validateAcceptanceInvocation(args) {
  if (Array.isArray(args) && args.length === 0) return null;

  return closedRejection("invalid-command");
}
