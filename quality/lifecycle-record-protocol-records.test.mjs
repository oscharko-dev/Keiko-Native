import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  LIFECYCLE_OBSERVATIONS,
  PRODUCERS,
  RECORD_MARKERS,
  RECORD_TYPES,
  REQUESTED_LIFECYCLE_STATES,
  createRecordEnvelope,
  decodePrimaryRecord,
  digestRecordBytes,
  encodePrimaryRecord,
  parseRecordEnvelope,
} from "./lifecycle-record-protocol.mjs";

const sha = "1".repeat(64);
const sha2 = "2".repeat(64);
const sha3 = "3".repeat(64);
const commit = "a".repeat(40);
const at = "2026-07-28T20:00:00Z";
const coordinator = ".github/workflows/issue-lifecycle.yml";
const common = {
  repository: "oscharko-dev/Keiko-Native",
  issue_number: 51,
  pull_request_number: 130,
  exact_head_sha: commit,
  exact_target: "dev",
  generation_identity: sha,
  attempt: 1,
  request_identity: sha2,
};

const references = [
  {
    producer: "pr-contract",
    comment_id: 103,
    record_digest: sha2,
    workflow_run_id: 42,
    workflow_job_id: 43,
    result_identity: sha3,
  },
  {
    producer: "issue-contract-current",
    comment_id: 102,
    record_digest: sha,
    workflow_run_id: 40,
    workflow_job_id: 41,
    result_identity: sha2,
  },
];

const fixtures = {
  "generation-request": {
    record_type: "generation-request",
    schema_version: 1,
    digest_algorithm: "sha-256",
    digest_domain: "keiko-native.lifecycle-record.generation-request",
    ...common,
    lane: "normal",
    publication_submode: "ordinary",
    generation_schema: 1,
    generation_bytes_sha256: sha3,
    request_payload_digest: sha3,
    expected_producers: ["pr-contract", "issue-contract-current"],
    source_observation_identity: sha,
    predecessor_comment_id: null,
    predecessor_record_digest: null,
    workflow_path: coordinator,
    workflow_run_id: 10,
    workflow_run_attempt: 1,
    protected_dev_sha: commit,
    recorded_at: at,
  },
  "producer-result": {
    record_type: "producer-result",
    schema_version: 1,
    digest_algorithm: "sha-256",
    digest_domain: "keiko-native.lifecycle-record.producer-result",
    ...common,
    generation_request_comment_id: 100,
    generation_request_digest: sha3,
    phase_fence_comment_id: 101,
    phase_fence_digest: sha,
    expected_producer: "issue-contract-current",
    producer_contract_version: 1,
    workflow_path: ".github/workflows/pr-contract.yml",
    workflow_id: 20,
    workflow_run_id: 21,
    workflow_run_attempt: 1,
    workflow_job_id: 22,
    result_identity: sha2,
    protected_dev_sha: commit,
    provider_observation_identity: sha3,
    conclusion: "success",
    reason_code: "ok",
    predecessor_comment_id: 101,
    predecessor_record_digest: sha,
    recorded_at: at,
  },
  "phase-fence-claim": {
    record_type: "phase-fence-claim",
    schema_version: 1,
    digest_algorithm: "sha-256",
    digest_domain: "keiko-native.lifecycle-record.phase-fence-claim",
    repository: common.repository,
    issue_number: 51,
    pull_request_number: 130,
    exact_head_sha: commit,
    generation_identity: sha,
    attempt: 1,
    request_identity: sha2,
    phase: "phase-one",
    fence_sequence: 1,
    fence_identity: sha3,
    owner_workflow_path: coordinator,
    owner_run_id: 30,
    owner_run_attempt: 1,
    source_observation_identity: sha,
    claim_outcome: "claimed",
    recovery_scan_identity: null,
    recovery_scanned_page_count: 0,
    recovery_scanned_comment_count: 0,
    recovery_accumulated_suffix_identity: null,
    recovery_provider_cursor: null,
    recovery_scan_complete: false,
    recovery_settlement_identity: null,
    predecessor_comment_id: 100,
    predecessor_record_digest: sha,
    protected_dev_sha: commit,
    recorded_at: at,
  },
  "transition-read-back": {
    record_type: "transition-read-back",
    schema_version: 1,
    digest_algorithm: "sha-256",
    digest_domain: "keiko-native.lifecycle-record.transition-read-back",
    ...common,
    phase_fence_comment_id: 101,
    phase_fence_digest: sha,
    source_state: "status: pr open",
    desired_state: "status: ready for human review",
    observed_state: "status: pr open",
    transition_owner: "handoff",
    effect_identity: null,
    read_back_identity: sha3,
    producer_results: references,
    checkpoint_sequence: 1,
    prior_checkpoint_comment_id: null,
    prior_checkpoint_record_digest: null,
    compacted_prefix_identity: sha,
    outcome: "planned",
    reason_code: "activation-disabled",
    predecessor_comment_id: 103,
    predecessor_record_digest: sha3,
    protected_dev_sha: commit,
    recorded_at: at,
  },
};

