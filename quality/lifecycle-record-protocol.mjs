import { createHash, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";

import {
  ProtocolValidationError,
  decodeCanonical,
  encodeCanonical,
  toBytes,
} from "./lifecycle-record-canonical.mjs";
import {
  AUXILIARY_IDENTITY_NAMES,
  LIFECYCLE_OBSERVATIONS,
  PRODUCERS,
  REASON_CODES,
  RECORD_TYPES,
  REQUESTED_LIFECYCLE_STATES,
  auxiliaryDomain,
} from "./lifecycle-record-schema.mjs";

export {
  AUXILIARY_IDENTITY_NAMES,
  LIFECYCLE_OBSERVATIONS,
  PRODUCERS,
  ProtocolValidationError,
  REASON_CODES,
  RECORD_TYPES,
  REQUESTED_LIFECYCLE_STATES,
};

const MAX_ENVELOPE = 32 * 1024;
const SHA = /^[0-9a-f]{64}$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });
const fail = (message) => {
  throw new ProtocolValidationError(message);
};

export const RECORD_MARKERS = Object.freeze({
  "generation-request": "<!-- keiko-native-lifecycle-generation-request:v1 -->",
  "producer-result": "<!-- keiko-native-lifecycle-producer-result:v1 -->",
  "phase-fence-claim": "<!-- keiko-native-lifecycle-phase-fence-claim:v1 -->",
  "transition-read-back":
    "<!-- keiko-native-lifecycle-transition-read-back:v1 -->",
});

export function encodePrimaryRecord(recordType, fields) {
  if (!RECORD_TYPES.includes(recordType)) fail("unknown primary record type");
  return encodeCanonical(recordType, fields);
}

export function decodePrimaryRecord(recordType, bytes) {
  if (!RECORD_TYPES.includes(recordType)) fail("unknown primary record type");
  return decodeCanonical(recordType, bytes);
}

export function digestRecordBytes(input) {
  return createHash("sha256").update(toBytes(input)).digest("hex");
}

export function constantTimeDigestEqual(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    !SHA.test(left) ||
    !SHA.test(right)
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function createRecordEnvelope(recordType, fields) {
  const marker = RECORD_MARKERS[recordType];
  if (!marker) fail("unknown primary record type");
  const record = encodePrimaryRecord(recordType, fields);
  const digest = digestRecordBytes(record);
  const body = `${marker}\n\`\`\`text\n${record.toString("hex")}\n\`\`\`\nDigest: sha-256:${digest}\n`;
  if (Buffer.byteLength(body) > MAX_ENVELOPE) fail("envelope exceeds 32 KiB");
  return body;
}

export function parseRecordEnvelope(input) {
  const bodyBytes = toBytes(input, "record envelope");
  if (bodyBytes.length > MAX_ENVELOPE) fail("envelope exceeds 32 KiB");
  let body;
  try {
    body = decoder.decode(bodyBytes);
  } catch {
    fail("malformed UTF-8 envelope");
  }
  if (
    body.includes("\r") ||
    body !== body.normalize("NFC") ||
    !body.endsWith("\n")
  ) {
    fail("envelope is not NFC LF-only");
  }
  const lines = body.split("\n");
  if (
    lines.length !== 6 ||
    lines[1] !== "```text" ||
    lines[3] !== "```" ||
    lines[5] !== ""
  ) {
    fail("invalid envelope shape");
  }
  const recordType = RECORD_TYPES.find(
    (candidate) => RECORD_MARKERS[candidate] === lines[0],
  );
  if (!recordType) fail("unknown marker");
  if (
    lines[2].length === 0 ||
    lines[2].length % 2 !== 0 ||
    !/^[0-9a-f]+$/u.test(lines[2])
  ) {
    fail("invalid record hex");
  }
  const digest = /^Digest: sha-256:([0-9a-f]{64})$/u.exec(lines[4])?.[1];
  if (!digest) fail("invalid digest line");
  const recordBytes = Buffer.from(lines[2], "hex");
  const fields = decodePrimaryRecord(recordType, recordBytes);
  const recordDigest = digestRecordBytes(recordBytes);
  if (!constantTimeDigestEqual(recordDigest, digest)) fail("digest mismatch");
  return Object.freeze({
    recordType,
    marker: lines[0],
    fields,
    recordBytes,
    recordDigest,
  });
}

export function encodeAuxiliaryPreimage(identityName, fields) {
  const domain = auxiliaryDomain(identityName);
  if (!domain) fail("unknown auxiliary identity");
  if (
    fields === null ||
    typeof fields !== "object" ||
    Array.isArray(fields) ||
    Object.hasOwn(fields, "digest_domain") ||
    Object.hasOwn(fields, "schema_version") ||
    Object.hasOwn(fields, "digest_algorithm")
  ) {
    fail("invalid auxiliary fields");
  }
  return encodeCanonical(`aux:${identityName}`, {
    digest_domain: domain,
    schema_version: 1,
    digest_algorithm: "sha-256",
    ...fields,
  });
}

export function digestAuxiliaryIdentity(identityName, fields) {
  return digestRecordBytes(encodeAuxiliaryPreimage(identityName, fields));
}
