import { isDeepStrictEqual } from "node:util";

import {
  bindEpicMergeAuthorizationSnapshot,
  decideEpicMergeAuthorization,
} from "./epic-merge-broker.mjs";

const inputKeys = Object.freeze([
  "conditionalResponse",
  "expectedProducers",
  "firstRead",
  "locks",
  "preSubmitRead",
  "secondRead",
  "semantics",
  "snapshotReadback",
  "submittedSnapshots",
]);
const responseKeys = Object.freeze([
  "head",
  "mergeCommit",
  "parents",
  "pullRequest",
  "repository",
  "snapshotId",
  "status",
  "target",
  "targetTip",
]);
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(
      Object.keys(value).toSorted(compare),
      [...expected].toSorted(compare),
    )
  );
}

export function sourceFromSnapshot(snapshot) {
  return snapshot.value.inputs.fields
    .find(({ name }) => name === "observation")
    ?.value.fields.find(({ name }) => name === "source")?.value.value;
}

export function proveAcceptedEpicMergeEffect(input) {
  try {
    if (
      !exactKeys(input, inputKeys) ||
      !exactKeys(input.conditionalResponse, responseKeys)
    )
      return undefined;
    const bound = bindEpicMergeAuthorizationSnapshot(input);
    if (!bound.ok || decideEpicMergeAuthorization(input).action !== "accepted")
      return undefined;
    const snapshot = bound.snapshot;
    const response = input.conditionalResponse;
    if (
      !isDeepStrictEqual(input.snapshotReadback, snapshot) ||
      !input.submittedSnapshots.includes(snapshot.id) ||
      response.snapshotId !== snapshot.id
    )
      return undefined;
    return Object.freeze({
      base: snapshot.preSubmit.targetTip,
      head: snapshot.preSubmit.head,
      issueFence: snapshot.preSubmit.issueFence,
      issueIdentity: snapshot.issueIdentity,
      mergeCommit: response.mergeCommit,
      parents: Object.freeze([...response.parents]),
      pullRequest: snapshot.preSubmit.pullRequest,
      repository: snapshot.preSubmit.repository,
      snapshotId: snapshot.id,
      source: sourceFromSnapshot(snapshot),
      target: snapshot.preSubmit.target,
      targetFence: snapshot.preSubmit.targetFence,
      targetTip: response.targetTip,
    });
  } catch {
    return undefined;
  }
}
