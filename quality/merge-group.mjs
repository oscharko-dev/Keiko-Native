import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  compareLifecycleGenerationDigestV1,
  digestLifecycleGenerationV1,
} from "./lifecycle-generation.mjs";
import {
  classifyLifecycleHandoffLane,
  evaluateNormalLifecycleHandoff,
  evaluatePublicationLifecycleHandoff,
} from "./lifecycle-handoff.mjs";
import { verifyPublicationCandidate } from "./publication-candidate.mjs";

const reject = (code) => ({ code, ok: false });
const same = isDeepStrictEqual;
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0;
const commit = (value) =>
  typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
const compareText = (left, right) => (left > right) - (left < right);
const digest = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const typed = (type, value) => ({ type, value });
const field = (name, value) => ({ name, value });
const nullable = (value) =>
  value === null ? { type: "null" } : typed("enum", value);
const scalarTypes = Object.freeze({ boolean: "bool", string: "string" });
const scalarType = (value) =>
  Number.isSafeInteger(value) && value >= 0
    ? "uint"
    : scalarTypes[typeof value];
const exactKeys = (value, keys) =>
  record(value) &&
  same(Object.keys(value).toSorted(compareText), keys.toSorted(compareText));
// prettier-ignore
const normalProducerKeys = Object.freeze(["Issue contract current", "Lifecycle handoff", "PR contract"]);
// prettier-ignore
const publicationProducerKeys = Object.freeze(["Contract publication", ...normalProducerKeys]);
// prettier-ignore
const groupReadKeys = Object.freeze(["baseTip", "baseTree", "cursor", "groupCommit", "groupSha", "groupTree", "members", "ordering", "pagination", "repository", "target"]);
// prettier-ignore
const groupMemberKeys = Object.freeze(["handoffInput", "head", "inputTree", "laneInput", "order", "outputTree", "pullRequest"]);

function exactNode(value) {
  if (value === null) return { type: "null" };
  if (Array.isArray(value))
    return { items: value.map(exactNode), type: "list" };
  if (record(value)) {
    return {
      fields: Object.keys(value)
        .toSorted(compareText)
        .map((name) => field(name, exactNode(value[name]))),
      type: "record",
    };
  }
  return typed(scalarType(value), value);
}

function generationCurrent(input) {
  const generation = input?.generation;
  if (!record(generation) || !record(generation.value)) return false;
  return (
    generation.digest === digestLifecycleGenerationV1(generation.value) &&
    compareLifecycleGenerationDigestV1(generation.value, generation.digest)
  );
}

function publicationCurrent(input, classification) {
  if (classification.binding.lane !== "publication") return true;
  return verifyPublicationCandidate(input.handoffInput.candidate).ok === true;
}

function constituentIdentityMatches(binding, input) {
  return [
    binding.head === input.head,
    binding.pullRequest === input.pullRequest,
  ].every(Boolean);
}

function classifyConstituent(input) {
  const classification = classifyLifecycleHandoffLane(input.laneInput);
  if (!classification.ok) return reject("constituent_lane_invalid");
  if (!same(classification, input.handoffInput.classification))
    return reject("constituent_lane_mismatch");
  if (!generationCurrent(input.handoffInput))
    return reject("constituent_generation_invalid");
  if (!publicationCurrent(input, classification))
    return reject("constituent_publication_invalid");
  const publication = classification.binding.lane === "publication";
  const handoffInput = { ...input.handoffInput, laneInput: input.laneInput };
  const decision = publication
    ? evaluatePublicationLifecycleHandoff(handoffInput)
    : evaluateNormalLifecycleHandoff(handoffInput);
  const binding = classification.binding;
  if (!decision.ok) return reject("constituent_handoff_invalid");
  if (!constituentIdentityMatches(binding, input))
    return reject("constituent_identity_mismatch");
  return { binding, decision, generation: input.handoffInput.generation };
}

export function classifyMergeGroupConstituent(input) {
  try {
    const result = classifyConstituent(input);
    if (result.ok === false) return result;
    const { binding, decision, generation } = result;
    return {
      binding: {
        generation: generation.digest,
        handoff: structuredClone(decision.binding),
        head: binding.head,
        issueIdentity: binding.issueIdentity,
        lane: binding.lane,
        pullRequest: binding.pullRequest,
        repository: binding.repository,
        submode: binding.submode ?? null,
        target: binding.target,
      },
      ok: true,
    };
  } catch {
    return reject("invalid_constituent_evidence");
  }
}

