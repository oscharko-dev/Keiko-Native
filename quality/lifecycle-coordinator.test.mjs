import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  lifecycleCoordinatorFacts,
  planInertLifecycleCoordinatorStep,
  planInertLifecycleRecoverySettlement,
} from "./lifecycle-coordinator.mjs";
import {
  createRecordEnvelope,
  parseRecordEnvelope,
} from "./lifecycle-record-protocol.mjs";

const commit = "a".repeat(40);
const digest = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
const runtime = {
  recordedAt: "2026-07-29T12:00:00Z",
  runAttempt: 1,
  runId: 900,
};
const issue = {
  body: [
    "## Planning contract",
    "",
    "- Contract version: `v1`",
    "",
    "## Execution Authority",
    "",
    "- Exact delivery target: `dev`",
  ].join("\n"),
  id: 51,
  labels: [{ name: "type: task" }, { name: "status: ready" }],
  number: 51,
  title: "Protected lifecycle fixture",
  updated_at: "2026-07-29T11:59:00Z",
};

function record(body, id) {
  return {
    comment: { id },
    parsed: parseRecordEnvelope(body),
  };
}

function producerBody(request, fence) {
  const generation = request.parsed.fields;
  return createRecordEnvelope("producer-result", {
    record_type: "producer-result",
    schema_version: 1,
    digest_algorithm: "sha-256",
    digest_domain: "keiko-native.lifecycle-record.producer-result",
    repository: "oscharko-dev/Keiko-Native",
    issue_number: 51,
    pull_request_number: null,
    exact_head_sha: null,
    exact_target: "dev",
    generation_identity: generation.generation_identity,
    attempt: generation.attempt,
    request_identity: generation.request_identity,
    generation_request_comment_id: request.comment.id,
    generation_request_digest: request.parsed.recordDigest,
    phase_fence_comment_id: fence.comment.id,
    phase_fence_digest: fence.parsed.recordDigest,
    expected_producer: "issue-contract-current",
    producer_contract_version: 1,
    workflow_path: ".github/workflows/pr-contract.yml",
    workflow_id: 100,
    workflow_run_id: 900,
    workflow_run_attempt: 1,
    workflow_job_id: 901,
    result_identity: digest("result"),
    protected_dev_sha: commit,
    provider_observation_identity: digest("provider"),
    conclusion: "success",
    reason_code: "ok",
    predecessor_comment_id: fence.comment.id,
    predecessor_record_digest: fence.parsed.recordDigest,
    recorded_at: "2026-07-29T12:02:00Z",
  });
}

test("advances one authenticated inert record obligation per wake", () => {
  const facts = lifecycleCoordinatorFacts({
    comments: [],
    issue,
    protectedDevSha: commit,
  });
  const first = planInertLifecycleCoordinatorStep({
    facts,
    records: [],
    recoveryAttempt: 1,
    runtime,
  });
  assert.equal(first.kind, "record");
  assert.equal(first.writer, "coordinator");
  const firstPlan = JSON.parse(
    Buffer.from(first.recordPlan, "base64url").toString("utf8"),
  );
  const request = record(firstPlan.recordBody, 100);
  assert.equal(request.parsed.recordType, "generation-request");
  assert.deepEqual(request.parsed.fields.expected_producers, [
    "issue-contract-current",
  ]);

  const second = planInertLifecycleCoordinatorStep({
    facts,
    records: [request],
    runtime: { ...runtime, runId: 901 },
  });
  const secondPlan = JSON.parse(
    Buffer.from(second.recordPlan, "base64url").toString("utf8"),
  );
  const fence = record(secondPlan.recordBody, 101);
  assert.equal(fence.parsed.recordType, "phase-fence-claim");

  const third = planInertLifecycleCoordinatorStep({
    facts,
    records: [request, fence],
    runtime: { ...runtime, runId: 902 },
  });
  assert.equal(third.kind, "producer");
  assert.equal(third.producer, "issue-contract-current");
  assert.equal(third.wire.attempt, "0");
  assert.equal(third.wire.phase_fence_comment_id, "101");

  const producer = record(producerBody(request, fence), 102);
  const fourth = planInertLifecycleCoordinatorStep({
    facts,
    records: [request, fence, producer],
    runtime: { ...runtime, runId: 903 },
  });
  const fourthPlan = JSON.parse(
    Buffer.from(fourth.recordPlan, "base64url").toString("utf8"),
  );
  const transition = record(fourthPlan.recordBody, 103);
  assert.equal(transition.parsed.recordType, "transition-read-back");
  assert.equal(transition.parsed.fields.outcome, "planned");
  assert.equal(transition.parsed.fields.reason_code, "activation-disabled");
  assert.equal(transition.parsed.fields.effect_identity, null);

  const fifth = planInertLifecycleCoordinatorStep({
    facts,
    records: [request, fence, producer, transition],
    runtime: { ...runtime, runId: 904 },
  });
  assert.equal(fifth.kind, "noop");
  assert.match(fifth.observation, /^[0-9a-f]{64}$/u);
});

