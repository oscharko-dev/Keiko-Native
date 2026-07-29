import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createRecordEnvelope,
  digestAuxiliaryIdentity,
  encodeAuxiliaryPreimage,
  parseRecordEnvelope,
} from "./lifecycle-record-protocol.mjs";
import {
  lifecycleAnchorArtifactName,
  lifecycleAnchorSubject,
  publishLifecycleRecord,
  verifyLifecycleRecordTuple,
} from "./lifecycle-record-auth.mjs";

const repository = "oscharko-dev/Keiko-Native";
const commit = "a".repeat(40);
const sha = (digit) => digit.repeat(64);
const workflowPath = ".github/workflows/issue-lifecycle.yml";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function recordBody() {
  return createRecordEnvelope("generation-request", {
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
    generation_bytes_sha256: sha("1"),
    generation_identity: sha("2"),
    attempt: 1,
    request_identity: sha("3"),
    request_payload_digest: sha("4"),
    expected_producers: ["issue-contract-current"],
    source_observation_identity: sha("5"),
    predecessor_comment_id: null,
    predecessor_record_digest: null,
    workflow_path: workflowPath,
    workflow_run_id: 10,
    workflow_run_attempt: 1,
    protected_dev_sha: commit,
    recorded_at: "2026-07-28T20:00:00Z",
  });
}

function createProvider(body = recordBody()) {
  const comment = {
    id: 100,
    body,
    author: { login: "github-actions[bot]", id: 41898282, type: "Bot" },
    performedViaGithubApp: { id: 15368 },
  };
  let artifact;
  let attestation = {};
  const buildArtifact = () => {
    const parsed = parseRecordEnvelope(comment.body);
    const fields = {
      repository,
      issue_number: 51,
      record_type: parsed.recordType,
      record_digest: parsed.recordDigest,
      comment_id: comment.id,
      comment_body_sha256: digest(Buffer.from(comment.body, "utf8")),
      generation_identity: parsed.fields.generation_identity,
      attempt: parsed.fields.attempt,
      workflow_path: workflowPath,
      workflow_run_id: 10,
      workflow_run_attempt: 1,
      protected_dev_sha: commit,
    };
    const bytes = encodeAuxiliaryPreimage("artifact anchor", fields);
    const anchorIdentity = digestAuxiliaryIdentity("artifact anchor", fields);
    artifact = {
      id: 7,
      name: lifecycleAnchorArtifactName(51),
      immutable: true,
      expired: false,
      anchorIdentity,
      writerJobId: 11,
      fields,
      bytes,
    };
    attestation = {
      verified: true,
      subject: {
        name: lifecycleAnchorSubject(fields),
        digest: `sha256:${anchorIdentity}`,
      },
      claims: {
        repository,
        job_workflow_ref: `${repository}/${workflowPath}@refs/heads/dev`,
        ref: "refs/heads/dev",
        sha: commit,
        run_id: 10,
        run_attempt: 1,
        iss: "https://token.actions.githubusercontent.com",
      },
    };
  };
  buildArtifact();
  const provider = {
    state: { artifact, attestation, comment },
    async getComment() {
      return structuredClone(provider.state.comment);
    },
    async createComment({ body: nextBody }) {
      provider.state.comment.body = nextBody;
      buildArtifact();
      return { id: 100 };
    },
    async uploadArtifact(input) {
      provider.state.artifact = {
        ...provider.state.artifact,
        name: input.name,
        immutable: input.immutable,
        anchorIdentity: input.anchorIdentity,
        bytes: Buffer.from(input.file.bytes),
      };
      return { id: 7 };
    },
    async createAttestation() {
      return { id: 8 };
    },
    async getArtifactForComment() {
      return structuredClone(provider.state.artifact);
    },
    async downloadArtifact() {
      const value = provider.state.artifact;
      return {
        files: [
          { name: "artifact-anchor.bin", bytes: Buffer.from(value.bytes) },
        ],
        digest: `sha256:${digest(value.bytes)}`,
      };
    },
    async getWorkflowRun() {
      return {
        id: 10,
        attempt: 1,
        workflowPath,
        ref: "refs/heads/dev",
        headSha: commit,
      };
    },
    async getWorkflowJob() {
      return { id: 11, runId: 10, workflowPath };
    },
    async isCommitReachableFromDev() {
      return true;
    },
    async listAttestations() {
      return [{}];
    },
    async verifyAttestation() {
      return structuredClone(provider.state.attestation);
    },
  };
  return provider;
}

