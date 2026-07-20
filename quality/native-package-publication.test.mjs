import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { nativePackageTestSupport } from "./native-package.mjs";
import { publishValidatedPackage } from "./native-package-publication.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const revision = "a".repeat(40);
const supported = process.platform === "darwin" || process.platform === "linux";

test(
  "validated acceptance publication includes the exact bound closure",
  { skip: !supported },
  async () => {
    await fixture(
      "acceptance",
      async ({ destination, executable, nativeFs, packageRoot }) => {
        const postCommitMutation = {
          ...nativeFs,
          publishBound(...args) {
            nativeFs.publishBound(...args);
            writeFileSync(executable, "post-commit-source-drift");
          },
        };
        publishValidatedPackage({
          cargoLockSha256: "e".repeat(64),
          destinationPath: "delivery",
          destinationRoot: destination,
          mode: "acceptance",
          nativeFs: postCommitMutation,
          npmLockSha256: "f".repeat(64),
          packageRoot,
          policySha256: "d".repeat(64),
          revision,
        });
        assert.deepEqual(
          nativeFs.list(destination, "delivery").map(({ path }) => path),
          [
            "Keiko Native.app",
            "Keiko Native.app/Contents",
            "Keiko Native.app/Contents/Info.plist",
            "Keiko Native.app/Contents/MacOS",
            "Keiko Native.app/Contents/MacOS/keiko-native-desktop",
            "Keiko Native.app/Contents/Resources",
            "Keiko Native.app/Contents/Resources/THIRD-PARTY-NOTICES.json",
            "acceptance-evidence.json",
            "package-manifest.json",
          ].toSorted((left, right) => left.localeCompare(right)),
        );
        await assert.rejects(readFile(join(destination, "delivery/old")), {
          code: "ENOENT",
        });
        assert.equal(
          (
            await readFile(
              join(
                destination,
                "delivery/Keiko Native.app/Contents/MacOS/keiko-native-desktop",
              ),
            )
          ).toString("hex"),
          "cffaedfe0c000001",
        );
      },
    );
  },
);

for (const [name, mutate] of [
  [
    "byte mutation",
    ({ executable }) => writeFileSync(executable, Buffer.from("mutated")),
  ],
  [
    "named replacement",
    ({ executable }) => {
      renameSync(executable, `${executable}.saved`);
      writeFileSync(executable, Buffer.from("replacement"), { mode: 0o755 });
    },
  ],
  ["mode drift", ({ executable }) => chmodSync(executable, 0o644)],
  [
    "added entry",
    ({ packageRoot }) => writeFileSync(join(packageRoot, "unexpected"), "bad"),
  ],
]) {
  test(
    `validation to publication rejects ${name} and preserves prior delivery`,
    { skip: !supported },
    async () => {
      await fixture("package", async (context) => {
        assert.throws(
          () =>
            publishValidatedPackage({
              beforePublish: () => mutate(context),
              cargoLockSha256: "e".repeat(64),
              destinationPath: "delivery",
              destinationRoot: context.destination,
              mode: "package",
              nativeFs: context.nativeFs,
              npmLockSha256: "f".repeat(64),
              packageRoot: context.packageRoot,
              policySha256: "d".repeat(64),
              revision,
            }),
          /Native filesystem helper rejected bound-/u,
        );
        assert.equal(
          await readFile(join(context.destination, "delivery/old"), "utf8"),
          "old",
        );
        assert.deepEqual(await readdir(context.destination), ["delivery"]);
      });
    },
  );
}

test(
  "manifest and acceptance evidence are validated before publication",
  { skip: !supported },
  async () => {
    await fixture("acceptance", async (context) => {
      assertMalformedBoundRecords(context);
      const manifestPath = join(context.packageRoot, "package-manifest.json");
      const evidencePath = join(
        context.packageRoot,
        "acceptance-evidence.json",
      );
      const manifestBytes = await readFile(manifestPath);
      assert.throws(
        () => publishValidatedPackage(publicationArguments(context, "invalid")),
        /publication-mode/u,
      );
      await writeFile(join(context.packageRoot, "unexpected"), "unexpected");
      assert.throws(
        () =>
          publishValidatedPackage(publicationArguments(context, "acceptance")),
        /package-inventory/u,
      );
      rmSync(join(context.packageRoot, "unexpected"));
      assert.throws(
        () =>
          publishValidatedPackage({
            ...publicationArguments(context, "acceptance"),
            nativeFs: {
              ...context.nativeFs,
              list(...args) {
                const inventory = context.nativeFs.list(...args);
                rmSync(manifestPath);
                return inventory;
              },
            },
          }),
        /ENOENT/u,
      );
      writeFileSync(manifestPath, "not-json", { mode: 0o600 });
      assert.throws(
        () =>
          publishValidatedPackage(publicationArguments(context, "acceptance")),
        /package-manifest/u,
      );
      writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
      const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
      await writeFile(
        evidencePath,
        `${JSON.stringify({ ...evidence, sourceRevision: "b".repeat(40) })}\n`,
        { mode: 0o600 },
      );
      assert.throws(
        () =>
          publishValidatedPackage(publicationArguments(context, "acceptance")),
        /acceptance-evidence/u,
      );
      assert.equal(
        await readFile(join(context.destination, "delivery/old"), "utf8"),
        "old",
      );
    });
  },
);

