import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  decodeCanonical,
  encodeCanonical,
} from "./lifecycle-record-canonical.mjs";
import { digestAuxiliaryIdentity } from "./lifecycle-record-protocol.mjs";
import {
  GOVERNANCE_MAINTAINERS,
  isGovernanceMaintainerActor,
} from "./governance-maintainers.mjs";

export const LIFECYCLE_WAKE_REPOSITORY = "oscharko-dev/Keiko-Native";
export const LIFECYCLE_WAKE_CALLER = ".github/workflows/lifecycle-wakeup.yml";
export const LIFECYCLE_WAKE_COORDINATOR =
  ".github/workflows/issue-lifecycle.yml";
export const LIFECYCLE_WAKE_LOCATOR_ARTIFACT =
  "keiko-lifecycle-wake-locator-v1";
const LIFECYCLE_WAKE_REPOSITORY_API_URL =
  "https://api.github.com/repos/oscharko-dev/Keiko-Native";

export const LIFECYCLE_WAKE_SOURCE_WORKFLOWS = Object.freeze({
  ".github/workflows/contract-publication.yml": Object.freeze({
    event: "workflow_dispatch",
    name: "Contract publication (inert)",
    sourceClass: "governance",
  }),
  ".github/workflows/issue-readiness.yml": Object.freeze({
    event: "issues",
    name: "Issue readiness",
    sourceClass: "governance",
  }),
  ".github/workflows/pr-contract.yml": Object.freeze({
    event: "pull_request_target",
    name: "Pull request contract",
    sourceClass: "governance",
  }),
  ".github/workflows/ci.yml": Object.freeze({
    event: "pull_request",
    name: "CI",
    sourceClass: "evidence",
  }),
  ".github/workflows/codeql.yml": Object.freeze({
    event: "pull_request",
    name: "CodeQL",
    sourceClass: "evidence",
  }),
  ".github/workflows/dependency-review.yml": Object.freeze({
    event: "pull_request",
    name: "Dependency Review",
    sourceClass: "evidence",
  }),
  ".github/workflows/osv-scanner.yml": Object.freeze({
    event: "pull_request",
    name: "OSV dependency scan",
    sourceClass: "evidence",
  }),
});

export const LIFECYCLE_WAKE_ACTIVITY = Object.freeze({
  check_run: Object.freeze(["completed", "rerequested"]),
  issue_comment: Object.freeze(["created", "edited", "deleted"]),
  issues: Object.freeze([
    "assigned",
    "closed",
    "edited",
    "labeled",
    "reopened",
    "unassigned",
    "unlabeled",
  ]),
  pull_request_target: Object.freeze([
    "opened",
    "edited",
    "reopened",
    "synchronize",
    "ready_for_review",
    "converted_to_draft",
    "closed",
  ]),
  workflow_run: Object.freeze(["completed"]),
});

export const LIFECYCLE_WAKE_RESOLVER_BUDGETS = Object.freeze({
  evidence: 4,
  governance: 6,
  issue: 0,
  pullRequest: 2,
  schedule: 8,
});

