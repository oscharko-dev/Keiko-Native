import assert from "node:assert/strict";
import test from "node:test";

import { readinessComment } from "./issue-readiness-action.mjs";
import { semanticIssueFingerprint } from "./issue-contract.mjs";
import { LIFECYCLE_STATES } from "./issue-lifecycle.mjs";
import { runIssueLifecycleAction } from "./issue-lifecycle-action.mjs";
import {
  LIFECYCLE_OBSERVATION_MARKER,
  LIFECYCLE_REQUEST_SCHEMA,
  lifecycleObservation,
  lifecycleObservationComment,
  lifecycleObservationRecords,
  lifecycleRequestReplay,
  parseLifecycleDispatchRequest,
} from "./issue-lifecycle-request.mjs";

const repository = "keiko/Keiko-Native";
const issueNumber = 27;
const issueTitle = "Lifecycle audit fixture";
const issueBody = [
  "## Planning contract",
  "",
  "- Contract version: `v2`",
  "",
  "## Execution Authority",
  "",
  "- Exact delivery target: `dev`",
].join("\n");
const validation = {
  failures: [],
  fingerprint: semanticIssueFingerprint(issueBody, issueTitle),
  version: "v2",
};
const workflowActor = {
  id: 41898282,
  login: "github-actions[bot]",
  type: "Bot",
};

function acceptedReadiness(id = 101) {
  return {
    body: readinessComment({
      actor: "planner",
      decision: { outcome: "accept", reasons: [] },
      now: "2026-07-28T09:00:00.000Z",
      validation,
    }),
    id,
    user: workflowActor,
  };
}

function currentIssue(labels, overrides = {}) {
  return {
    assignees: [],
    body: issueBody,
    id: 42,
    labels: labels.map((name) => ({ name })),
    node_id: "issue-node-42",
    number: issueNumber,
    state: "open",
    title: issueTitle,
    updated_at: "2026-07-28T09:00:00Z",
    ...overrides,
  };
}

function dispatchEvent({
  actor = "planner",
  expectedSource = "status: triaged",
  issue = String(issueNumber),
  orderingAttestation = "not-applicable",
  reason = "",
  requestIdentity = "request-27-audit-0001",
  requestedTarget = "status: ready",
} = {}) {
  return {
    inputs: {
      expected_source: expectedSource,
      issue_number: issue,
      ordering_attestation: orderingAttestation,
      reason,
      request_identity: requestIdentity,
      requested_target: requestedTarget,
      schema: LIFECYCLE_REQUEST_SCHEMA,
    },
    ref: "dev",
    repository: { full_name: repository },
    sender: { login: actor },
  };
}

function parsedDispatch(event = dispatchEvent(), overrides = {}) {
  return parseLifecycleDispatchRequest({
    actor: event.sender.login,
    event,
    protectedRef: "refs/heads/dev",
    repository,
    runAttempt: "1",
    runId: "30350729504",
    ...overrides,
  });
}

function trustedComment(body, overrides = {}) {
  return {
    body,
    id: 202,
    user: workflowActor,
    ...overrides,
  };
}

function installEnvironment(t, activation = "disabled") {
  const originalRepository = process.env.GITHUB_REPOSITORY;
  const originalActivation = process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
  const originalContract = process.env.KEIKO_PR_CONTRACT_RESULT;
  process.env.GITHUB_REPOSITORY = repository;
  process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = activation;
  delete process.env.KEIKO_PR_CONTRACT_RESULT;
  t.after(() => {
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
    if (originalActivation === undefined)
      delete process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
    else process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = originalActivation;
    if (originalContract === undefined)
      delete process.env.KEIKO_PR_CONTRACT_RESULT;
    else process.env.KEIKO_PR_CONTRACT_RESULT = originalContract;
  });
}

