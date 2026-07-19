import { parseContractPath } from "./repository-contract.mjs";
const keys = (value) => value.split(" ");
const rootKeys =
  "candidates observations pullRequest target terminalManifest".split(" ");
const observationKeys = keys(
  "candidatePath fingerprint lifecycleLabels linkedPullRequest number predecessor " +
    "readiness readinessProducer recoveries revision state type version",
);
const candidateKeys = ["digest", "mode", "path"],
  bindingKeys = ["digest", "path"];
const linkedPullRequestKeys = ["head", "number", "target"];
const readinessPattern =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)#issuecomment-[1-9]\d*$/u;
const readinessProducer = "issue-readiness.yml@protected-dev";
const manifestPattern = /^docs\/qa\/[a-z0-9-]+-v[1-9]\d*\.md$/u;
const actorPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const retainedLifecycle =
  /^status: (?:ready|in progress|pr open|ready for human review|blocked|waiting for user)$/u;
const prTrackedLifecycle = /^status: (?:pr open|ready for human review)$/u;
const reject = (code) => ({
  ok: false,
  rejection: { code, message: "Snapshot receipt failed closed." },
});
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value) =>
  typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
export const samePublicationBytes = (left, right) =>
  left instanceof Uint8Array &&
  right instanceof Uint8Array &&
  Buffer.from(left).equals(Buffer.from(right));
export function decodeSnapshotReceipt(receipt) {
  if (!record(receipt) || !(receipt.bytes instanceof Uint8Array))
    return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      receipt.bytes,
    );
    if (!text.endsWith("\n")) return undefined;
    const value = JSON.parse(text);
    return text === `${JSON.stringify(value)}\n` ? value : undefined;
  } catch {
    return undefined;
  }
}
export function publicationEntryMap(evidence, repository) {
  if (
    !record(evidence) ||
    evidence.repository !== repository ||
    !Array.isArray(evidence.entries)
  )
    return undefined;
  const entries = new Map();
  for (const entry of evidence.entries) {
    if (
      !record(entry) ||
      typeof entry.path !== "string" ||
      entry.mode !== "100644" ||
      !(entry.bytes instanceof Uint8Array) ||
      entries.has(entry.path)
    )
      return undefined;
    entries.set(entry.path, entry);
  }
  return entries;
}
export function publicationEvidenceMaps(input) {
  const added = publicationEntryMap(input.newlyAdded, input.repository);
  const publishing = publicationEntryMap(
    input.publishingTree,
    input.repository,
  );
  const current = publicationEntryMap(input.currentTree, input.repository);
  const invalid =
    added === undefined ||
    publishing === undefined ||
    current === undefined ||
    input.newlyAdded.pullRequest !== input.pullRequest.number ||
    input.newlyAdded.base !== input.pullRequest.base ||
    input.newlyAdded.head !== input.pullRequest.head ||
    input.publishingTree.commit !== input.commit.sha ||
    input.currentTree.commit !== input.protectedDev.tip;
  return invalid
    ? { failure: "invalid_tree_evidence" }
    : { added, current, publishing };
}
const validPullRequest = (pr, commit) =>
  record(pr) &&
  positiveInteger(pr.number) &&
  sha(pr.base) &&
  sha(pr.head) &&
  sha(pr.mergeSha) &&
  pr.mergeSha === commit?.sha &&
  pr.state === "closed" &&
  pr.merged === true &&
  pr.baseRef === "dev";
const validVerification = (verification, commit) =>
  record(verification) &&
  verification.verified === true &&
  verification.reason === "valid" &&
  typeof commit.signedPayload === "string" &&
  verification.payload === commit.signedPayload &&
  verification.signer === "github-web-flow";
const validMergeActor = (input, pr, verification) =>
  verification.signer !== pr.mergedBy &&
  typeof pr.mergedBy === "string" &&
  actorPattern.test(pr.mergedBy) &&
  Array.isArray(input.allowlistedMergers) &&
  input.allowlistedMergers.includes(pr.mergedBy);
const validMergeProof = (group, pr, commit) =>
  record(group) &&
  group.base === pr.base &&
  group.head === pr.head &&
  sha(group.prefixTree) &&
  sha(group.resultTree) &&
  Array.isArray(commit.parents) &&
  commit.parents.length === 1 &&
  commit.parents[0].sha === pr.base &&
  commit.parents[0].tree === group.prefixTree &&
  commit.tree === group.resultTree;
