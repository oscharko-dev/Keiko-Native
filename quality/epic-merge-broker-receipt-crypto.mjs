import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

export const EPIC_MERGE_RECEIPT_ALGORITHM = "RSA-PSS-SHA256";
const digestPattern = /^[0-9a-f]{64}$/u;
const signaturePattern = /^[A-Za-z0-9_-]+$/u;

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("receipt_number_invalid");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === undefined || typeof value !== "object")
    throw new Error("receipt_value_invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("receipt_object_invalid");
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

export function canonicalReceiptPayloadBytes(payload) {
  return Buffer.from(JSON.stringify(canonicalValue(payload)), "utf8");
}

function publicKeyDetails(value) {
  try {
    if (typeof value !== "string") return undefined;
    const key = createPublicKey(value);
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      return undefined;
    const pem = key.export({ format: "pem", type: "spki" }).toString();
    if (pem !== value) return undefined;
    const der = key.export({ format: "der", type: "spki" });
    return {
      fingerprint: createHash("sha256").update(der).digest("hex"),
      key,
    };
  } catch {
    return undefined;
  }
}

export function receiptPublicKeyFingerprint(publicKey) {
  return publicKeyDetails(publicKey)?.fingerprint;
}

export function receiptVerificationKeyValid(publicKey, fingerprint) {
  const details = publicKeyDetails(publicKey);
  return (
    details !== undefined &&
    digestPattern.test(fingerprint) &&
    details.fingerprint === fingerprint
  );
}

export function createRsaPssReceiptSigningCapability(privateKey) {
  const key =
    privateKey?.type === "private" ? privateKey : createPrivateKey(privateKey);
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  )
    throw new Error("receipt_signing_key_invalid");
  const publicKey = createPublicKey(key);
  const fingerprint = createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  return Object.freeze({
    algorithm: EPIC_MERGE_RECEIPT_ALGORITHM,
    keyFingerprint: fingerprint,
    sign: (payload) =>
      sign("sha256", payload, {
        key,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      }).toString("base64url"),
  });
}

function canonicalSignature(value) {
  if (
    typeof value !== "string" ||
    !signaturePattern.test(value) ||
    value.length > 1024
  )
    return undefined;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.toString("base64url") === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

export function verifyRsaPssReceiptSignature(envelope, publicKey, fingerprint) {
  try {
    const details = publicKeyDetails(publicKey);
    const signature = canonicalSignature(envelope.signature);
    if (
      details === undefined ||
      details.fingerprint !== fingerprint ||
      envelope.algorithm !== EPIC_MERGE_RECEIPT_ALGORITHM ||
      envelope.keyFingerprint !== fingerprint ||
      signature === undefined
    )
      return false;
    return verify(
      "sha256",
      canonicalReceiptPayloadBytes(envelope.payload),
      {
        key: details.key,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      signature,
    );
  } catch {
    return false;
  }
}
