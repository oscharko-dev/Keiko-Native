import assert from "node:assert/strict";
import test from "node:test";

import { createMigrationGithubProvider } from "./migration-github-provider.mjs";

const repository = "oscharko-dev/Keiko-Native";
const dev = "d".repeat(40);
const head = "a".repeat(40);

const pageInfo = { endCursor: "end", hasNextPage: false };
const emptyContracts = async () => ({
  pages: [
    {
      cursor: null,
      endCursor: null,
      hasNextPage: false,
      nodes: [],
      totalCount: 0,
    },
  ],
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
          defaultBranchRef: { name: "dev", target: { oid: dev } },
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
                number: 30,
                state: "OPEN",
                stateReason: null,
                title: "Governed issue",
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
                labels: {
                  nodes: [{ name: "status: pr open" }],
                  totalCount: 1,
                },
                mergeCommit: null,
                merged: false,
                mergedBy: null,
                number: 70,
                state: "OPEN",
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
        { context: "Issue contract current", state: "success" },
        { context: "PR contract", state: "success" },
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
  assert.deepEqual(result.pullRequests.pages[0].nodes[0].checks.required, [
    { conclusion: "SUCCESS", name: "Issue contract current" },
    { conclusion: "SUCCESS", name: "PR contract" },
  ]);
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

test("constructor rejects missing contract readers and invalid ceilings", () => {
  assert.throws(
    () => createMigrationGithubProvider(),
    /contract reader is required/u,
  );
  assert.throws(
    () =>
      createMigrationGithubProvider({
        contracts: emptyContracts,
        maximumRequests: 0,
      }),
    /request ceiling is invalid/u,
  );
});
