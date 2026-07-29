import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";

import { verifyLifecycleRecordTuple } from "./lifecycle-record-auth.mjs";
import {
  callLifecycleProvider,
  createLifecycleProviderBudget,
} from "./lifecycle-record-budget.mjs";
import { verifyCheckpointEvidence } from "./lifecycle-record-checkpoint.mjs";
import { parseRecordEnvelope } from "./lifecycle-record-protocol.mjs";

const RESERVED_PREFIX = "<!-- keiko-native-lifecycle-";
const PAGE_SIZE = 100;
const LIVE_SUFFIX_LIMIT = 15;

export class LifecycleRecordStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "LifecycleRecordStoreError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new LifecycleRecordStoreError(code);
};
const marked = (comment) =>
  Buffer.from(comment.body, "utf8").includes(Buffer.from(RESERVED_PREFIX));

function assertPage(page, priorIds) {
  if (
    !Array.isArray(page?.items) ||
    typeof page.hasMore !== "boolean" ||
    (page.hasMore && typeof page.nextCursor !== "string") ||
    (!page.hasMore && page.nextCursor !== null)
  )
    fail("timeline-page-malformed");
  for (const comment of page.items) {
    if (!Number.isSafeInteger(comment?.id) || priorIds.has(comment.id))
      fail("timeline-comment-duplicate");
    priorIds.add(comment.id);
  }
}

async function scanComments({
  provider,
  budget,
  repository,
  issueNumber,
  mode,
}) {
  const limit = mode === "recovery" ? 100 : 2;
  const comments = [];
  const ids = new Set();
  let cursor = null;
  for (let pageCount = 0; pageCount < limit; pageCount += 1) {
    const page = await callLifecycleProvider(budget, () =>
      provider.listCommentsPage({
        repository,
        issueNumber,
        cursor,
        direction: "backward",
        limit: PAGE_SIZE,
      }),
    );
    assertPage(page, ids);
    comments.push(...page.items);
    if (!page.hasMore)
      return {
        comments,
        complete: true,
        cursor: null,
        pageCount: pageCount + 1,
      };
    cursor = page.nextCursor;
  }
  return { comments, complete: false, cursor, pageCount: limit };
}

function assertArtifactInventory(inventory, issueNumber) {
  if (!Array.isArray(inventory?.items) || inventory.complete !== true)
    fail("artifact-inventory-incomplete");
  const ids = new Set();
  const anchors = new Set();
  const comments = new Set();
  for (const artifact of inventory.items) {
    if (
      artifact.name !== `keiko-lifecycle-anchor-v1-issue-${issueNumber}` ||
      ids.has(artifact.id) ||
      anchors.has(artifact.anchorIdentity) ||
      comments.has(artifact.commentId)
    )
      fail("artifact-inventory-conflict");
    ids.add(artifact.id);
    anchors.add(artifact.anchorIdentity);
    comments.add(artifact.commentId);
  }
}

function parseMarkedComments(comments, parseEnvelope, ignoredOrphan) {
  let ignored = false;
  const records = comments.filter(marked).flatMap((comment) => {
    if (comment.id === ignoredOrphan?.commentId) {
      const bodyDigest = createHash("sha256")
        .update(Buffer.from(comment.body, "utf8"))
        .digest("hex");
      if (bodyDigest !== ignoredOrphan.bodySha256)
        fail("ignored-orphan-body-mismatch");
      ignored = true;
      return [];
    }
    try {
      return [{ comment, parsed: parseEnvelope(comment.body) }];
    } catch {
      fail("lifecycle-comment-malformed");
    }
  });
  if (ignoredOrphan !== undefined && !ignored)
    fail("ignored-orphan-unavailable");
  return records;
}

function reconcileInventory(markedComments, artifacts, complete) {
  if (markedComments.length === 0 && artifacts.length === 0)
    return complete ? "empty" : fail("bootstrap-history-incomplete");
  const comments = new Set(markedComments.map(({ comment }) => comment.id));
  const anchors = new Set(artifacts.map((artifact) => artifact.commentId));
  for (const id of comments) {
    if (!anchors.has(id)) fail("lifecycle-comment-unanchored");
  }
  if (complete) {
    for (const id of anchors) {
      if (!comments.has(id)) fail("lifecycle-suffix-deleted");
    }
  }
  return complete ? "non-empty" : "recovery-required";
}

async function loadSnapshot(input) {
  const timeline = await scanComments(input);
  const inventory = await callLifecycleProvider(input.budget, () =>
    input.provider.listAnchorArtifacts({
      repository: input.repository,
      name: `keiko-lifecycle-anchor-v1-issue-${input.issueNumber}`,
      direction: "newest-first",
    }),
  );
  assertArtifactInventory(inventory, input.issueNumber);
  const records = parseMarkedComments(
    timeline.comments,
    input.parseEnvelope,
    input.ignoredOrphan,
  );
  const state = reconcileInventory(records, inventory.items, timeline.complete);
  return { timeline, inventory, records, state };
}

function comparable(snapshot) {
  return {
    timeline: snapshot.timeline,
    inventory: snapshot.inventory,
    records: snapshot.records.map(({ comment, parsed }) => ({
      comment,
      recordType: parsed.recordType,
      recordDigest: parsed.recordDigest,
      fields: parsed.fields,
    })),
    state: snapshot.state,
  };
}

