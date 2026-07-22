import assert from "node:assert/strict";
import test from "node:test";

import {
  createReleaseRecords,
  proveDeterministicImage,
  proveDeterministicReleaseBuild,
  runReleaseTransaction,
} from "./internal-release.mjs";
import { normalizeIsoTimestamps } from "./iso-normalization.mjs";
import {
  isoFixture,
  isoTimestampOffsets,
  writeBoth32,
} from "./iso-normalization.test-fixture.mjs";

const revision = "a".repeat(40);
const inputEvidence = {
  cargoLockSha256: "1".repeat(64),
  frontendLockSha256: "2".repeat(64),
  policySha256: "3".repeat(64),
  rootLockSha256: "4".repeat(64),
};

test("release records derive deterministic manifest, digest and SPDX bytes", () => {
  const input = {
    appInventory: [
      {
        mode: "0755",
        path: "Contents/MacOS/keiko-native-desktop",
        sha256: "c".repeat(64),
        size: 512,
      },
    ],
    dependencies: [
      { license: "Apache-2.0", name: "keiko-application", version: "0.1.0" },
    ],
    dmgBytes: Buffer.from("deterministic-image"),
    inputEvidence,
    revision,
    sourceEpoch: 1_700_000_000,
  };
  const first = createReleaseRecords(input);
  const second = createReleaseRecords(input);
  assert.deepEqual(first, second);
  assert.match(first.sha256s, /^[0-9a-f]{64}  Keiko-Native/u);
  assert.equal(first.manifest.sourceRevision, revision);
  assert.equal(first.sbom.spdxVersion, "SPDX-2.3");
  assert.equal(first.sbom.packages[0].licenseDeclared, "Apache-2.0");
});

test("disk image proof accepts exact bytes and rejects nondeterminism", async () => {
  assert.deepEqual(
    await proveDeterministicImage(async () => Buffer.from("same")),
    Buffer.from("same"),
  );
  let invocation = 0;
  await assert.rejects(
    proveDeterministicImage(async () =>
      Buffer.from(invocation++ === 0 ? "first" : "second"),
    ),
    /release-image-nondeterministic/u,
  );
});

test("release proof invokes two independent package builds and rejects drift", async () => {
  const candidate = {
    dmg: Buffer.from("image"),
    inventory: [{ path: "Contents/value", sha256: "a".repeat(64), size: 1 }],
    packageManifest: Buffer.from("manifest"),
  };
  let invocations = 0;
  assert.deepEqual(
    await proveDeterministicReleaseBuild(async () => {
      invocations += 1;
      return candidate;
    }),
    candidate,
  );
  assert.equal(invocations, 2);
  for (const [field, changed, expected] of [
    [
      "inventory",
      [{ path: "Contents/drift", sha256: "b".repeat(64), size: 1 }],
      /release-package-nondeterministic/u,
    ],
    [
      "packageManifest",
      Buffer.from("drift"),
      /release-package-nondeterministic/u,
    ],
    ["dmg", Buffer.from("drift"), /release-image-nondeterministic/u],
  ]) {
    let attempt = 0;
    await assert.rejects(
      proveDeterministicReleaseBuild(async () => ({
        ...candidate,
        [field]: attempt++ === 0 ? candidate[field] : changed,
      })),
      expected,
    );
  }
});

test("ISO and Joliet volume timestamps normalize to the exact source epoch", () => {
  const original = isoFixture("2026071911252600");
  const first = normalizeIsoTimestamps(original, 1_700_000_000);
  const second = normalizeIsoTimestamps(
    isoFixture("2026071911252800"),
    1_700_000_000,
  );
  assert.deepEqual(first, second);
  assert.equal(first[16 * 2048 + 100], 0xa5);
  for (const [index, byte] of original.entries()) {
    if (!isoTimestampOffsets().has(index)) assert.equal(first[index], byte);
  }
  assert.equal(
    first.subarray(16 * 2048 + 813, 16 * 2048 + 830).toString("hex"),
    Buffer.concat([Buffer.from("2023111422132000"), Buffer.from([0])]).toString(
      "hex",
    ),
  );
  const badSignature = isoFixture("2026071911252600");
  badSignature[16 * 2048 + 1] = 0;
  const nonzeroExpiration = isoFixture("2026071911252600");
  nonzeroExpiration[16 * 2048 + 847] = 1;
  const cycle = isoFixture("2026071911252600");
  cycle[20 * 2048 + 68 + 25] = 2;
  writeBoth32(cycle, 20 * 2048 + 68 + 2, 20);
  writeBoth32(cycle, 20 * 2048 + 68 + 10, 2048);
  const outOfBounds = isoFixture("2026071911252600");
  writeBoth32(outOfBounds, 20 * 2048 + 68 + 2, 100);
  const unknownTf = isoFixture("2026071911252600");
  unknownTf[20 * 2048 + 68 + 34 + 4] = 0x8f;
  for (const malformed of [
    Buffer.alloc(2048),
    isoFixture("2026071911252600", [1, 255]),
    isoFixture("2026071911252600", [1, 2, 2, 255]),
    badSignature,
    nonzeroExpiration,
    cycle,
    outOfBounds,
    unknownTf,
  ]) {
    assert.throws(
      () => normalizeIsoTimestamps(malformed, 1_700_000_000),
      /release-image-/u,
    );
  }
});

test("release transaction publishes only after complete verification", async () => {
  const events = [];
  const result = await runReleaseTransaction({
    build: async () => {
      events.push("build");
      return { id: "candidate" };
    },
    publish: async (candidate) => {
      events.push(`publish:${candidate.id}`);
      return "ready";
    },
    verify: async (candidate) => events.push(`verify:${candidate.id}`),
  });
  assert.equal(result, "ready");
  assert.deepEqual(events, ["build", "verify:candidate", "publish:candidate"]);
  await assert.rejects(
    runReleaseTransaction({
      build: async () => ({ id: "partial" }),
      publish: async () => assert.fail("partial result published"),
      verify: async () => {
        throw new Error("release-verification-failed");
      },
    }),
    /release-verification-failed/u,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    runReleaseTransaction({
      build: async () => assert.fail("cancelled build started"),
      publish: async () => assert.fail("cancelled result published"),
      signal: aborted.signal,
      verify: async () => assert.fail("cancelled verification started"),
    }),
    /release-cancelled/u,
  );
});
