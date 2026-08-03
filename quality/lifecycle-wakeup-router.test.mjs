import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { lifecycleWakeLocatorBytes } from "./lifecycle-wake.mjs";
import { resolveLifecycleWakeup } from "./lifecycle-wakeup-router.mjs";

const repository = "oscharko-dev/Keiko-Native";
const workflowSha = "a".repeat(40);

function environment(resolver, eventName) {
  return {
    GITHUB_EVENT_NAME: eventName,
    GITHUB_REPOSITORY: repository,
    GITHUB_WORKFLOW_SHA: workflowSha,
    KEIKO_LIFECYCLE_RESOLVER: resolver,
  };
}

function baseEvent(overrides = {}) {
  return {
    action: "edited",
    repository: { full_name: repository },
    workflowSha,
    ...overrides,
  };
}

function provider(responses) {
  const calls = [];
  return {
    calls,
    binary: async (path) => {
      calls.push(path);
      return Buffer.from(responses[path]);
    },
    json: async (path) => {
      calls.push(path);
      return structuredClone(responses[path]);
    },
  };
}

function storedZip(name, contents) {
  const filename = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30 + filename.length + contents.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(contents.length, 18);
  local.writeUInt16LE(contents.length, 22);
  local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);
  contents.copy(local, 30 + filename.length);

  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(contents.length, 20);
  central.writeUInt16LE(contents.length, 24);
  central.writeUInt16LE(filename.length, 28);
  filename.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function governanceProvider({
  locatorPullRequestNumber = 134,
  pullRequests = undefined,
  sourceWorkflowSha = workflowSha,
} = {}) {
  const runId = 30531667422;
  const runPath = `/repos/${repository}/actions/runs/${runId}`;
  const artifactsPath = `${runPath}/artifacts?per_page=100`;
  const archivePath = `/repos/${repository}/actions/artifacts/701/zip`;
  const locator = lifecycleWakeLocatorBytes({
    repository,
    issue_number: 51,
    pull_request_number: locatorPullRequestNumber,
    source_workflow_path: ".github/workflows/pr-contract.yml",
    source_run_id: runId,
    source_run_attempt: 1,
    source_protected_dev_sha: sourceWorkflowSha,
  });
  return {
    api: provider({
      [runPath]: {
        event: "pull_request_target",
        head_branch: "codex/51-protected-lifecycle",
        head_sha: "b".repeat(40),
        id: runId,
        name: "Pull request contract",
        path: ".github/workflows/pr-contract.yml",
        pull_requests: pullRequests ?? [
          {
            base: {
              ref: "dev",
              repo: {
                url: "https://api.github.com/repos/oscharko-dev/Keiko-Native",
              },
              sha: workflowSha,
            },
            number: locatorPullRequestNumber,
          },
        ],
        repository: { full_name: repository },
        run_attempt: 1,
        status: "completed",
      },
      [artifactsPath]: {
        artifacts: [
          {
            expired: false,
            id: 701,
            name: "keiko-lifecycle-wake-locator-v1",
            size_in_bytes: 512,
          },
        ],
      },
      [archivePath]: storedZip("locator.bin", locator),
    }),
    event: baseEvent({ workflow_run: { id: runId } }),
  };
}

test("routes a direct issue and exact recovery comment with zero provider requests", async () => {
  const direct = await resolveLifecycleWakeup({
    environment: environment("issue", "issues"),
    event: baseEvent({ issue: { number: 51 } }),
    provider: provider({}),
  });
  assert.deepEqual(direct, {
    locators: [{ issue_number: 51, recovery_comment_id: "" }],
    requestCount: 0,
    resolver: "issue",
  });

  const recovery = await resolveLifecycleWakeup({
    environment: environment("issue", "issue_comment"),
    event: baseEvent({
      action: "created",
      comment: { id: 9007199254740991 },
      issue: { number: 51 },
    }),
    provider: provider({}),
  });
  assert.deepEqual(recovery.locators, [
    { issue_number: 51, recovery_comment_id: "9007199254740991" },
  ]);
});

test("maps one stable pull request to its accepted issue in exactly two reads", async () => {
  const path = `/repos/${repository}/pulls/17`;
  const api = provider({
    [path]: {
      base: { ref: "dev" },
      body: "## Scope\n\n- Accepted issue: #51\n",
      head: { sha: "b".repeat(40) },
      number: 17,
      state: "open",
      updated_at: "2026-07-29T10:00:00Z",
    },
  });
  const result = await resolveLifecycleWakeup({
    environment: environment("pull-request", "pull_request_target"),
    event: baseEvent({
      action: "synchronize",
      pull_request: { number: 17 },
    }),
    provider: api,
  });
  assert.deepEqual(result.locators, [
    { issue_number: 51, recovery_comment_id: "" },
  ]);
  assert.equal(result.requestCount, 2);
  assert.deepEqual(api.calls, [path, path]);
});

