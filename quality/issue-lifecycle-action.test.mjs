import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readinessComment } from "./issue-readiness-action.mjs";
import { semanticIssueFingerprint } from "./issue-contract.mjs";
import { LIFECYCLE_STATES } from "./issue-lifecycle.mjs";
import {
  runIssueLifecycleAction,
  runIssueLifecycleCli,
} from "./issue-lifecycle-action.mjs";

const issueBody = "## Planning contract\n\n- Contract version: `v2`\n";
const issueTitle = "Governed lifecycle test issue";
const validation = {
  failures: [],
  fingerprint: semanticIssueFingerprint(issueBody, issueTitle),
  version: "v2",
};
const reopenedEvent = {
  action: "reopened",
  expectedReadinessCommentId: 101,
  issue: { number: 27 },
};
const labeledEvent = { action: "labeled", issue: { number: 27 } };

function machineReadinessComment(id = 101) {
  return {
    body: readinessComment({
      actor: "planner",
      decision: { outcome: "accept", reasons: [] },
      now: "2026-07-17T12:00:00.000Z",
      validation,
    }),
    id,
    user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
  };
}

function issue(labels = ["status: ready"], overrides = {}) {
  return {
    body: issueBody,
    id: 42,
    labels: labels.map((name) => ({ name })),
    node_id: "issue-node-42",
    number: 27,
    title: issueTitle,
    ...overrides,
  };
}

function requestMock(
  t,
  {
    comments = [machineReadinessComment()],
    failures = {},
    issueLabels,
    issueOverrides,
    permission = "write",
    pullRequests = [],
  } = {},
) {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({
      method: options.method ?? "GET",
      path,
      payload: options.payload,
    });
    const status = failures[path] ?? failures[options.method ?? "GET"];
    if (status !== undefined)
      throw new Error(`GitHub API failed with ${status}`);
    if (path.includes("/collaborators/") && path.endsWith("/permission")) {
      if (permission === "error") throw new Error("GitHub API failed with 503");
      return { permission };
    }
    if (path.includes("/comments?")) return comments;
    if (path.includes("/labels?"))
      return LIFECYCLE_STATES.map((name) => ({ name }));
    if (path.includes("/pulls?")) return pullRequests;
    if (path.includes("/issues/27")) return issue(issueLabels, issueOverrides);
    return {};
  };
  const originalRepository = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY = "keiko/Keiko-Native";
  t.after(() => {
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
  });
  return { calls, request };
}

async function actionOutcome(event, request) {
  return (await runIssueLifecycleAction({ event, request })).outcome;
}

test("workflow loads protected dev code with read-only credentials", async () => {
  const workflow = await readFile(
    ".github/workflows/issue-lifecycle.yml",
    "utf8",
  );
  assert.match(
    workflow,
    /types: \[assigned, closed, edited, labeled, reopened, unassigned, unlabeled\]/u,
  );
  assert.match(
    workflow,
    /group: issue-lifecycle-\$\{\{ github\.event\.issue\.number \}\}/u,
  );
  assert.match(workflow, /ref: dev/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /contents: read/u);
  assert.doesNotMatch(workflow, /contents: write/u);
  assert.doesNotMatch(workflow, /pull_request_target/u);

  const pullRequestWorkflow = await readFile(
    ".github/workflows/pr-contract.yml",
    "utf8",
  );
  assert.match(pullRequestWorkflow, /pull_request_target:/u);
  assert.match(
    pullRequestWorkflow,
    /run: node quality\/issue-lifecycle-action\.mjs/u,
  );
  assert.match(
    pullRequestWorkflow,
    /KEIKO_ISSUE_LIFECYCLE_ACTIVATION: disabled/u,
  );
  assert.match(pullRequestWorkflow, /KEIKO_PR_CONTRACT_RESULT=success/u);
  assert.match(pullRequestWorkflow, /if: always\(\)/u);
  assert.match(pullRequestWorkflow, /closed/u);
});

test("reloads trusted issue state and plans reconciliation with activation disabled", async (t) => {
  const { calls, request } = requestMock(t, {
    issueLabels: ["status: ready"],
  });
  process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = "disabled";
  t.after(() => delete process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION);

  const result = await runIssueLifecycleAction({
    event: reopenedEvent,
    now: new Date("2026-07-17T12:00:00.000Z"),
    request,
  });

  assert.equal(result.outcome, "planned");
  assert.equal(result.activation, "disabled");
  assert.deepEqual(result.plan.remove, ["status: ready"]);
  assert.deepEqual(result.plan.apply, ["status: new"]);
  assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
});

