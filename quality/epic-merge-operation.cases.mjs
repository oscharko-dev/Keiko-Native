import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileEpicMergeOperation,
  runGuardedEpicMerge,
} from "./epic-merge-broker.mjs";
import {
  base,
  claimIdentity,
  disabledPolicy,
  guardedPolicy,
  head,
  headTree,
  mergeCommit,
  operationIdentity,
  protection,
  repository,
  request,
  sha,
  successfulPorts,
  target,
} from "./epic-merge-broker-fixtures.mjs";

test("failed terminal settlement cannot report a terminal result", async () => {
  const result = await runGuardedEpicMerge(
    request(),
    successfulPorts([], { settleResult: { settled: false } }),
  );
  assert.equal(result.result, "indeterminate");
  assert.notEqual(result.receipt?.result, "merged");
  assert.equal(result.receipt?.settlement, "unproven");
});

test("settlement exceptions produce a bounded indeterminate receipt", async () => {
  const result = await runGuardedEpicMerge(
    request(),
    successfulPorts([], { settleError: true }),
  );
  assert.equal(result.result, "indeterminate");
  assert.equal(result.receipt?.settlement, "unavailable");
  assert.equal(JSON.stringify(result).includes("sensitive settlement"), false);
});

test("failed pre-submit settlements preserve a recoverable operation", async () => {
  const changedProtection = protection();
  changedProtection.current = false;
  const cases = [
    {
      refReads: [
        { base, head },
        { base, head: sha("a") },
      ],
    },
    { policies: [guardedPolicy(), guardedPolicy(), disabledPolicy()] },
    { protections: [protection(), protection(), changedProtection] },
  ];
  for (const options of cases) {
    const events = [];
    const result = await runGuardedEpicMerge(
      request(),
      successfulPorts(events, {
        ...options,
        settleResult: { settled: false },
      }),
    );
    assert.equal(result.result, "indeterminate");
    assert.equal(result.reason, "prepared_operation_reconciliation_required");
    assert.equal(result.receipt?.operationId, operationIdentity);
    assert.equal(
      events.some(([name]) => name === "merge"),
      false,
    );
  }
});

test("failed rejection settlement cannot appear terminal", async () => {
  const result = await runGuardedEpicMerge(
    request(),
    successfulPorts([], {
      providerResponse: { kind: "rejected" },
      settleResult: { settled: false },
    }),
  );
  assert.equal(result.result, "indeterminate");
  assert.notEqual(result.receipt?.result, "rejected");
});

test("confirmed rejection is terminal and fresh identity may revalidate", async () => {
  const rejectedEvents = [];
  const rejected = await runGuardedEpicMerge(
    request(),
    successfulPorts(rejectedEvents, {
      providerResponse: { kind: "rejected" },
    }),
  );
  assert.equal(rejected.result, "denied");
  assert.equal(rejected.reason, "provider_rejected");
  assert.equal(rejectedEvents.filter(([name]) => name === "merge").length, 1);
  assert.deepEqual(rejectedEvents.find(([name]) => name === "settle")[1], {
    claimId: claimIdentity,
    operationId: operationIdentity,
    releaseSerialization: true,
    result: "rejected",
  });
  const fresh = await runGuardedEpicMerge(
    request({
      operationId: "operation-50-fresh",
      requestId: "request-50-fresh",
    }),
    successfulPorts([]),
  );
  assert.equal(fresh.result, "merged");
});

test("ambiguous responses and readback mismatch block without retry", async () => {
  const cases = [
    { mergeError: true },
    { providerResponse: { kind: "timeout" } },
    { providerResponse: { kind: "accepted", mergeCommit: "bad" } },
    {
      outcome: {
        commit: { parents: [head], sha: mergeCommit, tree: headTree },
        merged: true,
        pullRequest: 150,
        targetTip: mergeCommit,
      },
    },
    {
      outcome: {
        commit: { parents: [base], sha: mergeCommit, tree: sha("f") },
        merged: true,
        pullRequest: 150,
        targetTip: mergeCommit,
      },
    },
    {
      outcome: {
        commit: { parents: [base], sha: mergeCommit, tree: headTree },
        merged: true,
        pullRequest: 999,
        targetTip: mergeCommit,
      },
    },
    {
      outcome: {
        commit: { parents: [base], sha: mergeCommit, tree: headTree },
        merged: true,
        pullRequest: 150,
        sourceHead: sha("f"),
        targetTip: mergeCommit,
      },
    },
    {
      outcome: {
        commit: { parents: [base], sha: mergeCommit, tree: headTree },
        merged: true,
        pullRequest: 150,
        targetTip: sha("f"),
      },
    },
  ];
  for (const options of cases) {
    const events = [];
    const result = await runGuardedEpicMerge(
      request(),
      successfulPorts(events, options),
    );
    assert.equal(result.result, "indeterminate");
    assert.equal(result.reason, "human_reconciliation_required");
    assert.equal(events.filter(([name]) => name === "merge").length, 1);
    assert.deepEqual(events.findLast(([name]) => name === "settle")[1], {
      claimId: claimIdentity,
      operationId: operationIdentity,
      releaseSerialization: false,
      result: "indeterminate",
    });
  }
});

