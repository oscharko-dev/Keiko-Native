import { createHash } from "node:crypto";

import { semanticIssueFingerprint } from "./issue-contract.mjs";
import { readinessRecordFromComments } from "./issue-readiness-action.mjs";
import {
  digestLifecycleGenerationV1,
  encodeLifecycleGenerationV1,
} from "./lifecycle-generation.mjs";
import {
  createRecordEnvelope,
  digestAuxiliaryIdentity,
} from "./lifecycle-record-protocol.mjs";
import { issueDeliveryTarget } from "./pr-contract.mjs";

const REPOSITORY = "oscharko-dev/Keiko-Native";
const COORDINATOR = ".github/workflows/issue-lifecycle.yml";
const SHA = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const LIFECYCLE = /^status: /u;

const sha256 = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" ||
        Buffer.isBuffer(value) ||
        value instanceof Uint8Array
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
const scalar = (type, value) => ({ type, value });
const field = (name, value) => ({ name, value });
const nullableString = (value) =>
  value === null ? { type: "null" } : scalar("string", value);

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function commit(value, name) {
  if (!COMMIT.test(value ?? ""))
    throw new TypeError(`${name} must be a lowercase commit SHA`);
  return value;
}

function timestamp(value, name) {
  const match =
    typeof value === "string"
      ? /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.[0-9]+)?Z$/u.exec(
          value,
        )
      : null;
  const parsed = match === null ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new TypeError(`${name} must be a canonical timestamp`);
  const wholeSeconds = new Date(parsed).toISOString().slice(0, 19);
  if (wholeSeconds !== match[1])
    throw new TypeError(`${name} must be a canonical timestamp`);
  return `${wholeSeconds}Z`;
}

function labels(issue) {
  if (!Array.isArray(issue?.labels)) return [];
  return issue.labels.map((label) =>
    typeof label === "string" ? label : label?.name,
  );
}

function soleLifecycle(issue) {
  const states = labels(issue).filter((label) => LIFECYCLE.test(label ?? ""));
  return states.length === 1 ? states[0] : "no-lifecycle";
}

function issueKind(issue) {
  return labels(issue).includes("type: epic") ? "epic" : "implementation";
}

function acceptedReadiness(issue, comments) {
  const record = readinessRecordFromComments(comments);
  const currentFingerprint = semanticIssueFingerprint(
    issue?.body ?? "",
    issue?.title ?? "",
  );
  return record?.status === "accepted" &&
    record.fingerprint === currentFingerprint
    ? record
    : undefined;
}

function exactTarget(issue) {
  const target = issueDeliveryTarget(issue?.body ?? "", issueKind(issue));
  if (
    target !== "dev" &&
    !/^epic\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)*$/u.test(
      target ?? "",
    )
  )
    throw new TypeError("accepted lifecycle target is invalid");
  return target;
}

function pullRequestFacts(pullRequest, target) {
  if (pullRequest === null) return null;
  if (
    !Number.isSafeInteger(pullRequest?.number) ||
    pullRequest.number <= 0 ||
    !COMMIT.test(pullRequest?.head?.sha ?? "") ||
    pullRequest?.base?.ref !== target
  )
    throw new TypeError("pull request facts are invalid");
  return Object.freeze({
    base: pullRequest.base.ref,
    draft: pullRequest.draft === true,
    head: pullRequest.head.sha,
    merged: pullRequest.merged === true,
    number: pullRequest.number,
    state: pullRequest.state,
    updatedAt: pullRequest.updated_at,
  });
}