export function publicationIdentityFailure(input) {
  if (
    !record(input) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository)
  ) {
    return "invalid_publication_identity";
  }
  const { commit, pullRequest: pr, validatedGroup: group } = input;
  if (!validPullRequest(pr, commit)) return "invalid_pull_request_identity";
  const verification = commit.verification;
  if (
    !validVerification(verification, commit) ||
    !validMergeActor(input, pr, verification)
  ) {
    return "invalid_signature_or_actor";
  }
  if (!validMergeProof(group, pr, commit)) {
    return "invalid_isolated_merge_proof";
  }
  return undefined;
}
export function publicationAncestryFailure(input) {
  const evidence = input.protectedDev;
  return !record(evidence) ||
    evidence.repository !== input.repository ||
    evidence.ancestor !== input.commit.sha ||
    evidence.reachable !== true ||
    !sha(evidence.tip)
    ? "invalid_protected_dev_ancestry"
    : undefined;
}
const exactKeys = (value, expected) =>
  record(value) &&
  JSON.stringify(Object.keys(value)) === JSON.stringify(expected);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const digest = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
function sortedUnique(values, identity) {
  const identities = values.map(identity);
  return (
    new Set(identities).size === identities.length &&
    identities.every(
      (item, index) => index === 0 || identities[index - 1] < item,
    )
  );
}
const contractBinding = (value) =>
  exactKeys(value, bindingKeys) &&
  digest(value.digest) &&
  parseContractPath(value.path).ok;
const manifestBinding = (value) =>
  exactKeys(value, bindingKeys) &&
  digest(value.digest) &&
  manifestPattern.test(value.path);
function candidateFailure(candidate) {
  return exactKeys(candidate, candidateKeys) &&
    parseContractPath(candidate.path).ok &&
    digest(candidate.digest) &&
    candidate.mode === "100644"
    ? undefined
    : "invalid_candidate";
}
function bindingSetFailure(bindings) {
  if (
    !Array.isArray(bindings) ||
    bindings.some((item) => !contractBinding(item))
  )
    return "invalid_binding_set";
  return sortedUnique(bindings, (item) => item.path)
    ? undefined
    : "noncanonical_binding_set";
}
function lifecycleFailure(labels) {
  return Array.isArray(labels) &&
    labels.length === 1 &&
    typeof labels[0] === "string" &&
    labels[0].startsWith("status: ")
    ? undefined
    : "invalid_lifecycle_labels";
}
function observationIdentityFailure(observation) {
  const parsed = parseContractPath(observation.candidatePath);
  if (!parsed.ok) return "invalid_observation_identity";
  const identity = parsed.contract;
  return identity.issue === observation.number &&
    identity.type === observation.type &&
    identity.version === observation.version &&
    identity.revision === observation.revision
    ? undefined
    : "candidate_identity_mismatch";
}
const validObservationCore = (observation) =>
  positiveInteger(observation.number) &&
  positiveInteger(observation.version) &&
  positiveInteger(observation.revision) &&
  digest(observation.fingerprint) &&
  observation.state === "open" &&
  lifecycleFailure(observation.lifecycleLabels) === undefined;
const validLinkedPullRequest = (value) =>
  value === null ||
  (exactKeys(value, linkedPullRequestKeys) &&
    sha(value.head) &&
    positiveInteger(value.number) &&
    typeof value.target === "string" &&
    value.target.trim() !== "");
function readinessFailure(observation, repository) {
  const match =
    typeof observation.readiness === "string"
      ? readinessPattern.exec(observation.readiness)
      : null;
  const absent =
    observation.readiness === null && observation.readinessProducer === null;
  const present =
    match !== null &&
    match[1] === repository &&
    Number(match[2]) === observation.number &&
    observation.readinessProducer === readinessProducer;
  return absent || present ? undefined : "invalid_readiness_identity";
}
function observationFailure(observation, repository) {
  if (!exactKeys(observation, observationKeys)) return "invalid_observation";
  if (!validObservationCore(observation)) return "invalid_observation";
  const readiness = readinessFailure(observation, repository);
  if (readiness !== undefined) return readiness;
  if (!validLinkedPullRequest(observation.linkedPullRequest))
    return "invalid_linked_pull_request";
  if (
    observation.predecessor !== null &&
    !contractBinding(observation.predecessor)
  ) {
    return "invalid_predecessor";
  }
  return (
    observationIdentityFailure(observation) ??
    bindingSetFailure(observation.recoveries)
  );
}
function validHistoryTransition(prior, current, same, start, item, candidate) {
  const predecessor = item.predecessor;
  return (
    (prior === null ||
      (prior.issue === current.issue &&
        [prior.version, prior.version + 1].includes(current.version) &&
        (!same || prior.type === current.type))) &&
    (predecessor === null || predecessor.digest !== candidate.digest) &&
    start <= current.revision &&
    item.recoveries.length === current.revision - start
  );
}
const validRecoveryIdentity = (identity, current, start) =>
  identity.issue === current.issue &&
  identity.type === current.type &&
  identity.version === current.version &&
  identity.revision >= start &&
  identity.revision < current.revision;
