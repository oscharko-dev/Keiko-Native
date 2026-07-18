import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = join(root, "Cargo.toml");

test("workspace owns the ADR-0004 package and composition binary", () => {
  const result = spawnSync(
    "cargo",
    [
      "+1.92.0",
      "metadata",
      "--locked",
      "--no-deps",
      "--format-version=1",
      "--manifest-path",
      manifest,
    ],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout);
  assert.equal(metadata.workspace_members.length, 4);
  assert.ok(
    metadata.packages.some(
      (pkg) =>
        pkg.name === "keiko-native-desktop" &&
        pkg.targets.some((target) => target.name === "keiko-native-desktop"),
    ),
  );
});

test("productive roots named by ADR-0004 exist", () => {
  for (const rootPath of [
    "crates/keiko-application/src",
    "crates/keiko-ui-port/src",
    "crates/keiko-host-macos/src",
    "apps/keiko-desktop/src",
    "frontend/src",
  ]) {
    assert.equal(existsSync(join(root, rootPath)), true, rootPath);
  }
});
