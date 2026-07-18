import assert from "node:assert/strict";
import test from "node:test";

import {
  decideReadiness,
  invalidateLinkedPullRequestContracts,
  readinessComment,
  readinessRecordFromComments,
  runIssueReadinessAction,
} from "./issue-readiness-action.mjs";
import { semanticIssueFingerprint } from "./issue-contract.mjs";

const validation = {
  failures: [],
  fingerprint: "a".repeat(64),
  version: "v1",
};

const taskHeadings = [
  "Planning contract",
  "Purpose and observable outcome",
  "Acceptance journey",
  "Change classification and planning authority",
  "Scope",
  "Execution Authority",
  "Planning and architecture alignment",
  "Interface contracts",
  "Quality Plan",
  "Acceptance criteria",
  "Verification commands",
  "Audit plan",
  "Definition of Ready",
  "Completion and review settlement",
  "Stop conditions",
];

function validTaskBody() {
  return taskHeadings
    .map((heading) => {
      if (heading === "Planning contract")
        return `## ${heading}\n\n- Contract version: \`v1\``;
      if (heading === "Acceptance journey")
        return `## ${heading}\n\n- Applicability: Required\n- Actor: Developer`;
      if (heading === "Acceptance criteria")
        return `## ${heading}\n\n- [ ] AC1 — The result is observable with expected test evidence.`;
      if (heading === "Verification commands")
        return `## ${heading}\n\n\`\`\`text\nnpm run quality\n\`\`\``;
      if (heading === "Definition of Ready")
        return `## ${heading}\n\n- [x] Scope and verification are complete.`;
      return `## ${heading}\n\nComplete governed content for ${heading}.`;
    })
    .join("\n\n");
}

function issueEvent(overrides = {}) {
  return {
    action: "labeled",
    issue: {
      body: validTaskBody(),
      labels: [{ name: "type: task" }, { name: "status: ready" }],
      number: 42,
      title: "Implement governed workspace opening",
    },
    label: { name: "status: ready" },
    sender: { login: "planner" },
    ...overrides,
  };
}

function installGitHubFetchMock(
  t,
  {
    comments = [],
    deleteStatus = 204,
    issueSnapshotError,
    issueSnapshotStatuses = [],
    issueSnapshots = [],
    labelPostStatus = 201,
    permission = "write",
    pullRequests = [],
  } = {},
) {
  const originalFetch = globalThis.fetch;
  const originalRepository = process.env.GITHUB_REPOSITORY;
  const calls = [];
  let issueSnapshotIndex = 0;
  process.env.GITHUB_REPOSITORY = "keiko/Keiko-Native";
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ method: options.method ?? "GET", url: String(url) });
    if (String(url).includes("/permission"))
      return permission === "error"
        ? new Response("permission unavailable", { status: 503 })
        : Response.json({ permission });
    if (
      String(url).endsWith("/issues/42") &&
      (options.method ?? "GET") === "GET"
    ) {
      if (issueSnapshotError !== undefined) throw new Error(issueSnapshotError);
      const snapshot = issueSnapshots[issueSnapshotIndex];
      const status = issueSnapshotStatuses[issueSnapshotIndex] ?? 200;
      issueSnapshotIndex += 1;
      if (status !== 200) return new Response("provider failure", { status });
      return Response.json(snapshot ?? {});
    }
    if (
      String(url).includes("/comments?") &&
      (options.method ?? "GET") === "GET"
    )
      return Response.json(comments);
    if (String(url).includes("/pulls?") && (options.method ?? "GET") === "GET")
      return Response.json(pullRequests);
    if (options.method === "DELETE")
      return new Response(deleteStatus === 204 ? null : "missing", {
        status: deleteStatus,
      });
    if (options.method === "POST" && String(url).endsWith("/labels"))
      return Response.json({}, { status: labelPostStatus });
    return Response.json({}, { status: 201 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
  });
  return calls;
}

