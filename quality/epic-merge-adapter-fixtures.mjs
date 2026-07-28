import { semanticIssueFingerprint } from "./issue-contract.mjs";
import { digestEpicMergeValue } from "./epic-merge-policy.mjs";
import { base, head, headTree, target } from "./epic-merge-broker-fixtures.mjs";

export const page = (items, nextPage = null) => ({ items, nextPage });

export function auditComment(overrides = {}) {
  const workflow = "adr-0009-maintainer-audit-v1";
  const digest = digestEpicMergeValue({ findings: 0, head, workflow });
  return {
    body: [
      "<!-- keiko-native-epic-merge-audit -->",
      "- Status: `accepted`",
      `- Head: \`${head}\``,
      "- Findings: `0`",
      `- Workflow: \`${workflow}\``,
      `- Digest: \`${digest}\``,
    ].join("\n"),
    created_at: "2026-07-28T00:00:00Z",
    id: 700,
    updated_at: "2026-07-28T00:00:00Z",
    user: { id: 59687448, login: "oscharko", type: "User" },
    ...overrides,
  };
}

export function githubFixture(overrides = {}) {
  const title = "Guarded epic merge";
  const body =
    overrides.issueBody ??
    [
      "## Planning contract",
      "",
      "- Contract version: `v5`",
      "- Exact delivery target: `epic/49-contract-as-code`",
    ].join("\n");
  const fingerprint = semanticIssueFingerprint(body, title);
  const readinessComment = {
    body: [
      "<!-- keiko-native-readiness -->",
      "- Status: `accepted`",
      "- Contract version: `v5`",
      `- Fingerprint: \`${fingerprint}\``,
    ].join("\n"),
    id: 500,
    user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
  };
  return {
    listChecks: async () =>
      page([
        {
          app: { id: 15368, slug: "github-actions" },
          conclusion: "success",
          head_sha: head,
          id: 100,
          name: "ci",
          pull_requests: [],
          status: "completed",
        },
      ]),
    listCommitStatuses: async () =>
      page([
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
    listConversations: async () => page([]),
    listFindings: async () => page([]),
    listIssueComments: async ({ issue, page: number }) => {
      if (issue === 150) return page([auditComment()]);
      return number === 1 ? page([], 2) : page([readinessComment]);
    },
    listTargetRules: async () =>
      page([
        {
          bypassActors: [],
          controls: {
            deletionBlocked: true,
            forcePushBlocked: true,
            pullRequestRequired: true,
            requiredSignatures: true,
            requiredStatusChecks: { strict: true },
          },
          enforcement: "active",
          id: 49,
          target,
        },
      ]),
    merge: async () => ({
      body: { merged: true, sha: "4".repeat(40) },
      status: 200,
    }),
    readIssue: async () => ({
      body,
      labels: [{ name: "status: ready for human review" }],
      number: 50,
      state: "open",
      title,
    }),
    readPermission: async () => ({
      bypass: false,
      permission: "maintain",
    }),
    readPolicy: async () => overrides.policy,
    readPullRequest: async () => ({
      base: { ref: target, sha: base },
      draft: false,
      head: {
        ref: "codex/50-inert-epic-merge-guard-v5",
        sha: head,
        tree: headTree,
      },
      issue: 50,
      mergeable: true,
      number: 150,
      state: "open",
    }),
    readRef: async ({ ref }) => ({
      sha: ref === target ? base : head,
    }),
    ...overrides,
  };
}