test("applies and verifies reconciliation only when activation is enabled", async (t) => {
  let reloaded = false;
  const { calls, request } = requestMock(t, { issueLabels: ["status: ready"] });
  const wrappedRequest = async (path, options) => {
    if (path.includes("/issues/27") && reloaded) return issue(["status: new"]);
    const response = await request(path, options);
    if (options?.method === "POST") reloaded = true;
    return response;
  };
  process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = "enabled";
  t.after(() => delete process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION);

  const result = await runIssueLifecycleAction({
    event: reopenedEvent,
    request: wrappedRequest,
  });

  assert.equal(result.outcome, "applied");
  assert.ok(calls.some((call) => call.method === "DELETE"));
  assert.ok(calls.some((call) => call.method === "POST"));
});

test("fails closed on provider errors and malformed provider state", async (t) => {
  for (const status of [403, 404, 409, 422, 429]) {
    const { request } = requestMock(t, {
      failures: { "/repos/keiko/Keiko-Native/issues/27": status },
    });
    await assert.rejects(
      runIssueLifecycleAction({
        event: reopenedEvent,
        request,
      }),
      new RegExp(String(status), "u"),
    );
  }

  const timeout = async () => {
    throw new Error("timeout");
  };
  await assert.rejects(
    runIssueLifecycleAction({
      event: reopenedEvent,
      request: timeout,
    }),
    /timeout/u,
  );

  const malformed = requestMock(t, { issueLabels: undefined });
  await assert.rejects(
    runIssueLifecycleAction({
      event: reopenedEvent,
      request: async (path, options) =>
        path.includes("/issues/27")
          ? { number: 27, title: issueTitle }
          : malformed.request(path, options),
    }),
    /malformed/u,
  );

  const malformedComments = requestMock(t);
  await assert.rejects(
    runIssueLifecycleAction({
      event: reopenedEvent,
      request: async (path, options) =>
        path.includes("/comments?")
          ? {}
          : malformedComments.request(path, options),
    }),
    /comments response is malformed/u,
  );
});

test("fails closed on zero-label and multi-label reloads", async (t) => {
  const zero = requestMock(t, { issueLabels: [] });
  assert.equal(await actionOutcome(labeledEvent, zero.request), "failed");

  const multi = requestMock(t, {
    issueLabels: ["status: ready", "status: blocked"],
  });
  assert.equal(await actionOutcome(labeledEvent, multi.request), "failed");
});

test("ignores events without a lifecycle destination and fails bad read-back", async (t) => {
  const ignored = requestMock(t);
  assert.equal(
    await actionOutcome(
      { action: "assigned", issue: { labels: ["status: ready"], number: 27 } },
      ignored.request,
    ),
    "ignored",
  );

  let reloaded = false;
  const active = requestMock(t, { issueLabels: ["status: ready"] });
  process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = "enabled";
  t.after(() => delete process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION);
  const result = await runIssueLifecycleAction({
    event: reopenedEvent,
    request: async (path, options) => {
      if (path.includes("/issues/27") && reloaded)
        return { ...issue(["status: blocked"]), node_id: "issue-node-42" };
      const response = await active.request(path, options);
      if (options?.method === "POST") reloaded = true;
      return response;
    },
  });
  assert.equal(result.outcome, "failed");
  assert.match(result.failures.join("\n"), /does not equal the desired state/u);
});

test("plans validated assignment claim and release transitions", async (t) => {
  const claim = requestMock(t, {
    issueLabels: ["status: ready"],
    issueOverrides: { assignees: [{ login: "runner" }] },
  });
  const claimResult = await runIssueLifecycleAction({
    event: {
      action: "assigned",
      assignee: { login: "runner" },
      expectedReadinessCommentId: 101,
      issue: { number: 27 },
      sender: { login: "maintainer" },
    },
    request: claim.request,
  });
  assert.equal(claimResult.outcome, "planned");
  assert.equal(claimResult.desiredState, "status: in progress");
  assert.deepEqual(claimResult.plan, {
    apply: ["status: in progress"],
    failures: [],
    ok: true,
    remove: ["status: ready"],
  });
  assert.ok(
    claim.calls.some((call) =>
      call.path.includes("/collaborators/maintainer/permission"),
    ),
  );

  const unauthorizedClaim = requestMock(t, {
    issueLabels: ["status: ready"],
    issueOverrides: { assignees: [{ login: "runner" }] },
    permission: "read",
  });
  const previousActivation = process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
  process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = "enabled";
  try {
    const unauthorizedClaimResult = await runIssueLifecycleAction({
      event: {
        action: "assigned",
        assignee: { login: "runner" },
        expectedReadinessCommentId: 101,
        issue: { number: 27 },
        sender: { login: "outside-collaborator" },
      },
      request: unauthorizedClaim.request,
    });
    assert.equal(unauthorizedClaimResult.outcome, "failed");
    assert.deepEqual(unauthorizedClaimResult.failures, [
      "validated_claim_required",
    ]);
  } finally {
    if (previousActivation === undefined)
      delete process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
    else process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = previousActivation;
  }

  const release = requestMock(t, { issueLabels: ["status: in progress"] });
  const releaseResult = await runIssueLifecycleAction({
    event: {
      action: "unassigned",
      expectedReadinessCommentId: 101,
      hasOpenPullRequest: false,
      issue: { number: 27 },
      release: { id: "release-1", validated: true },
    },
    request: release.request,
  });
  assert.equal(releaseResult.outcome, "planned");
  assert.equal(releaseResult.desiredState, "status: ready");
  assert.deepEqual(releaseResult.plan, {
    apply: ["status: ready"],
    failures: [],
    ok: true,
    remove: ["status: in progress"],
  });

  const rawRelease = requestMock(t, {
    issueLabels: ["status: in progress"],
    issueOverrides: { assignees: [] },
  });
  const rawReleaseResult = await runIssueLifecycleAction({
    event: {
      action: "unassigned",
      assignee: { login: "runner" },
      expectedReadinessCommentId: 101,
      issue: { number: 27 },
      sender: { login: "maintainer" },
    },
    request: rawRelease.request,
  });
  assert.equal(rawReleaseResult.outcome, "planned");
  assert.equal(rawReleaseResult.desiredState, "status: ready");
  assert.ok(
    rawRelease.calls.some((call) =>
      call.path.includes("/pulls?state=open&per_page=100&page=1"),
    ),
  );
});