test("accepts an authorized valid readiness request", () => {
  assert.deepEqual(
    decideReadiness({
      action: "labeled",
      actorAuthorized: true,
      hasReadyLabel: true,
      label: "status: ready",
      previousRecord: undefined,
      validation,
    }),
    { outcome: "accept", reasons: [] },
  );
});

test("rejects unauthorized or structurally incomplete requests", () => {
  assert.equal(
    decideReadiness({
      action: "labeled",
      actorAuthorized: false,
      hasReadyLabel: true,
      label: "status: ready",
      previousRecord: undefined,
      validation,
    }).outcome,
    "reject",
  );
  assert.deepEqual(
    decideReadiness({
      action: "labeled",
      actorAuthorized: true,
      hasReadyLabel: true,
      label: "status: ready",
      previousRecord: undefined,
      validation: { ...validation, failures: ["Missing section: Scope."] },
    }).reasons,
    ["Missing section: Scope."],
  );
});

test("keeps only an unchanged accepted contract ready", () => {
  const previousRecord = {
    fingerprint: validation.fingerprint,
    status: "accepted",
    version: validation.version,
  };
  assert.equal(
    decideReadiness({
      action: "edited",
      actorAuthorized: false,
      hasReadyLabel: true,
      previousRecord,
      validation,
    }).outcome,
    "keep",
  );
  assert.equal(
    decideReadiness({
      action: "edited",
      actorAuthorized: false,
      hasReadyLabel: true,
      previousRecord,
      validation: { ...validation, fingerprint: "b".repeat(64) },
    }).outcome,
    "reject",
  );
  assert.equal(
    decideReadiness({
      action: "edited",
      actorAuthorized: false,
      hasCurrentReadinessLifecycle: true,
      hasReadyLabel: false,
      previousRecord,
      validation: { ...validation, fingerprint: "b".repeat(64) },
    }).outcome,
    "reject",
  );
});

test("invalidates readiness when the issue closes or the ready label is removed", () => {
  assert.deepEqual(
    decideReadiness({
      action: "closed",
      hasReadyLabel: true,
      validation,
    }),
    {
      outcome: "reject",
      lifecycleOwned: true,
      reasons: ["A closed issue cannot remain implementation ready."],
    },
  );
  assert.deepEqual(
    decideReadiness({
      action: "unlabeled",
      hasReadyLabel: false,
      label: "status: ready",
      validation,
    }),
    {
      outcome: "reject",
      reasons: ["The implementation-ready label was removed."],
    },
  );
});

test("reads the latest machine readiness record", () => {
  const comment = readinessComment({
    actor: "planner",
    decision: { outcome: "accept", reasons: [] },
    now: "2026-07-16T12:00:00.000Z",
    validation,
  });
  const record = readinessRecordFromComments([
    { body: "ordinary comment", id: 1 },
    {
      body: comment,
      id: 2,
      user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    },
  ]);
  assert.deepEqual(record, {
    commentId: 2,
    fingerprint: validation.fingerprint,
    status: "accepted",
    version: "v1",
  });
});

test("ignores forged readiness markers from non-Actions authors", () => {
  const comment = readinessComment({
    actor: "planner",
    decision: { outcome: "accept", reasons: [] },
    now: "2026-07-16T12:00:00.000Z",
    validation,
  });
  assert.equal(
    readinessRecordFromComments([
      {
        body: comment,
        id: 2,
        user: { id: 7, login: "maintainer", type: "User" },
      },
    ]),
    undefined,
  );
});

test("renders actionable rejected readiness evidence", () => {
  const comment = readinessComment({
    actor: "planner",
    decision: { outcome: "reject", reasons: ["Scope is empty."] },
    now: "2026-07-16T12:00:00.000Z",
    validation,
  });
  assert.match(comment, /Issue readiness rejected/u);
  assert.match(comment, /Scope is empty/u);
  assert.match(comment, /status: new/u);
});

