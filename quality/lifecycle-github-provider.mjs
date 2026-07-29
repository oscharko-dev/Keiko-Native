import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  githubBinaryRequestFor,
  githubGraphqlRequestFor,
  githubRequestFor,
} from "./github-api.mjs";
import { decodeCanonical } from "./lifecycle-record-canonical.mjs";
import {
  digestAuxiliaryIdentity,
  parseRecordEnvelope,
} from "./lifecycle-record-protocol.mjs";
import { pullRequestIssueNumber } from "./pr-contract.mjs";
import { readSingleFileZip } from "./single-file-zip.mjs";
import {
  authenticateLifecycleRecoveryComment,
  parseLifecycleRecoveryCommand,
  selectLifecycleRecoveryFallback,
} from "./lifecycle-wake.mjs";
import { GOVERNANCE_MAINTAINERS } from "./governance-maintainers.mjs";

const REPOSITORY = "oscharko-dev/Keiko-Native";
const CALLER = ".github/workflows/lifecycle-wakeup.yml";
const COORDINATOR = ".github/workflows/issue-lifecycle.yml";
const DEV_REF = "refs/heads/dev";
const ISSUER = "https://token.actions.githubusercontent.com";
const ANCHOR_FILE = "artifact-anchor.bin";
const RESERVED_PREFIX = "<!-- keiko-native-lifecycle-";
const PRODUCER_JOB_LABELS = Object.freeze({
  "issue-contract-current": "Produce current issue-contract result",
  "pr-contract": "Produce pull-request contract result",
  "contract-publication": "Produce contract-publication result",
});
const request = githubRequestFor("keiko-native-lifecycle-provider");
const binaryRequest = githubBinaryRequestFor("keiko-native-lifecycle-provider");
const graphqlRequest = githubGraphqlRequestFor(
  "keiko-native-lifecycle-provider",
);
const RECOVERY_COMMENT_QUERY = `query LifecycleRecoveryComment($id: ID!) {
  node(id: $id) {
    __typename
    ... on IssueComment {
      databaseId
      body
      createdAt
      updatedAt
      lastEditedAt
      includesCreatedEdit
      author {
        __typename
        login
        ... on User { databaseId }
        ... on Bot { databaseId }
      }
      editor {
        __typename
        login
        ... on User { databaseId }
        ... on Bot { databaseId }
      }
      repository { databaseId nameWithOwner }
      issue { number }
    }
  }
}`;
const RECOVERY_WINDOW_QUERY = `query LifecycleRecoveryWindow(
  $owner: String!
  $name: String!
  $number: Int!
  $before: String
) {
  repository(owner: $owner, name: $name) {
    databaseId
    nameWithOwner
    issue(number: $number) {
      comments(last: 100, before: $before) {
        nodes {
          databaseId
          body
          createdAt
          updatedAt
          lastEditedAt
          includesCreatedEdit
          author {
            __typename
            login
            ... on User { databaseId }
            ... on Bot { databaseId }
          }
          editor {
            __typename
            login
            ... on User { databaseId }
            ... on Bot { databaseId }
          }
        }
        pageInfo { hasPreviousPage startCursor }
      }
    }
  }
}`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const positive = (value) =>
  Number.isSafeInteger(value) && value > 0 ? value : undefined;

function commentShape(comment) {
  const actor = Object.freeze({
    id: comment?.user?.id,
    login: comment?.user?.login,
    type: comment?.user?.type,
  });
  return Object.freeze({
    author: actor,
    body: comment?.body,
    createdAt: comment?.created_at,
    id: comment?.id,
    nodeId: comment?.node_id,
    performedViaGithubApp:
      comment?.performed_via_github_app === null
        ? null
        : Object.freeze({ id: comment?.performed_via_github_app?.id }),
    updatedAt: comment?.updated_at,
    user: actor,
  });
}

function actorShape(actor) {
  return actor === null
    ? null
    : Object.freeze({
        id: actor?.databaseId,
        login: actor?.login,
        type: actor?.__typename,
      });
}

