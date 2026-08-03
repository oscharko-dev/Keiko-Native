import assert from "node:assert/strict";
import test from "node:test";

import { createMigrationGithubProvider } from "./migration-github-provider.mjs";

const repository = "oscharko-dev/Keiko-Native";
const dev = "d".repeat(40);
const devTree = "e".repeat(40);
const head = "a".repeat(40);
const acceptedReadinessBody = [
  "<!-- keiko-native-readiness -->",
  "- Status: `accepted`",
  "- Contract version: `v1`",
  `- Fingerprint: \`${"f".repeat(64)}\``,
].join("\n");

const pageInfo = { endCursor: "end", hasNextPage: false };
const emptyContracts = async () => ({
  protectedDev: dev,
  contracts: {
    pages: [
      {
        cursor: null,
        endCursor: null,
        hasNextPage: false,
        nodes: [],
        totalCount: 0,
      },
    ],
  },
  manifests: {
    pages: [
      {
        cursor: null,
        endCursor: null,
        hasNextPage: false,
        nodes: [],
        totalCount: 0,
      },
    ],
  },
});

function fixtures() {
  return {
    labels: {
      data: {
        repository: {
          labels: {
            nodes: [{ name: "status: ready" }, { name: "type: task" }],
            pageInfo,
            totalCount: 2,
          },
          nameWithOwner: repository,
        },
      },
    },
    issues: {
      data: {
        repository: {
          defaultBranchRef: {
            name: "dev",
            target: { oid: dev, tree: { oid: devTree } },
          },
          issues: {
            nodes: [
              {
                assignees: {
                  nodes: [{ login: "Niko4417" }],
                  totalCount: 1,
                },
                body: "governed body",
                comments: {
                  nodes: [
                    {
                      author: {
                        __typename: "Bot",
                        databaseId: 41898282,
                        login: "github-actions",
                      },
                      body: "readiness",
                      createdAt: "2026-08-01T11:00:00Z",
                      databaseId: 99,
                    },
                  ],
                  pageInfo,
                  totalCount: 1,
                },
                labels: {
                  nodes: [{ name: "status: pr open" }, { name: "type: task" }],
                  totalCount: 2,
                },
                lastEditedAt: null,
                number: 30,
                state: "OPEN",
                stateReason: null,
                title: "Governed issue",
                timelineItems: {
                  nodes: [],
                  pageInfo,
                  totalCount: 0,
                },
                updatedAt: "2026-08-01T12:00:00Z",
              },
            ],
            pageInfo,
            totalCount: 1,
          },
          nameWithOwner: repository,
        },
      },
    },
    pullRequests: {
      data: {
        repository: {
          nameWithOwner: repository,
          pullRequests: {
            nodes: [
              {
                baseRefName: "dev",
                baseRefOid: dev,
                body: "## Scope\n\n- Accepted issue: #30",
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: head,
                        signature: { isValid: true, state: "VALID" },
                        status: {
                          contexts: [
                            {
                              context: "Issue contract current",
                              creator: {
                                __typename: "Bot",
                                databaseId: 41898282,
                                login: "github-actions",
                              },
                              state: "SUCCESS",
                            },
                            {
                              context: "PR contract",
                              creator: {
                                __typename: "Bot",
                                databaseId: 41898282,
                                login: "github-actions",
                              },
                              state: "SUCCESS",
                            },
                          ],
                        },
                        statusCheckRollup: {
                          state: "SUCCESS",
                        },
                      },
                    },
                  ],
                  totalCount: 1,
                },
                headRefName: "codex/30-work",
                headRefOid: head,
                headRepository: { nameWithOwner: repository },
                isDraft: false,
                labels: {
                  nodes: [{ name: "status: pr open" }],
                  totalCount: 1,
                },
                mergeCommit: null,
                mergeable: "MERGEABLE",
                merged: false,
                mergedBy: null,
                number: 70,
                state: "OPEN",
                title: "Deliver governed issue 30",
              },
            ],
            pageInfo,
            totalCount: 1,
          },
        },
      },
    },
  };
}

function graphqlHarness(mutate = () => {}) {
  let calls = 0;
  return {
    calls: () => calls,
    graphql: async (query) => {
      calls += 1;
      const values = fixtures();
      mutate(values, calls);
      if (query.includes("MigrationLabels")) return values.labels;
      if (query.includes("MigrationIssues")) return values.issues;
      if (query.includes("MigrationPullRequests")) return values.pullRequests;
      throw new Error("unexpected query");
    },
    json: async (path) => ({
      sha: head,
      statuses: [
        {
          context: "Issue contract current",
          creator: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
          state: "success",
        },
        {
          context: "PR contract",
          creator: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
          state: "success",
        },
      ],
      total_count: 2,
    }),
  };
}

