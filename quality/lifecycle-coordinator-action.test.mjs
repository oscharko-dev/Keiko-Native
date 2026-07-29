import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runLifecycleCoordinatorAction } from "./lifecycle-coordinator-action.mjs";

const commit = "a".repeat(40);
const environment = {
  GITHUB_REPOSITORY: "oscharko-dev/Keiko-Native",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_ID: "900",
  GITHUB_WORKFLOW_SHA: commit,
  KEIKO_ROUTED_ISSUE_NUMBER: "51",
  KEIKO_ROUTED_RECOVERY_COMMENT_ID: "",
};
const issue = {
  assignees: [],
  body: [
    "## Planning contract",
    "",
    "- Contract version: `v1`",
    "",
    "## Execution Authority",
    "",
    "- Exact delivery target: `dev`",
  ].join("\n"),
  id: 51,
  labels: [{ name: "type: task" }, { name: "status: ready" }],
  number: 51,
  title: "Protected lifecycle fixture",
  updated_at: "2026-07-29T11:59:00Z",
};

function emptyProvider() {
  return {
    authenticateRecoveryComment: async () => {
      throw new Error("recovery target unavailable");
    },
    comments: () => [],
    discoverRecoveryComment: async () => null,
    getComment: async () => ({
      body: `/keiko-native lifecycle-recovery v1 target=sha256:${"a".repeat(64)}`,
    }),
    listAnchorArtifacts: async () => ({ complete: true, items: [] }),
    listCommentsPage: async () => ({
      hasMore: false,
      items: [],
      nextCursor: null,
    }),
  };
}

test("writes the exact coordinator record outputs for an empty history", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-coordinator-"));
  const githubOutput = join(root, "output");
  await writeFile(githubOutput, "");
  const result = await runLifecycleCoordinatorAction({
    environment,
    githubOutput,
    loadFacts: async () => ({ issue, pullRequest: null }),
    now: new Date("2026-07-29T12:00:00Z"),
    provider: emptyProvider(),
  });
  assert.equal(result.history.state, "empty");
  assert.equal(result.plan.kind, "record");
  const output = await readFile(githubOutput, "utf8");
  assert.match(output, /^issue-number=51$/mu);
  assert.match(output, /^next-writer=record$/mu);
  assert.match(output, /^should-record=true$/mu);
  assert.match(output, /^record-plan=[A-Za-z0-9_-]+$/mu);
});

test("rejects noncanonical routes and unavailable recovery before facts access", async () => {
  let accessed = false;
  await assert.rejects(
    runLifecycleCoordinatorAction({
      environment: {
        ...environment,
        KEIKO_ROUTED_RECOVERY_COMMENT_ID: "01",
      },
      loadFacts: async () => {
        accessed = true;
      },
      provider: emptyProvider(),
    }),
    /recovery comment ID/u,
  );
  assert.equal(accessed, false);
  await assert.rejects(
    runLifecycleCoordinatorAction({
      environment: {
        ...environment,
        KEIKO_ROUTED_RECOVERY_COMMENT_ID: "17",
      },
      loadFacts: async () => {
        accessed = true;
      },
      provider: emptyProvider(),
    }),
    /recovery target unavailable/u,
  );
  assert.equal(accessed, false);
});

test("treats a direct non-recovery comment as a sanitized no-op", async () => {
  const result = await runLifecycleCoordinatorAction({
    environment: {
      ...environment,
      KEIKO_ROUTED_RECOVERY_COMMENT_ID: "17",
    },
    loadFacts: async () => {
      throw new Error("facts must not be loaded");
    },
    provider: {
      ...emptyProvider(),
      authenticateRecoveryComment: async () => null,
    },
  });
  assert.equal(result.plan.kind, "noop");
  assert.match(result.plan.observation, /^[0-9a-f]{64}$/u);
});