function generationInputNode(facts) {
  return {
    type: "record",
    fields: [
      field("issueId", scalar("uint", facts.issueId)),
      field("issueUpdatedAt", scalar("string", facts.issueUpdatedAt)),
      field("lifecycle", scalar("string", facts.observedState)),
      field("readinessIdentity", nullableString(facts.readinessIdentity)),
      field("target", scalar("string", facts.exactTarget)),
      field(
        "pullRequest",
        facts.pullRequest === null
          ? { type: "null" }
          : {
              type: "record",
              fields: [
                field("number", scalar("uint", facts.pullRequest.number)),
                field("head", scalar("string", facts.pullRequest.head)),
                field("base", scalar("string", facts.pullRequest.base)),
                field("state", scalar("string", facts.pullRequest.state)),
                field("draft", scalar("bool", facts.pullRequest.draft)),
                field("merged", scalar("bool", facts.pullRequest.merged)),
                field(
                  "updatedAt",
                  scalar("string", facts.pullRequest.updatedAt),
                ),
              ],
            },
      ),
    ],
  };
}

function sourceObservation(facts, generationBytesSha256) {
  return digestAuxiliaryIdentity("source observation", {
    generation_bytes_sha256: generationBytesSha256,
    observed_state: facts.observedState,
    issue_updated_at: facts.issueUpdatedAt,
    readiness_identity: facts.readinessIdentity,
    assignment_identity: facts.assignmentIdentity,
    pr_topology_identity: facts.prTopologyIdentity,
    reviews_identity: facts.reviewsIdentity,
    conversations_identity: facts.conversationsIdentity,
    checks_identity: facts.checksIdentity,
    evidence_identity: facts.evidenceIdentity,
    activation_identity: facts.activationIdentity,
  });
}

function generationProjection(facts, attempt) {
  const value = {
    algorithm: "sha-256",
    attemptSequence: attempt,
    domain: "keiko-native.lifecycle-input-generation",
    head: facts.pullRequest?.head ?? facts.protectedDevSha,
    inputs: generationInputNode(facts),
    lane: "normal",
    pullRequest: facts.pullRequest?.number ?? 0,
    repository: REPOSITORY,
    schema: 1,
    submode: null,
  };
  const bytes = encodeLifecycleGenerationV1(value);
  const identity = digestLifecycleGenerationV1(value);
  return Object.freeze({
    bytes,
    bytesBase64: bytes.toString("base64"),
    bytesSha256: sha256(bytes),
    identity,
  });
}

export function lifecycleCoordinatorGeneration(facts, attempt = 0) {
  if (!Number.isSafeInteger(attempt) || attempt < 0)
    throw new TypeError("generation attempt must be an unsigned safe integer");
  return generationProjection(facts, attempt);
}

function predecessor(records) {
  const tip = records.at(-1);
  return tip === undefined
    ? { commentId: null, recordDigest: null }
    : {
        commentId: positive(tip.comment?.id, "record comment ID"),
        recordDigest: tip.parsed?.recordDigest,
      };
}

function encodedPlan(issueNumber, body) {
  return Buffer.from(
    JSON.stringify({
      issueNumber,
      recordBody: body,
      repository: REPOSITORY,
    }),
  ).toString("base64url");
}

function primaryHeader(recordType) {
  return {
    record_type: recordType,
    schema_version: 1,
    digest_algorithm: "sha-256",
    digest_domain: `keiko-native.lifecycle-record.${recordType}`,
  };
}

function commonFields(facts, generation, attempt) {
  return {
    repository: REPOSITORY,
    issue_number: facts.issueNumber,
    pull_request_number: facts.pullRequest?.number ?? null,
    exact_head_sha: facts.pullRequest?.head ?? null,
    exact_target: facts.exactTarget,
    generation_identity: generation.identity,
    attempt,
  };
}

