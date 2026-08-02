import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  digestAuxiliaryIdentity,
  ProtocolValidationError,
} from "./lifecycle-record-protocol.mjs";
import { verifyPublicationTree } from "./lifecycle-publication-tree.mjs";

const commit = "a".repeat(40);
const root = "b".repeat(40);

function gitBlob(bytes) {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
}

function entry(path, text, mode = "100644") {
  const bytes = Buffer.from(text);
  return {
    candidate: {
      path,
      mode,
      blob_object_id: gitBlob(bytes),
      byte_count: bytes.length,
      content_sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    bytes,
  };
}

function fixture() {
  const entries = [
    entry("docs/a.md", "alpha\n"),
    entry("scripts/run", "#!/bin/sh\n", "100755"),
  ];
  const candidate = {
    exact_commit_sha: commit,
    root_tree_sha: root,
    entries: entries.map((item) => item.candidate),
  };
  const calls = [];
  const provider = {
    async readCommit(sha) {
      calls.push(["commit", sha]);
      return { sha, tree: { sha: root } };
    },
    async readTree(sha, options) {
      calls.push(["tree", sha, options]);
      return {
        sha,
        truncated: false,
        tree: entries.map((item) => ({
          path: item.candidate.path,
          mode: item.candidate.mode,
          type: "blob",
          sha: item.candidate.blob_object_id,
          size: item.candidate.byte_count,
        })),
      };
    },
    async readBlob(sha) {
      calls.push(["blob", sha]);
      const item = entries.find(
        (value) => value.candidate.blob_object_id === sha,
      );
      return {
        sha,
        size: item.bytes.length,
        encoding: "base64",
        content: item.bytes.toString("base64"),
      };
    },
  };
  return { calls, candidate, entries, provider };
}

test("binds a stable exact commit, recursive tree, blobs, bytes, and candidate-set identity", async () => {
  const { calls, candidate, entries, provider } = fixture();

  const result = await verifyPublicationTree({ candidate, provider });

  assert.equal(result.exactCommitSha, commit);
  assert.equal(result.rootTreeSha, root);
  assert.equal(
    result.candidateSetIdentity,
    digestAuxiliaryIdentity("publication candidate set", candidate),
  );
  assert.deepEqual(
    result.entries.map(({ bytes, ...binding }) => ({
      ...binding,
      bytes: Buffer.from(bytes).toString("utf8"),
    })),
    entries.map(({ candidate: value, bytes }) => ({
      path: value.path,
      mode: value.mode,
      blobObjectId: value.blob_object_id,
      byteCount: value.byte_count,
      contentSha256: value.content_sha256,
      bytes: bytes.toString("utf8"),
    })),
  );
  assert.deepEqual(
    calls.filter(([kind]) => kind === "commit"),
    [
      ["commit", commit],
      ["commit", commit],
    ],
  );
  assert.deepEqual(
    calls.filter(([kind]) => kind === "tree"),
    [
      ["tree", root, { recursive: true }],
      ["tree", root, { recursive: true }],
    ],
  );
  for (const item of entries) {
    assert.equal(
      calls.filter(
        ([kind, sha]) =>
          kind === "blob" && sha === item.candidate.blob_object_id,
      ).length,
      2,
    );
  }
});

test("uses candidate path order independent of provider enumeration order", async () => {
  const { candidate, provider } = fixture();
  candidate.entries.reverse();
  const readTree = provider.readTree;
  provider.readTree = async (...arguments_) => {
    const response = await readTree(...arguments_);
    response.tree.reverse();
    return response;
  };

  const result = await verifyPublicationTree({ candidate, provider });

  assert.deepEqual(
    result.entries.map((item) => item.path),
    ["docs/a.md", "scripts/run"],
  );
});

test("fails closed without the exact commit/tree/blob provider seam", async () => {
  const { candidate } = fixture();

  await assert.rejects(verifyPublicationTree(null), ProtocolValidationError);
  await assert.rejects(
    verifyPublicationTree({
      candidate,
      provider: { readPullRequestFiles: async () => [] },
    }),
    ProtocolValidationError,
  );
});