function historyFailure(observation, candidate) {
  const current = parseContractPath(observation.candidatePath).contract;
  const predecessor = observation.predecessor;
  const prior =
    predecessor === null ? null : parseContractPath(predecessor.path).contract;
  const same = prior?.version === current.version;
  const start = same ? prior.revision + 1 : 1;
  if (
    !validHistoryTransition(prior, current, same, start, observation, candidate)
  )
    return "invalid_history_transition";
  const digests = new Set([candidate.digest, predecessor?.digest]);
  for (const recovery of observation.recoveries) {
    const identity = parseContractPath(recovery.path).contract;
    if (
      !validRecoveryIdentity(identity, current, start) ||
      digests.has(recovery.digest)
    )
      return "invalid_recovery_history";
    digests.add(recovery.digest);
  }
  return undefined;
}
function receiptShapeFailure(receipt) {
  if (!exactKeys(receipt, rootKeys)) return "invalid_receipt_schema";
  if (receipt.target !== "dev" || !positiveInteger(receipt.pullRequest))
    return "invalid_receipt_authority";
  if (
    !Array.isArray(receipt.observations) ||
    receipt.observations.length === 0 ||
    !Array.isArray(receipt.candidates) ||
    receipt.candidates.length === 0
  ) {
    return "empty_receipt_set";
  }
  if (
    receipt.terminalManifest !== null &&
    !manifestBinding(receipt.terminalManifest)
  )
    return "invalid_terminal_manifest";
  return undefined;
}
function observationSetFailure(observations, repository) {
  for (const observation of observations) {
    const failure = observationFailure(observation, repository);
    if (failure !== undefined) return failure;
  }
  return sortedUnique(observations, (item) =>
    String(item.number).padStart(16, "0"),
  )
    ? undefined
    : "noncanonical_observation_set";
}
function candidateSetFailure(candidates) {
  for (const candidate of candidates) {
    const failure = candidateFailure(candidate);
    if (failure !== undefined) return failure;
  }
  const digests = new Set(candidates.map((candidate) => candidate.digest));
  if (digests.size !== candidates.length) return "duplicate_candidate_digest";
  return sortedUnique(candidates, (item) => item.path)
    ? undefined
    : "noncanonical_candidate_set";
}
function candidateEqualityFailure(receipt) {
  if (receipt.candidates.length !== receipt.observations.length)
    return "candidate_identity_mismatch";
  const candidates = new Map(
    receipt.candidates.map((candidate) => [candidate.path, candidate]),
  );
  for (const observation of receipt.observations) {
    const candidate = candidates.get(observation.candidatePath);
    if (candidate === undefined) return "candidate_identity_mismatch";
    const failure = historyFailure(observation, candidate);
    if (failure !== undefined) return failure;
  }
  return undefined;
}
function publicationSubmode(receipt) {
  const terminal = receipt.terminalManifest;
  const ordinary = receipt.observations.every(
    (item) =>
      item.readiness === null &&
      item.lifecycleLabels[0] === "status: new" &&
      item.linkedPullRequest === null,
  );
  if (ordinary && terminal === null) return "ordinary";
  const migration = receipt.observations.every(
    (item) =>
      item.readiness !== null &&
      retainedLifecycle.test(item.lifecycleLabels[0]) &&
      prTrackedLifecycle.test(item.lifecycleLabels[0]) ===
        (item.linkedPullRequest !== null),
  );
  return migration && terminal !== null ? "migration" : undefined;
}
export function validateSnapshotReceipt(receipt, repository) {
  try {
    const shapeFailure = receiptShapeFailure(receipt);
    if (shapeFailure !== undefined) return reject(shapeFailure);
    const failure =
      observationSetFailure(receipt.observations, repository) ??
      candidateSetFailure(receipt.candidates) ??
      candidateEqualityFailure(receipt);
    if (failure !== undefined) return reject(failure);
    const submode = publicationSubmode(receipt);
    if (submode === undefined)
      return reject("inconsistent_publication_evidence");
    return {
      binding: {
        candidates: receipt.candidates,
        observations: receipt.observations,
        pullRequest: receipt.pullRequest,
        submode,
        target: receipt.target,
        terminalManifest: receipt.terminalManifest,
      },
      ok: true,
    };
  } catch {
    return reject("invalid_receipt_schema");
  }
}
