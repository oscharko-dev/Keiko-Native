import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { compareCodeUnits } from "./deterministic-order.mjs";

export const EPIC_MERGE_REPOSITORY = "oscharko-dev/Keiko-Native";
const PROTECTED_REF = "refs/heads/dev";
const EXPECTED_PRODUCERS = Object.freeze({
  activation: "contract-activation@protected-dev",
  proof: "epic-merge-live-proof@protected-dev",
  status: "epic-merge-guard-status@protected-dev",
});
export const isEpicMergeCommit = (value) =>
  typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  isDeepStrictEqual(
    Object.keys(value).toSorted(compareCodeUnits),
    keys.toSorted(compareCodeUnits),
  );
const safeIdentity = (prefix, value) =>
  typeof value === "string" &&
  new RegExp(`^${prefix}_[0-9a-f]{64}$`, "u").test(value);
const namedProducer = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9 ,.[\]_:/@()-]{1,127}$/u.test(value);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .toSorted(compareCodeUnits)
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function digestEpicMergeProbeManifest(manifest) {
  return digestEpicMergeValue(manifest);
}

export function digestEpicMergeValue(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function canonicalEpicMergeIdentity(kind, value) {
  const prefix = { operation: "op", request: "req" }[kind];
  if (prefix === undefined || typeof value !== "string")
    throw new Error("invalid_epic_merge_identity");
  return `${prefix}_${digestEpicMergeValue({ kind, value })}`;
}

function validManifest(manifest, activationCommit) {
  if (
    !exactKeys(manifest, [
      "activationCommit",
      "issue",
      "operations",
      "repository",
      "schema",
    ]) ||
    manifest.schema !== 2 ||
    manifest.repository !== EPIC_MERGE_REPOSITORY ||
    manifest.issue !== 55 ||
    manifest.activationCommit !== activationCommit ||
    !Array.isArray(manifest.operations) ||
    manifest.operations.length === 0
  )
    return false;
  const identities = new Set();
  for (const operation of manifest.operations) {
    if (
      !exactKeys(operation, [
        "base",
        "head",
        "issue",
        "operationId",
        "pullRequest",
        "requestId",
        "target",
      ]) ||
      !isEpicMergeCommit(operation.base) ||
      !isEpicMergeCommit(operation.head) ||
      !positive(operation.issue) ||
      !positive(operation.pullRequest) ||
      !safeIdentity("op", operation.operationId) ||
      !safeIdentity("req", operation.requestId) ||
      !/^epic\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(operation.target)
    )
      return false;
    const identity = `${operation.operationId}:${operation.requestId}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return true;
}

function validRequirements(policy, active) {
  if (
    !Array.isArray(policy.requiredChecks) ||
    !Array.isArray(policy.requiredEvidence) ||
    (active &&
      (policy.requiredChecks.length === 0 ||
        policy.requiredEvidence.length === 0))
  )
    return false;
  const checks = new Set();
  for (const item of policy.requiredChecks) {
    const identity = `${item?.context}\0${item?.producer}`;
    if (
      !exactKeys(item, ["context", "producer"]) ||
      !namedProducer(item.context) ||
      !namedProducer(item.producer) ||
      checks.has(identity)
    )
      return false;
    checks.add(identity);
  }
  const evidence = new Set();
  for (const item of policy.requiredEvidence) {
    if (
      !exactKeys(item, ["name", "producer"]) ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(item.name) ||
      !namedProducer(item.producer) ||
      evidence.has(item.name)
    )
      return false;
    evidence.add(item.name);
  }
  return true;
}

function validProof(proof) {
  if (
    !exactKeys(proof, ["receipt", "status"]) ||
    !exactKeys(proof.receipt, [
      "activationCommit",
      "ambiguous",
      "head",
      "manifestDigest",
      "matrixComplete",
      "policyRevision",
      "producer",
      "settled",
    ]) ||
    !exactKeys(proof.status, [
      "activationCommit",
      "conclusion",
      "head",
      "manifestDigest",
      "policyRevision",
      "producer",
    ])
  )
    return false;
  return (
    isEpicMergeCommit(proof.receipt.activationCommit) &&
    isEpicMergeCommit(proof.receipt.head) &&
    /^[0-9a-f]{64}$/u.test(proof.receipt.manifestDigest) &&
    isEpicMergeCommit(proof.receipt.policyRevision) &&
    namedProducer(proof.receipt.producer) &&
    typeof proof.receipt.ambiguous === "boolean" &&
    typeof proof.receipt.matrixComplete === "boolean" &&
    typeof proof.receipt.settled === "boolean" &&
    isEpicMergeCommit(proof.status.activationCommit) &&
    isEpicMergeCommit(proof.status.head) &&
    /^[0-9a-f]{64}$/u.test(proof.status.manifestDigest) &&
    isEpicMergeCommit(proof.status.policyRevision) &&
    namedProducer(proof.status.producer) &&
    [
      "action_required",
      "cancelled",
      "failure",
      "neutral",
      "skipped",
      "stale",
      "success",
      "timed_out",
    ].includes(proof.status.conclusion)
  );
}

export function validateEpicMergePolicy(
  policy,
  { allowUnresolvedRevision = false } = {},
) {
  if (
    !exactKeys(policy, [
      "activation",
      "expectedProducers",
      "liveProof",
      "probeManifest",
      "repository",
      "requiredChecks",
      "requiredEvidence",
      "schema",
      "source",
    ]) ||
    policy.schema !== 2 ||
    policy.repository !== EPIC_MERGE_REPOSITORY ||
    !isDeepStrictEqual(policy.expectedProducers, EXPECTED_PRODUCERS) ||
    !exactKeys(
      policy.source,
      allowUnresolvedRevision
        ? ["protected", "ref"]
        : ["protected", "ref", "revision"],
    ) ||
    policy.source.ref !== PROTECTED_REF ||
    policy.source.protected !== true ||
    (!allowUnresolvedRevision && !isEpicMergeCommit(policy.source.revision))
  )
    return false;
  const inactive =
    exactKeys(policy.activation, ["state"]) &&
    policy.activation.state === "inactive";
  const active =
    exactKeys(policy.activation, ["commit", "producer", "signed", "state"]) &&
    policy.activation.state === "active" &&
    policy.activation.signed === true &&
    isEpicMergeCommit(policy.activation.commit) &&
    policy.activation.producer === policy.expectedProducers.activation;
  if (!inactive && !active) return false;
  if (!validRequirements(policy, active)) return false;
  if (inactive)
    return policy.probeManifest === null && policy.liveProof === null;
  return (
    validManifest(policy.probeManifest, policy.activation.commit) &&
    (policy.liveProof === null || validProof(policy.liveProof))
  );
}
