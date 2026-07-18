import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_LIFECYCLE_EDGES,
  LIFECYCLE_STATES,
  PERMITTED_LABEL_REQUESTS,
  isAllowedLifecycleEdge,
  planStatusLabelReconciliation,
  validateProviderStatusLabels,
  validateTransitionRequest,
  verifyStatusLabelReadback,
} from "./issue-lifecycle.mjs";

const canonicalStates = Object.freeze([
  "status: new",
  "status: triaged",
  "status: ready",
  "status: in progress",
  "status: pr open",
  "status: ready for human review",
  "status: blocked",
  "status: waiting for user",
  "status: done",
]);

const activeSources = canonicalStates.slice(0, 8);

const stateAlias = Object.freeze({
  blocked: "status: blocked",
  done: "status: done",
  inProgress: "status: in progress",
  new: "status: new",
  prOpen: "status: pr open",
  ready: "status: ready",
  review: "status: ready for human review",
  triaged: "status: triaged",
  waiting: "status: waiting for user",
});

const expectedEdgeAliases = Object.freeze([
  ["new", ["triaged", "blocked", "waiting"]],
  ["triaged", ["ready", "blocked", "waiting", "new"]],
  ["ready", ["inProgress", "blocked", "waiting", "new"]],
  ["inProgress", ["ready", "prOpen", "blocked", "waiting", "new"]],
  ["prOpen", ["ready", "inProgress", "review", "blocked", "waiting", "new"]],
  ["review", ["prOpen", "inProgress", "blocked", "waiting", "new", "done"]],
  ["blocked", ["waiting", "new", "triaged", "ready", "inProgress", "prOpen"]],
  ["waiting", ["blocked", "new", "triaged", "ready", "inProgress", "prOpen"]],
  ["done", ["new"]],
]);

function pairKey(source, target) {
  return `${source}->${target}`;
}

function expectedPermittedRequests() {
  return new Set([
    pairKey("status: new", "status: triaged"),
    pairKey("status: triaged", "status: ready"),
    ...activeSources
      .filter((source) => source !== "status: blocked")
      .map((source) => pairKey(source, "status: blocked")),
    ...activeSources
      .filter((source) => source !== "status: waiting for user")
      .map((source) => pairKey(source, "status: waiting for user")),
  ]);
}

function validRequest(source, target) {
  const planningTarget =
    target === "status: triaged" || target === "status: ready";
  return {
    actorRole: planningTarget ? "planner" : "implementer",
    blockingCondition: "dependency unavailable",
    currentState: source,
    eventIdentity: "event-123",
    humanInput: "scope decision needed",
    requestedSource: source,
    requestedTarget: target,
  };
}

function expectedEdges() {
  return new Map(
    expectedEdgeAliases.map(([source, targets]) => [
      stateAlias[source],
      targets.map((target) => stateAlias[target]),
    ]),
  );
}

test("exports the ordered nine-state taxonomy and rejects provider drift", () => {
  assert.deepEqual(LIFECYCLE_STATES, canonicalStates);
  assert.equal(validateProviderStatusLabels(canonicalStates).ok, true);

  assert.deepEqual(
    validateProviderStatusLabels(canonicalStates.slice(1)).missing,
    ["status: new"],
  );
  assert.deepEqual(
    validateProviderStatusLabels([...canonicalStates, "status: archived"])
      .unexpected,
    ["status: archived"],
  );
  assert.deepEqual(
    validateProviderStatusLabels([
      ...canonicalStates.slice(0, -1),
      "status: complete",
    ]).missing,
    ["status: done"],
  );
  assert.match(
    validateProviderStatusLabels([
      ...canonicalStates,
      "status: ready",
    ]).failures.join("\n"),
    /Duplicate lifecycle status labels/u,
  );
});

