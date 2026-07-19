import {
  compareLifecycleGenerationDigestV1,
  digestLifecycleGenerationV1,
} from "./lifecycle-generation.mjs";
import { isDeepStrictEqual } from "node:util";
import { isAllowedLifecycleEdge } from "./issue-lifecycle.mjs";
export const HANDOFF_CONTEXTS = Object.freeze({
  normal: Object.freeze(["Issue contract current", "PR contract"]),
  publication: Object.freeze([
    "Contract publication",
    "Issue contract current",
    "PR contract",
  ]),
});
export function createHandoffBinding(classification, generation) {
  return {
    generation: generation.digest,
    laneIdentity: structuredClone(classification.binding),
    prerequisiteResults: Object.fromEntries(
      Object.entries(generation.results).map(
        ([context, { producer, result, workflowRun }]) => [
          context,
          { producer, result, workflowRun },
        ],
      ),
    ),
  };
}
const terminalStates = new Set(["failure", "abandoned"]);
const resultStates = new Set(["pending", "success", ...terminalStates]);
const recoveryKeys =
  "authorized generation head producer result workflowRun".split(" ");
const reject = (code, extra = {}) => ({ code, ok: false, ...extra });
const text = (value) => typeof value === "string" && value.length > 0;
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const same = isDeepStrictEqual;
const typed = (type, value) => ({ type, value });
const field = (name, value) => ({ name, value });
const observationFields = Object.freeze([
  "issueRevision",
  "readiness",
  "lifecycle",
  "target",
  "reviews",
  "conversations",
  "audit",
  "journey",
  "manual",
  "external",
  "platform",
  "upstream",
]);
export function lifecycleObservation(input) {
  if (!record(input)) return undefined;
  if (input.type !== "record") return undefined;
  if (!Array.isArray(input.fields)) return undefined;
  if (input.fields.length !== observationFields.length) return undefined;
  const entries = input.fields.map((item, index) =>
    observationEntry(item, observationFields[index]),
  );
  return entries.includes(undefined) ? undefined : Object.fromEntries(entries);
}
export function validateTransitionBinding(input, classification) {
  const transition = input.transition;
  const before = lifecycleObservation(input.phaseOne.inputs);
  const after = lifecycleObservation(input.generationRequest.inputs);
  if (!record(transition) || before === undefined || after === undefined)
    return false;
  const expected = {
    actorRole: "implementer",
    authority: classification.binding.authority,
    head: classification.binding.head,
    issueIdentity: classification.binding.issueIdentity,
    lockFence: input.phaseOne?.lockFence,
    producer: input.generation?.expectedProducers?.["Lifecycle handoff"],
    pullRequest: classification.binding.pullRequest,
    repository: classification.binding.repository,
    resultRevision: after.issueRevision,
    sourceRevision: before.issueRevision,
    targetRef: classification.binding.target,
  };
  return [
    Object.entries(expected).every(([key, value]) => transition[key] === value),
    transition.applied === true,
    transition.source === "status: pr open",
    transition.target === "status: ready for human review",
    ["eventIdentity", "workflowRun", "result"].every((key) =>
      text(transition[key]),
    ),
    isAllowedLifecycleEdge(transition.source, transition.target),
  ].every(Boolean);
}
function observationEntry(item, name) {
  if (!record(item) || item.name !== name) return undefined;
  if (!record(item.value) || item.value.type !== "string") return undefined;
  return text(item.value.value) ? [name, item.value.value] : undefined;
}
function recoveryNode(recovery) {
  if (recovery === undefined) return { type: "null" };
  const fields = recoveryKeys.map((name) =>
    field(
      name,
      typed(name === "authorized" ? "bool" : "string", recovery[name]),
    ),
  );
  return { fields, type: "record" };
}
function laneInput(binding, inputs, recovery) {
  const nullable = (value) =>
    value === null || value === undefined
      ? { type: "null" }
      : typed("string", value);
  return {
    fields: [
      field("authority", typed("string", binding.authority)),
      field("issueIdentity", typed("string", binding.issueIdentity)),
      field("base", typed("string", binding.base)),
      field("target", typed("string", binding.target)),
      field("scope", nullable(binding.scope)),
      field("evidence", nullable(binding.evidence)),
      field("receiptPath", nullable(binding.receipt?.path)),
      field("receiptDigest", nullable(binding.receipt?.digest)),
      field("manifestPath", nullable(binding.manifest?.path)),
      field("manifestDigest", nullable(binding.manifest?.digest)),
      field("contractPaths", {
        items: binding.contractPaths.map((path) => typed("string", path)),
        type: "set",
      }),
      field("diff", {
        items: binding.diff.map((entry) => ({
          fields: [
            field("path", typed("string", entry.path)),
            field("status", typed("string", entry.status)),
            field("mode", typed("string", entry.mode)),
            field("previous", nullable(entry.previous)),
          ],
          type: "record",
        })),
        type: "set",
      }),
      field("expectedProducers", {
        entries: Object.entries(binding.expectedProducers).map(
          ([key, value]) => ({
            key: typed("string", key),
            value: typed("string", value),
          }),
        ),
        type: "map",
      }),
      field("recovery", recoveryNode(recovery)),
      field("observations", inputs),
    ],
    type: "record",
  };
}

