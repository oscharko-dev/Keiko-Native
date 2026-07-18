import assert from "node:assert/strict";
import test from "node:test";

import { semanticIssueFingerprint } from "./issue-contract.mjs";
import {
  evaluateClaimPrecondition,
  evaluateClaimRelease,
  evaluateClosurePrecondition,
  evaluateCurrentReadiness,
  evaluateEditInvalidation,
  evaluatePauseEntry,
  evaluatePullRequestTopology,
  evaluateReopenPrecondition,
  evaluateResumePrecondition,
} from "./issue-lifecycle-readiness.mjs";

const body = "## Planning contract\n\n- Contract version: `v2`\n";
const title = "Independent current readiness predicate";
const fingerprint = semanticIssueFingerprint(body, title);
const trustedUser = Object.freeze({
  id: 41898282,
  login: "github-actions[bot]",
  type: "Bot",
});

function readinessComment({
  id = 10,
  status = "accepted",
  user = trustedUser,
} = {}) {
  return {
    body: [
      "<!-- keiko-native-readiness -->",
      `- Status: \`${status}\``,
      "- Contract version: `v2`",
      `- Fingerprint: \`${fingerprint}\``,
    ].join("\n"),
    id,
    user,
  };
}

function readiness(overrides = {}) {
  return evaluateCurrentReadiness({
    comments: [readinessComment()],
    currentBody: body,
    currentTitle: title,
    currentVersion: "v2",
    expectedCommentId: 10,
    ...overrides,
  });
}

function assertReason(result, reason) {
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason);
}

test("accepts only the latest trusted matching readiness record", () => {
  assert.equal(readiness().current, true);
  assert.equal(readiness({ labels: ["status: new"] }).current, true);

  const forgedUser = { id: 1, login: "planner", type: "User" };
  const stale = readinessComment({ id: 11 });
  stale.body = stale.body.replace("`v2`", "`v1`");
  const mismatched = readinessComment({ id: 12 });
  mismatched.body = mismatched.body.replace(fingerprint, "b".repeat(64));
  const malformed = readinessComment({ id: 13 });
  malformed.body = malformed.body.replace(/^- Fingerprint:.*$/mu, "");

  assertReason(readiness({ comments: [] }), "missing");
  assertReason(
    readiness({ comments: [readinessComment({ user: forgedUser })] }),
    "forged",
  );
  assertReason(
    readiness({ comments: [readinessComment({ status: "rejected" })] }),
    "superseded",
  );
  assertReason(
    readiness({ comments: [stale], expectedCommentId: 11 }),
    "stale",
  );
  assertReason(
    readiness({ comments: [mismatched], expectedCommentId: 12 }),
    "mismatched",
  );
  assertReason(readiness({ expectedCommentId: undefined }), "missing");
  assertReason(readiness({ expectedCommentId: 999 }), "replayed");
  assertReason(
    readiness({ comments: [malformed], expectedCommentId: 13 }),
    "malformed",
  );
  assertReason(readiness({ availability: "unreachable" }), "unreachable");
  assertReason(readiness({ comments: undefined }), "unavailable");
});

test("does not infer readiness from labels and invalidates on closure, reopen, and edits", () => {
  assertReason(
    readiness({ comments: [], labels: ["status: ready"] }),
    "missing",
  );
  assertReason(readiness({ event: { action: "closed" } }), "closed");
  assertReason(readiness({ event: { action: "reopened" } }), "reopened");
  assertReason(
    readiness({ event: { action: "edited", editKind: "semantic" } }),
    "semantic_edit",
  );
  assertReason(
    readiness({ event: { action: "edited", editKind: "wording" } }),
    "wording_edit",
  );
  assertReason(readiness({ event: { action: "edited" } }), "unclassified_edit");
  assertReason(
    readiness({ event: { action: "edited", editKind: "unknown" } }),
    "unclassified_edit",
  );
  assert.equal(readiness({ event: { action: "assigned" } }).current, true);
  assert.deepEqual(evaluateEditInvalidation({ editKind: "semantic" }), {
    ok: true,
    reason: "semantic_edit",
    target: "status: new",
  });
  assert.deepEqual(evaluateEditInvalidation({ editKind: "wording" }), {
    ok: true,
    reason: "wording_edit_requires_readiness",
    target: "status: new",
  });
  assertReason(
    evaluateEditInvalidation({ editKind: "unknown" }),
    "unknown_edit_kind",
  );
});

test("requires validated claims and pull-request topology for active states", () => {
  const current = readiness();
  assert.deepEqual(
    evaluateClaimPrecondition({
      claim: { id: "claim-1", validated: true },
      readiness: current,
      sourceState: "status: ready",
    }),
    { claimId: "claim-1", ok: true, target: "status: in progress" },
  );
  assertReason(
    evaluateClaimPrecondition({
      claim: { validated: false },
      readiness: current,
      sourceState: "status: ready",
    }),
    "validated_claim_required",
  );
  assertReason(
    evaluateClaimPrecondition({
      claim: { id: "claim-1", validated: true },
      readiness: { ok: true },
      sourceState: "status: ready",
    }),
    "current_readiness_required",
  );
  assert.deepEqual(
    evaluateClaimRelease({
      hasOpenPullRequest: false,
      readiness: current,
      release: { id: "release-1", validated: true },
      sourceState: "status: in progress",
    }),
    { ok: true, target: "status: ready" },
  );
  assertReason(
    evaluateClaimRelease({
      hasOpenPullRequest: false,
      readiness: current,
      sourceState: "status: in progress",
    }),
    "validated_release_required",
  );
  assertReason(
    evaluateClaimRelease({
      hasOpenPullRequest: false,
      readiness: current,
      release: { validated: true },
      sourceState: "status: ready",
    }),
    "in_progress_source_required",
  );
  assertReason(
    evaluateClaimRelease({
      hasOpenPullRequest: true,
      readiness: current,
      release: { validated: true },
      sourceState: "status: in progress",
    }),
    "open_pull_request_retained",
  );
  assertReason(
    evaluateClaimRelease({
      readiness: current,
      release: { validated: true },
      sourceState: "status: in progress",
    }),
    "pull_request_evidence_required",
  );
});

