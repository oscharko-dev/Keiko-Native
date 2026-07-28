import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  reconcileEpicMergeOperation,
  runGuardedEpicMerge,
} from "./epic-merge-broker.mjs";
import { createEpicMergeOperationStore } from "./epic-merge-store.mjs";
import {
  base,
  mergeCommit,
  head,
  headTree,
  operationIdentity,
  repository,
  requestIdentity,
  successfulPorts,
  target,
} from "./epic-merge-broker-fixtures.mjs";

function preparation(suffix) {
  const operationId =
    suffix === "a" ? operationIdentity : `op_${suffix.repeat(64)}`;
  const claim = {
    base,
    claimId: `clm_${suffix.repeat(64)}`,
    key: "a".repeat(64),
    operationId,
    repository,
    state: "claimed",
    target,
  };
  return {
    claim,
    operation: {
      base,
      claimId: claim.claimId,
      contractFingerprint: "5".repeat(64),
      contractVersion: "v5",
      createdAt: "2026-07-27T19:00:00.000Z",
      evidenceDigest: "6".repeat(64),
      head,
      headTree,
      issue: 50,
      mode: "agent-credentialed",
      operationId,
      pullRequest: 150,
      policyDigest: "7".repeat(64),
      policyRevision: "8".repeat(40),
      policyState: "enabled",
      repository,
      requestId: requestIdentity,
      source: "codex/50-inert-epic-merge-guard-v5",
      state: "prepared",
      submitted: false,
      target,
    },
  };
}