function requestHarness(
  t,
  {
    activation = "disabled",
    comments = [acceptedReadiness()],
    initialIssue = currentIssue(["status: triaged"]),
    permission = "write",
    postComment,
  } = {},
) {
  installEnvironment(t, activation);
  const calls = [];
  let observedIssue = structuredClone(initialIssue);
  const request = async (path, options = {}) => {
    const method = options.method ?? "GET";
    calls.push({ method, path, payload: options.payload });
    if (path.includes("/collaborators/") && path.endsWith("/permission"))
      return { permission };
    if (path.includes("/comments?")) return comments;
    if (path.endsWith("/comments") && method === "POST") {
      if (postComment !== undefined)
        return postComment(options.payload?.body, calls);
      return trustedComment(options.payload?.body);
    }
    if (path.includes("/labels?"))
      return LIFECYCLE_STATES.map((name) => ({ name }));
    if (path.endsWith(`/issues/${issueNumber}`) && method === "GET")
      return observedIssue;
    if (
      path.includes(`/issues/${issueNumber}/labels/`) &&
      method === "DELETE"
    ) {
      const removed = decodeURIComponent(path.split("/").at(-1));
      observedIssue = {
        ...observedIssue,
        labels: observedIssue.labels.filter((label) => label.name !== removed),
      };
      return {};
    }
    if (path.endsWith(`/issues/${issueNumber}/labels`) && method === "POST") {
      const names = new Set(observedIssue.labels.map((label) => label.name));
      for (const label of options.payload?.labels ?? []) names.add(label);
      observedIssue = {
        ...observedIssue,
        labels: [...names].map((name) => ({ name })),
      };
      return observedIssue.labels;
    }
    if (path.endsWith(`/issues/${issueNumber}`) && method === "PATCH") {
      observedIssue = {
        ...observedIssue,
        labels: (options.payload?.labels ?? []).map((name) => ({ name })),
      };
      return observedIssue;
    }
    if (path.includes("/pulls?")) return [];
    return {};
  };
  return {
    calls,
    currentIssue: () => structuredClone(observedIssue),
    request,
    setIssue(next) {
      observedIssue = structuredClone(next);
    },
  };
}

function dispatchContext(actor) {
  return {
    actor,
    protectedRef: "refs/heads/dev",
    runAttempt: "1",
    runId: "30350729504",
  };
}

test("a changed reason conflicts with the same request identity and malformed bot text has no replay authority", () => {
  const original = parsedDispatch(
    dispatchEvent({
      actor: "implementer",
      expectedSource: "status: ready",
      reason: "dependency A is unavailable",
      requestIdentity: "request-27-audit-reason",
      requestedTarget: "status: blocked",
    }),
  );
  const changedReason = parsedDispatch(
    dispatchEvent({
      actor: "implementer",
      expectedSource: "status: ready",
      reason: "dependency B is unavailable",
      requestIdentity: "request-27-audit-reason",
      requestedTarget: "status: blocked",
    }),
  );
  assert.equal(original.ok, true);
  assert.equal(changedReason.ok, true);
  assert.equal(
    original.request.requestIdentityDigest,
    changedReason.request.requestIdentityDigest,
  );
  assert.notEqual(
    original.request.requestDigest,
    changedReason.request.requestDigest,
  );

  const observation = lifecycleObservation({
    activation: "disabled",
    issueNumber,
    now: new Date("2026-07-28T10:00:00.000Z"),
    request: original.request,
    result: {
      desiredState: "status: blocked",
      outcome: "planned",
      readiness: { current: true, ok: true },
    },
  });
  const recorded = trustedComment(lifecycleObservationComment(observation));
  assert.equal(
    lifecycleRequestReplay([recorded], changedReason.request),
    "request_identity_conflict",
  );

  const malformed = trustedComment(
    `${LIFECYCLE_OBSERVATION_MARKER}\n- Request identity digest: \`${original.request.requestIdentityDigest}\`\n- Request digest: \`${original.request.requestDigest}\``,
  );
  assert.deepEqual(lifecycleObservationRecords([malformed]), []);
  assert.equal(
    lifecycleRequestReplay([malformed], original.request),
    "malformed_lifecycle_observation",
  );
});

test("planned observations expose readiness, topology, mutation, and read-back classes without raw reasons", () => {
  const parsed = parsedDispatch();
  assert.equal(parsed.ok, true);
  const observation = lifecycleObservation({
    activation: "disabled",
    issueNumber,
    now: new Date("2026-07-28T10:01:00.000Z"),
    request: parsed.request,
    result: {
      desiredState: "status: ready",
      outcome: "planned",
      readiness: { current: true, ok: true },
    },
  });
  assert.equal(observation.readinessClass, "current");
  assert.equal(observation.topologyClass, "accepted");
  assert.equal(observation.mutationResult, "guarded-off");
  assert.equal(observation.readbackResult, "not-attempted");
  const body = lifecycleObservationComment(observation);
  assert.match(body, /- Readiness class: `current`/u);
  assert.match(body, /- Topology class: `accepted`/u);
  assert.match(body, /- Mutation result: `guarded-off`/u);
  assert.match(body, /- Read-back result: `not-attempted`/u);
  assert.doesNotMatch(body, /dependency A|dependency B|request body/iu);
  assert.deepEqual(lifecycleObservationRecords([trustedComment(body)]), [
    {
      commentId: 202,
      issueNumber,
      requestDigest: parsed.request.requestDigest,
      requestIdentityDigest: parsed.request.requestIdentityDigest,
    },
  ]);
});