export class LifecycleWakeError extends Error {
  constructor(code) {
    super(code);
    this.name = "LifecycleWakeError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new LifecycleWakeError(code);
};
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const commit = (value) =>
  typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
const canonicalCommentId = (value) =>
  typeof value === "string" &&
  /^[1-9][0-9]*$/u.test(value) &&
  positive(Number(value)) &&
  String(Number(value)) === value;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function validatedLifecycleWakeCommentId(value) {
  if (!positive(value)) fail("direct-locator-invalid");
  return value;
}

export function lifecycleWakeLocatorBytes(locator) {
  return encodeCanonical("lifecycle-wake-locator", locator);
}

export function parseLifecycleWakeLocator(bytes) {
  return decodeCanonical("lifecycle-wake-locator", bytes);
}

export function validateLifecycleWakeSource(
  run,
  locator,
  protectedCallerSha = undefined,
) {
  const expected = LIFECYCLE_WAKE_SOURCE_WORKFLOWS[run?.workflowPath];
  if (
    expected === undefined ||
    run?.repository !== LIFECYCLE_WAKE_REPOSITORY ||
    run?.name !== expected.name ||
    run?.event !== expected.event ||
    run?.status !== "completed" ||
    run?.id !== locator?.source_run_id ||
    run?.attempt !== locator?.source_run_attempt ||
    locator?.repository !== LIFECYCLE_WAKE_REPOSITORY ||
    locator?.source_workflow_path !== run.workflowPath
  )
    fail("source-run-mismatch");
  if (expected.sourceClass === "governance") {
    const protectedSha =
      expected.event === "pull_request_target"
        ? pullRequestTargetProtectedSha(run, locator, protectedCallerSha)
        : run.ref === "refs/heads/dev" && commit(run.headSha)
          ? run.headSha
          : undefined;
    if (
      !commit(locator.source_protected_dev_sha) ||
      protectedSha !== locator.source_protected_dev_sha
    )
      fail("governance-source-unprotected");
  }
  return expected.sourceClass;
}

function pullRequestTargetProtectedSha(run, locator, protectedCallerSha) {
  if (!Array.isArray(run.pullRequests) || run.pullRequests.length > 1)
    return undefined;
  if (run.pullRequests.length === 0)
    return positive(locator.pull_request_number) &&
      commit(protectedCallerSha) &&
      protectedCallerSha === locator.source_protected_dev_sha
      ? protectedCallerSha
      : undefined;
  const pullRequest = run.pullRequests[0];
  return positive(locator.pull_request_number) &&
    positive(pullRequest?.number) &&
    pullRequest.number === locator.pull_request_number &&
    pullRequest?.base?.repository === LIFECYCLE_WAKE_REPOSITORY_API_URL &&
    pullRequest?.base?.ref === "dev" &&
    commit(pullRequest?.base?.sha)
    ? pullRequest.base.sha
    : undefined;
}

export function directLifecycleWakeLocator({
  action,
  commentId = null,
  eventName,
  issueNumber,
  protectedDevSha,
  pullRequestNumber = null,
  recoveryCommentId = "",
  repository = LIFECYCLE_WAKE_REPOSITORY,
}) {
  const isComment = eventName === "issue_comment";
  const isPullRequestComment = isComment && pullRequestNumber !== null;
  const validatedCommentId = isComment
    ? validatedLifecycleWakeCommentId(commentId)
    : commentId;
  if (
    repository !== LIFECYCLE_WAKE_REPOSITORY ||
    !commit(protectedDevSha) ||
    !Object.hasOwn(LIFECYCLE_WAKE_ACTIVITY, eventName) ||
    !LIFECYCLE_WAKE_ACTIVITY[eventName].includes(action) ||
    !positive(issueNumber) ||
    (pullRequestNumber !== null && !positive(pullRequestNumber)) ||
    (!isComment && commentId !== null) ||
    (isPullRequestComment
      ? recoveryCommentId !== ""
      : isComment
        ? !canonicalCommentId(recoveryCommentId) ||
          recoveryCommentId !== String(validatedCommentId)
        : recoveryCommentId !== "")
  )
    fail("direct-locator-invalid");
  return Object.freeze({
    issue_number: issueNumber,
    protected_caller_sha: protectedDevSha,
    pull_request_number: pullRequestNumber,
    recovery_comment_id: recoveryCommentId,
    repository,
    source_event: eventName,
    source_run_attempt: null,
    source_run_id: null,
  });
}

export function boundedScheduledLocators(issueNumbers, requestCount) {
  if (
    !Number.isSafeInteger(requestCount) ||
    requestCount < 0 ||
    requestCount > LIFECYCLE_WAKE_RESOLVER_BUDGETS.schedule ||
    !Array.isArray(issueNumbers) ||
    issueNumbers.some((number) => !positive(number))
  )
    fail("schedule-enumeration-invalid");
  const sorted = [...new Set(issueNumbers)].sort((left, right) => left - right);
  if (sorted.length > 200) fail("schedule-locator-limit");
  return Object.freeze(
    sorted.map((issueNumber) =>
      Object.freeze({ issue_number: issueNumber, recovery_comment_id: "" }),
    ),
  );
}

const RECOVERY_COMMAND =
  /^\/keiko-native lifecycle-recovery v1 target=sha256:([0-9a-f]{64})$/u;

export function parseLifecycleRecoveryCommand(body) {
  if (
    typeof body !== "string" ||
    body !== body.normalize("NFC") ||
    body.includes("\r") ||
    body.includes("\n")
  )
    return undefined;
  return RECOVERY_COMMAND.exec(body)?.[1];
}

function neverEdited(comment) {
  return (
    comment?.createdAt === comment?.updatedAt &&
    comment?.lastEditedAt === null &&
    comment?.editor === null &&
    comment?.includesCreatedEdit === false
  );
}

export function authenticateLifecycleRecoveryComment({
  first,
  second,
  permissionFirst,
  permissionSecond,
  repositoryId,
  issueNumber,
}) {
  if (
    !isDeepStrictEqual(first, second) ||
    !positive(repositoryId) ||
    !positive(issueNumber) ||
    !positive(first?.id) ||
    first?.issueNumber !== issueNumber ||
    !neverEdited(first) ||
    !isGovernanceMaintainerActor(first?.author) ||
    !["maintain", "admin"].includes(permissionFirst) ||
    permissionFirst !== permissionSecond
  )
    fail("recovery-comment-unauthenticated");
  const target = parseLifecycleRecoveryCommand(first.body);
  if (target === undefined) fail("recovery-command-invalid");
  const fields = {
    repository_id: repositoryId,
    issue_number: issueNumber,
    comment_id: first.id,
    command_body_sha256: sha256(Buffer.from(first.body, "utf8")),
    comment_created_at: first.createdAt,
    author_id: first.author.id,
    author_type: first.author.type,
    recovery_target_identity: target,
  };
  return Object.freeze({
    fields: Object.freeze(fields),
    identity: digestAuxiliaryIdentity("authorized recovery request", fields),
    recoveryTargetIdentity: target,
  });
}

export function selectLifecycleRecoveryFallback(
  comments,
  permissionsByActorId,
) {
  if (!Array.isArray(comments) || comments.length > 200)
    fail("recovery-window-invalid");
  const allowlisted = new Set(GOVERNANCE_MAINTAINERS.map((entry) => entry.id));
  const candidates = comments.filter(
    (comment) =>
      positive(comment?.id) &&
      neverEdited(comment) &&
      parseLifecycleRecoveryCommand(comment.body) !== undefined &&
      comment?.author?.type === "User" &&
      allowlisted.has(comment?.author?.id) &&
      ["maintain", "admin"].includes(
        permissionsByActorId?.get(comment.author.id),
      ),
  );
  candidates.sort((left, right) => left.id - right.id);
  return candidates[0];
}

export function lifecycleRecoveryTargetAvailable(
  recoveryTargetIdentity,
  authenticatedRecords,
) {
  if (
    typeof recoveryTargetIdentity !== "string" ||
    !/^[0-9a-f]{64}$/u.test(recoveryTargetIdentity) ||
    !Array.isArray(authenticatedRecords)
  )
    fail("recovery-target-invalid");
  return !authenticatedRecords.some(
    (record) =>
      record?.recovery_target_identity === recoveryTargetIdentity &&
      typeof record?.authorized_request_identity === "string",
  );
}
