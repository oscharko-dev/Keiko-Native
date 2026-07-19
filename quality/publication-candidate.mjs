import { classifyPublicationLane } from "./publication-contract.mjs";
import {
  decodeSnapshotReceipt,
  samePublicationBytes,
  validateSnapshotReceipt,
} from "./publication-contract-schema.mjs";
import { contractSha256 } from "./repository-contract.mjs";

const inputKeys = [
  "diff",
  "issueObservations",
  "newlyAdded",
  "pullRequest",
  "receipt",
  "repository",
  "target",
  "terminalManifest",
];
const diffKeys = [
  "base",
  "complete",
  "files",
  "head",
  "normalValidated",
  "pullRequest",
  "repository",
  "truncated",
];
const pullRequestKeys = [
  "base",
  "baseRef",
  "head",
  "merged",
  "number",
  "state",
];
const evidenceKeys = ["base", "entries", "head", "pullRequest", "repository"];
const entryKeys = ["bytes", "mode", "path"];
const receiptKeys = ["bytes", "digest", "path"];
const manifestKeys = [
  "base",
  "bytes",
  "digest",
  "entries",
  "mode",
  "path",
  "repository",
];
const rejectionMessage = "Publication candidate evidence failed closed.";

function reject(code) {
  return { ok: false, rejection: { code, message: rejectionMessage } };
}
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function exactKeys(value, expected) {
  if (!record(value)) return false;
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const sha = (value) =>
  typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
const digest = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const repositoryIdentity = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const comparePaths = (left, right) => left.localeCompare(right);

function pullRequestFailure(pullRequest) {
  if (!exactKeys(pullRequest, pullRequestKeys)) return "invalid_pull_request";
  return positiveInteger(pullRequest.number) &&
    sha(pullRequest.base) &&
    sha(pullRequest.head) &&
    pullRequest.base !== pullRequest.head &&
    pullRequest.baseRef === "dev" &&
    pullRequest.state === "open" &&
    pullRequest.merged === false
    ? undefined
    : "invalid_pull_request";
}
function inputIdentityFailure(input) {
  if (!exactKeys(input, inputKeys)) return "invalid_candidate_input";
  if (!repositoryIdentity(input.repository) || input.target !== "dev")
    return "invalid_candidate_authority";
  return pullRequestFailure(input.pullRequest);
}
function diffContext(input) {
  const diff = input.diff;
  const pullRequest = input.pullRequest;
  if (!exactKeys(diff, diffKeys)) return { failure: "invalid_candidate_diff" };
  if (
    diff.repository !== input.repository ||
    diff.pullRequest !== pullRequest.number ||
    diff.base !== pullRequest.base ||
    diff.head !== pullRequest.head
  )
    return { failure: "candidate_diff_identity_mismatch" };
  const classification = classifyPublicationLane(diff);
  return classification.ok === true && classification.lane === "publication"
    ? { classification }
    : { failure: "candidate_diff_rejected" };
}
function validEntry(entry) {
  return (
    exactKeys(entry, entryKeys) &&
    entry.mode === "100644" &&
    entry.bytes instanceof Uint8Array &&
    typeof entry.path === "string"
  );
}
function addedEntries(input) {
  const evidence = input.newlyAdded;
  const pullRequest = input.pullRequest;
  if (!exactKeys(evidence, evidenceKeys) || !Array.isArray(evidence.entries))
    return { failure: "invalid_added_evidence" };
  if (
    evidence.repository !== input.repository ||
    evidence.pullRequest !== pullRequest.number ||
    evidence.base !== pullRequest.base ||
    evidence.head !== pullRequest.head ||
    evidence.entries.some((entry) => !validEntry(entry))
  )
    return { failure: "invalid_added_evidence" };
  const paths = evidence.entries.map((entry) => entry.path);
  const lexical = paths.every(
    (path, index) => index === 0 || paths[index - 1] < path,
  );
  return lexical && new Set(paths).size === paths.length
    ? { entries: new Map(evidence.entries.map((entry) => [entry.path, entry])) }
    : { failure: "noncanonical_added_evidence" };
}
function receiptContext(input, classification, entries) {
  const receipt = input.receipt;
  if (!exactKeys(receipt, receiptKeys))
    return { failure: "invalid_candidate_receipt" };
  const entry = entries.get(receipt.path);
  const hash = contractSha256(receipt.bytes);
  if (
    receipt.path !== classification.receiptPath ||
    !digest(receipt.digest) ||
    hash.ok !== true ||
    hash.digest !== receipt.digest ||
    entry === undefined ||
    !samePublicationBytes(receipt.bytes, entry.bytes)
  )
    return { failure: "invalid_candidate_receipt" };
  const validation = validateSnapshotReceipt(
    decodeSnapshotReceipt(receipt),
    input.repository,
  );
  if (validation.ok !== true)
    return { failure: "invalid_candidate_receipt_schema" };
  if (validation.binding.pullRequest !== input.pullRequest.number)
    return { failure: "receipt_pull_request_mismatch" };
  return { validation };
}
function candidateSetFailure(input, classification, validation, entries) {
  const candidates = validation.binding.candidates;
  const expectedPaths = [
    ...candidates.map((candidate) => candidate.path),
    input.receipt.path,
  ].sort(comparePaths);
  const diffPaths = input.diff.files
    .map((file) => file.path)
    .sort(comparePaths);
  if (
    entries.size !== candidates.length + 1 ||
    !same([...entries.keys()], expectedPaths) ||
    !same(diffPaths, expectedPaths) ||
    !same(
      [...classification.contractPaths].sort(comparePaths),
      candidates.map((candidate) => candidate.path),
    )
  )
    return "candidate_set_mismatch";
  for (const candidate of candidates) {
    const entry = entries.get(candidate.path);
    if (
      entry === undefined ||
      entry.mode !== candidate.mode ||
      contractSha256(entry.bytes).digest !== candidate.digest
    )
      return "candidate_bytes_mismatch";
  }
  return undefined;
}
function validManifestIdentity(manifest, input, binding) {
  return (
    exactKeys(manifest, manifestKeys) &&
    manifest.base === input.pullRequest.base &&
    manifest.repository === input.repository &&
    manifest.mode === "100644" &&
    manifest.path === binding.terminalManifest.path &&
    manifest.digest === binding.terminalManifest.digest
  );
}
function manifestFailure(input, validation) {
  const binding = validation.binding;
  if (binding.submode === "ordinary")
    return input.terminalManifest === null
      ? undefined
      : "unexpected_terminal_manifest";
  const manifest = input.terminalManifest;
  return validManifestIdentity(manifest, input, binding) &&
    contractSha256(manifest.bytes).digest === manifest.digest &&
    same(manifest.entries, binding.observations)
    ? undefined
    : "terminal_manifest_mismatch";
}
function cloneObservation(observation) {
  return {
    ...observation,
    lifecycleLabels: [...observation.lifecycleLabels],
    linkedPullRequest:
      observation.linkedPullRequest === null
        ? null
        : { ...observation.linkedPullRequest },
    predecessor:
      observation.predecessor === null ? null : { ...observation.predecessor },
    recoveries: observation.recoveries.map((recovery) => ({ ...recovery })),
  };
}
function normalizedBinding(input, validation) {
  const binding = validation.binding;
  return {
    base: input.pullRequest.base,
    candidates: binding.candidates.map((candidate) => ({ ...candidate })),
    diff: {
      ...input.diff,
      files: input.diff.files.map((file) => ({ ...file })),
    },
    head: input.pullRequest.head,
    lane: "publication",
    observations: binding.observations.map(cloneObservation),
    pullRequest: input.pullRequest.number,
    receipt: { digest: input.receipt.digest, path: input.receipt.path },
    repository: input.repository,
    submode: binding.submode,
    target: input.target,
    terminalManifest:
      binding.terminalManifest === null
        ? null
        : { ...binding.terminalManifest },
  };
}
export function verifyPublicationCandidate(input) {
  try {
    const identity = inputIdentityFailure(input);
    if (identity !== undefined) return reject(identity);
    const diff = diffContext(input);
    if (diff.failure !== undefined) return reject(diff.failure);
    const added = addedEntries(input);
    if (added.failure !== undefined) return reject(added.failure);
    const receipt = receiptContext(input, diff.classification, added.entries);
    if (receipt.failure !== undefined) return reject(receipt.failure);
    if (!same(input.issueObservations, receipt.validation.binding.observations))
      return reject("issue_observation_mismatch");
    const candidates = candidateSetFailure(
      input,
      diff.classification,
      receipt.validation,
      added.entries,
    );
    if (candidates !== undefined) return reject(candidates);
    const manifest = manifestFailure(input, receipt.validation);
    if (manifest !== undefined) return reject(manifest);
    return {
      binding: normalizedBinding(input, receipt.validation),
      ok: true,
    };
  } catch {
    return reject("invalid_publication_candidate_evidence");
  }
}
