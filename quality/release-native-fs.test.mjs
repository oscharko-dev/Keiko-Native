import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createReleaseNativeFilesystem } from "./release-native-fs.mjs";

test(
  "release filesystem canonicalizes a symlinked temporary base",
  { skip: process.platform === "win32" },
  async () => {
    const repositoryRoot = await realpath(process.cwd());
    const revision = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).stdout.trim();
    const createdRoot = await mkdtemp(join(tmpdir(), "keiko-release-fs-test-"));
    const root = await realpath(createdRoot);
    const actualBase = join(root, "actual");
    const linkedBase = join(root, "linked");
    await mkdir(actualBase, { mode: 0o700 });
    await symlink(actualBase, linkedBase, "dir");

    let releaseFilesystem;
    try {
      releaseFilesystem = await createReleaseNativeFilesystem(
        repositoryRoot,
        (command, args, { binary = false, capture = false } = {}) => {
          const result = spawnSync(command, args, {
            cwd: repositoryRoot,
            encoding: binary ? undefined : "utf8",
          });
          assert.equal(result.status, 0, result.stderr);
          return capture && !binary ? result.stdout.trim() : result.stdout;
        },
        { revision, temporaryBase: linkedBase },
      );
      assert.equal(
        dirname(dirname(releaseFilesystem.workspaceRoot)),
        actualBase,
      );
      releaseFilesystem.close();
      releaseFilesystem = undefined;
      assert.deepEqual(await readdir(actualBase), []);
    } finally {
      releaseFilesystem?.close();
      await rm(root, { force: true, recursive: true });
    }
  },
);
