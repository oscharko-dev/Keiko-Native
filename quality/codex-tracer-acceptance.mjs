import { checkpointBehaviorContract } from "./macos-accessibility-driver-harness.mjs";
import { percentile95 } from "./codex-tracer-accessibility.mjs";
import { compareCodeUnits } from "./deterministic-order.mjs";
import { redactionMatches } from "./native-contract.mjs";

const SCHEMA_VERSION = "keiko-native-codex-tracer-acceptance/v2";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;

export const acceptanceIdentityContract = Object.freeze({
  authProfileClass: "human-provisioned-chatgpt-keyring",
  authorityProfile: "keiko-codex-no-effect-v1",
  containmentProfile: "keiko-codex-readiness-v1",
  experimentalSchemaSha256:
    "46c4414f08cdbb20e66ce4153ee1edcb865ed5fda67e59511a78939ddb7a82d1",
  issueReadinessFingerprint:
    "1a0be864b3855b81c649c5843e936828ebaeb27477463ccf0af86f9da61d3391",
  parentReadinessFingerprint:
    "261b5711a21e76f79987d955960a7c7fbf46561c8ff34188ed38f54eec19d7b5",
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
  localProjectionSamples: 4,
  nativePickerCancellationSamples: 20,
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
  cleanupMs: 5_000,
  firstVisibleKeikoOverheadP95Ms: 2_000,
  localProjectionP95Ms: 100,
  nativePickerCancellationP95Ms: 750,
  turnCancellationProjectionMs: 100,
  turnDurationMs: 120_000,
  workspaceSelectionNativeActionMs: 5_000,
});

const localProjectionContract = Object.freeze([
  Object.freeze({ action: "open-canvas", observation: "probe-canvas" }),
  Object.freeze({
    action: "select-workspace",
    observation: "observe-workspace-permission-denied",
  }),
  Object.freeze({
    action: "select-workspace",
    observation: "observe-workspace-selected",
  }),
  Object.freeze({ action: "cancel-turn", observation: "observe-stopping" }),
]);

const referenceEnvironmentContract = Object.freeze({
  display: "built-in-main-3024x1964-120hz",
  hardware: "apple-m4-16-gib-mac16-1",
  operatingSystem: "macos-26.5.1-25f80",
  referenceClass: "owner-m4-16gib-macos26",
  scaling: "logical-1512x982-2x-default",
  thermal: "nominal",
});
const acceptedPowerConditions = new Set([
  "ac-power-standard",
  "battery-power-standard",
]);

const identityBindingKeys = Object.freeze(
  [
    ...Object.keys(acceptanceIdentityContract),
    "packageExecutableSha256",
    "packageManifestSha256",
    "sourceRevision",
  ].toSorted(compareCodeUnits),
);

