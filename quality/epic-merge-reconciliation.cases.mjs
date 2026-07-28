import assert from "node:assert/strict";
import test from "node:test";

import { reconcileEpicMergeOperation } from "./epic-merge-broker.mjs";
import {
  operationIdentity,
  repository,
} from "./epic-merge-broker-fixtures.mjs";

test("reconciliation allowlist binds canonical GitHub logins only", async () => {
  for (const actor of ["Niko4417", "nIkO4417", "oscharko", "OSCHARKO"]) {
    const calls = [];
    const result = await reconcileEpicMergeOperation(
      { actor, operationId: operationIdentity, repository },
      { readOperation: async () => calls.push("read") },
    );
    assert.deepEqual(result, {
      reason: "operation_unproven",
      result: "blocked",
    });
    assert.deepEqual(calls, ["read"]);
  }
  for (const actor of ["Niko", "Oscharko-dev", "niko44170", "oschark0"]) {
    const calls = [];
    const result = await reconcileEpicMergeOperation(
      { actor, operationId: operationIdentity, repository },
      { readOperation: async () => calls.push("read") },
    );
    assert.deepEqual(result, {
      reason: "maintainer_authority_unproven",
      result: "blocked",
    });
    assert.deepEqual(calls, []);
  }
});

test("reconciliation accepts only bounded internal operation identity", async () => {
  const calls = [];
  const result = await reconcileEpicMergeOperation(
    {
      actor: "Niko4417",
      operationId: "github_pat_SECRET_SHAPED_CALLER_ID",
      repository,
    },
    {
      authorizeMaintainer: async () => true,
      readOperation: async () => calls.push("read"),
    },
  );
  assert.deepEqual(result, {
    reason: "maintainer_authority_unproven",
    result: "blocked",
  });
  assert.deepEqual(calls, []);
});
