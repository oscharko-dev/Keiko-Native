import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  LIFECYCLE_PRODUCER_WIRE_FIELDS,
  validateLifecycleProducerWire,
  validLifecycleExactTarget,
} from "./lifecycle-producer-wire.mjs";

const generation = Buffer.from("record#0:", "utf8");
const sha = (value) => createHash("sha256").update(value).digest("hex");

function wire(overrides = {}) {
  return {
    schema_version: "1",
    producer_contract_version: "1",
    repository: "oscharko-dev/Keiko-Native",
    issue_number: "51",
    pull_request_number: "",
    exact_head_sha: "",
    exact_target: "dev",
    generation_bytes_base64: generation.toString("base64"),
    generation_bytes_sha256: sha(generation),
    generation_identity: "1".repeat(64),
    attempt: "0",
    phase_fence_comment_id: "101",
    phase_fence_digest: "2".repeat(64),
    generation_request_comment_id: "100",
    generation_request_digest: "3".repeat(64),
    request_identity: "4".repeat(64),
    request_payload_digest: "5".repeat(64),
    expected_producer: "issue-contract-current",
    ...overrides,
  };
}

test("accepts the exact ordered string-only bootstrap wire", () => {
  const input = wire();
  assert.deepEqual(Object.keys(input), LIFECYCLE_PRODUCER_WIRE_FIELDS);
  const result = validateLifecycleProducerWire(input, {
    acceptedTarget: "dev",
  });
  assert.equal(result.attempt, "0");
  assert.equal(result.producer_path, ".github/workflows/pr-contract.yml");
});

test("accepts only dev, canonical epic refs, and explicit null", () => {
  for (const target of ["", "dev", "epic/49", "epic/a_b/c.d-e"])
    assert.equal(validLifecycleExactTarget(target), true, target);
  for (const target of [
    "main",
    "feature/a",
    "refs/heads/epic/49",
    "epic/a..b",
    "epic/a.lock",
    "epic/a/b.lock",
    "epic/-a",
  ])
    assert.equal(validLifecycleExactTarget(target), false, target);
});

test("rejects missing, extra, reordered, non-string, malformed, and mismatched wire data", () => {
  const cases = [];
  const missing = wire();
  delete missing.expected_producer;
  cases.push(missing);
  cases.push({ extra: "", ...wire() });
  cases.push({ ...wire(), issue_number: 51 });
  cases.push(wire({ pull_request_number: "17" }));
  cases.push(wire({ exact_head_sha: "a".repeat(40) }));
  for (const [field, value] of [
    ["schema_version", "2"],
    ["producer_contract_version", "2"],
    ["repository", "attacker/repo"],
    ["issue_number", "01"],
    ["pull_request_number", "0"],
    ["exact_head_sha", "A".repeat(40)],
    ["exact_target", "epic/a..b"],
    ["attempt", "-1"],
    ["attempt", "01"],
    ["attempt", "9007199254740992"],
    ["phase_fence_comment_id", "0"],
    ["generation_identity", "A".repeat(64)],
    ["expected_producer", "caller-selected"],
  ])
    cases.push(wire({ [field]: value }));
  cases.push(wire({ generation_bytes_sha256: "0".repeat(64) }));
  for (const value of cases)
    assert.throws(() => validateLifecycleProducerWire(value));
});

test("requires target bytes to match accepted issue and provider base", () => {
  assert.throws(
    () =>
      validateLifecycleProducerWire(wire({ exact_target: "epic/49" }), {
        acceptedTarget: "epic/50",
      }),
    { code: "wire-accepted-target-mismatch" },
  );
  assert.throws(
    () =>
      validateLifecycleProducerWire(
        wire({
          exact_head_sha: "a".repeat(40),
          exact_target: "epic/49",
          pull_request_number: "17",
        }),
        {
          acceptedTarget: "epic/49",
          pullRequestBase: "epic/49/",
        },
      ),
    { code: "wire-provider-target-mismatch" },
  );
  const pullRequestWire = wire({
    exact_head_sha: "a".repeat(40),
    pull_request_number: "17",
  });
  assert.throws(
    () =>
      validateLifecycleProducerWire(pullRequestWire, {
        acceptedTarget: "dev",
      }),
    { code: "wire-provider-target-unavailable" },
  );
  assert.throws(
    () =>
      validateLifecycleProducerWire(wire(), {
        acceptedTarget: "dev",
        pullRequestBase: "dev",
      }),
    { code: "wire-provider-pull-request-mismatch" },
  );
  assert.equal(
    validateLifecycleProducerWire(pullRequestWire, {
      acceptedTarget: "dev",
      pullRequestBase: "dev",
    }).exact_target,
    "dev",
  );
});
