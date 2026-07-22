import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
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
  "compiler consumes bound sources and executes the bound helper",
  { skip: !supported },
  async () => {
    await fixture(async ({ outputPath, records, root }) => {
      const compiler = join(root, "descriptor-compiler");
      await writeFile(
        compiler,
        `#!/bin/sh
for value in "$@"; do
  case "$value" in
    '${root}'/*.c|'${root}'/*.h) exit 9 ;;
  esac
done
exec /usr/bin/cc "$@"
`,
        { mode: 0o700 },
      );
      const fs = compileNativeFsHelper({
        compiler,
        expectedSources: records,
        outputPath,
        snapshotRoot: root,
        tree: "a".repeat(40),
      });
      fs.mkdir(root, "bound-execution");
      assert.ok((await readdir(root)).includes("bound-execution"));
      await chmod(root, 0o755);
      assert.throws(() => fs.mkdir(root, "untrusted"), /executable-root/u);
      await chmod(root, 0o700);
    });
  },
);

test(
  "directory-shaped compiler output is rejected and fully cleaned",
  { skip: !supported },
  async () => {
    await fixture(async ({ outputPath, records, root }) => {
      const compiler = join(root, "directory-compiler");
      await writeFile(
        compiler,
        `#!/bin/sh
while [ "$1" != "-o" ]; do shift; done
shift
mkdir "$1"
`,
        { mode: 0o700 },
      );
      assert.throws(
        () =>
          compileNativeFsHelper({
            compiler,
            expectedSources: records,
            outputPath,
            snapshotRoot: root,
            tree: "a".repeat(40),
          }),
        /compiler-output/u,
      );
      assert.deepEqual(
        (await readdir(root)).filter((name) =>
          name.includes("native-fs-build"),
        ),
        [],
      );
    });
  },
);

async function fixture(callback) {
  const createdRoot = await mkdtemp(join(tmpdir(), "keiko-native-fs-binding-"));
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
    await callback({ outputPath: join(root, "helper"), records, root });
  } finally {
    await rm(createdRoot, { force: true, recursive: true });
  }
}
