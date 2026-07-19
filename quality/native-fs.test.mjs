import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
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
  "native helper compiles exact sources and handles regular trees",
  {
    skip: !supported,
  },
  async () => {
    await fixture(async ({ fs, helper, root }) => {
      await mkdir(join(root, "source/nested"), { recursive: true });
      await mkdir(join(root, "source/.bin"));
      await writeFile(join(root, "source/nested/value"), "alpha");
      await writeFile(join(root, "source/nested/executable"), "#!/bin/sh\n");
      await chmod(join(root, "source/nested/executable"), 0o755);
      await writeFile(join(root, "source/.bin/ignored"), "ignored");
      await mkdir(join(root, "destination"));
      fs.copyTree(
        join(root, "source"),
        ".",
        join(root, "destination"),
        "copy",
        ".bin",
      );
      assert.equal(
        fs.read(join(root, "destination"), "copy/nested/value", "utf8"),
        "alpha",
      );
      assert.equal(
        (await lstat(join(root, "destination/copy/nested/value"))).mode & 0o777,
        0o644,
      );
      assert.equal(
        (await lstat(join(root, "destination/copy/nested"))).mode & 0o777,
        0o755,
      );
      assert.equal(
        (await lstat(join(root, "destination/copy"))).mode & 0o777,
        0o755,
      );
      assert.equal(
        (await lstat(join(root, "destination/copy/nested/executable"))).mode &
          0o777,
        0o755,
      );
      assert.deepEqual(fs.list(join(root, "destination"), "copy"), [
        { mode: "0755", path: "nested", type: "D" },
        { mode: "0755", path: "nested/executable", type: "F" },
        { mode: "0644", path: "nested/value", type: "F" },
      ]);
      fs.write(
        join(root, "destination"),
        "created",
        Buffer.from("beta"),
        0o600,
      );
      fs.write(join(root, "destination"), "default-mode", Buffer.from("gamma"));
      fs.mkdir(join(root, "destination"), "directory/nested");
      fs.symlink(join(root, "destination"), "directory/link", "../created");
      assert.ok(Buffer.isBuffer(fs.read(join(root, "destination"), "created")));
      assert.equal(
        (await lstat(join(root, "destination/created"))).mode & 0o777,
        0o600,
      );
      assert.equal((await lstat(helper)).mode & 0o777, 0o700);
      assert.ok(
        (
          await lstat(join(root, "destination/directory/link"))
        ).isSymbolicLink(),
      );
    });
  },
);

test(
  "native helper rejects symlinks and special files without disclosure",
  {
    skip: !supported,
  },
  async () => {
    await fixture(async ({ fs, root }) => {
      const trusted = join(root, "trusted");
      const outside = join(root, "outside");
      await mkdir(join(trusted, "parent"), { recursive: true });
      await mkdir(outside);
      await writeFile(join(outside, "secret"), "do-not-read");
      await symlink(join(outside, "secret"), join(trusted, "final-link"));
      await symlink(outside, join(trusted, "parent-link"));
      await symlink(trusted, join(root, "root-link"));
      assert.throws(() => fs.read(trusted, "final-link"), /regular-open/u);
      assert.throws(
        () => fs.read(trusted, "parent-link/secret"),
        /parent-open/u,
      );
      assert.throws(
        () => fs.read(join(root, "root-link"), "parent/value"),
        /root-symlink/u,
      );
      const fifo = join(trusted, "fifo");
      const created = spawnSync("mkfifo", [fifo]);
      assert.equal(created.status, 0);
      assert.throws(() => fs.read(trusted, "fifo"), /regular-open/u);
      await mkdir(join(root, "copy-destination"));
      assert.throws(
        () => fs.copyTree(trusted, ".", join(root, "copy-destination"), "copy"),
        /unsupported-entry/u,
      );
    });
  },
);

test(
  "native helper detects final replacement, parent races, and content changes",
  {
    skip: !supported,
  },
  async () => {
    await fixture(async ({ helper, root }) => {
      const trusted = join(root, "trusted");
      const outside = join(root, "outside");
      await mkdir(join(trusted, "parent"), { recursive: true });
      await mkdir(outside);
      await writeFile(join(trusted, "parent/value"), "trusted");
      await writeFile(join(outside, "secret"), "secret");

      let race = startBarrier(helper, ["read", trusted, "parent/value"]);
      await race.ready;
      await rename(
        join(trusted, "parent/value"),
        join(trusted, "parent/saved"),
      );
      await symlink(join(outside, "secret"), join(trusted, "parent/value"));
      assert.equal((await race.release()).status, 1);

      await unlink(join(trusted, "parent/value"));
      await rename(
        join(trusted, "parent/saved"),
        join(trusted, "parent/value"),
      );
      race = startBarrier(helper, ["read", trusted, "parent/value"]);
      await race.ready;
      await rename(join(trusted, "parent"), join(trusted, "saved-parent"));
      await symlink(outside, join(trusted, "parent"));
      await unlink(join(trusted, "parent"));
      await rename(join(trusted, "saved-parent"), join(trusted, "parent"));
      assert.equal((await race.release()).status, 1);

      race = startBarrier(helper, ["read", trusted, "parent/value"]);
      await race.ready;
      await writeFile(join(trusted, "parent/value"), "changed");
      assert.equal((await race.release()).status, 1);

      race = startBarrier(helper, ["read", trusted, "parent/value"]);
      await race.ready;
      await rename(trusted, join(root, "saved-root"));
      await symlink(outside, trusted);
      assert.equal((await race.release()).status, 1);
    });
  },
);

