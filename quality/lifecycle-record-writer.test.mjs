import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRecordEnvelope } from "./lifecycle-record-protocol.mjs";
import {
  decodeLifecycleRecordPlan,
  prepareLifecycleRecordPublication,
  verifyLifecycleRecordPublication,
} from "./lifecycle-record-writer.mjs";

const repository = "oscharko-dev/Keiko-Native";
const commit = "a".repeat(40);
const digest = "1".repeat(64);

function recordBody() {
  return createRecordEnvelope("generation-request", {
    record_type: "generation-request",
    schema_version: 1,
    digest_algorithm: "sha-256",
    digest_domain: "keiko-native.lifecycle-record.generation-request",
    repository,
    issue_number: 51,
    pull_request_number: 130,
    exact_head_sha: commit,
    exact_target: "dev",
    lane: "normal",
    publication_submode: "not-applicable",
    generation_schema: 1,
    generation_bytes_sha256: digest,
    generation_identity: digest,
    attempt: 1,
    request_identity: "2".repeat(64),
    request_payload_digest: "3".repeat(64),
    expected_producers: ["issue-contract-current", "pr-contract"],
    source_observation_identity: "4".repeat(64),
    predecessor_comment_id: null,
    predecessor_record_digest: null,
    workflow_path: ".github/workflows/issue-lifecycle.yml",
    workflow_run_id: 10,
    workflow_run_attempt: 1,
    protected_dev_sha: commit,
    recorded_at: "2026-07-28T20:00:00Z",
  });
}

function encodedPlan(overrides = {}) {
  return Buffer.from(
    JSON.stringify({
      issueNumber: 51,
      recordBody: recordBody(),
      repository,
      ...overrides,
    }),
  ).toString("base64url");
}

function comment() {
  return {
    body: recordBody(),
    id: 99,
    performed_via_github_app: { id: 15368 },
    user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
  };
}

test("publishes one canonical comment and prepares exact anchor inputs", async () => {
  const calls = [];
  const prepared = await prepareLifecycleRecordPublication({
    encodedPlan: encodedPlan(),
    outputDirectory: await mkdtemp(join(tmpdir(), "keiko-record-writer-")),
    providerRequest: async (path, options = {}) => {
      calls.push({ options, path });
      return comment();
    },
  });
  assert.deepEqual(
    calls.map(({ options }) => options.method ?? "GET"),
    ["POST", "GET"],
  );
  assert.equal(prepared.commentId, 99);
  assert.match(prepared.anchorIdentity, /^[0-9a-f]{64}$/u);
  assert.equal(prepared.artifactName, "keiko-lifecycle-anchor-v1-issue-51");
  assert.match(
    prepared.subject,
    /^keiko-native\/lifecycle-comment\/v1\/oscharko-dev\/Keiko-Native\/51\/99\//u,
  );
  assert.equal((await readFile(prepared.anchorPath)).length > 0, true);
  assert.equal(
    await readFile(prepared.checksumsPath, "utf8"),
    `${prepared.anchorIdentity}  ${prepared.subject}\n`,
  );
  await assert.rejects(
    prepareLifecycleRecordPublication({
      encodedPlan: encodedPlan(),
      outputDirectory: await mkdtemp(join(tmpdir(), "keiko-record-writer-")),
      providerRequest: async () => ({ ...comment(), id: undefined }),
    }),
    /record comment identity is invalid/u,
  );
});