function generationRequest({ facts, generation, attempt, records, runtime }) {
  const prior = predecessor(records);
  const expectedProducers =
    facts.pullRequest === null
      ? ["issue-contract-current"]
      : ["issue-contract-current", "pr-contract"];
  const requestPayloadDigest = digestAuxiliaryIdentity("request payload", {
    request_kind: "event-reconciliation",
    requested_state: null,
    request_owner: "schedule",
    recovery_target_identity: null,
    reason_code: "activation-disabled",
  });
  const requestIdentity = digestAuxiliaryIdentity("request identity", {
    repository: REPOSITORY,
    issue_number: facts.issueNumber,
    pull_request_number: facts.pullRequest?.number ?? null,
    exact_head_sha: facts.pullRequest?.head ?? null,
    exact_target: facts.exactTarget,
    generation_identity: generation.identity,
    attempt,
    request_payload_digest: requestPayloadDigest,
    expected_producers: expectedProducers,
    predecessor_comment_id: prior.commentId,
    predecessor_record_digest: prior.recordDigest,
  });
  const body = createRecordEnvelope("generation-request", {
    ...primaryHeader("generation-request"),
    ...commonFields(facts, generation, attempt),
    lane: "normal",
    publication_submode: "not-applicable",
    generation_schema: 1,
    generation_bytes_sha256: generation.bytesSha256,
    request_identity: requestIdentity,
    request_payload_digest: requestPayloadDigest,
    expected_producers: expectedProducers,
    source_observation_identity: facts.sourceObservationIdentity,
    predecessor_comment_id: prior.commentId,
    predecessor_record_digest: prior.recordDigest,
    workflow_path: COORDINATOR,
    workflow_run_id: runtime.runId,
    workflow_run_attempt: runtime.runAttempt,
    protected_dev_sha: facts.protectedDevSha,
    recorded_at: runtime.recordedAt,
  });
  return { body, expectedProducers, requestIdentity, requestPayloadDigest };
}

function nextFenceSequence(records, generationIdentity, attempt) {
  return (
    records.filter(
      (record) =>
        record.parsed.recordType === "phase-fence-claim" &&
        record.parsed.fields.generation_identity === generationIdentity &&
        record.parsed.fields.attempt === attempt,
    ).length + 1
  );
}

function inertFenceEnvelope({
  claimOutcome,
  exactHeadSha,
  facts,
  identityFields,
  prior,
  pullRequestNumber,
  requestIdentity,
  runtime,
}) {
  return createRecordEnvelope("phase-fence-claim", {
    ...primaryHeader("phase-fence-claim"),
    repository: REPOSITORY,
    issue_number: facts.issueNumber,
    pull_request_number: pullRequestNumber,
    exact_head_sha: exactHeadSha,
    generation_identity: identityFields.generation_identity,
    attempt: identityFields.attempt,
    request_identity: requestIdentity,
    phase: identityFields.phase,
    fence_sequence: identityFields.fence_sequence,
    fence_identity: digestAuxiliaryIdentity("fence identity", identityFields),
    owner_workflow_path: COORDINATOR,
    owner_run_id: runtime.runId,
    owner_run_attempt: runtime.runAttempt,
    source_observation_identity: facts.sourceObservationIdentity,
    claim_outcome: claimOutcome,
    recovery_scan_identity: null,
    recovery_scanned_page_count: 0,
    recovery_scanned_comment_count: 0,
    recovery_accumulated_suffix_identity: null,
    recovery_provider_cursor: null,
    recovery_scan_complete: false,
    recovery_settlement_identity: null,
    predecessor_comment_id: prior.commentId,
    predecessor_record_digest: prior.recordDigest,
    protected_dev_sha: facts.protectedDevSha,
    recorded_at: runtime.recordedAt,
  });
}

function phaseFence({
  facts,
  generation,
  generationRequestRecord,
  records,
  runtime,
}) {
  const request = generationRequestRecord.parsed.fields;
  const prior = predecessor(records);
  const fenceSequence = nextFenceSequence(
    records,
    generation.identity,
    request.attempt,
  );
  const identityFields = {
    generation_identity: generation.identity,
    attempt: request.attempt,
    phase: "phase-one",
    fence_sequence: fenceSequence,
    owner_workflow_path: COORDINATOR,
    owner_run_id: runtime.runId,
    owner_run_attempt: runtime.runAttempt,
    source_observation_identity: facts.sourceObservationIdentity,
    predecessor_comment_id: prior.commentId,
    predecessor_record_digest: prior.recordDigest,
  };
  return inertFenceEnvelope({
    claimOutcome: "claimed",
    exactHeadSha: facts.pullRequest?.head ?? null,
    facts,
    identityFields,
    prior,
    pullRequestNumber: facts.pullRequest?.number ?? null,
    requestIdentity: request.request_identity,
    runtime,
  });
}

