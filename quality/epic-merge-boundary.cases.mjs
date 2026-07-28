import assert from "node:assert/strict";
import test from "node:test";

import { createEpicMergeGitHubBoundary } from "./epic-merge-github.mjs";
import {
  base,
  head,
  headTree,
  mergeCommit,
  repository,
  target,
} from "./epic-merge-broker-fixtures.mjs";

const response = (body, status = 200) => ({ body, headers: {}, status });

test("merged readback accepts provider-null eligibility fields", async () => {
  const boundary = createEpicMergeGitHubBoundary({
    request: async ({ path }) => {
      if (path.includes("/pulls/"))
        return response({
          base: { ref: target, sha: base },
          body: null,
          draft: null,
          head: { ref: "codex/source", sha: head },
          merge_commit_sha: mergeCommit,
          mergeable: null,
          merged: true,
          number: 150,
          state: "closed",
        });
      if (path.includes(`/git/commits/${mergeCommit}`))
        return response({
          parents: [{ sha: base }],
          sha: mergeCommit,
          tree: { sha: headTree },
        });
      return response({ object: { sha: mergeCommit } });
    },
  });
  assert.deepEqual(
    await boundary.readMergeOutcome({ pullRequest: 150, target }),
    {
      base,
      commit: { parents: [base], sha: mergeCommit, tree: headTree },
      merged: true,
      pullRequest: 150,
      source: "codex/source",
      sourceHead: head,
      target,
      targetTip: mergeCommit,
    },
  );
});

test("code findings accept exact open, fixed, and dismissed alerts only", async () => {
  const alert = (number, state, overrides = {}) => ({
    dismissed_at: null,
    dismissed_by: null,
    dismissed_reason: null,
    most_recent_instance: { ref: "refs/pull/150/merge" },
    number,
    state,
    ...overrides,
  });
  const boundary = createEpicMergeGitHubBoundary({
    request: async () =>
      response([
        alert(1, "open"),
        alert(2, "fixed"),
        alert(3, "dismissed", {
          dismissed_at: "2026-07-28T00:00:00Z",
          dismissed_by: { login: "oscharko" },
          dismissed_reason: "false positive",
        }),
      ]),
  });
  assert.deepEqual(await boundary.listFindings({ page: 1, pullRequest: 150 }), {
    items: [{ blocking: true }, { blocking: false }, { blocking: false }],
    nextPage: null,
  });
  for (const malformed of [
    {},
    alert(1, "unknown"),
    alert(1, "open", { most_recent_instance: {} }),
    alert(1, "dismissed"),
  ]) {
    const invalid = createEpicMergeGitHubBoundary({
      request: async () => response([malformed]),
    });
    assert.deepEqual(
      await invalid.listFindings({ page: 1, pullRequest: 150 }),
      { items: [], nextPage: undefined },
    );
  }
});

test("malformed protected policy payloads fail closed at the provider boundary", async () => {
  for (const payload of ["null", "{"]) {
    const boundary = createEpicMergeGitHubBoundary({
      request: async ({ path }) =>
        path.includes("/git/ref/")
          ? response({ object: { sha: head } })
          : response({
              content: Buffer.from(payload).toString("base64"),
              encoding: "base64",
            }),
    });
    assert.deepEqual(await boundary.readPolicy(), {
      document: null,
      protected: false,
      ref: "refs/heads/dev",
      revision: head,
    });
  }
});

async function assertBodyShapedNon200FailsClosed(status) {
  const boundary = createEpicMergeGitHubBoundary({
    request: async ({ path }) => {
      if (path.includes("/issues/"))
        return response(
          {
            body: "valid",
            labels: [],
            number: 50,
            state: "open",
            title: "valid",
          },
          status,
        );
      if (path.includes("/git/ref/"))
        return response({ object: { sha: head } }, status);
      if (path.includes("/collaborators/"))
        return response({ permission: "maintain" }, status);
      if (path.includes("/branches/"))
        return response({ enforce_admins: { enabled: true } }, status);
      if (path.includes("/rulesets")) return response([], status);
      if (path.includes("/pulls/"))
        return response(
          {
            base: { ref: target, sha: base },
            head: { ref: "codex/source", sha: head },
            merge_commit_sha: head,
            merged: true,
            number: 150,
          },
          status,
        );
      return response({}, status);
    },
  });
  assert.equal(await boundary.readIssue({ issue: 50 }), null);
  assert.equal(await boundary.readPullRequest({ pullRequest: 150 }), null);
  assert.equal(await boundary.readRef({ ref: target }), null);
  assert.equal(
    await boundary.readPermission({ actor: "oscharko", target }),
    null,
  );
  assert.equal(
    await boundary.readMergeOutcome({ pullRequest: 150, target }),
    null,
  );
  assert.equal((await boundary.readPolicy()).protected, false);
  assert.deepEqual(await boundary.listFindings({ page: 1, pullRequest: 150 }), {
    items: [],
    nextPage: undefined,
  });
}

test("body-shaped non-200 authoritative reads fail closed", async () => {
  await assertBodyShapedNon200FailsClosed(403);
  await assertBodyShapedNon200FailsClosed(404);
  assert.equal(repository, "oscharko-dev/Keiko-Native");
});
