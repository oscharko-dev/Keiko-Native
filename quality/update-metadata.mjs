import { verify } from "node:crypto";

const PAYLOAD_FIELDS = [
  "schema",
  "version",
  "channel",
  "platform",
  "architecture",
  "sourceRevision",
  "artifactSha256",
  "artifactSize",
  "issuedAt",
  "expiresAt",
  "sequence",
  "keyId",
];
const DOCUMENT_FIELDS = [...PAYLOAD_FIELDS, "signature"].toSorted();
const MAX_DOCUMENT_BYTES = 16 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_VALIDITY_MS = 14 * 24 * 60 * 60 * 1000;
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function canonicalUpdatePayload(metadata) {
  validatePayload(metadata, Object.hasOwn(metadata ?? {}, "signature"));
  return Buffer.from(
    JSON.stringify(
      Object.fromEntries(
        PAYLOAD_FIELDS.map((field) => [field, metadata[field]]),
      ),
    ),
    "utf8",
  );
}

export function verifyUpdateMetadata(options) {
  if (options === null || typeof options !== "object")
    throw rejected("UPDATE_METADATA_POLICY_INPUT_INVALID");
  const {
    bytes,
    expectedArchitecture,
    expectedChannel,
    expectedPlatform,
    installedVersion,
    now,
    publicKey,
    replaySeen,
  } = options;
  const metadata = parseEnvelope(bytes);
  validatePayload(metadata, true);
  const signature = decodeSignature(metadata.signature);
  authenticateMetadata(metadata, publicKey, signature);
  assertCompatibility(metadata, {
    expectedArchitecture,
    expectedChannel,
    expectedPlatform,
    installedVersion,
  });
  assertCurrent(metadata, now);
  const replayToken = Object.freeze({
    keyId: metadata.keyId,
    sequence: metadata.sequence,
    artifactSha256: metadata.artifactSha256,
  });
  assertNotReplayed(replaySeen, replayToken);
  return Object.freeze({
    metadata: Object.freeze({ ...metadata }),
    replayToken,
  });
}

function authenticateMetadata(metadata, publicKey, signature) {
  if (
    ![
      publicKey?.type === "public",
      publicKey?.asymmetricKeyType === "ed25519",
    ].every(Boolean)
  )
    throw rejected("UPDATE_METADATA_KEY_INVALID");
  let authenticated = false;
  try {
    authenticated = verify(
      null,
      canonicalUpdatePayload(metadata),
      publicKey,
      signature,
    );
  } catch {
    throw rejected("UPDATE_METADATA_KEY_INVALID");
  }
  if (!authenticated) throw rejected("UPDATE_METADATA_SIGNATURE_INVALID");
}

function assertCurrent(metadata, now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw rejected("UPDATE_METADATA_POLICY_INPUT_INVALID");
  const current = now.getTime();
  if (current < Date.parse(metadata.issuedAt))
    throw rejected("UPDATE_METADATA_NOT_YET_VALID");
  if (current >= Date.parse(metadata.expiresAt))
    throw rejected("UPDATE_METADATA_EXPIRED");
}

function assertNotReplayed(replaySeen, replayToken) {
  if (typeof replaySeen !== "function")
    throw rejected("UPDATE_METADATA_POLICY_INPUT_INVALID");
  let seen;
  try {
    seen = replaySeen(replayToken);
  } catch {
    throw rejected("UPDATE_METADATA_REPLAY_CHECK_FAILED");
  }
  if (typeof seen !== "boolean")
    throw rejected("UPDATE_METADATA_REPLAY_CHECK_FAILED");
  if (seen) throw rejected("UPDATE_METADATA_REPLAYED");
}

function assertCompatibility(
  metadata,
  { expectedArchitecture, expectedChannel, expectedPlatform, installedVersion },
) {
  if (
    ![
      validVersion(installedVersion),
      NAME_PATTERN.test(expectedChannel ?? ""),
      NAME_PATTERN.test(expectedPlatform ?? ""),
      NAME_PATTERN.test(expectedArchitecture ?? ""),
    ].every(Boolean)
  )
    throw rejected("UPDATE_METADATA_POLICY_INPUT_INVALID");
  if (metadata.channel !== expectedChannel)
    throw rejected("UPDATE_METADATA_CHANNEL_MISMATCH");
  if (metadata.platform !== expectedPlatform)
    throw rejected("UPDATE_METADATA_PLATFORM_MISMATCH");
  if (metadata.architecture !== expectedArchitecture)
    throw rejected("UPDATE_METADATA_ARCHITECTURE_MISMATCH");
  if (compareVersions(metadata.version, installedVersion) <= 0)
    throw rejected("UPDATE_METADATA_VERSION_NOT_NEWER");
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index])
      return leftParts[index] > rightParts[index] ? 1 : -1;
  }
  return 0;
}