test("plans pull request lifecycle topology from trusted PR events", async (t) => {
  const opened = requestMock(t, { issueLabels: ["status: in progress"] });
  const openedResult = await runIssueLifecycleAction({
    event: {
      action: "opened",
      expectedReadinessCommentId: 101,
      prContract: { validated: true },
      pull_request: {
        body: "## Scope\n\n- Accepted issue: #27",
        draft: true,
        head: { sha: "a".repeat(40) },
        node_id: "pr-node-40",
      },
    },
    request: opened.request,
  });
  assert.equal(openedResult.outcome, "planned");
  assert.equal(openedResult.desiredState, "status: pr open");
  assert.deepEqual(openedResult.plan, {
    apply: ["status: pr open"],
    failures: [],
    ok: true,
    remove: ["status: in progress"],
  });

  const nonDraftOpened = requestMock(t, {
    issueLabels: ["status: in progress"],
  });
  const nonDraftOpenedResult = await runIssueLifecycleAction({
    event: {
      action: "opened",
      expectedReadinessCommentId: 101,
      prContract: { validated: true },
      pull_request: {
        body: "## Scope\n\n- Accepted issue: #27",
        draft: false,
        head: { sha: "d".repeat(40) },
        node_id: "pr-node-41",
      },
    },
    request: nonDraftOpened.request,
  });
  assert.equal(nonDraftOpenedResult.outcome, "planned");
  assert.equal(nonDraftOpenedResult.desiredState, "status: pr open");
  assert.deepEqual(nonDraftOpenedResult.plan, {
    apply: ["status: pr open"],
    failures: [],
    ok: true,
    remove: ["status: in progress"],
  });

  const activatedMissingContract = requestMock(t, {
    issueLabels: ["status: in progress"],
  });
  const previousActivation = process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
  const previousContractResult = process.env.KEIKO_PR_CONTRACT_RESULT;
  process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = "enabled";
  delete process.env.KEIKO_PR_CONTRACT_RESULT;
  try {
    const activatedMissingContractResult = await runIssueLifecycleAction({
      event: {
        action: "opened",
        expectedReadinessCommentId: 101,
        pull_request: {
          body: "## Scope\n\n- Accepted issue: #27",
          draft: false,
          head: { sha: "d".repeat(40) },
          node_id: "pr-node-41",
        },
      },
      request: activatedMissingContract.request,
    });
    assert.equal(activatedMissingContractResult.outcome, "failed");
    assert.deepEqual(activatedMissingContractResult.failures, [
      "pr_contract_success_required",
    ]);
  } finally {
    if (previousActivation === undefined)
      delete process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
    else process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = previousActivation;
    if (previousContractResult === undefined)
      delete process.env.KEIKO_PR_CONTRACT_RESULT;
    else process.env.KEIKO_PR_CONTRACT_RESULT = previousContractResult;
  }

  const readyForReview = requestMock(t, {
    issueLabels: ["status: pr open"],
  });
  const readyForReviewResult = await runIssueLifecycleAction({
    event: {
      action: "ready_for_review",
      prContract: { validated: true },
      pull_request: {
        body: "## Scope\n\n- Accepted issue: #27",
        head: { sha: "c".repeat(40) },
        node_id: "pr-node-40",
      },
    },
    request: readyForReview.request,
  });
  assert.equal(readyForReviewResult.outcome, "planned");
  assert.equal(readyForReviewResult.desiredState, "status: pr open");
  assert.deepEqual(readyForReviewResult.plan, {
    apply: [],
    failures: [],
    ok: true,
    remove: [],
  });

  const synchronizedReady = requestMock(t, {
    issueLabels: ["status: ready for human review"],
  });
  const synchronizedReadyResult = await runIssueLifecycleAction({
    event: {
      action: "synchronize",
      prContract: { validated: true },
      pull_request: {
        body: "## Scope\n\n- Accepted issue: #27",
        draft: false,
        head: { sha: "c".repeat(40) },
        node_id: "pr-node-40",
      },
    },
    request: synchronizedReady.request,
  });
  assert.equal(synchronizedReadyResult.outcome, "planned");
  assert.equal(synchronizedReadyResult.desiredState, "status: pr open");
  assert.deepEqual(synchronizedReadyResult.plan, {
    apply: ["status: pr open"],
    failures: [],
    ok: true,
    remove: ["status: ready for human review"],
  });

  const synchronizedContractFailure = requestMock(t, {
    issueLabels: ["status: ready for human review"],
  });
  process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = "enabled";
  delete process.env.KEIKO_PR_CONTRACT_RESULT;
  try {
    const synchronizedContractFailureResult = await runIssueLifecycleAction({
      event: {
        action: "synchronize",
        pull_request: {
          body: "## Scope\n\n- Accepted issue: #27",
          draft: false,
          head: { sha: "c".repeat(40) },
          node_id: "pr-node-40",
        },
      },
      request: synchronizedContractFailure.request,
    });
    assert.equal(synchronizedContractFailureResult.outcome, "failed");
    assert.deepEqual(synchronizedContractFailureResult.failures, [
      "pr_contract_success_required",
    ]);
  } finally {
    if (previousActivation === undefined)
      delete process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
    else process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = previousActivation;
    if (previousContractResult === undefined)
      delete process.env.KEIKO_PR_CONTRACT_RESULT;
    else process.env.KEIKO_PR_CONTRACT_RESULT = previousContractResult;
  }

  const preActivationMissingContract = requestMock(t, {
    issueLabels: ["status: in progress"],
  });
  const preActivationMissingContractResult = await runIssueLifecycleAction({
    event: {
      action: "opened",
      expectedReadinessCommentId: 101,
      pull_request: {
        body: "## Scope\n\n- Accepted issue: #27",
        draft: true,
        head: { sha: "d".repeat(40) },
        node_id: "pr-node-43",
      },
    },
    request: preActivationMissingContract.request,
  });
  assert.equal(preActivationMissingContractResult.outcome, "ignored");
  assert.equal(
    preActivationMissingContractResult.reason,
    "pre_activation_pr_contract_required",
  );

  const closedWithAnotherOpen = requestMock(t, {
    issueLabels: ["status: pr open"],
    pullRequests: [
      {
        body: "## Scope\n\n- Accepted issue: #27",
        head: { sha: "f".repeat(40) },
        node_id: "pr-node-41",
      },
      {
        body: "## Scope\n\n- Accepted issue: #27",
        head: { sha: "e".repeat(40) },
        node_id: "pr-node-42",
      },
    ],
  });
  const closedWithAnotherOpenResult = await runIssueLifecycleAction({
    event: {
      action: "closed",
      prContract: { validated: true },
      pull_request: {
        body: "## Scope\n\n- Accepted issue: #27",
        head: { sha: "f".repeat(40) },
        merged: false,
        node_id: "pr-node-41",
      },
    },
    request: closedWithAnotherOpen.request,
  });
  assert.equal(closedWithAnotherOpenResult.outcome, "planned");
  assert.equal(closedWithAnotherOpenResult.desiredState, "status: pr open");
  assert.deepEqual(closedWithAnotherOpenResult.plan, {
    apply: [],
    failures: [],
    ok: true,
    remove: [],
  });
  assert.ok(
    closedWithAnotherOpen.calls.some((call) =>
      call.path.includes("/pulls?state=open&per_page=100&page=1"),
    ),
  );

  const closedWithOnlyStaleSelfOpen = requestMock(t, {
    issueLabels: ["status: pr open"],
    pullRequests: [
      {
        body: "## Scope\n\n- Accepted issue: #27",
        head: { sha: "f".repeat(40) },
        node_id: "pr-node-41",
      },
    ],
  });
  const closedWithOnlyStaleSelfOpenResult = await runIssueLifecycleAction({
    event: {
      action: "closed",
      pull_request: {
        body: "## Scope\n\n- Accepted issue: #27",
        head: { sha: "f".repeat(40) },
        merged: false,
        node_id: "pr-node-41",
      },
    },
    request: closedWithOnlyStaleSelfOpen.request,
  });
  assert.equal(closedWithOnlyStaleSelfOpenResult.outcome, "planned");
  assert.equal(closedWithOnlyStaleSelfOpenResult.desiredState, "status: ready");
  assert.deepEqual(closedWithOnlyStaleSelfOpenResult.plan, {
    apply: ["status: ready"],
    failures: [],
    ok: true,
    remove: ["status: pr open"],
  });

  const closedWithRetainedClaim = requestMock(t, {
    issueLabels: ["status: ready for human review"],
    issueOverrides: { assignees: [{ login: "runner" }] },
  });
  const closedWithRetainedClaimResult = await runIssueLifecycleAction({
    event: {
      action: "closed",
      pull_request: {
        body: "## Scope\n\n- Accepted issue: #27",
        head: { sha: "f".repeat(40) },
        merged: false,
        node_id: "pr-node-41",
      },
    },
    request: closedWithRetainedClaim.request,
  });
  assert.equal(closedWithRetainedClaimResult.outcome, "planned");
  assert.equal(
    closedWithRetainedClaimResult.desiredState,
    "status: in progress",
  );
  assert.deepEqual(closedWithRetainedClaimResult.plan, {
    apply: ["status: in progress"],
    failures: [],
    ok: true,
    remove: ["status: ready for human review"],
  });

  const preActivationReady = requestMock(t, { issueLabels: ["status: ready"] });
  const preActivationReadyResult = await runIssueLifecycleAction({
    event: {
      action: "opened",
      expectedReadinessCommentId: 101,
      pull_request: {
        body: "## Scope\n\n- Accepted issue: #27",
        head: { sha: "a".repeat(40) },
        node_id: "pr-node-40",
      },
    },
    request: preActivationReady.request,
  });
  assert.equal(preActivationReadyResult.outcome, "ignored");
  assert.equal(preActivationReadyResult.reason, "pre_activation_pr_topology");

  const preActivationUnlabeled = requestMock(t, { issueLabels: [] });
  const preActivationUnlabeledResult = await runIssueLifecycleAction({
    event: {
      action: "synchronize",
      expectedReadinessCommentId: 101,
      pull_request: {
        body: "## Scope\n\n- Accepted issue: #27",
        head: { sha: "b".repeat(40) },
        node_id: "pr-node-40",
      },
    },
    request: preActivationUnlabeled.request,
  });
  assert.equal(preActivationUnlabeledResult.outcome, "ignored");
  assert.equal(
    preActivationUnlabeledResult.reason,
    "pre_activation_pr_topology",
  );
});

