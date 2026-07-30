import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  LIFECYCLE_LIVE_SUFFIX_LIMIT,
  readStableLifecycleSnapshot,
  reconstructLifecycleHistory,
} from "./lifecycle-record-store.mjs";

const sha = (value) => String(value).padStart(64, "0");

function record(id, predecessor = null, type = "phase-fence-claim") {
  return {
    comment: {
      id,
      body: `<!-- keiko-native-lifecycle-fixture:${id} -->`,
      author: { login: "github-actions[bot]" },
    },
    parsed: {
      recordType: type,
      recordDigest: sha(id),
      fields: {
        record_type: type,
        predecessor_comment_id: predecessor,
        predecessor_record_digest:
          predecessor === null ? null : sha(predecessor),
      },
    },
  };
}

function providerFor(records, options = {}) {
  const comments = records.map(({ comment }) => structuredClone(comment));
  const artifacts = records.map(({ comment, parsed }) => ({
    id: comment.id + 1_000,
    name: "keiko-lifecycle-anchor-v1-issue-51",
    anchorIdentity: sha(comment.id + 1_000),
    commentId: comment.id,
  }));
  const pages = options.pages ?? [comments];
  let call = 0;
  return {
    artifacts: options.artifacts ?? artifacts,
    async listCommentsPage({ cursor }) {
      const index = cursor === null ? 0 : Number(cursor);
      const items = structuredClone(pages[index] ?? []);
      if (options.unstable && call++ === 1 && items.length > 0)
        items[0].body += " ";
      return {
        items,
        hasMore: index + 1 < pages.length,
        nextCursor: index + 1 < pages.length ? String(index + 1) : null,
      };
    },
    async listAnchorArtifacts() {
      return {
        items: structuredClone(this.artifacts),
        complete: options.artifactsComplete ?? true,
      };
    },
  };
}

const parser = (records) => (body) => {
  const id = Number(body.match(/fixture:(\d+)/u)?.[1]);
  const found = records.find(({ comment }) => comment.id === id);
  if (!found) throw new TypeError("malformed");
  return structuredClone(found.parsed);
};
const verifier =
  (records) =>
  async ({ commentId }) => {
    const found = records.find(({ comment }) => comment.id === commentId);
    return { parsed: structuredClone(found.parsed) };
  };

test("proves exact empty-history bootstrap with two stable evidence reads", async () => {
  const result = await readStableLifecycleSnapshot({
    provider: providerFor([]),
    repository: "oscharko-dev/Keiko-Native",
    issueNumber: 51,
    parseEnvelope: parser([]),
  });
  assert.equal(result.state, "empty");
});

test("treats the reserved prefix from any author as non-empty and malformed", async () => {
  const provider = providerFor([]);
  provider.listCommentsPage = async () => ({
    items: [
      {
        id: 1,
        body: "untrusted <!-- keiko-native-lifecycle-broken",
        author: { login: "attacker" },
      },
    ],
    hasMore: false,
    nextCursor: null,
  });
  await assert.rejects(
    readStableLifecycleSnapshot({
      provider,
      repository: "oscharko-dev/Keiko-Native",
      issueNumber: 51,
      parseEnvelope: () => {
        throw new TypeError("bad");
      },
    }),
    { code: "lifecycle-comment-malformed" },
  );
});

test("reconstructs a unique authenticated predecessor chain", async () => {
  const records = [
    record(3, 2),
    record(2, 1),
    record(1, null, "generation-request"),
  ];
  const result = await reconstructLifecycleHistory({
    provider: providerFor(records),
    repository: "oscharko-dev/Keiko-Native",
    issueNumber: 51,
    parseEnvelope: parser(records),
    verifyTuple: verifier(records),
  });
  assert.equal(result.state, "authenticated");
  assert.deepEqual(
    result.records.map(({ comment }) => comment.id),
    [1, 2, 3],
  );
  assert.deepEqual(result.predecessor, {
    commentId: 3,
    recordDigest: sha(3),
  });
});

test("detects unanchored comments and unreferenced suffix deletion", async () => {
  const records = [record(1, null, "generation-request")];
  const missingAnchor = providerFor(records, { artifacts: [] });
  await assert.rejects(
    readStableLifecycleSnapshot({
      provider: missingAnchor,
      repository: "oscharko-dev/Keiko-Native",
      issueNumber: 51,
      parseEnvelope: parser(records),
    }),
    { code: "lifecycle-comment-unanchored" },
  );
  const missingComment = providerFor([], {
    artifacts: [
      {
        id: 1,
        name: "keiko-lifecycle-anchor-v1-issue-51",
        anchorIdentity: sha(1),
        commentId: 99,
      },
    ],
  });
  await assert.rejects(
    readStableLifecycleSnapshot({
      provider: missingComment,
      repository: "oscharko-dev/Keiko-Native",
      issueNumber: 51,
      parseEnvelope: parser([]),
    }),
    { code: "lifecycle-suffix-deleted" },
  );
});

