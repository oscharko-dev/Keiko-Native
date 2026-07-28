import assert from "node:assert/strict";
import test from "node:test";

import { createInertEpicMergeAdapter } from "./epic-merge-adapter.mjs";
import {
  auditComment,
  githubFixture,
  page,
} from "./epic-merge-adapter-fixtures.mjs";
import { head, request } from "./epic-merge-broker-fixtures.mjs";

const adapter = (github) =>
  createInertEpicMergeAdapter({ clock: () => "", github, store: {} });

test("evidence uses exact-head bot acceptance and immutable maintainer audit", async () => {
  const evidence = (await adapter(githubFixture()).loadAuthorization(request()))
    .evidence;
  assert.deepEqual(evidence.acceptance, {
    complete: true,
    current: true,
    head,
    producer: "github-actions[bot]@41898282",
    statusId: 20,
  });
  assert.equal(evidence.audit.complete, true);
  assert.equal(evidence.audit.current, true);
  assert.equal(evidence.audit.producer, "maintainer-audit@adr-0009");
  assert.equal(evidence.audit.actor, "oscharko");
  assert.equal(evidence.audit.commentId, 700);
  assert.match(evidence.audit.digest, /^[0-9a-f]{64}$/u);
});

test("audit evidence rejects edits, duplicates, wrong actor, workflow, head, or digest", async () => {
  const mutations = [
    (comment) => (comment.updated_at = "2026-07-28T00:00:01Z"),
    (comment) => (comment.user.login = "other-admin"),
    (comment) =>
      (comment.body = comment.body.replace(
        "adr-0009-maintainer-audit-v1",
        "other-workflow",
      )),
    (comment) => (comment.body = comment.body.replace(head, "f".repeat(40))),
    (comment) =>
      (comment.body = comment.body.replace(
        /- Digest: `[0-9a-f]{64}`/u,
        `- Digest: \`${"f".repeat(64)}\``,
      )),
  ];
  for (const mutate of mutations) {
    const comment = auditComment();
    mutate(comment);
    const github = githubFixture({
      listIssueComments: async ({ issue }) =>
        page(issue === 150 ? [comment] : []),
    });
    assert.equal(
      (await adapter(github).loadAuthorization(request())).evidence.audit
        .current,
      false,
    );
  }
  const duplicate = githubFixture({
    listIssueComments: async ({ issue }) =>
      page(issue === 150 ? [auditComment(), auditComment({ id: 701 })] : []),
  });
  assert.equal(
    (await adapter(duplicate).loadAuthorization(request())).evidence.audit
      .current,
    false,
  );
});

test("newest PR contract failure makes acceptance evidence fail", async () => {
  const github = githubFixture({
    listCommitStatuses: async () =>
      page([
        {
          context: "PR contract",
          creator: {
            id: 41898282,
            login: "github-actions[bot]",
            type: "Bot",
          },
          id: 21,
          sha: null,
          state: "failure",
        },
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
      ]),
  });
  assert.equal(
    (await adapter(github).loadAuthorization(request())).evidence.acceptance
      .current,
    false,
  );
});
