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
const callerPath = ".github/workflows/lifecycle-wakeup.yml";
const producerPaths = [
  ".github/workflows/contract-publication.yml",
  ".github/workflows/pr-contract.yml",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

const staticWorkflowGraph = () =>
  [workflowPath, ...producerPaths].map((path) => ({
    path: `${repository}/${path}@${commit}`,
    ref: "refs/heads/dev",
    sha: commit,
  }));

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

function producerRecordBody(expectedProducer, producerPath, workflowJobId) {
  return createRecordEnvelope("producer-result", {
    record_type: "producer-result",
    schema_version: 1,
    digest_algorithm: "sha-256",
    digest_domain: "keiko-native.lifecycle-record.producer-result",
    repository,
    issue_number: 51,
    pull_request_number: null,
    exact_head_sha: null,
    exact_target: null,
    generation_identity: sha("1"),
    attempt: 1,
    request_identity: sha("2"),
    generation_request_comment_id: 19,
    generation_request_digest: sha("3"),
    phase_fence_comment_id: 20,
    phase_fence_digest: sha("4"),
    expected_producer: expectedProducer,
    producer_contract_version: 1,
    workflow_path: producerPath,
    workflow_id: 12,
    workflow_run_id: 10,
    workflow_run_attempt: 1,
    workflow_job_id: workflowJobId,
    result_identity: sha("5"),
    protected_dev_sha: commit,
    provider_observation_identity: sha("6"),
    conclusion: "success",
    reason_code: "ok",
    predecessor_comment_id: 19,
    predecessor_record_digest: sha("3"),
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
    const writerPath = parsed.fields.workflow_path;
    const fields = {
      repository,
      issue_number: 51,
      record_type: parsed.recordType,
      record_digest: parsed.recordDigest,
      comment_id: comment.id,
      comment_body_sha256: digest(Buffer.from(comment.body, "utf8")),
      generation_identity: parsed.fields.generation_identity,
      attempt: parsed.fields.attempt,
      workflow_path: writerPath,
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
        workflow_ref: `${repository}/${callerPath}@refs/heads/dev`,
        workflow_sha: commit,
        job_workflow_ref: `${repository}/${writerPath}@refs/heads/dev`,
        job_workflow_sha: commit,
        ref: "refs/heads/dev",
        sha: commit,
        run_id: 10,
        run_attempt: 1,
        iss: "https://token.actions.githubusercontent.com",
      },
    };
  };
  buildArtifact();
  const attestationSubjects = [];
  const provider = {
    attestationSubjects,
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
        event: "issues",
        workflowPath: callerPath,
        workflowSha: commit,
        eventSha: commit,
        headBranch: "dev",
        referencedWorkflows: staticWorkflowGraph(),
        ref: "refs/heads/dev",
        headSha: commit,
      };
    },
    async getWorkflowJob() {
      return {
        id: 11,
        runId: 10,
        workflowPath: provider.state.artifact.fields.workflow_path,
        workflowSha: commit,
      };
    },
    async isCommitReachableFromDev() {
      return true;
    },
    async listAttestations({ subjectDigest }) {
      attestationSubjects.push(subjectDigest);
      return [{}];
    },
    async verifyAttestation() {
      return structuredClone(provider.state.attestation);
    },
  };
  return provider;
}

test("authenticates an exact stable comment/anchor/attestation/run tuple", async () => {
  const provider = createProvider();
  const result = await verifyLifecycleRecordTuple({
    provider,
    repository,
    issueNumber: 51,
    commentId: 100,
  });
  assert.equal(result.parsed.recordType, "generation-request");
  assert.equal(
    result.artifact.anchorIdentity,
    result.verified.subject.digest.slice(7),
  );
  assert.equal(result.job.id, 11);
  assert.equal(result.parsed.fields.workflow_job_id, undefined);
  assert.deepEqual(provider.attestationSubjects, [
    result.artifact.anchorIdentity,
    result.artifact.anchorIdentity,
  ]);
});

test("authenticates pull_request_target source metadata through protected workflow evidence", async () => {
  const provider = createProvider();
  const original = provider.getWorkflowRun;
  provider.getWorkflowRun = async () => ({
    ...(await original()),
    event: "pull_request_target",
    eventSha: "b".repeat(40),
    headBranch: "codex/160-protected-provenance",
    ref: "codex/160-protected-provenance",
  });
  const result = await verifyLifecycleRecordTuple({
    provider,
    repository,
    issueNumber: 51,
    commentId: 100,
  });
  assert.equal(result.run.event, "pull_request_target");
  assert.equal(result.run.ref, "codex/160-protected-provenance");
});

