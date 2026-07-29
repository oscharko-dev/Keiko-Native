import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  lifecycleCoordinatorFacts,
  planInertLifecycleCoordinatorStep,
} from "./lifecycle-coordinator.mjs";
import { planInertLifecycleProducerResult } from "./lifecycle-producer.mjs";
import { parseRecordEnvelope } from "./lifecycle-record-protocol.mjs";

const commit = "a".repeat(40);
const sha = (value) => createHash("sha256").update(String(value)).digest("hex");
const issue = {
  assignees: [],
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

function decodeStep(step, id) {
  const plan = JSON.parse(
    Buffer.from(step.recordPlan, "base64url").toString("utf8"),
  );
  return { comment: { id }, parsed: parseRecordEnvelope(plan.recordBody) };
}

function coordinatorPrefix() {
  const facts = lifecycleCoordinatorFacts({
    comments: [],
    issue,
    protectedDevSha: commit,
  });
  const request = decodeStep(
    planInertLifecycleCoordinatorStep({
      facts,
      records: [],
      runtime: {
        recordedAt: "2026-07-29T12:00:00Z",
        runAttempt: 1,
        runId: 900,
      },
    }),
    100,
  );
  const fence = decodeStep(
    planInertLifecycleCoordinatorStep({
      facts,
      records: [request],
      runtime: {
        recordedAt: "2026-07-29T12:01:00Z",
        runAttempt: 1,
        runId: 901,
      },
    }),
    101,
  );
  const producer = planInertLifecycleCoordinatorStep({
    facts,
    records: [request, fence],
    runtime: {
      recordedAt: "2026-07-29T12:02:00Z",
      runAttempt: 1,
      runId: 902,
    },
  });
  return { facts, fence, producer, request };
}

test("emits only the selected same-generation producer result", () => {
  const { facts, fence, producer, request } = coordinatorPrefix();
  const result = planInertLifecycleProducerResult({
    evaluation: {
      conclusion: "success",
      payloadDigest: sha("accepted-readiness"),
      providerResultId: 77,
      providerResultSha: null,
      reasonCode: "ok",
      resultName: "Issue contract current",
    },
    facts,
    records: [request, fence],
    runtime: {
      jobId: 903,
      recordedAt: "2026-07-29T12:03:00Z",
      runAttempt: 1,
      runId: 902,
      workflowId: 44,
    },
    wire: producer.wire,
  });
  const plan = JSON.parse(
    Buffer.from(result.recordPlan, "base64url").toString("utf8"),
  );
  const parsed = parseRecordEnvelope(plan.recordBody);
  assert.equal(parsed.recordType, "producer-result");
  assert.equal(parsed.fields.expected_producer, "issue-contract-current");
  assert.equal(parsed.fields.attempt, 0);
  assert.equal(parsed.fields.predecessor_comment_id, 101);
  assert.equal(parsed.fields.workflow_job_id, 903);
});

test("rejects stale generations and duplicate or reordered producers", () => {
  const { facts, fence, producer, request } = coordinatorPrefix();
  const input = {
    evaluation: {
      conclusion: "success",
      payloadDigest: sha("accepted-readiness"),
      providerResultId: 77,
      providerResultSha: null,
      reasonCode: "ok",
      resultName: "Issue contract current",
    },
    facts,
    records: [request, fence],
    runtime: {
      jobId: 903,
      recordedAt: "2026-07-29T12:03:00Z",
      runAttempt: 1,
      runId: 902,
      workflowId: 44,
    },
    wire: producer.wire,
  };
  assert.throws(
    () =>
      planInertLifecycleProducerResult({
        ...input,
        wire: { ...producer.wire, generation_identity: sha("stale") },
      }),
    /generation/u,
  );
  const first = planInertLifecycleProducerResult(input);
  const firstPlan = JSON.parse(
    Buffer.from(first.recordPlan, "base64url").toString("utf8"),
  );
  const firstRecord = {
    comment: { id: 102 },
    parsed: parseRecordEnvelope(firstPlan.recordBody),
  };
  assert.throws(
    () =>
      planInertLifecycleProducerResult({
        ...input,
        records: [request, fence, firstRecord],
      }),
    /duplicated or reordered/u,
  );
});
