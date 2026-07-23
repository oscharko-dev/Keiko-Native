import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  acceptedEpicMergeEffectFromReceipt,
  createAcceptedEpicMergeReceipt,
} from "./epic-merge-broker-receipt.mjs";
import { canonicalReceiptPayloadBytes } from "./epic-merge-broker-receipt-crypto.mjs";
import { acceptedBrokerAuthorizationInput } from "./repository-controls-broker.test-fixtures.mjs";

const requestId = "9".repeat(64);
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const wrongKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = keys.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();
const wrongPublicKey = wrongKeys.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();
const fingerprint = (key) =>
  createHash("sha256")
    .update(key.export({ format: "der", type: "spki" }))
    .digest("hex");
const keyFingerprint = fingerprint(keys.publicKey);
const signer = Object.freeze({
  algorithm: "RSA-PSS-SHA256",
  keyFingerprint,
  sign: (payload) =>
    sign("sha256", payload, {
      key: keys.privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString("base64url"),
});

const receipt = () =>
  createAcceptedEpicMergeReceipt(
    acceptedBrokerAuthorizationInput(),
    requestId,
    signer,
  );
const verify = (value, key = publicKey, digest = keyFingerprint) =>
  acceptedEpicMergeEffectFromReceipt(value, key, digest);

test("signs a closed canonical broker receipt without raw provider bodies", () => {
  const value = receipt();
  assert.deepEqual(Object.keys(value).sort(), [
    "algorithm",
    "keyFingerprint",
    "payload",
    "signature",
  ]);
  assert.equal(verify(value)?.requestId, requestId);
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /PRIVATE KEY|brokerDecisionInput/u);
  for (const rawProviderText of [
    "<!-- keiko-native-readiness -->",
    "handoff-result",
    "comments",
    "body",
  ])
    assert.doesNotMatch(serialized, new RegExp(rawProviderText, "u"));
});

test("canonicalizes receipt objects with deterministic code-unit ordering", () => {
  assert.equal(
    canonicalReceiptPayloadBytes({ z: 2, Z: 1, ä: 3 }).toString("utf8"),
    '{"Z":1,"z":2,"ä":3}',
  );
});

test("rejects unsigned, wrong-key, wrong-algorithm, and malformed receipts", () => {
  const value = receipt();
  const { signature: _signature, ...unsigned } = value;
  assert.equal(verify(unsigned), undefined);
  assert.equal(
    verify(value, wrongPublicKey, fingerprint(wrongKeys.publicKey)),
    undefined,
  );
  for (const mutate of [
    (item) => (item.algorithm = "RSA-PKCS1-SHA256"),
    (item) => (item.keyFingerprint = "f".repeat(64)),
    (item) => (item.signature = "not+canonical/base64"),
    (item) =>
      (item.receiptId = createHash("sha256")
        .update(JSON.stringify(item.payload))
        .digest("hex")),
  ]) {
    const item = structuredClone(value);
    mutate(item);
    assert.equal(verify(item), undefined);
  }
});

test("rejects forged snapshots, outcomes, and signature replay", () => {
  for (const mutate of [
    (value) => (value.payload.authorizationSnapshot.id = "d".repeat(64)),
    (value) =>
      (value.payload.authorizationSnapshot.preSubmit.issueFence =
        "forged-issue-fence"),
    (value) => value.payload.conditionalResponse.parents.reverse(),
    (value) => {
      value.payload.authorizationSnapshot.preSubmit.issueFence =
        "forged-issue-fence";
      value.payload.conditionalResponse.mergeCommit = "6".repeat(40);
      value.payload.conditionalResponse.targetTip = "6".repeat(40);
    },
  ]) {
    const value = receipt();
    mutate(value);
    assert.equal(verify(value), undefined);
  }
});
