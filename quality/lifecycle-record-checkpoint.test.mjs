import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompactedPrefix,
  buildNullRootCompactedPrefix,
  verifyCheckpointEvidence,
} from "./lifecycle-record-checkpoint.mjs";

const sha = (digit) => digit.repeat(64);
const member = (comment_id, digit) => ({
  comment_id,
  record_digest: sha(digit),
});

test("builds the exact sequence-one null-root compacted prefix", () => {
  const result = buildNullRootCompactedPrefix({
    repository: "oscharko-dev/Keiko-Native",
    issueNumber: 51,
    checkpointSequence: 1,
    priorCheckpointIdentity: null,
    members: [member(1, "1"), member(2, "2")],
  });
  assert.match(result.identity, /^[0-9a-f]{64}$/u);
  assert.deepEqual(result.fields.members, [member(1, "1"), member(2, "2")]);
  assert.throws(
    () =>
      buildNullRootCompactedPrefix({
        repository: "oscharko-dev/Keiko-Native",
        issueNumber: 51,
        checkpointSequence: 2,
        priorCheckpointIdentity: null,
        members: [member(1, "1")],
      }),
    { code: "checkpoint-null-root-invalid" },
  );
});

test("rejects empty and duplicate compacted-prefix members", () => {
  const base = {
    repository: "oscharko-dev/Keiko-Native",
    issueNumber: 51,
    checkpointSequence: 1,
    priorCheckpointIdentity: null,
  };
  assert.throws(() => buildCompactedPrefix({ ...base, members: [] }), {
    code: "checkpoint-members-invalid",
  });
  assert.throws(
    () =>
      buildCompactedPrefix({
        ...base,
        members: [member(1, "1"), member(1, "2")],
      }),
    { code: "checkpoint-members-duplicate" },
  );
});

test("verifies genesis and incrementing checkpoint identities", () => {
  const input = {
    repository: "oscharko-dev/Keiko-Native",
    issueNumber: 51,
    compactedMembers: [member(1, "1")],
  };
  const compacted = buildNullRootCompactedPrefix({
    ...input,
    checkpointSequence: 1,
    priorCheckpointIdentity: null,
    members: input.compactedMembers,
  });
  const first = verifyCheckpointEvidence({
    ...input,
    commentId: 2,
    recordDigest: sha("2"),
    record: {
      record_type: "transition-read-back",
      checkpoint_sequence: 1,
      prior_checkpoint_comment_id: null,
      prior_checkpoint_record_digest: null,
      compacted_prefix_identity: compacted.identity,
    },
  });
  assert.equal(first.sequence, 1);
  const nextPrefix = buildCompactedPrefix({
    ...input,
    checkpointSequence: 2,
    priorCheckpointIdentity: first.identity,
    members: [member(3, "3")],
  });
  const second = verifyCheckpointEvidence({
    ...input,
    compactedMembers: [member(3, "3")],
    commentId: 4,
    recordDigest: sha("4"),
    priorCheckpoint: first,
    record: {
      record_type: "transition-read-back",
      checkpoint_sequence: 2,
      prior_checkpoint_comment_id: 2,
      prior_checkpoint_record_digest: sha("2"),
      compacted_prefix_identity: nextPrefix.identity,
    },
  });
  assert.equal(second.sequence, 2);
});

test("fails closed on wrong checkpoint type, sequence, or prefix", () => {
  const base = {
    repository: "oscharko-dev/Keiko-Native",
    issueNumber: 51,
    commentId: 2,
    recordDigest: sha("2"),
    compactedMembers: [member(1, "1")],
  };
  assert.throws(
    () =>
      verifyCheckpointEvidence({
        ...base,
        record: { record_type: "generation-request" },
      }),
    { code: "checkpoint-record-type-invalid" },
  );
  assert.throws(
    () =>
      verifyCheckpointEvidence({
        ...base,
        record: {
          record_type: "transition-read-back",
          checkpoint_sequence: 2,
          prior_checkpoint_comment_id: null,
          prior_checkpoint_record_digest: null,
          compacted_prefix_identity: sha("1"),
        },
      }),
    { code: "checkpoint-genesis-invalid" },
  );
});
