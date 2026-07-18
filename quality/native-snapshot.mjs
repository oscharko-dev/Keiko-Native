import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { captureDependencySnapshot } from "./native-dependencies.mjs";

const GENERATED = ["native/apps/keiko-desktop/gen", "native/frontend/dist"];

export async function runNativeSnapshot({ mode, repositoryRoot }) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "keiko-native-snapshot-"));
  await chmod(temporaryRoot, 0o700);
  const snapshotRoot = join(temporaryRoot, "repository");
  const dependencyRoot = join(temporaryRoot, "dependencies");
  const outputRoot = join(temporaryRoot, "output");
  const manifestPath = join(temporaryRoot, "manifest.json");
  try {
    await mkdir(dependencyRoot);
    const dependencies = await captureDependencySnapshot({
      frontendRoot: join(repositoryRoot, "native/frontend"),
      snapshotRoot: dependencyRoot,
      async writeFile(path, bytes) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes, { mode: 0o555 });
      },
    });
    const captured = captureRepository(repositoryRoot);
    await mkdir(snapshotRoot);
    await mkdir(outputRoot);
    materialize(repositoryRoot, snapshotRoot, captured.head, captured.entries);
    const files = [];
    for (const entry of captured.entries) {
      const bytes = await readFile(join(snapshotRoot, entry.path));
      files.push({
        path: entry.path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    await writeFile(
      manifestPath,
      `${JSON.stringify({ dependencies, files, head: captured.head, tree: captured.tree })}\n`,
      { mode: 0o600 },
    );
    const lockEntry = files.find(
      ({ path }) => path === "native/frontend/package-lock.json",
    );
    if (lockEntry?.sha256 !== dependencies.lockSha256)
      throw new Error("Immutable snapshot rejected dependency-lock-drift");
    await installFrontendDependencies(snapshotRoot, dependencyRoot);
    for (const path of GENERATED)
      await mkdir(join(snapshotRoot, path), { recursive: true });
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
      await rm(delivery, { force: true, recursive: true });
      await cp(join(outputRoot, "keiko-native-package"), delivery, {
        recursive: true,
      });
    }
    return 0;
  } finally {
    command("chmod", ["-R", "u+w", temporaryRoot]);
    await rm(temporaryRoot, { force: true, recursive: true });
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
      const match = /^(100644|100755) blob [0-9a-f]{40}\t([^\0]+)$/u.exec(
        record,
      );
      if (!match || invalidPath(match[2]))
        throw new Error("Immutable snapshot rejected tree-entry");
      return { mode: match[1], path: match[2] };
    });
  return { entries, head, tree };
}

function materialize(repositoryRoot, snapshotRoot, head, entries) {
  if (entries.length === 0)
    throw new Error("Immutable snapshot rejected empty-tree");
  const archive = command("git", ["archive", "--format=tar", head], {
    cwd: repositoryRoot,
    encoding: null,
  });
  if (archive.status !== 0 || archive.error)
    throw new Error("Immutable snapshot rejected archive");
  const extracted = command("tar", ["-xf", "-", "-C", snapshotRoot], {
    input: archive.stdout,
  });
  if (extracted.status !== 0 || extracted.error)
    throw new Error("Immutable snapshot rejected extraction");
}

async function installFrontendDependencies(snapshotRoot, dependencyRoot) {
  const destination = join(snapshotRoot, "native/frontend/node_modules");
  await cp(dependencyRoot, destination, { recursive: true });
  const bin = join(destination, ".bin");
  await mkdir(bin);
  for (const [name, target] of Object.entries({
    tauri: "../@tauri-apps/cli/tauri.js",
    tsc: "../typescript/bin/tsc",
    vite: "../vite/bin/vite.js",
    vitest: "../vitest/vitest.mjs",
  })) {
    await symlink(target, join(bin, name));
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
  const result = command("git", args, { cwd: repositoryRoot });
  if (result.status !== 0 || result.error)
    throw new Error("Immutable snapshot rejected git-read");
  return String(result.stdout);
}

function command(commandName, args, options = {}) {
  return spawnSync(commandName, args, {
    cwd: options.cwd,
    encoding: options.encoding === null ? null : "utf8",
    env: options.env ?? process.env,
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
