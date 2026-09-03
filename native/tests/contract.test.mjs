import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = join(root, "Cargo.toml");

test("workspace owns the ADR-0006 package and composition binary", () => {
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

test("productive roots named by ADR-0006 exist", () => {
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

test("frontend build and test loaders preserve the npm-ci inventory", () => {
  const config = readFileSync(join(root, "frontend/vite.config.ts"), "utf8");
  const frontendPackage = JSON.parse(
    readFileSync(join(root, "frontend/package.json"), "utf8"),
  );
  assert.match(config, /cacheDir: "dist\/\.vite-cache"/u);
  assert.match(config, /coverage: \{\s+all: true,\s+clean: false,/u);
  assert.doesNotMatch(config, /cacheDir: "node_modules/u);
  for (const script of ["build", "coverage", "test"]) {
    assert.match(frontendPackage.scripts[script], /--configLoader native/u);
    assert.doesNotMatch(
      frontendPackage.scripts[script],
      /configLoader runner/u,
    );
  }
});

test("workspace authority remains host-owned and metadata-only", () => {
  const application = readFileSync(
    join(root, "crates/keiko-application/src/workspace.rs"),
    "utf8",
  );
  const host = readFileSync(
    join(root, "crates/keiko-host-macos/src/workspace.rs"),
    "utf8",
  );
  const frontend = readFileSync(join(root, "frontend/src/port.ts"), "utf8");

  assert.doesNotMatch(application, /\b(?:Path|PathBuf|std::fs)\b/u);
  assert.match(host, /\bsymlink_metadata\b/u);
  assert.match(host, /\bcanonicalize\b/u);
  assert.doesNotMatch(
    host,
    /\b(?:read_dir|read_to_end|read_to_string|File::open|OpenOptions|write_all)\b/u,
  );
  assert.doesNotMatch(
    frontend,
    /\b(?:selectedPath|canonicalPath|workspaceRoot|repositoryContent)\b/u,
  );
});
