import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { filesBelow } from "./native-files.mjs";
import {
  nativeSnapshotTestSupport,
  runNativeSnapshot,
} from "./native-snapshot.mjs";
import {
  createSnapshotGuard,
  nativeSnapshotRuntimeTestSupport,
  readOpenedRegular,
  readSnapshotInput,
  snapshotPaths,
} from "./native-snapshot-runtime.mjs";

test("captured Git tree ignores final and parent workspace swaps", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-snapshot-git-"));
  const repository = join(root, "repository");
  const snapshot = join(root, "snapshot");
  const outside = join(root, "outside");
  try {
    await mkdir(join(repository, "native/parent"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(repository, "native/final.rs"), "owned-final");
    await writeFile(
      join(repository, "native/parent/source.rs"),
      "owned-parent",
    );
    await writeFile(join(outside, "source.rs"), "outside-parent");
    await writeFile(join(outside, "final.rs"), "outside-final");
    git(repository, ["init"]);
    git(repository, ["config", "user.email", "fixture@invalid"]);
    git(repository, ["config", "user.name", "Fixture"]);
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "fixture"]);
    const captured = nativeSnapshotTestSupport.captureRepository(repository);

    await rm(join(repository, "native/final.rs"));
    await symlink(
      join(outside, "final.rs"),
      join(repository, "native/final.rs"),
    );
    await rename(
      join(repository, "native/parent"),
      join(repository, "native/held-parent"),
    );
    await symlink(outside, join(repository, "native/parent"));
    await mkdir(snapshot);
    nativeSnapshotTestSupport.materialize(
      repository,
      snapshot,
      captured.head,
      captured.entries,
    );
    assert.equal(
      await readFile(join(snapshot, "native/final.rs"), "utf8"),
      "owned-final",
    );
    assert.equal(
      await readFile(join(snapshot, "native/parent/source.rs"), "utf8"),
      "owned-parent",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("opened output rejects final and parent swaps before reading outside bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-snapshot-output-"));
  const packageRoot = join(root, "package");
  const outside = join(root, "outside");
  try {
    await mkdir(join(packageRoot, "Contents"), { recursive: true });
    await mkdir(outside);
    const final = join(packageRoot, "final.bin");
    await writeFile(final, "owned-final");
    await writeFile(join(outside, "final.bin"), "outside-final");
    assert.deepEqual(await filesBelow(packageRoot), [final]);
    await rm(final);
    await symlink(join(outside, "final.bin"), final);
    await assert.rejects(
      readOpenedRegular(final, packageRoot),
      /Immutable snapshot rejected unavailable-file/u,
    );

    const nested = join(packageRoot, "Contents/value.bin");
    await writeFile(nested, "owned-parent");
    await writeFile(join(outside, "value.bin"), "outside-parent");
    await filesBelow(packageRoot).catch(() => []);
    await rename(join(packageRoot, "Contents"), join(packageRoot, "held"));
    await symlink(outside, join(packageRoot, "Contents"));
    await assert.rejects(
      readOpenedRegular(nested, packageRoot),
      /Immutable snapshot rejected output-parent/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("snapshot manifest binds declared input bytes and detects drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-snapshot-manifest-"));
  const repository = join(root, "repository");
  const manifest = join(root, "manifest.json");
  const previous = process.env.KEIKO_NATIVE_SNAPSHOT_MANIFEST;
  try {
    await mkdir(join(repository, "native"), { recursive: true });
    const source = join(repository, "native/source.rs");
    await writeFile(source, "owned");
    const sha256 = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update("owned").digest("hex"),
    );
    await writeFile(
      manifest,
      JSON.stringify({
        files: [{ path: "native/source.rs", sha256 }],
        head: "a".repeat(40),
        tree: "b".repeat(40),
      }),
    );
    process.env.KEIKO_NATIVE_SNAPSHOT_MANIFEST = manifest;
    nativeSnapshotRuntimeTestSupport.reset();
    assert.deepEqual(await snapshotPaths(repository, "native"), [source]);
    assert.equal(await readSnapshotInput(source, repository, "utf8"), "owned");
    const guard = await createSnapshotGuard(repository);
    assert.equal(guard.expectedHead, "a".repeat(40));
    await guard.assertUnchanged("test");
    await assert.rejects(
      readSnapshotInput(join(repository, "outside"), repository),
      /undeclared-input/u,
    );
    await writeFile(source, "drift");
    await assert.rejects(guard.assertUnchanged("drift"), /input-drift/u);
  } finally {
    if (previous === undefined)
      delete process.env.KEIKO_NATIVE_SNAPSHOT_MANIFEST;
    else process.env.KEIKO_NATIVE_SNAPSHOT_MANIFEST = previous;
    nativeSnapshotRuntimeTestSupport.reset();
    await rm(root, { force: true, recursive: true });
  }
});

test("snapshot runner cleans its private root when the isolated command fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-snapshot-cleanup-"));
  try {
    await mkdir(join(root, "native/frontend"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ private: true }),
    );
    await writeFile(
      join(root, "native/frontend/package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );
    await writeFile(
      join(root, "native/frontend/package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        name: "fixture",
        packages: { "": { name: "fixture", version: "1.0.0" } },
        requires: true,
        version: "1.0.0",
      }),
    );
    git(root, ["init"]);
    git(root, ["config", "user.email", "fixture@invalid"]);
    git(root, ["config", "user.name", "Fixture"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fixture"]);
    const before = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("keiko-native-snapshot-"),
    );
    await assert.rejects(
      runNativeSnapshot({ mode: "security", repositoryRoot: root }),
      /Immutable snapshot rejected dependency-install/u,
    );
    const after = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("keiko-native-snapshot-"),
    );
    assert.deepEqual(after, before);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

function git(repository, args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}