test("collects a complete stable double-read without mutation capability", async () => {
  const harness = graphqlHarness();
  const provider = createMigrationGithubProvider({
    contracts: emptyContracts,
    graphql: harness.graphql,
    json: harness.json,
    now: () => "2026-08-01T12:00:00.000Z",
  });
  assert.deepEqual(Object.keys(provider), ["snapshot"]);
  const result = await provider.snapshot(repository);
  assert.equal(harness.calls(), 6);
  assert.equal(result.protectedDev, dev);
  assert.equal(result.issues.pages[0].nodes[0].state, "open");
  assert.equal(result.comments.get(30).pages[0].nodes[0].user.type, "Bot");
  assert.equal(
    result.comments.get(30).pages[0].nodes[0].user.login,
    "github-actions[bot]",
  );
  assert.equal(
    result.pullRequests.pages[0].nodes[0].head.repository,
    repository,
  );
  assert.deepEqual(result.pullRequests.pages[0].nodes[0].checks.required, [
    {
      conclusion: "SUCCESS",
      name: "Issue contract current",
      producer: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    },
    {
      conclusion: "SUCCESS",
      name: "PR contract",
      producer: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    },
  ]);
  assert.equal(result.contractsProtectedDev, dev);
  assert.equal(result.manifestsProtectedDev, dev);
});

test("rejects provider drift between complete reads", async () => {
  const harness = graphqlHarness((values, call) => {
    if (call === 6)
      values.pullRequests.data.repository.pullRequests.nodes[0].headRefOid =
        "b".repeat(40);
  });
  const provider = createMigrationGithubProvider({
    contracts: emptyContracts,
    graphql: harness.graphql,
    json: harness.json,
  });
  await assert.rejects(
    provider.snapshot(repository),
    /pull-request-invalid|provider-drift|status-page-invalid/u,
  );
});

test("binds repository contracts to blobs from the exact protected-dev tree", async () => {
  const harness = graphqlHarness();
  const content = Buffer.from("governed contract\n");
  const blob = "b".repeat(40);
  const provider = createMigrationGithubProvider({
    graphql: harness.graphql,
    json: async (path) => {
      if (path.includes(`/git/trees/${devTree}`))
        return {
          sha: devTree,
          tree: [
            {
              mode: "100644",
              path: "docs/contracts/task-30-v1-r1.md",
              sha: blob,
              type: "blob",
            },
          ],
          truncated: false,
        };
      if (path.endsWith(`/git/blobs/${blob}`))
        return {
          content: content.toString("base64"),
          encoding: "base64",
          sha: blob,
        };
      return harness.json(path);
    },
  });
  const result = await provider.snapshot(repository);
  assert.equal(result.contractsProtectedDev, dev);
  assert.equal(
    result.contracts.pages[0].nodes[0].path,
    "docs/contracts/task-30-v1-r1.md",
  );
});

test("derives a validated in-progress claim and reopen invalidation from history", async () => {
  const harness = graphqlHarness((values) => {
    const observed = values.issues.data.repository.issues.nodes[0];
    observed.labels.nodes[0].name = "status: in progress";
    observed.comments.nodes[0].body = acceptedReadinessBody;
    observed.timelineItems = {
      nodes: [
        {
          __typename: "ReopenedEvent",
          actor: { login: "Niko4417" },
          createdAt: "2026-08-01T10:00:00Z",
          id: "reopened-1",
        },
        {
          __typename: "AssignedEvent",
          actor: { login: "Niko4417" },
          assignee: { login: "Niko4417" },
          createdAt: "2026-08-01T11:30:00Z",
          id: "assigned-1",
        },
      ],
      pageInfo,
      totalCount: 2,
    };
  });
  const provider = createMigrationGithubProvider({
    contracts: emptyContracts,
    graphql: harness.graphql,
    json: async (path) =>
      path.includes("/collaborators/")
        ? { permission: "admin" }
        : harness.json(path),
  });
  const result = await provider.snapshot(repository);
  const observed = result.issues.pages[0].nodes[0];
  assert.equal(observed.claim.validated, true);
  assert.equal(observed.reopenedAt, "2026-08-01T10:00:00Z");
});

test("rejects assignment claims older than readiness or issue invalidation", async () => {
  for (const mutate of [
    (observed) => {
      observed.timelineItems.nodes[1].createdAt = "2026-08-01T10:30:00Z";
    },
    (observed) => {
      observed.lastEditedAt = "2026-08-01T11:45:00Z";
      observed.comments.nodes[0].createdAt = "2026-08-01T12:00:00Z";
    },
  ]) {
    const harness = graphqlHarness((values) => {
      const observed = values.issues.data.repository.issues.nodes[0];
      observed.labels.nodes[0].name = "status: in progress";
      observed.comments.nodes[0].body = acceptedReadinessBody;
      observed.timelineItems = {
        nodes: [
          {
            __typename: "ReopenedEvent",
            actor: { login: "Niko4417" },
            createdAt: "2026-08-01T10:00:00Z",
            id: "reopened-1",
          },
          {
            __typename: "AssignedEvent",
            actor: { login: "Niko4417" },
            assignee: { login: "Niko4417" },
            createdAt: "2026-08-01T11:30:00Z",
            id: "assigned-1",
          },
        ],
        pageInfo,
        totalCount: 2,
      };
      mutate(observed);
    });
    const provider = createMigrationGithubProvider({
      contracts: emptyContracts,
      graphql: harness.graphql,
      json: async (path) =>
        path.includes("/collaborators/")
          ? { permission: "admin" }
          : harness.json(path),
    });
    const result = await provider.snapshot(repository);
    assert.equal(result.issues.pages[0].nodes[0].claim, null);
  }
});