test("receipts and durable records exclude credential-shaped data", async () => {
  const events = [];
  const result = await runGuardedEpicMerge(
    request(),
    successfulPorts(events, {
      outcome: {
        commit: { parents: [base], sha: mergeCommit, tree: headTree },
        merged: true,
        pullRequest: 150,
        rawBody: "SECRET_PROVIDER_BODY",
        targetTip: mergeCommit,
        token: "ghp_SECRET",
      },
      providerResponse: {
        kind: "accepted",
        mergeCommit,
        rawBody: "SECRET_PROVIDER_BODY",
        token: "ghp_SECRET",
      },
    }),
  );
  const durable = events
    .filter(([name]) => ["operation", "settle"].includes(name))
    .map(([, value]) => value);
  assert.doesNotMatch(
    JSON.stringify({ durable, result }),
    /SECRET|token|rawBody/iu,
  );
});

test("caller identities are digested before every durable or returned path", async () => {
  const events = [];
  const callerOperation = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const callerRequest = "github_pat_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const result = await runGuardedEpicMerge(
    request({
      operationId: callerOperation,
      requestId: callerRequest,
    }),
    successfulPorts(events),
  );
  assert.equal(result.result, "merged", JSON.stringify(result));
  const observable = JSON.stringify({ events, result });
  assert.doesNotMatch(observable, new RegExp(callerOperation, "u"));
  assert.doesNotMatch(observable, new RegExp(callerRequest, "u"));
  assert.match(result.receipt.operationId, /^op_[0-9a-f]{64}$/u);
  assert.match(result.receipt.requestId, /^req_[0-9a-f]{64}$/u);
});

test("authorized reconciliation settles only exact observed topology", async () => {
  const executionEvents = [];
  await runGuardedEpicMerge(
    request(),
    successfulPorts(executionEvents, { mergeError: true }),
  );
  const operation = structuredClone(
    executionEvents.find(([name]) => name === "operation")[1],
  );
  operation.state = "indeterminate";
  const settlements = [];
  const ports = {
    authorizeMaintainer: async (actor, exactTarget) =>
      actor === "niko4417" && exactTarget === target,
    readOperation: async () => structuredClone(operation),
    readReconciliation: async () => ({
      base,
      commit: { parents: [base], sha: mergeCommit, tree: headTree },
      merged: true,
      pullRequest: 150,
      source: "codex/50-inert-epic-merge-guard-v5",
      sourceHead: head,
      target,
      targetTip: mergeCommit,
    }),
    settleReconciliation: async (value) => {
      settlements.push(value);
      operation.state = "merged";
      return { settled: true };
    },
  };
  const input = {
    actor: "NiKo4417",
    operationId: operationIdentity,
    repository,
  };
  assert.deepEqual(await reconcileEpicMergeOperation(input, ports), {
    mergeCommit,
    result: "settled_merged",
  });
  assert.deepEqual(settlements, [
    {
      claimId: operation.claimId,
      from: "indeterminate",
      mergeCommit,
      operationId: operationIdentity,
      releaseSerialization: true,
      result: "merged",
    },
  ]);
  operation.state = "indeterminate";
  ports.readReconciliation = async () => ({
    base,
    commit: { parents: [base], sha: mergeCommit, tree: sha("f") },
    merged: true,
    pullRequest: 150,
    source: "codex/50-inert-epic-merge-guard-v5",
    sourceHead: head,
    target,
    targetTip: mergeCommit,
  });
  assert.deepEqual(await reconcileEpicMergeOperation(input, ports), {
    reason: "topology_unproven",
    result: "blocked",
  });
  ports.readReconciliation = async () => ({
    base,
    commit: { parents: [base], sha: mergeCommit, tree: headTree },
    merged: true,
    pullRequest: 150,
    source: "codex/50-inert-epic-merge-guard-v5",
    sourceHead: sha("f"),
    target,
    targetTip: mergeCommit,
  });
  assert.deepEqual(await reconcileEpicMergeOperation(input, ports), {
    reason: "topology_unproven",
    result: "blocked",
  });
});

test("reconciliation reports success only after exact settlement readback", async () => {
  const operation = {
    base,
    claimId: `clm_${"a".repeat(64)}`,
    head,
    headTree,
    issue: 50,
    operationId: operationIdentity,
    pullRequest: 150,
    repository,
    source: "codex/50-inert-epic-merge-guard-v5",
    state: "indeterminate",
    submitted: true,
    target: "epic/49-contract-as-code",
  };
  const result = await reconcileEpicMergeOperation(
    { actor: "Niko4417", operationId: operationIdentity, repository },
    {
      authorizeMaintainer: async () => true,
      readOperation: async () => structuredClone(operation),
      readReconciliation: async () => ({
        base,
        commit: { parents: [base], sha: mergeCommit, tree: headTree },
        merged: true,
        pullRequest: 150,
        source: "codex/50-inert-epic-merge-guard-v5",
        sourceHead: head,
        target,
        targetTip: mergeCommit,
      }),
      settleReconciliation: async () => ({ settled: false }),
    },
  );
  assert.deepEqual(result, {
    reason: "settlement_unproven",
    result: "blocked",
  });
});

test("unauthorized reconciliation cannot read or release a claim", async () => {
  const calls = [];
  const result = await reconcileEpicMergeOperation(
    {
      actor: "unknown",
      operationId: operationIdentity,
      repository,
    },
    {
      authorizeMaintainer: async () => false,
      readOperation: async () => calls.push("read"),
      settleReconciliation: async () => calls.push("settle"),
    },
  );
  assert.deepEqual(result, {
    reason: "maintainer_authority_unproven",
    result: "blocked",
  });
  assert.deepEqual(calls, []);
});
