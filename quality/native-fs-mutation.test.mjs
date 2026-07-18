import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
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
  "writes reject transient destination parent and final-entry rebinding",
  { skip: !supported },
  async () => {
    await fixture(async ({ helper, root }) => {
      const trusted = join(root, "trusted");
      const outside = join(root, "outside");
      await mkdir(join(trusted, "parent"), { recursive: true });
      await mkdir(outside);
      let race = startBarrier(
        helper,
        ["write", trusted, "parent/value", "600"],
        "payload",
      );
      await race.ready;
      await rename(join(trusted, "parent"), join(trusted, "saved-parent"));
      await symlink(outside, join(trusted, "parent"));
      await unlink(join(trusted, "parent"));
      await rename(join(trusted, "saved-parent"), join(trusted, "parent"));
      assert.equal((await race.release()).status, 1);
      await assert.rejects(readFile(join(trusted, "parent/value")), {
        code: "ENOENT",
      });
      await assert.rejects(readFile(join(outside, "value")), {
        code: "ENOENT",
      });

      race = startBarrier(
        helper,
        ["write", trusted, "parent/value", "600"],
        "payload",
        "write-complete",
      );
      await race.ready;
      await rename(
        join(trusted, "parent/value"),
        join(trusted, "parent/saved-value"),
      );
      await writeFile(join(trusted, "parent/value"), "hostile");
      await rm(join(trusted, "parent/value"));
      await rename(
        join(trusted, "parent/saved-value"),
        join(trusted, "parent/value"),
      );
      assert.equal((await race.release()).status, 1);
    });
  },
);

test(
  "mkdir rejects transient final-directory rebinding",
  { skip: !supported },
  async () => {
    await fixture(async ({ helper, root }) => {
      const trusted = join(root, "trusted");
      await mkdir(join(trusted, "parent"), { recursive: true });
      const race = startBarrier(helper, ["mkdir", trusted, "parent/created"]);
      await race.ready;
      await rename(
        join(trusted, "parent/created"),
        join(trusted, "parent/saved"),
      );
      await mkdir(join(trusted, "parent/created"));
      await rm(join(trusted, "parent/created"), { recursive: true });
      await rename(
        join(trusted, "parent/saved"),
        join(trusted, "parent/created"),
      );
      assert.equal((await race.release()).status, 1);
    });
  },
);

test(
  "publication rejects transient staging and final-leaf rebinding",
  { skip: !supported },
  async () => {
    await fixture(async ({ helper, root }) => {
      const source = join(root, "source");
      const destination = join(root, "destination");
      await mkdir(source);
      await mkdir(join(destination, "delivery"), { recursive: true });
      await writeFile(join(source, "new"), "new");
      await writeFile(join(destination, "delivery/old"), "old");

      let race = startBarrier(helper, [
        "publish",
        source,
        ".",
        destination,
        "delivery",
      ]);
      await race.ready;
      const staging = (await readdir(destination)).find((name) =>
        name.startsWith(".keiko-stage-"),
      );
      assert.ok(staging);
      await rename(
        join(destination, staging),
        join(destination, "saved-stage"),
      );
      await mkdir(join(destination, staging));
      await rm(join(destination, staging), { recursive: true });
      await rename(
        join(destination, "saved-stage"),
        join(destination, staging),
      );
      assert.equal((await race.release()).status, 1);
      assert.equal(
        await readFile(join(destination, "delivery/old"), "utf8"),
        "old",
      );
      await rm(join(destination, staging), { recursive: true });

      race = startBarrier(helper, [
        "publish",
        source,
        ".",
        destination,
        "delivery",
      ]);
      await race.ready;
      await rename(join(destination, "delivery"), join(destination, "saved"));
      await mkdir(join(destination, "delivery"));
      await rm(join(destination, "delivery"), { recursive: true });
      await rename(join(destination, "saved"), join(destination, "delivery"));
      assert.equal((await race.release()).status, 1);
      assert.equal(
        await readFile(join(destination, "delivery/old"), "utf8"),
        "old",
      );
    });
  },
);

