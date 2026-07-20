import { isDeepStrictEqual as same } from "node:util";
import { contractSha256, parseContractPath } from "./repository-contract.mjs";
// prettier-ignore
import { decodeSnapshotReceipt, publicationAncestryFailure, publicationEvidenceMaps, publicationIdentityFailure, samePublicationBytes, validateSnapshotReceipt } from "./publication-contract-schema.mjs";
export { validateSnapshotReceipt } from "./publication-contract-schema.mjs";
// prettier-ignore
const contractTrailer = /^Keiko-Contract-SHA256: ([0-9a-f]{64}) (docs\/contracts\/[A-Za-z0-9./-]+\.md)$/u, snapshotTrailer = /^Keiko-Publication-Snapshot-SHA256: ([0-9a-f]{64}) (docs\/contracts\/publications\/pr-([1-9]\d*)\.md)$/u, receiptPathPattern = /^docs\/contracts\/publications\/pr-([1-9]\d*)\.md$/u;
const evidenceFailureMessage = "Publication evidence failed closed.";
const reject = (code, message) => ({ ok: false, rejection: { code, message } });
const safeInteger = (value) => Number.isSafeInteger(value) && value > 0;
function receiptIdentity(path) {
  const match = typeof path === "string" ? receiptPathPattern.exec(path) : null;
  const pullRequest = match === null ? Number.NaN : Number(match[1]);
  return safeInteger(pullRequest) ? { path, pullRequest } : undefined;
}
function trailerLines(payload) {
  if (typeof payload !== "string") return undefined;
  const lines = payload.split(/\r?\n/u);
  while (lines.at(-1) === "") lines.pop();
  const separator = lines.lastIndexOf("");
  if (separator < 0 || separator === lines.length - 1) return [];
  return lines.slice(separator + 1);
}
function parsedTrailer(line) {
  const contract = contractTrailer.exec(line);
  if (contract !== null && parseContractPath(contract[2]).ok)
    return { digest: contract[1], kind: "contract", path: contract[2] };
  const snapshot = snapshotTrailer.exec(line);
  const identity = snapshot === null ? undefined : receiptIdentity(snapshot[2]);
  return identity === undefined
    ? undefined
    : { digest: snapshot[1], kind: "snapshot", ...identity };
}
function trailerSetFailure(trailers) {
  if (trailers.includes(undefined)) return "malformed_trailer";
  const paths = new Set();
  const digests = new Set();
  for (let index = 0; index < trailers.length; index += 1) {
    const trailer = trailers[index];
    if (paths.has(trailer.path) || digests.has(trailer.digest))
      return "duplicate_trailer_identity";
    if (index > 0 && trailers[index - 1].path >= trailer.path)
      return "unsorted_trailers";
    paths.add(trailer.path);
    digests.add(trailer.digest);
  }
  return undefined;
}
export function parsePublicationTrailers(payload) {
  const lines = trailerLines(payload);
  if (lines === undefined)
    return reject("invalid_signed_payload", "Signed payload must be text.");
  const trailers = lines.map(parsedTrailer);
  const failure = trailerSetFailure(trailers);
  if (failure !== undefined)
    return reject(failure, "Publication trailers failed canonical validation.");
  const contracts = trailers.filter((item) => item.kind === "contract");
  const snapshots = trailers.filter((item) => item.kind === "snapshot");
  if (contracts.length === 0 || snapshots.length !== 1)
    return reject(
      "incomplete_trailer_set",
      "Publication requires contracts and one snapshot trailer.",
    );
  const snapshot = { ...snapshots[0] };
  delete snapshot.kind;
  return {
    contracts: contracts.map(({ digest, path }) => ({ digest, path })),
    ok: true,
    snapshot,
  };
}
function publicationPath(path) {
  if (typeof path !== "string") return "malformed";
  if (parseContractPath(path).ok) return "contract";
  if (receiptIdentity(path) !== undefined) return "receipt";
  return path.startsWith("docs/contracts/") ? "malformed" : "other";
}
const validDiffFile = (file) =>
  file !== null &&
  typeof file === "object" &&
  typeof file.path === "string" &&
  typeof file.status === "string" &&
  typeof file.mode === "string";
