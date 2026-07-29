import assert from "node:assert/strict";
import test from "node:test";

import { digestAuxiliaryIdentity } from "./lifecycle-record-protocol.mjs";
import {
  advanceRecoveryAccumulator,
  recoveryScanIdentity,
  validateRecoveryResume,
  verifyAuthorizedOrphanSettlement,
} from "./lifecycle-record-recovery.mjs";

const sha = (digit) => digit.repeat(64);
const member = (id) => ({
  comment_id: id,
  comment_body_sha256: sha("1"),
  classification: "irrelevant",
  record_digest: null,
  artifact_anchor_identity: null,
  predecessor_comment_id: null,
  predecessor_record_digest: null,
});

test("advances root and resumed recovery accumulators with exact counts", () => {
  const first = advanceRecoveryAccumulator({
    repository: "oscharko-dev/Keiko-Native",
    issueNumber: 51,
    pageMembers: [member(9), member(8)],
    nextProviderCursor: "cursor-1",
  });
  assert.deepEqual(
    [
      first.fields.accumulator_step,
      first.fields.cumulative_member_count,
      first.fields.checkpoint_sequence,
      first.fields.complete,
    ],
    [1, 2, 0, false],
  );
  const second = advanceRecoveryAccumulator({
    repository: "oscharko-dev/Keiko-Native",
    issueNumber: 51,
    prior: first,
    pageMembers: [member(7)],
    nextProviderCursor: null,
    rootCheckpointSequence: 3,
  });
  assert.equal(second.fields.accumulator_step, 2);
  assert.equal(second.fields.cumulative_member_count, 3);
  assert.equal(second.fields.prior_accumulated_suffix_identity, first.identity);
  assert.equal(second.fields.checkpoint_sequence, 3);
  assert.equal(second.fields.complete, true);
  assert.match(
    recoveryScanIdentity({
      repository: "oscharko-dev/Keiko-Native",
      issueNumber: 51,
      accumulator: second,
    }),
    /^[0-9a-f]{64}$/u,
  );
});

test("rejects cursor/root mismatch and malformed or duplicate pages", () => {
  const base = {
    repository: "oscharko-dev/Keiko-Native",
    issueNumber: 51,
  };
  assert.throws(
    () =>
      advanceRecoveryAccumulator({
        ...base,
        pageMembers: [member(1)],
        nextProviderCursor: null,
      }),
    { code: "recovery-root-cursor-mismatch" },
  );
  assert.throws(
    () =>
      advanceRecoveryAccumulator({
        ...base,
        pageMembers: [member(1), member(1)],
        nextProviderCursor: "next",
      }),
    { code: "recovery-comment-duplicate" },
  );
  const invalid = { ...member(1), record_digest: sha("2") };
  assert.throws(
    () =>
      advanceRecoveryAccumulator({
        ...base,
        pageMembers: [invalid],
        nextProviderCursor: "next",
      }),
    { code: "recovery-member-invalid" },
  );
});

test("requires resume cursor, accumulator, step, and counts to match", () => {
  const accumulator = advanceRecoveryAccumulator({
    repository: "oscharko-dev/Keiko-Native",
    issueNumber: 51,
    pageMembers: [member(1)],
    nextProviderCursor: "opaque",
  });
  const claim = {
    recovery_scanned_page_count: 1,
    recovery_scanned_comment_count: 1,
    recovery_accumulated_suffix_identity: accumulator.identity,
    recovery_provider_cursor: "opaque",
    recovery_scan_complete: false,
  };
  assert.equal(
    validateRecoveryResume({ claim, accumulator, nextCursor: "opaque" }),
    true,
  );
  assert.throws(
    () =>
      validateRecoveryResume({
        claim: { ...claim, recovery_scanned_page_count: 2 },
        accumulator,
        nextCursor: "opaque",
      }),
    { code: "recovery-resume-discontinuity" },
  );
});

function orphan() {
  return {
    comment_id: 9,
    comment_body_sha256: sha("1"),
    record_digest: sha("2"),
    last_authenticated_comment_id: 8,
    last_authenticated_record_digest: sha("3"),
    author_login: "github-actions[bot]",
    author_id: 41898282,
    actor_type: "Bot",
    app_id: 15368,
    workflow_path: ".github/workflows/issue-lifecycle.yml",
    workflow_ref: "refs/heads/dev",
    workflow_run_id: 10,
    workflow_run_attempt: 1,
    protected_dev_sha: "a".repeat(40),
    run_conclusion: "failure",
    anchor_count: 0,
    attestation_count: 0,
  };
}

test("settles only an exact stable authorized pre-anchor orphan", () => {
  const value = orphan();
  const targetFields = {
    repository: "oscharko-dev/Keiko-Native",
    issue_number: 51,
    orphan_comment_id: value.comment_id,
    orphan_comment_body_sha256: value.comment_body_sha256,
    orphan_record_digest: value.record_digest,
    last_authenticated_comment_id: value.last_authenticated_comment_id,
    last_authenticated_record_digest: value.last_authenticated_record_digest,
  };
  const result = verifyAuthorizedOrphanSettlement({
    repository: "oscharko-dev/Keiko-Native",
    issueNumber: 51,
    authorizedRequestIdentity: sha("4"),
    expectedRecoveryTargetIdentity: digestAuxiliaryIdentity(
      "recovery target",
      targetFields,
    ),
    firstRead: value,
    secondRead: structuredClone(value),
  });
  assert.match(result.settlementIdentity, /^[0-9a-f]{64}$/u);
  assert.throws(
    () =>
      verifyAuthorizedOrphanSettlement({
        repository: "oscharko-dev/Keiko-Native",
        issueNumber: 51,
        authorizedRequestIdentity: sha("4"),
        expectedRecoveryTargetIdentity: result.targetIdentity,
        firstRead: value,
        secondRead: { ...value, run_conclusion: "success" },
      }),
    { code: "orphan-reread-unstable" },
  );
});

test("rejects successful, anchored, or wrong-request orphans", () => {
  for (const override of [
    { run_conclusion: "success" },
    { anchor_count: 1 },
    { app_id: 1 },
  ]) {
    const value = { ...orphan(), ...override };
    assert.throws(
      () =>
        verifyAuthorizedOrphanSettlement({
          repository: "oscharko-dev/Keiko-Native",
          issueNumber: 51,
          authorizedRequestIdentity: sha("4"),
          expectedRecoveryTargetIdentity: sha("5"),
          firstRead: value,
          secondRead: structuredClone(value),
        }),
      { code: "orphan-provider-facts-invalid" },
    );
  }
  const value = orphan();
  assert.throws(
    () =>
      verifyAuthorizedOrphanSettlement({
        repository: "oscharko-dev/Keiko-Native",
        issueNumber: 51,
        authorizedRequestIdentity: sha("4"),
        expectedRecoveryTargetIdentity: sha("5"),
        firstRead: value,
        secondRead: structuredClone(value),
      }),
    { code: "orphan-request-mismatch" },
  );
});
