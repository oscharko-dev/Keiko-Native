import { checkpointBehaviorContract } from "./macos-accessibility-driver-harness.mjs";
import { percentile95 } from "./codex-tracer-accessibility.mjs";
import { compareCodeUnits } from "./deterministic-order.mjs";
import { redactionMatches } from "./native-contract.mjs";

const SCHEMA_VERSION = "keiko-native-codex-tracer-acceptance/v2";
const WORKSPACE_SCHEMA_VERSION =
  "keiko-native-codex-tracer-workspace-acceptance/v1";
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
    "12ed4a0225fdf1fac2a75731fdbb25e949cf61349cc0a7ab7d8bad09c0eab7a3",
  promptSha256:
    "e1a92579b1ca673135331829beb97792c1289a6bccdfe0303302256c546960f6",
  runtimeArtifactSha256:
    "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
  runtimePackage: "@openai/codex",
  runtimeVersion: "0.145.0",
  stableSchemaSha256:
    "27fc5257cdd29b97b2abb064caadec32a72b7567d6df26a7f82c5f452c8bdfb9",
});

export const workspaceAcceptanceIdentityContract = Object.freeze({
  acceptanceContract: "keiko-native-workspace-projection/v1",
  issueNumber: "187",
  parentIssueNumber: "98",
});

export const workspaceAcceptanceBudgetLimits = Object.freeze({
  cleanupMaxMs: 5_000,
  nativePickerCancellationP95MaxMs: 750,
  nativePickerCancellationSamples: 20,
  workspaceProjectionP95MaxMs: 100,
  workspaceProjectionSamples: 4,
  workspaceSelectionNativeActionMaxMs: 5_000,
});

export const workspaceAcceptanceJourneyContract = Object.freeze({
  automationMechanism: "AXUIElement",
  checkpointResults: Object.freeze(
    [
      "application-launch",
      "canvas-presentation",
      "workspace-picker-open",
      "workspace-picker-cancellation",
      "workspace-permission-denial",
      "workspace-selection",
      "application-quit",
    ].map((checkpoint) => Object.freeze({ checkpoint, status: "passed" })),
  ),
  manualOnlyAutomatableCheckpoints: 0,
  mockOnlyClaims: 0,
  scenarios: Object.freeze([
    "workspace-selection",
    "workspace-picker-cancellation",
    "workspace-permission-denial",
    "application-quit",
  ]),
});

export const workspaceAcceptanceSafeguardContract = Object.freeze({
  hiddenRetries: 0,
  manualOnlyAutomatableCheckpoints: 0,
  mockOnlyClaims: 0,
  packageTestHooks: 0,
  rawPathBytesInEvidence: 0,
  redactionMatches: 0,
  repositoryBytesInEvidence: 0,
  repositoryContextBytesToRuntime: 0,
  residualProcesses: 0,
  unexpectedWorkspaceMutations: 0,
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
  operatingSystem: "macos-26.5.2-25f84",
  referenceClass: "owner-m4-16gib-macos26",
  scaling: "logical-1512x982-2x-default",
  thermal: "nominal",
});
const acceptedPowerConditions = new Set(["ac-power-standard"]);

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

function exactContractFailures(value, contract, prefix) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).toSorted(compareCodeUnits)) !==
      JSON.stringify(Object.keys(contract).toSorted(compareCodeUnits))
  ) {
    return [`${prefix}-fields`];
  }
  return Object.entries(contract)
    .filter(
      ([key, expected]) =>
        JSON.stringify(value[key]) !== JSON.stringify(expected),
    )
    .map(([key]) => `${prefix}-${key}`);
}

function workspaceIdentityFailures(bindings, expected) {
  const contract = {
    ...workspaceAcceptanceIdentityContract,
    packageExecutableSha256: expected?.packageExecutableSha256,
    packageManifestSha256: expected?.packageManifestSha256,
    sourceRevision: expected?.sourceRevision,
  };
  const failures = exactContractFailures(
    bindings,
    contract,
    "workspace-identity",
  );
  if (!REVISION_PATTERN.test(bindings?.sourceRevision ?? ""))
    failures.push("workspace-identity-source-revision");
  for (const key of ["packageExecutableSha256", "packageManifestSha256"]) {
    if (!SHA256_PATTERN.test(bindings?.[key] ?? ""))
      failures.push(`workspace-identity-${key}`);
  }
  return failures;
}

