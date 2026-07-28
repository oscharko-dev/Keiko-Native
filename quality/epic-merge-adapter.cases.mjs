import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createInertEpicMergeAdapter } from "./epic-merge-adapter.mjs";
import { githubFixture, page } from "./epic-merge-adapter-fixtures.mjs";
import { epicMergeAuthorizationCurrent } from "./epic-merge-authorization.mjs";
import {
  base,
  guardedPolicy,
  head,
  request,
  target,
} from "./epic-merge-broker-fixtures.mjs";

test("inert adapter reconstructs complete current authorization and protection", async () => {
  const store = {
    prepareOperation: () => {},
    readOperation: () => {},
    readPreparation: () => {},
    settleOperation: () => {},
  };
  const adapter = createInertEpicMergeAdapter({
    clock: () => "2026-07-27T19:00:00.000Z",
    github: githubFixture(),
    store,
  });
  const snapshot = await adapter.loadAuthorization(request());
  assert.equal(snapshot.issue.readiness.current, true);
  assert.equal(snapshot.issue.readiness.fingerprint.length, 64);
  assert.equal(snapshot.pagination.complete, true);
  assert.equal(snapshot.checks[0].producer, "github-actions@15368");
  const rules = await adapter.loadTargetProtection(target, base);
  assert.equal(rules.pagination.complete, true);
  assert.equal(rules.authorization.bypass, false);
  assert.deepEqual(await adapter.readRefs(target, "codex/source"), {
    base,
    head,
  });
});

test("adapter rejects malformed protected policy documents with a bounded error", async () => {
  for (const document of [null, [], "invalid"]) {
    const adapter = createInertEpicMergeAdapter({
      clock: () => "",
      github: githubFixture({
        policy: {
          document,
          protected: true,
          ref: "refs/heads/dev",
          revision: head,
        },
      }),
      store: {},
    });
    await assert.rejects(adapter.loadProtectedPolicy(), {
      message: "protected_policy_document_invalid",
    });
  }
});

test("adapter reads only the canonical execution-authority target field", async () => {
  const template = await readFile(
    new URL("../.github/ISSUE_TEMPLATE/feature_task.md", import.meta.url),
    "utf8",
  );
  const body = template.replace(
    "- Exact delivery target: `epic/<epic-number>-<short-slug> | dev (standalone)`",
    `- Exact delivery target: \`${target}\``,
  );
  const canonical = createInertEpicMergeAdapter({
    clock: () => "",
    github: githubFixture({ issueBody: body }),
    store: {},
  });
  assert.equal(
    (await canonical.loadAuthorization(request())).issue.target,
    target,
  );
  const legacy = createInertEpicMergeAdapter({
    clock: () => "",
    github: githubFixture({
      issueBody: body.replace("Exact delivery target", "Delivery target"),
    }),
    store: {},
  });
  assert.equal(
    (await legacy.loadAuthorization(request())).issue.target,
    undefined,
  );
});

test("adapter preserves missing bypass proof as unknown", async () => {
  const adapter = createInertEpicMergeAdapter({
    clock: () => "",
    github: githubFixture({
      readPermission: async () => ({ permission: "maintain" }),
    }),
    store: {},
  });
  const observed = await adapter.loadTargetProtection(target, base);
  assert.equal(observed.authorization.bypass, null);
});

test("adapter binds actual checks and latest statuses to the canonical PR", async () => {
  const adapter = createInertEpicMergeAdapter({
    clock: () => "",
    github: githubFixture({
      listCommitStatuses: async () =>
        page([
          {
            context: "PR contract",
            creator: {
              id: 41898282,
              login: "github-actions[bot]",
              type: "Bot",
            },
            id: 12,
            sha: null,
            state: "failure",
          },
          {
            context: "Issue contract current",
            creator: {
              id: 41898282,
              login: "github-actions[bot]",
              type: "Bot",
            },
            id: 11,
            sha: null,
            state: "success",
          },
          {
            context: "PR contract",
            creator: {
              id: 41898282,
              login: "github-actions[bot]",
              type: "Bot",
            },
            id: 10,
            sha: null,
            state: "success",
          },
        ]),
    }),
    store: {},
  });
  const checks = (await adapter.loadAuthorization(request())).checks;
  assert.deepEqual(
    checks.map(({ base, conclusion, context, head, producer, status }) => ({
      base,
      conclusion,
      context,
      head,
      producer,
      status,
    })),
    [
      {
        base,
        conclusion: "success",
        context: "ci",
        head,
        producer: "github-actions@15368",
        status: "completed",
      },
      {
        base,
        conclusion: "failure",
        context: "PR contract",
        head,
        producer: "github-actions[bot]@41898282",
        status: "completed",
      },
      {
        base,
        conclusion: "success",
        context: "Issue contract current",
        head,
        producer: "github-actions[bot]@41898282",
        status: "completed",
      },
    ],
  );
});

test("adapter rejects missing or conflicting nonempty check associations", async () => {
  for (const pull_requests of [
    undefined,
    [{ base: { sha: "f".repeat(40) }, head: { sha: head }, number: 150 }],
    [{ base: { sha: base }, head: { sha: "f".repeat(40) }, number: 150 }],
    [{ base: { sha: base }, head: { sha: head }, number: 999 }],
  ]) {
    const adapter = createInertEpicMergeAdapter({
      clock: () => "",
      github: githubFixture({
        listChecks: async () =>
          page([
            {
              app: { id: 15368, slug: "github-actions" },
              conclusion: "success",
              head_sha: head,
              id: 100,
              name: "ci",
              pull_requests,
              status: "completed",
            },
          ]),
      }),
      store: {},
    });
    assert.equal(
      (await adapter.loadAuthorization(request())).checks[0].base,
      null,
    );
  }
});

test("status ordering and cross-source duplicates fail closed", async () => {
  const status = (id) => ({
    context: "PR contract",
    creator: {
      id: 41898282,
      login: "github-actions[bot]",
      type: "Bot",
    },
    id,
    sha: null,
    state: "success",
  });
  const malformed = createInertEpicMergeAdapter({
    clock: () => "",
    github: githubFixture({
      listCommitStatuses: async () => page([status(10), status(11)]),
    }),
    store: {},
  });
  assert.equal(
    (await malformed.loadAuthorization(request())).pagination.complete,
    false,
  );
  const duplicate = createInertEpicMergeAdapter({
    clock: () => "",
    github: githubFixture({
      listChecks: async () =>
        page([
          {
            app: { id: 41898282, slug: "github-actions[bot]" },
            conclusion: "success",
            head_sha: head,
            id: 101,
            name: "PR contract",
            pull_requests: [],
            status: "completed",
          },
        ]),
      listCommitStatuses: async () => page([status(11)]),
    }),
    store: {},
  });
  const snapshot = await duplicate.loadAuthorization(request());
  const policy = guardedPolicy();
  policy.requiredChecks = [
    {
      context: "PR contract",
      producer: "github-actions[bot]@41898282",
    },
  ];
  assert.equal(
    epicMergeAuthorizationCurrent(snapshot, request(), policy),
    false,
  );
});
