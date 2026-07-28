import assert from "node:assert/strict";
import test from "node:test";

import { createInertEpicMergeAdapter } from "./epic-merge-adapter.mjs";
import { head, repository } from "./epic-merge-broker-fixtures.mjs";

const adapter = (merge) =>
  createInertEpicMergeAdapter({
    clock: () => "",
    github: { merge },
    store: {},
  });

test("provider adapter classifies rejection and ambiguity without raw data", async () => {
  const cases = [
    [{ status: 403 }, { kind: "rejected", status: 403 }],
    [{ status: 404 }, { kind: "rejected", status: 404 }],
    [{ status: 409 }, { kind: "rejected", status: 409 }],
    [{ status: 422 }, { kind: "rejected", status: 422 }],
    [{ status: 429 }, { kind: "timeout" }],
    [{ body: { merged: true }, status: 200 }, { kind: "malformed" }],
  ];
  for (const [response, expected] of cases)
    assert.deepEqual(
      await adapter(async () => response).mergePullRequest({
        merge_method: "squash",
        pullRequest: 150,
        repository,
        sha: head,
      }),
      expected,
    );
  for (const error of [
    Object.assign(new Error("secret"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("secret"), { status: 429 }),
    Object.assign(new Error("secret"), { name: "AbortError" }),
  ])
    assert.deepEqual(
      await adapter(async () => {
        throw error;
      }).mergePullRequest({}),
      { kind: "timeout" },
    );
});

test("provider adapter bounds the merge request with an abort signal", async () => {
  let observed;
  const result = await adapter(async (input) => {
    observed = input;
    return {
      body: { merged: true, sha: "4".repeat(40) },
      status: 200,
    };
  }).mergePullRequest({
    merge_method: "squash",
    pullRequest: 150,
    repository,
    sha: head,
  });
  assert.equal(result.kind, "accepted");
  assert.equal(observed.signal instanceof AbortSignal, true);
});