function supersessionFence({
  facts,
  generationRequestRecord,
  records,
  runtime,
}) {
  const request = generationRequestRecord.parsed.fields;
  const prior = predecessor(records);
  const fenceSequence = nextFenceSequence(
    records,
    request.generation_identity,
    request.attempt,
  );
  const identityFields = {
    generation_identity: request.generation_identity,
    attempt: request.attempt,
    phase: "request",
    fence_sequence: fenceSequence,
    owner_workflow_path: COORDINATOR,
    owner_run_id: runtime.runId,
    owner_run_attempt: runtime.runAttempt,
    source_observation_identity: facts.sourceObservationIdentity,
    predecessor_comment_id: prior.commentId,
    predecessor_record_digest: prior.recordDigest,
  };
  return inertFenceEnvelope({
    claimOutcome: "superseded",
    exactHeadSha: request.exact_head_sha,
    facts,
    identityFields,
    prior,
    pullRequestNumber: request.pull_request_number,
    requestIdentity: request.request_identity,
    runtime,
  });
}

function priorCheckpoint(records) {
  const record = records.findLast(
    (candidate) => candidate.parsed.recordType === "transition-read-back",
  );
  if (record === undefined)
    return { commentId: null, recordDigest: null, identity: null, sequence: 0 };
  const fields = record.parsed.fields;
  return {
    commentId: record.comment.id,
    recordDigest: record.parsed.recordDigest,
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
    sequence: fields.checkpoint_sequence,
  };
}

function transitionRecord({
  active,
  facts,
  generation,
  generationRequestRecord,
  phaseFenceRecord,
  producerRecords,
  records,
  runtime,
}) {
  const request = generationRequestRecord.parsed.fields;
  const prior = predecessor(records);
  const checkpoint = priorCheckpoint(records);
  const compactedPrefixIdentity = digestAuxiliaryIdentity("compacted prefix", {
    repository: REPOSITORY,
    issue_number: facts.issueNumber,
    checkpoint_sequence: checkpoint.sequence + 1,
    prior_checkpoint_identity: checkpoint.identity,
    members: active.map((record) => ({
      comment_id: record.comment.id,
      record_digest: record.parsed.recordDigest,
    })),
  });
  const readBackIdentity = digestAuxiliaryIdentity("read-back identity", {
    generation_identity: generation.identity,
    attempt: request.attempt,
    phase_fence_digest: phaseFenceRecord.parsed.recordDigest,
    effect_identity: null,
    observed_state: facts.observedState,
    issue_updated_at: facts.issueUpdatedAt,
    source_observation_identity: facts.sourceObservationIdentity,
  });
  const failedProducer = producerRecords.some(
    (record) => record.parsed.fields.conclusion !== "success",
  );
  return createRecordEnvelope("transition-read-back", {
    ...primaryHeader("transition-read-back"),
    ...commonFields(facts, generation, request.attempt),
    request_identity: request.request_identity,
    phase_fence_comment_id: phaseFenceRecord.comment.id,
    phase_fence_digest: phaseFenceRecord.parsed.recordDigest,
    source_state: facts.observedState,
    desired_state: facts.observedState,
    observed_state: facts.observedState,
    transition_owner: "handoff",
    effect_identity: null,
    read_back_identity: readBackIdentity,
    producer_results: producerRecords.map((record) => ({
      producer: record.parsed.fields.expected_producer,
      comment_id: record.comment.id,
      record_digest: record.parsed.recordDigest,
      workflow_run_id: record.parsed.fields.workflow_run_id,
      workflow_job_id: record.parsed.fields.workflow_job_id,
      result_identity: record.parsed.fields.result_identity,
    })),
    checkpoint_sequence: checkpoint.sequence + 1,
    prior_checkpoint_comment_id: checkpoint.commentId,
    prior_checkpoint_record_digest: checkpoint.recordDigest,
    compacted_prefix_identity: compactedPrefixIdentity,
    outcome: failedProducer ? "failed" : "planned",
    reason_code: failedProducer ? "evidence-incomplete" : "activation-disabled",
    predecessor_comment_id: prior.commentId,
    predecessor_record_digest: prior.recordDigest,
    protected_dev_sha: facts.protectedDevSha,
    recorded_at: runtime.recordedAt,
  });
}

