import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { filesBelow } from "./native-files.mjs";

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