test("leaves closed lifecycle reconciliation to the lifecycle workflow", async (t) => {
  const calls = installGitHubFetchMock(t);
  const result = await runIssueReadinessAction({
    event: issueEvent({
      action: "closed",
      issue: {
        body: validTaskBody(),
        labels: [
          { name: "type: task" },
          { name: "status: ready for human review" },
        ],
        number: 42,
        title: "Implement governed workspace opening",
      },
    }),
  });

  assert.equal(result.outcome, "reject");
  assert.equal(result.lifecycleOwned, true);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
  assert.equal(
    calls.filter(
      (call) => call.method === "POST" && call.url.endsWith("/labels"),
    ).length,
    0,
  );
  assert.ok(
    calls.some(
      (call) => call.method === "POST" && call.url.endsWith("/comments"),
    ),
  );
});

test("invalidates readiness when an issue is reopened", async (t) => {
  const body = validTaskBody();
  const title = "Implement governed workspace opening";
  const accepted = readinessComment({
    actor: "planner",
    decision: { outcome: "accept", reasons: [] },
    now: "2026-07-16T12:00:00.000Z",
    validation: {
      failures: [],
      fingerprint: semanticIssueFingerprint(body, title),
      version: "v1",
    },
  });
  const calls = installGitHubFetchMock(t, {
    comments: [
      {
        body: accepted,
        id: 1,
        user: {
          id: 41898282,
          login: "github-actions[bot]",
          type: "Bot",
        },
      },
    ],
    issueSnapshots: [
      {
        body,
        labels: [{ name: "type: task" }, { name: "status: ready" }],
        number: 42,
        state: "open",
        title,
        updated_at: "2026-07-16T12:00:01Z",
      },
      {
        body,
        labels: [{ name: "type: task" }, { name: "status: ready" }],
        number: 42,
        state: "open",
        title,
        updated_at: "2026-07-16T12:00:01Z",
      },
      {
        body,
        labels: [{ name: "type: task" }, { name: "status: new" }],
        number: 42,
        state: "open",
        title,
        updated_at: "2026-07-16T12:00:02Z",
      },
    ],
  });

  const result = await runIssueReadinessAction({
    event: issueEvent({
      action: "reopened",
      issue: {
        body,
        labels: [{ name: "type: task" }, { name: "status: ready" }],
        number: 42,
        title,
        updated_at: "2026-07-16T12:00:01Z",
      },
    }),
  });

  assert.equal(result.outcome, "reject");
  assert.match(result.reasons.join("\n"), /reopened issue/u);
  assert.ok(
    calls.some(
      (call) =>
        call.method === "DELETE" &&
        call.url.endsWith("/labels/status%3A%20ready"),
    ),
  );
  assert.ok(
    calls.some(
      (call) => call.method === "POST" && call.url.endsWith("/labels"),
    ),
  );
});

test("ignores a replayed reopen event after lifecycle state advances", async (t) => {
  const calls = installGitHubFetchMock(t, {
    issueSnapshots: [
      {
        body: validTaskBody(),
        labels: [{ name: "type: task" }, { name: "status: blocked" }],
        number: 42,
        state: "open",
        title: "Implement governed workspace opening",
        updated_at: "2026-07-16T12:00:03Z",
      },
    ],
  });
  const result = await runIssueReadinessAction({
    event: issueEvent({
      action: "reopened",
      issue: {
        body: validTaskBody(),
        labels: [{ name: "type: task" }, { name: "status: ready" }],
        number: 42,
        title: "Implement governed workspace opening",
        updated_at: "2026-07-16T12:00:01Z",
      },
    }),
  });

  assert.equal(result.outcome, "ignore");
  assert.equal(result.reason, "stale_reopened_event");
  assert.equal(
    calls.filter((call) => ["DELETE", "POST"].includes(call.method)).length,
    0,
  );
});

