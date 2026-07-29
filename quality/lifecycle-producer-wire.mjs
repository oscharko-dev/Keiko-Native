import { createHash } from "node:crypto";

export const LIFECYCLE_PRODUCER_WIRE_FIELDS = Object.freeze([
  "schema_version",
  "producer_contract_version",
  "repository",
  "issue_number",
  "pull_request_number",
  "exact_head_sha",
  "exact_target",
  "generation_bytes_base64",
  "generation_bytes_sha256",
  "generation_identity",
  "attempt",
  "phase_fence_comment_id",
  "phase_fence_digest",
  "generation_request_comment_id",
  "generation_request_digest",
  "request_identity",
  "request_payload_digest",
  "expected_producer",
]);

export const LIFECYCLE_PRODUCER_PATHS = Object.freeze({
  "contract-publication": ".github/workflows/contract-publication.yml",
  "issue-contract-current": ".github/workflows/pr-contract.yml",
  "pr-contract": ".github/workflows/pr-contract.yml",
});

const REPOSITORY = "oscharko-dev/Keiko-Native";
const MAX_SAFE_DECIMAL = "9007199254740991";
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const EPIC_TARGET =
  /^epic\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)*$/u;

export class LifecycleProducerWireError extends Error {
  constructor(code) {
    super(code);
    this.name = "LifecycleProducerWireError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new LifecycleProducerWireError(code);
};
const byteLength = (value) => Buffer.byteLength(value, "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function canonicalDecimal(value, pattern, allowZero) {
  if (!pattern.test(value)) return false;
  const number = Number(value);
  return (
    Number.isSafeInteger(number) &&
    number >= (allowZero ? 0 : 1) &&
    BigInt(value) <= BigInt(MAX_SAFE_DECIMAL) &&
    String(number) === value
  );
}

export function validLifecycleExactTarget(value) {
  if (value === "" || value === "dev") return true;
  return (
    EPIC_TARGET.test(value) &&
    !value.includes("..") &&
    !value.split("/").some((component) => component.endsWith(".lock")) &&
    !value.startsWith("refs/heads/")
  );
}

function decodeGeneration(value) {
  if (
    value === "" ||
    byteLength(value) > 65_536 ||
    value.length % 4 !== 0 ||
    !BASE64.test(value)
  )
    fail("generation-base64-invalid");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value)
    fail("generation-base64-noncanonical");
  return bytes;
}

export function validateLifecycleProducerWire(
  input,
  { acceptedTarget, pullRequestBase } = {},
) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    fail("wire-not-record");
  const keys = Object.keys(input);
  if (
    keys.length !== LIFECYCLE_PRODUCER_WIRE_FIELDS.length ||
    keys.some((key, index) => key !== LIFECYCLE_PRODUCER_WIRE_FIELDS[index])
  )
    fail("wire-field-order");
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") fail(`wire-${key}-not-string`);
    const limit = key === "generation_bytes_base64" ? 65_536 : 512;
    if (byteLength(value) > limit) fail(`wire-${key}-oversized`);
  }
  if (input.schema_version !== "1") fail("wire-schema-version");
  if (input.producer_contract_version !== "1") fail("wire-producer-version");
  if (input.repository !== REPOSITORY) fail("wire-repository");
  if (!canonicalDecimal(input.issue_number, POSITIVE_DECIMAL, false))
    fail("wire-issue-number");
  if (
    input.pull_request_number !== "" &&
    !canonicalDecimal(input.pull_request_number, POSITIVE_DECIMAL, false)
  )
    fail("wire-pull-request-number");
  if (input.exact_head_sha !== "" && !COMMIT.test(input.exact_head_sha))
    fail("wire-exact-head");
  if (!validLifecycleExactTarget(input.exact_target)) fail("wire-exact-target");
  if (acceptedTarget !== undefined && input.exact_target !== acceptedTarget)
    fail("wire-accepted-target-mismatch");
  if (pullRequestBase !== undefined && input.exact_target !== pullRequestBase)
    fail("wire-provider-target-mismatch");
  if (!canonicalDecimal(input.attempt, NON_NEGATIVE_DECIMAL, true))
    fail("wire-attempt");
  for (const key of ["phase_fence_comment_id", "generation_request_comment_id"])
    if (!canonicalDecimal(input[key], POSITIVE_DECIMAL, false))
      fail(`wire-${key}`);
  for (const key of [
    "generation_bytes_sha256",
    "generation_identity",
    "phase_fence_digest",
    "generation_request_digest",
    "request_identity",
    "request_payload_digest",
  ])
    if (!SHA256.test(input[key])) fail(`wire-${key}`);
  if (!Object.hasOwn(LIFECYCLE_PRODUCER_PATHS, input.expected_producer))
    fail("wire-expected-producer");
  const generation = decodeGeneration(input.generation_bytes_base64);
  if (sha256(generation) !== input.generation_bytes_sha256)
    fail("generation-digest-mismatch");
  return Object.freeze({
    ...input,
    generation_bytes: generation,
    producer_path: LIFECYCLE_PRODUCER_PATHS[input.expected_producer],
  });
}
