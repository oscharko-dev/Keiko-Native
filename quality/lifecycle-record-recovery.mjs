import { isDeepStrictEqual } from "node:util";

import { digestAuxiliaryIdentity } from "./lifecycle-record-protocol.mjs";

export class LifecycleRecoveryError extends Error {
  constructor(code) {
    super(code);
    this.name = "LifecycleRecoveryError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new LifecycleRecoveryError(code);
};

function validateMember(member) {
  const authenticated = member?.classification === "authenticated-record";
  const irrelevant = member?.classification === "irrelevant";
  if (!authenticated && !irrelevant) fail("recovery-member-invalid");
  const recordFields = [
    "record_digest",
    "artifact_anchor_identity",
    "predecessor_comment_id",
    "predecessor_record_digest",
  ];
  if (irrelevant && recordFields.some((field) => member[field] !== null))
    fail("recovery-member-invalid");
  if (
    authenticated &&
    (typeof member.record_digest !== "string" ||
      typeof member.artifact_anchor_identity !== "string")
  )
    fail("recovery-member-invalid");
}

function validatePageMembers(members) {
  if (!Array.isArray(members) || members.length === 0)
    fail("recovery-page-empty");
  const ids = new Set();
  for (const member of members) {
    validateMember(member);
    if (ids.has(member.comment_id)) fail("recovery-comment-duplicate");
    ids.add(member.comment_id);
  }
}

export function advanceRecoveryAccumulator({
  repository,
  issueNumber,
  prior = null,
  pageMembers,
  nextProviderCursor,
  rootCheckpointSequence = null,
}) {
  validatePageMembers(pageMembers);
  const complete = nextProviderCursor === null;
  if (complete !== (rootCheckpointSequence !== null))
    fail("recovery-root-cursor-mismatch");
  const fields = Object.freeze({
    repository,
    issue_number: issueNumber,
    checkpoint_sequence: rootCheckpointSequence ?? 0,
    scan_direction: "backward",
    accumulator_step: (prior?.fields.accumulator_step ?? 0) + 1,
    prior_accumulated_suffix_identity: prior?.identity ?? null,
    page_members: structuredClone(pageMembers),
    cumulative_member_count:
      (prior?.fields.cumulative_member_count ?? 0) + pageMembers.length,
    next_provider_cursor: nextProviderCursor,
    complete,
  });
  return Object.freeze({
    fields,
    identity: digestAuxiliaryIdentity("recovery suffix accumulator", fields),
  });
}

export function recoveryScanIdentity({ repository, issueNumber, accumulator }) {
  const fields = {
    repository,
    issue_number: issueNumber,
    checkpoint_sequence: accumulator.fields.checkpoint_sequence,
    scan_direction: "backward",
    provider_cursor: accumulator.fields.next_provider_cursor,
    scanned_page_count: accumulator.fields.accumulator_step,
    scanned_comment_count: accumulator.fields.cumulative_member_count,
    accumulated_suffix_identity: accumulator.identity,
    complete: accumulator.fields.complete,
  };
  return digestAuxiliaryIdentity("recovery scan identity", fields);
}

export function validateRecoveryResume({ claim, accumulator, nextCursor }) {
  const fields = accumulator?.fields;
  if (
    claim?.recovery_scanned_page_count !== fields?.accumulator_step ||
    claim?.recovery_scanned_comment_count !== fields?.cumulative_member_count ||
    claim?.recovery_accumulated_suffix_identity !== accumulator?.identity ||
    claim?.recovery_provider_cursor !== fields?.next_provider_cursor ||
    claim?.recovery_scan_complete !== fields?.complete ||
    nextCursor !== fields?.next_provider_cursor
  )
    fail("recovery-resume-discontinuity");
  return true;
}

function exactOrphanActor(orphan) {
  return (
    orphan.author_login === "github-actions[bot]" &&
    orphan.author_id === 41898282 &&
    orphan.actor_type === "Bot" &&
    orphan.app_id === 15368 &&
    orphan.workflow_ref === "refs/heads/dev" &&
    ["failure", "cancelled", "timed-out"].includes(orphan.run_conclusion) &&
    orphan.anchor_count === 0 &&
    orphan.attestation_count === 0
  );
}

function settlementFields(
  repository,
  issueNumber,
  authorizedRequestIdentity,
  targetIdentity,
  orphan,
) {
  return {
    repository,
    issue_number: issueNumber,
    authorized_request_identity: authorizedRequestIdentity,
    recovery_target_identity: targetIdentity,
    orphan_comment_id: orphan.comment_id,
    orphan_comment_body_sha256: orphan.comment_body_sha256,
    orphan_record_digest: orphan.record_digest,
    orphan_author_login: orphan.author_login,
    orphan_author_id: orphan.author_id,
    orphan_actor_type: orphan.actor_type,
    orphan_app_id: orphan.app_id,
    orphan_workflow_path: orphan.workflow_path,
    orphan_workflow_run_id: orphan.workflow_run_id,
    orphan_workflow_run_attempt: orphan.workflow_run_attempt,
    orphan_protected_dev_sha: orphan.protected_dev_sha,
    orphan_run_conclusion: orphan.run_conclusion,
    orphan_anchor_count: 0,
    orphan_attestation_count: 0,
    last_authenticated_comment_id: orphan.last_authenticated_comment_id,
    last_authenticated_record_digest: orphan.last_authenticated_record_digest,
    quarantine_reason: "anchor-publication-interrupted",
  };
}

export function verifyAuthorizedOrphanSettlement({
  repository,
  issueNumber,
  authorizedRequestIdentity,
  expectedRecoveryTargetIdentity,
  firstRead,
  secondRead,
}) {
  if (!isDeepStrictEqual(firstRead, secondRead)) fail("orphan-reread-unstable");
  if (!exactOrphanActor(firstRead)) fail("orphan-provider-facts-invalid");
  const targetFields = {
    repository,
    issue_number: issueNumber,
    orphan_comment_id: firstRead.comment_id,
    orphan_comment_body_sha256: firstRead.comment_body_sha256,
    orphan_record_digest: firstRead.record_digest,
    last_authenticated_comment_id: firstRead.last_authenticated_comment_id,
    last_authenticated_record_digest:
      firstRead.last_authenticated_record_digest,
  };
  const targetIdentity = digestAuxiliaryIdentity(
    "recovery target",
    targetFields,
  );
  if (targetIdentity !== expectedRecoveryTargetIdentity)
    fail("orphan-request-mismatch");
  const fields = settlementFields(
    repository,
    issueNumber,
    authorizedRequestIdentity,
    targetIdentity,
    firstRead,
  );
  return Object.freeze({
    targetIdentity,
    settlementIdentity: digestAuxiliaryIdentity("recovery settlement", fields),
  });
}