test("fails a reopen reset when the issue changes before mutation", async (t) => {
  const body = validTaskBody();
  const title = "Implement governed workspace opening";
  const accepted = readinessComment({
    actor: "planner",
    decision: { outcome: "accept", reasons: [] },
    now: "2026-07-16T12:00:00.000Z",
    validation: {
      failures: [],
      fingerprint: semanticIssueFingerprint(body, title),
      version: "v1",
    },
  });
  const calls = installGitHubFetchMock(t, {
    comments: [
      {
        body: accepted,
        id: 1,
        user: {
          id: 41898282,
          login: "github-actions[bot]",
          type: "Bot",
        },
      },
    ],
    issueSnapshots: [
      {
        body,
        labels: [{ name: "type: task" }, { name: "status: ready" }],
        number: 42,
        state: "open",
        title,
        updated_at: "2026-07-16T12:00:01Z",
      },
      {
        body,
        labels: [{ name: "type: task" }, { name: "status: blocked" }],
        number: 42,
        state: "open",
        title,
        updated_at: "2026-07-16T12:00:02Z",
      },
    ],
  });

  await assert.rejects(
    runIssueReadinessAction({
      event: issueEvent({
        action: "reopened",
        issue: {
          body,
          labels: [{ name: "type: task" }, { name: "status: ready" }],
          number: 42,
          title,
          updated_at: "2026-07-16T12:00:01Z",
        },
      }),
    }),
    /changed before readiness reconciliation/u,
  );
  assert.equal(
    calls.filter((call) => ["DELETE", "POST"].includes(call.method)).length,
    0,
  );
});

for (const status of [403, 404, 409, 422, 429, 503]) {
  test(`fails closed when reopened issue reload returns ${status}`, async (t) => {
    const calls = installGitHubFetchMock(t, {
      issueSnapshotStatuses: [status],
    });
    await assert.rejects(
      runIssueReadinessAction({
        event: issueEvent({
          action: "reopened",
          issue: {
            body: validTaskBody(),
            labels: [{ name: "type: task" }, { name: "status: ready" }],
            number: 42,
            title: "Implement governed workspace opening",
            updated_at: "2026-07-16T12:00:01Z",
          },
        }),
      }),
      new RegExp(`failed with ${status}`, "u"),
    );
    assert.equal(
      calls.filter((call) => ["DELETE", "POST"].includes(call.method)).length,
      0,
    );
  });
}

test("fails closed when reopened issue reload times out", async (t) => {
  const calls = installGitHubFetchMock(t, {
    issueSnapshotError: "provider timeout",
  });
  await assert.rejects(
    runIssueReadinessAction({
      event: issueEvent({
        action: "reopened",
        issue: {
          body: validTaskBody(),
          labels: [{ name: "type: task" }, { name: "status: ready" }],
          number: 42,
          title: "Implement governed workspace opening",
          updated_at: "2026-07-16T12:00:01Z",
        },
      }),
    }),
    /provider timeout/u,
  );
  assert.equal(
    calls.filter((call) => ["DELETE", "POST"].includes(call.method)).length,
    0,
  );
});

test("fails closed on malformed reopen state and partial mutation read-back", async (t) => {
  const malformedCalls = installGitHubFetchMock(t, {
    issueSnapshots: [{}],
  });
  await assert.rejects(
    runIssueReadinessAction({
      event: issueEvent({
        action: "reopened",
        issue: {
          body: validTaskBody(),
          labels: [{ name: "type: task" }, { name: "status: ready" }],
          number: 42,
          title: "Implement governed workspace opening",
          updated_at: "2026-07-16T12:00:01Z",
        },
      }),
    }),
    /response is malformed/u,
  );
  assert.equal(
    malformedCalls.filter((call) => ["DELETE", "POST"].includes(call.method))
      .length,
    0,
  );
});

