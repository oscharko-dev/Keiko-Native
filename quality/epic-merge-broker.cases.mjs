import assert from "node:assert/strict";
import test from "node:test";

import { runGuardedEpicMerge } from "./epic-merge-broker.mjs";
import {
  authorization,
  base,
  claimIdentity,
  head,
  mergeCommit,
  operationIdentity,
  protection,
  repository,
  request,
  sha,
  successfulPorts,
  target,
} from "./epic-merge-broker-fixtures.mjs";

test("eligible target persists durable facts before one exact squash request", async () => {
  const events = [];
  const result = await runGuardedEpicMerge(request(), successfulPorts(events));
  assert.equal(result.result, "merged", JSON.stringify(result));
  assert.equal(result.receipt.mode, "agent-credentialed");
  assert.equal(result.receipt.mergeCommit, mergeCommit);
  assert.deepEqual(
    events.find(([name]) => name === "merge"),
    [
      "merge",
      {
        merge_method: "squash",
        pullRequest: 150,
        repository,
        sha: head,
      },
    ],
  );
  const names = events.map(([name]) => name);
  for (const name of ["prepare", "read-preparation"])
    assert.ok(names.indexOf(name) < names.indexOf("merge"));
  const providerReads = names
    .slice(0, names.indexOf("merge"))
    .filter((name) =>
      [
        "authorization",
        "policy",
        "protection",
        "pull-request",
        "refs",
      ].includes(name),
    );
  assert.equal(providerReads.at(-1), "pull-request");
  const operation = events.find(([name]) => name === "operation")[1];
  assert.match(operation.policyDigest, /^[0-9a-f]{64}$/u);
  assert.equal(operation.policyRevision, sha("a"));
  assert.equal(operation.policyState, "enabled");
  assert.equal(result.receipt.policyDigest, operation.policyDigest);
  assert.equal(result.receipt.policyRevision, operation.policyRevision);
  assert.equal(result.receipt.policyState, operation.policyState);
  assert.deepEqual(events.find(([name]) => name === "settle")[1], {
    claimId: claimIdentity,
    mergeCommit,
    operationId: operationIdentity,
    releaseSerialization: true,
    result: "merged",
  });
});

test("authorization failures deny before durable claim or provider call", async () => {
  const mutations = [
    (value) => (value.issue.open = false),
    (value) => (value.issue.lifecycle = "status: pr open"),
    (value) => (value.issue.target = "dev"),
    (value) => (value.issue.target = "main"),
    (value) => (value.issue.target = "release/probe"),
    (value) => (value.issue.target = "codex/feature"),
    (value) => (value.issue.readiness.current = false),
    (value) => (value.issue.readiness.producerId = 999),
    (value) => (value.pullRequest.target = "epic/999-wrong"),
    (value) => (value.pullRequest.head = sha("a")),
    (value) => (value.checks[0].producer = "wrong-producer"),
    (value) => (value.checks[0].conclusion = "skipped"),
    (value) => (value.evidence.audit.complete = false),
    (value) => (value.findings.blocking = 1),
    (value) => (value.conversations.unresolved = 1),
    (value) => (value.pagination.truncated = true),
  ];
  for (const [index, mutate] of mutations.entries()) {
    const snapshot = authorization();
    mutate(snapshot);
    const events = [];
    const result = await runGuardedEpicMerge(
      request(),
      successfulPorts(events, { authorization: snapshot }),
    );
    assert.equal(result.result, "denied", `mutation ${String(index)}`);
    assert.equal(
      events.some(([name]) => name === "claim" || name === "merge"),
      false,
    );
  }
});

test("required checks must have one unambiguous completed current result", async () => {
  const mutations = [
    (value) => (value.checks[0].status = "in_progress"),
    (value) => value.checks.push(structuredClone(value.checks[0])),
    (value) =>
      value.checks.push({
        ...structuredClone(value.checks[0]),
        conclusion: "failure",
      }),
    (value) =>
      value.checks.push({
        ...structuredClone(value.checks[0]),
        head: sha("a"),
      }),
  ];
  for (const mutate of mutations) {
    const snapshot = authorization();
    mutate(snapshot);
    const events = [];
    const result = await runGuardedEpicMerge(
      request(),
      successfulPorts(events, { authorization: snapshot }),
    );
    assert.equal(result.result, "denied");
    assert.equal(
      events.some(([name]) => name === "claim"),
      false,
    );
  }
});

test("target protection must be current, strict, no-bypass, and stable", async () => {
  const mutations = [
    (value) => (value.current = false),
    (value) => (value.authorization.merge = false),
    (value) => (value.authorization.bypass = true),
    (value) => (value.pagination.complete = false),
    (value) => value.rules[0].bypassActors.push("maintainer"),
    (value) => (value.rules[0].controls.requiredStatusChecks.strict = false),
    (value) => delete value.rules[0].controls.requiredStatusChecks.strict,
    (value) => (value.rules = []),
    (value) => (value.target = "epic/999-wrong"),
  ];
  for (const mutate of mutations) {
    const snapshot = protection();
    mutate(snapshot);
    const events = [];
    const result = await runGuardedEpicMerge(
      request(),
      successfulPorts(events, { protection: snapshot }),
    );
    assert.equal(result.result, "denied");
    assert.equal(
      events.some(([name]) => name === "claim"),
      false,
    );
  }
  const changed = protection();
  changed.rules[0].id = 999;
  const unstableEvents = [];
  const unstable = await runGuardedEpicMerge(
    request(),
    successfulPorts(unstableEvents, {
      protections: [protection(), changed],
    }),
  );
  assert.equal(unstable.result, "denied");
  assert.equal(
    unstableEvents.some(([name]) => name === "claim"),
    false,
  );
});