test("removes lifecycle labels for non-completed closures", async (t) => {
  const planned = requestMock(t, {
    issueLabels: ["status: ready", "status: blocked"],
    issueOverrides: { state: "closed", state_reason: "not_planned" },
  });
  const plannedResult = await runIssueLifecycleAction({
    event: {
      action: "closed",
      issue: { number: 27, state_reason: "not_planned" },
    },
    request: planned.request,
  });
  assert.equal(plannedResult.outcome, "planned");
  assert.equal(plannedResult.removeLifecycleLabels, true);
  assert.deepEqual(plannedResult.plan, {
    apply: [],
    failures: [],
    ok: true,
    remove: ["status: ready", "status: blocked"],
  });

  let deleteCount = 0;
  const active = requestMock(t, {
    issueLabels: ["status: ready", "status: blocked"],
    issueOverrides: { state: "closed", state_reason: "duplicate" },
  });
  const previousActivation = process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
  process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = "enabled";
  t.after(() => {
    if (previousActivation === undefined)
      delete process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
    else process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = previousActivation;
  });
  const appliedResult = await runIssueLifecycleAction({
    event: {
      action: "closed",
      issue: { number: 27, state_reason: "duplicate" },
    },
    request: async (path, options) => {
      if (path.includes("/issues/27") && deleteCount === 2)
        return issue([], { state: "closed", state_reason: "duplicate" });
      const response = await active.request(path, options);
      if (options?.method === "DELETE") deleteCount += 1;
      return response;
    },
  });
  assert.equal(appliedResult.outcome, "applied");
  assert.equal(appliedResult.removeLifecycleLabels, true);
  assert.equal(deleteCount, 2);

  let malformedDeleteCount = 0;
  const malformedReadback = requestMock(t, {
    issueLabels: ["status: ready", "status: blocked"],
    issueOverrides: { state: "closed", state_reason: "not_planned" },
  });
  const malformedResult = await runIssueLifecycleAction({
    event: {
      action: "closed",
      issue: { number: 27, state_reason: "not_planned" },
    },
    request: async (path, options) => {
      if (path.includes("/issues/27") && malformedDeleteCount === 2) {
        const { labels, ...withoutLabels } = issue([]);
        return withoutLabels;
      }
      const response = await malformedReadback.request(path, options);
      if (options?.method === "DELETE") malformedDeleteCount += 1;
      return response;
    },
  });
  assert.equal(malformedResult.outcome, "failed");
  assert.match(
    malformedResult.failures.join("\n"),
    /read-back labels are unavailable/u,
  );

  const missingInitialLabels = requestMock(t);
  const missingInitialLabelsResult = await runIssueLifecycleAction({
    event: {
      action: "closed",
      issue: { number: 27, state_reason: "not_planned" },
    },
    request: async (path, options) => {
      if (path.endsWith("/issues/27")) {
        const { labels, ...withoutLabels } = issue(["status: ready"], {
          state: "closed",
          state_reason: "not_planned",
        });
        return withoutLabels;
      }
      return missingInitialLabels.request(path, options);
    },
  });
  assert.equal(missingInitialLabelsResult.outcome, "failed");
  assert.match(
    missingInitialLabelsResult.failures.join("\n"),
    /lifecycle labels are unavailable/u,
  );

  const unsupported = requestMock(t, {
    issueLabels: ["status: ready"],
    issueOverrides: { state: "closed", state_reason: "unsupported" },
  });
  const unsupportedResult = await runIssueLifecycleAction({
    event: {
      action: "closed",
      issue: { number: 27, state_reason: "unsupported" },
    },
    request: unsupported.request,
  });
  assert.equal(unsupportedResult.outcome, "failed");
  assert.deepEqual(unsupportedResult.failures, ["unsupported_closure_reason"]);
});