function recoveryCommentShape(comment, issueNumber) {
  return Object.freeze({
    author: actorShape(comment?.author),
    body: comment?.body,
    createdAt: comment?.createdAt,
    editor: actorShape(comment?.editor),
    id: comment?.databaseId,
    includesCreatedEdit: comment?.includesCreatedEdit,
    issueNumber,
    lastEditedAt: comment?.lastEditedAt,
    updatedAt: comment?.updatedAt,
  });
}

function canonicalRunPath(path) {
  return typeof path === "string" && path.startsWith("/")
    ? path.slice(1)
    : path;
}

function referencedWorkflow(entry) {
  const path = canonicalRunPath(entry?.path);
  const ref =
    entry?.ref === "dev" || entry?.ref === "refs/heads/dev"
      ? DEV_REF
      : entry?.ref;
  return { path, ref, sha: entry?.sha };
}

function exactOne(values, code) {
  if (values.length !== 1) throw new Error(code);
  return values[0];
}

function checkpointIdentity(record) {
  const fields = record.parsed.fields;
  return {
    commentId: record.comment.id,
    identity: digestAuxiliaryIdentity("checkpoint identity", {
      repository: REPOSITORY,
      issue_number: fields.issue_number,
      checkpoint_sequence: fields.checkpoint_sequence,
      prior_checkpoint_comment_id: fields.prior_checkpoint_comment_id,
      prior_checkpoint_record_digest: fields.prior_checkpoint_record_digest,
      compacted_prefix_identity: fields.compacted_prefix_identity,
      chain_tip_comment_id: record.comment.id,
      chain_tip_record_digest: record.parsed.recordDigest,
    }),
    recordDigest: record.parsed.recordDigest,
    sequence: fields.checkpoint_sequence,
  };
}

function statementFromAttestation(attestation) {
  const payload =
    attestation?.bundle?.dsseEnvelope?.payload ??
    attestation?.bundle?.dsse_envelope?.payload;
  if (typeof payload !== "string") throw new Error("attestation-payload");
  let statement;
  try {
    statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    throw new Error("attestation-payload");
  }
  if (!Array.isArray(statement?.subject) || statement.subject.length !== 1)
    throw new Error("attestation-subject");
  return statement;
}

function expectedClaims(fields) {
  return {
    repository: REPOSITORY,
    workflow_ref: `${REPOSITORY}/${CALLER}@${DEV_REF}`,
    workflow_sha: fields.protected_dev_sha,
    job_workflow_ref: `${REPOSITORY}/${fields.workflow_path}@${DEV_REF}`,
    job_workflow_sha: fields.protected_dev_sha,
    ref: DEV_REF,
    sha: fields.protected_dev_sha,
    run_id: fields.workflow_run_id,
    run_attempt: fields.workflow_run_attempt,
    iss: ISSUER,
  };
}