test("recovery may quarantine only one exact request-bound orphan body", async () => {
  const records = [
    record(2, 1, "phase-fence-claim"),
    record(1, null, "generation-request"),
  ];
  const provider = providerFor(records, {
    artifacts: [
      {
        id: 1_001,
        name: "keiko-lifecycle-anchor-v1-issue-51",
        anchorIdentity: sha(1_001),
        commentId: 1,
      },
    ],
  });
  const bodySha256 = createHash("sha256")
    .update(records[0].comment.body)
    .digest("hex");
  const result = await reconstructLifecycleHistory({
    ignoredOrphan: { bodySha256, commentId: 2 },
    issueNumber: 51,
    mode: "recovery",
    parseEnvelope: parser(records),
    provider,
    repository: "oscharko-dev/Keiko-Native",
    verifyTuple: verifier(records),
  });
  assert.deepEqual(
    result.records.map(({ comment }) => comment.id),
    [1],
  );
  await assert.rejects(
    reconstructLifecycleHistory({
      ignoredOrphan: { bodySha256: sha(9), commentId: 2 },
      issueNumber: 51,
      mode: "recovery",
      parseEnvelope: parser(records),
      provider,
      repository: "oscharko-dev/Keiko-Native",
      verifyTuple: verifier(records),
    }),
    { code: "ignored-orphan-body-mismatch" },
  );
});

test("detects duplicates, gaps, digest mismatch, forks, and roots", async () => {
  const cases = [
    [
      [record(2, 99), record(1, null, "generation-request")],
      "record-chain-gap",
    ],
    [
      [
        record(2, 1),
        {
          ...record(1, null, "generation-request"),
          parsed: {
            ...record(1, null, "generation-request").parsed,
            recordDigest: sha(9),
          },
        },
      ],
      "record-predecessor-digest-mismatch",
    ],
    [
      [record(3, 1), record(2, 1), record(1, null, "generation-request")],
      "record-chain-fork",
    ],
    [
      [
        record(2, null, "generation-request"),
        record(1, null, "generation-request"),
      ],
      "record-chain-root-conflict",
    ],
  ];
  for (const [records, code] of cases) {
    await assert.rejects(
      reconstructLifecycleHistory({
        provider: providerFor(records),
        repository: "oscharko-dev/Keiko-Native",
        issueNumber: 51,
        parseEnvelope: parser(records),
        verifyTuple: verifier(records),
      }),
      { code },
    );
  }
});

test("detects unstable reads and duplicate/conflicting artifacts", async () => {
  const records = [record(1, null, "generation-request")];
  await assert.rejects(
    readStableLifecycleSnapshot({
      provider: providerFor(records, { unstable: true }),
      repository: "oscharko-dev/Keiko-Native",
      issueNumber: 51,
      parseEnvelope: parser(records),
    }),
    { code: "lifecycle-snapshot-unstable" },
  );
  const provider = providerFor(records);
  provider.artifacts.push({ ...provider.artifacts[0], id: 2_000 });
  await assert.rejects(
    readStableLifecycleSnapshot({
      provider,
      repository: "oscharko-dev/Keiko-Native",
      issueNumber: 51,
      parseEnvelope: parser(records),
    }),
    { code: "artifact-inventory-conflict" },
  );
});

test("enters bounded recovery when two newest-first pages cannot find root", async () => {
  const records = [
    record(3, 2),
    record(2, 1),
    record(1, null, "generation-request"),
  ];
  const provider = providerFor(records, {
    pages: [[records[0].comment], [records[1].comment], [records[2].comment]],
  });
  const result = await reconstructLifecycleHistory({
    provider,
    repository: "oscharko-dev/Keiko-Native",
    issueNumber: 51,
    parseEnvelope: parser(records),
    verifyTuple: verifier(records),
  });
  assert.equal(result.state, "recovery-required");
});

test("enforces the maximum 15-record live suffix", async () => {
  const records = [];
  for (let id = LIFECYCLE_LIVE_SUFFIX_LIMIT + 1; id >= 1; id -= 1) {
    records.push(
      record(
        id,
        id === 1 ? null : id - 1,
        id === 1 ? "generation-request" : "phase-fence-claim",
      ),
    );
  }
  await assert.rejects(
    reconstructLifecycleHistory({
      provider: providerFor(records),
      repository: "oscharko-dev/Keiko-Native",
      issueNumber: 51,
      parseEnvelope: parser(records),
      verifyTuple: verifier(records),
    }),
    { code: "record-live-suffix-overflow" },
  );
});

test("rejects authentication disagreements and incomplete inventories", async () => {
  const records = [record(1, null, "generation-request")];
  await assert.rejects(
    reconstructLifecycleHistory({
      provider: providerFor(records),
      repository: "oscharko-dev/Keiko-Native",
      issueNumber: 51,
      parseEnvelope: parser(records),
      verifyTuple: async () => ({
        parsed: { ...records[0].parsed, recordDigest: sha(9) },
      }),
    }),
    { code: "record-authentication-conflict" },
  );
  await assert.rejects(
    readStableLifecycleSnapshot({
      provider: providerFor(records, { artifactsComplete: false }),
      repository: "oscharko-dev/Keiko-Native",
      issueNumber: 51,
      parseEnvelope: parser(records),
    }),
    { code: "artifact-inventory-incomplete" },
  );
});
