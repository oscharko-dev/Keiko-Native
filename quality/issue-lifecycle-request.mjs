import { createHash } from "node:crypto";

import { LIFECYCLE_STATES } from "./issue-lifecycle.mjs";

export const LIFECYCLE_REQUEST_SCHEMA =
  "keiko-native.issue-lifecycle-request/v1";
export const LIFECYCLE_OBSERVATION_SCHEMA =
  "keiko-native.issue-lifecycle-observation/v1";
export const LIFECYCLE_OBSERVATION_MARKER =
  "<!-- keiko-native-lifecycle-observation:v1 -->";

const githubActionsBot = Object.freeze({
  id: 41898282,
  login: "github-actions[bot]",
  type: "Bot",
});
const requestTargets = new Set([
  LIFECYCLE_STATES[1],
  LIFECYCLE_STATES[2],
  LIFECYCLE_STATES[6],
  LIFECYCLE_STATES[7],
]);
const requestSources = new Set(LIFECYCLE_STATES.slice(0, 8));
const requestIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const runIdPattern = /^[1-9][0-9]{0,19}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const actorPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const eventIdentityPattern =
  /^[1-9][0-9]{0,19}:[1-9][0-9]{0,19}:[0-9a-f]{64}$/u;
const observationOutcomes = new Set([
  "applied",
  "failed",
  "ignored",
  "planned",
]);
const observationActivations = new Set(["disabled", "enabled"]);
const observationReadinessClasses = new Set([
  "closed",
  "current",
  "forged",
  "malformed",
  "mismatched",
  "missing",
  "not-applicable",
  "reopened",
  "replayed",
  "semantic-edit",
  "stale",
  "superseded",
  "unavailable",
  "unclassified-edit",
  "unreachable",
  "wording-edit",
]);
const observationTopologyClasses = new Set([
  "accepted",
  "not-applicable",
  "rejected",
]);
const observationMutationResults = new Set([
  "applied",
  "failed",
  "guarded-off",
  "not-attempted",
]);
const observationReadbackResults = new Set([
  "not-attempted",
  "not-verified",
  "verified",
]);
const observationDesiredStates = new Set([
  ...LIFECYCLE_STATES,
  "not-applicable",
]);

function digest(domain, value) {
  return createHash("sha256")
    .update(`${domain}\0${value}`, "utf8")
    .digest("hex");
}

function compactText(value, maximum) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  )
    return undefined;
  return trimmed;
}

function positiveInteger(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/u.test(value))
    return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function failure(failures) {
  return { failures, ok: false };
}

export function parseLifecycleDispatchRequest({
  actor,
  event,
  protectedRef,
  repository,
  runAttempt,
  runId,
}) {
  const failures = [];
  const inputs = event?.inputs;
  const issueNumber = positiveInteger(inputs?.issue_number);
  const expectedSource = inputs?.expected_source;
  const requestedTarget = inputs?.requested_target;
  const requestIdentity = compactText(inputs?.request_identity, 128);
  const reason = compactText(inputs?.reason, 512);
  const sender = compactText(event?.sender?.login, 100);

  if (inputs?.schema !== LIFECYCLE_REQUEST_SCHEMA)
    failures.push("unsupported_request_schema");
  if (issueNumber === undefined) failures.push("invalid_issue_number");
  if (!requestSources.has(expectedSource))
    failures.push("invalid_expected_source");
  if (!requestTargets.has(requestedTarget))
    failures.push("invalid_requested_target");
  if (
    requestIdentity === undefined ||
    !requestIdentityPattern.test(requestIdentity)
  )
    failures.push("invalid_request_identity");
  if (sender === undefined || sender !== actor)
    failures.push("authenticated_actor_mismatch");
  if (event?.repository?.full_name !== repository)
    failures.push("repository_identity_mismatch");
  if (event?.ref !== "dev" || protectedRef !== "refs/heads/dev")
    failures.push("protected_ref_required");
  if (!runIdPattern.test(runId ?? "") || !runIdPattern.test(runAttempt ?? ""))
    failures.push("provider_event_identity_missing");
  if (
    [LIFECYCLE_STATES[6], LIFECYCLE_STATES[7]].includes(requestedTarget) &&
    reason === undefined
  )
    failures.push("request_reason_required");
  if (
    ![LIFECYCLE_STATES[6], LIFECYCLE_STATES[7]].includes(requestedTarget) &&
    (inputs?.reason ?? "").trim() !== ""
  )
    failures.push("request_reason_not_permitted");
  if (
    requestedTarget === LIFECYCLE_STATES[1] &&
    inputs?.ordering_attestation !== "confirmed"
  )
    failures.push("ordering_attestation_required");
  if (
    requestedTarget !== LIFECYCLE_STATES[1] &&
    inputs?.ordering_attestation !== "not-applicable"
  )
    failures.push("ordering_attestation_not_applicable");
  if (failures.length > 0) return failure([...new Set(failures)]);

  const requestIdentityDigest = digest(
    "keiko-native.lifecycle-request-identity",
    requestIdentity,
  );
  const reasonDigest =
    reason === undefined
      ? "none"
      : digest("keiko-native.lifecycle-request-reason", reason);
  const requestDigest = digest(
    "keiko-native.lifecycle-request",
    JSON.stringify([
      LIFECYCLE_REQUEST_SCHEMA,
      repository,
      issueNumber,
      expectedSource,
      requestedTarget,
      sender,
      requestIdentityDigest,
      reasonDigest,
      inputs.ordering_attestation,
    ]),
  );
  return {
    failures: [],
    ok: true,
    request: Object.freeze({
      actor: sender,
      eventIdentity: `${runId}:${runAttempt}:${requestIdentityDigest}`,
      expectedSource,
      issueNumber,
      orderingAttestation: inputs.ordering_attestation,
      reason,
      requestDigest,
      requestIdentityDigest,
      requestedTarget,
      schema: LIFECYCLE_REQUEST_SCHEMA,
    }),
  };
}

