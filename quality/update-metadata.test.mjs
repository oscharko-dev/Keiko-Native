import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  canonicalUpdatePayload,
  verifyUpdateMetadata,
} from "./update-metadata.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function unsignedMetadata(overrides = {}) {
  return {
    schema: "keiko-native-update-metadata/v1",
    version: "0.2.0",
    channel: "internal",
    platform: "macos",
    architecture: "arm64",
    sourceRevision: "a".repeat(40),
    artifactSha256: "b".repeat(64),
    artifactSize: 4_096,
    issuedAt: "2026-07-19T10:00:00.000Z",
    expiresAt: "2026-07-20T10:00:00.000Z",
    sequence: 2,
    keyId: "internal-test-key-1",
    ...overrides,
  };
}

function signedBytes(overrides = {}) {
  const metadata = unsignedMetadata(overrides);
  const signature = sign(
    null,
    canonicalUpdatePayload(metadata),
    privateKey,
  ).toString("base64url");
  return Buffer.from(JSON.stringify({ ...metadata, signature }), "utf8");
}

function mutatedBytes(overrides) {
  return Buffer.from(
    JSON.stringify({ ...JSON.parse(signedBytes()), ...overrides }),
    "utf8",
  );
}

function verification(overrides = {}) {
  return {
    bytes: signedBytes(),
    publicKey,
    installedVersion: "0.1.0",
    expectedChannel: "internal",
    expectedPlatform: "macos",
    expectedArchitecture: "arm64",
    now: new Date("2026-07-19T12:00:00.000Z"),
    replaySeen: () => false,
    ...overrides,
  };
}

function rejectsCode(options, code) {
  assert.throws(() => verifyUpdateMetadata(options), {
    code,
    message: code,
    name: "UpdateMetadataError",
  });
}

test("accepts canonical signed metadata and returns frozen bounded state", () => {
  assert.equal(
    canonicalUpdatePayload(unsignedMetadata()).toString("utf8"),
    JSON.stringify(unsignedMetadata()),
  );
  const result = verifyUpdateMetadata(verification());

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.metadata), true);
  assert.equal(Object.isFrozen(result.replayToken), true);
  assert.equal(result.metadata.version, "0.2.0");
  assert.deepEqual(result.replayToken, {
    keyId: "internal-test-key-1",
    sequence: 2,
    artifactSha256: "b".repeat(64),
  });
});

test("authenticates metadata before applying compatibility policy", () => {
  const substituted = JSON.parse(signedBytes());
  substituted.artifactSha256 = "c".repeat(64);
  rejectsCode(
    verification({ bytes: Buffer.from(JSON.stringify(substituted)) }),
    "UPDATE_METADATA_SIGNATURE_INVALID",
  );
  rejectsCode(
    verification({
      bytes: Buffer.from(
        JSON.stringify({
          ...substituted,
          channel: "wrong",
          signature: "A".repeat(86),
        }),
      ),
    }),
    "UPDATE_METADATA_SIGNATURE_INVALID",
  );
  rejectsCode(
    verification({ publicKey: "not-a-public-key" }),
    "UPDATE_METADATA_KEY_INVALID",
  );
  rejectsCode(
    verification({ publicKey: privateKey }),
    "UPDATE_METADATA_KEY_INVALID",
  );
  rejectsCode(
    verification({
      publicKey: { asymmetricKeyType: "ed25519", type: "public" },
    }),
    "UPDATE_METADATA_KEY_INVALID",
  );
  const rsaKey = generateKeyPairSync("rsa", { modulusLength: 2_048 }).publicKey;
  rejectsCode(
    verification({ publicKey: rsaKey }),
    "UPDATE_METADATA_KEY_INVALID",
  );
});

test("bounds and closes the UTF-8 JSON envelope", () => {
  rejectsCode(
    verification({ bytes: "not-bytes" }),
    "UPDATE_METADATA_ENCODING_INVALID",
  );
  rejectsCode(
    verification({ bytes: Buffer.alloc(16_385, 0x20) }),
    "UPDATE_METADATA_TOO_LARGE",
  );
  rejectsCode(
    verification({ bytes: Buffer.alloc(16_384, 0x20) }),
    "UPDATE_METADATA_JSON_INVALID",
  );
  rejectsCode(
    verification({ bytes: Buffer.from([0xc3, 0x28]) }),
    "UPDATE_METADATA_ENCODING_INVALID",
  );
  rejectsCode(
    verification({ bytes: Buffer.from("{broken", "utf8") }),
    "UPDATE_METADATA_JSON_INVALID",
  );

  const canonical = signedBytes().toString("utf8");
  rejectsCode(
    verification({
      bytes: prependObjectFields(canonical, '"schema":"duplicate",'),
    }),
    "UPDATE_METADATA_DUPLICATE_FIELD",
  );
  rejectsCode(
    verification({
      bytes: prependObjectFields(canonical, '"future":true,'),
    }),
    "UPDATE_METADATA_FIELDS_INVALID",
  );
  rejectsCode(
    verification({
      bytes: prependObjectFields(canonical, '"sch\\u0065ma":"duplicate",'),
    }),
    "UPDATE_METADATA_DUPLICATE_FIELD",
  );
  for (const value of ["null", "[]", '"metadata"']) {
    rejectsCode(
      verification({ bytes: Buffer.from(value) }),
      "UPDATE_METADATA_FIELDS_INVALID",
    );
  }

  const maximumValidDocument = Buffer.from(
    signedBytes().toString("utf8").padEnd(16_384, " "),
  );
  assert.equal(maximumValidDocument.byteLength, 16_384);
  assert.equal(
    verifyUpdateMetadata(verification({ bytes: maximumValidDocument })).metadata
      .version,
    "0.2.0",
  );
});