test("rejects malformed, unknown, and unprotected caller event/ref combinations", async () => {
  for (const runOverride of [
    {
      event: "push",
      eventSha: commit,
      headBranch: "dev",
      ref: "refs/heads/dev",
    },
    {
      event: "issues",
      eventSha: "b".repeat(40),
      headBranch: "dev",
      ref: "refs/heads/dev",
    },
    {
      event: "issues",
      eventSha: commit,
      headBranch: "codex/unprotected",
      ref: "codex/unprotected",
    },
    {
      event: "pull_request_target",
      eventSha: "not-a-commit",
      headBranch: "codex/unprotected",
      ref: "codex/unprotected",
    },
  ]) {
    const provider = createProvider();
    const original = provider.getWorkflowRun;
    provider.getWorkflowRun = async () => ({
      ...(await original()),
      ...runOverride,
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
  }
});

test("authenticates the complete static referenced-workflow graph", async () => {
  const provider = createProvider();
  const original = provider.getWorkflowRun;
  provider.getWorkflowRun = async () => ({
    ...(await original()),
    referencedWorkflows: staticWorkflowGraph().reverse(),
  });
  const result = await verifyLifecycleRecordTuple({
    provider,
    repository,
    issueNumber: 51,
    commentId: 100,
  });
  assert.deepEqual(
    result.run.referencedWorkflows,
    staticWorkflowGraph().reverse(),
  );
});

test("binds both producer records to the exact writer job ID", async () => {
  for (const [expectedProducer, producerPath] of [
    ["contract-publication", producerPaths[0]],
    ["pr-contract", producerPaths[1]],
  ]) {
    const validProvider = createProvider(
      producerRecordBody(expectedProducer, producerPath, 11),
    );
    const valid = await verifyLifecycleRecordTuple({
      provider: validProvider,
      repository,
      issueNumber: 51,
      commentId: 100,
    });
    assert.equal(valid.job.id, 11);
    assert.equal(valid.parsed.fields.workflow_job_id, 11);

    const mismatchedProvider = createProvider(
      producerRecordBody(expectedProducer, producerPath, 999),
    );
    await assert.rejects(
      verifyLifecycleRecordTuple({
        provider: mismatchedProvider,
        repository,
        issueNumber: 51,
        commentId: 100,
      }),
      { code: "record-workflow-run-mismatch" },
    );

    const wrongJobProvider = createProvider(
      producerRecordBody(expectedProducer, producerPath, 11),
    );
    wrongJobProvider.getWorkflowJob = async () => ({
      id: 12,
      runId: 10,
      workflowPath: producerPath,
      workflowSha: commit,
    });
    await assert.rejects(
      verifyLifecycleRecordTuple({
        provider: wrongJobProvider,
        repository,
        issueNumber: 51,
        commentId: 100,
      }),
      { code: "record-workflow-run-mismatch" },
    );
  }
});

test("rejects producer OIDC writer path, run, and SHA mismatches", async () => {
  for (const [expectedProducer, producerPath] of [
    ["contract-publication", producerPaths[0]],
    ["pr-contract", producerPaths[1]],
  ]) {
    for (const mutate of [
      (provider) => {
        provider.state.attestation.claims.job_workflow_ref = `${repository}/${workflowPath}@refs/heads/dev`;
      },
      (provider) => {
        provider.state.attestation.claims.run_id = 999;
      },
      (provider) => {
        provider.state.attestation.claims.job_workflow_sha = "b".repeat(40);
      },
    ]) {
      const provider = createProvider(
        producerRecordBody(expectedProducer, producerPath, 11),
      );
      mutate(provider);
      await assert.rejects(
        verifyLifecycleRecordTuple({
          provider,
          repository,
          issueNumber: 51,
          commentId: 100,
        }),
        { code: "record-attestation-invalid" },
      );
    }
  }
});

test("rejects every non-exact static referenced-workflow graph", async () => {
  const wrongSha = "b".repeat(40);
  const graph = staticWorkflowGraph();
  const cases = [
    graph.slice(0, 2),
    [graph[0], graph[2]],
    [graph[1], graph[2]],
    [graph[0], graph[0], graph[2]],
    [
      ...graph,
      {
        path: `${repository}/.github/workflows/unlisted.yml@${commit}`,
        ref: "refs/heads/dev",
        sha: commit,
      },
    ],
    [{ ...graph[0], ref: "refs/heads/topic" }, graph[1], graph[2]],
    [{ ...graph[0], sha: wrongSha }, graph[1], graph[2]],
    [
      {
        ...graph[0],
        path: `${repository}/${workflowPath}@${wrongSha}`,
      },
      graph[1],
      graph[2],
    ],
    [null, graph[1], graph[2]],
    [{ ...graph[0], path: workflowPath }, graph[1], graph[2]],
    [
      {
        path: "/.github/workflows/issue-lifecycle.yml",
        ref: "dev",
        sha: commit,
      },
      graph[1],
      graph[2],
    ],
    [
      {
        ...graph[0],
        path: `/${repository}/${workflowPath}@${commit}`,
      },
      graph[1],
      graph[2],
    ],
    [graph[0]],
  ];
  for (const referencedWorkflows of cases) {
    const provider = createProvider();
    const original = provider.getWorkflowRun;
    provider.getWorkflowRun = async () => ({
      ...(await original()),
      referencedWorkflows,
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
  }
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
        workflowPath: callerPath,
        workflowSha: commit,
        eventSha: commit,
        referencedWorkflows: [
          {
            path: workflowPath,
            ref: "refs/heads/dev",
            sha: commit,
          },
        ],
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

test("rejects a wrong caller or incomplete referenced-workflow identity", async () => {
  const provider = createProvider();
  provider.getWorkflowRun = async () => ({
    id: 10,
    attempt: 1,
    workflowPath: ".github/workflows/lifecycle-wakeup-dispatch.yml",
    workflowSha: commit,
    eventSha: commit,
    referencedWorkflows: [],
    ref: "refs/heads/dev",
    headSha: commit,
  });
  provider.getWorkflowJob = async () => ({
    id: 11,
    runId: 10,
    workflowPath,
    workflowSha: commit,
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