for (const action of ["created", "edited", "deleted"])
  test(`routes a pull-request comment ${action} wake without recovery authority`, async () => {
    const path = `/repos/${repository}/pulls/17`;
    const api = provider({
      [path]: {
        base: { ref: "dev" },
        body: "## Scope\n\n- Accepted issue: #51\n",
        head: { sha: "b".repeat(40) },
        number: 17,
        state: "open",
        updated_at: "2026-07-29T10:00:00Z",
      },
    });
    const result = await resolveLifecycleWakeup({
      environment: environment("pull-request", "issue_comment"),
      event: baseEvent({
        action,
        comment: { id: 9007199254740991 },
        issue: { number: 17, pull_request: {} },
      }),
      provider: api,
    });
    assert.deepEqual(result.locators, [
      { issue_number: 51, recovery_comment_id: "" },
    ]);
    assert.equal(result.requestCount, 2);
    assert.deepEqual(api.calls, [path, path]);
  });

test("rejects malformed comment IDs for issue and pull-request comment wakes", async () => {
  for (const [resolver, issue] of [
    ["issue", { number: 51 }],
    ["pull-request", { number: 17, pull_request: {} }],
  ])
    for (const id of [undefined, null, 0, -1, 1.5, "1", 9007199254740992])
      await assert.rejects(
        resolveLifecycleWakeup({
          environment: environment(resolver, "issue_comment"),
          event: baseEvent({ action: "created", comment: { id }, issue }),
          provider: provider({}),
        }),
        { code: "direct-locator-invalid" },
      );
});

test("authenticates PR-target governance sources from an exact base or closed-run caller SHA", async () => {
  const valid = governanceProvider();
  const result = await resolveLifecycleWakeup({
    environment: environment("governance", "workflow_run"),
    event: valid.event,
    provider: valid.api,
  });
  assert.deepEqual(result.locators, [
    { issue_number: 51, recovery_comment_id: "" },
  ]);
  assert.equal(result.requestCount, 6);

  const closed = governanceProvider({ pullRequests: [] });
  const closedResult = await resolveLifecycleWakeup({
    environment: environment("governance", "workflow_run"),
    event: closed.event,
    provider: closed.api,
  });
  assert.deepEqual(closedResult.locators, [
    { issue_number: 51, recovery_comment_id: "" },
  ]);
  assert.equal(closedResult.requestCount, 6);

  const mismatched = governanceProvider({
    pullRequests: [],
    sourceWorkflowSha: "c".repeat(40),
  });
  await assert.rejects(
    resolveLifecycleWakeup({
      environment: environment("governance", "workflow_run"),
      event: mismatched.event,
      provider: mismatched.api,
    }),
    { code: "governance-source-unprotected" },
  );

  for (const invalid of [
    governanceProvider({ locatorPullRequestNumber: null, pullRequests: [] }),
    governanceProvider({
      pullRequests: [
        {
          base: {
            ref: "dev",
            repo: {
              url: "https://api.github.com/repos/oscharko-dev/Keiko-Native",
            },
            sha: workflowSha,
          },
          number: 133,
        },
      ],
    }),
    governanceProvider({
      pullRequests: [
        {
          base: {
            ref: "dev",
            repo: {
              url: "https://api.github.com/repos/oscharko-dev/Keiko-Native",
            },
            sha: workflowSha,
          },
          number: 134,
        },
        {
          base: {
            ref: "dev",
            repo: {
              url: "https://api.github.com/repos/oscharko-dev/Keiko-Native",
            },
            sha: workflowSha,
          },
          number: 134,
        },
      ],
    }),
  ])
    await assert.rejects(
      resolveLifecycleWakeup({
        environment: environment("governance", "workflow_run"),
        event: invalid.event,
        provider: invalid.api,
      }),
      { code: "governance-source-unprotected" },
    );
});

