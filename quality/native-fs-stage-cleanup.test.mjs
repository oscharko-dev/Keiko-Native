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
  symlink,
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
  "every precommit failure removes its identity-bound stage",
  { skip: !supported },
  async () => {
    await fixture(async ({ helper, root }) => {
      for (const name of ["parent-changed", "copy", "sync", "inventory"]) {
        const source = join(root, `source-${name}`);
        const destination = join(root, `destination-${name}`);
        await mkdir(source);
        await mkdir(join(destination, "parent"), { recursive: true });
        await writeFile(join(source, "value"), "new");
        let result;
        if (name === "copy") {
          await symlink("value", join(source, "unsupported"));
          result = await runHelper(helper, [
            "publish",
            source,
            ".",
            destination,
            "parent/delivery",
          ]);
        } else if (name === "sync") {
          result = await runHelper(
            helper,
            ["publish", source, ".", destination, "parent/delivery"],
            { env: { KEIKO_FS_HELPER_TEST_FAIL_SYNC: "stage-sync" } },
          );
        } else if (name === "parent-changed") {
          const race = startBarrier(helper, [
            "publish",
            source,
            ".",
            destination,
            "parent/delivery",
          ]);
          await race.ready;
          await writeFile(join(destination, "parent/unrelated"), "changed");
          result = await race.release();
        } else {
          result = await boundInventoryFailure(helper, source, destination);
        }
        assert.equal(result.status, 1, name);
        assert.deepEqual(
          (await readdir(join(destination, "parent"))).filter((entry) =>
            entry.startsWith(".keiko-stage-"),
          ),
          [],
          name,
        );
      }
    });
  },
);

async function boundInventoryFailure(helper, source, destination) {
  await chmod(source, 0o700);
  const handles = await Promise.all([
    open(source, "r"),
    open(join(source, "value"), "r"),
  ]);
  try {
    const entries = await Promise.all(
      [
        ["D", "0700", "."],
        ["F", "0644", "value"],
      ].map(async ([type, mode, path], index) => [
        type,
        mode,
        path,
        metadata(await handles[index].stat({ bigint: true })),
      ]),
    );
    return await runHelper(
      helper,
      [
        "publish-bound",
        destination,
        "parent/delivery",
        String(entries.length),
        ...entries.flat(),
      ],
      {
        env: { KEIKO_FS_HELPER_TEST_FAILURE: "bound-inventory-drift" },
        fds: handles.map(({ fd }) => fd),
      },
    );
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

async function fixture(callback) {
  const createdRoot = await mkdtemp(join(tmpdir(), "keiko-stage-cleanup-"));
  const root = await realpath(createdRoot);
  try {
    const records = [];
    for (const path of NATIVE_FS_SOURCES) {
      const destination = join(root, path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(repositoryRoot, path), destination);
      const bytes = await readFile(destination);
      records.push({
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

function runHelper(helper, args, { env = {}, fds = [] } = {}) {
  const child = spawn(helper, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "ignore", ...fds],
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status }));
  });
}

function startBarrier(helper, args) {
  const child = spawn(helper, args, {
    env: { ...process.env, KEIKO_FS_HELPER_TEST_BARRIER: "1" },
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  return {
    ready: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdio[3].once("data", resolve);
      child.once("close", () =>
        reject(new Error("helper closed before barrier")),
      );
    }),
    release() {
      child.stdio[4].end("C");
      return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (status) => resolve({ status }));
      });
    },
  };
}