test("rejects incomplete or duplicate issue-event pagination", async () => {
  for (const mutate of [
    (timeline) => {
      timeline.totalCount = 1;
    },
    (timeline) => {
      timeline.nodes = [
        {
          __typename: "ReopenedEvent",
          actor: { login: "Niko4417" },
          createdAt: "2026-08-01T10:00:00Z",
          id: "same-event",
        },
        {
          __typename: "ReopenedEvent",
          actor: { login: "Niko4417" },
          createdAt: "2026-08-01T11:00:00Z",
          id: "same-event",
        },
      ];
      timeline.totalCount = 2;
    },
  ]) {
    const harness = graphqlHarness((values) => {
      mutate(values.issues.data.repository.issues.nodes[0].timelineItems);
    });
    const provider = createMigrationGithubProvider({
      contracts: emptyContracts,
      graphql: harness.graphql,
      json: harness.json,
    });
    await assert.rejects(
      provider.snapshot(repository),
      /migration-provider-issue-events-incomplete/u,
    );
  }
});

test("binds a dispatched scan to the checked-out protected-dev commit", async () => {
  const harness = graphqlHarness();
  const provider = createMigrationGithubProvider({
    contracts: emptyContracts,
    expectedProtectedDev: "f".repeat(40),
    graphql: harness.graphql,
    json: harness.json,
  });
  await assert.rejects(
    provider.snapshot(repository),
    /migration-provider-checked-out-dev-mismatch/u,
  );
});

test("loads the immutable manifest chain from protected dev", async () => {
  const harness = graphqlHarness();
  const bytes = Buffer.from('{"entries":[],"predecessor":null}\n');
  const blob = "b".repeat(40);
  const provider = createMigrationGithubProvider({
    graphql: harness.graphql,
    json: async (path) => {
      if (path.includes(`/git/trees/${devTree}`))
        return {
          sha: devTree,
          tree: [
            {
              mode: "100644",
              path: "docs/qa/repository-migration-manifest-v1.md",
              sha: blob,
              type: "blob",
            },
          ],
          truncated: false,
        };
      if (path.endsWith(`/git/blobs/${blob}`))
        return {
          content: bytes.toString("base64"),
          encoding: "base64",
          sha: blob,
        };
      return harness.json(path);
    },
  });
  const result = await provider.snapshot(repository);
  assert.deepEqual(result.manifests.pages[0].nodes[0].predecessor, null);
  assert.equal(
    result.manifests.pages[0].nodes[0].path,
    "docs/qa/repository-migration-manifest-v1.md",
  );
});

test("preserves the complete exact-head rollup independently of commit statuses", async () => {
  const harness = graphqlHarness((values) => {
    values.pullRequests.data.repository.pullRequests.nodes[0].commits.nodes[0].commit.statusCheckRollup.state =
      "FAILURE";
  });
  const provider = createMigrationGithubProvider({
    contracts: emptyContracts,
    graphql: harness.graphql,
    json: harness.json,
  });
  const result = await provider.snapshot(repository);
  const checks = result.pullRequests.pages[0].nodes[0].checks;
  assert.equal(checks.allPassing, false);
  assert.equal(
    checks.required.every(({ conclusion }) => conclusion === "SUCCESS"),
    true,
  );
});

test("rejects truncated nested sets, unavailable data, and request-budget exhaustion", async () => {
  const malformed = graphqlHarness((values, call) => {
    if (call === 2)
      values.issues.data.repository.issues.nodes[0].comments.pageInfo = {
        endCursor: "comments-end",
        hasNextPage: true,
      };
  });
  const malformedProvider = createMigrationGithubProvider({
    contracts: emptyContracts,
    graphql: malformed.graphql,
    json: malformed.json,
  });
  await assert.rejects(
    malformedProvider.snapshot(repository),
    /unexpected query/u,
  );

  const budget = graphqlHarness();
  const budgetProvider = createMigrationGithubProvider({
    contracts: emptyContracts,
    graphql: budget.graphql,
    json: budget.json,
    maximumRequests: 5,
  });
  await assert.rejects(budgetProvider.snapshot(repository), /request-ceiling/u);
});

test("constructor supplies a protected-dev contract reader and rejects invalid ceilings", () => {
  assert.deepEqual(Object.keys(createMigrationGithubProvider()), ["snapshot"]);
  assert.throws(
    () =>
      createMigrationGithubProvider({
        contracts: emptyContracts,
        maximumRequests: 0,
      }),
    /request ceiling is invalid/u,
  );
  assert.throws(
    () => createMigrationGithubProvider({ expectedProtectedDev: "bad" }),
    /expected protected dev is invalid/u,
  );
});