function pageMembers(page, index) {
  if (!record(page)) return undefined;
  const keys = ["end", "index", "members", "start"];
  const shape = [
    page.index === index,
    Array.isArray(page.members),
    text(page.start),
    text(page.end),
    same(Object.keys(page).toSorted(compareText), keys.toSorted(compareText)),
  ];
  if (!shape.every(Boolean)) return undefined;
  return page.members.every(Number.isSafeInteger) ? page.members : undefined;
}

function paginationMembers(read) {
  const pagination = read.pagination;
  if (!exactKeys(pagination, ["complete", "pages", "truncated"]))
    return undefined;
  const valid = [
    pagination.complete === true,
    pagination.truncated === false,
    Array.isArray(pagination.pages),
  ];
  if (!valid.every(Boolean)) return undefined;
  const members = [];
  const boundaries = [read.cursor];
  for (let index = 0; index < pagination.pages.length; index += 1) {
    const current = pagination.pages[index];
    const page = pageMembers(current, index);
    if (page === undefined) return undefined;
    const prior = index === 0 ? read.cursor : pagination.pages[index - 1].end;
    if (current.start !== prior) return undefined;
    boundaries.push(current.end);
    members.push(...page);
  }
  return new Set(boundaries).size === boundaries.length ? members : undefined;
}

function memberPolicyCurrent(member, binding, policy, read) {
  const keys =
    binding.lane === "publication"
      ? publicationProducerKeys
      : normalProducerKeys;
  const actual = member.handoffInput.generation.expectedProducers;
  return [
    binding.repository === read.repository,
    binding.target === read.target,
    exactKeys(actual, keys),
    keys.every((key) => actual?.[key] === policy[key]),
  ].every(Boolean);
}

function memberSetCurrent(read, paginated) {
  const pulls = read.members.map(({ pullRequest }) => pullRequest);
  const heads = read.members.map(({ head }) => head);
  return [
    same(paginated, pulls),
    new Set(pulls).size === pulls.length,
    new Set(heads).size === heads.length,
    !heads.includes(read.groupSha),
  ].every(Boolean);
}

function classifyOrderedMember(member, order) {
  if (member.order !== order) return reject("order");
  return classifyMergeGroupConstituent(member);
}

function classifiedMembers(read, policy) {
  if (!Array.isArray(read.members) || read.members.length === 0)
    return undefined;
  if (!read.members.every((member) => exactKeys(member, groupMemberKeys)))
    return undefined;
  const paginated = paginationMembers(read);
  if (!memberSetCurrent(read, paginated)) return undefined;
  const classified = read.members.map(classifyOrderedMember);
  if (!classified.every(({ ok }) => ok)) return undefined;
  const bindings = classified.map(({ binding }) => binding);
  if (!exactKeys(policy, publicationProducerKeys)) return undefined;
  if (!publicationProducerKeys.every((key) => text(policy[key])))
    return undefined;
  return bindings.every((binding, index) =>
    memberPolicyCurrent(read.members[index], binding, policy, read),
  )
    ? bindings
    : undefined;
}

function stableRead(input) {
  if (input.event !== "checks_requested") return undefined;
  if (!record(input.firstRead) || !same(input.firstRead, input.secondRead))
    return undefined;
  const read = input.secondRead;
  if (!exactKeys(read, groupReadKeys)) return undefined;
  const identities = [
    read.repository,
    read.target,
    read.cursor,
    read.baseTip,
    read.baseTree,
    read.groupSha,
    read.groupTree,
  ];
  if (!identities.slice(0, 3).every(text) || read.target !== "dev")
    return undefined;
  if (!identities.slice(3).every(commit) || read.ordering !== "proven")
    return undefined;
  return read;
}

function memberNode(member) {
  return {
    fields: [
      field("pullRequest", typed("uint", member.pullRequest)),
      field("head", typed("string", member.head)),
      field("issueIdentity", typed("string", member.issueIdentity)),
      field("lane", typed("enum", member.lane)),
      field("submode", nullable(member.submode)),
      field("generation", typed("string", member.generation)),
      field("handoffBinding", exactNode(member.handoff)),
    ],
    type: "record",
  };
}