function normalizedRuntime(runtime) {
  return Object.freeze({
    recordedAt: timestamp(runtime?.recordedAt, "recordedAt"),
    runAttempt: positive(runtime?.runAttempt, "run attempt"),
    runId: positive(runtime?.runId, "run ID"),
  });
}

export function lifecycleCoordinatorFacts({
  comments,
  issue,
  protectedDevSha,
  pullRequest = null,
}) {
  positive(issue?.number, "issue number");
  positive(issue?.id, "issue ID");
  const updatedAt = timestamp(issue?.updated_at, "issue updated_at");
  const target = exactTarget(issue);
  const pr = pullRequestFacts(pullRequest, target);
  const readiness = acceptedReadiness(issue, comments);
  const observedState = soleLifecycle(issue);
  const readinessIdentity =
    readiness === undefined
      ? null
      : sha256(
          `${readiness.commentId}:${readiness.version}:${readiness.fingerprint}`,
        );
  const facts = {
    activationIdentity: sha256("disabled"),
    assignmentIdentity: sha256(
      (issue?.assignees ?? [])
        .map((assignee) => assignee?.id)
        .filter(Number.isSafeInteger)
        .toSorted((left, right) => left - right),
    ),
    checksIdentity: sha256(pr === null ? "not-applicable" : pr.head),
    conversationsIdentity: sha256("not-observed"),
    evidenceIdentity: sha256(
      readiness === undefined ? "readiness-missing" : "readiness-current",
    ),
    exactTarget: target,
    issueId: issue.id,
    issueNumber: issue.number,
    issueUpdatedAt: updatedAt,
    observedState,
    prTopologyIdentity: sha256(pr),
    protectedDevSha: commit(protectedDevSha, "protected dev SHA"),
    pullRequest: pr,
    readinessIdentity,
    reviewsIdentity: sha256("not-observed"),
  };
  const initial = generationProjection(facts, 0);
  return Object.freeze({
    ...facts,
    sourceObservationIdentity: sourceObservation(facts, initial.bytesSha256),
  });
}

function activeRecords(records) {
  const boundaryIndex = records.findLastIndex(
    (record) =>
      record.parsed.recordType === "transition-read-back" ||
      (record.parsed.recordType === "phase-fence-claim" &&
        ((record.parsed.fields.phase === "recovery" &&
          record.parsed.fields.claim_outcome === "settled") ||
          record.parsed.fields.claim_outcome === "superseded")),
  );
  return records.slice(boundaryIndex + 1);
}

function checkpointSuffix(records) {
  const checkpointIndex = records.findLastIndex(
    (record) => record.parsed.recordType === "transition-read-back",
  );
  return records.slice(checkpointIndex + 1);
}

function recordOutput(facts, body, writer) {
  return Object.freeze({
    issueNumber: facts.issueNumber,
    kind: "record",
    recordPlan: encodedPlan(facts.issueNumber, body),
    writer,
  });
}

