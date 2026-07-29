import { lifecycleCoordinatorGeneration } from "./lifecycle-coordinator.mjs";
import {
  createRecordEnvelope,
  digestAuxiliaryIdentity,
} from "./lifecycle-record-protocol.mjs";
import { validateLifecycleProducerWire } from "./lifecycle-producer-wire.mjs";

const REPOSITORY = "oscharko-dev/Keiko-Native";
const PATHS = Object.freeze({
  "issue-contract-current": ".github/workflows/pr-contract.yml",
  "pr-contract": ".github/workflows/pr-contract.yml",
  "contract-publication": ".github/workflows/contract-publication.yml",
});
const RESULT_NAMES = Object.freeze({
  "issue-contract-current": "Issue contract current",
  "pr-contract": "PR contract",
  "contract-publication": "Contract publication",
});
const CONCLUSIONS = new Set([
  "success",
  "failure",
  "cancelled",
  "timed-out",
  "unavailable",
]);
const REASONS = new Set([
  "ok",
  "activation-disabled",
  "not-applicable",
  "unauthorized",
  "invalid-schema",
  "malformed-record",
  "stale-generation",
  "fence-lost",
  "producer-mismatch",
  "evidence-incomplete",
  "provider-rejected",
  "provider-conflict",
  "provider-rate-limited",
  "provider-timeout",
  "provider-unavailable",
  "read-back-mismatch",
  "ambiguous-effect",
  "recovery-required",
  "superseded",
]);
const SHA = /^[0-9a-f]{64}$/u;

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new TypeError("recordedAt must be a timestamp");
  return new Date(value).toISOString().replace(".000Z", "Z");
}

function activeRecords(records) {
  const boundary = records.findLastIndex(
    (record) =>
      record.parsed.recordType === "transition-read-back" ||
      (record.parsed.recordType === "phase-fence-claim" &&
        record.parsed.fields.phase === "recovery" &&
        record.parsed.fields.claim_outcome === "settled"),
  );
  return records.slice(boundary + 1);
}

