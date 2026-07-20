import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  hardenedGitArguments,
  noReplaceGitEnvironment,
} from "./git-integrity.mjs";

import { captureDependencySnapshot } from "./native-dependencies.mjs";
import { compileNativeFsHelper, NATIVE_FS_SOURCES } from "./native-fs.mjs";
import { publishValidatedPackage } from "./native-package-publication.mjs";

const GENERATED = [
  "native/apps/keiko-desktop/gen",
  "native/frontend/coverage",
  "native/frontend/dist",
];

export async function runNativeSnapshot({ mode, repositoryRoot }) {
  const suppliedRepositoryRoot = repositoryRoot;
  const metadata = await lstat(suppliedRepositoryRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("Immutable snapshot rejected repository-root");
  repositoryRoot = await realpath(suppliedRepositoryRoot);
  if (
    repositoryRoot !== suppliedRepositoryRoot &&
    repositoryRoot !== `/private${suppliedRepositoryRoot}`
  ) {
    throw new Error("Immutable snapshot rejected repository-root-alias");
  }
  const createdRoot = await mkdtemp(join(tmpdir(), "keiko-native-snapshot-"));
  const temporaryRoot = await realpath(createdRoot);
  await chmod(temporaryRoot, 0o700);
  const snapshotRoot = join(temporaryRoot, "repository");
  const dependencyRoot = join(temporaryRoot, "dependencies");
  const outputRoot = join(temporaryRoot, "output");
  const manifestPath = join(temporaryRoot, "manifest.json");
  try {
    const captured = captureRepository(repositoryRoot);
    await mkdir(snapshotRoot);
    await mkdir(dependencyRoot);
    await mkdir(outputRoot);
    materialize(repositoryRoot, snapshotRoot, captured.head, captured.entries);
    const files = [];
    for (const entry of captured.entries) {
      const bytes = await readFile(join(snapshotRoot, entry.path));
      files.push({
        blob: entry.blob,
        path: entry.path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const helperPath = join(temporaryRoot, "native-fs-helper");
    const nativeFs = compileNativeFsHelper({
      expectedSources: NATIVE_FS_SOURCES.map((path) =>
        files.find((entry) => entry.path === path),
      ),
      outputPath: helperPath,
      snapshotRoot,
      tree: captured.tree,
    });
    const sourceModules = join(repositoryRoot, "native/frontend/node_modules");
    nativeFs.copyTree(sourceModules, ".", dependencyRoot, ".", ".bin");
    const dependencyInventory = nativeFs.list(dependencyRoot);
    const dependencies = await captureDependencySnapshot({
      frontendRoot: join(snapshotRoot, "native/frontend"),
      listFiles: () =>
        dependencyInventory
          .filter(({ type }) => type === "F")
          .map(({ path }) => join(dependencyRoot, ...path.split("/"))),
      listTopLevel: () => [
        ...new Set(dependencyInventory.map(({ path }) => path.split("/")[0])),
      ],
      readRegular(path, root) {
        return nativeFs.read(root, relative(root, path));
      },
      snapshotRoot: dependencyRoot,
      sourceRoot: dependencyRoot,
    });
    nativeFs.write(
      temporaryRoot,
      "manifest.json",
      `${JSON.stringify({ dependencies, files, head: captured.head, tree: captured.tree })}\n`,
      0o600,
    );
    const lockEntry = files.find(
      ({ path }) => path === "native/frontend/package-lock.json",
    );
    if (lockEntry?.sha256 !== dependencies.lockSha256)
      throw new Error("Immutable snapshot rejected dependency-lock-drift");
    installFrontendDependencies(nativeFs, snapshotRoot, dependencyRoot);
    for (const path of GENERATED) nativeFs.mkdir(snapshotRoot, path);
    if (process.platform !== "win32") protectInputs(snapshotRoot);
    const result = command(
      process.execPath,
      [join(snapshotRoot, "quality/native-gate.mjs"), mode],
      {
        cwd: snapshotRoot,
        env: {
          ...process.env,
          CARGO_TARGET_DIR: join(outputRoot, "cargo-target"),
          KEIKO_NATIVE_OUTPUT_ROOT: outputRoot,
          KEIKO_NATIVE_FS_HELPER: helperPath,
          KEIKO_NATIVE_SNAPSHOT_MANIFEST: manifestPath,
          KEIKO_NATIVE_SOURCE_REVISION: captured.head,
        },
      },
    );
    if (result.stdout)
      process.stdout.write(
        String(result.stdout).replaceAll(temporaryRoot, "<snapshot>"),
      );
    if (result.stderr)
      process.stderr.write(
        String(result.stderr).replaceAll(temporaryRoot, "<snapshot>"),
      );
    assertRepository(repositoryRoot, captured);
    if (result.status !== 0 || result.error) return result.status ?? 1;
    if (["acceptance", "package"].includes(mode)) {
      const delivery = join(
        repositoryRoot,
        "native/target/keiko-native-package",
      );
      publishValidatedPackage({
        cargoLockSha256: files.find(({ path }) => path === "native/Cargo.lock")
          ?.sha256,
        destinationPath: relative(repositoryRoot, delivery),
        destinationRoot: repositoryRoot,
        mode,
        nativeFs,
        npmLockSha256: files.find(
          ({ path }) => path === "native/frontend/package-lock.json",
        )?.sha256,
        packageRoot: join(outputRoot, "keiko-native-package"),
        policySha256: files.find(
          ({ path }) => path === "native/package-policy.json",
        )?.sha256,
        revision: captured.head,
      });
    }
    return 0;
  } finally {
    command("chmod", ["-R", "u+w", temporaryRoot]);
    await rm(createdRoot, { force: true, recursive: true });
  }
}

function captureRepository(repositoryRoot) {
  const head = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  const tree = git(repositoryRoot, ["rev-parse", `${head}^{tree}`]).trim();
  const status = git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (!/^[0-9a-f]{40}$/u.test(head) || !/^[0-9a-f]{40}$/u.test(tree) || status)
    throw new Error("Immutable snapshot rejected repository-state");
  const encoded = git(repositoryRoot, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    head,
  ]);
  const entries = encoded
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)$/u.exec(
        record,
      );
      if (!match || invalidPath(match[3]))
        throw new Error("Immutable snapshot rejected tree-entry");
      return { blob: match[2], mode: match[1], path: match[3] };
    });
  return { entries, head, tree };
}

