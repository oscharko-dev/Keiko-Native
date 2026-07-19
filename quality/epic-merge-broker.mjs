import { isDeepStrictEqual } from "node:util";
import {
  compareLifecycleGenerationDigestV1,
  digestLifecycleGenerationV1,
} from "./lifecycle-generation.mjs";
import { evaluateNormalLifecycleHandoff } from "./lifecycle-handoff.mjs";
import { lifecycleObservation } from "./lifecycle-handoff-generation.mjs";
import { LIFECYCLE_STATES } from "./issue-lifecycle.mjs";

const same = isDeepStrictEqual;
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0;
const commit = (value) =>
  typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
const digest = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const uint = (value) => Number.isSafeInteger(value) && value >= 0;
const scalarTypes = Object.freeze({ boolean: "bool", string: "string" });
function exactNode(value) {
  if (value === null) return { type: "null" };
  if (Array.isArray(value))
    return { items: value.map(exactNode), type: "list" };
  if (record(value)) {
    return {
      fields: Object.keys(value)
        .toSorted()
        .map((name) => ({ name, value: exactNode(value[name]) })),
      type: "record",
    };
  }
  const type = uint(value) ? "uint" : scalarTypes[typeof value];
  return { type, value };
}
const failed = (action, code) =>
  Object.assign(
    { action, code },
    { automation: false, ok: false, retry: false },
  );
const humanOnly = (code) => failed("human_only", code);
const noAction = (code) => failed("none", code);
const automated = (action, extra = {}) =>
  Object.assign({ action, automation: true, ok: true, retry: false }, extra);
// prettier-ignore
const semanticsKeys = Object.freeze(["completePagination", "cursorOrdering", "dualRefConditional", "exactOutcome", "fencing", "liveProbe", "stableReads"]);
// prettier-ignore
const evidenceKeys = Object.freeze(["audit", "conversations", "external", "journey", "manual", "platform", "reviews"]);
// prettier-ignore
const normalProducerKeys = Object.freeze(["Issue contract current", "Lifecycle handoff", "PR contract"]);
// prettier-ignore
const producerKeys = Object.freeze([...evidenceKeys, "composition", ...normalProducerKeys]);
// prettier-ignore
const acceptedKeys = Object.freeze(["head", "mergeCommit", "parents", "pullRequest", "repository", "snapshotId", "status", "target", "targetTip"]);
// prettier-ignore
const issueLockKeys = Object.freeze(["acquired", "current", "fence", "issueIdentity", "repository"]);
// prettier-ignore
const targetLockKeys = Object.freeze(["acquired", "current", "fence", "repository", "target"]);
// prettier-ignore
const compositionKeys = Object.freeze(["base", "complete", "head", "producer", "result", "workflowRun"]);
// prettier-ignore
const resultKeys = Object.freeze(["current", "producer", "result", "workflowRun"]);
// prettier-ignore
const observationKeys = Object.freeze([["issueRevision", "issueUpdated"], ["lifecycle", "lifecycle"], ["readiness", "readiness"], ["target", "target"]]);
// prettier-ignore
const handoffIdentityKeys = Object.freeze(["head", "issueIdentity", "pullRequest", "repository", "target"]);
// prettier-ignore
const readIdentityKeys = Object.freeze(["repository", "target", "source", "issueIdentity", "issueUpdated", "cursor", "readiness"]);
// prettier-ignore
const snapshotKeys = Object.freeze(["id", "issueIdentity", "issueLock", "preSubmit", "targetLock", "value"]);
// prettier-ignore
const preSubmitKeys = Object.freeze(["head", "issueFence", "pullRequest", "repository", "target", "targetFence", "targetTip"]);
// prettier-ignore
const brokerReadKeys = Object.freeze(["composition", "contractFingerprint", "cursor", "draft", "evidence", "handoffInput", "head", "issueIdentity", "issueUpdated", "lifecycle", "mergeable", "pagination", "pullRequest", "readiness", "repository", "source", "target", "targetTip"]);
const exactKeys = (value, keys) =>
  record(value) && same(Object.keys(value).sort(), [...keys].sort());