test("reconciles label-less reopen and overlapping requested labels", async (t) => {
  const reopened = requestMock(t, { issueLabels: [] });
  const reopenedResult = await runIssueLifecycleAction({
    event: reopenedEvent,
    request: reopened.request,
  });
  assert.equal(reopenedResult.outcome, "planned");
  assert.deepEqual(reopenedResult.plan, {
    apply: ["status: new"],
    failures: [],
    ok: true,
    remove: [],
  });

  const overlap = requestMock(t, {
    issueLabels: ["status: blocked", "status: ready"],
  });
  const overlapResult = await runIssueLifecycleAction({
    event: {
      action: "labeled",
      label: { name: "status: blocked" },
      issue: { number: 27 },
      transitionRequest: {
        actorRole: "implementer",
        blockingCondition: "blocked by verification",
        eventIdentity: "label-event-27",
        requestedSource: "status: ready",
      },
    },
    request: overlap.request,
  });
  assert.equal(overlapResult.outcome, "planned");
  assert.equal(overlapResult.desiredState, "status: blocked");
  assert.deepEqual(overlapResult.plan, {
    apply: [],
    failures: [],
    ok: true,
    remove: ["status: ready"],
  });
});

test("requires current readiness before ready label transitions", async (t) => {
  const readyTransitionEvent = {
    action: "labeled",
    expectedReadinessCommentId: 101,
    label: { name: "status: ready" },
    issue: { number: 27 },
    transitionRequest: {
      actorRole: "planner",
      eventIdentity: "label-event-27",
      requestedSource: "status: triaged",
    },
  };
  const previousActivation = process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
  t.after(() => {
    if (previousActivation === undefined)
      delete process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
    else process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = previousActivation;
  });

  process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = "enabled";
  const missingReadiness = requestMock(t, {
    comments: [],
    issueLabels: ["status: triaged", "status: ready"],
  });
  const missingReadinessResult = await runIssueLifecycleAction({
    event: readyTransitionEvent,
    request: missingReadiness.request,
  });
  assert.equal(missingReadinessResult.outcome, "failed");
  assert.deepEqual(missingReadinessResult.failures, [
    "current_readiness_required",
  ]);

  process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = "disabled";
  const currentReadiness = requestMock(t, {
    issueLabels: ["status: triaged", "status: ready"],
  });
  const currentReadinessResult = await runIssueLifecycleAction({
    event: readyTransitionEvent,
    request: currentReadiness.request,
  });
  assert.equal(currentReadinessResult.outcome, "planned");
  assert.equal(currentReadinessResult.desiredState, "status: ready");
  assert.deepEqual(currentReadinessResult.plan, {
    apply: [],
    failures: [],
    ok: true,
    remove: ["status: triaged"],
  });
});