const validEnvelope = (input) =>
  input !== null &&
  typeof input === "object" &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository) &&
  safeInteger(input.pullRequest) &&
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.base) &&
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.head) &&
  input.base !== input.head;
function validClassificationInput(input) {
  return (
    validEnvelope(input) &&
    input.complete === true &&
    input.truncated === false &&
    Array.isArray(input.files) &&
    input.files.every(validDiffFile)
  );
}
function publicationDiffFailure(files, kinds) {
  const paths = new Set(files.map((file) => file.path));
  if (paths.size !== files.length) return "duplicate_diff_path";
  if (kinds.includes("malformed")) return "malformed_publication_path";
  const hasPublication = kinds.some((kind) =>
    ["contract", "receipt"].includes(kind),
  );
  if (!hasPublication) return undefined;
  if (kinds.includes("other")) return "mixed_publication_scope";
  if (files.some((file) => file.status !== "added" || file.mode !== "100644"))
    return "non_add_only_publication";
  return undefined;
}
// prettier-ignore
const laneBinding = ({ base, head, pullRequest, repository }, lane) => ({ base, head, lane, pullRequest, repository });
export function classifyPublicationLane(input) {
  if (!validClassificationInput(input))
    return reject(
      "unavailable_diff",
      "Complete trusted diff metadata is required.",
    );
  const kinds = input.files.map((file) => publicationPath(file.path));
  const previousKinds = input.files
    .filter((file) => ["renamed", "copied"].includes(file.status))
    .map((file) => publicationPath(file.previous_filename));
  const failure = publicationDiffFailure(input.files, [
    ...kinds,
    ...previousKinds,
  ]);
  if (failure !== undefined)
    return reject(failure, "Diff cannot select a publication lane.");
  const contractPaths = input.files
    .filter((_, index) => kinds[index] === "contract")
    .map((file) => file.path);
  const receipts = input.files.filter((_, index) => kinds[index] === "receipt");
  if (contractPaths.length === 0 && receipts.length === 0) {
    return input.normalValidated === true
      ? { binding: laneBinding(input, "normal"), lane: "normal", ok: true }
      : reject(
          "ambiguous_normal_diff",
          "Normal lane requires trusted validation.",
        );
  }
  if (contractPaths.length === 0 || receipts.length !== 1)
    return reject(
      "incomplete_publication_diff",
      "Publication diff is incomplete.",
    );
  if (receiptIdentity(receipts[0].path).pullRequest !== input.pullRequest)
    return reject(
      "receipt_pull_request_mismatch",
      "Receipt identity is stale.",
    );
  return {
    binding: laneBinding(input, "publication"),
    contractPaths,
    lane: "publication",
    ok: true,
    receiptPath: receipts[0].path,
  };
}
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function validReceiptBinding(input, trailers, validation, identity, hash) {
  const receipt = input.receipt;
  return (
    identity !== undefined &&
    identity.pullRequest === input.pullRequest.number &&
    receipt.repository === input.repository &&
    receipt.pullRequest === input.pullRequest.number &&
    hash.ok &&
    trailers.snapshot.path === receipt.path &&
    trailers.snapshot.digest === hash.digest &&
    validation.binding.pullRequest === input.pullRequest.number
  );
}
function receiptFailure(input, trailers, validation, added) {
  const receipt = input.receipt;
  const identity = receiptIdentity(receipt?.path);
  const hash = contractSha256(receipt?.bytes);
  const entry = added.get(receipt?.path);
  if (entry === undefined) return "invalid_receipt_binding";
  const same = samePublicationBytes(receipt?.bytes, entry.bytes);
  const digest = same ? contractSha256(entry.bytes).digest : undefined;
  if (digest !== trailers.snapshot.digest) return "invalid_receipt_binding";
  return validReceiptBinding(input, trailers, validation, identity, hash)
    ? undefined
    : "invalid_receipt_binding";
}
function exactCandidateFailure(candidates, trailers, added) {
  if (trailers.contracts.length !== candidates.length)
    return "candidate_set_mismatch";
  const contracts = new Map(
    trailers.contracts.map((item) => [item.path, item.digest]),
  );
  for (const candidate of candidates) {
    const entry = added.get(candidate.path);
    if (
      contracts.get(candidate.path) !== candidate.digest ||
      entry === undefined ||
      contractSha256(entry.bytes).digest !== candidate.digest ||
      entry.mode !== candidate.mode
    )
      return "candidate_set_mismatch";
  }
  return undefined;
}
function treeEqualityFailure(expected, publishing, current) {
  if (expected.size !== publishing.size || expected.size !== current.size)
    return "tree_set_mismatch";
  for (const [path, entry] of expected) {
    const published = publishing.get(path);
    const present = current.get(path);
    if (
      published === undefined ||
      present === undefined ||
      entry.mode !== published.mode ||
      entry.mode !== present.mode ||
      !samePublicationBytes(entry.bytes, published.bytes) ||
      !samePublicationBytes(entry.bytes, present.bytes)
    )
      return "tree_entry_mismatch";
  }
  return undefined;
}
function manifestEvidenceFailure(binding, evidence) {
  if (binding.submode === "ordinary")
    return evidence === null ? undefined : "unexpected_manifest_evidence";
  if (
    !record(evidence) ||
    evidence.path !== binding.terminalManifest.path ||
    evidence.digest !== binding.terminalManifest.digest ||
    !Array.isArray(evidence.entries) ||
    evidence.entries.length !== binding.observations.length
  )
    return "invalid_manifest_evidence";
  return JSON.stringify(evidence.entries) ===
    JSON.stringify(binding.observations)
    ? undefined
    : "manifest_entry_mismatch";
}
function normalizedBinding(input, validation, receiptDigest) {
  const candidates = validation.binding.candidates.map((item) => ({ ...item }));
  return {
    ancestry: { commit: input.commit.sha, tip: input.protectedDev.tip },
    base: input.pullRequest.base,
    candidates,
    head: input.pullRequest.head,
    lane: "publication",
    mergeActor: input.pullRequest.mergedBy,
    mergeSha: input.commit.sha,
    pullRequest: input.pullRequest.number,
    receipt: { digest: receiptDigest, path: input.receipt.path },
    repository: input.repository,
    signer: input.commit.verification.signer,
    submode: validation.binding.submode,
    trees: {
      parent: input.validatedGroup.prefixTree,
      result: input.validatedGroup.resultTree,
    },
  };
}
function verificationContext(input) {
  const identity =
    publicationIdentityFailure(input) ?? publicationAncestryFailure(input);
  if (identity !== undefined) return { failure: identity };
  const trailers = parsePublicationTrailers(input.commit.signedPayload);
  if (!trailers.ok) return { failure: "invalid_publication_trailers" };
  const decoded = decodeSnapshotReceipt(input.receipt);
  const validation = validateSnapshotReceipt(decoded, input.repository);
  if (!validation.ok) return { failure: "invalid_snapshot_receipt" };
  const maps = publicationEvidenceMaps(input);
  return maps.failure === undefined
    ? { maps, trailers, validation }
    : { failure: maps.failure };
}
function boundPublicationFailure(input, context) {
  const { maps, trailers, validation } = context;
  const failure =
    receiptFailure(input, trailers, validation, maps.added) ??
    exactCandidateFailure(validation.binding.candidates, trailers, maps.added);
  if (failure !== undefined) return failure;
  if (
    maps.added.size !== validation.binding.candidates.length + 1 ||
    !maps.added.has(input.receipt.path)
  )
    return "unexpected_new_blob";
  return (
    treeEqualityFailure(maps.added, maps.publishing, maps.current) ??
    manifestEvidenceFailure(validation.binding, input.terminalManifestEvidence)
  );
}
export function verifyPublication(input) {
  try {
    const context = verificationContext(input);
    if (context.failure !== undefined)
      return reject(context.failure, evidenceFailureMessage);
    const failure = boundPublicationFailure(input, context);
    if (failure !== undefined) return reject(failure, evidenceFailureMessage);
    const receiptHash = contractSha256(input.receipt.bytes).digest;
    return {
      binding: normalizedBinding(input, context.validation, receiptHash),
      ok: true,
    };
  } catch {
    return reject("invalid_publication_evidence", evidenceFailureMessage);
  }
}
// prettier-ignore
const failedContexts = Object.freeze({ "Contract publication": "failure", "Issue contract current": "failure", "PR contract": "failure" });
// prettier-ignore
const sharedKeys = ["repository", "pullRequest", "base", "head", "lane"], candidateKeys = "base candidates diff head lane observations pullRequest receipt repository submode target terminalManifest".split(" "), candidateDiffKeys = "base complete files head normalValidated pullRequest repository truncated".split(" ");
const exactKeys = (value, expected) =>
  record(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
function normalizedCandidate(binding, outer) {
  try {
    if (!exactKeys(binding, candidateKeys)) return false;
    const { candidates, observations, pullRequest, target, terminalManifest } =
      binding;
    const snapshot = validateSnapshotReceipt(
      { candidates, observations, pullRequest, target, terminalManifest },
      binding.repository,
    );
    const classified = classifyPublicationLane(binding.diff);
    const paths = binding.candidates.map(({ path }) => path);
    return [
      exactKeys(binding.diff, candidateDiffKeys) &&
        exactKeys(binding.receipt, ["digest", "path"]) &&
        binding.diff.files.every((file) =>
          exactKeys(file, ["mode", "path", "status"]),
        ),
      /^[0-9a-f]{64}$/u.test(binding.receipt.digest),
      snapshot.ok === true && snapshot.binding.submode === binding.submode,
      classified.ok === true &&
        classified.lane === "publication" &&
        classified.receiptPath === binding.receipt.path,
      same(classified.contractPaths, paths),
      same(classified.binding, laneBinding(binding, binding.lane)),
      same(outer.contractPaths, paths),
      sharedKeys.every((key) => binding[key] === outer[key]),
      binding.target === outer.target,
      binding.submode === outer.submode,
      same(binding.receipt, outer.receipt),
      same(binding.terminalManifest, outer.manifest),
    ].every(Boolean);
  } catch {
    return false;
  }
}
function classifiedBinding(classification) {
  try {
    const binding = classification?.binding;
    return classification?.ok === true &&
      validEnvelope(binding) &&
      ["normal", "publication"].includes(binding.lane) &&
      binding.lane === classification.lane
      ? binding
      : undefined;
  } catch {
    return undefined;
  }
}
function matchingResult(result, binding, exact = false) {
  try {
    const matches = exact
      ? same(result.binding, binding.candidate)
      : sharedKeys.every((key) => result.binding?.[key] === binding[key]);
    return result?.ok === true && matches;
  } catch {
    return false;
  }
}
function successfulContexts(input, binding, lane) {
  const normal =
    lane === "normal" &&
    matchingResult(input.normal?.prContract, binding) &&
    matchingResult(input.normal?.issueContractCurrent, binding);
  const publication =
    lane === "publication" &&
    normalizedCandidate(binding.candidate, binding) &&
    matchingResult(input.publication, binding, true);
  if (!normal && !publication) return failedContexts;
  // prettier-ignore
  return { "Contract publication": publication ? "success" : "not_applicable", "Issue contract current": "success", "PR contract": "success" };
}
export function publicationResultMatrix(input) {
  let contexts = failedContexts;
  let lane;
  try {
    input = Object(input);
    const binding = classifiedBinding(input.classification);
    lane = binding?.lane ?? "invalid";
    contexts = successfulContexts(input, binding, lane);
  } catch {
    lane = "invalid";
  }
  return { contexts: { ...contexts }, lane, ok: true, readinessClaim: false };
}
