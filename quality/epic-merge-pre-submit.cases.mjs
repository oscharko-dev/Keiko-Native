import assert from "node:assert/strict";
import test from "node:test";

import { runGuardedEpicMerge } from "./epic-merge-broker.mjs";
import {
  authorization,
  base,
  disabledPolicy,
  guardedPolicy,
  head,
  headTree,
  mergeCommit,
  operationIdentity,
  request,
  successfulPorts,
  target,
} from "./epic-merge-broker-fixtures.mjs";

test("final canonical PR reload blocks a post-claim retarget to dev", async () => {
  const retargeted = structuredClone(authorization().pullRequest);
  retargeted.target = "dev";
  const events = [];
  const result = await runGuardedEpicMerge(
    request(),
    successfulPorts(events, { finalPullRequest: retargeted }),
  );
  assert.equal(result.result, "denied");
  assert.equal(result.reason, "canonical_pull_request_changed");
  assert.equal(
    events.some(([name]) => name === "merge"),
    false,
  );
  assert.equal(
    events.find(([name]) => name === "settle")[1].operationId,
    operationIdentity,
  );
});

test("provider readback must report actual persisted PR topology", async () => {
  for (const substitution of [
    { target: "dev" },
    { base: "f".repeat(40) },
    { source: "codex/substituted" },
    { sourceHead: "f".repeat(40) },
  ]) {
    const result = await runGuardedEpicMerge(
      request(),
      successfulPorts([], {
        outcome: {
          base,
          commit: { parents: [base], sha: mergeCommit, tree: headTree },
          merged: true,
          pullRequest: 150,
          source: "codex/50-inert-epic-merge-guard-v5",
          sourceHead: head,
          target,
          targetTip: mergeCommit,
          ...substitution,
        },
      }),
    );
    assert.equal(result.result, "indeterminate");
  }
});

test("submission marker uncertainty is conservatively submitted", async () => {
  const events = [];
  const result = await runGuardedEpicMerge(
    request(),
    successfulPorts(events, { submittedReadbackMismatch: true }),
  );
  assert.equal(result.result, "indeterminate");
  assert.equal(result.receipt.submitted, true);
  assert.equal(
    events.some(([name]) => name === "merge"),
    false,
  );
});

test("protected policy is stable and revalidated immediately before effect", async () => {
  const events = [];
  const result = await runGuardedEpicMerge(
    request(),
    successfulPorts(events, {
      policies: [guardedPolicy(), guardedPolicy(), disabledPolicy()],
    }),
  );
  assert.equal(result.result, "denied");
  assert.equal(result.reason, "protected_policy_changed");
  assert.equal(
    events.some(([name]) => name === "merge"),
    false,
  );
});

test("unstable protected policy denies before authorization or durability", async () => {
  const events = [];
  const result = await runGuardedEpicMerge(
    request(),
    successfulPorts(events, {
      policies: [guardedPolicy(), disabledPolicy()],
    }),
  );
  assert.equal(result.result, "denied");
  assert.equal(result.reason, "protected_policy_unstable");
  assert.deepEqual(events, [["policy"], ["policy"]]);
});