test("fails reopen reconciliation after a conflicting partial mutation", async (t) => {
  const body = validTaskBody();
  const title = "Implement governed workspace opening";
  const accepted = readinessComment({
    actor: "planner",
    decision: { outcome: "accept", reasons: [] },
    now: "2026-07-16T12:00:00.000Z",
    validation: {
      failures: [],
      fingerprint: semanticIssueFingerprint(body, title),
      version: "v1",
    },
  });
  const calls = installGitHubFetchMock(t, {
    comments: [
      {
        body: accepted,
        id: 1,
        user: {
          id: 41898282,
          login: "github-actions[bot]",
          type: "Bot",
        },
      },
    ],
    issueSnapshots: [
      {
        body,
        labels: [{ name: "type: task" }, { name: "status: ready" }],
        number: 42,
        state: "open",
        title,
        updated_at: "2026-07-16T12:00:01Z",
      },
      {
        body,
        labels: [{ name: "type: task" }, { name: "status: ready" }],
        number: 42,
        state: "open",
        title,
        updated_at: "2026-07-16T12:00:01Z",
      },
      {
        body,
        labels: [
          { name: "type: task" },
          { name: "status: blocked" },
          { name: "status: new" },
        ],
        number: 42,
        state: "open",
        title,
        updated_at: "2026-07-16T12:00:02Z",
      },
    ],
    pullRequests: [
      {
        body: "## Scope\n\n- Accepted issue: #42",
        head: { sha: "c".repeat(40) },
      },
    ],
  });
  await assert.rejects(
    runIssueReadinessAction({
      event: issueEvent({
        action: "reopened",
        issue: {
          body,
          labels: [{ name: "type: task" }, { name: "status: ready" }],
          number: 42,
          title,
          updated_at: "2026-07-16T12:00:01Z",
        },
      }),
    }),
    /failed read-back/u,
  );
  assert.ok(calls.some((call) => call.method === "DELETE"));
  assert.ok(
    calls.some(
      (call) => call.method === "POST" && call.url.endsWith("/labels"),
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.method === "POST" &&
        call.url.endsWith(`/statuses/${"c".repeat(40)}`),
    ),
  );
});

for (const mutationFailure of [
  { deleteStatus: 403, labelPostStatus: 201, status: 403 },
  { deleteStatus: 204, labelPostStatus: 422, status: 422 },
]) {
  test(`fails reopened issue mutation on ${mutationFailure.status}`, async (t) => {
    const body = validTaskBody();
    const title = "Implement governed workspace opening";
    const accepted = readinessComment({
      actor: "planner",
      decision: { outcome: "accept", reasons: [] },
      now: "2026-07-16T12:00:00.000Z",
      validation: {
        failures: [],
        fingerprint: semanticIssueFingerprint(body, title),
        version: "v1",
      },
    });
    const calls = installGitHubFetchMock(t, {
      comments: [
        {
          body: accepted,
          id: 1,
          user: {
            id: 41898282,
            login: "github-actions[bot]",
            type: "Bot",
          },
        },
      ],
      deleteStatus: mutationFailure.deleteStatus,
      issueSnapshots: [
        {
          body,
          labels: [{ name: "type: task" }, { name: "status: ready" }],
          number: 42,
          state: "open",
          title,
          updated_at: "2026-07-16T12:00:01Z",
        },
        {
          body,
          labels: [{ name: "type: task" }, { name: "status: ready" }],
          number: 42,
          state: "open",
          title,
          updated_at: "2026-07-16T12:00:01Z",
        },
      ],
      labelPostStatus: mutationFailure.labelPostStatus,
    });
    await assert.rejects(
      runIssueReadinessAction({
        event: issueEvent({
          action: "reopened",
          issue: {
            body,
            labels: [{ name: "type: task" }, { name: "status: ready" }],
            number: 42,
            title,
            updated_at: "2026-07-16T12:00:01Z",
          },
        }),
      }),
      new RegExp(`failed with ${mutationFailure.status}`, "u"),
    );
    assert.ok(calls.some((call) => call.method === "DELETE"));
  });
}

