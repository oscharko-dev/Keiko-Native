// prettier-ignore
import { publicationResultMatrix } from "./publication-contract.mjs";
import { classifyLifecycleHandoffLane } from "./lifecycle-handoff-publication.mjs";
export {
  classifyLifecycleHandoffLane,
  evaluatePublicationLifecycleHandoff,
} from "./lifecycle-handoff-publication.mjs";
import {
  HANDOFF_CONTEXTS as CONTEXTS,
  createHandoffBinding,
  lifecycleObservation,
  matchesCurrentLifecycleGeneration,
  validateTransitionBinding,
} from "./lifecycle-handoff-generation.mjs";
export { coalesceLifecycleInputGeneration } from "./lifecycle-handoff-generation.mjs";
import { evaluateCurrentReadiness } from "./issue-lifecycle-readiness.mjs";
import {
  LIFECYCLE_STATES,
  verifyStatusLabelReadback,
} from "./issue-lifecycle.mjs";
import { isDeepStrictEqual } from "node:util";
const [PR_OPEN, REVIEW] = LIFECYCLE_STATES.slice(4, 6);
const reject = (code, extra = {}) => ({ code, ok: false, ...extra });
const text = (value) => typeof value === "string" && value.length > 0;
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const same = isDeepStrictEqual;
const compareText = (left, right) => left.localeCompare(right);
function validProducerMap(map, contexts) {
  return record(map) && contexts.every((context) => text(map[context]));
}
function generationResultsShape(generation, classification, contexts, request) {
  if (!record(generation)) return false;
  return [
    generation.status === "success",
    generation.head === classification.binding.head,
    generation.lane === classification.binding.lane,
    generation.submode === (classification.binding.submode ?? null),
    record(generation.results),
    same(
      Object.keys(generation.results).toSorted(compareText),
      [...contexts].toSorted(compareText),
    ),
    validProducerMap(generation.expectedProducers, contexts),
    same(request?.classification, classification),
    matchesCurrentLifecycleGeneration(generation, request),
  ].every(Boolean);
}
function validResult(result, context, generation) {
  return (
    result?.conclusion === "success" &&
    result.context === context &&
    result.generation === generation.digest &&
    result.head === generation.head &&
    result.producer === generation.expectedProducers[context] &&
    text(result.workflowRun) &&
    text(result.result)
  );
}
function verifiedResults(generation, classification, contexts, request) {
  if (!generationResultsShape(generation, classification, contexts, request))
    return false;
  if (
    !contexts.every((context) =>
      validResult(generation.results[context], context, generation),
    )
  )
    return false;
  const runs = contexts.map(
    (context) => generation.results[context].workflowRun,
  );
  const results = contexts.map((context) => generation.results[context].result);
  return (
    new Set(runs).size === contexts.length &&
    new Set(results).size === contexts.length
  );
}
function normalFailure(status = "failure", downgrade = false) {
  return reject("normal_handoff_ineligible", {
    status,
    ...(downgrade ? { target: PR_OPEN } : {}),
  });
}
function phaseOneEligible(input, classification) {
  const phase = input.phaseOne;
  const readiness = evaluateCurrentReadiness(input.readiness);
  return (
    readiness.current === true &&
    phaseSnapshotsCurrent(input, readiness) &&
    phaseEvidenceCurrent(phase) &&
    phase.sourceState === PR_OPEN &&
    phase.head === classification.binding.head &&
    phase.target === classification.binding.target
  );
}
function phaseEvidenceCurrent(phase) {
  if (!record(phase)) return false;
  return [
    phase.ok === true,
    phase.reviewsCurrent === true,
    phase.conversationsCurrent === true,
    phase.evidenceCurrent === true,
    text(phase.lockFence),
    same(phase.excludedContexts, ["Lifecycle handoff"]),
  ].every(Boolean);
}
function readinessIdentity(readiness) {
  const record = readiness.record;
  return `${record.commentId}:${record.version}:${record.fingerprint}`;
}
function phaseSnapshotsCurrent(input, readiness) {
  const before = lifecycleObservation(input.phaseOne?.inputs);
  const after = lifecycleObservation(input.generationRequest?.inputs);
  if (before === undefined || after === undefined) return false;
  if (before.lifecycle !== PR_OPEN || after.lifecycle !== REVIEW) return false;
  if (after.readiness !== readinessIdentity(readiness)) return false;
  const stable = ({ issueRevision: revision, lifecycle, ...value }) => value;
  return (
    before.issueRevision !== after.issueRevision &&
    same(stable(before), stable(after))
  );
}
function downgradeEligible(input, classification) {
  const phase = input.phaseOne;
  return (
    evaluateCurrentReadiness(input.readiness).current === true &&
    [PR_OPEN, REVIEW].includes(phase?.sourceState) &&
    phase.head === classification.binding.head &&
    phase.target === classification.binding.target
  );
}
function readbackEligible(readback, binding, transition, revision) {
  if (!record(readback) || !record(transition)) return false;
  const result = verifyStatusLabelReadback({
    actualIssueIdentity: readback.actualIssueIdentity,
    desiredState: REVIEW,
    expectedIssueIdentity: readback.expectedIssueIdentity,
    labels: readback.labels,
  });
  return [
    result.ok,
    text(readback.issueRevision),
    text(readback.transitionIdentity),
    text(transition.resultRevision),
    text(transition.eventIdentity),
    readback.expectedIssueIdentity === binding.issueIdentity,
    transition.issueIdentity === binding.issueIdentity,
    readback.head === binding.head,
    readback.issueRevision === revision,
    readback.issueRevision === transition.resultRevision,
    readback.transitionIdentity === transition.eventIdentity,
  ].every(Boolean);
}
function normalClassification(input) {
  const classification = input?.classification;
  if (!record(classification) || classification.ok !== true) return undefined;
  const recomputed = classifyLifecycleHandoffLane(input?.laneInput);
  return classification.binding?.lane === "normal" &&
    same(recomputed, classification)
    ? classification
    : undefined;
}
function normalDecision(input, classification, transition) {
  const status = input.generation?.status;
  if (status !== "success")
    return normalFailure(status === "pending" ? "pending" : "failure", true);
  if (
    !verifiedResults(
      input.generation,
      classification,
      CONTEXTS.normal,
      input.generationRequest,
    )
  )
    return normalFailure("failure", true);
  const results = input.generation.results;
  const exact = { binding: classification.binding, ok: true };
  let outputsCurrent = false;
  try {
    outputsCurrent = CONTEXTS.normal.every((context) =>
      same(results[context].output, exact),
    );
  } catch {
    return normalFailure("failure", true);
  }
  if (!outputsCurrent) return normalFailure("failure", true);
  const matrix = publicationResultMatrix({
    classification,
    normal: {
      issueContractCurrent: results["Issue contract current"].output,
      prContract: results["PR contract"].output,
    },
  });
  return matrix.lane === "normal" &&
    matrix.contexts["Issue contract current"] === "success" &&
    matrix.contexts["PR contract"] === "success"
    ? {
        binding: {
          ...createHandoffBinding(classification, input.generation),
          eventIdentity: transition.eventIdentity,
          lockFence: transition.lockFence,
          resultRevision: transition.resultRevision,
          sourceRevision: transition.sourceRevision,
        },
        ok: true,
        status: "success",
        target: REVIEW,
      }
    : normalFailure("failure", true);
}
function stableReviewDecision(input, classification) {
  const readiness = evaluateCurrentReadiness(input.readiness);
  const observation = lifecycleObservation(input.generationRequest?.inputs);
  const valid =
    stableReviewEvidence(input, classification, readiness, observation) &&
    stableHandoffCurrent(input, classification, input.existingHandoff);
  if (!valid) return normalFailure("failure", true);
  const decision = normalDecision(input, classification, input.existingHandoff);
  return decision.ok ? { ...decision, decision: "noop" } : decision;
}
function stableReviewEvidence(input, classification, readiness, observation) {
  const phase = input.phaseOne;
  if (readiness.current !== true) return false;
  if (!record(phase) || observation === undefined) return false;
  return [
    observation.lifecycle === REVIEW,
    observation.readiness === readinessIdentity(readiness),
    same(phase.inputs, input.generationRequest.inputs),
    phaseEvidenceCurrent(phase),
    phase.head === classification.binding.head,
    phase.target === classification.binding.target,
    readbackEligible(
      input.readback,
      classification.binding,
      input.existingHandoff,
      observation.issueRevision,
    ),
  ].every(Boolean);
}
function stableHandoffCurrent(input, classification, handoff) {
  if (!record(handoff) || !record(input.generation)) return false;
  const binding = classification.binding;
  return [
    handoff.status === "success",
    handoff.generation === input.generation.digest,
    handoff.authority === binding.authority,
    handoff.head === binding.head,
    handoff.issueIdentity === binding.issueIdentity,
    handoff.lockFence === input.phaseOne?.lockFence,
    handoff.pullRequest === binding.pullRequest,
    handoff.repository === binding.repository,
    handoff.targetRef === binding.target,
    handoff.producer ===
      input.generation.expectedProducers["Lifecycle handoff"],
    text(handoff.eventIdentity),
    text(handoff.resultRevision),
    text(handoff.sourceRevision),
    text(handoff.workflowRun),
    text(handoff.result),
  ].every(Boolean);
}
export function evaluateNormalLifecycleHandoff(input) {
  try {
    const classification = normalClassification(input);
    if (classification === undefined) return normalFailure();
    if (input.phaseOne?.sourceState === REVIEW)
      return stableReviewDecision(input, classification);
    if (!phaseOneEligible(input, classification))
      return normalFailure("failure", downgradeEligible(input, classification));
    if (!validateTransitionBinding(input, classification))
      return normalFailure("failure", true);
    if (
      !readbackEligible(
        input.readback,
        classification.binding,
        input.transition,
        lifecycleObservation(input.generationRequest?.inputs)?.issueRevision,
      )
    )
      return normalFailure("failure", true);
    return normalDecision(input, classification, input.transition);
  } catch {
    return normalFailure();
  }
}