test("triaged-to-ready ingress validates current readiness and verifies the observation read-back", async (t) => {
  const harness = requestHarness(t, {
    initialIssue: currentIssue(["type: task", "status: triaged"]),
    permission: "triage",
  });
  const event = dispatchEvent({
    requestIdentity: "request-27-audit-ready",
  });
  const result = await runIssueLifecycleAction({
    dispatchContext: dispatchContext("planner"),
    event,
    now: new Date("2026-07-28T10:02:00.000Z"),
    request: harness.request,
  });
  assert.equal(result.outcome, "planned");
  assert.equal(result.desiredState, "status: ready");
  assert.equal(result.observation.readinessClass, "current");
  assert.equal(result.observation.topologyClass, "accepted");
  assert.equal(result.observation.mutationResult, "guarded-off");
  assert.equal(result.observation.readbackResult, "not-attempted");
  assert.equal(
    harness.calls.filter(
      ({ method, path }) =>
        method === "POST" && path.endsWith(`/issues/${issueNumber}/comments`),
    ).length,
    1,
  );
  assert.equal(
    harness.calls.filter(
      ({ method, path }) =>
        method !== "GET" && !path.endsWith(`/issues/${issueNumber}/comments`),
    ).length,
    0,
  );

  const missingReadiness = requestHarness(t, {
    comments: [],
    initialIssue: currentIssue(["type: task", "status: triaged"]),
    permission: "triage",
  });
  const rejected = await runIssueLifecycleAction({
    dispatchContext: dispatchContext("planner"),
    event: dispatchEvent({
      requestIdentity: "request-27-audit-ready-missing",
    }),
    request: missingReadiness.request,
  });
  assert.equal(rejected.outcome, "failed");
  assert.deepEqual(rejected.failures, ["current_readiness_required"]);
});

test("the stable pre-mutation read includes assignment authority inputs", async (t) => {
  const original = currentIssue(["status: ready"], {
    assignees: [{ id: 7, login: "runner" }],
  });
  const harness = requestHarness(t, {
    activation: "enabled",
    initialIssue: original,
  });
  let issueReads = 0;
  const request = async (path, options) => {
    if (path.endsWith(`/issues/${issueNumber}`)) {
      issueReads += 1;
      if (issueReads >= 2)
        return currentIssue(["status: ready"], { assignees: [] });
    }
    return harness.request(path, options);
  };
  const result = await runIssueLifecycleAction({
    event: {
      action: "reopened",
      expectedReadinessCommentId: 101,
      issue: { number: issueNumber },
    },
    request,
  });
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.failures, ["issue_changed_before_reconciliation"]);
  assert.equal(
    harness.calls.filter(({ method }) =>
      ["DELETE", "POST", "PATCH"].includes(method),
    ).length,
    0,
  );
});

test("assignment and pull-request effects reject unauthorized actors before mutation", async (t) => {
  const assignment = requestHarness(t, {
    activation: "enabled",
    initialIssue: currentIssue(["status: ready"], {
      assignees: [{ id: 7, login: "runner" }],
    }),
    permission: "read",
  });
  const assignmentResult = await runIssueLifecycleAction({
    event: {
      action: "assigned",
      assignee: { login: "runner" },
      expectedReadinessCommentId: 101,
      issue: { number: issueNumber },
      sender: { login: "outside-collaborator" },
    },
    request: assignment.request,
  });
  assert.equal(assignmentResult.outcome, "failed");
  assert.deepEqual(assignmentResult.failures, ["validated_claim_required"]);
  assert.equal(
    assignment.calls.filter(({ method }) =>
      ["DELETE", "POST", "PATCH"].includes(method),
    ).length,
    0,
  );

  const pullRequest = requestHarness(t, {
    activation: "enabled",
    initialIssue: currentIssue(["status: in progress"]),
    permission: "read",
  });
  const pullRequestResult = await runIssueLifecycleAction({
    event: {
      action: "opened",
      expectedReadinessCommentId: 101,
      prContract: { validated: true },
      pull_request: {
        body: "## Scope\n\n- Accepted issue: #27",
        draft: true,
        head: { ref: "outside/change", sha: "a".repeat(40) },
        node_id: "pr-node-outsider",
        number: 40,
      },
      sender: { login: "outside-collaborator" },
    },
    request: pullRequest.request,
  });
  assert.equal(pullRequestResult.outcome, "failed");
  assert.match(pullRequestResult.failures.join("\n"), /actor|authorized/iu);
  assert.equal(
    pullRequest.calls.filter(({ method }) =>
      ["DELETE", "POST", "PATCH"].includes(method),
    ).length,
    0,
  );
});

