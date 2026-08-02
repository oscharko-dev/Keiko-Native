import { isDeepStrictEqual } from "node:util";

import { compareCodeUnits } from "./deterministic-order.mjs";
import {
  epicMergeAuthorizationCurrent,
  epicMergeManifestMatches,
  epicMergeProtectionCurrent,
} from "./epic-merge-authorization.mjs";
import {
  canonicalEpicMergeIdentity,
  deriveEpicMergeAvailability,
  digestEpicMergeValue,
  EPIC_MERGE_REPOSITORY,
  findProbeManifestOperation,
  isEpicMergeCommit,
} from "./epic-merge-policy.mjs";
import {
  epicMergeProviderOutcomeMatches as verifiedOutcome,
  epicMergeReceipt as receipt,
  settleEpicMergeOperation as settleAndVerify,
} from "./epic-merge-operation.mjs";

export {
  buildEpicMergeProbePlan,
  canonicalEpicMergeIdentity,
  deriveEpicMergeAvailability,
  digestEpicMergeProbeManifest,
  epicMergeGuardStatus,
} from "./epic-merge-policy.mjs";
export { reconcileEpicMergeOperation } from "./epic-merge-operation.mjs";

const REPOSITORY = EPIC_MERGE_REPOSITORY;
const identifier = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  isDeepStrictEqual(
    Object.keys(value).toSorted(compareCodeUnits),
    keys.toSorted(compareCodeUnits),
  );

const denied = (reason) => ({
  mode: "agent-credentialed",
  reason,
  result: "denied",
});

const requestKeys = [
  "issue",
  "mode",
  "operationId",
  "pullRequest",
  "repository",
  "requestId",
];
function validRequest(request) {
  return (
    exactKeys(request, requestKeys) &&
    request.repository === REPOSITORY &&
    request.mode === "agent-credentialed" &&
    positive(request.issue) &&
    positive(request.pullRequest) &&
    identifier(request.operationId) &&
    identifier(request.requestId)
  );
}

function claimInput(authorization, request) {
  const { base } = authorization.pullRequest;
  const target = authorization.issue.target;
  const identity = { base, repository: REPOSITORY, target };
  return {
    ...identity,
    claimId: `clm_${digestEpicMergeValue({
      identity,
      operationId: request.operationId,
    })}`,
    key: digestEpicMergeValue(identity),
    operationId: request.operationId,
    state: "claimed",
  };
}

function operationRecord(
  authorization,
  protection,
  policy,
  request,
  claim,
  clock,
) {
  const { issue, pullRequest } = authorization;
  const evidenceDigest = digestEpicMergeValue({ authorization, protection });
  return {
    base: pullRequest.base,
    claimId: claim.claimId,
    contractFingerprint: issue.readiness.fingerprint,
    contractVersion: issue.readiness.version,
    createdAt: clock(),
    evidenceDigest,
    head: pullRequest.head,
    headTree: pullRequest.headTree,
    issue: issue.number,
    mode: "agent-credentialed",
    operationId: request.operationId,
    pullRequest: pullRequest.number,
    policyDigest: digestEpicMergeValue(policy),
    policyRevision: policy.source.revision,
    policyState: deriveEpicMergeAvailability(policy).state,
    repository: REPOSITORY,
    requestId: request.requestId,
    source: pullRequest.source,
    state: "prepared",
    submitted: false,
    target: issue.target,
  };
}

const refsCurrent = (refs, pullRequest) =>
  refs?.base === pullRequest.base && refs?.head === pullRequest.head;