export function identityBindingFailures(bindings, expected) {
  const failures = [];
  if (
    typeof bindings !== "object" ||
    bindings === null ||
    Array.isArray(bindings) ||
    JSON.stringify(Object.keys(bindings).toSorted(compareCodeUnits)) !==
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
    JSON.stringify(Object.keys(journey).toSorted(compareCodeUnits)) !==
      JSON.stringify(
        Object.keys(acceptanceJourneyContract).toSorted(compareCodeUnits),
      )
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
    "localProjectionMeasurements",
    "nativePickerCancellationMeasurements",
  ].toSorted(compareCodeUnits);
  if (
    typeof budgets !== "object" ||
    budgets === null ||
    Array.isArray(budgets) ||
    JSON.stringify(Object.keys(budgets).toSorted(compareCodeUnits)) !==
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
  failures.push(
    ...localProjectionMeasurementFailures(
      budgets?.localProjectionMeasurements,
      budgets?.localProjectionP95Ms,
    ),
    ...nativePickerMeasurementFailures(
      budgets?.nativePickerCancellationMeasurements,
      budgets?.nativePickerCancellationP95Ms,
    ),
  );
  return failures;
}

function localProjectionMeasurementFailures(measurements, reportedP95Ms) {
  const failures = [];
  if (
    !Array.isArray(measurements) ||
    measurements.length !== acceptanceBudgetLimits.localProjectionSamples
  ) {
    return ["budget-local-projection-measurements"];
  }
  for (const [index, measurement] of measurements.entries()) {
    const expected = localProjectionContract[index];
    if (
      typeof measurement !== "object" ||
      measurement === null ||
      Array.isArray(measurement) ||
      JSON.stringify(Object.keys(measurement).toSorted(compareCodeUnits)) !==
        JSON.stringify(["action", "observation", "projectedMs"]) ||
      measurement.action !== expected?.action ||
      measurement.observation !== expected?.observation ||
      !Number.isSafeInteger(measurement.projectedMs) ||
      measurement.projectedMs < 0 ||
      measurement.projectedMs > budgetMeasurementLimits.localProjectionP95Ms
    ) {
      failures.push("budget-local-projection-measurements");
      break;
    }
  }
  if (
    failures.length === 0 &&
    percentile95(measurements.map(({ projectedMs }) => projectedMs)) !==
      reportedP95Ms
  ) {
    failures.push("budget-local-projection-p95-consistency");
  }
  return failures;
}

function nativePickerMeasurementFailures(measurements, reportedP95Ms) {
  const failures = [];
  if (
    !Array.isArray(measurements) ||
    measurements.length !==
      acceptanceBudgetLimits.nativePickerCancellationSamples
  ) {
    failures.push("budget-native-picker-measurements");
  } else {
    for (const [index, measurement] of measurements.entries()) {
      if (
        typeof measurement !== "object" ||
        measurement === null ||
        Array.isArray(measurement) ||
        JSON.stringify(Object.keys(measurement).toSorted(compareCodeUnits)) !==
          JSON.stringify(["launch", "projectedMs"]) ||
        measurement.launch !== index + 1 ||
        !Number.isSafeInteger(measurement.projectedMs) ||
        measurement.projectedMs < 0 ||
        measurement.projectedMs > 5_000
      ) {
        failures.push("budget-native-picker-measurements");
        break;
      }
    }
    if (
      failures.length === 0 &&
      percentile95(measurements.map(({ projectedMs }) => projectedMs)) !==
        reportedP95Ms
    ) {
      failures.push("budget-native-picker-p95-consistency");
    }
  }
  return failures;
}

export function referenceEnvironmentFailures(environment) {
  const failures = [];
  const expectedKeys = [
    ...Object.keys(referenceEnvironmentContract),
    "power",
  ].toSorted(compareCodeUnits);
  if (
    typeof environment !== "object" ||
    environment === null ||
    Array.isArray(environment) ||
    JSON.stringify(Object.keys(environment).toSorted(compareCodeUnits)) !==
      JSON.stringify(expectedKeys)
  ) {
    failures.push("reference-environment-fields");
  }
  for (const [key, value] of Object.entries(referenceEnvironmentContract)) {
    if (environment?.[key] !== value)
      failures.push(`reference-environment-${key}`);
  }
  if (!acceptedPowerConditions.has(environment?.power))
    failures.push("reference-environment-power");
  return failures;
}

export function safeguardEvidenceFailures(safeguards) {
  const failures = [];
  const expectedKeys = Object.keys(acceptanceSafeguardContract).toSorted(
    compareCodeUnits,
  );
  if (
    typeof safeguards !== "object" ||
    safeguards === null ||
    Array.isArray(safeguards) ||
    JSON.stringify(Object.keys(safeguards).toSorted(compareCodeUnits)) !==
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
    JSON.stringify(Object.keys(inspection).toSorted(compareCodeUnits)) !==
      JSON.stringify(
        Object.keys(acceptancePackageInspectionContract).toSorted(
          compareCodeUnits,
        ),
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
  ].toSorted(compareCodeUnits);
  if (
    typeof physical !== "object" ||
    physical === null ||
    Array.isArray(physical) ||
    JSON.stringify(Object.keys(physical).toSorted(compareCodeUnits)) !==
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
    "referenceEnvironment",
    "safeguards",
    "schemaVersion",
    "status",
  ].toSorted(compareCodeUnits);
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    Array.isArray(evidence) ||
    JSON.stringify(Object.keys(evidence).toSorted(compareCodeUnits)) !==
      JSON.stringify(expectedKeys)
  ) {
    failures.push("evidence-fields");
  }
  if (evidence?.schemaVersion !== SCHEMA_VERSION)
    failures.push("evidence-schema");
  if (evidence?.status !== "complete") failures.push("evidence-status");
  if (evidence?.redaction !== "closed") failures.push("evidence-redaction");
  failures.push(
    ...identityBindingFailures(evidence?.bindings, expected),
    ...budgetEvidenceFailures(evidence?.budgets),
    ...journeyEvidenceFailures(evidence?.journey),
    ...packageInspectionFailures(evidence?.packageInspection),
    ...physicalEvidenceFailures(evidence?.physical, expected),
    ...referenceEnvironmentFailures(evidence?.referenceEnvironment),
    ...safeguardEvidenceFailures(evidence?.safeguards),
  );
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
    const physical = await io.runPhysicalJourney(prepared, production);
    const evidence = {
      bindings: prepared.bindings,
      budgets: physical.budgets,
      journey: physical.journey,
      packageInspection: prepared.packageInspection,
      physical: physical.physical,
      redaction: "closed",
      referenceEnvironment: physical.referenceEnvironment,
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