export function createLifecycleGithubProvider({
  binary = binaryRequest,
  graphql = graphqlRequest,
  json = request,
  maximumRequests = 136,
} = {}) {
  if (!Number.isSafeInteger(maximumRequests) || maximumRequests <= 0)
    throw new TypeError("provider request ceiling is invalid");
  let requestCount = 0;
  const counted = async (operation) => {
    requestCount += 1;
    if (requestCount > maximumRequests)
      throw new Error("provider-request-ceiling");
    return operation();
  };
  const providerJson = (path, options) => counted(() => json(path, options));
  const providerBinary = (path) => counted(() => binary(path));
  const providerGraphql = (query, variables) =>
    counted(() => graphql(query, variables));
  const comments = new Map();
  const artifacts = new Map();
  const anchorFields = new Map();
  const jobPaths = new Map();
  const runProtectedShas = new Map();

  async function recoveryPermission(login) {
    const response = await providerJson(
      `/repos/${REPOSITORY}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    if (
      response?.user?.login !== login ||
      !["none", "read", "triage", "write", "maintain", "admin"].includes(
        response?.permission,
      )
    )
      throw new Error("recovery-permission-invalid");
    return response.permission;
  }

  async function recoveryCommentRest(issueNumber, commentId) {
    const rest = await providerJson(
      `/repos/${REPOSITORY}/issues/comments/${commentId}`,
    );
    if (
      rest?.id !== commentId ||
      typeof rest?.node_id !== "string" ||
      rest.issue_url !==
        `https://api.github.com/repos/${REPOSITORY}/issues/${issueNumber}`
    )
      throw new Error("recovery-comment-rest-mismatch");
    return rest;
  }

  async function exactRecoveryCommentRead(issueNumber, commentId, restInput) {
    const rest =
      restInput ?? (await recoveryCommentRest(issueNumber, commentId));
    const response = await providerGraphql(RECOVERY_COMMENT_QUERY, {
      id: rest.node_id,
    });
    const node = response?.data?.node;
    const comment = recoveryCommentShape(node, issueNumber);
    if (
      node?.__typename !== "IssueComment" ||
      node?.repository?.nameWithOwner !== REPOSITORY ||
      !positive(node?.repository?.databaseId) ||
      node?.issue?.number !== issueNumber ||
      comment.id !== rest.id ||
      comment.body !== rest.body ||
      comment.createdAt !== rest.created_at ||
      comment.updatedAt !== rest.updated_at ||
      comment.author?.id !== rest.user?.id ||
      comment.author?.login !== rest.user?.login ||
      comment.author?.type !== rest.user?.type
    )
      throw new Error("recovery-comment-graphql-mismatch");
    return {
      comment,
      permission: await recoveryPermission(comment.author.login),
      repositoryId: node.repository.databaseId,
    };
  }

  async function recoveryWindowPage(issueNumber, before) {
    const response = await providerGraphql(RECOVERY_WINDOW_QUERY, {
      before,
      name: "Keiko-Native",
      number: issueNumber,
      owner: "oscharko-dev",
    });
    const repository = response?.data?.repository;
    const commentsConnection = repository?.issue?.comments;
    if (
      repository?.nameWithOwner !== REPOSITORY ||
      !positive(repository?.databaseId) ||
      !Array.isArray(commentsConnection?.nodes) ||
      commentsConnection.nodes.length > 100 ||
      typeof commentsConnection?.pageInfo?.hasPreviousPage !== "boolean" ||
      (commentsConnection.pageInfo.hasPreviousPage &&
        typeof commentsConnection.pageInfo.startCursor !== "string")
    )
      throw new Error("recovery-window-invalid");
    return {
      comments: commentsConnection.nodes.map((comment) =>
        recoveryCommentShape(comment, issueNumber),
      ),
      hasPreviousPage: commentsConnection.pageInfo.hasPreviousPage,
      repositoryId: repository.databaseId,
      startCursor: commentsConnection.pageInfo.startCursor,
    };
  }

  async function recoveryWindow(issueNumber) {
    const pages = [];
    let before = null;
    for (let page = 0; page < 2; page += 1) {
      const value = await recoveryWindowPage(issueNumber, before);
      pages.push(value);
      if (!value.hasPreviousPage) break;
      before = value.startCursor;
    }
    return pages;
  }

  async function recoveryOrphanRead(issueNumber, recoveryTargetIdentity) {
    const timeline = [];
    let cursor = null;
    for (let page = 0; page < 2; page += 1) {
      const value = await provider.listCommentsPage({
        cursor,
        issueNumber,
      });
      timeline.push(...value.items);
      if (!value.hasMore) break;
      cursor = value.nextCursor;
    }
    const inventory = await provider.listAnchorArtifacts({
      issueNumber,
      name: `keiko-lifecycle-anchor-v1-issue-${issueNumber}`,
    });
    const anchored = new Set(
      inventory.items.map((artifact) => artifact.commentId),
    );
    const candidates = timeline.flatMap((comment) => {
      if (anchored.has(comment.id) || !comment.body.includes(RESERVED_PREFIX))
        return [];
      let parsed;
      try {
        parsed = parseRecordEnvelope(comment.body);
      } catch {
        throw new Error("recovery-orphan-malformed");
      }
      const fields = parsed.fields;
      const targetIdentity = digestAuxiliaryIdentity("recovery target", {
        repository: REPOSITORY,
        issue_number: issueNumber,
        orphan_comment_id: comment.id,
        orphan_comment_body_sha256: sha256(Buffer.from(comment.body, "utf8")),
        orphan_record_digest: parsed.recordDigest,
        last_authenticated_comment_id: fields.predecessor_comment_id ?? null,
        last_authenticated_record_digest:
          fields.predecessor_record_digest ?? null,
      });
      return targetIdentity === recoveryTargetIdentity
        ? [{ comment, fields, parsed, targetIdentity }]
        : [];
    });
    const candidate = exactOne(
      candidates,
      "recovery-orphan-target-cardinality",
    );
    const exactComment = await provider.getComment({
      commentId: candidate.comment.id,
      issueNumber,
    });
    if (
      exactComment.body !== candidate.comment.body ||
      exactComment.author?.login !== "github-actions[bot]" ||
      exactComment.author?.id !== 41898282 ||
      exactComment.author?.type !== "Bot" ||
      exactComment.performedViaGithubApp?.id !== 15368 ||
      candidate.fields.repository !== REPOSITORY ||
      candidate.fields.issue_number !== issueNumber
    )
      throw new Error("recovery-orphan-comment-invalid");
    const workflowPath =
      candidate.fields.workflow_path ?? candidate.fields.owner_workflow_path;
    const runId =
      candidate.fields.workflow_run_id ?? candidate.fields.owner_run_id;
    const runAttempt =
      candidate.fields.workflow_run_attempt ??
      candidate.fields.owner_run_attempt;
    const run = await providerJson(
      `/repos/${REPOSITORY}/actions/runs/${runId}`,
    );
    const referenced = (run?.referenced_workflows ?? []).map(
      referencedWorkflow,
    );
    if (
      run?.id !== runId ||
      run?.run_attempt !== runAttempt ||
      canonicalRunPath(run?.path) !== CALLER ||
      run?.head_branch !== "dev" ||
      !referenced.some(
        (entry) =>
          entry.path === COORDINATOR &&
          entry.ref === DEV_REF &&
          entry.sha === candidate.fields.protected_dev_sha,
      ) ||
      (workflowPath !== COORDINATOR &&
        !referenced.some(
          (entry) =>
            entry.path === workflowPath &&
            entry.ref === DEV_REF &&
            entry.sha === candidate.fields.protected_dev_sha,
        ))
    )
      throw new Error("recovery-orphan-run-invalid");
    const reachability = await providerJson(
      `/repos/${REPOSITORY}/compare/${candidate.fields.protected_dev_sha}...dev`,
    );
    if (!["ahead", "identical"].includes(reachability?.status))
      throw new Error("recovery-orphan-protected-sha-unreachable");
    const orphanAnchorFields = {
      repository: REPOSITORY,
      issue_number: issueNumber,
      record_type: candidate.parsed.recordType,
      record_digest: candidate.parsed.recordDigest,
      comment_id: exactComment.id,
      comment_body_sha256: sha256(Buffer.from(exactComment.body, "utf8")),
      generation_identity: candidate.fields.generation_identity,
      attempt: candidate.fields.attempt,
      workflow_path: workflowPath,
      workflow_run_id: runId,
      workflow_run_attempt: runAttempt,
      protected_dev_sha: candidate.fields.protected_dev_sha,
    };
    const anchorIdentity = digestAuxiliaryIdentity(
      "artifact anchor",
      orphanAnchorFields,
    );
    const attestations = await providerJson(
      `/repos/${REPOSITORY}/attestations/${anchorIdentity}`,
    );
    if (
      !Array.isArray(attestations?.attestations) ||
      attestations.attestations.length !== 0
    )
      throw new Error("recovery-orphan-attestation-present");
    const conclusion =
      run.conclusion === "timed_out" ? "timed-out" : run.conclusion;
    return {
      actor_type: exactComment.author.type,
      anchor_count: 0,
      app_id: exactComment.performedViaGithubApp.id,
      attempt: candidate.fields.attempt,
      attestation_count: 0,
      author_id: exactComment.author.id,
      author_login: exactComment.author.login,
      comment_body_sha256: orphanAnchorFields.comment_body_sha256,
      comment_id: exactComment.id,
      last_authenticated_comment_id:
        candidate.fields.predecessor_comment_id ?? null,
      last_authenticated_record_digest:
        candidate.fields.predecessor_record_digest ?? null,
      protected_dev_sha: candidate.fields.protected_dev_sha,
      record_digest: candidate.parsed.recordDigest,
      run_conclusion: conclusion,
      workflow_path: workflowPath,
      workflow_ref: DEV_REF,
      workflow_run_attempt: runAttempt,
      workflow_run_id: runId,
    };
  }

  async function artifactBytes(artifact) {
    const cached = artifacts.get(artifact.id);
    if (cached?.bytes !== undefined) return cached.bytes;
    const archive = await providerBinary(
      `/repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`,
    );
    const bytes = readSingleFileZip(archive, {
      expectedName: ANCHOR_FILE,
      maximumFileBytes: 8192,
    });
    return bytes;
  }

  async function jobsForRun(runId) {
    const response = await providerJson(
      `/repos/${REPOSITORY}/actions/runs/${runId}/jobs?filter=all&per_page=100`,
    );
    if (
      !Array.isArray(response?.jobs) ||
      response.total_count !== response.jobs.length
    )
      throw new Error("workflow-job-inventory-incomplete");
    return response.jobs;
  }

  async function writerJob(fields) {
    const jobs = await jobsForRun(fields.workflow_run_id);
    const suffix =
      fields.workflow_path === COORDINATOR
        ? "Publish authenticated lifecycle record"
        : "Produce authenticated lifecycle result";
    const job = exactOne(
      jobs.filter(
        (candidate) =>
          positive(candidate?.id) !== undefined &&
          candidate?.run_id === fields.workflow_run_id &&
          (candidate?.name === suffix ||
            candidate?.name?.endsWith(` / ${suffix}`)),
      ),
      "record-writer-job-cardinality",
    );
    jobPaths.set(job.id, {
      protectedDevSha: fields.protected_dev_sha,
      workflowPath: fields.workflow_path,
    });
    runProtectedShas.set(fields.workflow_run_id, fields.protected_dev_sha);
    return job;
  }

  const provider = {
    async listCommentsPage({ issueNumber, cursor }) {
      const page = cursor === null ? 1 : Number(cursor);
      if (!Number.isSafeInteger(page) || page <= 0)
        throw new Error("comment-cursor-invalid");
      const response = await providerJson(
        `/repos/${REPOSITORY}/issues/${issueNumber}/comments?sort=created&direction=desc&per_page=100&page=${page}`,
      );
      if (!Array.isArray(response) || response.length > 100)
        throw new Error("comment-page-invalid");
      const items = response.map(commentShape);
      for (const item of items) comments.set(item.id, item);
      return {
        hasMore: response.length === 100,
        items,
        nextCursor: response.length === 100 ? String(page + 1) : null,
      };
    },

    async listAnchorArtifacts({ issueNumber, name }) {
      const response = await providerJson(
        `/repos/${REPOSITORY}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100&page=1`,
      );
      if (
        !Array.isArray(response?.artifacts) ||
        response.total_count !== response.artifacts.length ||
        response.artifacts.length > 100
      )
        throw new Error("anchor-artifact-inventory-incomplete");
      const items = [];
      for (const artifact of response.artifacts) {
        if (
          positive(artifact?.id) === undefined ||
          artifact.name !== name ||
          artifact.expired === true
        )
          throw new Error("anchor-artifact-invalid");
        const bytes = await artifactBytes(artifact);
        const fields = decodeCanonical("aux:artifact anchor", bytes);
        if (
          fields.issue_number !== issueNumber ||
          fields.repository !== REPOSITORY ||
          artifact.workflow_run?.id !== fields.workflow_run_id
        )
          throw new Error("anchor-artifact-identity-mismatch");
        const anchorIdentity = digestAuxiliaryIdentity(
          "artifact anchor",
          fields,
        );
        const normalized = {
          anchorIdentity,
          commentId: fields.comment_id,
          expired: false,
          id: artifact.id,
          immutable: true,
          name,
          workflowRunId: fields.workflow_run_id,
        };
        artifacts.set(artifact.id, {
          api: artifact,
          bytes,
          fields,
          normalized,
        });
        anchorFields.set(anchorIdentity, fields);
        items.push(normalized);
      }
      return { complete: true, items };
    },

    async getComment({ issueNumber, commentId }) {
      const response = await providerJson(
        `/repos/${REPOSITORY}/issues/comments/${commentId}`,
      );
      const comment = commentShape(response);
      if (
        comment.id !== commentId ||
        response?.issue_url !==
          `https://api.github.com/repos/${REPOSITORY}/issues/${issueNumber}`
      )
        throw new Error("record-comment-identity-mismatch");
      comments.set(comment.id, comment);
      return comment;
    },

    async authenticateRecoveryComment({ issueNumber, commentId }) {
      const firstRest = await recoveryCommentRest(issueNumber, commentId);
      if (parseLifecycleRecoveryCommand(firstRest.body) === undefined)
        return null;
      const first = await exactRecoveryCommentRead(
        issueNumber,
        commentId,
        firstRest,
      );
      const second = await exactRecoveryCommentRead(issueNumber, commentId);
      if (
        first.repositoryId !== second.repositoryId ||
        first.permission !== second.permission
      )
        throw new Error("recovery-comment-unstable");
      return authenticateLifecycleRecoveryComment({
        first: first.comment,
        issueNumber,
        permissionFirst: first.permission,
        permissionSecond: second.permission,
        repositoryId: first.repositoryId,
        second: second.comment,
      });
    },

    async discoverRecoveryComment({ issueNumber }) {
      const first = await recoveryWindow(issueNumber);
      const second = await recoveryWindow(issueNumber);
      if (!isDeepStrictEqual(first, second))
        throw new Error("recovery-window-unstable");
      const commentsInWindow = second.flatMap((page) => page.comments);
      const actorLogins = new Map(
        commentsInWindow
          .filter(
            (comment) =>
              comment.author?.type === "User" &&
              comment.createdAt === comment.updatedAt &&
              comment.lastEditedAt === null &&
              comment.editor === null &&
              comment.includesCreatedEdit === false &&
              parseLifecycleRecoveryCommand(comment.body) !== undefined,
          )
          .map((comment) => [comment.author.id, comment.author.login]),
      );
      const permissions = new Map();
      const allowlisted = new Set(
        GOVERNANCE_MAINTAINERS.map((actor) => actor.id),
      );
      for (const [actorId, login] of actorLogins) {
        if (!allowlisted.has(actorId)) continue;
        const permissionFirst = await recoveryPermission(login);
        const permissionSecond = await recoveryPermission(login);
        if (permissionFirst !== permissionSecond)
          throw new Error("recovery-permission-unstable");
        permissions.set(actorId, permissionSecond);
      }
      return (
        selectLifecycleRecoveryFallback(commentsInWindow, permissions)?.id ??
        null
      );
    },

    async loadRecoveryOrphan({ issueNumber, recoveryTargetIdentity }) {
      const first = await recoveryOrphanRead(
        issueNumber,
        recoveryTargetIdentity,
      );
      const second = await recoveryOrphanRead(
        issueNumber,
        recoveryTargetIdentity,
      );
      if (!isDeepStrictEqual(first, second))
        throw new Error("recovery-orphan-unstable");
      return { first, second };
    },

    async getArtifactForComment({ issueNumber, commentId }) {
      let match = [...artifacts.values()].find(
        (artifact) =>
          artifact.fields.issue_number === issueNumber &&
          artifact.fields.comment_id === commentId,
      );
      if (match === undefined) {
        await provider.listAnchorArtifacts({
          issueNumber,
          name: `keiko-lifecycle-anchor-v1-issue-${issueNumber}`,
        });
        match = [...artifacts.values()].find(
          (artifact) => artifact.fields.comment_id === commentId,
        );
      }
      if (match === undefined) throw new Error("record-artifact-missing");
      const job = await writerJob(match.fields);
      return {
        ...match.normalized,
        writerJobId: job.id,
      };
    },

    async downloadArtifact({ artifactId }) {
      const artifact = artifacts.get(artifactId);
      if (artifact === undefined) throw new Error("record-artifact-missing");
      return {
        digest: `sha256:${sha256(artifact.bytes)}`,
        files: [{ bytes: artifact.bytes, name: ANCHOR_FILE }],
      };
    },

    async getWorkflowRun({ runId }) {
      const response = await providerJson(
        `/repos/${REPOSITORY}/actions/runs/${runId}`,
      );
      const protectedDevSha = runProtectedShas.get(runId);
      if (protectedDevSha === undefined)
        throw new Error("record-run-protected-sha-missing");
      const referenced = (response?.referenced_workflows ?? [])
        .map(referencedWorkflow)
        .filter((entry) => entry.path !== CALLER)
        .toSorted((left, right) => {
          if (left.path === COORDINATOR) return -1;
          if (right.path === COORDINATOR) return 1;
          return left.path.localeCompare(right.path, "en");
        });
      return {
        attempt: response?.run_attempt,
        eventSha: response?.head_sha,
        id: response?.id,
        ref: response?.head_branch === "dev" ? DEV_REF : response?.head_branch,
        referencedWorkflows: referenced,
        workflowPath: canonicalRunPath(response?.path),
        workflowSha: protectedDevSha,
      };
    },

    async getWorkflowJob({ runId, jobId }) {
      const response = await providerJson(
        `/repos/${REPOSITORY}/actions/jobs/${jobId}`,
      );
      const cached = jobPaths.get(jobId);
      if (cached === undefined)
        throw new Error("record-job-workflow-path-missing");
      return {
        runId: response?.run_id ?? runId,
        workflowPath: cached.workflowPath,
        workflowSha: cached.protectedDevSha,
      };
    },

    async isCommitReachableFromDev({ commit }) {
      const response = await providerJson(
        `/repos/${REPOSITORY}/compare/${commit}...dev`,
      );
      return ["ahead", "identical"].includes(response?.status);
    },

    async listAttestations({ subjectDigest }) {
      const response = await providerJson(
        `/repos/${REPOSITORY}/attestations/${subjectDigest}`,
      );
      const fields = anchorFields.get(subjectDigest);
      if (fields === undefined || !Array.isArray(response?.attestations))
        throw new Error("record-attestation-inventory-invalid");
      return response.attestations.map((attestation) => ({
        attestation,
        fields,
        subjectDigest,
      }));
    },

    async verifyAttestation({ bundle }) {
      const statement = statementFromAttestation(bundle.attestation);
      const subject = statement.subject[0];
      if (
        subject?.name !==
          `keiko-native/lifecycle-comment/v1/${REPOSITORY}/${bundle.fields.issue_number}/${bundle.fields.comment_id}/${bundle.fields.generation_identity}/${bundle.fields.attempt}/${bundle.fields.record_type}/${bundle.fields.workflow_run_id}/${bundle.fields.workflow_run_attempt}` ||
        subject?.digest?.sha256 !== bundle.subjectDigest
      )
        throw new Error("record-attestation-subject-mismatch");
      return {
        claims: expectedClaims(bundle.fields),
        subject: {
          digest: `sha256:${bundle.subjectDigest}`,
          name: subject.name,
        },
        verified: true,
      };
    },

    async getCheckpointEvidence({ commentId }) {
      const checkpointComment = comments.get(commentId);
      if (checkpointComment === undefined)
        throw new Error("checkpoint-comment-unavailable");
      const parsed = parseRecordEnvelope(checkpointComment.body);
      const current = { comment: checkpointComment, parsed };
      const priorId = parsed.fields.prior_checkpoint_comment_id;
      let priorCheckpoint = null;
      if (priorId !== null) {
        const priorComment = comments.get(priorId);
        if (priorComment === undefined)
          throw new Error("prior-checkpoint-comment-unavailable");
        priorCheckpoint = checkpointIdentity({
          comment: priorComment,
          parsed: parseRecordEnvelope(priorComment.body),
        });
      }
      const members = [];
      let predecessorId = parsed.fields.predecessor_comment_id;
      let predecessorDigest = parsed.fields.predecessor_record_digest;
      while (predecessorId !== priorId) {
        const predecessorComment = comments.get(predecessorId);
        if (predecessorComment === undefined)
          throw new Error("checkpoint-member-unavailable");
        const predecessor = parseRecordEnvelope(predecessorComment.body);
        if (predecessor.recordDigest !== predecessorDigest)
          throw new Error("checkpoint-member-digest-mismatch");
        members.push({
          comment_id: predecessorId,
          record_digest: predecessorDigest,
        });
        predecessorId = predecessor.fields.predecessor_comment_id;
        predecessorDigest = predecessor.fields.predecessor_record_digest;
      }
      members.reverse();
      return {
        compactedMembers: members,
        priorCheckpoint,
        record: current,
      };
    },

    async currentProducerRuntime({ expectedProducer, runId }) {
      const callerLabel = PRODUCER_JOB_LABELS[expectedProducer];
      if (callerLabel === undefined)
        throw new Error("producer-runtime-identity-invalid");
      const [run, jobs] = await Promise.all([
        providerJson(`/repos/${REPOSITORY}/actions/runs/${runId}`),
        jobsForRun(runId),
      ]);
      const job = exactOne(
        jobs.filter(
          (candidate) =>
            positive(candidate?.id) !== undefined &&
            candidate?.run_id === runId &&
            candidate?.name?.includes(callerLabel) &&
            candidate.name.endsWith("Produce authenticated lifecycle result"),
        ),
        "producer-runtime-job-cardinality",
      );
      return {
        jobId: job.id,
        workflowId: run?.workflow_id,
      };
    },

    comments() {
      return [...comments.values()].toSorted(
        (left, right) => left.id - right.id,
      );
    },

    loadCoordinatorFacts({ issueNumber }) {
      return loadStableLifecycleCoordinatorFacts({
        issueNumber,
        json: providerJson,
      });
    },

    requestCount() {
      return requestCount;
    },
  };
  return Object.freeze(provider);
}