function materialize(repositoryRoot, snapshotRoot, head, entries) {
  if (entries.length === 0)
    throw new Error("Immutable snapshot rejected empty-tree");
  const archive = command(
    "git",
    hardenedGitArguments(["archive", "--format=tar", head]),
    {
      cwd: repositoryRoot,
      encoding: null,
    },
  );
  if (archive.status !== 0 || archive.error)
    throw new Error("Immutable snapshot rejected archive");
  const extracted = command("tar", ["-xf", "-", "-C", snapshotRoot], {
    input: archive.stdout,
  });
  if (extracted.status !== 0 || extracted.error)
    throw new Error("Immutable snapshot rejected extraction");
}

function installFrontendDependencies(nativeFs, snapshotRoot, dependencyRoot) {
  nativeFs.copyTree(
    dependencyRoot,
    ".",
    join(snapshotRoot, "native/frontend"),
    "node_modules",
  );
  nativeFs.mkdir(snapshotRoot, "native/frontend/node_modules/.bin");
  for (const [name, target] of Object.entries({
    tauri: "../@tauri-apps/cli/tauri.js",
    tsc: "../typescript/bin/tsc",
    vite: "../vite/bin/vite.js",
    vitest: "../vitest/vitest.mjs",
  })) {
    nativeFs.symlink(
      snapshotRoot,
      `native/frontend/node_modules/.bin/${name}`,
      target,
    );
  }
}

function protectInputs(snapshotRoot) {
  let result = command("chmod", ["-R", "a-w", snapshotRoot]);
  if (result.status !== 0)
    throw new Error("Immutable snapshot rejected input-protection");
  for (const path of GENERATED) {
    result = command("chmod", ["-R", "u+w", join(snapshotRoot, path)]);
    if (result.status !== 0)
      throw new Error("Immutable snapshot rejected output-protection");
  }
}

function assertRepository(repositoryRoot, captured) {
  const current = captureRepository(repositoryRoot);
  if (current.head !== captured.head || current.tree !== captured.tree)
    throw new Error("Immutable snapshot rejected repository-changed");
}

function git(repositoryRoot, args) {
  const result = command("git", hardenedGitArguments(args), {
    cwd: repositoryRoot,
  });
  if (result.status !== 0 || result.error)
    throw new Error("Immutable snapshot rejected git-read");
  return String(result.stdout);
}

function command(commandName, args, options = {}) {
  return spawnSync(commandName, args, {
    cwd: options.cwd,
    encoding: options.encoding === null ? null : "utf8",
    env: noReplaceGitEnvironment(options.env ?? process.env),
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: "pipe",
  });
}

function invalidPath(path) {
  return (
    path.startsWith("/") ||
    path.split(/[\\/]/u).some((part) => part === "" || part === "..")
  );
}

export const nativeSnapshotTestSupport = { captureRepository, materialize };