test("skips pull_request_target-only evidence completed from an ineligible push before resolution", async () => {
  const runId = 30740176636;
  const path = `/repos/${repository}/actions/runs/${runId}`;
  const api = provider({
    [path]: {
      event: "push",
      head_branch: "dev",
      head_sha: workflowSha,
      id: runId,
      name: "CodeQL",
      path: ".github/workflows/codeql.yml",
      pull_requests: [],
      repository: { full_name: repository },
      run_attempt: 1,
      status: "completed",
    },
  });
  const result = await resolveLifecycleWakeup({
    environment: environment("evidence", "workflow_run"),
    event: baseEvent({
      workflow_run: { event: "push", id: runId, name: "CodeQL" },
    }),
    provider: api,
  });
  assert.deepEqual(result.locators, []);
  assert.equal(result.requestCount, 0);
  assert.deepEqual(api.calls, []);
});

test("routes eligible pull_request evidence through exact stable run and issue reads", async () => {
  const runId = 30740176637;
  const runPath = `/repos/${repository}/actions/runs/${runId}`;
  const pullPath = `/repos/${repository}/pulls/17`;
  const api = provider({
    [runPath]: {
      event: "pull_request",
      head_branch: "codex/160-protected-provenance",
      head_sha: "b".repeat(40),
      id: runId,
      name: "CodeQL",
      path: ".github/workflows/codeql.yml",
      pull_requests: [{ number: 17 }],
      repository: { full_name: repository },
      run_attempt: 1,
      status: "completed",
    },
    [pullPath]: {
      base: { ref: "dev" },
      body: "## Scope\n\n- Accepted issue: #160\n",
      head: { sha: "b".repeat(40) },
      number: 17,
      state: "open",
      updated_at: "2026-08-02T09:00:00Z",
    },
  });
  const result = await resolveLifecycleWakeup({
    environment: environment("evidence", "workflow_run"),
    event: baseEvent({
      workflow_run: {
        event: "pull_request",
        id: runId,
        name: "CodeQL",
        run_attempt: 1,
      },
    }),
    provider: api,
  });
  assert.deepEqual(result.locators, [
    { issue_number: 160, recovery_comment_id: "" },
  ]);
  assert.equal(result.requestCount, 4);
  assert.deepEqual(api.calls, [runPath, runPath, pullPath, pullPath]);
});

test("rejects evidence when the stable run ID differs from the payload run ID", async () => {
  const runId = 30740176638;
  const runPath = `/repos/${repository}/actions/runs/${runId}`;
  const api = provider({
    [runPath]: {
      event: "pull_request",
      head_sha: "b".repeat(40),
      id: runId + 1,
      name: "CodeQL",
      path: ".github/workflows/codeql.yml",
      pull_requests: [{ number: 17 }],
      repository: { full_name: repository },
      run_attempt: 1,
      status: "completed",
    },
  });
  await assert.rejects(
    resolveLifecycleWakeup({
      environment: environment("evidence", "workflow_run"),
      event: baseEvent({
        workflow_run: {
          event: "pull_request",
          id: runId,
          name: "CodeQL",
          pull_requests: [{ number: 17 }],
          run_attempt: 1,
        },
      }),
      provider: api,
    }),
    { code: "source-run-invalid" },
  );
  assert.deepEqual(api.calls, [runPath, runPath]);
});

test("rejects evidence when the stable run attempt differs from the payload attempt", async () => {
  const runId = 30740176639;
  const runPath = `/repos/${repository}/actions/runs/${runId}`;
  const api = provider({
    [runPath]: {
      event: "pull_request",
      head_sha: "b".repeat(40),
      id: runId,
      name: "CodeQL",
      path: ".github/workflows/codeql.yml",
      pull_requests: [{ number: 17 }],
      repository: { full_name: repository },
      run_attempt: 2,
      status: "completed",
    },
  });
  await assert.rejects(
    resolveLifecycleWakeup({
      environment: environment("evidence", "workflow_run"),
      event: baseEvent({
        workflow_run: {
          event: "pull_request",
          id: runId,
          name: "CodeQL",
          pull_requests: [{ number: 17 }],
          run_attempt: 1,
        },
      }),
      provider: api,
    }),
    { code: "source-run-invalid" },
  );
  assert.deepEqual(api.calls, [runPath, runPath]);
});

for (const [associationDescription, stablePullRequests] of [
  ["no PR association", []],
  ["a different PR association", [{ number: 18 }]],
  ["multiple PR associations", [{ number: 17 }, { number: 18 }]],
])
  test(`rejects evidence when the stable run has ${associationDescription} despite a payload PR`, async () => {
    const runId = 30740176640;
    const runPath = `/repos/${repository}/actions/runs/${runId}`;
    const api = provider({
      [runPath]: {
        event: "pull_request",
        head_sha: "b".repeat(40),
        id: runId,
        name: "CodeQL",
        path: ".github/workflows/codeql.yml",
        pull_requests: stablePullRequests,
        repository: { full_name: repository },
        run_attempt: 1,
        status: "completed",
      },
    });
    await assert.rejects(
      resolveLifecycleWakeup({
        environment: environment("evidence", "workflow_run"),
        event: baseEvent({
          workflow_run: {
            event: "pull_request",
            id: runId,
            name: "CodeQL",
            pull_requests: [{ number: 17 }],
            run_attempt: 1,
          },
        }),
        provider: api,
      }),
      { code: "exact-pull-request-required" },
    );
    assert.deepEqual(api.calls, [runPath, runPath]);
  });

