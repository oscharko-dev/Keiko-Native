import { isDeepStrictEqual } from "node:util";
import {
  HANDOFF_CONTEXTS,
  createHandoffBinding,
  matchesCurrentLifecycleGeneration,
} from "./lifecycle-handoff-generation.mjs";
import { verifyPublicationCandidate } from "./publication-candidate.mjs";
import {
  classifyPublicationLane,
  publicationResultMatrix,
} from "./publication-contract.mjs";

const contexts = HANDOFF_CONTEXTS.publication;
const message = "Publication handoff evidence failed closed.";
const same = isDeepStrictEqual;
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0;
const compareText = (left, right) => left.localeCompare(right);
const compareDiff = (left, right) => compareText(left.path, right.path);
const reject = (code) => ({ code, message, ok: false });
const laneReject = (code) => ({ code, ok: false });

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
  const identity = [authority?.id, authority?.issueIdentity, target];
  if (!record(authority) || !identity.every(text)) return "invalid_authority";
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
    .toSorted(compareDiff);
}
function normalBinding(authority, binding, target, diff) {
  if (![authority.evidence, authority.scope].every(text))
    return laneReject("invalid_normal_scope");
  return {
    binding: {
      ...binding,
      authority: authority.id,
      contractPaths: [],
      diff,
      evidence: authority.evidence,
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
  )
    return laneReject("invalid_publication_authority");
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
      scope: authority.scope,
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
    if (!classified.ok) return laneReject("lane_classification_failed");
    const authority = input?.authority;
    const diff = diffIdentity(input.diff);
    const failure = commonAuthorityFailure(
      authority,
      classified.binding,
      input?.target,
    );
    if (failure !== undefined) return laneReject(failure);
    if (classified.lane === "normal")
      return authority.lane === "normal"
        ? normalBinding(authority, classified.binding, input.target, diff)
        : laneReject("lane_authority_mismatch");
    return authority.lane === "publication"
      ? publicationLane(authority, classified, input, diff)
      : laneReject("lane_authority_mismatch");
  } catch {
    return laneReject("invalid_lane_evidence");
  }
}

function classificationMatches(classification, accepted) {
  classification = Object(classification);
  const binding = Object(classification.binding);
  const expected = accepted.binding;
  return [
    classification.ok === true,
    classification.lane === "publication",
    binding.lane === "publication",
    same(binding.candidate, expected),
    binding.repository === expected.repository,
    binding.pullRequest === expected.pullRequest,
    binding.base === expected.base,
    binding.head === expected.head,
    binding.target === expected.target,
    binding.submode === expected.submode,
    same(binding.receipt, expected.receipt),
    same(binding.manifest, expected.terminalManifest),
    same(
      binding.contractPaths,
      expected.candidates.map((candidate) => candidate.path),
    ),
  ].every(Boolean);
}

function generationMatches(input) {
  const generation = input.generation;
  const request = input.generationRequest;
  return (
    record(generation) &&
    generation.status === "success" &&
    generation.lane === "publication" &&
    generation.head === input.classification.binding.head &&
    generation.submode === input.classification.binding.submode &&
    record(generation.results) &&
    record(generation.expectedProducers) &&
    same(Object(request).classification, input.classification) &&
    matchesCurrentLifecycleGeneration(generation, request)
  );
}

function resultMatches(result, context, generation, accepted) {
  result = Object(result);
  return [
    result.conclusion === "success",
    result.context === context,
    result.generation === generation.digest,
    result.head === generation.head,
    result.producer === generation.expectedProducers[context],
    text(result.producer),
    text(result.workflowRun),
    text(result.result),
    Object(result.output).ok === true,
    Object(result.output).readinessClaim !== true,
    same(result.output, accepted),
  ].every(Boolean);
}

function uniqueRunAndResultIdentities(generation) {
  const results = contexts.map((context) => generation.results[context]);
  const unique = (select) =>
    new Set(results.map((result) => select(result))).size === contexts.length;
  return (
    unique((result) => result.workflowRun) && unique((result) => result.result)
  );
}

function authenticatedResults(input, accepted) {
  const generation = input.generation;
  if (!generationMatches(input)) return false;
  if (
    !same(
      Object.keys(generation.results).sort(compareText),
      [...contexts].sort(compareText),
    )
  )
    return false;
  if (
    !contexts.every((context) =>
      resultMatches(generation.results[context], context, generation, accepted),
    )
  )
    return false;
  return uniqueRunAndResultIdentities(generation);
}

function successfulMatrix(classification, accepted) {
  const matrix = publicationResultMatrix({
    classification,
    publication: accepted,
  });
  const expected = {
    "Contract publication": "success",
    "Issue contract current": "success",
    "PR contract": "success",
  };
  return (
    matrix.ok === true &&
    matrix.lane === "publication" &&
    matrix.readinessClaim === false &&
    same(matrix.contexts, expected)
  );
}

export function verifyPublicationLaneCandidate(candidate) {
  const accepted = verifyPublicationCandidate(candidate);
  return accepted.ok === true
    ? structuredClone(accepted)
    : reject("publication_candidate_rejected");
}

export function evaluatePublicationLifecycleHandoff(input) {
  try {
    if (!record(input)) return reject("invalid_publication_input");
    const recomputed = classifyLifecycleHandoffLane(input.laneInput);
    if (
      recomputed.ok !== true ||
      recomputed.lane !== "publication" ||
      !same(recomputed, input.classification)
    )
      return reject("publication_classification_mismatch");
    const accepted = verifyPublicationLaneCandidate(input.candidate);
    if (accepted.ok !== true) return reject("publication_candidate_rejected");
    if (!classificationMatches(input.classification, accepted))
      return reject("publication_classification_mismatch");
    if (!authenticatedResults(input, accepted))
      return reject("publication_result_mismatch");
    if (!successfulMatrix(input.classification, accepted))
      return reject("publication_matrix_failed");
    return {
      binding: createHandoffBinding(input.classification, input.generation),
      lifecycleMutations: [],
      ok: true,
      readinessClaim: false,
      status: "success",
    };
  } catch {
    return reject("invalid_publication_evidence");
  }
}
