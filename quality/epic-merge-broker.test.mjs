import assert from "node:assert/strict";
import test from "node:test";

import { runGuardedEpicMerge } from "./epic-merge-broker.mjs";
import { request, successfulPorts } from "./epic-merge-broker-fixtures.mjs";

import "./epic-merge-broker.cases.mjs";
import "./epic-merge-boundary.cases.mjs";
import "./epic-merge-composition.cases.mjs";
import "./epic-merge-evidence.cases.mjs";
import "./epic-merge-adapter.cases.mjs";
import "./epic-merge-operation.cases.mjs";
import "./epic-merge-policy.cases.mjs";
import "./epic-merge-pre-submit.cases.mjs";
import "./epic-merge-provider.cases.mjs";
import "./epic-merge-reconciliation.cases.mjs";
import "./epic-merge-store.cases.mjs";

test("guard exposes no alternate privileged effect ports", async () => {
  const forbidden = [];
  const ports = successfulPorts([]);
  for (const name of [
    "enableAutoMerge",
    "enqueueMerge",
    "updateRef",
    "administerRepository",
    "bypassProtection",
  ])
    ports[name] = async () => forbidden.push(name);
  assert.equal((await runGuardedEpicMerge(request(), ports)).result, "merged");
  assert.deepEqual(forbidden, []);
});
