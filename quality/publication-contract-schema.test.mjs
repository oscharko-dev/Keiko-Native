import assert from "node:assert/strict";
import test from "node:test";

import { validateSnapshotReceipt } from "./publication-contract-schema.mjs";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const pathA = "docs/contracts/task-30-v2-r1.md";

export function ordinaryReceipt() {
  return {
    candidates: [{ digest: digestA, mode: "100644", path: pathA }],
    observations: [
      {
        candidatePath: pathA,
        fingerprint: digestB,
        lifecycleLabels: ["status: new"],
        number: 30,
        predecessor: null,
        readiness: null,
        recoveries: [],
        revision: 1,
        state: "open",
        type: "task",
        version: 2,
      },
    ],
    pullRequest: 77,
    target: "dev",
    terminalManifest: null,
  };
}

test("normalizes a closed ordinary snapshot receipt schema", () => {
  const receipt = ordinaryReceipt();
  assert.deepEqual(validateSnapshotReceipt(receipt), {
    binding: {
      candidates: receipt.candidates,
      observations: receipt.observations,
      pullRequest: 77,
      submode: "ordinary",
      target: "dev",
      terminalManifest: null,
    },
    ok: true,
  });
});

test("derives migration only from readiness, lifecycle, and manifest evidence", () => {
  const receipt = ordinaryReceipt();
  receipt.observations[0].lifecycleLabels = ["status: ready"];
  receipt.observations[0].readiness =
    "https://github.com/oscharko-dev/Keiko-Native/issues/30#issuecomment-123";
  receipt.terminalManifest = {
    digest: "c".repeat(64),
    path: "docs/qa/repository-migration-manifest-v1.md",
  };
  assert.equal(validateSnapshotReceipt(receipt).binding.submode, "migration");
  for (const changed of [
    { ...receipt, terminalManifest: null },
    {
      ...receipt,
      observations: [{ ...receipt.observations[0], readiness: null }],
    },
    {
      ...receipt,
      observations: [
        { ...receipt.observations[0], lifecycleLabels: ["status: new"] },
      ],
    },
  ]) {
    assert.equal(validateSnapshotReceipt(changed).ok, false);
  }
});

test("supports multiple sorted issues and exact candidate path identities", () => {
  const receipt = ordinaryReceipt();
  const secondPath = "docs/contracts/task-31-v1-r1.md";
  receipt.observations.push({
    ...receipt.observations[0],
    candidatePath: secondPath,
    fingerprint: "d".repeat(64),
    number: 31,
    version: 1,
  });
  receipt.candidates.push({
    digest: "e".repeat(64),
    mode: "100644",
    path: secondPath,
  });
  assert.equal(validateSnapshotReceipt(receipt).ok, true);
  receipt.candidates[1].path = "docs/contracts/task-32-v1-r1.md";
  assert.equal(
    validateSnapshotReceipt(receipt).rejection.code,
    "candidate_identity_mismatch",
  );
});

test("rejects unknown, missing, raw, malformed, and unauthorized receipt data", () => {
  const receipt = ordinaryReceipt();
  const explosive = ordinaryReceipt();
  Object.defineProperty(explosive, "candidates", {
    get() {
      throw new Error("SECRET");
    },
  });
  const invalid = [
    null,
    { ...receipt, body: "raw customer content" },
    { ...receipt, target: "main" },
    { ...receipt, pullRequest: 0 },
    { ...receipt, candidates: [] },
    { ...receipt, observations: [] },
    { ...receipt, terminalManifest: "bad" },
    {
      ...receipt,
      observations: [{ ...receipt.observations[0], state: "bad" }],
    },
    {
      ...receipt,
      observations: [{ ...receipt.observations[0], fingerprint: "SECRET" }],
    },
    {
      ...receipt,
      observations: [{ ...receipt.observations[0], lifecycleLabels: [] }],
    },
    {
      ...receipt,
      observations: [{ ...receipt.observations[0], readiness: "SECRET" }],
    },
    {
      ...receipt,
      observations: [{ ...receipt.observations[0], recoveries: null }],
    },
    {
      ...receipt,
      observations: [
        {
          ...receipt.observations[0],
          predecessor: { digest: "bad", path: pathA },
        },
      ],
    },
    { ...receipt, candidates: [{ ...receipt.candidates[0], mode: "120000" }] },
    explosive,
  ];
  for (const value of invalid) {
    const result = validateSnapshotReceipt(value);
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.rejection.message, /SECRET|customer/iu);
  }
});

test("rejects replayed, unsorted, conflicting, and inconsistent sets", () => {
  const receipt = ordinaryReceipt();
  const observation = receipt.observations[0];
  const candidate = receipt.candidates[0];
  for (const changed of [
    { ...receipt, observations: [observation, observation] },
    { ...receipt, candidates: [candidate, candidate] },
    {
      ...receipt,
      candidates: [
        candidate,
        {
          digest: digestB,
          mode: "100644",
          path: "docs/contracts/task-31-v1-r1.md",
        },
      ],
    },
    {
      ...receipt,
      observations: [
        { ...observation, lifecycleLabels: ["status: ready", "status: new"] },
      ],
    },
    {
      ...receipt,
      observations: [
        {
          ...observation,
          predecessor: { digest: digestA, path: pathA },
        },
      ],
    },
    {
      ...receipt,
      observations: [
        {
          ...observation,
          recoveries: [
            { digest: digestA, path: "docs/contracts/task-30-v2-r3.md" },
            { digest: digestB, path: "docs/contracts/task-30-v2-r2.md" },
          ],
        },
      ],
    },
  ]) {
    assert.equal(validateSnapshotReceipt(changed).ok, false);
  }
});