test("invalidates stale readiness retained by a paused issue", async (t) => {
  const body = validTaskBody();
  const title = "Implement governed workspace opening";
  const accepted = readinessComment({
    actor: "planner",
    decision: { outcome: "accept", reasons: [] },
    now: "2026-07-16T12:00:00.000Z",
    validation: {
      failures: [],
      fingerprint: semanticIssueFingerprint(body, title),
      version: "v1",
    },
  });
  const calls = installGitHubFetchMock(t, {
    comments: [
      {
        body: accepted,
        id: 1,
        user: {
          id: 41898282,
          login: "github-actions[bot]",
          type: "Bot",
        },
      },
    ],
  });

  const result = await runIssueReadinessAction({
    event: issueEvent({
      action: "edited",
      issue: {
        body: `${body}\n\nChanged governed scope.`,
        labels: [{ name: "type: task" }, { name: "status: blocked" }],
        number: 42,
        title,
      },
    }),
  });

  assert.equal(result.outcome, "reject");
  assert.ok(
    calls.some(
      (call) =>
        call.method === "DELETE" &&
        call.url.endsWith("/labels/status%3A%20blocked"),
    ),
  );
  assert.ok(
    calls.some(
      (call) => call.method === "POST" && call.url.endsWith("/labels"),
    ),
  );
});

test("executes the accepted readiness label transition", async (t) => {
  const calls = installGitHubFetchMock(t);
  const result = await runIssueReadinessAction({
    event: issueEvent(),
    now: new Date("2026-07-16T12:00:00.000Z"),
  });
  assert.equal(result.outcome, "accept");
  assert.ok(
    calls.some(
      (call) =>
        call.method === "DELETE" &&
        call.url.endsWith("/labels/status%3A%20new"),
    ),
  );
  assert.ok(
    calls.some(
      (call) => call.method === "POST" && call.url.endsWith("/comments"),
    ),
  );
});

test("rejects an initial readiness request with a conflicting lifecycle status", async (t) => {
  installGitHubFetchMock(t);
  const event = issueEvent({
    issue: {
      body: validTaskBody(),
      labels: [
        { name: "type: task" },
        { name: "status: new" },
        { name: "status: blocked" },
        { name: "status: ready" },
      ],
      number: 42,
      title: "Implement governed workspace opening",
    },
  });

  const result = await runIssueReadinessAction({ event });

  assert.equal(result.outcome, "reject");
  assert.match(result.reasons.join("\n"), /conflicting lifecycle status/u);
});

test("accepts an initial readiness request from triaged", async (t) => {
  const calls = installGitHubFetchMock(t);
  const event = issueEvent({
    issue: {
      body: validTaskBody(),
      labels: [
        { name: "type: task" },
        { name: "status: triaged" },
        { name: "status: ready" },
      ],
      number: 42,
      title: "Implement governed workspace opening",
    },
  });

  const result = await runIssueReadinessAction({ event });

  assert.equal(result.outcome, "accept");
  assert.ok(
    calls.some(
      (call) =>
        call.method === "DELETE" &&
        call.url.endsWith("/labels/status%3A%20triaged"),
    ),
  );
});

test("executes a rejected readiness request fail closed", async (t) => {
  const calls = installGitHubFetchMock(t, {
    permission: "read",
    pullRequests: [
      {
        body: "## Scope\n\n- Accepted issue: #42",
        head: { sha: "a".repeat(40) },
      },
      {
        body: "## Scope\n\n- Accepted issue: #7",
        head: { sha: "b".repeat(40) },
      },
    ],
  });
  const result = await runIssueReadinessAction({ event: issueEvent() });
  assert.equal(result.outcome, "reject");
  assert.ok(
    calls.some(
      (call) =>
        call.method === "DELETE" &&
        call.url.endsWith("/labels/status%3A%20ready"),
    ),
  );
  assert.equal(
    calls.filter(
      (call) => call.method === "POST" && call.url.endsWith("/labels"),
    ).length,
    1,
  );
  assert.equal(
    calls.filter(
      (call) =>
        call.method === "POST" &&
        call.url.endsWith(`/statuses/${"a".repeat(40)}`),
    ).length,
    1,
  );
});

