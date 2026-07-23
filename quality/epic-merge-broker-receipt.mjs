import { isDeepStrictEqual } from "node:util";

import { compareCodeUnits } from "./deterministic-order.mjs";
import {
  acceptedEpicMergeOutcomeCurrent,
  bindEpicMergeAuthorizationSnapshot,
  epicMergeAuthorizationSnapshotCurrent,
} from "./epic-merge-broker.mjs";
import {
  proveAcceptedEpicMergeEffect,
  sourceFromSnapshot,
} from "./epic-merge-broker-effect.mjs";
import {
  EPIC_MERGE_RECEIPT_ALGORITHM,
  canonicalReceiptPayloadBytes,
  verifyRsaPssReceiptSignature,
} from "./epic-merge-broker-receipt-crypto.mjs";

export const EPIC_MERGE_BROKER_RECEIPT_SCHEMA =
  "keiko-native-epic-merge-broker-receipt/v3";

const digestPattern = /^[0-9a-f]{64}$/u;
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function exactKeys(value, expected) {
  return (
    record(value) &&
    isDeepStrictEqual(
      Object.keys(value).toSorted(compareCodeUnits),
      [...expected].toSorted(compareCodeUnits),
    )
  );
}

export function createAcceptedEpicMergeReceipt(
  input,
  requestId,
  signingCapability,
) {
  const effect = proveAcceptedEpicMergeEffect(input);
  const bound = bindEpicMergeAuthorizationSnapshot(input);
  if (
    effect === undefined ||
    !bound.ok ||
    !digestPattern.test(requestId) ||
    !epicMergeAuthorizationSnapshotCurrent(bound.snapshot) ||
    !acceptedEpicMergeOutcomeCurrent(input.conditionalResponse, bound.snapshot)
  )
    return undefined;
  const payload = {
    authorizationSnapshot: structuredClone(bound.snapshot),
    conditionalResponse: structuredClone(input.conditionalResponse),
    requestId,
    schema: EPIC_MERGE_BROKER_RECEIPT_SCHEMA,
  };
  if (
    signingCapability?.algorithm !== EPIC_MERGE_RECEIPT_ALGORITHM ||
    !digestPattern.test(signingCapability?.keyFingerprint) ||
    typeof signingCapability?.sign !== "function"
  )
    return undefined;
  const signature = signingCapability.sign(
    canonicalReceiptPayloadBytes(payload),
  );
  return Object.freeze({
    algorithm: EPIC_MERGE_RECEIPT_ALGORITHM,
    keyFingerprint: signingCapability.keyFingerprint,
    payload,
    signature,
  });
}

export function acceptedEpicMergeEffectFromReceipt(
  receipt,
  publicKey,
  keyFingerprint,
) {
  try {
    if (
      !exactKeys(receipt, [
        "algorithm",
        "keyFingerprint",
        "payload",
        "signature",
      ]) ||
      !exactKeys(receipt.payload, [
        "authorizationSnapshot",
        "conditionalResponse",
        "requestId",
        "schema",
      ]) ||
      receipt.payload.schema !== EPIC_MERGE_BROKER_RECEIPT_SCHEMA ||
      !digestPattern.test(receipt.payload.requestId) ||
      !verifyRsaPssReceiptSignature(receipt, publicKey, keyFingerprint) ||
      !epicMergeAuthorizationSnapshotCurrent(
        receipt.payload.authorizationSnapshot,
      ) ||
      !acceptedEpicMergeOutcomeCurrent(
        receipt.payload.conditionalResponse,
        receipt.payload.authorizationSnapshot,
      )
    )
      return undefined;
    const snapshot = receipt.payload.authorizationSnapshot;
    const response = receipt.payload.conditionalResponse;
    return Object.freeze({
      base: snapshot.preSubmit.targetTip,
      head: snapshot.preSubmit.head,
      issueFence: snapshot.preSubmit.issueFence,
      issueIdentity: snapshot.issueIdentity,
      mergeCommit: response.mergeCommit,
      parents: Object.freeze([...response.parents]),
      pullRequest: snapshot.preSubmit.pullRequest,
      repository: snapshot.preSubmit.repository,
      requestId: receipt.payload.requestId,
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
