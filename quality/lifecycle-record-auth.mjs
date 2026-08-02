import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  digestAuxiliaryIdentity,
  encodeAuxiliaryPreimage,
  parseRecordEnvelope,
} from "./lifecycle-record-protocol.mjs";
import {
  callLifecycleProvider,
  createLifecycleProviderBudget,
} from "./lifecycle-record-budget.mjs";

const BOT = Object.freeze({
  appId: 15368,
  id: 41898282,
  login: "github-actions[bot]",
  type: "Bot",
});
const DEV_REF = "refs/heads/dev";
const ISSUER = "https://token.actions.githubusercontent.com";
const ANCHOR_FILE = "artifact-anchor.bin";
const CALLER = ".github/workflows/lifecycle-wakeup.yml";
const COORDINATOR = ".github/workflows/issue-lifecycle.yml";
const STATIC_WORKFLOW_PATHS = Object.freeze([
  COORDINATOR,
  ".github/workflows/contract-publication.yml",
  ".github/workflows/pr-contract.yml",
]);
const PROTECTED_CALLER_EVENTS = new Set([
  "check_run",
  "issue_comment",
  "issues",
  "pull_request_target",
  "schedule",
  "workflow_run",
]);
const COMMIT = /^[0-9a-f]{40}$/u;

export class LifecycleAuthenticationError extends Error {
  constructor(code) {
    super(code);
    this.name = "LifecycleAuthenticationError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new LifecycleAuthenticationError(code);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function lifecycleProtectedRunRef(run, protectedDevSha) {
  const event = run?.event;
  const headBranch = run?.headBranch ?? run?.head_branch;
  const eventSha = run?.eventSha ?? run?.head_sha;
  if (
    !PROTECTED_CALLER_EVENTS.has(event) ||
    typeof headBranch !== "string" ||
    headBranch === "" ||
    !COMMIT.test(eventSha ?? "") ||
    !COMMIT.test(protectedDevSha ?? "")
  )
    return undefined;
  if (event === "pull_request_target") return DEV_REF;
  return eventSha === protectedDevSha &&
    (headBranch === "dev" || headBranch === DEV_REF)
    ? DEV_REF
    : undefined;
}

export function lifecycleAnchorArtifactName(issueNumber) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)
    throw new TypeError("issue number must be a positive safe integer");
  return `keiko-lifecycle-anchor-v1-issue-${issueNumber}`;
}

export function lifecycleAnchorSubject(fields) {
  return (
    `keiko-native/lifecycle-comment/v1/${fields.repository}/` +
    `${fields.issue_number}/${fields.comment_id}/${fields.generation_identity}/` +
    `${fields.attempt}/${fields.record_type}/${fields.workflow_run_id}/` +
    `${fields.workflow_run_attempt}`
  );
}

function verifyComment(comment, body) {
  if (
    comment.author?.login !== BOT.login ||
    comment.author?.id !== BOT.id ||
    comment.author?.type !== BOT.type ||
    comment.performedViaGithubApp?.id !== BOT.appId
  )
    fail("record-author-unauthenticated");
  if (comment.body !== body) fail("record-comment-body-mismatch");
}

function anchorFields(repository, issueNumber, comment, parsed) {
  const record = parsed.fields;
  return {
    repository,
    issue_number: issueNumber,
    record_type: parsed.recordType,
    record_digest: parsed.recordDigest,
    comment_id: comment.id,
    comment_body_sha256: sha256(Buffer.from(comment.body, "utf8")),
    generation_identity: record.generation_identity,
    attempt: record.attempt,
    workflow_path: record.workflow_path ?? record.owner_workflow_path,
    workflow_run_id: record.workflow_run_id ?? record.owner_run_id,
    workflow_run_attempt:
      record.workflow_run_attempt ?? record.owner_run_attempt,
    protected_dev_sha: record.protected_dev_sha,
  };
}

function verifyArtifact(artifact, download, expectedFields) {
  if (
    artifact.name !==
      lifecycleAnchorArtifactName(expectedFields.issue_number) ||
    artifact.immutable !== true ||
    artifact.expired === true ||
    download.files?.length !== 1 ||
    download.files[0].name !== ANCHOR_FILE
  )
    fail("record-artifact-invalid");
  const expectedBytes = encodeAuxiliaryPreimage(
    "artifact anchor",
    expectedFields,
  );
  if (!Buffer.from(download.files[0].bytes).equals(expectedBytes))
    fail("record-artifact-bytes-mismatch");
  if (
    download.digest !== `sha256:${sha256(expectedBytes)}` ||
    artifact.anchorIdentity !==
      digestAuxiliaryIdentity("artifact anchor", expectedFields)
  )
    fail("record-artifact-digest-mismatch");
}

export function hasExactLifecycleStaticWorkflowGraph(
  referenced,
  repository,
  protectedDevSha,
) {
  if (!Array.isArray(referenced) || referenced.length !== 3) return false;
  const expected = STATIC_WORKFLOW_PATHS.map((workflowPath) => ({
    path: `${repository}/${workflowPath}@${protectedDevSha}`,
    ref: DEV_REF,
    sha: protectedDevSha,
  }));
  return expected.every((workflow) =>
    referenced.some((candidate) => isDeepStrictEqual(candidate, workflow)),
  );
}