test(
  "native helper fails closed when a write parent is swapped",
  {
    skip: !supported,
  },
  async () => {
    await fixture(async ({ helper, root }) => {
      const trusted = join(root, "trusted");
      const outside = join(root, "outside");
      await mkdir(join(trusted, "parent"), { recursive: true });
      await mkdir(outside);
      const race = startBarrier(
        helper,
        ["write", trusted, "parent/value", "600"],
        "payload",
      );
      await race.ready;
      await rename(join(trusted, "parent"), join(trusted, "saved-parent"));
      await symlink(outside, join(trusted, "parent"));
      assert.equal((await race.release()).status, 1);
      await assert.rejects(readFile(join(outside, "value")), {
        code: "ENOENT",
      });
    });
  },
);

test(
  "native helper publishes by atomic replacement and rejects hostile destinations",
  {
    skip: !supported,
  },
  async () => {
    await fixture(async ({ fs, root }) => {
      const source = join(root, "source");
      const destination = join(root, "destination");
      const outside = join(root, "outside");
      await mkdir(source);
      await mkdir(join(destination, "delivery"), { recursive: true });
      await mkdir(outside);
      await writeFile(join(source, "new"), "new");
      await writeFile(join(destination, "delivery/old"), "old");
      fs.publish(source, ".", destination, "delivery");
      assert.equal(
        await readFile(join(destination, "delivery/new"), "utf8"),
        "new",
      );
      await assert.rejects(readFile(join(destination, "delivery/old")), {
        code: "ENOENT",
      });
      await symlink(outside, join(destination, "hostile"));
      assert.throws(
        () => fs.publish(source, ".", destination, "hostile"),
        /publish-destination-type/u,
      );
      assert.deepEqual(await readdir(outside), []);
      assert.deepEqual((await readdir(destination)).toSorted(), [
        "delivery",
        "hostile",
      ]);
    });
  },
);

test(
  "native helper rejects compiler and source integrity failures and cleans temporary output",
  {
    skip: !supported,
  },
  async () => {
    const createdRoot = await mkdtemp(
      join(tmpdir(), "keiko-native-fs-compile-"),
    );
    const root = await realpath(createdRoot);
    try {
      const records = await copySources(root);
      const outputPath = join(root, "helper");
      assert.throws(
        () =>
          compileNativeFsHelper({
            expectedSources: [],
            outputPath,
            snapshotRoot: root,
            tree: "a".repeat(40),
          }),
        /source-set/u,
      );
      assert.throws(
        () =>
          compileNativeFsHelper({
            expectedSources: records,
            outputPath,
            snapshotRoot: root,
            tree: "invalid",
          }),
        /snapshot-tree/u,
      );
      assert.throws(
        () =>
          compileNativeFsHelper({
            compiler: "/usr/bin/false",
            expectedSources: records,
            outputPath,
            snapshotRoot: root,
            tree: "a".repeat(40),
          }),
        /compiler/u,
      );
      assert.deepEqual(
        (await readdir(root)).filter((name) => name.includes("building")),
        [],
      );
      const hostile = structuredClone(records);
      hostile[0].sha256 = "0".repeat(64);
      assert.throws(
        () =>
          compileNativeFsHelper({
            expectedSources: hostile,
            outputPath,
            snapshotRoot: root,
            tree: "a".repeat(40),
          }),
        /source-integrity/u,
      );
      const mutatingCompiler = join(root, "mutating-compiler");
      await writeFile(
        mutatingCompiler,
        `#!/bin/sh\nprintf "\\n/* compiler-time drift */\\n" >> '${join(root, NATIVE_FS_SOURCES[0])}'\nexec /usr/bin/cc "$@"\n`,
        { mode: 0o700 },
      );
      assert.throws(
        () =>
          compileNativeFsHelper({
            compiler: mutatingCompiler,
            expectedSources: records,
            outputPath,
            snapshotRoot: root,
            tree: "a".repeat(40),
          }),
        /source-integrity/u,
      );
      assert.deepEqual(
        (await readdir(root)).filter((name) => name.includes("building")),
        [],
      );
    } finally {
      await rm(createdRoot, { force: true, recursive: true });
    }
  },
);

async function fixture(callback) {
  const createdRoot = await mkdtemp(join(tmpdir(), "keiko-native-fs-"));
  const root = await realpath(createdRoot);
  try {
    const records = await copySources(root);
    const helper = join(root, "native-fs-helper");
    const fs = compileNativeFsHelper({
      expectedSources: records,
      outputPath: helper,
      snapshotRoot: root,
      tree: "a".repeat(40),
    });
    await callback({ fs, helper, root });
  } finally {
    await rm(createdRoot, { force: true, recursive: true });
  }
}

async function copySources(root) {
  const records = [];
  for (const path of NATIVE_FS_SOURCES) {
    const source = join(repositoryRoot, path);
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
    const bytes = await readFile(destination);
    records.push({
      blob: nativeFsTestSupport.gitBlob(bytes),
      path,
      sha256: nativeFsTestSupport.sha256(bytes),
    });
  }
  return records;
}

function startBarrier(helper, args, input) {
  const child = spawn(helper, args, {
    env: { ...process.env, KEIKO_FS_HELPER_TEST_BARRIER: "1" },
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  const ready = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdio[3].once("data", resolve);
  });
  return {
    ready,
    async release() {
      child.stdio[4].end("C");
      return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (status) => resolve({ status }));
      });
    },
  };
}