function trustedObservationComment(comment) {
  return (
    comment?.body?.includes(LIFECYCLE_OBSERVATION_MARKER) &&
    comment?.user?.id === githubActionsBot.id &&
    comment?.user?.login === githubActionsBot.login &&
    comment?.user?.type === githubActionsBot.type
  );
}

function observationLine(body, label, pattern) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const tick = "`";
  return new RegExp(
    `^- ${escapedLabel}: ${tick}(${pattern})${tick}$`,
    "mu",
  ).exec(body)?.[1];
}

function canonicalIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function parsedLifecycleObservation(comment) {
  if (
    !trustedObservationComment(comment) ||
    typeof comment.body !== "string" ||
    comment.body.length > 4096 ||
    !Number.isSafeInteger(comment.id) ||
    comment.id <= 0
  )
    return undefined;
  const body = comment.body;
  const issueNumber = positiveInteger(
    observationLine(body, "Issue", "[1-9][0-9]{0,9}"),
  );
  const observation = {
    activation: observationLine(body, "Activation", "disabled|enabled"),
    actor: observationLine(body, "Actor", "[A-Za-z0-9-]{1,39}"),
    desiredState: observationLine(
      body,
      "Desired state",
      "status: [a-z ]+|not-applicable",
    ),
    eventIdentity: observationLine(
      body,
      "Event identity",
      "[1-9][0-9]{0,19}:[1-9][0-9]{0,19}:[0-9a-f]{64}",
    ),
    issueNumber,
    mutationResult: observationLine(
      body,
      "Mutation result",
      "applied|failed|guarded-off|not-attempted",
    ),
    observedAt: observationLine(
      body,
      "Evaluated at",
      "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z",
    ),
    outcome: observationLine(body, "Outcome", "applied|failed|ignored|planned"),
    requestDigest: observationLine(body, "Request digest", "[0-9a-f]{64}"),
    requestIdentityDigest: observationLine(
      body,
      "Request identity digest",
      "[0-9a-f]{64}",
    ),
    readbackResult: observationLine(
      body,
      "Read-back result",
      "not-attempted|not-verified|verified",
    ),
    readinessClass: observationLine(body, "Readiness class", "[a-z-]+"),
    requestedTarget: observationLine(
      body,
      "Requested target",
      "status: [a-z ]+",
    ),
    schema: observationLine(
      body,
      "Schema",
      "keiko-native\\.issue-lifecycle-observation/v1",
    ),
    sourceState: observationLine(body, "Source", "status: [a-z ]+"),
    topologyClass: observationLine(
      body,
      "Topology class",
      "accepted|not-applicable|rejected",
    ),
  };
  if (
    issueNumber === undefined ||
    observation.schema !== LIFECYCLE_OBSERVATION_SCHEMA ||
    !digestPattern.test(observation.requestDigest ?? "") ||
    !digestPattern.test(observation.requestIdentityDigest ?? "") ||
    !eventIdentityPattern.test(observation.eventIdentity ?? "") ||
    !actorPattern.test(observation.actor ?? "") ||
    !requestSources.has(observation.sourceState) ||
    !requestTargets.has(observation.requestedTarget) ||
    !observationDesiredStates.has(observation.desiredState) ||
    !observationActivations.has(observation.activation) ||
    !observationOutcomes.has(observation.outcome) ||
    !observationReadinessClasses.has(observation.readinessClass) ||
    !observationTopologyClasses.has(observation.topologyClass) ||
    !observationMutationResults.has(observation.mutationResult) ||
    !observationReadbackResults.has(observation.readbackResult) ||
    !canonicalIsoTimestamp(observation.observedAt)
  )
    return undefined;
  return lifecycleObservationComment(observation) === body
    ? Object.freeze(observation)
    : undefined;
}

