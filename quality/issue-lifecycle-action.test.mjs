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

function issue(labels = ["status: ready"]) {
  return {
    body: issueBody,
    id: 42,
    labels: labels.map((name) => ({ name })),
    node_id: "issue-node-42",
    number: 27,
    title: issueTitle,
  };
}

function requestMock(
  t,
  { comments = [machineReadinessComment()], failures = {}, issueLabels } = {},
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
    if (path.includes("/comments?")) return comments;
    if (path.includes("/labels?"))
      return LIFECYCLE_STATES.map((name) => ({ name }));
    if (path.includes("/issues/27")) return issue(issueLabels);
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

  const edited = requestMock(t, { issueLabels: ["status: ready"] });
  assert.equal(
    (
      await runIssueLifecycleAction({
        event: { action: "edited", issue: { number: 27 } },
        request: edited.request,
      })
    ).desiredState,
    "status: new",
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
  process.env.GITHUB_REPOSITORY = "keiko/Keiko-Native";
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

  const invalidTransition = requestMock(t, { issueLabels: ["status: ready"] });
  assert.equal(
    await actionOutcome(
      { ...labeledEvent, label: { name: "status: blocked" } },
      invalidTransition.request,
    ),
    "failed",
  );

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
  process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION = "enabled";
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