function sampledMeasurementFailures(
  measurements,
  { count, maximum, prefix, reportedP95Ms, valueKey },
) {
  if (!Array.isArray(measurements) || measurements.length !== count)
    return [`${prefix}-measurements`];
  for (const [index, measurement] of measurements.entries()) {
    if (
      typeof measurement !== "object" ||
      measurement === null ||
      Array.isArray(measurement) ||
      JSON.stringify(Object.keys(measurement).toSorted(compareCodeUnits)) !==
        JSON.stringify(["sample", valueKey].toSorted(compareCodeUnits)) ||
      measurement.sample !== index + 1 ||
      !Number.isSafeInteger(measurement[valueKey]) ||
      measurement[valueKey] < 0 ||
      measurement[valueKey] > maximum
    ) {
      return [`${prefix}-measurements`];
    }
  }
  if (
    reportedP95Ms !== undefined &&
    percentile95(measurements.map((measurement) => measurement[valueKey])) !==
      reportedP95Ms
  ) {
    return [`${prefix}-p95-consistency`];
  }
  return [];
}

export function workspaceBudgetEvidenceFailures(budgets) {
  const measurementKeys = [
    "cleanupMs",
    "nativePickerCancellationMeasurements",
    "nativePickerCancellationP95Ms",
    "workspaceProjectionMeasurements",
    "workspaceProjectionP95Ms",
    "workspaceSelectionNativeActionMeasurements",
  ];
  const failures = [];
  const expectedKeys = [
    ...Object.keys(workspaceAcceptanceBudgetLimits),
    ...measurementKeys,
  ].toSorted(compareCodeUnits);
  if (
    typeof budgets !== "object" ||
    budgets === null ||
    Array.isArray(budgets) ||
    JSON.stringify(Object.keys(budgets).toSorted(compareCodeUnits)) !==
      JSON.stringify(expectedKeys)
  ) {
    failures.push("workspace-budget-fields");
  }
  for (const [key, value] of Object.entries(workspaceAcceptanceBudgetLimits)) {
    if (budgets?.[key] !== value) failures.push(`workspace-budget-${key}`);
  }
  if (
    !Number.isSafeInteger(budgets?.cleanupMs) ||
    budgets.cleanupMs < 0 ||
    budgets.cleanupMs > workspaceAcceptanceBudgetLimits.cleanupMaxMs
  ) {
    failures.push("workspace-budget-cleanupMs");
  }
  failures.push(
    ...sampledMeasurementFailures(budgets?.workspaceProjectionMeasurements, {
      count: workspaceAcceptanceBudgetLimits.workspaceProjectionSamples,
      maximum: workspaceAcceptanceBudgetLimits.workspaceProjectionP95MaxMs,
      prefix: "workspace-budget-projection",
      reportedP95Ms: budgets?.workspaceProjectionP95Ms,
      valueKey: "projectedMs",
    }),
    ...sampledMeasurementFailures(
      budgets?.workspaceSelectionNativeActionMeasurements,
      {
        count: workspaceAcceptanceBudgetLimits.workspaceProjectionSamples,
        maximum:
          workspaceAcceptanceBudgetLimits.workspaceSelectionNativeActionMaxMs,
        prefix: "workspace-budget-native-action",
        valueKey: "nativeActionMs",
      },
    ),
    ...nativePickerMeasurementFailures(
      budgets?.nativePickerCancellationMeasurements,
      budgets?.nativePickerCancellationP95Ms,
    ),
  );
  if (
    !Number.isSafeInteger(budgets?.nativePickerCancellationP95Ms) ||
    budgets.nativePickerCancellationP95Ms >
      workspaceAcceptanceBudgetLimits.nativePickerCancellationP95MaxMs
  ) {
    failures.push("workspace-budget-native-picker-p95");
  }
  return failures;
}

export function workspaceAcceptanceEvidenceFailures(evidence, expected) {
  const expectedKeys = [
    "bindings",
    "budgets",
    "journey",
    "packageInspection",
    "redaction",
    "referenceEnvironment",
    "safeguards",
    "schemaVersion",
    "status",
  ].toSorted(compareCodeUnits);
  const failures = [];
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    Array.isArray(evidence) ||
    JSON.stringify(Object.keys(evidence).toSorted(compareCodeUnits)) !==
      JSON.stringify(expectedKeys)
  ) {
    failures.push("workspace-evidence-fields");
  }
  if (evidence?.schemaVersion !== WORKSPACE_SCHEMA_VERSION)
    failures.push("workspace-evidence-schema");
  if (evidence?.status !== "complete")
    failures.push("workspace-evidence-status");
  if (evidence?.redaction !== "closed")
    failures.push("workspace-evidence-redaction");
  failures.push(
    ...workspaceIdentityFailures(evidence?.bindings, expected),
    ...workspaceBudgetEvidenceFailures(evidence?.budgets),
    ...exactContractFailures(
      evidence?.journey,
      workspaceAcceptanceJourneyContract,
      "workspace-journey",
    ),
    ...packageInspectionFailures(evidence?.packageInspection),
    ...referenceEnvironmentFailures(evidence?.referenceEnvironment),
    ...exactContractFailures(
      evidence?.safeguards,
      workspaceAcceptanceSafeguardContract,
      "workspace-safeguard",
    ),
  );
  if (redactionMatches(JSON.stringify(evidence)).length > 0)
    failures.push("workspace-evidence-sensitive-content");
  return failures;
}