test("rejects a conflicting lifecycle status after readiness", async (t) => {
  const accepted = readinessComment({
    actor: "planner",
    decision: { outcome: "accept", reasons: [] },
    now: "2026-07-16T12:00:00.000Z",
    validation: {
      failures: [],
      fingerprint: "unused",
      version: "v1",
    },
  });
  installGitHubFetchMock(t, {
    comments: [
      {
        body: accepted,
        id: 1,
        user: {
          id: 41898282,
          login: "github-actions[bot]",
          type: "Bot",
        },
      },
    ],
  });
  const event = issueEvent({
    action: "labeled",
    issue: {
      body: validTaskBody(),
      labels: [
        { name: "type: task" },
        { name: "status: ready" },
        { name: "status: blocked" },
      ],
      number: 42,
      title: "Implement governed workspace opening",
    },
    label: { name: "status: blocked" },
  });
  const result = await runIssueReadinessAction({ event });
  assert.equal(result.outcome, "reject");
  assert.match(result.reasons.join("\n"), /conflicting lifecycle status/u);
});

test("invalidates linked PR contracts from current-ready PR lifecycle states", async (t) => {
  const accepted = readinessComment({
    actor: "planner",
    decision: { outcome: "accept", reasons: [] },
    now: "2026-07-16T12:00:00.000Z",
    validation: {
      failures: [],
      fingerprint: "b".repeat(64),
      version: "v2",
    },
  });
  const calls = installGitHubFetchMock(t, {
    comments: [
      {
        body: accepted,
        id: 1,
        user: {
          id: 41898282,
          login: "github-actions[bot]",
          type: "Bot",
        },
      },
    ],
    pullRequests: [
      {
        body: "## Scope\n\n- Accepted issue: #42",
        head: { sha: "c".repeat(40) },
      },
    ],
  });
  const result = await runIssueReadinessAction({
    event: issueEvent({
      action: "edited",
      issue: {
        body: validTaskBody(),
        labels: [{ name: "type: task" }, { name: "status: pr open" }],
        number: 42,
        title: "Implement governed workspace opening",
      },
    }),
  });

  assert.equal(result.outcome, "reject");
  assert.ok(
    calls.some(
      (call) =>
        call.method === "DELETE" &&
        call.url.endsWith("/labels/status%3A%20pr%20open"),
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.method === "POST" &&
        call.url.endsWith(`/statuses/${"c".repeat(40)}`),
    ),
  );
});

test("invalidates linked PR contracts when pausing PR-tracked work", async (t) => {
  const body = validTaskBody();
  const title = "Implement governed workspace opening";
  const accepted = readinessComment({
    actor: "planner",
    decision: { outcome: "accept", reasons: [] },
    now: "2026-07-16T12:00:00.000Z",
    validation: {
      failures: [],
      fingerprint: semanticIssueFingerprint(body, title),
      version: "v1",
    },
  });
  const calls = installGitHubFetchMock(t, {
    comments: [
      {
        body: accepted,
        id: 1,
        user: {
          id: 41898282,
          login: "github-actions[bot]",
          type: "Bot",
        },
      },
    ],
    pullRequests: [
      {
        body: "## Scope\n\n- Accepted issue: #42",
        head: { sha: "d".repeat(40) },
      },
    ],
  });
  const result = await runIssueReadinessAction({
    event: issueEvent({
      action: "labeled",
      issue: {
        body,
        labels: [
          { name: "type: task" },
          { name: "status: pr open" },
          { name: "status: blocked" },
        ],
        number: 42,
        title,
      },
      label: { name: "status: blocked" },
    }),
  });

  assert.equal(result.outcome, "keep");
  assert.equal(result.invalidatedLinkedPullRequests, 1);
  assert.ok(
    calls.some(
      (call) =>
        call.method === "POST" &&
        call.url.endsWith(`/statuses/${"d".repeat(40)}`),
    ),
  );
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
});

