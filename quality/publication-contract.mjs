import { contractSha256, parseContractPath } from "./repository-contract.mjs";
import {
  decodeSnapshotReceipt,
  publicationAncestryFailure,
  publicationEvidenceMaps,
  publicationIdentityFailure,
  samePublicationBytes,
  validateSnapshotReceipt,
} from "./publication-contract-schema.mjs";
export { validateSnapshotReceipt } from "./publication-contract-schema.mjs";
const contractTrailer =
  /^Keiko-Contract-SHA256: ([0-9a-f]{64}) (docs\/contracts\/[A-Za-z0-9./-]+\.md)$/u;
const snapshotTrailer =
  /^Keiko-Publication-Snapshot-SHA256: ([0-9a-f]{64}) (docs\/contracts\/publications\/pr-([1-9]\d*)\.md)$/u;
const receiptPathPattern =
  /^docs\/contracts\/publications\/pr-([1-9]\d*)\.md$/u;
function reject(code, message) {
  return { ok: false, rejection: { code, message } };
}
function safeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function receiptIdentity(path) {
  const match = typeof path === "string" ? receiptPathPattern.exec(path) : null;
  const pullRequest = match === null ? NaN : Number(match[1]);
  return safeInteger(pullRequest) ? { path, pullRequest } : undefined;
}
function trailerLines(payload) {
  if (typeof payload !== "string") return undefined;
  const lines = payload.split(/\r?\n/u);
  while (lines.at(-1) === "") lines.pop();
  const separator = lines.lastIndexOf("");
  if (separator < 0 || separator === lines.length - 1) return [];
  const block = lines.slice(separator + 1);
  return block;
}
function parsedTrailer(line) {
  const contract = contractTrailer.exec(line);
  if (contract !== null && parseContractPath(contract[2]).ok) {
    return { digest: contract[1], kind: "contract", path: contract[2] };
  }
  const snapshot = snapshotTrailer.exec(line);
  const identity = snapshot === null ? undefined : receiptIdentity(snapshot[2]);
  return identity === undefined
    ? undefined
    : { digest: snapshot[1], kind: "snapshot", ...identity };
}
function trailerSetFailure(trailers) {
  if (trailers.some((item) => item === undefined)) return "malformed_trailer";
  const paths = new Set();
  const digests = new Set();
  for (let index = 0; index < trailers.length; index += 1) {
    const trailer = trailers[index];
    if (paths.has(trailer.path) || digests.has(trailer.digest)) {
      return "duplicate_trailer_identity";
    }
    if (index > 0 && trailers[index - 1].path >= trailer.path) {
      return "unsorted_trailers";
    }
    paths.add(trailer.path);
    digests.add(trailer.digest);
  }
  return undefined;
}
export function parsePublicationTrailers(payload) {
  const lines = trailerLines(payload);
  if (lines === undefined) {
    return reject("invalid_signed_payload", "Signed payload must be text.");
  }
  const trailers = lines.map(parsedTrailer);
  const failure = trailerSetFailure(trailers);
  if (failure !== undefined) {
    return reject(failure, "Publication trailers failed canonical validation.");
  }
  const contracts = trailers.filter((item) => item.kind === "contract");
  const snapshots = trailers.filter((item) => item.kind === "snapshot");
  if (contracts.length === 0 || snapshots.length !== 1) {
    return reject(
      "incomplete_trailer_set",
      "Publication requires contracts and one snapshot trailer.",
    );
  }
  const snapshot = { ...snapshots[0] };
  delete snapshot.kind;
  return {
    contracts: contracts.map(({ digest, path }) => ({ digest, path })),
    ok: true,
    snapshot,
  };
}
function publicationPath(path) {
  if (parseContractPath(path).ok) return "contract";
  if (receiptIdentity(path) !== undefined) return "receipt";
  return typeof path === "string" && path.startsWith("docs/contracts/")
    ? "malformed"
    : "other";
}
function validDiffFile(file) {
  return (
    file !== null &&
    typeof file === "object" &&
    typeof file.path === "string" &&
    typeof file.status === "string" &&
    typeof file.mode === "string"
  );
}
function validEnvelope(input) {
  return (
    input !== null &&
    typeof input === "object" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository) &&
    safeInteger(input.pullRequest) &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.base) &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.head) &&
    input.base !== input.head
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
  if (files.some((file) => file.status !== "added" || file.mode !== "100644")) {
    return "non_add_only_publication";
  }
  return undefined;
}
function laneBinding(input, lane) {
  const { base, head, pullRequest, repository } = input;
  return { base, head, lane, pullRequest, repository };
}
export function classifyPublicationLane(input) {
  if (
    !validEnvelope(input) ||
    input.complete !== true ||
    input.truncated !== false ||
    !Array.isArray(input.files) ||
    input.files.some((file) => !validDiffFile(file))
  ) {
    return reject(
      "unavailable_diff",
      "Complete trusted diff metadata is required.",
    );
  }
  const kinds = input.files.map((file) => publicationPath(file.path));
  const failure = publicationDiffFailure(input.files, kinds);
  if (failure !== undefined) {
    return reject(failure, "Diff cannot select a publication lane.");
  }
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
  if (contractPaths.length === 0 || receipts.length !== 1) {
    return reject(
      "incomplete_publication_diff",
      "Publication diff is incomplete.",
    );
  }
  if (receiptIdentity(receipts[0].path).pullRequest !== input.pullRequest) {
    return reject(
      "receipt_pull_request_mismatch",
      "Receipt identity is stale.",
    );
  }
  return {
    binding: laneBinding(input, "publication"),
    contractPaths,
    lane: "publication",
    ok: true,
    receiptPath: receipts[0].path,
  };
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function receiptFailure(input, trailers, validation) {
  const receipt = input.receipt;
  const identity = receiptIdentity(receipt?.path);
  const hash = contractSha256(receipt?.bytes);
  if (
    identity === undefined ||
    identity.pullRequest !== input.pullRequest.number ||
    receipt.repository !== input.repository ||
    receipt.pullRequest !== input.pullRequest.number ||
    !hash.ok ||
    trailers.snapshot.path !== receipt.path ||
    trailers.snapshot.digest !== hash.digest ||
    validation.binding.pullRequest !== input.pullRequest.number
  ) {
    return "invalid_receipt_binding";
  }
  return undefined;
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
    ) {
      return "candidate_set_mismatch";
    }
  }
  return undefined;
}
function treeEqualityFailure(expected, publishing, current) {
  if (expected.size !== publishing.size || expected.size !== current.size) {
    return "tree_set_mismatch";
  }
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
    ) {
      return "tree_entry_mismatch";
    }
  }
  return undefined;
}
function manifestEntry(item) {
  return {
    candidatePath: item.candidatePath,
    fingerprint: item.fingerprint,
    number: item.number,
    readiness: item.readiness,
    revision: item.revision,
    type: item.type,
    version: item.version,
  };
}
function manifestEvidenceFailure(binding, evidence) {
  if (binding.submode === "ordinary") {
    return evidence === null ? undefined : "unexpected_manifest_evidence";
  }
  if (
    !record(evidence) ||
    evidence.path !== binding.terminalManifest.path ||
    evidence.digest !== binding.terminalManifest.digest ||
    !Array.isArray(evidence.entries) ||
    evidence.entries.length !== binding.observations.length
  ) {
    return "invalid_manifest_evidence";
  }
  const expected = binding.observations.map(manifestEntry);
  return JSON.stringify(evidence.entries) === JSON.stringify(expected)
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
  const validation = validateSnapshotReceipt(
    decodeSnapshotReceipt(input.receipt),
  );
  if (!validation.ok) return { failure: "invalid_snapshot_receipt" };
  const maps = publicationEvidenceMaps(input);
  return maps.failure === undefined
    ? { maps, trailers, validation }
    : { failure: maps.failure };
}
export function verifyPublication(input) {
  try {
    const context = verificationContext(input);
    if (context.failure !== undefined)
      return reject(context.failure, "Publication evidence failed closed.");
    const { maps, trailers, validation } = context;
    const receiptHash = contractSha256(input.receipt.bytes).digest;
    const receipt = receiptFailure(input, trailers, validation);
    const candidate = exactCandidateFailure(
      validation.binding.candidates,
      trailers,
      maps.added,
    );
    if (receipt !== undefined || candidate !== undefined) {
      return reject(
        receipt ?? candidate,
        "Publication evidence failed closed.",
      );
    }
    if (
      maps.added.size !== validation.binding.candidates.length + 1 ||
      !maps.added.has(input.receipt.path)
    ) {
      return reject(
        "unexpected_new_blob",
        "Publication evidence failed closed.",
      );
    }
    const tree = treeEqualityFailure(maps.added, maps.publishing, maps.current);
    const manifest = manifestEvidenceFailure(
      validation.binding,
      input.terminalManifestEvidence,
    );
    if (tree !== undefined || manifest !== undefined) {
      return reject(tree ?? manifest, "Publication evidence failed closed.");
    }
    return {
      binding: normalizedBinding(input, validation, receiptHash),
      ok: true,
    };
  } catch {
    return reject(
      "invalid_publication_evidence",
      "Publication evidence failed closed.",
    );
  }
}
const failedContexts = Object.freeze({
  "Contract publication": "failure",
  "Issue contract current": "failure",
  "PR contract": "failure",
});
export function publicationResultMatrix(input) {
  const classification = input?.classification;
  const binding = classification?.binding;
  const classified =
    classification?.ok === true &&
    validEnvelope(binding) &&
    binding.lane === classification.lane;
  const matches = (result) =>
    result?.ok === true &&
    ["repository", "pullRequest", "base", "head", "lane"].every(
      (key) => result.binding?.[key] === binding[key],
    );
  let contexts = failedContexts;
  let lane = "invalid";
  if (classified && classification.lane === "normal") {
    lane = "normal";
    if (
      matches(input.normal?.prContract) &&
      matches(input.normal?.issueContractCurrent)
    ) {
      contexts = {
        "Contract publication": "not_applicable",
        "Issue contract current": "success",
        "PR contract": "success",
      };
    }
  } else if (classified && classification.lane === "publication") {
    lane = "publication";
    if (matches(input.publication)) {
      contexts = {
        "Contract publication": "success",
        "Issue contract current": "success",
        "PR contract": "success",
      };
    }
  }
  return { contexts: { ...contexts }, lane, ok: true, readinessClaim: false };
}
