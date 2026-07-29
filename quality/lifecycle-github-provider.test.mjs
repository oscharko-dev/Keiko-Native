import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createLifecycleGithubProvider,
  verifyLifecycleAttestationBundle,
} from "./lifecycle-github-provider.mjs";

const target = "b".repeat(64);
const command = `/keiko-native lifecycle-recovery v1 target=sha256:${target}`;
const restComment = {
  body: command,
  created_at: "2026-07-29T10:00:00Z",
  id: 101,
  issue_url: "https://api.github.com/repos/oscharko-dev/Keiko-Native/issues/51",
  node_id: "IC_kwDOA",
  updated_at: "2026-07-29T10:00:00Z",
  user: { id: 159039192, login: "Niko4417", type: "User" },
};
const graphComment = {
  __typename: "IssueComment",
  author: {
    __typename: "User",
    databaseId: 159039192,
    login: "Niko4417",
  },
  body: command,
  createdAt: "2026-07-29T10:00:00Z",
  databaseId: 101,
  editor: null,
  includesCreatedEdit: false,
  issue: { number: 51 },
  lastEditedAt: null,
  repository: {
    databaseId: 123,
    nameWithOwner: "oscharko-dev/Keiko-Native",
  },
  updatedAt: "2026-07-29T10:00:00Z",
};

test("authenticates a recovery command through exactly two REST/GraphQL/permission reads", async () => {
  const calls = [];
  const provider = createLifecycleGithubProvider({
    binary: async () => {
      throw new Error("binary access is unexpected");
    },
    graphql: async (query, variables) => {
      calls.push(["graphql", variables]);
      assert.match(query, /LifecycleRecoveryComment/u);
      return { data: { node: graphComment } };
    },
    json: async (path) => {
      calls.push(["rest", path]);
      if (path.endsWith("/issues/comments/101")) return restComment;
      if (path.endsWith("/collaborators/Niko4417/permission"))
        return {
          permission: "admin",
          user: { login: "Niko4417" },
        };
      throw new Error(`unexpected route: ${path}`);
    },
  });
  const result = await provider.authenticateRecoveryComment({
    commentId: 101,
    issueNumber: 51,
  });
  assert.equal(result.recoveryTargetIdentity, target);
  assert.match(result.identity, /^[0-9a-f]{64}$/u);
  assert.equal(provider.requestCount(), 6);
  assert.equal(calls.length, 6);
});

test("rejects edited recovery commands and stops early for ordinary comments", async () => {
  const ordinary = {
    ...restComment,
    body: "ordinary issue comment",
  };
  const ordinaryGraph = {
    ...graphComment,
    body: ordinary.body,
  };
  const provider = createLifecycleGithubProvider({
    binary: async () => Buffer.alloc(0),
    graphql: async () => ({ data: { node: ordinaryGraph } }),
    json: async (path) =>
      path.endsWith("/permission")
        ? { permission: "admin", user: { login: "Niko4417" } }
        : ordinary,
  });
  assert.equal(
    await provider.authenticateRecoveryComment({
      commentId: 101,
      issueNumber: 51,
    }),
    null,
  );
  assert.equal(provider.requestCount(), 1);

  const editedProvider = createLifecycleGithubProvider({
    binary: async () => Buffer.alloc(0),
    graphql: async () => ({
      data: {
        node: {
          ...graphComment,
          lastEditedAt: "2026-07-29T10:00:01Z",
        },
      },
    }),
    json: async (path) =>
      path.endsWith("/permission")
        ? { permission: "admin", user: { login: "Niko4417" } }
        : restComment,
  });
  await assert.rejects(
    editedProvider.authenticateRecoveryComment({
      commentId: 101,
      issueNumber: 51,
    }),
    /recovery-comment-unauthenticated/u,
  );
});