test("evaluates PR open and unmerged-close recovery topology", () => {
  const current = readiness();
  assert.deepEqual(
    evaluatePullRequestTopology({
      event: "opened",
      pullRequest: { id: 36, validated: true },
      readiness: current,
      sourceState: "status: in progress",
    }),
    { ok: true, pullRequestId: 36, target: "status: pr open" },
  );
  assertReason(
    evaluatePullRequestTopology({
      event: "opened",
      pullRequest: { validated: false },
      readiness: current,
      sourceState: "status: in progress",
    }),
    "validated_pr_required",
  );
  assertReason(
    evaluatePullRequestTopology({
      event: "opened",
      pullRequest: { validated: true },
      readiness: { ok: true },
      sourceState: "status: in progress",
    }),
    "current_readiness_required",
  );
  assert.deepEqual(
    evaluatePullRequestTopology({
      claim: { id: "claim-1", validated: true },
      event: "closed_unmerged",
      readiness: current,
      sourceState: "status: pr open",
    }),
    { claimId: "claim-1", ok: true, target: "status: in progress" },
  );
  assert.equal(
    evaluatePullRequestTopology({
      claim: undefined,
      event: "closed_unmerged",
      readiness: current,
      sourceState: "status: pr open",
    }).target,
    "status: ready",
  );
  assert.equal(
    evaluatePullRequestTopology({
      event: "closed_unmerged",
      otherOpenPullRequest: { id: 41, validated: true },
      readiness: current,
      sourceState: "status: pr open",
    }).target,
    "status: pr open",
  );
  assertReason(
    evaluatePullRequestTopology({
      claim: "unknown",
      event: "closed_unmerged",
      readiness: current,
      sourceState: "status: pr open",
    }),
    "claim_evidence_unavailable",
  );
});

test("records paused sources and derives resume destinations without restoring review", () => {
  const current = readiness();
  assert.deepEqual(
    evaluatePauseEntry({
      eventIdentity: "event-1",
      reason: "dependency",
      sourceState: "status: ready",
      targetState: "status: blocked",
    }),
    { ok: true, suspendedSource: "status: ready", target: "status: blocked" },
  );
  assert.deepEqual(
    evaluatePauseEntry({
      eventIdentity: "event-2",
      reason: "scope answer needed",
      sourceState: "status: pr open",
      targetState: "status: waiting for user",
    }).target,
    "status: waiting for user",
  );
  assert.equal(
    evaluateResumePrecondition({
      pauseEvidence: { suspendedSource: "status: pr open", validated: true },
      pullRequest: { validated: true },
      readiness: current,
    }).target,
    "status: pr open",
  );
  assert.equal(
    evaluateResumePrecondition({
      claim: { validated: true },
      pauseEvidence: { suspendedSource: "status: ready", validated: true },
      readiness: current,
    }).target,
    "status: in progress",
  );
  assert.equal(
    evaluateResumePrecondition({
      pauseEvidence: { suspendedSource: "status: triaged", validated: true },
      readiness: { current: false },
    }).target,
    "status: triaged",
  );
  assert.equal(
    evaluateResumePrecondition({
      pauseEvidence: { suspendedSource: "status: ready", validated: false },
      readiness: current,
    }).target,
    "status: new",
  );
  assert.equal(
    evaluateResumePrecondition({ readiness: current }).target,
    "status: new",
  );
  assert.equal(
    evaluateResumePrecondition({
      pauseEvidence: { suspendedSource: "status: triaged", validated: false },
      readiness: current,
    }).target,
    "status: triaged",
  );
  assert.equal(
    evaluateResumePrecondition({
      pauseEvidence: {
        suspendedSource: "status: ready for human review",
        validated: true,
      },
      readiness: current,
    }).target,
    "status: ready",
  );
});

test("requires reason-aware closure evidence and reopens to new", () => {
  assert.deepEqual(
    evaluateClosurePrecondition({
      completionEvidence: { validated: true },
      reason: "completed",
    }),
    { ok: true, target: "status: done" },
  );
  assertReason(
    evaluateClosurePrecondition({ reason: "completed" }),
    "completion_evidence_required",
  );
  assert.deepEqual(evaluateClosurePrecondition({ reason: "not_planned" }), {
    ok: true,
    removeLifecycleLabels: true,
    target: undefined,
  });
  assert.deepEqual(evaluateClosurePrecondition({ reason: "duplicate" }), {
    ok: true,
    removeLifecycleLabels: true,
    target: undefined,
  });
  assertReason(
    evaluateClosurePrecondition({ reason: "unsupported" }),
    "unsupported_closure_reason",
  );
  assert.deepEqual(evaluateReopenPrecondition(), {
    ok: true,
    restoreReadiness: false,
    target: "status: new",
  });
});