test("a current paused issue can explicitly resume but never jumps directly back to review", async (t) => {
  const readyResume = requestHarness(t, {
    initialIssue: currentIssue(["type: task", "status: blocked"]),
    permission: "write",
  });
  const result = await runIssueLifecycleAction({
    dispatchContext: dispatchContext("planner"),
    event: dispatchEvent({
      expectedSource: "status: blocked",
      requestIdentity: "request-27-audit-resume",
      requestedTarget: "status: ready",
    }),
    request: readyResume.request,
  });
  assert.equal(result.outcome, "planned");
  assert.equal(result.desiredState, "status: ready");
  assert.notEqual(result.desiredState, "status: ready for human review");
  assert.deepEqual(result.plan, {
    apply: ["status: ready"],
    failures: [],
    ok: true,
    remove: ["status: blocked"],
  });

  const claimResume = requestHarness(t, {
    initialIssue: currentIssue(["status: waiting for user"], {
      assignees: [{ id: 7, login: "runner" }],
    }),
    permission: "write",
  });
  const claimResult = await runIssueLifecycleAction({
    event: {
      action: "assigned",
      assignee: { login: "runner" },
      expectedReadinessCommentId: 101,
      issue: { number: issueNumber },
      sender: { login: "maintainer" },
    },
    request: claimResume.request,
  });
  assert.equal(claimResult.outcome, "planned");
  assert.equal(claimResult.desiredState, "status: in progress");
  assert.notEqual(claimResult.desiredState, "status: ready for human review");
});

test("a retry completes a partial label mutation and raw active-state gestures are repaired", async (t) => {
  const partial = requestHarness(t, {
    activation: "enabled",
    initialIssue: currentIssue(["status: ready"]),
  });
  let failFirstApply = true;
  const partialRequest = async (path, options = {}) => {
    if (
      failFirstApply &&
      path.endsWith(`/issues/${issueNumber}`) &&
      options.method === "PATCH"
    ) {
      failFirstApply = false;
      throw new Error("GitHub API failed with 422");
    }
    return partial.request(path, options);
  };
  const partialFailure = await runIssueLifecycleAction({
    event: {
      action: "reopened",
      expectedReadinessCommentId: 101,
      issue: { number: issueNumber },
    },
    request: partialRequest,
  });
  assert.equal(partialFailure.outcome, "failed");
  assert.equal(partialFailure.mutationResult, "failed");
  assert.equal(partialFailure.readbackResult, "not-verified");
  assert.deepEqual(
    partial
      .currentIssue()
      .labels.map(({ name }) => name)
      .filter((name) => name.startsWith("status: ")),
    ["status: ready"],
  );
  const recovered = await runIssueLifecycleAction({
    event: {
      action: "reopened",
      expectedReadinessCommentId: 101,
      issue: { number: issueNumber },
    },
    request: partialRequest,
  });
  assert.equal(recovered.outcome, "applied");
  assert.deepEqual(
    partial
      .currentIssue()
      .labels.map(({ name }) => name)
      .filter((name) => name.startsWith("status: ")),
    ["status: new"],
  );

  const raw = requestHarness(t, {
    activation: "enabled",
    initialIssue: currentIssue(["status: ready", "status: in progress"]),
  });
  const rawResult = await runIssueLifecycleAction({
    event: {
      action: "labeled",
      issue: { number: issueNumber },
      label: { name: "status: in progress" },
      sender: { login: "outside-collaborator" },
    },
    request: raw.request,
  });
  assert.equal(rawResult.outcome, "failed");
  assert.deepEqual(
    raw
      .currentIssue()
      .labels.map(({ name }) => name)
      .filter((name) => name.startsWith("status: ")),
    ["status: ready"],
  );
  assert.ok(
    raw.calls.some(
      ({ method, path }) =>
        method === "DELETE" &&
        path.endsWith(encodeURIComponent("status: in progress")),
    ),
  );
});