test("exports four records, nine request states, and the outside observation", () => {
  assert.equal(RECORD_TYPES.length, 4);
  assert.equal(PRODUCERS.length, 3);
  assert.equal(REQUESTED_LIFECYCLE_STATES.length, 9);
  assert.deepEqual(LIFECYCLE_OBSERVATIONS, [
    ...REQUESTED_LIFECYCLE_STATES,
    "no-lifecycle",
  ]);
  assert.equal(REQUESTED_LIFECYCLE_STATES.includes("no-lifecycle"), false);
});

for (const recordType of RECORD_TYPES) {
  test(`${recordType} canonical record and full envelope round trip`, () => {
    const fixture = fixtures[recordType];
    const bytes = encodePrimaryRecord(recordType, fixture);
    assert.deepEqual(decodePrimaryRecord(recordType, bytes), fixture);
    const parsed = parseRecordEnvelope(
      Buffer.from(createRecordEnvelope(recordType, fixture)),
    );
    assert.equal(parsed.recordType, recordType);
    assert.equal(parsed.marker, RECORD_MARKERS[recordType]);
    assert.deepEqual(parsed.fields, fixture);
    assert.deepEqual(parsed.recordBytes, bytes);
    assert.equal(parsed.recordDigest, digestRecordBytes(bytes));
    assert.equal(
      parsed.recordDigest,
      createHash("sha256").update(bytes).digest("hex"),
    );
  });
}

test("canonical set order is encoded-node order, independent of caller order", () => {
  const request = structuredClone(fixtures["generation-request"]);
  request.expected_producers.reverse();
  assert.deepEqual(
    encodePrimaryRecord("generation-request", request),
    encodePrimaryRecord("generation-request", fixtures["generation-request"]),
  );
  const transition = structuredClone(fixtures["transition-read-back"]);
  transition.producer_results.reverse();
  assert.deepEqual(
    encodePrimaryRecord("transition-read-back", transition),
    encodePrimaryRecord(
      "transition-read-back",
      fixtures["transition-read-back"],
    ),
  );
});

test("phase recovery accepts only incomplete, complete, or settlement tuples", () => {
  const claim = structuredClone(fixtures["phase-fence-claim"]);
  Object.assign(claim, {
    phase: "recovery",
    recovery_scan_identity: sha,
    recovery_scanned_page_count: 1,
    recovery_scanned_comment_count: 1,
    recovery_accumulated_suffix_identity: sha2,
    recovery_provider_cursor: "cursor",
  });
  assert.doesNotThrow(() => encodePrimaryRecord("phase-fence-claim", claim));
  claim.recovery_scan_complete = true;
  assert.throws(() => encodePrimaryRecord("phase-fence-claim", claim));
  claim.recovery_provider_cursor = null;
  assert.doesNotThrow(() => encodePrimaryRecord("phase-fence-claim", claim));
  Object.assign(claim, {
    recovery_scan_identity: null,
    recovery_scanned_page_count: 0,
    recovery_scanned_comment_count: 0,
    recovery_accumulated_suffix_identity: null,
    recovery_scan_complete: false,
    recovery_settlement_identity: sha3,
  });
  assert.doesNotThrow(() => encodePrimaryRecord("phase-fence-claim", claim));
});