function snapshotValue(read, members, expectedProducers) {
  return {
    algorithm: "sha-256",
    attemptSequence: 0,
    domain: "keiko-native.lifecycle-input-generation",
    head: read.groupSha,
    inputs: {
      fields: [
        field("target", typed("string", read.target)),
        field("baseTip", typed("string", read.baseTip)),
        field("baseTree", typed("string", read.baseTree)),
        field("groupTree", typed("string", read.groupTree)),
        field("cursor", typed("string", read.cursor)),
        field("pagination", exactNode(read.pagination)),
        field("expectedProducers", exactNode(expectedProducers)),
        field("members", { items: members.map(memberNode), type: "list" }),
      ],
      type: "record",
    },
    lane: "normal",
    pullRequest: 0,
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

export function bindMergeGroupSnapshot(input) {
  try {
    const read = stableRead(input);
    if (read === undefined) return reject("unstable_group_observation");
    if (!verifyGroupCommitTree(read).ok) return reject("invalid_group_commit");
    const members = classifiedMembers(read, input.expectedProducers);
    if (members === undefined) return reject("invalid_group_membership");
    if (!verifyCombinedGroupTree(read).ok)
      return reject("invalid_group_composition");
    const value = snapshotValue(read, members, input.expectedProducers);
    const id = digestLifecycleGenerationV1(value);
    if (!compareLifecycleGenerationDigestV1(value, id))
      return reject("invalid_group_snapshot_digest");
    return {
      ok: true,
      snapshot: immutable({
        baseTip: read.baseTip,
        baseTree: read.baseTree,
        cursor: read.cursor,
        groupSha: read.groupSha,
        groupTree: read.groupTree,
        id,
        members,
        repository: read.repository,
        target: read.target,
        value,
      }),
    };
  } catch {
    return reject("invalid_group_evidence");
  }
}

// prettier-ignore
export function verifyGroupCommitTree(input) {
  try {
    const bytes = input?.groupCommit;
    if (!(bytes instanceof Uint8Array)) return reject("invalid_group_commit");
    const algorithm = { 40: "sha1", 64: "sha256" }[input.groupSha?.length];
    if (!algorithm || input.groupTree?.length !== input.groupSha.length) return reject("unsupported_group_object_id");
    const header = Buffer.from(`commit ${bytes.byteLength}\0`);
    if (createHash(algorithm).update(header).update(bytes).digest("hex") !== input.groupSha) return reject("group_commit_hash_mismatch");
    const end = bytes.indexOf(10);
    if (end < 0) return reject("invalid_group_commit");
    const tree = Buffer.from(bytes.subarray(0, end)).toString("ascii").match(/^tree ([0-9a-f]{40}|[0-9a-f]{64})$/u)?.[1];
    if (tree !== input.groupTree) return reject("group_commit_tree_mismatch");
    return { ok: true };
  } catch {
    return reject("invalid_group_commit");
  }
}

export function evaluateMergeGroup(input) {
  try {
    const invalidated = input.invalidatedSnapshots;
    if (
      !Array.isArray(invalidated) ||
      !invalidated.every(digest) ||
      new Set(invalidated).size !== invalidated.length
    )
      return reject("invalid_invalidation_ledger");
    const bound = bindMergeGroupSnapshot(input);
    if (!bound.ok) return bound;
    const snapshot = bound.snapshot;
    if (!same(input.snapshotReadback, snapshot))
      return reject("group_snapshot_readback_mismatch");
    if (!compareLifecycleGenerationDigestV1(snapshot.value, snapshot.id))
      return reject("group_snapshot_digest_mismatch");
    if (invalidated.includes(snapshot.id))
      return reject("group_snapshot_invalidated");
    return {
      action: "publish",
      head: snapshot.groupSha,
      laneIdentities: snapshot.members,
      ok: true,
      snapshotId: snapshot.id,
      status: "success",
    };
  } catch {
    return reject("invalid_group_evaluation");
  }
}

function nextTree(member, tree) {
  if (!record(member)) return reject("invalid_tree_member");
  if (![commit(member.inputTree), commit(member.outputTree)].every(Boolean))
    return reject("invalid_tree_member");
  return member.inputTree === tree
    ? { ok: true, tree: member.outputTree }
    : reject("tree_chain_mismatch");
}

export function verifyCombinedGroupTree(input) {
  try {
    const valid = record(input)
      ? [commit(input.baseTree), commit(input.groupTree)].every(Boolean)
      : false;
    if (!valid) return reject("invalid_tree_evidence");
    if (
      ![Array.isArray(input.members), input.members?.length > 0].every(Boolean)
    )
      return reject("empty_group_composition");
    let tree = input.baseTree;
    for (const member of input.members) {
      const next = nextTree(member, tree);
      if (!next.ok) return next;
      tree = next.tree;
    }
    return tree === input.groupTree
      ? { ok: true }
      : reject("group_tree_mismatch");
  } catch {
    return reject("invalid_tree_evidence");
  }
}