function generationValue(input) {
  const binding = {
    ...input.classification.binding,
    expectedProducers: input.expectedProducers,
  };
  return {
    algorithm: "sha-256",
    attemptSequence: input.attemptSequence,
    domain: "keiko-native.lifecycle-input-generation",
    head: binding.head,
    inputs: laneInput(binding, input.inputs, input.recovery),
    lane: binding.lane,
    pullRequest: binding.pullRequest,
    repository: binding.repository,
    schema: 1,
    submode: binding.submode ?? null,
  };
}
function validProducerMap(map, contexts) {
  return (
    record(map) &&
    text(map["Lifecycle handoff"]) &&
    contexts.every((context) => text(map[context]))
  );
}
export function matchesCurrentLifecycleGeneration(generation, input) {
  try {
    const contexts = generationContexts(input);
    if (contexts === undefined || !record(generation)) return false;
    const value = generationValue(input);
    return (
      generation.digest === digestLifecycleGenerationV1(value) &&
      compareLifecycleGenerationDigestV1(value, generation.digest) &&
      generation.attemptSequence === input.attemptSequence &&
      same(generation.expectedProducers, input.expectedProducers)
    );
  } catch {
    return false;
  }
}
const startPlans = (generation, contexts) =>
  contexts.map((context) => ({
    context,
    generation: generation.digest,
    head: generation.head,
    producer: generation.expectedProducers[context],
  }));
function newGeneration(input, value, digest, contexts) {
  const generation = {
    attemptSequence: input.attemptSequence,
    digest,
    expectedProducers: { ...input.expectedProducers },
    head: input.classification.binding.head,
    lane: input.classification.binding.lane,
    results: {},
    request: structuredClone({
      attemptSequence: input.attemptSequence,
      classification: input.classification,
      expectedProducers: input.expectedProducers,
      inputs: input.inputs,
      recovery: input.recovery,
    }),
    status: "pending",
    submode: input.classification.binding.submode ?? null,
    value,
  };
  return {
    decision: "start",
    generation,
    ok: true,
    starts: startPlans(generation, contexts),
    value,
  };
}
function validPriorShape(prior) {
  return (
    record(prior) &&
    Number.isSafeInteger(prior.attemptSequence) &&
    prior.attemptSequence >= 0 &&
    record(prior.results) &&
    resultStates.has(prior.status)
  );
}
function validPrior(prior) {
  if (!validPriorShape(prior)) return false;
  if (!record(prior.value) || !record(prior.request)) return false;
  const contexts = generationContexts(prior.request);
  if (contexts === undefined) return false;
  const value = generationValue(prior.request);
  if (!validPriorProjection(prior, value)) return false;
  return validPriorResults(prior, contexts);
}
function validPriorProjection(prior, value) {
  return [
    same(value, prior.value),
    compareLifecycleGenerationDigestV1(value, prior.digest),
    prior.attemptSequence === value.attemptSequence,
    prior.head === value.head,
    prior.lane === value.lane,
    prior.submode === value.submode,
    same(prior.expectedProducers, prior.request.expectedProducers),
  ].every(Boolean);
}
function validPriorResults(prior, contexts) {
  const keys = Object.keys(prior.results);
  if (keys.some((context) => !contexts.includes(context))) return false;
  if (
    keys.some(
      (context) =>
        completionFailure(prior.results[context], prior, contexts) !==
        undefined,
    )
  )
    return false;
  return prior.status === nextStatus(prior.results, contexts);
}
function generationContexts(input) {
  if (!record(input)) return undefined;
  if (!record(input.classification)) return undefined;
  if (input.classification.ok !== true) return undefined;
  const contexts = HANDOFF_CONTEXTS[input.classification.binding?.lane];
  if (contexts === undefined) return undefined;
  if (!Number.isSafeInteger(input.attemptSequence)) return undefined;
  if (input.attemptSequence < 0) return undefined;
  if (!validProducerMap(input.expectedProducers, contexts)) return undefined;
  return validObservationTarget(input) ? contexts : undefined;
}
const validObservationTarget = (input) =>
  lifecycleObservation(input.inputs)?.target ===
  input.classification.binding.target;