test("authenticates an exact stable comment/anchor/attestation/run tuple", async () => {
  const result = await verifyLifecycleRecordTuple({
    provider: createProvider(),
    repository,
    issueNumber: 51,
    commentId: 100,
  });
  assert.equal(result.parsed.recordType, "generation-request");
  assert.equal(
    result.artifact.anchorIdentity,
    result.verified.subject.digest.slice(7),
  );
});

test("publishes comment, exact single-file anchor, attestation, and rereads", async () => {
  const provider = createProvider();
  const result = await publishLifecycleRecord({
    provider,
    repository,
    issueNumber: 51,
    recordBody: recordBody(),
  });
  assert.equal(result.comment.id, 100);
  assert.equal(provider.state.artifact.name, lifecycleAnchorArtifactName(51));
});

test("rejects wrong bot, App, workflow ref, or unreachable dev commit", async () => {
  const cases = [
    (provider) => {
      provider.state.comment.author.id = 1;
    },
    (provider) => {
      provider.state.comment.performedViaGithubApp.id = 1;
    },
    (provider) => {
      provider.getWorkflowRun = async () => ({
        id: 10,
        attempt: 1,
        workflowPath,
        ref: "refs/heads/topic",
        headSha: commit,
      });
    },
    (provider) => {
      provider.isCommitReachableFromDev = async () => false;
    },
  ];
  for (const mutate of cases) {
    const provider = createProvider();
    mutate(provider);
    await assert.rejects(
      verifyLifecycleRecordTuple({
        provider,
        repository,
        issueNumber: 51,
        commentId: 100,
      }),
      /record-(?:author-unauthenticated|workflow-run-mismatch|protected-commit-unreachable)/u,
    );
  }
});

test("rejects a caller run even when its reusable-workflow reference matches", async () => {
  const provider = createProvider();
  provider.getWorkflowRun = async () => ({
    id: 10,
    attempt: 1,
    workflowPath: ".github/workflows/lifecycle-wakeup-dispatch.yml",
    referencedWorkflows: [
      {
        path: workflowPath,
        ref: "refs/heads/dev",
        sha: commit,
      },
    ],
    ref: "refs/heads/dev",
    headSha: commit,
  });
  provider.getWorkflowJob = async () => ({
    id: 11,
    runId: 10,
    workflowPath: ".github/workflows/lifecycle-wakeup-dispatch.yml",
  });

  await assert.rejects(
    verifyLifecycleRecordTuple({
      provider,
      repository,
      issueNumber: 51,
      commentId: 100,
    }),
    { code: "record-workflow-run-mismatch" },
  );
});

test("rejects changed bodies, artifacts, and non-exact attestations", async () => {
  for (const mutate of [
    (provider) => {
      provider.state.artifact.bytes = Buffer.from("wrong");
    },
    (provider) => {
      provider.state.artifact.expired = true;
    },
    (provider) => {
      provider.state.attestation.claims.extra = "authority";
    },
    (provider) => {
      provider.listAttestations = async () => [{}, {}];
    },
  ]) {
    const provider = createProvider();
    mutate(provider);
    await assert.rejects(
      verifyLifecycleRecordTuple({
        provider,
        repository,
        issueNumber: 51,
        commentId: 100,
      }),
      /record-(?:artifact|attestation)/u,
    );
  }
});

test("rejects an unstable final tuple reread", async () => {
  const provider = createProvider();
  let reads = 0;
  const original = provider.getWorkflowRun;
  provider.getWorkflowRun = async () => {
    reads += 1;
    const run = await original();
    return { ...run, conclusion: reads === 1 ? "success" : "failure" };
  };
  await assert.rejects(
    verifyLifecycleRecordTuple({
      provider,
      repository,
      issueNumber: 51,
      commentId: 100,
    }),
    { code: "record-tuple-reread-unstable" },
  );
});