function prependObjectFields(canonical, fields) {
  assert.equal(canonical.startsWith("{"), true);
  return Buffer.from(`{${fields}${canonical.slice(1)}`, "utf8");
}

test("validates every schema field and accepts declared maximum bounds", () => {
  const maximum = signedBytes({
    artifactSize: 16 * 1024 * 1024 * 1024,
    expiresAt: "2026-08-02T10:00:00.000Z",
    keyId: "k".repeat(64),
    sequence: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(
    verifyUpdateMetadata(
      verification({
        bytes: maximum,
        now: new Date("2026-07-19T10:00:00.000Z"),
      }),
    ).metadata.artifactSize,
    16 * 1024 * 1024 * 1024,
  );

  for (const override of [
    { schema: "keiko-native-update-metadata/v2" },
    { version: 2 },
    { version: "01.2.3" },
    { version: "2147483648.0.0" },
    { channel: "INTERNAL" },
    { platform: "m".repeat(33) },
    { architecture: "arm64!" },
    { sourceRevision: "A".repeat(40) },
    { artifactSha256: "b".repeat(63) },
    { artifactSize: 0 },
    { artifactSize: 16 * 1024 * 1024 * 1024 + 1 },
    { issuedAt: "2026-07-19" },
    { issuedAt: "2026-02-31T10:00:00.000Z" },
    { expiresAt: "2026-07-19T10:00:00.000Z" },
    { expiresAt: "2026-08-02T10:00:00.001Z" },
    { sequence: 0 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { keyId: "bad key" },
    { keyId: "k".repeat(65) },
  ]) {
    rejectsCode(
      verification({ bytes: mutatedBytes(override) }),
      "UPDATE_METADATA_FIELD_INVALID",
    );
  }

  const malformedSignature = JSON.parse(signedBytes());
  malformedSignature.signature = "not-base64url";
  rejectsCode(
    verification({ bytes: Buffer.from(JSON.stringify(malformedSignature)) }),
    "UPDATE_METADATA_FIELD_INVALID",
  );
  rejectsCode(
    verification({ bytes: mutatedBytes({ signature: 7 }) }),
    "UPDATE_METADATA_FIELD_INVALID",
  );
  assert.throws(
    () => canonicalUpdatePayload(unsignedMetadata({ artifactSize: 0 })),
    { code: "UPDATE_METADATA_FIELD_INVALID" },
  );
});

test("rejects incompatible, equal, and downgraded authenticated updates", () => {
  for (const [options, code] of [
    [{ expectedChannel: "stable" }, "UPDATE_METADATA_CHANNEL_MISMATCH"],
    [{ expectedPlatform: "windows" }, "UPDATE_METADATA_PLATFORM_MISMATCH"],
    [
      { expectedArchitecture: "x86-64" },
      "UPDATE_METADATA_ARCHITECTURE_MISMATCH",
    ],
    [{ installedVersion: "0.2.0" }, "UPDATE_METADATA_VERSION_NOT_NEWER"],
    [{ installedVersion: "0.3.0" }, "UPDATE_METADATA_VERSION_NOT_NEWER"],
  ]) {
    rejectsCode(verification(options), code);
  }
  rejectsCode(
    verification({ installedVersion: "not-semver" }),
    "UPDATE_METADATA_POLICY_INPUT_INVALID",
  );
});

test("enforces validity windows and replay checks with injected read-only state", () => {
  rejectsCode(undefined, "UPDATE_METADATA_POLICY_INPUT_INVALID");
  rejectsCode(
    verification({ now: new Date("2026-07-19T09:59:59.999Z") }),
    "UPDATE_METADATA_NOT_YET_VALID",
  );
  rejectsCode(
    verification({ now: new Date("2026-07-20T10:00:00.000Z") }),
    "UPDATE_METADATA_EXPIRED",
  );
  rejectsCode(
    verification({ replaySeen: () => true }),
    "UPDATE_METADATA_REPLAYED",
  );
  rejectsCode(
    verification({ replaySeen: () => "unknown" }),
    "UPDATE_METADATA_REPLAY_CHECK_FAILED",
  );
  rejectsCode(
    verification({
      replaySeen: () => {
        throw new Error("private state");
      },
    }),
    "UPDATE_METADATA_REPLAY_CHECK_FAILED",
  );
  rejectsCode(
    verification({ now: "2026-07-19T12:00:00.000Z" }),
    "UPDATE_METADATA_POLICY_INPUT_INVALID",
  );

  let observed;
  verifyUpdateMetadata(
    verification({
      replaySeen(token) {
        observed = token;
        assert.equal(Object.isFrozen(token), true);
        return false;
      },
    }),
  );
  assert.deepEqual(observed, {
    keyId: "internal-test-key-1",
    sequence: 2,
    artifactSha256: "b".repeat(64),
  });
});