test("durable store atomically creates claim plus immutable operation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keiko-epic-store-"));
  const path = join(directory, "operations.sqlite");
  const first = createEpicMergeOperationStore(path);
  const second = createEpicMergeOperationStore(path);
  try {
    const a = preparation("a");
    assert.deepEqual(first.prepareOperation(a), { ...a, state: "prepared" });
    assert.deepEqual(first.readPreparation(a.operation.operationId), {
      ...a,
      state: "prepared",
    });
    const b = preparation("b");
    assert.deepEqual(second.prepareOperation(b), { state: "contended" });
    assert.equal(second.readOperation(b.operation.operationId), null);
    first.close();
    const reopened = createEpicMergeOperationStore(path);
    assert.deepEqual(reopened.readPreparation(a.operation.operationId), {
      ...a,
      state: "prepared",
    });
    reopened.close();
  } finally {
    second.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("indeterminate settlement remains blocked until explicit resolution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keiko-epic-store-"));
  const store = createEpicMergeOperationStore(
    join(directory, "operations.sqlite"),
  );
  try {
    const a = preparation("a");
    store.prepareOperation(a);
    assert.deepEqual(
      store.settleOperation({
        claimId: a.claim.claimId,
        operationId: a.operation.operationId,
        releaseSerialization: false,
        result: "indeterminate",
      }),
      { settled: true },
    );
    assert.equal(
      store.readOperation(a.operation.operationId).state,
      "indeterminate",
    );
    assert.deepEqual(store.prepareOperation(preparation("b")), {
      state: "contended",
    });
  } finally {
    store.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("store appends one CAS reconciliation transition and rejects replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keiko-epic-store-"));
  const store = createEpicMergeOperationStore(
    join(directory, "operations.sqlite"),
  );
  try {
    const a = preparation("a");
    store.prepareOperation(a);
    assert.deepEqual(
      store.markOperationSubmitted({
        claimId: a.claim.claimId,
        operationId: a.operation.operationId,
        state: "submitted",
      }),
      { submitted: true },
    );
    assert.equal(store.readOperation(a.operation.operationId).submitted, true);
    store.settleOperation({
      claimId: a.claim.claimId,
      operationId: a.operation.operationId,
      releaseSerialization: false,
      result: "indeterminate",
    });
    const settlement = {
      claimId: a.claim.claimId,
      from: "indeterminate",
      mergeCommit,
      operationId: a.operation.operationId,
      releaseSerialization: true,
      result: "merged",
    };
    assert.deepEqual(store.settleReconciliation(settlement), {
      settled: true,
    });
    assert.deepEqual(store.readSettlements(a.operation.operationId), [
      {
        claimId: a.claim.claimId,
        operationId: a.operation.operationId,
        releaseSerialization: false,
        result: "indeterminate",
      },
      settlement,
    ]);
    assert.deepEqual(store.settleReconciliation(settlement), {
      settled: false,
    });
  } finally {
    store.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("real store reconciles submitted merge and never-submitted no-effect once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keiko-epic-store-"));
  const store = createEpicMergeOperationStore(
    join(directory, "operations.sqlite"),
  );
  try {
    const execution = successfulPorts([], { mergeError: true });
    Object.assign(execution, {
      markOperationSubmitted: store.markOperationSubmitted,
      prepareOperation: store.prepareOperation,
      readOperation: store.readOperation,
      readPreparation: store.readPreparation,
      settleOperation: store.settleOperation,
    });
    const ambiguous = await runGuardedEpicMerge(
      {
        issue: 50,
        mode: "agent-credentialed",
        operationId: "submitted-operation",
        pullRequest: 150,
        repository,
        requestId: "submitted-request",
      },
      execution,
    );
    assert.equal(ambiguous.result, "indeterminate");
    assert.equal(ambiguous.receipt.submitted, true);
    const submittedId = ambiguous.receipt.operationId;
    const submitted = {
      authorizeMaintainer: async () => true,
      readOperation: store.readOperation,
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
      settleReconciliation: store.settleReconciliation,
    };
    const mergedObservation = submitted.readReconciliation;
    submitted.readReconciliation = async () => ({
      base,
      commit: { parents: [], sha: null, tree: null },
      merged: false,
      pullRequest: 150,
      source: "codex/50-inert-epic-merge-guard-v5",
      sourceHead: head,
      target,
      targetTip: base,
    });
    assert.equal(
      (
        await reconcileEpicMergeOperation(
          { actor: "niko4417", operationId: submittedId, repository },
          submitted,
        )
      ).result,
      "blocked",
    );
    submitted.readReconciliation = mergedObservation;
    assert.equal(
      (
        await reconcileEpicMergeOperation(
          { actor: "niko4417", operationId: submittedId, repository },
          submitted,
        )
      ).result,
      "settled_merged",
    );
    assert.equal(
      (
        await reconcileEpicMergeOperation(
          { actor: "niko4417", operationId: submittedId, repository },
          submitted,
        )
      ).result,
      "blocked",
    );

    const preSubmit = successfulPorts([]);
    Object.assign(preSubmit, {
      markOperationSubmitted: store.markOperationSubmitted,
      prepareOperation: store.prepareOperation,
      readOperation: store.readOperation,
      readPreparation: async () => null,
      settleOperation: async () => ({ settled: false }),
    });
    const stranded = await runGuardedEpicMerge(
      {
        issue: 50,
        mode: "agent-credentialed",
        operationId: "preparation-readback-mismatch",
        pullRequest: 150,
        repository,
        requestId: "preparation-readback-request",
      },
      preSubmit,
    );
    assert.equal(stranded.result, "indeterminate");
    assert.equal(stranded.receipt.submitted, false);
    const unsubmittedId = stranded.receipt.operationId;
    assert.equal(store.readOperation(unsubmittedId).state, "prepared");
    const noEffect = {
      authorizeMaintainer: async () => true,
      readOperation: store.readOperation,
      readReconciliation: async () => ({
        base,
        commit: { parents: [], sha: null, tree: null },
        merged: false,
        pullRequest: 150,
        source: "codex/50-inert-epic-merge-guard-v5",
        sourceHead: head,
        target,
        targetTip: base,
      }),
      settleReconciliation: store.settleReconciliation,
    };
    assert.equal(
      (
        await reconcileEpicMergeOperation(
          {
            actor: "oscharko",
            operationId: unsubmittedId,
            repository,
          },
          noEffect,
        )
      ).result,
      "settled_cancelled",
    );
  } finally {
    store.close();
    await rm(directory, { force: true, recursive: true });
  }
});
