import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { BROKER_APP_PERMISSIONS } from "./epic-merge-broker-capability.mjs";
import {
  exactKeys,
  exactStrings,
  positiveInteger,
  record,
  text,
} from "./repository-controls-policy.mjs";

const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
export const brokerRejectionScenarios = Object.freeze([
  "broader_target",
  "concurrent_request",
  "permission_drift",
  "provider_failure",
  "replay",
  "stale_base",
  "stale_head",
  "wrong_target",
]);
export const BROKER_PERMISSION_ENTRIES = Object.freeze(
  Object.entries(BROKER_APP_PERMISSIONS)
    .map(([name, access]) => `${name}:${access}`)
    .toSorted(),
);

export function permissionSetDigest(entries) {
  return createHash("sha256")
    .update(JSON.stringify([...entries].toSorted()))
    .digest("hex");
}

const observedAt = (value) => text(value) && Number.isFinite(Date.parse(value));
const issueNumber = (identity) => {
  const match = /^issue-([1-9][0-9]*)$/u.exec(identity ?? "");
  const value = match ? Number(match[1]) : undefined;
  return positiveInteger(value) ? value : undefined;
};

function exactRows(values, names, nameKey, valid) {
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

const rowKeys = Object.freeze([
  "actorAppId",
  "automationDisabled",
  "base",
  "details",
  "head",
  "issue",
  "issueFence",
  "observedAt",
  "protectedStateUnchanged",
  "pullRequest",
  "repository",
  "requestId",
  "result",
  "scenario",
  "snapshotId",
  "source",
  "target",
  "targetFence",
]);

function baselineValid(row, effect, policy) {
  return (
    exactKeys(row, rowKeys) &&
    row.actorAppId === policy.identities.broker.appId &&
    row.automationDisabled === true &&
    row.base === effect.base &&
    row.head === effect.head &&
    row.issue === issueNumber(effect.issueIdentity) &&
    row.issueFence === effect.issueFence &&
    observedAt(row.observedAt) &&
    row.protectedStateUnchanged === true &&
    row.pullRequest === effect.pullRequest &&
    row.repository === effect.repository &&
    digestPattern.test(row.requestId) &&
    row.result === "rejected" &&
    row.snapshotId === effect.snapshotId &&
    row.source === effect.source &&
    row.target === effect.target &&
    row.targetFence === effect.targetFence
  );
}

function targetDetails(details, expected) {
  return (
    exactKeys(details, ["attemptedTarget", "submitted"]) &&
    details.attemptedTarget === expected &&
    details.submitted === false
  );
}

function staleDetails(details, effect, kind) {
  const expectedKey = kind === "head" ? "expectedHead" : "expectedBase";
  const observedKey = kind === "head" ? "observedHead" : "observedBase";
  const expected = kind === "head" ? effect.head : effect.base;
  return (
    exactKeys(details, [expectedKey, observedKey, "submitted"]) &&
    details[expectedKey] === expected &&
    shaPattern.test(details[observedKey]) &&
    details[observedKey] !== expected &&
    details.submitted === false
  );
}

function concurrencyDetails(details, row, effect) {
  return (
    exactKeys(details, [
      "competingRequestId",
      "competingTargetFence",
      "submitted",
    ]) &&
    digestPattern.test(details.competingRequestId) &&
    details.competingRequestId !== row.requestId &&
    details.competingRequestId !== effect.requestId &&
    text(details.competingTargetFence) &&
    details.competingTargetFence !== effect.targetFence &&
    details.submitted === false
  );
}

function permissionDetails(details) {
  if (
    !exactKeys(details, [
      "expectedPermissions",
      "expectedPermissionsDigest",
      "observedPermissions",
      "observedPermissionsDigest",
      "submitted",
    ]) ||
    !exactStrings(details.expectedPermissions, BROKER_PERMISSION_ENTRIES) ||
    !Array.isArray(details.observedPermissions) ||
    !exactStrings(details.observedPermissions, details.observedPermissions) ||
    isDeepStrictEqual(
      details.observedPermissions.toSorted(),
      [...BROKER_PERMISSION_ENTRIES].toSorted(),
    )
  )
    return false;
  return (
    details.expectedPermissionsDigest ===
      permissionSetDigest([...BROKER_PERMISSION_ENTRIES]) &&
    details.observedPermissionsDigest ===
      permissionSetDigest(details.observedPermissions) &&
    details.submitted === false
  );
}

function providerDetails(details) {
  return (
    exactKeys(details, ["failureClass", "providerResult", "submitted"]) &&
    details.failureClass === "provider_unavailable" &&
    details.providerResult === "unavailable" &&
    details.submitted === false
  );
}

function replayDetails(details, effect) {
  return (
    exactKeys(details, [
      "noRetry",
      "replayOfRequestId",
      "replayOfSnapshotId",
      "submissionCount",
      "submitted",
    ]) &&
    details.noRetry === true &&
    details.replayOfRequestId === effect.requestId &&
    details.replayOfSnapshotId === effect.snapshotId &&
    details.submissionCount === 1 &&
    details.submitted === false
  );
}

function detailsValid(row, effect) {
  if (row.scenario === "broader_target")
    return targetDetails(row.details, "epic/**");
  if (row.scenario === "wrong_target") return targetDetails(row.details, "dev");
  if (row.scenario === "stale_head")
    return staleDetails(row.details, effect, "head");
  if (row.scenario === "stale_base")
    return staleDetails(row.details, effect, "base");
  if (row.scenario === "concurrent_request")
    return concurrencyDetails(row.details, row, effect);
  if (row.scenario === "permission_drift")
    return permissionDetails(row.details);
  if (row.scenario === "provider_failure") return providerDetails(row.details);
  if (row.scenario === "replay") return replayDetails(row.details, effect);
  return false;
}

export function brokerRejectionProbeInvalid(probes, effect, policy) {
  const rows = probes.brokerRejections;
  return (
    !exactRows(
      rows,
      brokerRejectionScenarios,
      "scenario",
      (row) => baselineValid(row, effect, policy) && detailsValid(row, effect),
    ) || new Set(rows?.map((row) => row.requestId)).size !== rows?.length
  );
}
