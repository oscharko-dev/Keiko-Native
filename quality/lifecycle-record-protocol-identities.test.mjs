import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AUXILIARY_IDENTITY_NAMES,
  ProtocolValidationError,
  digestAuxiliaryIdentity,
  encodeAuxiliaryPreimage,
} from "./lifecycle-record-protocol.mjs";

const s = "1".repeat(64);
const s2 = "2".repeat(64);
const c = "a".repeat(40);
const repo = "oscharko-dev/Keiko-Native";
const at = "2026-07-28T20:00:00Z";
const coord = ".github/workflows/issue-lifecycle.yml";
const producer = ".github/workflows/pr-contract.yml";
const member = {
  comment_id: 3,
  comment_body_sha256: s,
  classification: "irrelevant",
  record_digest: null,
  artifact_anchor_identity: null,
  predecessor_comment_id: null,
  predecessor_record_digest: null,
};

const fixtures = {
  "request identity": {
    repository: repo,
    issue_number: 51,
    pull_request_number: 130,
    exact_head_sha: c,
    exact_target: "dev",
    generation_identity: s,
    attempt: 1,
    request_payload_digest: s2,
    expected_producers: ["pr-contract"],
    predecessor_comment_id: null,
    predecessor_record_digest: null,
  },
  "request payload": {
    request_kind: "planner-request",
    requested_state: "status: triaged",
    request_owner: "planner",
    recovery_target_identity: null,
    reason_code: "ok",
  },
  "source observation": {
    generation_bytes_sha256: s,
    observed_state: "status: new",
    issue_updated_at: at,
    readiness_identity: s2,
    assignment_identity: s,
    pr_topology_identity: s,
    reviews_identity: s,
    conversations_identity: s,
    checks_identity: s,
    evidence_identity: s,
    activation_identity: s,
  },
  "fence identity": {
    generation_identity: s,
    attempt: 1,
    phase: "request",
    fence_sequence: 1,
    owner_workflow_path: coord,
    owner_run_id: 1,
    owner_run_attempt: 1,
    source_observation_identity: s2,
    predecessor_comment_id: null,
    predecessor_record_digest: null,
  },
  "result identity": {
    expected_producer: "issue-contract-current",
    producer_contract_version: 1,
    generation_identity: s,
    attempt: 1,
    phase_fence_digest: s2,
    workflow_path: producer,
    workflow_id: 1,
    workflow_run_id: 2,
    workflow_run_attempt: 1,
    workflow_job_id: 3,
    provider_observation_identity: s,
    conclusion: "success",
    reason_code: "ok",
  },
  "provider observation": {
    expected_producer: "issue-contract-current",
    generation_identity: s,
    exact_head_sha: c,
    phase_fence_digest: s2,
    provider_result_id: 1,
    provider_result_name: "Issue contract current",
    provider_result_conclusion: "success",
    provider_result_sha: c,
    producer_payload_digest: s,
  },
  "effect identity": {
    generation_identity: s,
    attempt: 1,
    phase_fence_digest: s2,
    source_state: "status: new",
    desired_state: "status: triaged",
    transition_owner: "request",
    mutation: "no-effect",
    source_observation_identity: s,
  },
  "read-back identity": {
    generation_identity: s,
    attempt: 1,
    phase_fence_digest: s2,
    effect_identity: null,
    observed_state: "status: new",
    issue_updated_at: at,
    source_observation_identity: s,
  },
  "publication candidate set": {
    exact_commit_sha: c,
    root_tree_sha: "b".repeat(40),
    entries: [
      {
        path: "AGENTS.md",
        mode: "100644",
        blob_object_id: c,
        byte_count: 10,
        content_sha256: s,
      },
      {
        path: "docs/é.md",
        mode: "100755",
        blob_object_id: c,
        byte_count: 20,
        content_sha256: s2,
      },
    ],
  },
  "compacted prefix": {
    repository: repo,
    issue_number: 51,
    checkpoint_sequence: 1,
    prior_checkpoint_identity: null,
    members: [
      { comment_id: 1, record_digest: s },
      { comment_id: 2, record_digest: s2 },
    ],
  },
  "checkpoint identity": {
    repository: repo,
    issue_number: 51,
    checkpoint_sequence: 1,
    prior_checkpoint_comment_id: null,
    prior_checkpoint_record_digest: null,
    compacted_prefix_identity: s,
    chain_tip_comment_id: 2,
    chain_tip_record_digest: s2,
  },
  "recovery suffix accumulator": {
    repository: repo,
    issue_number: 51,
    checkpoint_sequence: 0,
    scan_direction: "backward",
    accumulator_step: 1,
    prior_accumulated_suffix_identity: null,
    page_members: [member],
    cumulative_member_count: 1,
    next_provider_cursor: "cursor",
    complete: false,
  },
  "recovery scan identity": {
    repository: repo,
    issue_number: 51,
    checkpoint_sequence: 0,
    scan_direction: "backward",
    provider_cursor: "cursor",
    scanned_page_count: 1,
    scanned_comment_count: 1,
    accumulated_suffix_identity: s,
    complete: false,
  },
  "recovery target": {
    repository: repo,
    issue_number: 51,
    orphan_comment_id: 10,
    orphan_comment_body_sha256: s,
    orphan_record_digest: s2,
    last_authenticated_comment_id: null,
    last_authenticated_record_digest: null,
  },
  "recovery settlement": {
    repository: repo,
    issue_number: 51,
    authorized_request_identity: s,
    recovery_target_identity: s2,
    orphan_comment_id: 10,
    orphan_comment_body_sha256: s,
    orphan_record_digest: s2,
    orphan_author_login: "github-actions[bot]",
    orphan_author_id: 41898282,
    orphan_actor_type: "Bot",
    orphan_app_id: 15368,
    orphan_workflow_path: coord,
    orphan_workflow_run_id: 1,
    orphan_workflow_run_attempt: 1,
    orphan_protected_dev_sha: c,
    orphan_run_conclusion: "failure",
    orphan_anchor_count: 0,
    orphan_attestation_count: 0,
    last_authenticated_comment_id: null,
    last_authenticated_record_digest: null,
    quarantine_reason: "anchor-publication-interrupted",
  },
  "authorized recovery request": {
    repository_id: 123,
    issue_number: 51,
    comment_id: 101,
    command_body_sha256: s,
    comment_created_at: "2026-07-29T10:00:00Z",
    author_id: 159039192,
    author_type: "User",
    recovery_target_identity: s2,
  },
  "artifact anchor": {
    repository: repo,
    issue_number: 51,
    record_type: "generation-request",
    record_digest: s,
    comment_id: 100,
    comment_body_sha256: s2,
    generation_identity: s,
    attempt: 1,
    workflow_path: coord,
    workflow_run_id: 1,
    workflow_run_attempt: 1,
    protected_dev_sha: c,
  },
};

