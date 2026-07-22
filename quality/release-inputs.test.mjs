import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadReleaseInputs,
  loadReleaseInputsFromRevision,
} from "./release-inputs.mjs";

test("release inputs bind policy and evidence to exact repository locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-release-inputs-"));
  try {
    await mkdir(join(root, "native/frontend"), { recursive: true });
    const cargo = Buffer.from("cargo-lock");
    const frontend = Buffer.from("frontend-lock");
    await writeFile(join(root, "native/Cargo.lock"), cargo);
    await writeFile(join(root, "native/frontend/package-lock.json"), frontend);
    await writeFile(join(root, "package-lock.json"), "root-lock");
    await writeFile(
      join(root, "native/package-policy.json"),
      JSON.stringify({
        schema: "keiko-native-package-policy/v1",
        expectedLocks: {
          cargoSha256: digest(cargo),
          npmSha256: digest(frontend),
        },
        cargoInventory: [
          { license: "MIT", name: "dependency", version: "1.0.0" },
        ],
        npmInventory: [],
      }),
    );
    const inputs = await loadReleaseInputs(root);
    assert.equal(inputs.evidence.cargoLockSha256, digest(cargo));
    assert.equal(inputs.evidence.frontendLockSha256, digest(frontend));
    assert.match(inputs.evidence.policySha256, /^[0-9a-f]{64}$/u);
    assert.match(inputs.evidence.rootLockSha256, /^[0-9a-f]{64}$/u);
    await writeFile(join(root, "native/Cargo.lock"), "drift");
    await assert.rejects(loadReleaseInputs(root), /release-inputs-rejected/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("verify inputs are read only from the named exact revision", async () => {
  const revision = "a".repeat(40);
  const cargo = Buffer.from("committed-cargo");
  const frontend = Buffer.from("committed-frontend");
  const values = new Map([
    ["native/Cargo.lock", cargo],
    ["native/frontend/package-lock.json", frontend],
    ["package-lock.json", Buffer.from("committed-root")],
    [
      "native/package-policy.json",
      Buffer.from(
        JSON.stringify({
          schema: "keiko-native-package-policy/v1",
          expectedLocks: {
            cargoSha256: digest(cargo),
            npmSha256: digest(frontend),
          },
          cargoInventory: [],
          npmInventory: [],
        }),
      ),
    ],
  ]);
  const reads = [];
  const inputs = await loadReleaseInputsFromRevision(revision, (head, path) => {
    reads.push({ head, path });
    return values.get(path);
  });
  assert.equal(reads.length, 4);
  assert.ok(reads.every(({ head }) => head === revision));
  assert.equal(inputs.evidence.cargoLockSha256, digest(cargo));
});

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
