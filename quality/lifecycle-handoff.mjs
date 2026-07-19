import {
  classifyPublicationLane,
  publicationResultMatrix,
} from "./publication-contract.mjs";
import { verifyPublicationLaneCandidate } from "./lifecycle-handoff-publication.mjs";
export { evaluatePublicationLifecycleHandoff } from "./lifecycle-handoff-publication.mjs";
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
const PR_OPEN = LIFECYCLE_STATES[4];
const REVIEW = LIFECYCLE_STATES[5];
const reject = (code, extra = {}) => ({ code, ok: false, ...extra });
const text = (value) => typeof value === "string" && value.length > 0;
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const same = isDeepStrictEqual;
function receipt(value) {
  return (
    record(value) && text(value.path) && /^[0-9a-f]{64}$/u.test(value.digest)
  );
}
function manifest(value, submode) {
  if (submode === "ordinary") return value === null;
  return submode === "migration" && receipt(value);
}
function commonAuthorityFailure(authority, binding, target) {
  if (
    !record(authority) ||
    !text(authority.id) ||
    !text(authority.issueIdentity) ||
    !text(target)
  )
    return "invalid_authority";
  const keys = ["repository", "pullRequest", "head", "lane"];
  if (keys.some((key) => authority[key] !== binding[key]))
    return "authority_mismatch";
  if (authority.target !== target) return "target_mismatch";
  return undefined;
}
function diffIdentity(diff) {
  return diff.files
    .map(({ mode, path, previous_filename: previous = null, status }) => ({
      mode,
      path,
      previous,
      status,
    }))
    .toSorted((left, right) =>
      left.path < right.path ? -1 : left.path === right.path ? 0 : 1,
    );
}
function normalBinding(authority, binding, target, diff) {
  if (!text(authority.scope)) return reject("invalid_normal_scope");
  return {
    binding: {
      ...binding,
      authority: authority.id,
      contractPaths: [],
      diff,
      issueIdentity: authority.issueIdentity,
      scope: authority.scope,
      target,
    },
    lane: "normal",
    ok: true,
  };
}
function publicationCandidateMatches(accepted, classified, target, diff) {
  const binding = accepted.binding;
  const keys = ["repository", "pullRequest", "base", "head"];
  return (
    accepted.ok === true &&
    keys.every((key) => binding[key] === classified.binding[key]) &&
    binding.target === target &&
    same(diff, diffIdentity(binding.diff)) &&
    same(
      classified.contractPaths.toSorted(),
      binding.candidates.map((candidate) => candidate.path),
    )
  );
}
function publicationAuthorityMatches(authority, classified, accepted) {
  return [
    ["ordinary", "migration"].includes(authority.submode),
    authority.scope === null,
    text(authority.evidence),
    receipt(authority.receipt),
    authority.receipt?.path === classified.receiptPath,
    manifest(authority.manifest, authority.submode),
    authority.submode === accepted.binding.submode,
    same(authority.receipt, accepted.binding.receipt),
    same(authority.manifest, accepted.binding.terminalManifest),
  ].every(Boolean);
}
function publicationLane(authority, classified, { candidate, target }, diff) {
  const accepted = verifyPublicationLaneCandidate(candidate);
  if (
    !publicationCandidateMatches(accepted, classified, target, diff) ||
    !publicationAuthorityMatches(authority, classified, accepted)
  ) {
    return reject("invalid_publication_authority");
  }
  return {
    binding: {
      ...classified.binding,
      authority: authority.id,
      candidate: accepted.binding,
      contractPaths: accepted.binding.candidates.map(({ path }) => path),
      diff,
      evidence: authority.evidence,
      issueIdentity: authority.issueIdentity,
      manifest: authority.manifest,
      receipt: { ...authority.receipt },
      submode: authority.submode,
      target,
    },
    lane: "publication",
    ok: true,
  };
}
export function classifyLifecycleHandoffLane(input) {
  try {
    const classified = classifyPublicationLane(input?.diff);
    if (!classified.ok) return reject("lane_classification_failed");
    const authority = input?.authority;
    const diff = diffIdentity(input.diff);
    const failure = commonAuthorityFailure(
      authority,
      classified.binding,
      input?.target,
    );
    if (failure !== undefined) return reject(failure);
    if (classified.lane === "normal") {
      return authority.lane === "normal"
        ? normalBinding(authority, classified.binding, input.target, diff)
        : reject("lane_authority_mismatch");
    }
    return authority.lane === "publication"
      ? publicationLane(authority, classified, input, diff)
      : reject("lane_authority_mismatch");
  } catch {
    return reject("invalid_lane_evidence");
  }
}
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
    same(Object.keys(generation.results).toSorted(), [...contexts].toSorted()),
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
  if (!record(input) || !record(input.classification)) return undefined;
  if (input.classification.ok !== true) return undefined;
  return input.classification.binding?.lane === "normal"
    ? input.classification
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
  if (!record(phase) || observation === undefined) return false;
  return [
    readiness.current === true,
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