test("fails closed when provider issue identity is unavailable", async (t) => {
  const missingInitialIdentity = requestMock(t);
  await assert.rejects(
    runIssueLifecycleAction({
      event: reopenedEvent,
      request: async (path, options) =>
        path.endsWith("/issues/27")
          ? { ...issue(["status: ready"]), id: undefined, node_id: undefined }
          : missingInitialIdentity.request(path, options),
    }),
    /Reloaded issue response is malformed/u,
  );

  let reloaded = false;
  const missingReadbackIdentity = requestMock(t, {
    issueLabels: ["status: ready"],
  });
  const previousActivation = process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
  process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = "enabled";
  t.after(() => {
    if (previousActivation === undefined)
      delete process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
    else process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = previousActivation;
  });
  await assert.rejects(
    runIssueLifecycleAction({
      event: reopenedEvent,
      request: async (path, options) => {
        if (path.includes("/issues/27") && reloaded) {
          const { id, node_id, ...withoutIdentity } = issue(["status: new"]);
          return withoutIdentity;
        }
        const response = await missingReadbackIdentity.request(path, options);
        if (options?.method === "POST") reloaded = true;
        return response;
      },
    }),
    /Reloaded issue response is malformed/u,
  );
});

test("runs the CLI wrapper with a hermetic event file", async (t) => {
  const eventPath = join(
    await mkdtemp(join(tmpdir(), "keiko-lifecycle-")),
    "event.json",
  );
  await writeFile(eventPath, JSON.stringify(reopenedEvent));
  const { request } = requestMock(t, { issueLabels: ["status: ready"] });
  const writes = [];
  const result = await runIssueLifecycleCli({
    eventPath,
    output: { write: (value) => writes.push(value) },
    request,
  });
  assert.equal(result.outcome, "planned");
  assert.deepEqual(writes, ["issue-lifecycle: planned\n"]);
  await assert.rejects(
    runIssueLifecycleCli({ eventPath: "" }),
    /GITHUB_EVENT_PATH/u,
  );
});