for (const name of AUXILIARY_IDENTITY_NAMES) {
  test(`${name} has exact domain-separated v1 bytes and digest`, () => {
    const encoded = encodeAuxiliaryPreimage(name, fixtures[name]);
    assert.ok(encoded.length > 0);
    assert.equal(
      digestAuxiliaryIdentity(name, fixtures[name]),
      createHash("sha256").update(encoded).digest("hex"),
    );
  });
}

test("request payload preimage has exact ADR-0004 typed header bytes", () => {
  const bytes = encodeAuxiliaryPreimage(
    "request payload",
    fixtures["request payload"],
  );
  assert.match(
    bytes.toString(),
    /^record#[0-9]+:field#[0-9]+:string#13:digest_domainenum#38:keiko-native\.lifecycle-request-payload/u,
  );
  assert.ok(
    bytes.includes(Buffer.from("field#32:string#14:schema_versionuint#1:1")),
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "1607f2ca1a2dd1fdd940d01e6d2f1efa4dc1c820172c9e60a5fbeedc27991c77",
  );
});

test("recovery sequence zero is required while scan is incomplete", () => {
  for (const name of [
    "recovery suffix accumulator",
    "recovery scan identity",
  ]) {
    assert.doesNotThrow(() => encodeAuxiliaryPreimage(name, fixtures[name]));
    assert.throws(
      () =>
        encodeAuxiliaryPreimage(name, {
          ...fixtures[name],
          checkpoint_sequence: 1,
        }),
      ProtocolValidationError,
    );
  }
});

test("recovery settlement has one exact orphan record digest field", () => {
  const text = encodeAuxiliaryPreimage(
    "recovery settlement",
    fixtures["recovery settlement"],
  ).toString();
  assert.equal(text.match(/string#20:orphan_record_digest/gu)?.length, 1);
});

test("recovery accumulator rejects empty and duplicate page identities", () => {
  const fixture = fixtures["recovery suffix accumulator"];
  assert.throws(
    () =>
      encodeAuxiliaryPreimage("recovery suffix accumulator", {
        ...fixture,
        page_members: [],
      }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      encodeAuxiliaryPreimage("recovery suffix accumulator", {
        ...fixture,
        page_members: [member, { ...member }],
        cumulative_member_count: 2,
      }),
    ProtocolValidationError,
  );
});

test("recovery member classification fixes null and authenticated shapes", () => {
  const fixture = fixtures["recovery suffix accumulator"];
  assert.throws(
    () =>
      encodeAuxiliaryPreimage("recovery suffix accumulator", {
        ...fixture,
        page_members: [{ ...member, record_digest: s }],
      }),
    ProtocolValidationError,
  );
  assert.doesNotThrow(() =>
    encodeAuxiliaryPreimage("recovery suffix accumulator", {
      ...fixture,
      page_members: [
        {
          ...member,
          classification: "authenticated-record",
          record_digest: s,
          artifact_anchor_identity: s2,
        },
      ],
    }),
  );
});