function verifyRun(run, job, repository, fields, workflowJobId) {
  if (
    run.id !== fields.workflow_run_id ||
    run.attempt !== fields.workflow_run_attempt ||
    run.workflowPath !== CALLER ||
    lifecycleProtectedRunRef(run, fields.protected_dev_sha) !== DEV_REF ||
    run.workflowSha !== fields.protected_dev_sha ||
    !hasExactLifecycleStaticWorkflowGraph(
      run.referencedWorkflows,
      repository,
      fields.protected_dev_sha,
    ) ||
    job.runId !== run.id ||
    (workflowJobId !== undefined && job.id !== workflowJobId) ||
    job.workflowPath !== fields.workflow_path ||
    job.workflowSha !== fields.protected_dev_sha
  )
    fail("record-workflow-run-mismatch");
}

function expectedClaims(repository, fields) {
  return {
    repository,
    workflow_ref: `${repository}/${CALLER}@${DEV_REF}`,
    workflow_sha: fields.protected_dev_sha,
    job_workflow_ref: `${repository}/${fields.workflow_path}@${DEV_REF}`,
    job_workflow_sha: fields.protected_dev_sha,
    ref: DEV_REF,
    sha: fields.protected_dev_sha,
    run_id: fields.workflow_run_id,
    run_attempt: fields.workflow_run_attempt,
    iss: ISSUER,
  };
}

function verifyAttestation(attestations, verified, repository, fields) {
  const subject = {
    name: lifecycleAnchorSubject(fields),
    digest: `sha256:${digestAuxiliaryIdentity("artifact anchor", fields)}`,
  };
  if (
    attestations.length !== 1 ||
    verified.verified !== true ||
    !isDeepStrictEqual(verified.subject, subject) ||
    !isDeepStrictEqual(verified.claims, expectedClaims(repository, fields))
  )
    fail("record-attestation-invalid");
}

async function loadWorkflowEvidence(
  provider,
  budget,
  repository,
  artifact,
  fields,
  recordFields,
) {
  const run = await callLifecycleProvider(budget, () =>
    provider.getWorkflowRun({ repository, runId: fields.workflow_run_id }),
  );
  const job = await callLifecycleProvider(budget, () =>
    provider.getWorkflowJob({
      repository,
      runId: run.id,
      jobId: artifact.writerJobId,
    }),
  );
  verifyRun(run, job, repository, fields, recordFields.workflow_job_id);
  const reachable = await callLifecycleProvider(budget, () =>
    provider.isCommitReachableFromDev({
      repository,
      commit: fields.protected_dev_sha,
    }),
  );
  if (reachable !== true) fail("record-protected-commit-unreachable");
  return { job, run };
}

async function loadTuple({
  provider,
  budget,
  repository,
  issueNumber,
  commentId,
}) {
  const comment = await callLifecycleProvider(budget, () =>
    provider.getComment({ repository, issueNumber, commentId }),
  );
  const parsed = parseRecordEnvelope(comment.body);
  verifyComment(comment, comment.body);
  const fields = anchorFields(repository, issueNumber, comment, parsed);
  const artifact = await callLifecycleProvider(budget, () =>
    provider.getArtifactForComment({ repository, issueNumber, commentId }),
  );
  const download = await callLifecycleProvider(budget, () =>
    provider.downloadArtifact({ repository, artifactId: artifact.id }),
  );
  verifyArtifact(artifact, download, fields);
  const { job, run } = await loadWorkflowEvidence(
    provider,
    budget,
    repository,
    artifact,
    fields,
    parsed.fields,
  );
  const attestations = await callLifecycleProvider(budget, () =>
    provider.listAttestations({
      repository,
      subjectDigest: artifact.anchorIdentity,
    }),
  );
  if (!Array.isArray(attestations) || attestations.length !== 1)
    fail("record-attestation-invalid");
  const verified = await callLifecycleProvider(budget, () =>
    provider.verifyAttestation({ repository, bundle: attestations[0] }),
  );
  verifyAttestation(attestations, verified, repository, fields);
  return { artifact, comment, fields, parsed, run, job, verified };
}

export async function verifyLifecycleRecordTuple({
  provider,
  repository,
  issueNumber,
  commentId,
  budget = createLifecycleProviderBudget(),
}) {
  const first = await loadTuple({
    provider,
    budget,
    repository,
    issueNumber,
    commentId,
  });
  const second = await loadTuple({
    provider,
    budget,
    repository,
    issueNumber,
    commentId,
  });
  if (!isDeepStrictEqual(first, second)) fail("record-tuple-reread-unstable");
  return Object.freeze(first);
}

export async function publishLifecycleRecord({
  provider,
  repository,
  issueNumber,
  recordBody,
  budget = createLifecycleProviderBudget(),
}) {
  const parsed = parseRecordEnvelope(recordBody);
  const comment = await callLifecycleProvider(budget, () =>
    provider.createComment({ repository, issueNumber, body: recordBody }),
  );
  const reread = await callLifecycleProvider(budget, () =>
    provider.getComment({ repository, issueNumber, commentId: comment.id }),
  );
  verifyComment(reread, recordBody);
  const fields = anchorFields(repository, issueNumber, reread, parsed);
  const bytes = encodeAuxiliaryPreimage("artifact anchor", fields);
  const artifact = await callLifecycleProvider(budget, () =>
    provider.uploadArtifact({
      repository,
      name: lifecycleAnchorArtifactName(issueNumber),
      file: { name: ANCHOR_FILE, bytes },
      anchorIdentity: digestAuxiliaryIdentity("artifact anchor", fields),
      immutable: true,
    }),
  );
  await callLifecycleProvider(budget, () =>
    provider.createAttestation({
      repository,
      artifactId: artifact.id,
      subject: {
        name: lifecycleAnchorSubject(fields),
        digest: `sha256:${digestAuxiliaryIdentity("artifact anchor", fields)}`,
      },
    }),
  );
  return verifyLifecycleRecordTuple({
    provider,
    repository,
    issueNumber,
    commentId: comment.id,
    budget,
  });
}