test("invalidates linked PR contracts when PR lifecycle labels are removed", async (t) => {
  const body = validTaskBody();
  const title = "Implement governed workspace opening";
  const accepted = readinessComment({
    actor: "planner",
    decision: { outcome: "accept", reasons: [] },
    now: "2026-07-16T12:00:00.000Z",
    validation: {
      failures: [],
      fingerprint: semanticIssueFingerprint(body, title),
      version: "v1",
    },
  });
  const calls = installGitHubFetchMock(t, {
    comments: [
      {
        body: accepted,
        id: 1,
        user: {
          id: 41898282,
          login: "github-actions[bot]",
          type: "Bot",
        },
      },
    ],
    pullRequests: [
      {
        body: "## Scope\n\n- Accepted issue: #42",
        head: { sha: "e".repeat(40) },
      },
    ],
  });
  const result = await runIssueReadinessAction({
    event: issueEvent({
      action: "unlabeled",
      issue: {
        body,
        labels: [{ name: "type: task" }],
        number: 42,
        title,
      },
      label: { name: "status: pr open" },
    }),
  });

  assert.equal(result.outcome, "reject");
  assert.deepEqual(result.reasons, [
    "The pull-request lifecycle label was removed.",
  ]);
  assert.ok(
    calls.some(
      (call) =>
        call.method === "POST" && call.url.endsWith("/issues/42/labels"),
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.method === "POST" &&
        call.url.endsWith(`/statuses/${"e".repeat(40)}`),
    ),
  );

  assert.deepEqual(
    await runIssueReadinessAction({
      event: issueEvent({
        action: "unlabeled",
        issue: {
          body,
          labels: [{ name: "type: task" }],
          number: 42,
          title,
        },
        label: { name: "status: ready for human review" },
        sender: { login: "github-actions[bot]" },
      }),
    }),
    { outcome: "ignore" },
  );
});

test("fails closed when actor permission cannot be established", async (t) => {
  installGitHubFetchMock(t, { deleteStatus: 404, permission: "error" });
  const result = await runIssueReadinessAction({ event: issueEvent() });
  assert.equal(result.outcome, "reject");
  assert.match(result.reasons.join("\n"), /without triage or write authority/u);
});

test("rejects invalid linked PR head evidence", async (t) => {
  installGitHubFetchMock(t, {
    pullRequests: [
      {
        body: "- Accepted issue: https://github.com/keiko/Keiko-Native/issues/42",
        head: { sha: "invalid" },
      },
    ],
  });
  await assert.rejects(
    invalidateLinkedPullRequestContracts("keiko/Keiko-Native", 42),
    /no valid head SHA/u,
  );
});

test("posts rejection feedback before linked PR invalidation can fail", async (t) => {
  const calls = installGitHubFetchMock(t, {
    permission: "read",
    pullRequests: [
      {
        body: "- Accepted issue: #42",
        head: { sha: "invalid" },
      },
    ],
  });

  await assert.rejects(
    runIssueReadinessAction({ event: issueEvent() }),
    /no valid head SHA/u,
  );

  assert.ok(
    calls.some(
      (call) => call.method === "POST" && call.url.endsWith("/comments"),
    ),
  );
});

test("ignores pull requests, bot cleanup, and unrelated issue events", async (t) => {
  const calls = installGitHubFetchMock(t);
  assert.deepEqual(
    await runIssueReadinessAction({
      event: issueEvent({ issue: { pull_request: {}, number: 42 } }),
    }),
    { outcome: "ignore" },
  );
  assert.deepEqual(
    await runIssueReadinessAction({
      event: issueEvent({ action: "assigned" }),
    }),
    { outcome: "ignore" },
  );
  assert.deepEqual(
    await runIssueReadinessAction({
      event: issueEvent({
        action: "unlabeled",
        issue: {
          body: validTaskBody(),
          labels: [{ name: "type: task" }, { name: "status: new" }],
          number: 42,
          title: "Implement governed workspace opening",
        },
        label: { name: "status: ready" },
        sender: { login: "github-actions[bot]" },
      }),
    }),
    { outcome: "ignore" },
  );
  assert.equal(calls.length, 0);
});
