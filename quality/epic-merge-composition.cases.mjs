import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditComment } from "./epic-merge-adapter-fixtures.mjs";
import { createInertEpicMergeComposition } from "./epic-merge-composition.mjs";
import { createEpicMergeGitHubBoundary } from "./epic-merge-github.mjs";
import { semanticIssueFingerprint } from "./issue-contract.mjs";
import {
  base,
  guardedPolicy,
  head,
  headTree,
  mergeCommit,
  request,
  repository,
  sha,
  target,
} from "./epic-merge-broker-fixtures.mjs";

const response = (body, status = 200) => ({ body, headers: {}, status });

test("production composition is inert until run and normalizes GitHub boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keiko-epic-composition-"));
  const template = await readFile(
    new URL("../.github/ISSUE_TEMPLATE/feature_task.md", import.meta.url),
    "utf8",
  );
  const body = template
    .replace("- Contract version: `v1`", "- Contract version: `v5`")
    .replace(
      "- Exact delivery target: `epic/<epic-number>-<short-slug> | dev (standalone)`",
      `- Exact delivery target: \`${target}\``,
    );
  const title = "Guarded epic merge";
  const fingerprint = semanticIssueFingerprint(body, title);
  const policy = guardedPolicy();
  let merged = false;
  const calls = [];
  const rawRequest = async (input) => {
    calls.push(structuredClone(input));
    const path = input.path;
    if (path === `/repos/${repository}/git/ref/heads/dev`)
      return response({ object: { sha: sha("a") } });
    if (path.startsWith(`/repos/${repository}/contents/`))
      return response({
        content: Buffer.from(JSON.stringify(policy)).toString("base64"),
        encoding: "base64",
      });
    if (path === `/repos/${repository}/issues/50`)
      return response({
        body,
        labels: [{ name: "status: ready for human review" }],
        number: 50,
        state: "open",
        title,
      });
    if (path === `/repos/${repository}/issues/50/comments?page=1&per_page=100`)
      return response([
        {
          body: [
            "<!-- keiko-native-readiness -->",
            "- Status: `accepted`",
            "- Contract version: `v5`",
            `- Fingerprint: \`${fingerprint}\``,
          ].join("\n"),
          id: 500,
          user: {
            id: 41898282,
            login: "github-actions[bot]",
            type: "Bot",
          },
        },
      ]);
    if (path === `/repos/${repository}/issues/150/comments?page=1&per_page=100`)
      return response([auditComment()]);
    if (path === `/repos/${repository}/pulls/150`)
      return response({
        base: { ref: target, sha: base },
        body: "Closes #50",
        draft: false,
        head: {
          ref: "codex/50-inert-epic-merge-guard-v5",
          sha: head,
        },
        merge_commit_sha: merged ? mergeCommit : null,
        mergeable: true,
        merged,
        number: 150,
        state: merged ? "closed" : "open",
      });
    if (path === `/repos/${repository}/git/commits/${head}`)
      return response({
        parents: [{ sha: base }],
        sha: head,
        tree: { sha: headTree },
      });
    if (path === `/repos/${repository}/git/commits/${mergeCommit}`)
      return response({
        parents: [{ sha: base }],
        sha: mergeCommit,
        tree: { sha: headTree },
      });
    if (path.startsWith(`/repos/${repository}/commits/${head}/check-runs`))
      return response({
        check_runs: [
          {
            app: { id: 15368, slug: "github-actions" },
            conclusion: "success",
            head_sha: head,
            id: 100,
            name: "ci",
            pull_requests: [],
            status: "completed",
          },
        ],
      });
    if (path.startsWith(`/repos/${repository}/commits/${head}/statuses`))
      return response([
        {
          context: "PR contract",
          creator: {
            id: 41898282,
            login: "github-actions[bot]",
            type: "Bot",
          },
          id: 20,
          sha: null,
          state: "success",
        },
      ]);
    if (path.startsWith(`/repos/${repository}/code-scanning/alerts`))
      return response([]);
    if (path === "/graphql")
      return response({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        },
      });
    if (path === "/user") return response({ login: "oscharko" });
    if (path.includes("/collaborators/oscharko/permission"))
      return response({ permission: "maintain" });
    if (path.includes(`/branches/${encodeURIComponent(target)}/protection`))
      return response({
        allow_deletions: { enabled: false },
        allow_force_pushes: { enabled: false },
        enforce_admins: { enabled: true },
        required_pull_request_reviews: {},
        required_signatures: { enabled: true },
        required_status_checks: { strict: true },
      });
    if (path.startsWith(`/repos/${repository}/rulesets?`))
      return response([{ id: 49, name: "Epic protection" }]);
    if (path === `/repos/${repository}/rulesets/49`)
      return response(
        [
          {
            bypass_actors: [],
            conditions: {
              ref_name: { exclude: [], include: [`refs/heads/${target}`] },
            },
            enforcement: "active",
            id: 49,
            rules: [
              { type: "deletion" },
              { type: "non_fast_forward" },
              { type: "pull_request" },
              { type: "required_signatures" },
              {
                parameters: {
                  strict_required_status_checks_policy: true,
                },
                type: "required_status_checks",
              },
            ],
          },
        ][0],
      );
    if (
      path ===
      `/repos/${repository}/git/ref/heads/${encodeURIComponent(target)}`
    )
      return response({ object: { sha: merged ? mergeCommit : base } });
    if (
      path ===
      `/repos/${repository}/git/ref/heads/${encodeURIComponent(
        "codex/50-inert-epic-merge-guard-v5",
      )}`
    )
      return response({ object: { sha: head } });
    if (path === `/repos/${repository}/pulls/150/merge`) {
      merged = true;
      return response({ merged: true, sha: mergeCommit });
    }
    return response({}, 404);
  };
  const composition = createInertEpicMergeComposition({
    clock: () => "2026-07-28T12:00:00.000Z",
    databasePath: join(directory, "operations.sqlite"),
    request: rawRequest,
  });
  try {
    assert.equal(calls.length, 0);
    const result = await composition.run(request());
    assert.equal(result.result, "merged", JSON.stringify(result));
    assert.equal(
      calls.filter((call) => call.path.endsWith("/pulls/150/merge")).length,
      1,
    );
    assert.equal(
      calls.some((call) =>
        call.path.includes(
          `/commits/${head}/check-runs?filter=latest&page=1&per_page=100`,
        ),
      ),
      true,
    );
    assert.equal(
      calls.some((call) =>
        call.path.includes(`/commits/${head}/statuses?page=1&per_page=100`),
      ),
      true,
    );
    assert.equal(
      (
        await composition.reconcile({
          actor: "oscharko",
          operationId: result.receipt.operationId,
          repository,
        })
      ).result,
      "blocked",
    );
  } finally {
    composition.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("ruleset discovery requires complete detail and honors exact exclusion", async () => {
  const protection = response({
    allow_deletions: { enabled: false },
    allow_force_pushes: { enabled: false },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {},
    required_signatures: { enabled: true },
    required_status_checks: { strict: true },
  });
  const detail = {
    bypass_actors: [],
    conditions: {
      ref_name: { exclude: [], include: [`refs/heads/${target}`] },
    },
    enforcement: "active",
    id: 49,
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "pull_request" },
      { type: "required_signatures" },
      {
        parameters: { strict_required_status_checks_policy: true },
        type: "required_status_checks",
      },
    ],
  };
  const boundary = (mutate) =>
    createEpicMergeGitHubBoundary({
      request: async ({ path }) => {
        if (path.includes("/branches/")) return protection;
        if (path.includes("/rulesets?"))
          return response([{ id: 49, name: "summary-only" }]);
        if (path.endsWith("/rulesets/49")) {
          const value = structuredClone(detail);
          mutate(value);
          return response(value);
        }
        if (path === "/user") return response({ login: "oscharko" });
        if (path.includes("/collaborators/"))
          return response({ permission: "maintain" });
        return response({}, 404);
      },
    });
  const missingBypass = boundary((value) => delete value.bypass_actors);
  assert.deepEqual(await missingBypass.listTargetRules({ page: 1, target }), {
    items: [],
    nextPage: undefined,
  });
  assert.equal(await missingBypass.readPermission({ target }), null);
  const excluded = boundary((value) =>
    value.conditions.ref_name.exclude.push(`refs/heads/${target}`),
  );
  assert.deepEqual(await excluded.listTargetRules({ page: 1, target }), {
    items: [],
    nextPage: null,
  });
});