function workspaceProgressTracker() {
  let lastCompleted = null;
  let lastStarted = null;
  const pickerActions = new Set([
    "launch",
    "probe-start",
    "probe-canvas",
    "open-workspace-picker",
    "observe-workspace-cancelled",
    "quit",
  ]);
  const workspaceActions = new Set([
    "probe-start",
    "probe-canvas",
    "open-workspace-picker",
    "observe-workspace-cancelled",
    "observe-workspace-permission-denied",
    "observe-workspace-selected",
    "quit",
  ]);
  const valid = (checkpoint) => {
    if (
      [
        "cleanup:application",
        "cleanup:fixture",
        "post-observation:reference-environment",
        "prepare",
        "validate",
        "workspace-journey",
        "write",
      ].includes(checkpoint)
    ) {
      return true;
    }
    const parts = String(checkpoint).split(":");
    if (parts.length !== 3) return false;
    const [stage, action, sample] = parts;
    if (!/^\d+$/u.test(sample ?? "")) return false;
    const sampleNumber = Number.parseInt(sample, 10);
    return stage === "picker-cancellation"
      ? pickerActions.has(action) && sampleNumber >= 1 && sampleNumber <= 20
      : stage === "workspace"
        ? workspaceActions.has(action) && sampleNumber >= 0 && sampleNumber <= 4
        : false;
  };
  const record = (state, checkpoint) => {
    if (!valid(checkpoint)) throw new TypeError("workspace-progress-invalid");
    if (state === "started") lastStarted = checkpoint;
    else if (state === "completed") lastCompleted = checkpoint;
    else throw new TypeError("workspace-progress-invalid");
  };
  return {
    record,
    snapshot: () => ({ lastCompleted, lastStarted, status: "rejected" }),
  };
}

function closedWorkspaceRejection(reasonCode, diagnostic) {
  return {
    diagnostic,
    exitCode: 2,
    output: {
      reasonCode,
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      status: "rejected",
    },
  };
}

export async function runCodexTracerWorkspaceAcceptance({ args, io }) {
  const progress = workspaceProgressTracker();
  if (!Array.isArray(args) || args.length !== 0)
    return closedWorkspaceRejection("invalid-command", progress.snapshot());
  let prepared;
  let cleanupAttempted = false;
  try {
    progress.record("started", "prepare");
    prepared = await io.prepareWorkspacePackage();
    progress.record("completed", "prepare");
    progress.record("started", "workspace-journey");
    const workspace = await io.runWorkspaceJourney(prepared, progress.record);
    progress.record("completed", "workspace-journey");
    const evidence = {
      bindings: prepared.workspaceBindings,
      budgets: workspace.budgets,
      journey: workspace.journey,
      packageInspection: prepared.packageInspection,
      redaction: "closed",
      referenceEnvironment: workspace.referenceEnvironment,
      safeguards: workspace.safeguards,
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      status: "complete",
    };
    cleanupAttempted = true;
    progress.record("started", "cleanup:fixture");
    await io.cleanupWorkspacePackage(prepared);
    progress.record("completed", "cleanup:fixture");
    progress.record("started", "validate");
    if (
      workspaceAcceptanceEvidenceFailures(evidence, prepared.expected).length >
      0
    )
      return closedWorkspaceRejection(
        "acceptance-evidence-invalid",
        progress.snapshot(),
      );
    progress.record("completed", "validate");
    progress.record("started", "write");
    await io.writeWorkspaceEvidence(evidence, prepared);
    progress.record("completed", "write");
    return { exitCode: 0, output: evidence };
  } catch {
    let diagnostic = progress.snapshot();
    if (prepared !== undefined && !cleanupAttempted) {
      try {
        progress.record("started", "cleanup:fixture");
        await io.cleanupWorkspacePackage(prepared);
        progress.record("completed", "cleanup:fixture");
      } catch {
        diagnostic = progress.snapshot();
      }
    }
    return closedWorkspaceRejection("acceptance-check-failed", diagnostic);
  }
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