test("verifies exact final provider records and rejects malformed plans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keiko-record-verify-"));
  const prepared = await prepareLifecycleRecordPublication({
    encodedPlan: encodedPlan(),
    outputDirectory: directory,
    providerRequest: async () => comment(),
  });
  const verificationCalls = [];
  const result = await verifyLifecycleRecordPublication({
    encodedPlan: encodedPlan(),
    prepared,
    providerRequest: async (path) => {
      verificationCalls.push(path);
      if (path.includes("/issues/comments/")) return comment();
      if (path.includes("/artifacts?"))
        return {
          artifacts: [
            {
              expired: false,
              name: prepared.artifactName,
              workflow_run: { id: 10 },
            },
          ],
        };
      if (path.includes("/attestations/")) return { attestations: [{}] };
      return {
        event: "issues",
        head_branch: "dev",
        head_sha: commit,
        id: 10,
        path: ".github/workflows/lifecycle-wakeup.yml",
        referenced_workflows: [
          ".github/workflows/issue-lifecycle.yml",
          ".github/workflows/contract-publication.yml",
          ".github/workflows/pr-contract.yml",
        ].map((workflowPath) => ({
          path: `${repository}/${workflowPath}@${commit}`,
          ref: "refs/heads/dev",
          sha: commit,
        })),
        run_attempt: 1,
      };
    },
  });
  assert.equal(result.commentId, 99);
  assert.equal(result.recordDigest.length, 64);
  assert.equal(
    verificationCalls.find((path) => path.includes("/attestations/")),
    `/repos/${repository}/attestations/sha256:${prepared.anchorIdentity}`,
  );
  assert.throws(
    () => decodeLifecycleRecordPlan(encodedPlan({ repository: "evil/repo" })),
    /record plan is invalid/u,
  );
  assert.throws(
    () => decodeLifecycleRecordPlan("not-base64"),
    /record plan is malformed/u,
  );
  let providerCalls = 0;
  await assert.rejects(
    verifyLifecycleRecordPublication({
      encodedPlan: encodedPlan(),
      prepared: { ...prepared, commentId: "../attacker" },
      providerRequest: async () => {
        providerCalls += 1;
      },
    }),
    /prepared lifecycle publication is invalid/u,
  );
  assert.equal(providerCalls, 0);
  await assert.rejects(
    verifyLifecycleRecordPublication({
      encodedPlan: encodedPlan(),
      prepared: { ...prepared, anchorIdentity: "0".repeat(64) },
      providerRequest: async () => {
        providerCalls += 1;
      },
    }),
    /prepared lifecycle publication identity mismatch/u,
  );
  assert.equal(providerCalls, 0);
});

test("rejects unknown and non-protected writer run event/ref combinations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keiko-record-invalid-run-"));
  const prepared = await prepareLifecycleRecordPublication({
    encodedPlan: encodedPlan(),
    outputDirectory: directory,
    providerRequest: async () => comment(),
  });
  for (const run of [
    { event: "push", head_branch: "dev", head_sha: commit },
    {
      event: "issues",
      head_branch: "codex/unprotected",
      head_sha: commit,
    },
    {
      event: "pull_request_target",
      head_branch: "codex/unprotected",
      head_sha: "not-a-commit",
    },
  ])
    await assert.rejects(
      verifyLifecycleRecordPublication({
        encodedPlan: encodedPlan(),
        prepared,
        providerRequest: async (path) => {
          if (path.includes("/issues/comments/")) return comment();
          if (path.includes("/artifacts?"))
            return {
              artifacts: [
                {
                  expired: false,
                  name: prepared.artifactName,
                  workflow_run: { id: 10 },
                },
              ],
            };
          if (path.includes("/attestations/")) return { attestations: [{}] };
          return {
            ...run,
            id: 10,
            path: ".github/workflows/lifecycle-wakeup.yml",
            run_attempt: 1,
          };
        },
      }),
      /record writer run mismatch/u,
    );
});

test("accepts pull_request_target REST source-branch metadata only with protected record evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keiko-record-pr-target-"));
  const prepared = await prepareLifecycleRecordPublication({
    encodedPlan: encodedPlan(),
    outputDirectory: directory,
    providerRequest: async () => comment(),
  });
  const result = await verifyLifecycleRecordPublication({
    encodedPlan: encodedPlan(),
    prepared,
    providerRequest: async (path) => {
      if (path.includes("/issues/comments/")) return comment();
      if (path.includes("/artifacts?"))
        return {
          artifacts: [
            {
              expired: false,
              name: prepared.artifactName,
              workflow_run: { id: 10 },
            },
          ],
        };
      if (path.includes("/attestations/")) return { attestations: [{}] };
      return {
        event: "pull_request_target",
        head_branch: "codex/160-protected-provenance",
        head_sha: "b".repeat(40),
        id: 10,
        path: ".github/workflows/lifecycle-wakeup.yml",
        referenced_workflows: [
          ".github/workflows/issue-lifecycle.yml",
          ".github/workflows/contract-publication.yml",
          ".github/workflows/pr-contract.yml",
        ].map((workflowPath) => ({
          path: `${repository}/${workflowPath}@${commit}`,
          ref: "refs/heads/dev",
          sha: commit,
        })),
        run_attempt: 1,
      };
    },
  });
  assert.equal(result.commentId, 99);
});