export async function readStableLifecycleSnapshot({
  provider,
  repository,
  issueNumber,
  mode = "normal",
  budget = createLifecycleProviderBudget(mode),
  parseEnvelope = parseRecordEnvelope,
  ignoredOrphan,
}) {
  const input = {
    provider,
    repository,
    issueNumber,
    mode,
    budget,
    parseEnvelope,
    ignoredOrphan,
  };
  const first = await loadSnapshot(input);
  const second = await loadSnapshot(input);
  if (!isDeepStrictEqual(comparable(first), comparable(second)))
    fail("lifecycle-snapshot-unstable");
  return Object.freeze(first);
}

function predecessor(record) {
  const fields = record.parsed.fields;
  const commentId = fields.predecessor_comment_id;
  const digest = fields.predecessor_record_digest;
  if ((commentId === null) !== (digest === null))
    fail("record-predecessor-pair-invalid");
  return { commentId, digest };
}

function selectLiveRecords(records) {
  const checkpointIndex = records.findIndex(
    ({ parsed }) => parsed.recordType === "transition-read-back",
  );
  if (checkpointIndex < 0) return { records, checkpoint: null };
  return {
    records: records.slice(0, checkpointIndex + 1),
    checkpoint: records[checkpointIndex],
  };
}

function orderChain(records, checkpoint) {
  if (records.length === 0) return [];
  const byId = new Map(records.map((record) => [record.comment.id, record]));
  const children = new Map();
  for (const record of records) {
    const prior = predecessor(record);
    if (prior.commentId === null || record === checkpoint) continue;
    const parent = byId.get(prior.commentId);
    if (!parent) fail("record-chain-gap");
    if (parent.parsed.recordDigest !== prior.digest)
      fail("record-predecessor-digest-mismatch");
    if (children.has(prior.commentId)) fail("record-chain-fork");
    children.set(prior.commentId, record);
  }
  const root =
    checkpoint ??
    records.find((record) => predecessor(record).commentId === null);
  if (!root) fail("record-chain-cycle");
  if (
    checkpoint === null &&
    records.filter((record) => predecessor(record).commentId === null)
      .length !== 1
  )
    fail("record-chain-root-conflict");
  const ordered = [];
  const visited = new Set();
  for (
    let current = root;
    current;
    current = children.get(current.comment.id)
  ) {
    if (visited.has(current.comment.id)) fail("record-chain-cycle");
    visited.add(current.comment.id);
    ordered.push(current);
  }
  if (visited.size !== records.length) fail("record-chain-conflict");
  return ordered;
}

async function authenticateRecords(input, records) {
  const authenticated = [];
  for (const record of records) {
    const tuple = await input.verifyTuple({
      provider: input.provider,
      repository: input.repository,
      issueNumber: input.issueNumber,
      commentId: record.comment.id,
      budget: input.budget,
    });
    if (
      tuple.parsed.recordDigest !== record.parsed.recordDigest ||
      !isDeepStrictEqual(tuple.parsed.fields, record.parsed.fields)
    )
      fail("record-authentication-conflict");
    authenticated.push(record);
  }
  return authenticated;
}

async function checkpointSummary(input, checkpoint) {
  if (checkpoint === null) return null;
  const evidence = await callLifecycleProvider(input.budget, () =>
    input.provider.getCheckpointEvidence({
      repository: input.repository,
      issueNumber: input.issueNumber,
      commentId: checkpoint.comment.id,
    }),
  );
  return verifyCheckpointEvidence({
    repository: input.repository,
    issueNumber: input.issueNumber,
    record: checkpoint.parsed.fields,
    commentId: checkpoint.comment.id,
    recordDigest: checkpoint.parsed.recordDigest,
    priorCheckpoint: evidence.priorCheckpoint,
    compactedMembers: evidence.compactedMembers,
  });
}

export async function reconstructLifecycleHistory(input) {
  const budget =
    input.budget ?? createLifecycleProviderBudget(input.mode ?? "normal");
  const snapshot = await readStableLifecycleSnapshot({ ...input, budget });
  if (snapshot.state !== "non-empty")
    return Object.freeze({ state: snapshot.state, budgetUsed: budget.used });
  const selected = selectLiveRecords(snapshot.records);
  if (
    selected.records.length - (selected.checkpoint === null ? 0 : 1) >
    LIVE_SUFFIX_LIMIT
  )
    fail("record-live-suffix-overflow");
  const verifyTuple = input.verifyTuple ?? verifyLifecycleRecordTuple;
  const records = await authenticateRecords(
    { ...input, budget, verifyTuple },
    selected.records,
  );
  const ordered = orderChain(records, selected.checkpoint);
  const checkpoint = await checkpointSummary(
    { ...input, budget },
    selected.checkpoint,
  );
  return Object.freeze({
    state: "authenticated",
    records: Object.freeze(ordered),
    checkpoint,
    predecessor: Object.freeze({
      commentId: ordered.at(-1).comment.id,
      recordDigest: ordered.at(-1).parsed.recordDigest,
    }),
    budgetUsed: budget.used,
  });
}

export const LIFECYCLE_LIVE_SUFFIX_LIMIT = LIVE_SUFFIX_LIMIT;
