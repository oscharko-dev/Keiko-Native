import { createHash } from "node:crypto";

import {
  digestAuxiliaryIdentity,
  ProtocolValidationError,
} from "./lifecycle-record-protocol.mjs";

const OID = /^[0-9a-f]{40}$/u;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MODES = new Set(["100644", "100755"]);

function fail(message) {
  throw new ProtocolValidationError(message);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function repositoryPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.includes("\r") ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function exactObjectId(value) {
  return typeof value === "string" && OID.test(value);
}

function exactSize(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

async function providerRead(provider, method, ...arguments_) {
  try {
    return await provider[method](...arguments_);
  } catch {
    fail("publication provider unavailable");
  }
}

function commitBinding(response, expectedCommit, expectedTree) {
  if (
    !record(response) ||
    response.sha !== expectedCommit ||
    !record(response.tree) ||
    response.tree.sha !== expectedTree
  ) {
    fail("stale publication commit");
  }
  return { sha: response.sha, treeSha: response.tree.sha };
}

function treeBinding(response, expectedTree) {
  if (
    !record(response) ||
    response.sha !== expectedTree ||
    response.truncated !== false ||
    !Array.isArray(response.tree)
  ) {
    fail("incomplete publication tree");
  }
  const entries = [];
  const paths = new Set();
  for (const entry of response.tree) {
    if (
      !record(entry) ||
      !repositoryPath(entry.path) ||
      paths.has(entry.path) ||
      entry.type !== "blob" ||
      !MODES.has(entry.mode) ||
      !exactObjectId(entry.sha) ||
      !exactSize(entry.size) ||
      entry.status === "renamed" ||
      entry.status === "copied" ||
      Object.hasOwn(entry, "previous_filename")
    ) {
      fail("invalid publication tree entry");
    }
    paths.add(entry.path);
    entries.push({
      path: entry.path,
      mode: entry.mode,
      blobObjectId: entry.sha,
      byteCount: entry.size,
    });
  }
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
  return entries;
}

function strictBase64(value) {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !BASE64.test(value)
  ) {
    fail("malformed publication blob base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    fail("malformed publication blob base64");
  }
  return bytes;
}

function gitBlobObjectId(bytes, expectedObjectId) {
  const algorithm = { 40: "sha1", 64: "sha256" }[expectedObjectId.length];
  if (algorithm === undefined) {
    fail("publication blob object algorithm unavailable");
  }
  return createHash(algorithm)
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
}

function blobBinding(response, expected) {
  if (
    !record(response) ||
    response.sha !== expected.blob_object_id ||
    response.encoding !== "base64" ||
    response.size !== expected.byte_count
  ) {
    fail("publication blob identity mismatch");
  }
  const bytes = strictBase64(response.content);
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.length !== expected.byte_count ||
    gitBlobObjectId(bytes, expected.blob_object_id) !==
      expected.blob_object_id ||
    contentSha256 !== expected.content_sha256
  ) {
    fail("publication blob content mismatch");
  }
  return {
    path: expected.path,
    mode: expected.mode,
    blobObjectId: expected.blob_object_id,
    byteCount: expected.byte_count,
    contentSha256,
    bytes,
  };
}

function sameScalarEntries(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.path === right[index].path &&
        entry.mode === right[index].mode &&
        entry.blobObjectId === right[index].blobObjectId &&
        entry.byteCount === right[index].byteCount,
    )
  );
}

function candidateEntries(candidate, treeEntries) {
  const entries = [...candidate.entries].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
  const projected = entries.map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    blobObjectId: entry.blob_object_id,
    byteCount: entry.byte_count,
  }));
  if (!sameScalarEntries(projected, treeEntries)) {
    fail("publication candidate set mismatch");
  }
  return entries;
}

async function readBlobs(provider, entries) {
  const bindings = [];
  for (const entry of entries) {
    const response = await providerRead(
      provider,
      "readBlob",
      entry.blob_object_id,
    );
    bindings.push(blobBinding(response, entry));
  }
  return bindings;
}

function sameBlobBindings(left, right) {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        entry.path === other.path &&
        entry.mode === other.mode &&
        entry.blobObjectId === other.blobObjectId &&
        entry.byteCount === other.byteCount &&
        entry.contentSha256 === other.contentSha256 &&
        entry.bytes.equals(other.bytes)
      );
    })
  );
}

export async function verifyPublicationTree(input = {}) {
  if (!record(input)) {
    fail("invalid publication tree input");
  }
  const { candidate, provider } = input;
  if (
    !record(provider) ||
    typeof provider.readCommit !== "function" ||
    typeof provider.readTree !== "function" ||
    typeof provider.readBlob !== "function"
  ) {
    fail("exact publication provider required");
  }

  let candidateSetIdentity;
  try {
    candidateSetIdentity = digestAuxiliaryIdentity(
      "publication candidate set",
      candidate,
    );
  } catch (error) {
    if (error instanceof ProtocolValidationError) throw error;
    fail("invalid publication candidate envelope");
  }

  const snapshot = structuredClone(candidate);
  const firstCommit = commitBinding(
    await providerRead(provider, "readCommit", snapshot.exact_commit_sha),
    snapshot.exact_commit_sha,
    snapshot.root_tree_sha,
  );
  const firstTree = treeBinding(
    await providerRead(provider, "readTree", snapshot.root_tree_sha, {
      recursive: true,
    }),
    snapshot.root_tree_sha,
  );
  const expectedEntries = candidateEntries(snapshot, firstTree);
  const firstBlobs = await readBlobs(provider, expectedEntries);

  const secondCommit = commitBinding(
    await providerRead(provider, "readCommit", snapshot.exact_commit_sha),
    snapshot.exact_commit_sha,
    snapshot.root_tree_sha,
  );
  const secondTree = treeBinding(
    await providerRead(provider, "readTree", snapshot.root_tree_sha, {
      recursive: true,
    }),
    snapshot.root_tree_sha,
  );
  const repeatedEntries = candidateEntries(snapshot, secondTree);
  const secondBlobs = await readBlobs(provider, repeatedEntries);

  if (
    firstCommit.sha !== secondCommit.sha ||
    firstCommit.treeSha !== secondCommit.treeSha ||
    !sameScalarEntries(firstTree, secondTree) ||
    !sameBlobBindings(firstBlobs, secondBlobs)
  ) {
    fail("publication provider reread changed");
  }
  if (
    digestAuxiliaryIdentity("publication candidate set", snapshot) !==
    candidateSetIdentity
  ) {
    fail("publication candidate set drift");
  }

  return {
    exactCommitSha: snapshot.exact_commit_sha,
    rootTreeSha: snapshot.root_tree_sha,
    candidateSetIdentity,
    entries: firstBlobs,
  };
}
