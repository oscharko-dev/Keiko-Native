import { digestAuxiliaryIdentity } from "./lifecycle-record-protocol.mjs";

export class LifecycleCheckpointError extends Error {
  constructor(code) {
    super(code);
    this.name = "LifecycleCheckpointError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new LifecycleCheckpointError(code);
};

function validMember(member) {
  return (
    Number.isSafeInteger(member?.comment_id) &&
    member.comment_id > 0 &&
    /^[0-9a-f]{64}$/u.test(member?.record_digest)
  );
}

function assertUniqueMembers(members) {
  if (!Array.isArray(members) || members.length === 0)
    fail("checkpoint-members-invalid");
  const comments = new Set();
  const digests = new Set();
  for (const member of members) {
    if (!validMember(member)) fail("checkpoint-members-invalid");
    if (comments.has(member.comment_id) || digests.has(member.record_digest))
      fail("checkpoint-members-duplicate");
    comments.add(member.comment_id);
    digests.add(member.record_digest);
  }
}

export function buildCompactedPrefix({
  repository,
  issueNumber,
  checkpointSequence,
  priorCheckpointIdentity,
  members,
}) {
  assertUniqueMembers(members);
  const fields = Object.freeze({
    repository,
    issue_number: issueNumber,
    checkpoint_sequence: checkpointSequence,
    prior_checkpoint_identity: priorCheckpointIdentity,
    members: structuredClone(members),
  });
  return Object.freeze({
    fields,
    identity: digestAuxiliaryIdentity("compacted prefix", fields),
  });
}

export function buildNullRootCompactedPrefix(input) {
  if (input.checkpointSequence !== 1 || input.priorCheckpointIdentity !== null)
    fail("checkpoint-null-root-invalid");
  return buildCompactedPrefix(input);
}

function expectedSequence(record, priorCheckpoint) {
  if (priorCheckpoint === null) {
    if (
      record.checkpoint_sequence !== 1 ||
      record.prior_checkpoint_comment_id !== null ||
      record.prior_checkpoint_record_digest !== null
    )
      fail("checkpoint-genesis-invalid");
    return;
  }
  if (
    record.checkpoint_sequence !== priorCheckpoint.sequence + 1 ||
    record.prior_checkpoint_comment_id !== priorCheckpoint.commentId ||
    record.prior_checkpoint_record_digest !== priorCheckpoint.recordDigest
  )
    fail("checkpoint-sequence-invalid");
}

export function verifyCheckpointEvidence({
  repository,
  issueNumber,
  record,
  commentId,
  recordDigest,
  priorCheckpoint = null,
  compactedMembers,
}) {
  if (record.record_type !== "transition-read-back")
    fail("checkpoint-record-type-invalid");
  expectedSequence(record, priorCheckpoint);
  const compacted = buildCompactedPrefix({
    repository,
    issueNumber,
    checkpointSequence: record.checkpoint_sequence,
    priorCheckpointIdentity: priorCheckpoint?.identity ?? null,
    members: compactedMembers,
  });
  if (compacted.identity !== record.compacted_prefix_identity)
    fail("checkpoint-prefix-mismatch");
  const fields = {
    repository,
    issue_number: issueNumber,
    checkpoint_sequence: record.checkpoint_sequence,
    prior_checkpoint_comment_id: record.prior_checkpoint_comment_id,
    prior_checkpoint_record_digest: record.prior_checkpoint_record_digest,
    compacted_prefix_identity: compacted.identity,
    chain_tip_comment_id: commentId,
    chain_tip_record_digest: recordDigest,
  };
  return Object.freeze({
    commentId,
    recordDigest,
    sequence: record.checkpoint_sequence,
    compactedPrefixIdentity: compacted.identity,
    identity: digestAuxiliaryIdentity("checkpoint identity", fields),
  });
}
