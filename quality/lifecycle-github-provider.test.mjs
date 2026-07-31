import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createLifecycleGithubProvider,
  verifyLifecycleAttestationBundle,
} from "./lifecycle-github-provider.mjs";
import {
  createRecordEnvelope,
  digestAuxiliaryIdentity,
  encodeAuxiliaryPreimage,
  parseRecordEnvelope,
} from "./lifecycle-record-protocol.mjs";

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

function anchorInventoryFixture(anchorBytes) {
  const repository = "oscharko-dev/Keiko-Native";
  const issueNumber = 141;
  const name = `keiko-lifecycle-anchor-v1-issue-${issueNumber}`;
  const provider = createLifecycleGithubProvider({
    binary: async (path) => {
      assert.equal(path, `/repos/${repository}/actions/artifacts/701/zip`);
      return storedZip("artifact-anchor.bin", anchorBytes);
    },
    graphql: async () => {
      throw new Error("GraphQL access is unexpected");
    },
    json: async (path) => {
      assert.equal(
        path,
        `/repos/${repository}/actions/artifacts?name=${name}&per_page=100&page=1`,
      );
      return {
        artifacts: [
          {
            expired: false,
            id: 701,
            name,
            workflow_run: { id: 77 },
          },
        ],
        total_count: 1,
      };
    },
  });
  return { issueNumber, name, provider };
}

const identityFields = {
  repository: "oscharko-dev/Keiko-Native",
  issue_number: 141,
  record_type: "generation-request",
  record_digest: "1".repeat(64),
  comment_id: 501,
  comment_body_sha256: "2".repeat(64),
  generation_identity: "3".repeat(64),
  attempt: 1,
  workflow_path: ".github/workflows/issue-lifecycle.yml",
  workflow_run_id: 77,
  workflow_run_attempt: 1,
  protected_dev_sha: "a".repeat(40),
};

test("derives the unchanged identity from canonical writer-produced anchor bytes", async () => {
  const anchorBytes = encodeAuxiliaryPreimage(
    "artifact anchor",
    identityFields,
  );
  const { issueNumber, name, provider } = anchorInventoryFixture(anchorBytes);
  assert.deepEqual(await provider.listAnchorArtifacts({ issueNumber, name }), {
    complete: true,
    items: [
      {
        anchorIdentity: digestAuxiliaryIdentity(
          "artifact anchor",
          identityFields,
        ),
        commentId: identityFields.comment_id,
        expired: false,
        id: 701,
        immutable: true,
        name,
        workflowRunId: identityFields.workflow_run_id,
      },
    ],
  });
  assert.equal(provider.requestCount(), 2);
});

test("validates canonical anchor bytes before deriving their identity", async () => {
  const anchorBytes = encodeAuxiliaryPreimage(
    "artifact anchor",
    identityFields,
  );
  const { issueNumber, name, provider } = anchorInventoryFixture(
    Buffer.concat([anchorBytes, Buffer.from("hostile suffix")]),
  );
  await assert.rejects(
    provider.listAnchorArtifacts({ issueNumber, name }),
    /trailing bytes/u,
  );
  assert.equal(provider.requestCount(), 2);
});

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

test("qualifies validated internal attestation identities only at the outbound route", async () => {
  const jsonCalls = [];
  const provider = createLifecycleGithubProvider({
    binary: async () => {
      throw new Error("binary access is unexpected");
    },
    graphql: async () => {
      throw new Error("GraphQL access is unexpected");
    },
    json: async (path) => {
      jsonCalls.push(path);
      return { attestations: [] };
    },
  });
  const identity = "c".repeat(64);
  await assert.rejects(
    provider.listAttestations({ subjectDigest: identity }),
    /record-attestation-inventory-invalid/u,
  );
  assert.deepEqual(jsonCalls, [
    `/repos/oscharko-dev/Keiko-Native/attestations/sha256:${identity}`,
  ]);
  assert.equal(provider.requestCount(), 1);
});