test("rejects pull_request_target publication with a non-exact static workflow graph", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keiko-record-pr-graph-"));
  const prepared = await prepareLifecycleRecordPublication({
    encodedPlan: encodedPlan(),
    outputDirectory: directory,
    providerRequest: async () => comment(),
  });
  await assert.rejects(
    verifyLifecycleRecordPublication({
      encodedPlan: encodedPlan(),
      prepared,
      providerRequest: async (path) => {
        if (path.includes("/issues/comments/")) return comment();
        if (path.includes("/artifacts?"))
          return {
            artifacts: [
              {
                expired: false,
                name: prepared.artifactName,
                workflow_run: { id: 10 },
              },
            ],
          };
        if (path.includes("/attestations/")) return { attestations: [{}] };
        return {
          event: "pull_request_target",
          head_branch: "codex/160-protected-provenance",
          head_sha: "b".repeat(40),
          id: 10,
          path: ".github/workflows/lifecycle-wakeup.yml",
          referenced_workflows: [
            {
              path: `${repository}/.github/workflows/issue-lifecycle.yml@${commit}`,
              ref: "refs/heads/dev",
              sha: commit,
            },
          ],
          run_attempt: 1,
        };
      },
    }),
    /record writer run mismatch/u,
  );
});

test("rejects a pull_request_target writer run response with the wrong run identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keiko-record-pr-run-id-"));
  const prepared = await prepareLifecycleRecordPublication({
    encodedPlan: encodedPlan(),
    outputDirectory: directory,
    providerRequest: async () => comment(),
  });
  await assert.rejects(
    verifyLifecycleRecordPublication({
      encodedPlan: encodedPlan(),
      prepared,
      providerRequest: async (path) => {
        if (path.includes("/issues/comments/")) return comment();
        if (path.includes("/artifacts?"))
          return {
            artifacts: [
              {
                expired: false,
                name: prepared.artifactName,
                workflow_run: { id: 10 },
              },
            ],
          };
        if (path.includes("/attestations/")) return { attestations: [{}] };
        return {
          event: "pull_request_target",
          head_branch: "codex/160-protected-provenance",
          head_sha: "b".repeat(40),
          id: 999,
          path: ".github/workflows/lifecycle-wakeup.yml",
          referenced_workflows: [
            ".github/workflows/issue-lifecycle.yml",
            ".github/workflows/contract-publication.yml",
            ".github/workflows/pr-contract.yml",
          ].map((workflowPath) => ({
            path: `${repository}/${workflowPath}@${commit}`,
            ref: "refs/heads/dev",
            sha: commit,
          })),
          run_attempt: 1,
        };
      },
    }),
    /record writer run mismatch/u,
  );
});

test("rejects a non-PR writer run whose event SHA differs from protected dev", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keiko-record-event-sha-"));
  const prepared = await prepareLifecycleRecordPublication({
    encodedPlan: encodedPlan(),
    outputDirectory: directory,
    providerRequest: async () => comment(),
  });
  await assert.rejects(
    verifyLifecycleRecordPublication({
      encodedPlan: encodedPlan(),
      prepared,
      providerRequest: async (path) => {
        if (path.includes("/issues/comments/")) return comment();
        if (path.includes("/artifacts?"))
          return {
            artifacts: [
              {
                expired: false,
                name: prepared.artifactName,
                workflow_run: { id: 10 },
              },
            ],
          };
        if (path.includes("/attestations/")) return { attestations: [{}] };
        return {
          event: "issues",
          head_branch: "dev",
          head_sha: "b".repeat(40),
          id: 10,
          path: ".github/workflows/lifecycle-wakeup.yml",
          referenced_workflows: [
            ".github/workflows/issue-lifecycle.yml",
            ".github/workflows/contract-publication.yml",
            ".github/workflows/pr-contract.yml",
          ].map((workflowPath) => ({
            path: `${repository}/${workflowPath}@${commit}`,
            ref: "refs/heads/dev",
            sha: commit,
          })),
          run_attempt: 1,
        };
      },
    }),
    /record writer run mismatch/u,
  );
});

test("workflow writer transport is pinned and activation remains disabled", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/issue-lifecycle.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /KEIKO_ISSUE_LIFECYCLE_ACTIVATION: disabled/u);
  assert.match(
    workflow,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u,
  );
  assert.match(
    workflow,
    /actions\/attest@a1948c3f048ba23858d222213b7c278aabede763/u,
  );
  assert.doesNotMatch(
    workflow,
    /KEIKO_ISSUE_LIFECYCLE_ACTIVATION:\s*(?:enabled|probe-only)/u,
  );
});