test("plans set-to-desired reconciliation for empty, single, and multi-label sets", () => {
  assert.deepEqual(planStatusLabelReconciliation([], "status: ready"), {
    apply: ["status: ready"],
    failures: [],
    ok: true,
    remove: [],
  });
  assert.deepEqual(
    planStatusLabelReconciliation(["status: ready"], "status: ready"),
    { apply: [], failures: [], ok: true, remove: [] },
  );
  assert.deepEqual(
    planStatusLabelReconciliation(
      ["status: new", "status: ready", "status: blocked"],
      "status: ready",
    ),
    {
      apply: [],
      failures: [],
      ok: true,
      remove: ["status: new", "status: blocked"],
    },
  );
});

test("fails read-back on zero labels, multiple labels, or changed issue identity", () => {
  const base = {
    actualIssueIdentity: "issue-25@2",
    desiredState: "status: ready",
    expectedIssueIdentity: "issue-25@2",
  };
  assert.deepEqual(
    verifyStatusLabelReadback({ ...base, labels: ["status: ready"] }),
    { failures: [], ok: true, state: "status: ready" },
  );
  assert.equal(verifyStatusLabelReadback({ ...base, labels: [] }).ok, false);
  assert.equal(
    verifyStatusLabelReadback({
      ...base,
      labels: ["status: ready", "status: blocked"],
    }).ok,
    false,
  );
  for (const labels of [
    ["status: new", "status: triaged"],
    ["status: triaged", "status: ready"],
  ]) {
    assert.equal(verifyStatusLabelReadback({ ...base, labels }).ok, false);
  }
  assert.equal(
    verifyStatusLabelReadback({
      ...base,
      actualIssueIdentity: "issue-25@3",
      labels: ["status: ready"],
    }).ok,
    false,
  );
});

test("accepts exactly the permitted source and requested-target label pairs", () => {
  assert.deepEqual(
    new Set(
      PERMITTED_LABEL_REQUESTS.map(({ source, target }) =>
        pairKey(source, target),
      ),
    ),
    expectedPermittedRequests(),
  );

  const permitted = expectedPermittedRequests();
  for (const source of canonicalStates) {
    for (const target of canonicalStates) {
      const result = validateTransitionRequest(validRequest(source, target));
      assert.equal(
        result.ok,
        permitted.has(pairKey(source, target)),
        pairKey(source, target),
      );
    }
  }
});

test("rejects unauthorized, stale, reasonless, mismatched-source, and removal requests", () => {
  const accepted = validRequest("status: new", "status: triaged");
  assert.equal(validateTransitionRequest(accepted).ok, true);

  for (const override of [
    { actorRole: "viewer" },
    { eventIdentity: "" },
    { currentState: "status: ready" },
    { requestedSource: "status: ready" },
    { requestedTarget: null },
  ]) {
    assert.equal(
      validateTransitionRequest({ ...accepted, ...override }).ok,
      false,
    );
  }

  assert.equal(
    validateTransitionRequest({
      ...validRequest("status: ready", "status: blocked"),
      blockingCondition: "",
    }).ok,
    false,
  );
  assert.equal(
    validateTransitionRequest({
      ...validRequest("status: ready", "status: waiting for user"),
      humanInput: "",
    }).ok,
    false,
  );
});

test("publishes the complete allowed-edge graph and rejects other edges", () => {
  const expected = expectedEdges();
  assert.deepEqual(ALLOWED_LIFECYCLE_EDGES, Object.fromEntries(expected));

  for (const source of canonicalStates) {
    for (const target of canonicalStates) {
      assert.equal(
        isAllowedLifecycleEdge(source, target),
        expected.get(source).includes(target),
        pairKey(source, target),
      );
    }
  }

  for (const [source, target] of [
    ["status: new", "status: ready"],
    ["status: ready", "status: pr open"],
    ["status: in progress", "status: ready for human review"],
    ["status: blocked", "status: ready for human review"],
    ["status: done", "status: ready"],
    ["status: invented", "status: new"],
  ]) {
    assert.equal(isAllowedLifecycleEdge(source, target), false);
  }
});