export function planInertLifecycleRecoverySettlement({
  authorizedRecovery,
  facts,
  records = [],
  recoveryAttempt,
  recoverySettlementIdentity,
  runtime,
}) {
  const normalized = normalizedRuntime(runtime);
  if (
    !Array.isArray(records) ||
    !Number.isSafeInteger(recoveryAttempt) ||
    recoveryAttempt <= 0 ||
    !SHA.test(authorizedRecovery?.identity ?? "") ||
    !SHA.test(authorizedRecovery?.recoveryTargetIdentity ?? "") ||
    !SHA.test(recoverySettlementIdentity ?? "")
  )
    throw new TypeError("authenticated recovery settlement is invalid");
  const prior = predecessor(records);
  const priorAttempt = records.reduce(
    (maximum, record) =>
      Math.max(maximum, record?.parsed?.fields?.attempt ?? -1),
    -1,
  );
  if (recoveryAttempt <= priorAttempt)
    throw new TypeError("recovery attempt must advance the record chain");
  const attempt = recoveryAttempt;
  const generation = generationProjection(facts, attempt);
  const requestPayloadDigest = digestAuxiliaryIdentity("request payload", {
    request_kind: "recovery-request",
    requested_state: null,
    request_owner: "recovery",
    recovery_target_identity: authorizedRecovery.recoveryTargetIdentity,
    reason_code: "recovery-required",
  });
  const requestIdentity = digestAuxiliaryIdentity("request identity", {
    repository: REPOSITORY,
    issue_number: facts.issueNumber,
    pull_request_number: facts.pullRequest?.number ?? null,
    exact_head_sha: facts.pullRequest?.head ?? null,
    exact_target: facts.exactTarget,
    generation_identity: generation.identity,
    attempt,
    request_payload_digest: requestPayloadDigest,
    expected_producers: [],
    predecessor_comment_id: prior.commentId,
    predecessor_record_digest: prior.recordDigest,
  });
  const fenceSequence =
    records.filter(
      (record) =>
        record.parsed.recordType === "phase-fence-claim" &&
        record.parsed.fields.generation_identity === generation.identity &&
        record.parsed.fields.attempt === attempt,
    ).length + 1;
  const fenceIdentity = digestAuxiliaryIdentity("fence identity", {
    generation_identity: generation.identity,
    attempt,
    phase: "recovery",
    fence_sequence: fenceSequence,
    owner_workflow_path: COORDINATOR,
    owner_run_id: normalized.runId,
    owner_run_attempt: normalized.runAttempt,
    source_observation_identity: facts.sourceObservationIdentity,
    predecessor_comment_id: prior.commentId,
    predecessor_record_digest: prior.recordDigest,
  });
  return recordOutput(
    facts,
    createRecordEnvelope("phase-fence-claim", {
      ...primaryHeader("phase-fence-claim"),
      repository: REPOSITORY,
      issue_number: facts.issueNumber,
      pull_request_number: facts.pullRequest?.number ?? null,
      exact_head_sha: facts.pullRequest?.head ?? null,
      generation_identity: generation.identity,
      attempt,
      request_identity: requestIdentity,
      phase: "recovery",
      fence_sequence: fenceSequence,
      fence_identity: fenceIdentity,
      owner_workflow_path: COORDINATOR,
      owner_run_id: normalized.runId,
      owner_run_attempt: normalized.runAttempt,
      source_observation_identity: facts.sourceObservationIdentity,
      claim_outcome: "settled",
      recovery_scan_identity: null,
      recovery_scanned_page_count: 0,
      recovery_scanned_comment_count: 0,
      recovery_accumulated_suffix_identity: null,
      recovery_provider_cursor: null,
      recovery_scan_complete: false,
      recovery_settlement_identity: recoverySettlementIdentity,
      predecessor_comment_id: prior.commentId,
      predecessor_record_digest: prior.recordDigest,
      protected_dev_sha: facts.protectedDevSha,
      recorded_at: normalized.recordedAt,
    }),
    "coordinator",
  );
}

