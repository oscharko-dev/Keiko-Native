import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { filesBelow, trackedFiles } from "./native-files.mjs";

test("native traversal rejects file and directory symlinks without following", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-native-files-"));
  const outside = await mkdtemp(join(tmpdir(), "keiko-native-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "must-not-be-read");
    for (const [name, target] of [
      ["file-link", join(outside, "secret.txt")],
      ["directory-link", outside],
    ]) {
      const tree = join(root, name);
      await mkdir(tree);
      await symlink(target, join(tree, "escape"));
      let inventoryStarted = false;
      await assert.rejects(
        filesBelow(tree).then((files) => {
          inventoryStarted = true;
          return files;
        }),
        /Native traversal rejected symbolic-link at <redacted-path>/u,
      );
      assert.equal(inventoryStarted, false);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("native traversal retains regular files and exact ignored directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-native-files-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "lib.rs"), "regular");
    for (const directory of ["node_modules", "target"]) {
      await mkdir(join(root, directory));
      await symlink(root, join(root, directory, "escape"));
    }
    assert.deepEqual(
      await filesBelow(root, new Set(["node_modules", "target"])),
      [join(root, "src", "lib.rs")],
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test(
  "native traversal rejects non-regular special entries",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "keiko-native-files-"));
    try {
      const fifo = join(root, "local.fifo");
      const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
      assert.equal(created.status, 0, created.stderr);
      await assert.rejects(
        filesBelow(root),
        /Native traversal rejected special-entry at <redacted-path>/u,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);

test("tracked native entries are validated without following ignored symlinks", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "keiko-native-tracked-"));
  const outside = await mkdtemp(join(tmpdir(), "keiko-native-outside-"));
  try {
    const nativeRoot = join(repositoryRoot, "native");
    await mkdir(join(nativeRoot, "node_modules"), { recursive: true });
    await writeFile(join(outside, "secret.rs"), "must-not-be-read");
    await symlink(
      join(outside, "secret.rs"),
      join(nativeRoot, "node_modules", "escape.rs"),
    );
    const staged = `120000 ${"a".repeat(40)} 0\tnative/node_modules/escape.rs\0`;
    await assert.rejects(
      trackedFiles(staged, repositoryRoot, nativeRoot),
      /Native traversal rejected tracked-symbolic-link/u,
    );

    await rm(join(nativeRoot, "node_modules", "escape.rs"));
    await writeFile(join(nativeRoot, "node_modules", "tracked.rs"), "regular");
    const regular = `100644 ${"b".repeat(40)} 0\tnative/node_modules/tracked.rs\0`;
    assert.deepEqual(await trackedFiles(regular, repositoryRoot, nativeRoot), [
      join(nativeRoot, "node_modules", "tracked.rs"),
    ]);

    await mkdir(join(nativeRoot, "node_modules", "special"));
    const special = `100644 ${"d".repeat(40)} 0\tnative/node_modules/special\0`;
    await assert.rejects(
      trackedFiles(special, repositoryRoot, nativeRoot),
      /Native traversal rejected special-entry/u,
    );

    const directory = join(nativeRoot, "linked-parent");
    await symlink(outside, directory);
    const escaped = `100644 ${"c".repeat(40)} 0\tnative/linked-parent/secret.rs\0`;
    await assert.rejects(
      trackedFiles(escaped, repositoryRoot, nativeRoot),
      /Native traversal rejected symbolic-link/u,
    );
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});