function exactRecord(records, type, commentId, digest) {
  const matches = records.filter(
    (record) =>
      record.parsed.recordType === type &&
      record.comment.id === commentId &&
      record.parsed.recordDigest === digest,
  );
  if (matches.length !== 1)
    throw new TypeError(`${type} wire identity is unavailable`);
  return matches[0];
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

function validEvaluation(evaluation, producer) {
  return (
    positive(evaluation?.providerResultId, "provider result ID") &&
    evaluation.resultName === RESULT_NAMES[producer] &&
    CONCLUSIONS.has(evaluation.conclusion) &&
    REASONS.has(evaluation.reasonCode) &&
    SHA.test(evaluation.payloadDigest ?? "") &&
    (evaluation.providerResultSha === null ||
      /^[0-9a-f]{40}$/u.test(evaluation.providerResultSha ?? ""))
  );
}

export function planInertLifecycleProducerResult({
  evaluation,
  facts,
  records,
  runtime,
  wire: rawWire,
}) {
  if (!Array.isArray(records))
    throw new TypeError("records must be an authenticated ordered array");
  const wire = validateLifecycleProducerWire(rawWire, {
    acceptedTarget: facts.exactTarget,
    pullRequestBase: facts.pullRequest?.base,
  });
  const attempt = Number(wire.attempt);
  const generation = lifecycleCoordinatorGeneration(facts, attempt);
  if (
    generation.bytesBase64 !== wire.generation_bytes_base64 ||
    generation.bytesSha256 !== wire.generation_bytes_sha256 ||
    generation.identity !== wire.generation_identity
  )
    throw new TypeError("producer generation does not match current facts");
  const active = activeRecords(records);
  const request = exactRecord(
    active,
    "generation-request",
    Number(wire.generation_request_comment_id),
    wire.generation_request_digest,
  );
  const fence = exactRecord(
    active,
    "phase-fence-claim",
    Number(wire.phase_fence_comment_id),
    wire.phase_fence_digest,
  );
  if (
    request.parsed.fields.generation_identity !== generation.identity ||
    request.parsed.fields.request_identity !== wire.request_identity ||
    request.parsed.fields.request_payload_digest !==
      wire.request_payload_digest ||
    fence.parsed.fields.generation_identity !== generation.identity ||
    fence.parsed.fields.request_identity !== wire.request_identity ||
    fence.parsed.fields.claim_outcome !== "claimed"
  )
    throw new TypeError("producer request or fence is stale");
  const producerRecords = active.filter(
    (record) =>
      record.parsed.recordType === "producer-result" &&
      record.parsed.fields.generation_identity === generation.identity &&
      record.parsed.fields.attempt === attempt,
  );
  const observed = new Set(
    producerRecords.map((record) => record.parsed.fields.expected_producer),
  );
  const next = request.parsed.fields.expected_producers.find(
    (producer) => !observed.has(producer),
  );
  if (next !== wire.expected_producer)
    throw new TypeError("producer invocation is duplicated or reordered");
  if (!validEvaluation(evaluation, next))
    throw new TypeError("producer evaluation is invalid");
  const predecessor = records.at(-1);
  if (predecessor === undefined)
    throw new TypeError("producer predecessor is unavailable");
  const runtimeFields = {
    workflow_id: positive(runtime?.workflowId, "workflow ID"),
    workflow_run_id: positive(runtime?.runId, "run ID"),
    workflow_run_attempt: positive(runtime?.runAttempt, "run attempt"),
    workflow_job_id: positive(runtime?.jobId, "job ID"),
  };
  const providerObservationIdentity = digestAuxiliaryIdentity(
    "provider observation",
    {
      expected_producer: next,
      generation_identity: generation.identity,
      exact_head_sha: facts.pullRequest?.head ?? null,
      phase_fence_digest: fence.parsed.recordDigest,
      provider_result_id: evaluation.providerResultId,
      provider_result_name: evaluation.resultName,
      provider_result_conclusion: evaluation.conclusion,
      provider_result_sha: evaluation.providerResultSha,
      producer_payload_digest: evaluation.payloadDigest,
    },
  );
  const identityFields = {
    expected_producer: next,
    producer_contract_version: 1,
    generation_identity: generation.identity,
    attempt,
    phase_fence_digest: fence.parsed.recordDigest,
    workflow_path: PATHS[next],
    ...runtimeFields,
    provider_observation_identity: providerObservationIdentity,
    conclusion: evaluation.conclusion,
    reason_code: evaluation.reasonCode,
  };
  const resultIdentity = digestAuxiliaryIdentity(
    "result identity",
    identityFields,
  );
  const body = createRecordEnvelope("producer-result", {
    record_type: "producer-result",
    schema_version: 1,
    digest_algorithm: "sha-256",
    digest_domain: "keiko-native.lifecycle-record.producer-result",
    repository: REPOSITORY,
    issue_number: facts.issueNumber,
    pull_request_number: facts.pullRequest?.number ?? null,
    exact_head_sha: facts.pullRequest?.head ?? null,
    exact_target: facts.exactTarget,
    generation_identity: generation.identity,
    attempt,
    request_identity: request.parsed.fields.request_identity,
    generation_request_comment_id: request.comment.id,
    generation_request_digest: request.parsed.recordDigest,
    phase_fence_comment_id: fence.comment.id,
    phase_fence_digest: fence.parsed.recordDigest,
    expected_producer: next,
    producer_contract_version: 1,
    workflow_path: PATHS[next],
    ...runtimeFields,
    result_identity: resultIdentity,
    protected_dev_sha: facts.protectedDevSha,
    provider_observation_identity: providerObservationIdentity,
    conclusion: evaluation.conclusion,
    reason_code: evaluation.reasonCode,
    predecessor_comment_id: predecessor.comment.id,
    predecessor_record_digest: predecessor.parsed.recordDigest,
    recorded_at: canonicalTimestamp(runtime?.recordedAt),
  });
  return Object.freeze({
    issueNumber: facts.issueNumber,
    recordPlan: encodedPlan(facts.issueNumber, body),
    resultIdentity,
  });
}

export const LIFECYCLE_PRODUCER_PATHS = PATHS;
export const LIFECYCLE_PRODUCER_RESULT_NAMES = RESULT_NAMES;
