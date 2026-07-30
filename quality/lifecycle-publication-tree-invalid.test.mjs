import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ProtocolValidationError } from "./lifecycle-record-protocol.mjs";
import { verifyPublicationTree } from "./lifecycle-publication-tree.mjs";

const commit = "a".repeat(40);
const root = "b".repeat(40);

function hash(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest("hex");
}

function gitBlob(bytes) {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
}

function fixture() {
  const bytes = Buffer.from("exact publication bytes\n");
  const blob = gitBlob(bytes);
  const candidate = {
    exact_commit_sha: commit,
    root_tree_sha: root,
    entries: [
      {
        path: "docs/contracts/task-51-v5.md",
        mode: "100644",
        blob_object_id: blob,
        byte_count: bytes.length,
        content_sha256: hash(bytes, "sha256"),
      },
    ],
  };
  const commitResponse = { sha: commit, tree: { sha: root } };
  const treeResponse = {
    sha: root,
    truncated: false,
    tree: [
      {
        path: candidate.entries[0].path,
        mode: candidate.entries[0].mode,
        type: "blob",
        sha: blob,
        size: bytes.length,
      },
    ],
  };
  const blobResponse = {
    sha: blob,
    size: bytes.length,
    encoding: "base64",
    content: bytes.toString("base64"),
  };
  return {
    blobResponse,
    bytes,
    candidate,
    commitResponse,
    treeResponse,
  };
}

function provider(fixtureValue, overrides = {}) {
  let commitRead = 0;
  let treeRead = 0;
  let blobRead = 0;
  return {
    async readCommit() {
      const value =
        overrides.commits?.[commitRead] ?? fixtureValue.commitResponse;
      commitRead += 1;
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
    async readTree() {
      const value = overrides.trees?.[treeRead] ?? fixtureValue.treeResponse;
      treeRead += 1;
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
    async readBlob() {
      const value = overrides.blobs?.[blobRead] ?? fixtureValue.blobResponse;
      blobRead += 1;
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
  };
}

async function rejects(fixtureValue, overrides = {}) {
  await assert.rejects(
    verifyPublicationTree({
      candidate: fixtureValue.candidate,
      provider: provider(fixtureValue, overrides),
    }),
    ProtocolValidationError,
  );
}

test("rejects malformed, stale, and duplicate candidate envelopes before trust", async () => {
  for (const mutate of [
    (value) => {
      value.exact_commit_sha = "not-an-object";
    },
    (value) => {
      value.root_tree_sha = "c".repeat(40);
    },
    (value) => {
      value.entries[0].path = "docs/e\u0301.md";
    },
    (value) => {
      value.entries.push(structuredClone(value.entries[0]));
    },
    (value) => {
      value.entries[0].mode = "120000";
    },
    (value) => {
      value.entries[0].content_sha256 = "f".repeat(64);
    },
  ]) {
    const value = fixture();
    mutate(value.candidate);
    await rejects(value);
  }
});

test("requires an exact, complete, unique recursive tree set", async () => {
  const cases = [
    (tree) => {
      tree.truncated = true;
    },
    (tree) => {
      tree.tree = [];
    },
    (tree) => {
      tree.tree.push({
        ...tree.tree[0],
        path: "docs/contracts/extra.md",
      });
    },
    (tree) => {
      tree.tree.push(structuredClone(tree.tree[0]));
    },
    (tree) => {
      tree.tree[0].path = "docs/e\u0301.md";
    },
    (tree) => {
      tree.tree[0].path = "../escape.md";
    },
    (tree) => {
      tree.tree[0].path = "docs//contract.md";
    },
  ];
  for (const mutate of cases) {
    const value = fixture();
    mutate(value.treeResponse);
    await rejects(value);
  }
});

test("rejects trees, symlinks, submodules, invalid modes, renames, and copies", async () => {
  const cases = [
    ["tree", "040000"],
    ["blob", "120000"],
    ["commit", "160000"],
    ["blob", "100600"],
  ];
  for (const [type, mode] of cases) {
    const value = fixture();
    value.treeResponse.tree[0].type = type;
    value.treeResponse.tree[0].mode = mode;
    await rejects(value);
  }
  for (const status of ["renamed", "copied"]) {
    const value = fixture();
    value.treeResponse.tree[0].status = status;
    await rejects(value);
  }
  const value = fixture();
  value.treeResponse.tree[0].previous_filename = "docs/old.md";
  await rejects(value);
});

test("requires exact tree mode, object ID, and declared byte size", async () => {
  for (const mutate of [
    (entry) => {
      entry.mode = "100755";
    },
    (entry) => {
      entry.sha = "c".repeat(40);
    },
    (entry) => {
      entry.size += 1;
    },
  ]) {
    const value = fixture();
    mutate(value.treeResponse.tree[0]);
    await rejects(value);
  }
});

test("strictly rejects malformed or non-base64 blob payloads", async () => {
  for (const content of ["=", "YQ", "YQ==\n", "YQ==!", "YR=="]) {
    const value = fixture();
    value.blobResponse.content = content;
    await rejects(value);
  }
  const value = fixture();
  value.blobResponse.encoding = "utf-8";
  await rejects(value);
});

test("recomputes exact blob size, Git object ID, and SHA-256 bytes", async () => {
  for (const mutate of [
    (value) => {
      value.blobResponse.sha = "c".repeat(40);
    },
    (value) => {
      value.blobResponse.size += 1;
    },
    (value) => {
      value.blobResponse.content = Buffer.from("changed").toString("base64");
    },
    (value) => {
      value.candidate.entries[0].byte_count += 1;
      value.treeResponse.tree[0].size += 1;
      value.blobResponse.size += 1;
    },
  ]) {
    const value = fixture();
    mutate(value);
    await rejects(value);
  }
});

test("rejects commit, root-tree, tree-entry, and blob changes on reread", async () => {
  {
    const value = fixture();
    const changed = structuredClone(value.commitResponse);
    changed.sha = "c".repeat(40);
    await rejects(value, { commits: [value.commitResponse, changed] });
  }
  {
    const value = fixture();
    const changed = structuredClone(value.treeResponse);
    changed.tree[0].mode = "100755";
    await rejects(value, { trees: [value.treeResponse, changed] });
  }
  {
    const value = fixture();
    const changed = structuredClone(value.blobResponse);
    changed.content = Buffer.from("changed").toString("base64");
    await rejects(value, { blobs: [value.blobResponse, changed] });
  }
});

test("classifies commit, tree, and blob API unavailability without leaking errors", async () => {
  for (const overrides of [
    { commits: [new Error("credential-secret")] },
    { trees: [new Error("private-endpoint")] },
    { blobs: [new Error("customer-content")] },
  ]) {
    const value = fixture();
    await assert.rejects(
      verifyPublicationTree({
        candidate: value.candidate,
        provider: provider(value, overrides),
      }),
      (error) =>
        error instanceof ProtocolValidationError &&
        error.message === "publication provider unavailable",
    );
  }
});
