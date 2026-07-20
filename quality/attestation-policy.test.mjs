import assert from "node:assert/strict";
import test from "node:test";

import {
  customAttestationFailures,
  releasePredicateType,
} from "./attestation-policy.mjs";

const revision = "a".repeat(40);
const subjects = [
  { name: "bundle/evidence", sha256: "b".repeat(64) },
  { name: "bundle/manifest", sha256: "c".repeat(64) },
];

function result(sourceRevision = revision) {
  return [
    {
      verificationResult: {
        statement: {
          predicate: {
            schema: "keiko-native-internal-release/v1",
            sourceRevision,
          },
          predicateType: releasePredicateType,
          subject: subjects.map(({ name, sha256 }) => ({
            digest: { sha256 },
            name,
          })),
        },
      },
    },
  ];
}

test("custom attestation policy binds retained evidence to exact source head", () => {
  assert.deepEqual(customAttestationFailures(result(), revision, subjects), []);
  for (const value of [
    [],
    result("c".repeat(40)),
    [{ verificationResult: { statement: { predicate: {} } } }],
  ])
    assert.ok(customAttestationFailures(value, revision, subjects).length > 0);
  assert.ok(
    customAttestationFailures(result(), revision, subjects.slice(1)).length > 0,
  );
});