test("covers alternate fail-closed and no-op lifecycle branches", async (t) => {
  const ignoredPullRequest = requestMock(t);
  assert.deepEqual(
    await runIssueLifecycleAction({
      event: { issue: { number: 27, pull_request: {} } },
      request: ignoredPullRequest.request,
    }),
    { outcome: "ignored", reason: "pull_request_issue" },
  );

  await assert.rejects(
    runIssueLifecycleAction({
      event: { issue: {} },
      request: ignoredPullRequest.request,
    }),
    /Issue number/u,
  );

  const closed = requestMock(t, {
    issueLabels: ["status: ready for human review"],
    issueOverrides: { state: "closed", state_reason: "completed" },
  });
  assert.deepEqual(
    (
      await runIssueLifecycleAction({
        event: {
          action: "closed",
          expectedReadinessCommentId: 101,
          issue: { number: 27, state_reason: "completed" },
        },
        request: closed.request,
      })
    ).plan,
    {
      apply: ["status: done"],
      failures: [],
      ok: true,
      remove: ["status: ready for human review"],
    },
  );

  const prematureClosed = requestMock(t, {
    issueLabels: ["status: new"],
    issueOverrides: { state: "closed", state_reason: "completed" },
  });
  const prematureClosedResult = await runIssueLifecycleAction({
    event: {
      action: "closed",
      expectedReadinessCommentId: 101,
      issue: { number: 27, state_reason: "completed" },
    },
    request: prematureClosed.request,
  });
  assert.equal(prematureClosedResult.outcome, "failed");
  assert.deepEqual(prematureClosedResult.failures, [
    "completion_evidence_required",
  ]);

  const conflictedClosed = requestMock(t, {
    issueLabels: ["status: ready for human review", "status: blocked"],
    issueOverrides: { state: "closed", state_reason: "completed" },
  });
  const conflictedClosedResult = await runIssueLifecycleAction({
    event: {
      action: "closed",
      expectedReadinessCommentId: 101,
      issue: { number: 27, state_reason: "completed" },
    },
    request: conflictedClosed.request,
  });
  assert.equal(conflictedClosedResult.outcome, "failed");
  assert.deepEqual(conflictedClosedResult.failures, [
    "completion_evidence_required",
  ]);

  const staleClosedEvent = requestMock(t, {
    issueLabels: ["status: ready for human review"],
    issueOverrides: { state: "open", state_reason: null },
  });
  const staleClosedResult = await runIssueLifecycleAction({
    event: {
      action: "closed",
      expectedReadinessCommentId: 101,
      issue: { number: 27, state_reason: "completed" },
    },
    request: staleClosedEvent.request,
  });
  assert.equal(staleClosedResult.outcome, "failed");
  assert.deepEqual(staleClosedResult.failures, [
    "current_closed_state_required",
  ]);

  const edited = requestMock(t, { issueLabels: ["status: ready"] });
  assert.equal(
    (
      await runIssueLifecycleAction({
        event: {
          action: "edited",
          editKind: "semantic",
          issue: { number: 27 },
        },
        request: edited.request,
      })
    ).desiredState,
    "status: new",
  );
  const checkboxOnlyEdited = requestMock(t, { issueLabels: ["status: ready"] });
  assert.equal(
    (
      await runIssueLifecycleAction({
        event: { action: "edited", issue: { number: 27 } },
        request: checkboxOnlyEdited.request,
      })
    ).outcome,
    "ignored",
  );

  const stringLabelIssue = {
    ...issue(["status: ready"]),
    labels: ["status: ready"],
  };
  const stringLabelRequest = async (path, options = {}) => {
    if (path.includes("/comments?")) return [machineReadinessComment()];
    if (path.includes("/labels?"))
      return LIFECYCLE_STATES.map((name) => ({ name }));
    if (path.includes("/issues/27")) return stringLabelIssue;
    return {};
  };
  const previousRepository = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY = "keiko/Keiko-Native";
  t.after(() => {
    if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previousRepository;
  });
  assert.equal(
    (
      await runIssueLifecycleAction({
        event: {
          action: "labeled",
          label: { name: "status: blocked" },
          issue: { labels: ["status: blocked"], number: 27 },
          transitionRequest: {
            actorRole: "implementer",
            blockingCondition: "blocked by verification",
            eventIdentity: "label-event-27",
            requestedSource: "status: ready",
          },
        },
        request: stringLabelRequest,
      })
    ).desiredState,
    "status: blocked",
  );

  const rawTransition = requestMock(t, { issueLabels: ["status: ready"] });
  const rawResult = await runIssueLifecycleAction({
    event: { ...labeledEvent, label: { name: "status: blocked" } },
    request: rawTransition.request,
  });
  assert.equal(rawResult.outcome, "ignored");
  assert.equal(rawResult.reason, "raw_lifecycle_label_event");

  const enabledRawTransition = requestMock(t, {
    issueLabels: ["status: ready"],
  });
  const previousRawActivation = process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
  process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = "enabled";
  try {
    const enabledRawResult = await runIssueLifecycleAction({
      event: { ...labeledEvent, label: { name: "status: blocked" } },
      request: enabledRawTransition.request,
    });
    assert.equal(enabledRawResult.outcome, "failed");
    assert.match(
      enabledRawResult.failures.join("\n"),
      /explicit transition authority/u,
    );
  } finally {
    if (previousRawActivation === undefined)
      delete process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
    else process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = previousRawActivation;
  }

  const enabledRawAssignment = requestMock(t, {
    issueLabels: ["status: ready"],
  });
  const previousAssignmentActivation =
    process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
  process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = "enabled";
  try {
    const enabledRawAssignmentResult = await runIssueLifecycleAction({
      event: {
        action: "assigned",
        expectedReadinessCommentId: 101,
        issue: { number: 27 },
      },
      request: enabledRawAssignment.request,
    });
    assert.equal(enabledRawAssignmentResult.outcome, "failed");
    assert.deepEqual(enabledRawAssignmentResult.failures, [
      "validated_claim_required",
    ]);
  } finally {
    if (previousAssignmentActivation === undefined)
      delete process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
    else
      process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION =
        previousAssignmentActivation;
  }

  const malformedLabels = requestMock(t);
  await assert.rejects(
    runIssueLifecycleAction({
      event: reopenedEvent,
      request: async (path, options) =>
        path.includes("/labels?") ? {} : malformedLabels.request(path, options),
    }),
    /Provider labels response is malformed/u,
  );

  const malformedIssue = requestMock(t);
  await assert.rejects(
    runIssueLifecycleAction({
      event: reopenedEvent,
      request: async (path, options) =>
        path.endsWith("/issues/27")
          ? { number: 99, title: issueTitle }
          : malformedIssue.request(path, options),
    }),
    /Reloaded issue response is malformed/u,
  );

  let reloaded = false;
  const noop = requestMock(t, { issueLabels: ["status: new"] });
  const previousActivation = process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
  process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = "enabled";
  t.after(() => {
    if (previousActivation === undefined)
      delete process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION;
    else process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = previousActivation;
  });
  const noopResult = await runIssueLifecycleAction({
    event: reopenedEvent,
    request: async (path, options) => {
      if (path.includes("/issues/27") && reloaded)
        return issue(["status: new"]);
      const response = await noop.request(path, options);
      if (options?.method === "POST") reloaded = true;
      return response;
    },
  });
  assert.equal(noopResult.outcome, "applied");

  const eventPath = join(
    await mkdtemp(join(tmpdir(), "keiko-lifecycle-fail-")),
    "event.json",
  );
  await writeFile(eventPath, JSON.stringify(labeledEvent));
  const failed = requestMock(t, { issueLabels: [] });
  await assert.rejects(
    runIssueLifecycleCli({
      eventPath,
      output: { write: () => true },
      request: failed.request,
    }),
    /Issue lifecycle failed/u,
  );
});