export function planInertLifecycleCoordinatorStep({
  facts,
  records = [],
  runtime,
}) {
  const normalized = normalizedRuntime(runtime);
  if (!Array.isArray(records))
    throw new TypeError("records must be an ordered authenticated array");
  const active = activeRecords(records);
  const priorTransition = records.findLast(
    (record) => record.parsed.recordType === "transition-read-back",
  );
  const settlement = records.findLast(
    (record) =>
      record.parsed.recordType === "phase-fence-claim" &&
      record.parsed.fields.phase === "recovery" &&
      record.parsed.fields.claim_outcome === "settled",
  );
  const attempt = settlement?.parsed.fields.attempt ?? 0;
  const generation = generationProjection(facts, attempt);
  if (
    active.length === 0 &&
    priorTransition?.parsed.fields.generation_identity === generation.identity
  )
    return Object.freeze({
      issueNumber: facts.issueNumber,
      kind: "noop",
      observation: priorTransition.parsed.fields.read_back_identity,
    });
  if (active.length === 0) {
    const request = generationRequest({
      facts,
      generation,
      attempt,
      records,
      runtime: normalized,
    });
    return recordOutput(facts, request.body, "coordinator");
  }
  const generationRequestRecord = active[0];
  if (generationRequestRecord.parsed.recordType !== "generation-request")
    throw new TypeError("active generation does not match current facts");
  if (
    generationRequestRecord.parsed.fields.generation_identity !==
    generation.identity
  )
    return recordOutput(
      facts,
      supersessionFence({
        facts,
        generationRequestRecord,
        records,
        runtime: normalized,
      }),
      "coordinator",
    );
  const phaseFenceRecord = active.find(
    (record) => record.parsed.recordType === "phase-fence-claim",
  );
  if (phaseFenceRecord === undefined)
    return recordOutput(
      facts,
      phaseFence({
        facts,
        generation,
        generationRequestRecord,
        records,
        runtime: normalized,
      }),
      "coordinator",
    );
  const producerRecords = active.filter(
    (record) => record.parsed.recordType === "producer-result",
  );
  const expected = generationRequestRecord.parsed.fields.expected_producers;
  const observed = new Set(
    producerRecords.map((record) => record.parsed.fields.expected_producer),
  );
  const nextProducer = expected.find((producer) => !observed.has(producer));
  if (nextProducer !== undefined)
    return Object.freeze({
      issueNumber: facts.issueNumber,
      kind: "producer",
      producer: nextProducer,
      wire: Object.freeze({
        schema_version: "1",
        producer_contract_version: "1",
        repository: REPOSITORY,
        issue_number: String(facts.issueNumber),
        pull_request_number:
          facts.pullRequest === null ? "" : String(facts.pullRequest.number),
        exact_head_sha: facts.pullRequest?.head ?? "",
        exact_target: facts.exactTarget,
        generation_bytes_base64: generation.bytesBase64,
        generation_bytes_sha256: generation.bytesSha256,
        generation_identity: generation.identity,
        attempt: String(generationRequestRecord.parsed.fields.attempt),
        phase_fence_comment_id: String(phaseFenceRecord.comment.id),
        phase_fence_digest: phaseFenceRecord.parsed.recordDigest,
        generation_request_comment_id: String(
          generationRequestRecord.comment.id,
        ),
        generation_request_digest: generationRequestRecord.parsed.recordDigest,
        request_identity:
          generationRequestRecord.parsed.fields.request_identity,
        request_payload_digest:
          generationRequestRecord.parsed.fields.request_payload_digest,
        expected_producer: nextProducer,
      }),
    });
  return recordOutput(
    facts,
    transitionRecord({
      active: checkpointSuffix(records),
      facts,
      generation,
      generationRequestRecord,
      phaseFenceRecord,
      producerRecords,
      records,
      runtime: normalized,
    }),
    "coordinator",
  );
}

export const LIFECYCLE_COORDINATOR_REPOSITORY = REPOSITORY;
export const LIFECYCLE_COORDINATOR_SHA_PATTERN = SHA;
