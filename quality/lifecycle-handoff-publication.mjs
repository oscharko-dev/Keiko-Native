import { isDeepStrictEqual } from "node:util";
import {
  HANDOFF_CONTEXTS,
  createHandoffBinding,
  matchesCurrentLifecycleGeneration,
} from "./lifecycle-handoff-generation.mjs";
import { verifyPublicationCandidate } from "./publication-candidate.mjs";
import { publicationResultMatrix } from "./publication-contract.mjs";

const contexts = HANDOFF_CONTEXTS.publication;
const message = "Publication handoff evidence failed closed.";
const same = isDeepStrictEqual;
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0;
const compareText = (left, right) => left.localeCompare(right);
const reject = (code) => ({ code, message, ok: false });

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

function resultMatches(result, context, generation) {
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
    Object(result.output).readinessClaim !== true,
  ].every(Boolean);
}

function uniqueResultIdentities(generation) {
  const results = contexts.map((context) => generation.results[context]);
  const unique = (select) =>
    new Set(results.map((result) => select(result))).size === contexts.length;
  return (
    unique((result) => result.producer) &&
    unique((result) => result.workflowRun) &&
    unique((result) => result.result)
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
      resultMatches(generation.results[context], context, generation),
    )
  )
    return false;
  if (!uniqueResultIdentities(generation)) return false;
  return same(generation.results["Contract publication"].output, accepted);
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
