import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { semanticIssueFingerprint } from "./issue-contract.mjs";
import { readinessComment } from "./issue-readiness-action.mjs";
import {
  lifecycleCoordinatorFacts,
  planInertLifecycleCoordinatorStep,
} from "./lifecycle-coordinator.mjs";
import { runLifecycleProducerRecordAction } from "./lifecycle-producer-action.mjs";
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

function coordinatorPrefix(comments = []) {
  const facts = lifecycleCoordinatorFacts({
    comments,
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

test("the producer action reconstructs, evaluates, and writes the record plan", async () => {
  const fingerprint = semanticIssueFingerprint(issue.body, issue.title);
  const readiness = {
    body: readinessComment({
      actor: "Niko4417",
      decision: { outcome: "accept", reasons: [] },
      now: "2026-07-29T11:55:00Z",
      validation: { fingerprint, version: "v1" },
    }),
    id: 77,
    user: {
      id: 41898282,
      login: "github-actions[bot]",
      type: "Bot",
    },
  };
  const { fence, producer, request } = coordinatorPrefix([readiness]);
  const environment = {
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "902",
    GITHUB_WORKFLOW_SHA: commit,
    ...Object.fromEntries(
      Object.entries(producer.wire).map(([name, value]) => [
        `KEIKO_PRODUCER_${name.toUpperCase()}`,
        value,
      ]),
    ),
    KEIKO_PRODUCER_CONTRACT_VERSION: producer.wire.producer_contract_version,
  };
  const root = await mkdtemp(join(tmpdir(), "keiko-producer-"));
  const githubOutput = join(root, "output");
  await writeFile(githubOutput, "");
  const provider = {
    comments: () => [readiness],
    currentProducerRuntime: async () => ({ jobId: 903, workflowId: 44 }),
    requestCount: () => 0,
  };
  const result = await runLifecycleProducerRecordAction({
    environment,
    githubOutput,
    loadFacts: async () => ({ issue, pullRequest: null }),
    loadHistory: async () => ({
      records: [request, fence],
      state: "authenticated",
    }),
    now: new Date("2026-07-29T12:03:00Z"),
    provider,
  });
  assert.equal(result.result.issueNumber, 51);
  assert.match(result.result.resultIdentity, /^[0-9a-f]{64}$/u);
  const output = await readFile(githubOutput, "utf8");
  assert.match(output, /^issue-number=51$/mu);
  assert.match(output, /^record-plan=[A-Za-z0-9_-]+$/mu);
  assert.match(output, /^result-identity=[0-9a-f]{64}$/mu);
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
