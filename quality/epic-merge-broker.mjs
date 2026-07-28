import { isDeepStrictEqual } from "node:util";

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
  isDeepStrictEqual(Object.keys(value).toSorted(), keys.toSorted());

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
    const policy = await ports.loadProtectedPolicy();
    const stablePolicy = await ports.loadProtectedPolicy();
    if (!isDeepStrictEqual(policy, stablePolicy))
      return denied("protected_policy_unstable");
    const availability = deriveEpicMergeAvailability(policy);
    if (availability.state === "disabled") return denied(availability.reason);
    const manifest =
      availability.state === "probe-only"
        ? findProbeManifestOperation(
            safeRequest,
            policy.probeManifest,
            policy.activation.commit,
          )
        : undefined;
    if (availability.state === "probe-only" && manifest === undefined)
      return denied("probe_manifest_mismatch");
    const first = await ports.loadAuthorization(safeRequest);
    const second = await ports.loadAuthorization(safeRequest);
    if (
      !epicMergeAuthorizationCurrent(first, safeRequest, policy) ||
      !isDeepStrictEqual(first, second)
    ) {
      return denied("authorization_unproven");
    }
    if (manifest && !epicMergeManifestMatches(manifest, first))
      return denied("probe_manifest_mismatch");
    const firstProtection = await ports.loadTargetProtection(
      first.issue.target,
      first.pullRequest.base,
    );
    const secondProtection = await ports.loadTargetProtection(
      first.issue.target,
      first.pullRequest.base,
    );
    if (
      !epicMergeProtectionCurrent(firstProtection, first) ||
      !isDeepStrictEqual(firstProtection, secondProtection)
    ) {
      return denied("target_protection_unproven");
    }
    const refs = await ports.readRefs(
      first.issue.target,
      first.pullRequest.source,
    );
    if (
      refs?.base !== first.pullRequest.base ||
      refs?.head !== first.pullRequest.head
    ) {
      return denied("refs_changed");
    }
    const claim = claimInput(first, safeRequest);
    operation = operationRecord(
      first,
      firstProtection,
      policy,
      safeRequest,
      claim,
      ports.clock,
    );
    const expectedPreparation = { claim, operation, state: "prepared" };
    const prepared = await ports.prepareOperation({ claim, operation });
    if (!isDeepStrictEqual(prepared, expectedPreparation))
      return denied("serialization_prepare_unavailable");
    const readback = await ports.readPreparation(safeRequest.operationId);
    if (!isDeepStrictEqual(readback, expectedPreparation))
      throw new Error("durable_readback_mismatch");
    const preSubmitRefs = await ports.readRefs(
      first.issue.target,
      first.pullRequest.source,
    );
    if (
      preSubmitRefs?.base !== first.pullRequest.base ||
      preSubmitRefs?.head !== first.pullRequest.head
    ) {
      if (
        !(await settleAndVerify(
          ports,
          operation,
          {
            claimId: operation.claimId,
            operationId: safeRequest.operationId,
            releaseSerialization: true,
            result: "cancelled",
          },
          false,
        ))
      )
        throw new Error("settlement_unproven");
      return denied("refs_changed");
    }
    const preSubmitProtection = await ports.loadTargetProtection(
      first.issue.target,
      first.pullRequest.base,
    );
    if (
      !epicMergeProtectionCurrent(preSubmitProtection, first) ||
      !isDeepStrictEqual(preSubmitProtection, firstProtection)
    ) {
      if (
        !(await settleAndVerify(
          ports,
          operation,
          {
            claimId: operation.claimId,
            operationId: safeRequest.operationId,
            releaseSerialization: true,
            result: "cancelled",
          },
          false,
        ))
      )
        throw new Error("settlement_unproven");
      return denied("target_protection_changed");
    }
    const preSubmitPolicy = await ports.loadProtectedPolicy();
    if (!isDeepStrictEqual(preSubmitPolicy, policy)) {
      if (
        !(await settleAndVerify(
          ports,
          operation,
          {
            claimId: operation.claimId,
            operationId: operation.operationId,
            releaseSerialization: true,
            result: "cancelled",
          },
          false,
        ))
      )
        throw new Error("settlement_unproven");
      return denied("protected_policy_changed");
    }
    const finalPullRequest = await ports.loadPullRequest(safeRequest);
    if (!isDeepStrictEqual(finalPullRequest, first.pullRequest)) {
      if (
        !(await settleAndVerify(
          ports,
          operation,
          {
            claimId: operation.claimId,
            operationId: operation.operationId,
            releaseSerialization: true,
            result: "cancelled",
          },
          false,
        ))
      )
        throw new Error("settlement_unproven");
      return denied("canonical_pull_request_changed");
    }
    submitted = true;
    const marked = await ports.markOperationSubmitted({
      claimId: operation.claimId,
      operationId: operation.operationId,
      state: "submitted",
    });
    if (
      !isDeepStrictEqual(marked, { submitted: true }) ||
      !isDeepStrictEqual(await ports.readOperation(operation.operationId), {
        ...operation,
        state: "submitted",
        submitted: true,
      })
    )
      throw new Error("submission_marker_unproven");
    const response = await ports.mergePullRequest({
      merge_method: "squash",
      pullRequest: first.pullRequest.number,
      repository: REPOSITORY,
      sha: first.pullRequest.head,
    });
    if (response?.kind === "rejected") {
      if (
        !(await settleAndVerify(
          ports,
          operation,
          {
            claimId: operation.claimId,
            operationId: safeRequest.operationId,
            releaseSerialization: true,
            result: "rejected",
          },
          true,
        ))
      )
        throw new Error("settlement_unproven");
      return {
        ...denied("provider_rejected"),
        receipt: receipt(operation, "denied", true),
      };
    }
    if (
      response?.kind !== "accepted" ||
      !isEpicMergeCommit(response.mergeCommit)
    )
      throw new Error("indeterminate");
    const outcome = await ports.readMergeOutcome({
      pullRequest: first.pullRequest.number,
      repository: REPOSITORY,
      target: first.issue.target,
    });
    if (!verifiedOutcome(outcome, first.pullRequest, response))
      throw new Error("indeterminate");
    if (
      !(await settleAndVerify(
        ports,
        operation,
        {
          claimId: operation.claimId,
          mergeCommit: response.mergeCommit,
          operationId: safeRequest.operationId,
          releaseSerialization: true,
          result: "merged",
        },
        true,
      ))
    )
      throw new Error("settlement_unproven");
    return {
      receipt: receipt(operation, "merged", true, {
        mergeCommit: response.mergeCommit,
        parents: [first.pullRequest.base],
        targetTip: outcome.targetTip,
        tree: outcome.commit.tree,
      }),
      result: "merged",
    };
  } catch {
    if (operation) {
      try {
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
        );
      } catch {}
      return {
        receipt: receipt(operation, "indeterminate", submitted),
        reason: submitted
          ? "human_reconciliation_required"
          : "prepared_operation_reconciliation_required",
        result: "indeterminate",
      };
    }
    return denied("guard_unavailable");
  }
}