test("changes in authenticated provider facts begin a new generation", () => {
  const initialFacts = lifecycleCoordinatorFacts({
    comments: [],
    issue,
    protectedDevSha: commit,
  });
  const first = planInertLifecycleCoordinatorStep({
    facts: initialFacts,
    records: [],
    runtime,
  });
  const requestPlan = JSON.parse(
    Buffer.from(first.recordPlan, "base64url").toString("utf8"),
  );
  const request = record(requestPlan.recordBody, 100);
  const fenceStep = planInertLifecycleCoordinatorStep({
    facts: initialFacts,
    records: [request],
    runtime: { ...runtime, runId: 901 },
  });
  const fencePlan = JSON.parse(
    Buffer.from(fenceStep.recordPlan, "base64url").toString("utf8"),
  );
  const fence = record(fencePlan.recordBody, 101);
  const producer = record(producerBody(request, fence), 102);
  const transitionStep = planInertLifecycleCoordinatorStep({
    facts: initialFacts,
    records: [request, fence, producer],
    runtime: { ...runtime, runId: 903 },
  });
  const transitionPlan = JSON.parse(
    Buffer.from(transitionStep.recordPlan, "base64url").toString("utf8"),
  );
  const transition = record(transitionPlan.recordBody, 103);
  const changedFacts = lifecycleCoordinatorFacts({
    comments: [],
    issue: { ...issue, updated_at: "2026-07-29T12:05:00Z" },
    protectedDevSha: commit,
  });
  const changed = planInertLifecycleCoordinatorStep({
    facts: changedFacts,
    records: [request, fence, producer, transition],
    runtime: { ...runtime, runId: 904 },
  });
  const changedPlan = JSON.parse(
    Buffer.from(changed.recordPlan, "base64url").toString("utf8"),
  );
  const changedRequest = record(changedPlan.recordBody, 104);
  assert.equal(changedRequest.parsed.recordType, "generation-request");
  assert.equal(
    changedRequest.parsed.fields.predecessor_comment_id,
    transition.comment.id,
  );
});

test("rejects malformed issue authority before creating a generation", () => {
  assert.throws(
    () =>
      lifecycleCoordinatorFacts({
        comments: [],
        issue: {
          ...issue,
          body: issue.body.replace("`dev`", "`feature/untrusted`"),
        },
        protectedDevSha: commit,
      }),
    /target/u,
  );
});

test("an authenticated settlement advances the attempt and becomes the next predecessor", () => {
  const facts = lifecycleCoordinatorFacts({
    comments: [],
    issue,
    protectedDevSha: commit,
  });
  const settlementStep = planInertLifecycleRecoverySettlement({
    authorizedRecovery: {
      identity: digest("authorized"),
      recoveryTargetIdentity: digest("target"),
    },
    facts,
    records: [],
    recoveryAttempt: 1,
    recoverySettlementIdentity: digest("settlement"),
    runtime,
  });
  const settlementPlan = JSON.parse(
    Buffer.from(settlementStep.recordPlan, "base64url").toString("utf8"),
  );
  const settlement = record(settlementPlan.recordBody, 110);
  assert.equal(settlement.parsed.fields.phase, "recovery");
  assert.equal(settlement.parsed.fields.claim_outcome, "settled");
  assert.equal(settlement.parsed.fields.attempt, 1);

  const resumed = planInertLifecycleCoordinatorStep({
    facts,
    records: [settlement],
    runtime: { ...runtime, runId: 901 },
  });
  const resumedPlan = JSON.parse(
    Buffer.from(resumed.recordPlan, "base64url").toString("utf8"),
  );
  const request = record(resumedPlan.recordBody, 111);
  assert.equal(request.parsed.fields.attempt, 1);
  assert.equal(request.parsed.fields.predecessor_comment_id, 110);
  assert.equal(
    request.parsed.fields.predecessor_record_digest,
    settlement.parsed.recordDigest,
  );
});