test("review threads use bounded real GraphQL cursor pagination", async () => {
  const calls = [];
  const boundary = createEpicMergeGitHubBoundary({
    request: async (input) => {
      calls.push(structuredClone(input));
      const after = input.body?.variables?.after;
      return response({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{ isResolved: after === "cursor-1" }],
                pageInfo:
                  after === null
                    ? { endCursor: "cursor-1", hasNextPage: true }
                    : { endCursor: null, hasNextPage: false },
              },
            },
          },
        },
      });
    },
  });
  assert.deepEqual(
    await boundary.listConversations({ page: 1, pullRequest: 150 }),
    {
      items: [{ resolved: false }, { resolved: true }],
      nextPage: null,
    },
  );
  assert.equal(calls.length, 2);
  assert.match(
    calls[0].body.query,
    /reviewThreads\(first: \$first, after: \$after\)/u,
  );
  assert.deepEqual(
    calls.map((call) => call.body.variables),
    [
      {
        after: null,
        first: 100,
        name: "Keiko-Native",
        number: 150,
        owner: "oscharko-dev",
      },
      {
        after: "cursor-1",
        first: 100,
        name: "Keiko-Native",
        number: 150,
        owner: "oscharko-dev",
      },
    ],
  );

  const cyclic = createEpicMergeGitHubBoundary({
    request: async () =>
      response({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [],
                pageInfo: { endCursor: "same", hasNextPage: true },
              },
            },
          },
        },
      }),
  });
  assert.deepEqual(
    await cyclic.listConversations({ page: 1, pullRequest: 150 }),
    { items: [], nextPage: undefined },
  );
});