test("selects the lowest eligible fallback only after stable bounded discovery", async () => {
  const graphCalls = [];
  const provider = createLifecycleGithubProvider({
    binary: async () => Buffer.alloc(0),
    graphql: async (query, variables) => {
      graphCalls.push(variables);
      assert.match(query, /LifecycleRecoveryWindow/u);
      return {
        data: {
          repository: {
            databaseId: 123,
            issue: {
              comments: {
                nodes: [
                  graphComment,
                  {
                    ...graphComment,
                    author: {
                      __typename: "User",
                      databaseId: 1,
                      login: "attacker",
                    },
                    databaseId: 100,
                  },
                ],
                pageInfo: {
                  hasPreviousPage: false,
                  startCursor: "cursor",
                },
              },
            },
            nameWithOwner: "oscharko-dev/Keiko-Native",
          },
        },
      };
    },
    json: async (path) => {
      assert.match(path, /collaborators\/Niko4417\/permission$/u);
      return { permission: "maintain", user: { login: "Niko4417" } };
    },
  });
  assert.equal(
    await provider.discoverRecoveryComment({ issueNumber: 51 }),
    101,
  );
  assert.equal(graphCalls.length, 2);
  assert.equal(provider.requestCount(), 4);
});

test("cryptographically verifies the exact bundle with closed signer and source flags", async () => {
  const bundle = { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" };
  const calls = [];
  const claims = await verifyLifecycleAttestationBundle({
    anchorBytes: Buffer.from("exact anchor"),
    attestation: { bundle },
    execute: async (commandName, argumentsList, options) => {
      calls.push({ argumentsList, commandName, options });
      assert.equal(commandName, "gh");
      assert.deepEqual(
        JSON.parse(
          await readFile(
            argumentsList[argumentsList.indexOf("--bundle") + 1],
            "utf8",
          ),
        ),
        bundle,
      );
      return {
        stdout: JSON.stringify([
          {
            verificationResult: {
              signature: {
                certificate: {
                  buildConfigDigest: "a".repeat(40),
                  buildConfigURI:
                    "https://github.com/oscharko-dev/Keiko-Native/.github/workflows/lifecycle-wakeup.yml@refs/heads/dev",
                  buildSignerDigest: "a".repeat(40),
                  buildSignerURI:
                    "https://github.com/oscharko-dev/Keiko-Native/.github/workflows/issue-lifecycle.yml@refs/heads/dev",
                  issuer: "https://token.actions.githubusercontent.com",
                  runInvocationURI:
                    "https://github.com/oscharko-dev/Keiko-Native/actions/runs/41/attempts/2",
                  sourceRepositoryDigest: "a".repeat(40),
                  sourceRepositoryRef: "refs/heads/dev",
                  sourceRepositoryURI:
                    "https://github.com/oscharko-dev/Keiko-Native",
                },
              },
            },
          },
        ]),
      };
    },
    fields: {
      protected_dev_sha: "a".repeat(40),
      workflow_run_attempt: 2,
      workflow_run_id: 41,
      workflow_path: ".github/workflows/issue-lifecycle.yml",
    },
  });
  assert.deepEqual(claims, {
    iss: "https://token.actions.githubusercontent.com",
    job_workflow_ref:
      "oscharko-dev/Keiko-Native/.github/workflows/issue-lifecycle.yml@refs/heads/dev",
    job_workflow_sha: "a".repeat(40),
    ref: "refs/heads/dev",
    repository: "oscharko-dev/Keiko-Native",
    run_attempt: 2,
    run_id: 41,
    sha: "a".repeat(40),
    workflow_ref:
      "oscharko-dev/Keiko-Native/.github/workflows/lifecycle-wakeup.yml@refs/heads/dev",
    workflow_sha: "a".repeat(40),
  });
  assert.equal(calls.length, 1);
  const argumentsList = calls[0].argumentsList;
  for (const pair of [
    ["--repo", "oscharko-dev/Keiko-Native"],
    [
      "--signer-workflow",
      "oscharko-dev/Keiko-Native/.github/workflows/issue-lifecycle.yml",
    ],
    ["--signer-digest", "a".repeat(40)],
    ["--source-ref", "refs/heads/dev"],
    ["--source-digest", "a".repeat(40)],
  ])
    assert.equal(argumentsList[argumentsList.indexOf(pair[0]) + 1], pair[1]);
  assert.ok(argumentsList.includes("--deny-self-hosted-runners"));
  assert.ok(argumentsList.includes("--no-public-good"));
});