test("rejects invalid internal attestation identities without consuming provider requests", async () => {
  for (const subjectDigest of [
    "",
    "c".repeat(63),
    "c".repeat(65),
    "C".repeat(64),
    `sha256:${"c".repeat(64)}`,
    `sha512:${"c".repeat(64)}`,
    `sha256%3A${"c".repeat(64)}`,
    `${"c".repeat(64)}/..`,
    `${"c".repeat(64)}?page=1`,
    `${"c".repeat(64)}#fragment`,
  ]) {
    const jsonCalls = [];
    const provider = createLifecycleGithubProvider({
      binary: async () => {
        throw new Error("binary access is unexpected");
      },
      graphql: async () => {
        throw new Error("GraphQL access is unexpected");
      },
      json: async (...arguments_) => {
        jsonCalls.push(arguments_);
        return { attestations: [] };
      },
    });
    await assert.rejects(
      provider.listAttestations({ subjectDigest }),
      /record-attestation-inventory-invalid/u,
    );
    assert.equal(provider.requestCount(), 0, subjectDigest);
    assert.equal(jsonCalls.length, 0, subjectDigest);
  }
});

test("qualifies both stable orphan-recovery attestation absence reads", async () => {
  const repository = "oscharko-dev/Keiko-Native";
  const protectedDevSha = "a".repeat(40);
  const body = createRecordEnvelope("generation-request", {
    record_type: "generation-request",
    schema_version: 1,
    digest_algorithm: "sha-256",
    digest_domain: "keiko-native.lifecycle-record.generation-request",
    repository,
    issue_number: 51,
    pull_request_number: null,
    exact_head_sha: null,
    exact_target: null,
    lane: "normal",
    publication_submode: "not-applicable",
    generation_schema: 1,
    generation_bytes_sha256: "1".repeat(64),
    generation_identity: "2".repeat(64),
    attempt: 1,
    request_identity: "3".repeat(64),
    request_payload_digest: "4".repeat(64),
    expected_producers: ["issue-contract-current"],
    source_observation_identity: "5".repeat(64),
    predecessor_comment_id: null,
    predecessor_record_digest: null,
    workflow_path: ".github/workflows/issue-lifecycle.yml",
    workflow_run_id: 77,
    workflow_run_attempt: 1,
    protected_dev_sha: protectedDevSha,
    recorded_at: "2026-07-29T12:00:00Z",
  });
  const parsed = parseRecordEnvelope(body);
  const comment = {
    body,
    created_at: "2026-07-29T12:00:00Z",
    id: 501,
    issue_url: `https://api.github.com/repos/${repository}/issues/51`,
    node_id: "IC_orphan",
    performed_via_github_app: { id: 15368 },
    updated_at: "2026-07-29T12:00:00Z",
    user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
  };
  const commentBodySha256 = createHash("sha256")
    .update(Buffer.from(body, "utf8"))
    .digest("hex");
  const recoveryTargetIdentity = digestAuxiliaryIdentity("recovery target", {
    repository,
    issue_number: 51,
    orphan_comment_id: 501,
    orphan_comment_body_sha256: commentBodySha256,
    orphan_record_digest: parsed.recordDigest,
    last_authenticated_comment_id: null,
    last_authenticated_record_digest: null,
  });
  const anchorIdentity = digestAuxiliaryIdentity("artifact anchor", {
    repository,
    issue_number: 51,
    record_type: parsed.recordType,
    record_digest: parsed.recordDigest,
    comment_id: 501,
    comment_body_sha256: commentBodySha256,
    generation_identity: parsed.fields.generation_identity,
    attempt: parsed.fields.attempt,
    workflow_path: parsed.fields.workflow_path,
    workflow_run_id: parsed.fields.workflow_run_id,
    workflow_run_attempt: parsed.fields.workflow_run_attempt,
    protected_dev_sha: parsed.fields.protected_dev_sha,
  });
  const attestationPaths = [];
  const provider = createLifecycleGithubProvider({
    binary: async () => {
      throw new Error("binary access is unexpected");
    },
    graphql: async () => {
      throw new Error("GraphQL access is unexpected");
    },
    json: async (path) => {
      if (path.includes("/attestations/")) {
        attestationPaths.push(path);
        return { attestations: [] };
      }
      if (path.includes("/issues/51/comments?")) return [comment];
      if (path.includes("/actions/artifacts?"))
        return { artifacts: [], total_count: 0 };
      if (path.endsWith("/issues/comments/501")) return comment;
      if (path.endsWith("/actions/runs/77"))
        return {
          conclusion: "failure",
          head_branch: "dev",
          id: 77,
          path: "/.github/workflows/lifecycle-wakeup.yml",
          referenced_workflows: [
            {
              path: ".github/workflows/issue-lifecycle.yml",
              ref: "refs/heads/dev",
              sha: protectedDevSha,
            },
          ],
          run_attempt: 1,
        };
      if (path.endsWith(`/compare/${protectedDevSha}...dev`))
        return { status: "ahead" };
      throw new Error(`unexpected route: ${path}`);
    },
  });
  const result = await provider.loadRecoveryOrphan({
    issueNumber: 51,
    recoveryTargetIdentity,
  });
  assert.match(recoveryTargetIdentity, /^[0-9a-f]{64}$/u);
  assert.match(anchorIdentity, /^[0-9a-f]{64}$/u);
  assert.equal(result.first.record_digest, parsed.recordDigest);
  assert.deepEqual(result.first, result.second);
  assert.deepEqual(attestationPaths, [
    `/repos/${repository}/attestations/sha256:${anchorIdentity}`,
    `/repos/${repository}/attestations/sha256:${anchorIdentity}`,
  ]);
  assert.equal(provider.requestCount(), 12);
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

test("bounds checkpoint predecessor traversal to the live suffix", async () => {
  const bodies = new Map();
  let predecessorId = null;
  let predecessorDigest = null;
  for (let id = 1; id <= 17; id += 1) {
    const common = {
      schema_version: 1,
      digest_algorithm: "sha-256",
      repository: "oscharko-dev/Keiko-Native",
      issue_number: 51,
      pull_request_number: null,
      exact_head_sha: null,
      exact_target: "dev",
      generation_identity: "2".repeat(64),
      attempt: 1,
      request_identity: "3".repeat(64),
      predecessor_comment_id: predecessorId,
      predecessor_record_digest: predecessorDigest,
      protected_dev_sha: "a".repeat(40),
      recorded_at: "2026-07-29T12:00:00Z",
    };
    const body =
      id === 17
        ? createRecordEnvelope("transition-read-back", {
            record_type: "transition-read-back",
            digest_domain: "keiko-native.lifecycle-record.transition-read-back",
            ...common,
            phase_fence_comment_id: 20,
            phase_fence_digest: "6".repeat(64),
            source_state: "status: ready",
            desired_state: "status: ready",
            observed_state: "status: ready",
            transition_owner: "handoff",
            effect_identity: null,
            read_back_identity: "7".repeat(64),
            producer_results: [],
            checkpoint_sequence: 1,
            prior_checkpoint_comment_id: null,
            prior_checkpoint_record_digest: null,
            compacted_prefix_identity: "8".repeat(64),
            outcome: "planned",
            reason_code: "activation-disabled",
          })
        : createRecordEnvelope("generation-request", {
            record_type: "generation-request",
            digest_domain: "keiko-native.lifecycle-record.generation-request",
            ...common,
            lane: "normal",
            publication_submode: "not-applicable",
            generation_schema: 1,
            generation_bytes_sha256: "1".repeat(64),
            request_payload_digest: "4".repeat(64),
            expected_producers: ["issue-contract-current"],
            source_observation_identity: "5".repeat(64),
            workflow_path: ".github/workflows/issue-lifecycle.yml",
            workflow_run_id: 10,
            workflow_run_attempt: 1,
          });
    bodies.set(id, body);
    predecessorId = id;
    predecessorDigest = parseRecordEnvelope(body).recordDigest;
  }
  const provider = createLifecycleGithubProvider({
    binary: async () => Buffer.alloc(0),
    graphql: async () => {
      throw new Error("GraphQL access is unexpected");
    },
    json: async (path) => {
      const id = Number(path.match(/issues\/comments\/([1-9][0-9]*)$/u)?.[1]);
      return {
        body: bodies.get(id),
        created_at: "2026-07-29T12:00:00Z",
        id,
        issue_url:
          "https://api.github.com/repos/oscharko-dev/Keiko-Native/issues/51",
        node_id: `IC_${id}`,
        performed_via_github_app: { id: 15368 },
        updated_at: "2026-07-29T12:00:00Z",
        user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
      };
    },
  });
  for (let id = 1; id <= 17; id += 1)
    await provider.getComment({ commentId: id, issueNumber: 51 });
  await assert.rejects(
    provider.getCheckpointEvidence({ commentId: 17 }),
    /checkpoint-member-overflow/u,
  );
});