test("caller target, unstable reads, and changed refs deny before claim", async () => {
  const changed = authorization();
  changed.pullRequest.head = sha("a");
  changed.checks[0].head = sha("a");
  changed.evidence.acceptance.head = sha("a");
  changed.evidence.audit.head = sha("a");
  const cases = [
    {
      ports: successfulPorts([], {}),
      request: request({ target }),
    },
    {
      ports: successfulPorts([], {
        snapshots: [authorization(), changed],
      }),
      request: request(),
    },
    {
      ports: successfulPorts([], { refs: { base, head: sha("a") } }),
      request: request(),
    },
  ];
  for (const item of cases)
    assert.equal(
      (await runGuardedEpicMerge(item.request, item.ports)).result,
      "denied",
    );
});

test("serialization key cannot be partitioned by child identity", async () => {
  const firstEvents = [];
  await runGuardedEpicMerge(request(), successfulPorts(firstEvents));
  const second = authorization();
  second.issue.number = 51;
  second.issue.readiness.fingerprint = "6".repeat(64);
  second.pullRequest.issue = 51;
  second.pullRequest.number = 151;
  second.pullRequest.head = sha("a");
  second.pullRequest.headTree = sha("b");
  second.pullRequest.source = "codex/51-guard-race";
  for (const check of second.checks) check.head = sha("a");
  for (const evidence of Object.values(second.evidence))
    evidence.head = sha("a");
  const secondEvents = [];
  await runGuardedEpicMerge(
    request({
      issue: 51,
      operationId: "operation-51-2",
      pullRequest: 151,
      requestId: "request-51-2",
    }),
    successfulPorts(secondEvents, { authorization: second }),
  );
  const firstClaim = firstEvents.find(([name]) => name === "claim")[1];
  const secondClaim = secondEvents.find(([name]) => name === "claim")[1];
  assert.equal(firstClaim.key, secondClaim.key);
  assert.equal(firstClaim.base, secondClaim.base);
  assert.equal(firstClaim.target, secondClaim.target);
  assert.notEqual(firstClaim.operationId, secondClaim.operationId);
});

test("contended, replayed, or blocked serialization never submits", async () => {
  for (const claim of [
    { claimId: "claim-other", state: "contended" },
    { claimId: "claim-replay", state: "replayed" },
    { claimId: "claim-ambiguous", state: "blocked" },
  ]) {
    const events = [];
    const result = await runGuardedEpicMerge(
      request(),
      successfulPorts(events, { claim }),
    );
    assert.equal(result.result, "denied");
    assert.equal(
      events.some(([name]) => name === "merge"),
      false,
    );
  }
});

test("claim and operation must persist and read back before submission", async () => {
  const unavailable = await runGuardedEpicMerge(
    request(),
    successfulPorts([], { persistResult: { persisted: false } }),
  );
  assert.equal(unavailable.result, "denied");
  for (const options of [
    { claimReadback: { claimId: "forged", state: "claimed" } },
    { operationReadback: { operationId: "forged", state: "prepared" } },
  ]) {
    const events = [];
    const result = await runGuardedEpicMerge(
      request(),
      successfulPorts(events, options),
    );
    assert.equal(result.result, "indeterminate");
    assert.equal(result.receipt.submitted, false);
    assert.equal(
      events.some(([name]) => name === "merge"),
      false,
    );
  }
});

test("serialization claim and immutable operation are created atomically", async () => {
  const events = [];
  const ports = successfulPorts(events);
  ports.claimSerialization = async () => {
    throw new Error("split claim forbidden");
  };
  ports.persistOperation = async () => {
    throw new Error("split operation forbidden");
  };
  const result = await runGuardedEpicMerge(request(), ports);
  assert.equal(result.result, "merged", JSON.stringify(result));
  assert.equal(events.filter(([name]) => name === "prepare").length, 1);
  assert.ok(
    events.findIndex(([name]) => name === "prepare") <
      events.findIndex(([name]) => name === "merge"),
  );
});

test("post-durability ref change cancels before submission", async () => {
  for (const changedRefs of [
    { base: sha("a"), head },
    { base, head: sha("a") },
  ]) {
    const events = [];
    const result = await runGuardedEpicMerge(
      request(),
      successfulPorts(events, {
        refReads: [{ base, head }, changedRefs],
      }),
    );
    assert.equal(result.result, "denied");
    assert.equal(events.filter(([name]) => name === "refs").length, 2);
    assert.equal(
      events.some(([name]) => name === "merge"),
      false,
    );
    assert.deepEqual(events.find(([name]) => name === "settle")[1], {
      claimId: claimIdentity,
      operationId: operationIdentity,
      releaseSerialization: true,
      result: "cancelled",
    });
  }
});

test("post-durability protection change cancels before submission", async () => {
  const changed = protection();
  changed.current = false;
  const events = [];
  const result = await runGuardedEpicMerge(
    request(),
    successfulPorts(events, {
      protections: [protection(), protection(), changed],
    }),
  );
  assert.equal(result.result, "denied");
  assert.equal(result.reason, "target_protection_changed");
  assert.equal(events.filter(([name]) => name === "protection").length, 3);
  assert.equal(
    events.some(([name]) => name === "merge"),
    false,
  );
  assert.deepEqual(events.find(([name]) => name === "settle")[1], {
    claimId: claimIdentity,
    operationId: operationIdentity,
    releaseSerialization: true,
    result: "cancelled",
  });
});

test("guard never invokes auto-merge, queue, ref-update, admin, or bypass ports", async () => {
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