function validatePayload(metadata, signatureRequired) {
  const expected = signatureRequired
    ? DOCUMENT_FIELDS
    : PAYLOAD_FIELDS.toSorted();
  if (!hasExactFields(metadata, expected))
    throw rejected("UPDATE_METADATA_FIELD_INVALID");
  const issued = exactTimestamp(metadata.issuedAt);
  const expires = exactTimestamp(metadata.expiresAt);
  const valid = [
    metadata.schema === "keiko-native-update-metadata/v1",
    validVersion(metadata.version),
    NAME_PATTERN.test(metadata.channel),
    NAME_PATTERN.test(metadata.platform),
    NAME_PATTERN.test(metadata.architecture),
    /^[0-9a-f]{40}$/u.test(metadata.sourceRevision),
    /^[0-9a-f]{64}$/u.test(metadata.artifactSha256),
    boundedInteger(metadata.artifactSize, MAX_ARTIFACT_BYTES),
    boundedInteger(metadata.sequence, Number.MAX_SAFE_INTEGER),
    /^[A-Za-z0-9._-]{1,64}$/u.test(metadata.keyId),
    issued !== undefined,
    expires !== undefined,
    expires > issued,
    expires - issued <= MAX_VALIDITY_MS,
    signatureRequired ? validSignatureText(metadata.signature) : true,
  ].every(Boolean);
  if (!valid) throw rejected("UPDATE_METADATA_FIELD_INVALID");
}

function hasExactFields(value, expected) {
  if (
    ![value !== null, typeof value === "object", !Array.isArray(value)].every(
      Boolean,
    )
  )
    return false;
  return (
    JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify(expected)
  );
}

function validVersion(value) {
  if (typeof value !== "string") return false;
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) return false;
  return match.slice(1).every((part) => Number(part) <= 2_147_483_647);
}

function exactTimestamp(value) {
  if (typeof value !== "string") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString() === value ? parsed : undefined;
}

function boundedInteger(value, maximum) {
  return [Number.isSafeInteger(value), value >= 1, value <= maximum].every(
    Boolean,
  );
}

function validSignatureText(value) {
  if (typeof value !== "string") return false;
  return /^[A-Za-z0-9_-]{86}$/u.test(value);
}

function decodeSignature(value) {
  const signature = Buffer.from(value, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== value)
    throw rejected("UPDATE_METADATA_FIELD_INVALID");
  return signature;
}

function parseEnvelope(bytes) {
  if (!(bytes instanceof Uint8Array))
    throw rejected("UPDATE_METADATA_ENCODING_INVALID");
  if (bytes.byteLength > MAX_DOCUMENT_BYTES)
    throw rejected("UPDATE_METADATA_TOO_LARGE");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw rejected("UPDATE_METADATA_ENCODING_INVALID");
  }
  let metadata;
  try {
    metadata = JSON.parse(text);
  } catch {
    throw rejected("UPDATE_METADATA_JSON_INVALID");
  }
  if (duplicateTopLevelKey(text))
    throw rejected("UPDATE_METADATA_DUPLICATE_FIELD");
  if (!hasExactFields(metadata, DOCUMENT_FIELDS))
    throw rejected("UPDATE_METADATA_FIELDS_INVALID");
  return metadata;
}

function duplicateTopLevelKey(text) {
  const keys = new Set();
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") depth -= 1;
    else if (text[index] === '"') {
      const end = stringEnd(text, index);
      let next = end + 1;
      while (/\s/u.test(text[next] ?? "")) next += 1;
      if (depth === 1 && text[next] === ":") {
        const key = JSON.parse(text.slice(index, end + 1));
        if (keys.has(key)) return true;
        keys.add(key);
      }
      index = end;
    }
  }
  return false;
}

function stringEnd(text, start) {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    if (!escaped && text[index] === '"') return index;
    if (!escaped && text[index] === "\\") escaped = true;
    else escaped = false;
  }
  return text.length - 1;
}

function rejected(code) {
  const error = new Error(code);
  error.name = "UpdateMetadataError";
  error.code = code;
  return error;
}