export function lifecycleObservationRecords(comments) {
  return (Array.isArray(comments) ? comments : [])
    .map((comment) => ({
      comment,
      observation: parsedLifecycleObservation(comment),
    }))
    .filter(({ observation }) => observation !== undefined)
    .map(({ comment, observation }) => ({
      commentId: comment.id,
      issueNumber: observation.issueNumber,
      requestDigest: observation.requestDigest,
      requestIdentityDigest: observation.requestIdentityDigest,
    }));
}

export function lifecycleRequestReplay(comments, request) {
  if (
    (Array.isArray(comments) ? comments : []).some(
      (comment) =>
        trustedObservationComment(comment) &&
        parsedLifecycleObservation(comment) === undefined,
    )
  )
    return "malformed_lifecycle_observation";
  const records = lifecycleObservationRecords(comments);
  if (
    records.some(
      (record) =>
        record.requestIdentityDigest === request.requestIdentityDigest &&
        record.requestDigest !== request.requestDigest,
    )
  )
    return "request_identity_conflict";
  if (
    records.some(
      (record) =>
        record.requestIdentityDigest === request.requestIdentityDigest ||
        record.requestDigest === request.requestDigest,
    )
  )
    return "duplicate_or_replayed_request";
  return undefined;
}

function observationValue(value, allowed, fallback = "not-applicable") {
  return allowed.has(value) ? value : fallback;
}

export function lifecycleObservation({
  activation,
  issueNumber,
  now,
  request,
  result,
}) {
  return Object.freeze({
    activation: observationValue(
      activation,
      new Set(["disabled", "enabled"]),
      "disabled",
    ),
    actor: request.actor,
    desiredState: observationValue(
      result?.desiredState,
      new Set(LIFECYCLE_STATES),
    ),
    eventIdentity: request.eventIdentity,
    issueNumber,
    mutationResult:
      activation !== "enabled"
        ? "guarded-off"
        : observationValue(
            result?.mutationResult ??
              (result?.outcome === "applied"
                ? "applied"
                : result?.outcome === "failed"
                  ? "failed"
                  : "not-attempted"),
            observationMutationResults,
            "failed",
          ),
    observedAt: now.toISOString(),
    outcome: observationValue(
      result?.outcome,
      new Set(["applied", "failed", "ignored", "planned"]),
      "failed",
    ),
    requestDigest: request.requestDigest,
    requestIdentityDigest: request.requestIdentityDigest,
    readbackResult:
      activation !== "enabled"
        ? "not-attempted"
        : observationValue(
            result?.readbackResult ??
              (result?.outcome === "applied" ? "verified" : "not-attempted"),
            observationReadbackResults,
          ),
    readinessClass: observationValue(
      result?.readiness?.current === true
        ? "current"
        : result?.readiness?.reason?.replaceAll("_", "-"),
      observationReadinessClasses,
    ),
    requestedTarget: request.requestedTarget,
    schema: LIFECYCLE_OBSERVATION_SCHEMA,
    sourceState: request.expectedSource,
    topologyClass: observationValue(
      result?.topologyClass ??
        (result?.desiredState !== undefined
          ? "accepted"
          : result?.outcome === "failed"
            ? "rejected"
            : "not-applicable"),
      observationTopologyClasses,
    ),
  });
}

export function lifecycleObservationComment(observation) {
  return [
    LIFECYCLE_OBSERVATION_MARKER,
    "### Lifecycle request observation",
    "",
    `- Schema: \`${observation.schema}\``,
    `- Issue: \`${observation.issueNumber}\``,
    `- Request identity digest: \`${observation.requestIdentityDigest}\``,
    `- Request digest: \`${observation.requestDigest}\``,
    `- Event identity: \`${observation.eventIdentity}\``,
    `- Actor: \`${observation.actor}\``,
    `- Source: \`${observation.sourceState}\``,
    `- Requested target: \`${observation.requestedTarget}\``,
    `- Desired state: \`${observation.desiredState}\``,
    `- Readiness class: \`${observation.readinessClass}\``,
    `- Topology class: \`${observation.topologyClass}\``,
    `- Activation: \`${observation.activation}\``,
    `- Outcome: \`${observation.outcome}\``,
    `- Mutation result: \`${observation.mutationResult}\``,
    `- Read-back result: \`${observation.readbackResult}\``,
    `- Evaluated at: \`${observation.observedAt}\``,
    "",
    "This bounded record contains no issue body, request reason, provider response, endpoint, or credential material.",
  ].join("\n");
}

export function trustedLifecycleObservation(comment, expectedBody) {
  return (
    comment.body === expectedBody &&
    parsedLifecycleObservation(comment) !== undefined
  );
}
