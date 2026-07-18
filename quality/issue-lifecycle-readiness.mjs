import { semanticIssueFingerprint } from "./issue-contract.mjs";
import { readinessRecordFromComments } from "./issue-readiness-action.mjs";
import {
  LIFECYCLE_STATES,
  isAllowedLifecycleEdge,
  validateTransitionRequest,
} from "./issue-lifecycle.mjs";

const READY = LIFECYCLE_STATES[2];
const IN_PROGRESS = LIFECYCLE_STATES[3];
const PR_OPEN = LIFECYCLE_STATES[4];
const REVIEW = LIFECYCLE_STATES[5];
const BLOCKED = LIFECYCLE_STATES[6];
const WAITING = LIFECYCLE_STATES[7];
const DONE = LIFECYCLE_STATES[8];
const NEW = LIFECYCLE_STATES[0];
const TRIAGED = LIFECYCLE_STATES[1];
const readinessMarker = "<!-- keiko-native-readiness -->";
const workflowActor = Object.freeze({
  id: 41898282,
  login: "github-actions[bot]",
  type: "Bot",
});

function ok(extra = {}) {
  return { ok: true, ...extra };
}

function fail(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

function trustedReadinessComment(comment) {
  return (
    comment?.body?.includes(readinessMarker) &&
    comment?.user?.id === workflowActor.id &&
    comment?.user?.login === workflowActor.login &&
    comment?.user?.type === workflowActor.type
  );
}

function markedComments(comments) {
  return comments.filter((comment) => comment?.body?.includes(readinessMarker));
}

function currentFingerprint(input) {
  return (
    input.currentFingerprint ??
    semanticIssueFingerprint(input.currentBody ?? "", input.currentTitle ?? "")
  );
}

function eventInvalidation(event) {
  if (event === undefined || event.action === undefined) return undefined;
  if (event.action === "closed") return "closed";
  if (event.action === "reopened") return "reopened";
  if (event.action === "edited") {
    if (event.editKind === "semantic") return "semantic_edit";
    if (event.editKind === "wording") return "wording_edit";
    return "unclassified_edit";
  }
  return undefined;
}

export function evaluateCurrentReadiness(input = {}) {
  const invalidation = eventInvalidation(input.event);
  if (invalidation !== undefined) return fail(invalidation);
  if (input.availability === "unreachable") return fail("unreachable");
  if (!Array.isArray(input.comments)) return fail("unavailable");

  const marked = markedComments(input.comments);
  const record = readinessRecordFromComments(input.comments);
  if (record === undefined)
    return fail(marked.length > 0 ? "forged" : "missing");
  if (record.status === undefined || record.version === undefined)
    return fail("malformed");
  if (record.fingerprint === undefined) return fail("malformed");
  if (record.status !== "accepted") return fail("superseded");
  if (input.expectedCommentId === undefined)
    return fail("missing", { field: "expectedCommentId", record });
  if (record.commentId !== input.expectedCommentId)
    return fail("replayed", { record });
  if (record.version !== input.currentVersion) return fail("stale", { record });
  if (record.fingerprint !== currentFingerprint(input))
    return fail("mismatched", { record });
  if (marked.some((comment) => !trustedReadinessComment(comment)))
    return fail("forged", { record });
  return ok({ current: true, record });
}

function requireCurrent(readiness) {
  return readiness?.current === true ? [] : ["current_readiness_required"];
}

function validEdge(source, target) {
  if (source === target) return [];
  return isAllowedLifecycleEdge(source, target)
    ? []
    : ["lifecycle_edge_not_allowed"];
}

function topologyResult(source, target, extra = {}) {
  const failures = validEdge(source, target);
  return failures.length > 0 ? fail(failures[0]) : ok({ target, ...extra });
}

export function evaluateClaimPrecondition({ claim, readiness, sourceState }) {
  const failures = [...requireCurrent(readiness)];
  if (sourceState !== READY) failures.push("ready_source_required");
  if (claim?.validated !== true) failures.push("validated_claim_required");
  return failures.length > 0
    ? fail(failures[0])
    : ok({ claimId: claim.id, target: IN_PROGRESS });
}

export function evaluateClaimRelease({
  hasOpenPullRequest,
  readiness,
  release,
  sourceState,
}) {
  const failures = requireCurrent(readiness);
  if (sourceState !== IN_PROGRESS) failures.push("in_progress_source_required");
  if (release?.validated !== true) failures.push("validated_release_required");
  if (hasOpenPullRequest === true) failures.push("open_pull_request_retained");
  if (hasOpenPullRequest === undefined)
    failures.push("pull_request_evidence_required");
  return failures.length > 0 ? fail(failures[0]) : ok({ target: READY });
}

export function evaluatePullRequestTopology({
  claim,
  event,
  otherOpenPullRequest,
  pullRequest,
  readiness,
  sourceState,
}) {
  const failures = requireCurrent(readiness);
  if (failures.length > 0) return fail(failures[0]);
  if (["opened", "reopened"].includes(event)) {
    if (pullRequest?.validated !== true) return fail("validated_pr_required");
    return topologyResult(sourceState, PR_OPEN, {
      pullRequestId: pullRequest.id,
    });
  }
  if (event === "ready_for_review") {
    if (pullRequest?.validated !== true) return fail("validated_pr_required");
    return topologyResult(sourceState, REVIEW, {
      pullRequestId: pullRequest.id,
    });
  }
  if (event !== "closed_unmerged") return fail("unsupported_pr_event");
  if (otherOpenPullRequest?.validated === true)
    return topologyResult(sourceState, PR_OPEN, {
      pullRequestId: otherOpenPullRequest.id,
    });
  if (claim === "unknown") return fail("claim_evidence_unavailable");
  return claim?.validated === true
    ? topologyResult(sourceState, IN_PROGRESS, { claimId: claim.id })
    : topologyResult(sourceState, READY);
}

export function evaluatePauseEntry({
  actorRole = "implementer",
  eventIdentity,
  reason,
  sourceState,
  targetState,
}) {
  const transition = validateTransitionRequest({
    actorRole,
    blockingCondition: targetState === BLOCKED ? reason : undefined,
    currentState: sourceState,
    eventIdentity,
    humanInput: targetState === WAITING ? reason : undefined,
    requestedSource: sourceState,
    requestedTarget: targetState,
  });
  return transition.ok
    ? ok({ suspendedSource: sourceState, target: targetState })
    : fail("pause_request_not_permitted", { failures: transition.failures });
}

export function evaluateResumePrecondition({
  claim,
  pauseEvidence,
  pullRequest,
  readiness,
}) {
  if (pauseEvidence?.validated !== true)
    return ok({
      target: pauseEvidence?.suspendedSource === TRIAGED ? TRIAGED : NEW,
    });
  if (readiness?.current !== true)
    return ok({
      target: pauseEvidence.suspendedSource === TRIAGED ? TRIAGED : NEW,
    });
  if (pullRequest?.validated === true) return ok({ target: PR_OPEN });
  if (claim?.validated === true) return ok({ target: IN_PROGRESS });
  return ok({ target: READY });
}

export function evaluateClosurePrecondition({ completionEvidence, reason }) {
  if (reason === "completed") {
    return completionEvidence?.validated === true
      ? ok({ target: DONE })
      : fail("completion_evidence_required");
  }
  if (["not_planned", "duplicate"].includes(reason))
    return ok({ removeLifecycleLabels: true, target: undefined });
  return fail("unsupported_closure_reason");
}

export function evaluateReopenPrecondition() {
  return ok({ restoreReadiness: false, target: NEW });
}

export function evaluateEditInvalidation({ editKind }) {
  if (editKind === "semantic")
    return ok({ reason: "semantic_edit", target: NEW });
  if (editKind === "wording")
    return ok({ reason: "wording_edit_requires_readiness", target: NEW });
  return fail("unknown_edit_kind");
}
