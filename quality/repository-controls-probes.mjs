import {
  add,
  exactKeys,
  exactStrings,
  record,
  text,
} from "./repository-controls-policy.mjs";
import {
  brokerEffect,
  callerProbeInvalid,
} from "./repository-controls-probe-identities.mjs";
import { denialProbeInvalid } from "./repository-controls-probe-denials.mjs";
import { brokerRejectionProbeInvalid } from "./repository-controls-probe-scenarios.mjs";

export const REPOSITORY_CONTROLS_PROBES_SCHEMA =
  "keiko-native-repository-controls-probes/v2";

const recoveryScenarios = Object.freeze([
  "ambiguous_result",
  "outage",
  "revocation",
  "rotation",
]);

function observedAt(value) {
  return text(value) && Number.isFinite(Date.parse(value));
}

function exactProbeRows(values, names, nameKey, valid) {
  return (
    Array.isArray(values) &&
    values.every(
      (value) => record(value) && text(value[nameKey]) && valid(value),
    ) &&
    exactStrings(
      values.map((value) => value[nameKey]),
      names,
    )
  );
}

function recoveryRowValid(row) {
  if (
    !exactKeys(row, [
      "automationDisabled",
      "capabilityReproven",
      "humanReconciled",
      "noRetry",
      "observedAt",
      "result",
      "scenario",
    ])
  )
    return false;
  const ambiguous = row.scenario === "ambiguous_result";
  return (
    row.automationDisabled === true &&
    row.capabilityReproven === true &&
    row.humanReconciled === ambiguous &&
    row.noRetry === true &&
    observedAt(row.observedAt) &&
    row.result === "recovered"
  );
}

function recoveryProbeInvalid(probes) {
  return !exactProbeRows(
    probes.recovery,
    recoveryScenarios,
    "scenario",
    recoveryRowValid,
  );
}

function observationTimes(probes) {
  return [
    probes.broker?.observedAt,
    probes.cleanup?.observedAt,
    ...(probes.brokerRejections ?? []).map((row) => row?.observedAt),
    ...(probes.callerCapabilities ?? []).map((row) => row?.observedAt),
    ...(probes.denials ?? []).map((row) => row?.observedAt),
    ...(probes.recovery ?? []).map((row) => row?.observedAt),
  ];
}

function observationsFresh(probes, policy, capturedAt, now) {
  const capture = Date.parse(capturedAt);
  if (!Number.isFinite(capture)) return false;
  const maxAge = policy.evidenceMaxAgeMinutes * 60 * 1000;
  return observationTimes(probes).every((value) => {
    const observed = Date.parse(value);
    return (
      Number.isFinite(observed) &&
      observed <= now + 5 * 60 * 1000 &&
      now - observed <= maxAge &&
      observed <= capture + 5 * 60 * 1000 &&
      capture - observed <= maxAge
    );
  });
}

function requestIdsGloballyUnique(probes, effect) {
  const requestIds = [
    effect?.requestId,
    ...(probes.callerCapabilities ?? []).map((row) => row?.requestId),
    ...(probes.brokerRejections ?? []).map((row) => row?.requestId),
    ...(probes.denials ?? []).map((row) => row?.requestId),
  ];
  return new Set(requestIds).size === requestIds.length;
}

export function repositoryControlProbeFailures(
  probes,
  policy,
  capturedAt,
  now,
) {
  if (
    !exactKeys(probes, [
      "broker",
      "brokerRejections",
      "callerCapabilities",
      "cleanup",
      "denials",
      "recovery",
      "schema",
    ])
  )
    return ["probe_shape_invalid"];
  const failures = [];
  const effect = brokerEffect(probes.broker, policy);
  add(
    failures,
    probes.schema !== REPOSITORY_CONTROLS_PROBES_SCHEMA,
    "probe_schema_invalid",
  );
  add(
    failures,
    effect === undefined || brokerRejectionProbeInvalid(probes, effect, policy),
    "broker_rejection_probes_invalid",
  );
  add(failures, effect === undefined, "broker_probe_invalid");
  add(
    failures,
    effect === undefined || callerProbeInvalid(probes, effect, policy),
    "caller_capability_probes_invalid",
  );
  add(
    failures,
    effect === undefined || denialProbeInvalid(probes, effect, policy),
    "denial_probes_invalid",
  );
  add(failures, recoveryProbeInvalid(probes), "recovery_probes_invalid");
  add(
    failures,
    !requestIdsGloballyUnique(probes, effect),
    "probe_request_ids_reused",
  );
  add(
    failures,
    !observationsFresh(probes, policy, capturedAt, now),
    "probe_observation_stale",
  );
  add(
    failures,
    !exactKeys(probes.cleanup, [
      "artifactsRemaining",
      "observedAt",
      "result",
    ]) ||
      probes.cleanup.artifactsRemaining !== 0 ||
      !observedAt(probes.cleanup.observedAt) ||
      probes.cleanup.result !== "passed",
    "cleanup_probe_invalid",
  );
  return failures;
}
