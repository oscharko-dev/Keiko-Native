import { isDeepStrictEqual } from "node:util";

import {
  EPIC_MERGE_REPOSITORY,
  isEpicMergeCommit,
} from "./epic-merge-policy.mjs";

const actor = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value);
const operationIdentity = (value) =>
  typeof value === "string" && /^op_[0-9a-f]{64}$/u.test(value);
const claimIdentity = (value) =>
  typeof value === "string" && /^clm_[0-9a-f]{64}$/u.test(value);
const reconciliationKeys = ["actor", "operationId", "repository"];
const maintainers = new Set(["niko4417", "oscharko"]);
const maintainerLogin = (value) => {
  if (!actor(value)) return undefined;
  const login = value.toLowerCase();
  return maintainers.has(login) ? login : undefined;
};

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).toSorted(), keys.toSorted())
  );
}

export function epicMergeReceipt(record, result, submitted, extra = {}) {
  return {
    base: record.base,
    evidenceDigest: record.evidenceDigest,
    head: record.head,
    issue: record.issue,
    mode: "agent-credentialed",
    operationId: record.operationId,
    policyDigest: record.policyDigest,
    policyRevision: record.policyRevision,
    policyState: record.policyState,
    pullRequest: record.pullRequest,
    repository: EPIC_MERGE_REPOSITORY,
    requestId: record.requestId,
    result,
    submitted,
    target: record.target,
    timestamp: record.createdAt,
    ...extra,
  };
}

export async function settleEpicMergeOperation(
  ports,
  operation,
  settlement,
  submitted,
) {
  const result = await ports.settleOperation(settlement);
  if (!isDeepStrictEqual(result, { settled: true })) return false;
  return isDeepStrictEqual(await ports.readOperation(operation.operationId), {
    ...operation,
    state: settlement.result,
    submitted,
  });
}

export function epicMergeOutcomeMatchesOperation(outcome, operation) {
  return (
    outcome?.merged === true &&
    outcome.pullRequest === operation.pullRequest &&
    outcome.base === operation.base &&
    outcome.source === operation.source &&
    outcome.sourceHead === operation.head &&
    outcome.target === operation.target &&
    outcome.targetTip === outcome.commit?.sha &&
    isEpicMergeCommit(outcome.commit?.sha) &&
    isDeepStrictEqual(outcome.commit?.parents, [operation.base]) &&
    outcome.commit?.tree === operation.headTree
  );
}

export function epicMergeProviderOutcomeMatches(
  outcome,
  pullRequest,
  response,
) {
  return (
    outcome?.merged === true &&
    outcome.pullRequest === pullRequest.number &&
    outcome.base === pullRequest.base &&
    outcome.source === pullRequest.source &&
    outcome.sourceHead === pullRequest.head &&
    outcome.target === pullRequest.target &&
    outcome.targetTip === response.mergeCommit &&
    outcome.commit?.sha === response.mergeCommit &&
    isDeepStrictEqual(outcome.commit?.parents, [pullRequest.base]) &&
    outcome.commit?.tree === pullRequest.headTree
  );
}

function noEffectMatchesOperation(outcome, operation) {
  return (
    outcome?.merged === false &&
    outcome.pullRequest === operation.pullRequest &&
    outcome.base === operation.base &&
    outcome.source === operation.source &&
    outcome.sourceHead === operation.head &&
    outcome.target === operation.target &&
    outcome.targetTip === operation.base
  );
}

export async function reconcileEpicMergeOperation(input, ports) {
  try {
    const login = maintainerLogin(input?.actor);
    if (
      !exactKeys(input, reconciliationKeys) ||
      input.repository !== EPIC_MERGE_REPOSITORY ||
      login === undefined ||
      !operationIdentity(input.operationId) ||
      input.actor.length > 39
    ) {
      return { reason: "maintainer_authority_unproven", result: "blocked" };
    }
    const operation = await ports.readOperation(input.operationId);
    if (
      operation?.repository !== EPIC_MERGE_REPOSITORY ||
      operation.operationId !== input.operationId ||
      !["indeterminate", "prepared", "submitted"].includes(operation.state) ||
      !claimIdentity(operation.claimId) ||
      typeof operation.submitted !== "boolean" ||
      typeof operation.source !== "string"
    ) {
      return { reason: "operation_unproven", result: "blocked" };
    }
    if ((await ports.authorizeMaintainer(login, operation.target)) !== true)
      return { reason: "maintainer_authority_unproven", result: "blocked" };
    const observation = await ports.readReconciliation({
      issue: operation.issue,
      pullRequest: operation.pullRequest,
      repository: EPIC_MERGE_REPOSITORY,
      source: operation.head,
      target: operation.target,
    });
    const merged =
      operation.submitted === true &&
      ["indeterminate", "submitted"].includes(operation.state) &&
      epicMergeOutcomeMatchesOperation(observation, operation);
    const cancelled =
      operation.submitted === false &&
      ["indeterminate", "prepared"].includes(operation.state) &&
      noEffectMatchesOperation(observation, operation);
    if (!merged && !cancelled) {
      return { reason: "topology_unproven", result: "blocked" };
    }
    const transition = {
      claimId: operation.claimId,
      from: operation.state,
      operationId: operation.operationId,
      releaseSerialization: true,
      result: merged ? "merged" : "cancelled",
      ...(merged ? { mergeCommit: observation.commit.sha } : {}),
    };
    const settlement = await ports.settleReconciliation(transition);
    if (!isDeepStrictEqual(settlement, { settled: true }))
      return { reason: "settlement_unproven", result: "blocked" };
    const readback = await ports.readOperation(operation.operationId);
    if (
      !isDeepStrictEqual(readback, {
        ...operation,
        state: transition.result,
      })
    )
      return { reason: "settlement_unproven", result: "blocked" };
    return merged
      ? { mergeCommit: observation.commit.sha, result: "settled_merged" }
      : { result: "settled_cancelled" };
  } catch {
    return { reason: "reconciliation_unavailable", result: "blocked" };
  }
}