async function loadInitialContext(safeRequest, ports) {
  const policy = await ports.loadProtectedPolicy();
  if (!isDeepStrictEqual(policy, await ports.loadProtectedPolicy()))
    return { denial: denied("protected_policy_unstable") };
  const availability = deriveEpicMergeAvailability(policy);
  if (availability.state === "disabled")
    return { denial: denied(availability.reason) };
  const manifest =
    availability.state === "probe-only"
      ? findProbeManifestOperation(
          safeRequest,
          policy.probeManifest,
          policy.activation.commit,
        )
      : undefined;
  if (availability.state === "probe-only" && manifest === undefined)
    return { denial: denied("probe_manifest_mismatch") };
  const authorization = await ports.loadAuthorization(safeRequest);
  const stableAuthorization = await ports.loadAuthorization(safeRequest);
  if (
    !epicMergeAuthorizationCurrent(authorization, safeRequest, policy) ||
    !isDeepStrictEqual(authorization, stableAuthorization)
  )
    return { denial: denied("authorization_unproven") };
  if (manifest && !epicMergeManifestMatches(manifest, authorization))
    return { denial: denied("probe_manifest_mismatch") };
  const protection = await ports.loadTargetProtection(
    authorization.issue.target,
    authorization.pullRequest.base,
  );
  const stableProtection = await ports.loadTargetProtection(
    authorization.issue.target,
    authorization.pullRequest.base,
  );
  if (
    !epicMergeProtectionCurrent(protection, authorization) ||
    !isDeepStrictEqual(protection, stableProtection)
  )
    return { denial: denied("target_protection_unproven") };
  const refs = await ports.readRefs(
    authorization.issue.target,
    authorization.pullRequest.source,
  );
  return refsCurrent(refs, authorization.pullRequest)
    ? { authorization, policy, protection }
    : { denial: denied("refs_changed") };
}

async function persistPreparation(ports, claim, operation) {
  const expected = { claim, operation, state: "prepared" };
  if (
    !isDeepStrictEqual(
      await ports.prepareOperation({ claim, operation }),
      expected,
    )
  )
    return denied("serialization_prepare_unavailable");
  if (
    !isDeepStrictEqual(
      await ports.readPreparation(operation.operationId),
      expected,
    )
  )
    throw new Error("durable_readback_mismatch");
  return undefined;
}

async function cancelPrepared(ports, operation, reason) {
  const settled = await settleAndVerify(
    ports,
    operation,
    {
      claimId: operation.claimId,
      operationId: operation.operationId,
      releaseSerialization: true,
      result: "cancelled",
    },
    false,
  );
  if (!settled) throw new Error("settlement_unproven");
  return denied(reason);
}

async function revalidatePrepared(context, safeRequest, ports, operation) {
  const { authorization, policy, protection } = context;
  const refs = await ports.readRefs(
    authorization.issue.target,
    authorization.pullRequest.source,
  );
  if (!refsCurrent(refs, authorization.pullRequest))
    return cancelPrepared(ports, operation, "refs_changed");
  const currentProtection = await ports.loadTargetProtection(
    authorization.issue.target,
    authorization.pullRequest.base,
  );
  if (
    !epicMergeProtectionCurrent(currentProtection, authorization) ||
    !isDeepStrictEqual(currentProtection, protection)
  )
    return cancelPrepared(ports, operation, "target_protection_changed");
  if (!isDeepStrictEqual(await ports.loadProtectedPolicy(), policy))
    return cancelPrepared(ports, operation, "protected_policy_changed");
  const currentAuthorization = await ports.loadAuthorization(safeRequest);
  if (
    !epicMergeAuthorizationCurrent(currentAuthorization, safeRequest, policy) ||
    !isDeepStrictEqual(currentAuthorization, authorization)
  )
    return cancelPrepared(ports, operation, "authorization_changed");
  if (
    !isDeepStrictEqual(
      await ports.loadPullRequest(safeRequest),
      authorization.pullRequest,
    )
  )
    return cancelPrepared(ports, operation, "canonical_pull_request_changed");
  return undefined;
}

