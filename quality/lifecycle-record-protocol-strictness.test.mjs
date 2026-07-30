import assert from "node:assert/strict";
import test from "node:test";

import {
  ProtocolValidationError,
  constantTimeDigestEqual,
  createRecordEnvelope,
  decodePrimaryRecord,
  digestRecordBytes,
  encodeAuxiliaryPreimage,
  encodePrimaryRecord,
  parseRecordEnvelope,
} from "./lifecycle-record-protocol.mjs";

const s = "1".repeat(64);
const s2 = "2".repeat(64);
const c = "a".repeat(40);
const request = {
  record_type: "generation-request",
  schema_version: 1,
  digest_algorithm: "sha-256",
  digest_domain: "keiko-native.lifecycle-record.generation-request",
  repository: "oscharko-dev/Keiko-Native",
  issue_number: 51,
  pull_request_number: 130,
  exact_head_sha: c,
  exact_target: "dev",
  lane: "normal",
  publication_submode: "ordinary",
  generation_schema: 1,
  generation_bytes_sha256: s,
  generation_identity: s,
  attempt: 1,
  request_identity: s2,
  request_payload_digest: s2,
  expected_producers: ["pr-contract"],
  source_observation_identity: s,
  predecessor_comment_id: null,
  predecessor_record_digest: null,
  workflow_path: ".github/workflows/issue-lifecycle.yml",
  workflow_run_id: 1,
  workflow_run_attempt: 1,
  protected_dev_sha: c,
  recorded_at: "2026-07-28T20:00:00Z",
};