function locksProven(locks) {
  if (!exactKeys(locks, ["issue", "order", "target"])) return false;
  if (!same(locks.order, ["issue", "target"])) return false;
  const shapes = [
    exactKeys(locks.issue, issueLockKeys),
    exactKeys(locks.target, targetLockKeys),
  ];
  return (
    shapes.every(Boolean) &&
    [locks.issue, locks.target].every(
      (lock) =>
        lock.acquired === true &&
        lock.current === true &&
        [lock.fence, lock.repository].every(text),
    )
  );
}
function lockScopesCurrent(locks, read) {
  return [
    locks.issue.issueIdentity === read.issueIdentity,
    locks.issue.repository === read.repository,
    locks.target.repository === read.repository,
    locks.target.target === read.target,
  ].every(Boolean);
}
function generationCurrent(handoff) {
  const generation = handoff?.generation;
  if (!record(generation) || !record(generation.value)) return false;
  return (
    generation.digest === digestLifecycleGenerationV1(generation.value) &&
    compareLifecycleGenerationDigestV1(generation.value, generation.digest)
  );
}
function resultCurrent(item, producer) {
  return (
    record(item) &&
    item.producer === producer &&
    [item.producer, item.workflowRun, item.result].every(text)
  );
}
function evidenceCurrent(evidence, expected) {
  if (!exactKeys(evidence, evidenceKeys)) return false;
  return evidenceKeys.every(
    (key) =>
      exactKeys(evidence[key], resultKeys) &&
      evidence[key].current === true &&
      resultCurrent(evidence[key], expected[key]),
  );
}
function brokerHandoff(read) {
  if (!generationCurrent(read.handoffInput)) return undefined;
  const decision = evaluateNormalLifecycleHandoff(read.handoffInput);
  if (!decision.ok) return undefined;
  const request = read.handoffInput.generationRequest;
  const observation = lifecycleObservation(request?.inputs);
  if (observation === undefined) return undefined;
  if (
    !observationKeys.every(
      ([observationKey, readKey]) =>
        observation[observationKey] === read[readKey],
    )
  )
    return undefined;
  const binding = read.handoffInput.classification.binding;
  return handoffIdentityKeys.every((key) => binding[key] === read[key])
    ? decision
    : undefined;
}
function paginationCurrent(pagination, cursor) {
  const keys = ["complete", "cursor", "pages", "truncated"];
  if (!exactKeys(pagination, keys)) return false;
  if (pagination.complete !== true || pagination.truncated !== false)
    return false;
  if (pagination.cursor !== cursor || !Array.isArray(pagination.pages))
    return false;
  if (pagination.pages.length === 0) return false;
  const boundaries = [cursor];
  const valid = pagination.pages.every((page, index) => {
    const pageKeys = ["count", "end", "index", "start"];
    const prior = index === 0 ? cursor : pagination.pages[index - 1].end;
    boundaries.push(page?.end);
    return [
      exactKeys(page, pageKeys),
      page.index === index &&
        Number.isSafeInteger(page.count) &&
        page.count >= 0 &&
        text(page.start) &&
        text(page.end),
      page.start === prior,
    ].every(Boolean);
  });
  return valid && new Set(boundaries).size === boundaries.length;
}
function basicReadProven(read) {
  if (!exactKeys(read, brokerReadKeys)) return false;
  return [
    readIdentityKeys.every((key) => text(read[key])),
    [read.targetTip, read.head].every(commit),
    Number.isSafeInteger(read.pullRequest),
    digest(read.contractFingerprint),
    LIFECYCLE_STATES.includes(read.lifecycle),
    typeof read.draft === "boolean",
    typeof read.mergeable === "boolean",
  ].every(Boolean);
}
function providerReadProven(read, expected) {
  if (!basicReadProven(read) || !record(read.handoffInput)) return false;
  const { composition, handoffInput } = read;
  if (!record(composition) || !record(handoffInput.generation)) return false;
  const actual = handoffInput.generation.expectedProducers;
  const readiness = handoffInput.readiness;
  return [
    exactKeys(expected, producerKeys),
    producerKeys.every((key) => text(expected[key])),
    paginationCurrent(read.pagination, read.cursor),
    exactKeys(composition, compositionKeys),
    composition.complete === true,
    composition.base === read.targetTip,
    composition.head === read.head,
    resultCurrent(composition, expected.composition),
    evidenceCurrent(read.evidence, expected),
    generationCurrent(handoffInput),
    record(readiness),
    readiness?.currentFingerprint === read.contractFingerprint,
    read.readiness ===
      `${readiness?.expectedCommentId}:${readiness?.currentVersion}:${read.contractFingerprint}`,
    exactKeys(actual, normalProducerKeys),
    normalProducerKeys.every((key) => actual?.[key] === expected[key]),
  ].every(Boolean);
}
function observedRead(read, expected) {
  if (!providerReadProven(read, expected)) return { kind: "human_only" };
  if (read.target === "dev" || !/^epic\//u.test(read.target))
    return { kind: "human_only" };
  const eligible = [
    read.lifecycle === "status: ready for human review",
    read.draft === false,
    read.mergeable === true,
  ].every(Boolean);
  if (!eligible) return { kind: "none" };
  const handoff = brokerHandoff(read);
  if (handoff === undefined) return { kind: "none" };
  return { handoff, kind: "eligible", read };
}
function stableRead(input) {
  const first = observedRead(input.firstRead, input.expectedProducers);
  const second = observedRead(input.secondRead, input.expectedProducers);
  if ([first.kind, second.kind].includes("human_only"))
    return first.kind === "human_only" ? first : second;
  if ([first.kind, second.kind].includes("none")) return { kind: "none" };
  return same(first.read, second.read) ? second : { kind: "none" };
}
function snapshotValue(read, input, handoff) {
  const { handoffInput, ...observation } = read;
  observation.generation = handoffInput.generation.digest;
  return {
    algorithm: "sha-256",
    attemptSequence: 0,
    domain: "keiko-native.lifecycle-input-generation",
    head: read.head,
    inputs: exactNode({
      expectedProducers: input.expectedProducers,
      handoffBinding: handoff.binding,
      locks: input.locks,
      observation,
    }),
    lane: "normal",
    pullRequest: read.pullRequest,
    repository: read.repository,
    schema: 1,
    submode: null,
  };
}
function immutable(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
export function bindEpicMergeAuthorizationSnapshot(input) {
  try {
    if (
      !exactKeys(input?.semantics, semanticsKeys) ||
      !semanticsKeys.every((key) => input.semantics[key] === true)
    )
      return humanOnly("automation_not_proven");
    if (!locksProven(input.locks)) return humanOnly("lock_semantics_unproven");
    const current = stableRead(input);
    if (current.kind === "human_only")
      return humanOnly("broker_observation_unproven");
    if (current.kind === "none") return noAction("broker_observation_changed");
    const { handoff, read } = current;
    if (!lockScopesCurrent(input.locks, read))
      return humanOnly("lock_scope_mismatch");
    const value = snapshotValue(read, input, handoff);
    const id = digestLifecycleGenerationV1(value);
    if (!compareLifecycleGenerationDigestV1(value, id))
      return humanOnly("snapshot_digest_unproven");
    return {
      ok: true,
      snapshot: immutable({
        id,
        issueIdentity: read.issueIdentity,
        issueLock: structuredClone(input.locks.issue),
        preSubmit: {
          head: read.head,
          issueFence: input.locks.issue.fence,
          pullRequest: read.pullRequest,
          repository: read.repository,
          target: read.target,
          targetFence: input.locks.target.fence,
          targetTip: read.targetTip,
        },
        targetLock: structuredClone(input.locks.target),
        value,
      }),
    };
  } catch {
    return humanOnly("invalid_broker_evidence");
  }
}
function conditionalRequest(snapshot) {
  return {
    expectedHead: snapshot.preSubmit.head,
    expectedTargetTip: snapshot.preSubmit.targetTip,
    issueLock: snapshot.issueLock,
    preSubmit: snapshot.preSubmit,
    snapshotId: snapshot.id,
    targetLock: snapshot.targetLock,
  };
}
function acceptedOutcome(response, snapshot) {
  if (!record(response) || response.status !== "accepted") return false;
  const proof = snapshot.preSubmit;
  return [
    exactKeys(response, acceptedKeys),
    response.snapshotId === snapshot.id,
    response.repository === proof.repository,
    response.target === proof.target,
    response.pullRequest === proof.pullRequest,
    response.head === proof.head,
    commit(response.mergeCommit),
    response.targetTip === response.mergeCommit,
    same(response.parents, [proof.targetTip, proof.head]),
  ].every(Boolean);
}
const nodeField = (node, name) =>
  node?.fields?.find((item) => item.name === name)?.value;
const nodeSame = (node, name, value) =>
  same(nodeField(node, name), exactNode(value));
function snapshotCurrent(snapshot) {
  if (!exactKeys(snapshot, snapshotKeys)) return false;
  const locks = {
    issue: snapshot.issueLock,
    order: ["issue", "target"],
    target: snapshot.targetLock,
  };
  const proof = snapshot.preSubmit;
  const inputs = snapshot.value?.inputs;
  const observation = nodeField(inputs, "observation");
  return [
    preSubmitCurrent(proof),
    digest(snapshot.id),
    locksProven(locks),
    lockScopesCurrent(locks, {
      ...proof,
      issueIdentity: snapshot.issueIdentity,
    }),
    snapshot.value?.head === proof.head,
    snapshot.value?.pullRequest === proof.pullRequest,
    snapshot.value?.repository === proof.repository,
    nodeSame(inputs, "locks", locks),
    nodeSame(observation, "issueIdentity", snapshot.issueIdentity),
    nodeSame(observation, "target", proof.target),
    nodeSame(observation, "targetTip", proof.targetTip),
    compareLifecycleGenerationDigestV1(snapshot.value, snapshot.id),
  ].every(Boolean);
}
function preSubmitCurrent(read) {
  return [
    exactKeys(read, preSubmitKeys),
    [read.head, read.targetTip].every(commit),
    Number.isSafeInteger(read.pullRequest),
    [read.repository, read.target, read.issueFence, read.targetFence].every(
      text,
    ),
  ].every(Boolean);
}
function validLedger(value) {
  if (!Array.isArray(value)) return false;
  return value.every(digest) && new Set(value).size === value.length;
}
function responseDecision(response, snapshot) {
  if (response === undefined) {
    return automated("submit_once", { request: conditionalRequest(snapshot) });
  }
  if (acceptedOutcome(response, snapshot)) return automated("accepted");
  return exactKeys(response, ["status"]) && response.status === "rejected"
    ? noAction("conditional_rejected")
    : humanOnly("conditional_outcome_ambiguous");
}
export function decideEpicMergeAuthorization(input) {
  try {
    const bound = bindEpicMergeAuthorizationSnapshot(input);
    if (!bound.ok) return bound;
    if (!validLedger(input.submittedSnapshots))
      return humanOnly("submission_ledger_unproven");
    const snapshot = bound.snapshot;
    if (!snapshotCurrent(input.snapshotReadback))
      return humanOnly("broker_snapshot_readback_unproven");
    if (!same(input.snapshotReadback, snapshot))
      return noAction("broker_snapshot_readback_mismatch");
    if (input.submittedSnapshots.includes(snapshot.id))
      return humanOnly("snapshot_already_submitted");
    if (!preSubmitCurrent(input.preSubmitRead))
      return humanOnly("pre_submit_read_unproven");
    if (!same(input.preSubmitRead, snapshot.preSubmit))
      return noAction("pre_submit_identity_changed");
    return responseDecision(input.conditionalResponse, snapshot);
  } catch {
    return humanOnly("invalid_broker_decision");
  }
}