async function markSubmitted(ports, operation) {
  const marked = await ports.markOperationSubmitted({
    claimId: operation.claimId,
    operationId: operation.operationId,
    state: "submitted",
  });
  const readback = await ports.readOperation(operation.operationId);
  if (
    !isDeepStrictEqual(marked, { submitted: true }) ||
    !isDeepStrictEqual(readback, {
      ...operation,
      state: "submitted",
      submitted: true,
    })
  )
    throw new Error("submission_marker_unproven");
}

async function performMerge(context, ports, operation) {
  const { authorization } = context;
  const response = await ports.mergePullRequest({
    merge_method: "squash",
    pullRequest: authorization.pullRequest.number,
    repository: REPOSITORY,
    sha: authorization.pullRequest.head,
  });
  if (response?.kind === "rejected") {
    const settled = await settleAndVerify(
      ports,
      operation,
      {
        claimId: operation.claimId,
        operationId: operation.operationId,
        releaseSerialization: true,
        result: "rejected",
      },
      true,
    );
    if (!settled) throw new Error("settlement_unproven");
    return {
      ...denied("provider_rejected"),
      receipt: receipt(operation, "denied", true),
    };
  }
  if (response?.kind !== "accepted" || !isEpicMergeCommit(response.mergeCommit))
    throw new Error("indeterminate");
  const outcome = await ports.readMergeOutcome({
    pullRequest: authorization.pullRequest.number,
    repository: REPOSITORY,
    target: authorization.issue.target,
  });
  if (!verifiedOutcome(outcome, authorization.pullRequest, response))
    throw new Error("indeterminate");
  const settled = await settleAndVerify(
    ports,
    operation,
    {
      claimId: operation.claimId,
      mergeCommit: response.mergeCommit,
      operationId: operation.operationId,
      releaseSerialization: true,
      result: "merged",
    },
    true,
  );
  if (!settled) throw new Error("settlement_unproven");
  return {
    receipt: receipt(operation, "merged", true, {
      mergeCommit: response.mergeCommit,
      parents: [authorization.pullRequest.base],
      targetTip: outcome.targetTip,
      tree: outcome.commit.tree,
    }),
    result: "merged",
  };
}

async function indeterminateResult(ports, operation, submitted) {
  if (!operation) return denied("guard_unavailable");
  let settlement = "unproven";
  try {
    if (
      await settleAndVerify(
        ports,
        operation,
        {
          claimId: operation.claimId,
          operationId: operation.operationId,
          releaseSerialization: false,
          result: "indeterminate",
        },
        submitted,
      )
    )
      settlement = "recorded";
  } catch {
    settlement = "unavailable";
  }
  return {
    receipt: receipt(operation, "indeterminate", submitted, { settlement }),
    reason: submitted
      ? "human_reconciliation_required"
      : "prepared_operation_reconciliation_required",
    result: "indeterminate",
  };
}

export async function runGuardedEpicMerge(request, ports) {
  let submitted = false;
  let operation;
  try {
    if (!validRequest(request)) return denied("request_invalid");
    const safeRequest = {
      ...request,
      operationId: canonicalEpicMergeIdentity("operation", request.operationId),
      requestId: canonicalEpicMergeIdentity("request", request.requestId),
    };
    const context = await loadInitialContext(safeRequest, ports);
    if (context.denial) return context.denial;
    const claim = claimInput(context.authorization, safeRequest);
    operation = operationRecord(
      context.authorization,
      context.protection,
      context.policy,
      safeRequest,
      claim,
      ports.clock,
    );
    const persistenceFailure = await persistPreparation(
      ports,
      claim,
      operation,
    );
    if (persistenceFailure) return persistenceFailure;
    const revalidationFailure = await revalidatePrepared(
      context,
      safeRequest,
      ports,
      operation,
    );
    if (revalidationFailure) return revalidationFailure;
    submitted = true;
    await markSubmitted(ports, operation);
    return await performMerge(context, ports, operation);
  } catch {
    return indeterminateResult(ports, operation, submitted);
  }
}