function recoveryFailure(input) {
  const attemptChanged = input.attemptSequence !== input.prior.attemptSequence;
  if (!attemptChanged) return undefined;
  const recovery = Object(input.recovery);
  if (!terminalStates.has(input.prior.status)) return "recovery_not_terminal";
  if (input.attemptSequence !== input.prior.attemptSequence + 1)
    return "recovery_attempt_mismatch";
  const invalid = [
    !record(recovery) || !same(Object.keys(recovery), recoveryKeys),
    recovery.authorized !== true,
    recovery.generation !== input.prior.digest,
    recovery.head !== input.prior.head,
    recovery.producer !== input.expectedProducers["Lifecycle handoff"],
    !text(recovery.workflowRun),
    !text(recovery.result),
  ].some(Boolean);
  if (invalid) return "recovery_not_authorized";
  return undefined;
}
function existingGeneration(input, value, digest, contexts) {
  if (!validPrior(input.prior))
    return reject("invalid_prior_generation", { starts: [] });
  if (digest !== input.prior.digest) {
    const failure = recoveryFailure(input);
    return failure === undefined
      ? newGeneration(input, value, digest, contexts)
      : reject(failure, { starts: [] });
  }
  if (input.completion !== undefined)
    return attachCompletion(input, input.prior, contexts);
  return {
    decision: terminalStates.has(input.prior.status) ? "terminal" : "noop",
    generation: input.prior,
    ok: true,
    starts: [],
  };
}
function completionFailure(completion, generation, contexts) {
  if (!record(completion) || !contexts.includes(completion.context))
    return "invalid_completion_context";
  if (
    completion.generation !== generation.digest ||
    completion.head !== generation.head ||
    completion.producer !== generation.expectedProducers[completion.context]
  )
    return "completion_identity_mismatch";
  if (
    !text(completion.workflowRun) ||
    !text(completion.result) ||
    !resultStates.has(completion.conclusion)
  )
    return "invalid_completion_result";
  return undefined;
}
function nextStatus(results, contexts) {
  const conclusions = contexts.map((context) => results[context]?.conclusion);
  if (conclusions.includes("failure")) return "failure";
  if (conclusions.includes("abandoned")) return "abandoned";
  return conclusions.every((value) => value === "success")
    ? "success"
    : "pending";
}
function attachCompletion(input, prior, contexts) {
  const failure = completionFailure(input.completion, prior, contexts);
  if (failure !== undefined) return reject(failure, { starts: [] });
  const existing = prior.results[input.completion.context];
  if (existing !== undefined) {
    if (same(existing, input.completion))
      return { decision: "noop", generation: prior, ok: true, starts: [] };
    const identity = ({
      context,
      generation,
      head,
      producer,
      result,
      workflowRun,
    }) => ({ context, generation, head, producer, result, workflowRun });
    if (
      existing.conclusion !== "pending" ||
      !same(identity(existing), identity(input.completion))
    )
      return reject("contradictory_completion", { starts: [] });
  }
  const generation = {
    ...prior,
    results: { ...prior.results, [input.completion.context]: input.completion },
  };
  generation.status = nextStatus(generation.results, contexts);
  return { decision: "attach", generation, ok: true, starts: [] };
}
export function coalesceLifecycleInputGeneration(input) {
  try {
    const contexts = generationContexts(input);
    if (contexts === undefined) return reject("invalid_generation_request");
    const value = generationValue(input);
    const digest = digestLifecycleGenerationV1(value);
    if (input.prior === undefined) {
      if (input.attemptSequence !== 0 || input.recovery !== undefined)
        return reject("invalid_initial_attempt", { starts: [] });
      if (input.completion !== undefined)
        return reject("orphan_completion", { starts: [] });
      return newGeneration(input, value, digest, contexts);
    }
    if (
      input.attemptSequence === input.prior.attemptSequence &&
      !same(input.recovery, input.prior.request.recovery)
    )
      return reject("recovery_identity_mismatch", { starts: [] });
    return existingGeneration(input, value, digest, contexts);
  } catch {
    return reject("invalid_generation_evidence", { starts: [] });
  }
}