test("scheduled enumeration is stable, sorted, deduplicated, and bounded to eight reads", async () => {
  const responses = {};
  for (const page of [1, 2]) {
    responses[
      `/repos/${repository}/issues?state=open&per_page=100&page=${page}`
    ] = page === 1 ? [{ number: 55 }, { number: 49 }] : [];
    responses[
      `/repos/${repository}/pulls?state=open&per_page=100&page=${page}`
    ] =
      page === 1
        ? [
            {
              body: "## Scope\n\n- Accepted issue: #51\n",
              number: 17,
            },
          ]
        : [];
  }
  const result = await resolveLifecycleWakeup({
    environment: environment("schedule", "schedule"),
    event: baseEvent(),
    provider: provider(responses),
  });
  assert.deepEqual(result.locators, [
    { issue_number: 49, recovery_comment_id: "" },
    { issue_number: 51, recovery_comment_id: "" },
    { issue_number: 55, recovery_comment_id: "" },
  ]);
  assert.equal(result.requestCount, 8);
});

test("fails closed on caller mismatch, ambiguous PR association, and unstable reads", async () => {
  await assert.rejects(
    resolveLifecycleWakeup({
      environment: environment("issue", "issues"),
      event: baseEvent({
        issue: { number: 51 },
        repository: { full_name: "attacker/repo" },
      }),
      provider: provider({}),
    }),
    { code: "caller-environment-mismatch" },
  );
  await assert.rejects(
    resolveLifecycleWakeup({
      environment: environment("pull-request", "check_run"),
      event: baseEvent({
        action: "completed",
        check_run: { pull_requests: [{ number: 17 }, { number: 18 }] },
      }),
      provider: provider({}),
    }),
    { code: "exact-pull-request-required" },
  );
  const path = `/repos/${repository}/pulls/17`;
  let reads = 0;
  const unstable = {
    binary: async () => Buffer.alloc(0),
    json: async () => ({
      base: { ref: "dev" },
      body: "## Scope\n\n- Accepted issue: #51\n",
      head: { sha: "b".repeat(40) },
      number: 17,
      state: "open",
      updated_at: `2026-07-29T10:00:0${reads++}Z`,
    }),
  };
  await assert.rejects(
    resolveLifecycleWakeup({
      environment: environment("pull-request", "pull_request_target"),
      event: baseEvent({
        action: "edited",
        pull_request: { number: 17 },
      }),
      provider: unstable,
    }),
    { code: "resolver-unstable" },
  );
  assert.equal(path.endsWith("/17"), true);
});

test("caller workflow freezes ADR-0012 source closure and has no Actions write or dispatch", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/lifecycle-wakeup.yml", import.meta.url),
    "utf8",
  );
  for (const marker of [
    "name: Lifecycle wake-up",
    "issues:",
    "pull_request_target:",
    "issue_comment:",
    "check_run:",
    "workflow_run:",
    'cron: "17 * * * *"',
    "resolve-issue:",
    "resolve-pull-request:",
    "resolve-governance:",
    "resolve-evidence:",
    "resolve-schedule:",
    "group: issue-lifecycle-provider-budget",
    "group: issue-lifecycle-${{ matrix.locator.issue_number }}",
    "needs.resolve-schedule.outputs.locators != '[]'",
    "uses: ./.github/workflows/issue-lifecycle.yml",
    "recovery_comment_id: ${{ matrix.locator.recovery_comment_id }}",
  ])
    assert.ok(workflow.includes(marker), marker);
  for (const forbidden of [
    "actions: write",
    "workflow_dispatch:",
    "repository_dispatch:",
    "pull_request_review:",
    "pull_request_review_comment:",
    "upload-artifact",
  ])
    assert.equal(workflow.includes(forbidden), false, forbidden);
  assert.match(
    workflow,
    /resolve-evidence:[\s\S]*?if: \$\{\{[^\n]*github\.event\.workflow_run\.event == 'pull_request'/u,
  );
});
