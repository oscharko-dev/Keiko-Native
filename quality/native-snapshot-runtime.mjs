import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

let cachedManifest;

async function manifest() {
  if (cachedManifest !== undefined) return cachedManifest;
  const path = process.env.KEIKO_NATIVE_SNAPSHOT_MANIFEST;
  if (!path) return undefined;
  cachedManifest = JSON.parse(await readFile(path, "utf8"));
  return cachedManifest;
}

export function inExactSnapshot() {
  return Boolean(process.env.KEIKO_NATIVE_SNAPSHOT_MANIFEST);
}

export async function snapshotPaths(repositoryRoot, prefix = "") {
  const value = await manifest();
  if (!value) return undefined;
  const normalized = prefix.replaceAll("\\", "/").replace(/\/$/u, "");
  return value.files
    .map(({ path }) => path)
    .filter((path) => normalized === "" || path.startsWith(`${normalized}/`))
    .map((path) => `${repositoryRoot}${sep}${path.split("/").join(sep)}`);
}

export async function readSnapshotInput(path, repositoryRoot, encoding) {
  const value = await manifest();
  if (!value) return readFile(path, encoding);
  const repositoryPath = relative(repositoryRoot, path).split(sep).join("/");
  if (
    repositoryPath.startsWith("../") ||
    isAbsolute(repositoryPath) ||
    !value.files.some((entry) => entry.path === repositoryPath)
  ) {
    throw new Error("Immutable snapshot rejected undeclared-input");
  }
  const bytes = await readOpenedRegular(path);
  const expected = value.files.find((entry) => entry.path === repositoryPath);
  if (digest(bytes) !== expected.sha256)
    throw new Error("Immutable snapshot rejected input-drift");
  return encoding ? bytes.toString(encoding) : bytes;
}

export async function readOpenedRegular(path, containmentRoot = dirname(path)) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new Error("Immutable snapshot rejected non-regular-output");
    const contained = relative(containmentRoot, path);
    if (contained.startsWith(`..${sep}`) || isAbsolute(contained))
      throw new Error("Immutable snapshot rejected output-escape");
    let parent = containmentRoot;
    for (const component of dirname(contained)
      .split(/[\\/]/u)
      .filter(Boolean)) {
      parent = join(parent, component);
      const entry = await lstat(parent);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("Immutable snapshot rejected output-parent");
    }
    return await handle.readFile();
  } catch (error) {
    if (error?.message?.startsWith("Immutable snapshot rejected")) throw error;
    throw new Error("Immutable snapshot rejected unavailable-file");
  } finally {
    await handle?.close();
  }
}

export async function createSnapshotGuard(repositoryRoot) {
  const value = await manifest();
  if (!value) return undefined;
  return {
    expectedHead: value.head,
    async assertUnchanged(stage) {
      for (const entry of value.files) {
        await readSnapshotInput(
          `${repositoryRoot}${sep}${entry.path.split("/").join(sep)}`,
          repositoryRoot,
        );
      }
      if (!stage) throw new Error("Immutable snapshot rejected missing-stage");
    },
  };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export const nativeSnapshotRuntimeTestSupport = {
  reset() {
    cachedManifest = undefined;
  },
};
