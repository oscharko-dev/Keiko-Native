import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileNativeFsHelper,
  nativeFsTestSupport,
  NATIVE_FS_SOURCES,
} from "./native-fs.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const supported = process.platform === "darwin" || process.platform === "linux";

test(
  "bound publication syncs nested staged directories before commit",
  { skip: !supported },
  async () => {
    await fixture(async ({ helper, root }) => {
      const source = join(root, "source");
      const destination = join(root, "destination");
      await mkdir(join(source, "nested"), { recursive: true });
      await chmod(source, 0o700);
      await writeFile(join(source, "nested/value"), "new");
      await mkdir(join(destination, "delivery"), { recursive: true });
      await writeFile(join(destination, "delivery/old"), "old");
      const handles = await Promise.all([
        open(source, "r"),
        open(join(source, "nested"), "r"),
        open(join(source, "nested/value"), "r"),
      ]);
      try {
        const entries = await Promise.all(
          [
            ["D", "0700", "."],
            ["D", "0755", "nested"],
            ["F", "0644", "nested/value"],
          ].map(async ([type, mode, path], index) => [
            type,
            mode,
            path,
            metadata(await handles[index].stat({ bigint: true })),
          ]),
        );
        const result = await runHelper(
          helper,
          [
            "publish-bound",
            destination,
            "delivery",
            String(entries.length),
            ...entries.flat(),
          ],
          {
            env: { KEIKO_FS_HELPER_TEST_FAIL_SYNC: "bound-directory-sync" },
            fds: handles.map(({ fd }) => fd),
          },
        );
        assert.equal(result.status, 1);
        assert.match(result.stderr, /bound-directory-sync/u);
        assert.equal(
          await readFile(join(destination, "delivery/old"), "utf8"),
          "old",
        );
      } finally {
        await Promise.all(handles.map((handle) => handle.close()));
      }
    });
  },
);

test(
  "publication checks commit and rollback directory sync failures",
  { skip: !supported },
  async () => {
    await fixture(async ({ helper, root }) => {
      for (const failure of [
        "publish-parent-sync",
        "publish-parent-sync,publish-rollback-sync",
      ]) {
        const source = join(root, `source-${failure.length}`);
        const destination = join(root, `destination-${failure.length}`);
        await mkdir(source);
        await mkdir(join(destination, "delivery"), { recursive: true });
        await writeFile(join(source, "new"), "new");
        await writeFile(join(destination, "delivery/old"), "old");
        const result = await runHelper(
          helper,
          ["publish", source, ".", destination, "delivery"],
          { env: { KEIKO_FS_HELPER_TEST_FAIL_SYNC: failure } },
        );
        assert.equal(result.status, 1, failure);
        assert.match(
          result.stderr,
          failure.includes("rollback")
            ? /publish-rollback-sync/u
            : /publish-sync/u,
        );
        assert.equal(
          await readFile(join(destination, "delivery/old"), "utf8"),
          "old",
        );
      }
    });
  },
);

test(
  "post-commit cleanup failure reports success and retains a tombstone",
  { skip: !supported },
  async () => {
    await fixture(async ({ helper, root }) => {
      const source = join(root, "source");
      const destination = join(root, "destination");
      await mkdir(source);
      await mkdir(join(destination, "delivery"), { recursive: true });
      await writeFile(join(source, "new"), "new");
      await writeFile(join(destination, "delivery/old"), "old");
      await chmod(join(destination, "delivery"), 0o500);
      try {
        const result = await runHelper(helper, [
          "publish",
          source,
          ".",
          destination,
          "delivery",
        ]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          await readFile(join(destination, "delivery/new"), "utf8"),
          "new",
        );
        const tombstone = (await readdir(destination)).find((name) =>
          name.startsWith(".keiko-cleanup-"),
        );
        assert.ok(tombstone);
        assert.equal(
          await readFile(join(destination, tombstone, "old"), "utf8"),
          "old",
        );
      } finally {
        for (const name of await readdir(destination))
          if (
            name.startsWith(".keiko-cleanup-") ||
            name.startsWith(".keiko-stage-")
          )
            await chmod(join(destination, name), 0o700);
      }
    });
  },
);

async function fixture(callback) {
  const createdRoot = await mkdtemp(
    join(tmpdir(), "keiko-native-fs-durability-"),
  );
  const root = await realpath(createdRoot);
  try {
    const records = [];
    for (const path of NATIVE_FS_SOURCES) {
      const destination = join(root, path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(repositoryRoot, path), destination);
      const bytes = await readFile(destination);
      records.push({
        blob: nativeFsTestSupport.gitBlob(bytes),
        path,
        sha256: nativeFsTestSupport.sha256(bytes),
      });
    }
    const helper = join(root, "helper");
    compileNativeFsHelper({
      expectedSources: records,
      outputPath: helper,
      snapshotRoot: root,
      tree: "a".repeat(40),
    });
    await callback({ helper, root });
  } finally {
    await rm(createdRoot, { force: true, recursive: true });
  }
}

function metadata(value) {
  return [
    value.dev,
    value.ino,
    value.mode,
    value.size,
    value.mtimeNs,
    value.ctimeNs,
  ].join(":");
}

function runHelper(helper, args, { env = {}, fds = [], input } = {}) {
  const child = spawn(helper, args, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "ignore", "pipe", ...fds],
  });
  child.stdin.end(input);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stderr }));
  });
}