function assertMalformedBoundRecords(context) {
  const rootFd = openSync(
    context.packageRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
  );
  const fileFd = openSync(
    context.executable,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const root = {
    fd: rootFd,
    metadata: fstatSync(rootFd, { bigint: true }),
    mode: "0700",
    path: ".",
    type: "D",
  };
  const file = {
    fd: fileFd,
    metadata: fstatSync(fileFd, { bigint: true }),
    mode: "0755",
    path: "Keiko Native.app/Contents/MacOS/keiko-native-desktop",
    type: "F",
  };
  try {
    for (const [mutation, expected] of [
      [{ ...file, type: "X" }, /bound-entry/u],
      [{ ...file, path: "../escape" }, /bound-entry/u],
      [{ ...file, mode: "0644" }, /bound-fd/u],
    ]) {
      assert.throws(
        () =>
          context.nativeFs.publishBound(context.destination, "invalid", [
            root,
            mutation,
          ]),
        expected,
      );
    }
    assert.throws(
      () =>
        context.nativeFs.publishBound(context.destination, "invalid", [
          root,
          { ...root },
        ]),
      /bound-duplicate/u,
    );
  } finally {
    closeSync(fileFd);
    closeSync(rootFd);
  }
}

function publicationArguments(context, mode) {
  return {
    cargoLockSha256: "e".repeat(64),
    destinationPath: "delivery",
    destinationRoot: context.destination,
    mode,
    nativeFs: context.nativeFs,
    npmLockSha256: "f".repeat(64),
    packageRoot: context.packageRoot,
    policySha256: "d".repeat(64),
    revision,
  };
}

async function fixture(mode, callback) {
  const createdRoot = await mkdtemp(join(tmpdir(), "keiko-bound-package-"));
  const root = await realpath(createdRoot);
  const packageRoot = join(root, "package");
  const destination = join(root, "destination");
  try {
    await chmod(root, 0o700);
    const records = [];
    for (const path of NATIVE_FS_SOURCES) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(repositoryRoot, path), target);
      const bytes = await readFile(target);
      records.push({
        blob: nativeFsTestSupport.gitBlob(bytes),
        path,
        sha256: nativeFsTestSupport.sha256(bytes),
      });
    }
    const nativeFs = compileFixture(root, records);
    const files = await createPackage(packageRoot, mode);
    await mkdir(join(destination, "delivery"), { recursive: true });
    await writeFile(join(destination, "delivery/old"), "old");
    await callback({
      destination,
      executable: join(
        packageRoot,
        "Keiko Native.app/Contents/MacOS/keiko-native-desktop",
      ),
      files,
      nativeFs,
      packageRoot,
    });
  } finally {
    await rm(createdRoot, { force: true, recursive: true });
  }
}

function compileFixture(root, records) {
  let failure;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return compileNativeFsHelper({
        expectedSources: records,
        outputPath: join(root, "helper"),
        snapshotRoot: root,
        tree: "c".repeat(40),
      });
    } catch (error) {
      failure = error;
      if (!/rejected compiler$/u.test(error.message)) throw error;
    }
  }
  throw failure;
}

async function createPackage(packageRoot, mode) {
  const appRoot = join(packageRoot, "Keiko Native.app");
  await mkdir(join(appRoot, "Contents/MacOS"), { recursive: true });
  await mkdir(join(appRoot, "Contents/Resources"), { recursive: true });
  await chmod(packageRoot, 0o700);
  for (const path of [
    appRoot,
    join(appRoot, "Contents"),
    join(appRoot, "Contents/MacOS"),
    join(appRoot, "Contents/Resources"),
  ])
    await chmod(path, 0o755);
  const values = [
    ["Contents/Info.plist", Buffer.from("plist"), 0o644],
    [
      "Contents/MacOS/keiko-native-desktop",
      Buffer.from("cffaedfe0c000001", "hex"),
      0o755,
    ],
    ["Contents/Resources/THIRD-PARTY-NOTICES.json", Buffer.from("{}\n"), 0o644],
  ];
  const files = [];
  for (const [path, bytes, fileMode] of values) {
    await writeFile(join(appRoot, path), bytes, { mode: fileMode });
    files.push({
      bytes,
      mode: fileMode.toString(8).padStart(4, "0"),
      path,
      sha256: digest(bytes),
    });
  }
  const manifest = nativePackageTestSupport.packageManifest({
    files,
    policySha256: "d".repeat(64),
    revision,
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(packageRoot, "package-manifest.json"), manifestBytes, {
    mode: 0o600,
  });
  if (mode === "acceptance") {
    const evidence = nativePackageTestSupport.packagedShellEvidence({
      architecture: "arm64",
      cargoLockSha256: "e".repeat(64),
      lifecycle: {
        acknowledgementMs: 1,
        cleanupOwnedDescendants: 0,
        shutdownMs: 2,
      },
      npmLockSha256: "f".repeat(64),
      packageManifestSha256: digest(manifestBytes),
      revision,
      runner: "local-macos",
    });
    await writeFile(
      join(packageRoot, "acceptance-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  return files;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