test("rejects malformed UTF-8 and every envelope deviation", () => {
  const envelope = createRecordEnvelope("generation-request", request);
  const invalidUtf8 = Buffer.concat([
    Buffer.from(envelope.slice(0, 5)),
    Buffer.from([0xc3, 0x28]),
    Buffer.from(envelope.slice(5)),
  ]);
  assert.throws(
    () => parseRecordEnvelope(invalidUtf8),
    ProtocolValidationError,
  );
  const cases = [
    envelope.slice(0, -1),
    `prose\n${envelope}`,
    `${envelope}suffix`,
    envelope.replaceAll("\n", "\r\n"),
    envelope.replace("```text", "```json"),
    envelope.replace("Digest: sha-256:", "Digest: sha-512:"),
    envelope.replace(/[a-f0-9](?=\n```)/u, "A"),
    envelope.replace(/Digest: sha-256:[a-f0-9]/u, "Digest: sha-256:0"),
  ];
  for (const malformed of cases)
    assert.throws(
      () => parseRecordEnvelope(malformed),
      ProtocolValidationError,
    );
});

test("rejects missing, unknown, mistyped, unsafe, null, and oversized fields", () => {
  for (const changed of [
    { ...request, issue_number: undefined },
    { ...request, surprise: true },
    { ...request, issue_number: "51" },
    { ...request, issue_number: null },
    { ...request, issue_number: 0 },
    { ...request, issue_number: Number.MAX_SAFE_INTEGER + 1 },
    { ...request, exact_target: "a".repeat(4097) },
  ]) {
    assert.throws(
      () => encodePrimaryRecord("generation-request", changed),
      ProtocolValidationError,
    );
  }
  assert.throws(
    () =>
      encodePrimaryRecord("generation-request", {
        ...request,
        expected_producers: Array(257).fill("pr-contract"),
      }),
    ProtocolValidationError,
  );
});

test("rejects reordered canonical field nodes and trailing canonical bytes", () => {
  const bytes = encodePrimaryRecord("generation-request", request);
  const text = bytes.toString();
  const first = text.indexOf("field#");
  const second = text.indexOf("field#", first + 1);
  const third = text.indexOf("field#", second + 1);
  const reordered = Buffer.from(
    `${text.slice(0, first)}${text.slice(second, third)}${text.slice(first, second)}${text.slice(third)}`,
  );
  assert.throws(
    () => decodePrimaryRecord("generation-request", reordered),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      decodePrimaryRecord(
        "generation-request",
        Buffer.concat([bytes, Buffer.from("x")]),
      ),
    ProtocolValidationError,
  );
  for (const malformed of [
    Buffer.from("record#01:x"),
    Buffer.from("unknown#0:"),
    Buffer.from("record#999:x"),
  ]) {
    assert.throws(
      () => decodePrimaryRecord("generation-request", malformed),
      ProtocolValidationError,
    );
  }
  const malformedUtf8 = Buffer.from(bytes);
  malformedUtf8[malformedUtf8.indexOf(Buffer.from("oscharko"))] = 0xff;
  assert.throws(
    () => decodePrimaryRecord("generation-request", malformedUtf8),
    ProtocolValidationError,
  );
});

test("rejects CR, decomposed Unicode, duplicate normalized paths, and duplicate list identities", () => {
  const candidates = {
    exact_commit_sha: c,
    root_tree_sha: c,
    entries: [
      {
        path: "a",
        mode: "100644",
        blob_object_id: c,
        byte_count: 1,
        content_sha256: s,
      },
      {
        path: "b",
        mode: "100644",
        blob_object_id: c,
        byte_count: 1,
        content_sha256: s2,
      },
    ],
  };
  assert.doesNotThrow(() =>
    encodeAuxiliaryPreimage("publication candidate set", candidates),
  );
  for (const path of ["e\u0301", "a\r\nb"]) {
    const invalid = structuredClone(candidates);
    invalid.entries[1].path = path;
    assert.throws(
      () => encodeAuxiliaryPreimage("publication candidate set", invalid),
      ProtocolValidationError,
    );
  }
  const duplicate = structuredClone(candidates);
  duplicate.entries[1].path = "a";
  assert.throws(
    () => encodeAuxiliaryPreimage("publication candidate set", duplicate),
    ProtocolValidationError,
  );
  const prefix = {
    repository: "owner/repo",
    issue_number: 1,
    checkpoint_sequence: 1,
    prior_checkpoint_identity: null,
    members: [
      { comment_id: 1, record_digest: s },
      { comment_id: 1, record_digest: s2 },
    ],
  };
  assert.throws(
    () => encodeAuxiliaryPreimage("compacted prefix", prefix),
    ProtocolValidationError,
  );
});

test("enforces requested-state distinction and recovery discriminants", () => {
  const payload = {
    request_kind: "planner-request",
    requested_state: "no-lifecycle",
    request_owner: "planner",
    recovery_target_identity: null,
    reason_code: "ok",
  };
  assert.throws(
    () => encodeAuxiliaryPreimage("request payload", payload),
    ProtocolValidationError,
  );
  payload.requested_state = "status: triaged";
  payload.recovery_target_identity = s;
  assert.throws(
    () => encodeAuxiliaryPreimage("request payload", payload),
    ProtocolValidationError,
  );
  payload.request_kind = "recovery-request";
  assert.doesNotThrow(() =>
    encodeAuxiliaryPreimage("request payload", payload),
  );
  const observation = {
    generation_bytes_sha256: s,
    observed_state: "no-lifecycle",
    issue_updated_at: "2026-07-28T20:00:00Z",
    readiness_identity: null,
    assignment_identity: s,
    pr_topology_identity: s,
    reviews_identity: s,
    conversations_identity: s,
    checks_identity: s,
    evidence_identity: s,
    activation_identity: s,
  };
  assert.doesNotThrow(() =>
    encodeAuxiliaryPreimage("source observation", observation),
  );
});

test("accepts exact scalar and collection boundaries and rejects overflow", () => {
  const entry = (index) => ({
    path: `p${String(index).padStart(4, "0")}`,
    mode: "100644",
    blob_object_id: c,
    byte_count: 0,
    content_sha256: s,
  });
  const candidates = {
    exact_commit_sha: c,
    root_tree_sha: c,
    entries: Array.from({ length: 256 }, (_, index) => entry(index)),
  };
  assert.doesNotThrow(() =>
    encodeAuxiliaryPreimage("publication candidate set", candidates),
  );
  candidates.entries.push(entry(256));
  assert.throws(
    () => encodeAuxiliaryPreimage("publication candidate set", candidates),
    ProtocolValidationError,
  );
  const boundary = {
    exact_commit_sha: c,
    root_tree_sha: c,
    entries: [{ ...entry(1), path: "a".repeat(4096) }],
  };
  assert.doesNotThrow(() =>
    encodeAuxiliaryPreimage("publication candidate set", boundary),
  );
  boundary.entries[0].path += "a";
  assert.throws(
    () => encodeAuxiliaryPreimage("publication candidate set", boundary),
    ProtocolValidationError,
  );
});

test("rejects duplicate sets and producer/workflow mismatches", () => {
  assert.throws(
    () =>
      encodePrimaryRecord("generation-request", {
        ...request,
        expected_producers: ["pr-contract", "pr-contract"],
      }),
    ProtocolValidationError,
  );
  const result = {
    expected_producer: "contract-publication",
    producer_contract_version: 1,
    generation_identity: s,
    attempt: 1,
    phase_fence_digest: s,
    workflow_path: ".github/workflows/pr-contract.yml",
    workflow_id: 1,
    workflow_run_id: 1,
    workflow_run_attempt: 1,
    workflow_job_id: 1,
    provider_observation_identity: s,
    conclusion: "success",
    reason_code: "ok",
  };
  assert.throws(
    () => encodeAuxiliaryPreimage("result identity", result),
    ProtocolValidationError,
  );
});

test("rejects invalid public API inputs and caller-supplied identity headers", () => {
  assert.throws(() => digestRecordBytes(42), ProtocolValidationError);
  assert.throws(
    () => encodeAuxiliaryPreimage("unknown", {}),
    ProtocolValidationError,
  );
  assert.throws(
    () => encodeAuxiliaryPreimage("request payload", null),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      encodeAuxiliaryPreimage("request payload", {
        schema_version: 1,
      }),
    ProtocolValidationError,
  );
});

test("constant-time digest comparison validates both fixed-length digests", () => {
  assert.equal(constantTimeDigestEqual(s, s), true);
  assert.equal(constantTimeDigestEqual(s, s2), false);
  assert.equal(constantTimeDigestEqual("A".repeat(64), s), false);
  assert.equal(constantTimeDigestEqual("1".repeat(63), s), false);
});