async function stable(read, code) {
  const first = await read();
  const second = await read();
  if (!isDeepStrictEqual(first, second)) throw new Error(code);
  return second;
}

async function allPullRequests(json, state) {
  const values = [];
  for (let page = 1; page <= 2; page += 1) {
    const batch = await json(
      `/repos/${REPOSITORY}/pulls?state=${state}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch)) throw new Error("pull-request-page-invalid");
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error("pull-request-pagination-incomplete");
}

export async function loadStableLifecycleCoordinatorFacts({
  issueNumber,
  json = request,
}) {
  const issue = await stable(
    () => json(`/repos/${REPOSITORY}/issues/${issueNumber}`),
    "coordinator-issue-unstable",
  );
  const pullRequests = await stable(
    async () => [
      ...(await allPullRequests(json, "open")),
      ...(await allPullRequests(json, "closed")),
    ],
    "coordinator-pull-requests-unstable",
  );
  const linked = pullRequests.filter(
    (pullRequest) => pullRequestIssueNumber(pullRequest?.body) === issueNumber,
  );
  const open = linked.filter((pullRequest) => pullRequest.state === "open");
  if (open.length > 1) throw new Error("coordinator-pull-request-ambiguous");
  const pullRequest =
    open[0] ??
    linked
      .filter((candidate) => candidate.merged === true)
      .toSorted((left, right) =>
        String(right.updated_at).localeCompare(String(left.updated_at), "en"),
      )[0] ??
    null;
  return { issue, pullRequest };
}

export const LIFECYCLE_GITHUB_REPOSITORY = REPOSITORY;
