import assert from "node:assert/strict";
import test from "node:test";

import {
  digestFramedSources,
  physicalEvaluationSourceDigest,
  physicalEvaluationSourceNames,
} from "./macos-accessibility-driver-source.mjs";

test("source digest frames file identity and bytes without concatenation ambiguity", () => {
  const left = digestFramedSources([
    { name: "a", bytes: Buffer.from("bc") },
    { name: "d", bytes: Buffer.from("") },
  ]);
  const changedName = digestFramedSources([
    { name: "ab", bytes: Buffer.from("c") },
    { name: "d", bytes: Buffer.from("") },
  ]);
  const changedBoundary = digestFramedSources([
    { name: "a", bytes: Buffer.from("b") },
    { name: "c", bytes: Buffer.from("d") },
  ]);

  assert.match(left, /^[0-9a-f]{64}$/u);
  assert.notEqual(left, changedName);
  assert.notEqual(left, changedBoundary);
});

test("source digest binds every decision-critical evaluator source", async () => {
  assert.deepEqual(physicalEvaluationSourceNames, [
    "evaluate-macos-accessibility-driver.mjs",
    "macos-accessibility-driver-evaluation.mjs",
    "macos-accessibility-driver-harness.mjs",
    "macos-accessibility-driver-source.mjs",
    "macos-accessibility-foundation-attestation.mjs",
    "run-macos-accessibility-driver-evaluation.mjs",
  ]);
  assert.match(await physicalEvaluationSourceDigest(), /^[0-9a-f]{64}$/u);
});

test("source digest rejects malformed entries", () => {
  assert.throws(
    () => digestFramedSources([{ name: "", bytes: Buffer.from("source") }]),
    /evaluation-source-entry-invalid/u,
  );
  assert.throws(
    () => digestFramedSources([{ name: "source", bytes: "not-bytes" }]),
    /evaluation-source-entry-invalid/u,
  );
});