test(
  "publication rolls back a mismatched post-swap leaf",
  { skip: !supported },
  async () => {
    await fixture(async ({ helper, root }) => {
      const source = join(root, "source");
      const destination = join(root, "destination");
      await mkdir(source);
      await mkdir(join(destination, "delivery"), { recursive: true });
      await writeFile(join(source, "new"), "new");
      await writeFile(join(destination, "delivery/old"), "old");
      const race = startBarrier(
        helper,
        ["publish", source, ".", destination, "delivery"],
        undefined,
        "published-leaf",
      );
      await race.ready;
      await rename(
        join(destination, "delivery"),
        join(destination, "moved-new"),
      );
      await mkdir(join(destination, "delivery"));
      await writeFile(join(destination, "delivery/hostile"), "hostile");
      assert.equal((await race.release()).status, 1);
      assert.equal(
        await readFile(join(destination, "delivery/old"), "utf8"),
        "old",
      );
      await assert.rejects(readFile(join(destination, "delivery/hostile")), {
        code: "ENOENT",
      });
    });
  },
);

test(
  "symlink creation rejects transient final-entry rebinding",
  { skip: !supported },
  async () => {
    await fixture(async ({ helper, root }) => {
      const trusted = join(root, "trusted");
      await mkdir(join(trusted, "parent"), { recursive: true });
      const race = startBarrier(
        helper,
        ["symlink", trusted, "parent/link", "../target"],
        undefined,
        "symlink-created",
      );
      await race.ready;
      await rename(join(trusted, "parent/link"), join(trusted, "parent/saved"));
      await symlink("../other", join(trusted, "parent/link"));
      await unlink(join(trusted, "parent/link"));
      await rename(join(trusted, "parent/saved"), join(trusted, "parent/link"));
      assert.equal((await race.release()).status, 1);
    });
  },
);

test(
  "tree copy rejects transient file and child-directory rebinding",
  { skip: !supported },
  async () => {
    await fixture(async ({ helper, root }) => {
      const source = join(root, "source");
      const destination = join(root, "destination");
      await mkdir(join(source, "nested"), { recursive: true });
      await mkdir(destination);
      await writeFile(join(source, "nested/value"), "trusted");

      let race = startBarrier(
        helper,
        ["copy-tree", source, ".", destination, "copy"],
        undefined,
        "copy-file-created",
      );
      await race.ready;
      await rename(
        join(destination, "copy/nested/value"),
        join(destination, "copy/nested/saved"),
      );
      await writeFile(join(destination, "copy/nested/value"), "hostile");
      await rm(join(destination, "copy/nested/value"));
      await rename(
        join(destination, "copy/nested/saved"),
        join(destination, "copy/nested/value"),
      );
      assert.equal((await race.release()).status, 1);
      await rm(join(destination, "copy"), { recursive: true });

      race = startBarrier(
        helper,
        ["copy-tree", source, ".", destination, "copy"],
        undefined,
        "copy-directory-created",
      );
      await race.ready;
      await rename(
        join(destination, "copy/nested"),
        join(destination, "copy/saved"),
      );
      await mkdir(join(destination, "copy/nested"));
      await rm(join(destination, "copy/nested"), { recursive: true });
      await rename(
        join(destination, "copy/saved"),
        join(destination, "copy/nested"),
      );
      assert.equal((await race.release()).status, 1);
    });
  },
);

async function fixture(callback) {
  const createdRoot = await mkdtemp(
    join(tmpdir(), "keiko-native-fs-mutation-"),
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

function startBarrier(helper, args, input, point = "1") {
  const child = spawn(helper, args, {
    env: { ...process.env, KEIKO_FS_HELPER_TEST_BARRIER: point },
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  child.stdin.end(input);
  return {
    ready: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdio[3].once("data", resolve);
    }),
    async release() {
      child.stdio[4].end("C");
      return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (status) => resolve({ status }));
      });
    },
  };
}
