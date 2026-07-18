import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export async function filesBelow(
  root,
  ignored = new Set(),
  traversalRoot = root,
) {
  if (root === traversalRoot) await requireDirectory(root, traversalRoot);
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink())
      throw unsupportedEntry("symbolic-link", traversalRoot, path);
    if (entry.isDirectory())
      files.push(...(await filesBelow(path, ignored, traversalRoot)));
    else if (entry.isFile()) files.push(path);
    else throw unsupportedEntry("special-entry", traversalRoot, path);
  }
  return files.toSorted();
}

export async function trackedFiles(encoded, repositoryRoot, nativeRoot) {
  const files = [];
  for (const record of encoded.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) [0-9a-f]{40,64} [0-3]\t([\s\S]+)$/u.exec(record);
    if (match === null)
      throw unsupportedEntry("tracked-metadata", nativeRoot, nativeRoot);
    const [, mode, repositoryPath] = match;
    if (mode === "120000")
      throw unsupportedEntry("tracked-symbolic-link", nativeRoot, nativeRoot);
    if (!new Set(["100644", "100755"]).has(mode))
      throw unsupportedEntry("tracked-special-entry", nativeRoot, nativeRoot);
    const path = join(repositoryRoot, repositoryPath);
    const nativePath = relative(nativeRoot, path);
    if (
      nativePath === "" ||
      nativePath.startsWith(`..${separator()}`) ||
      isAbsolute(nativePath)
    )
      throw unsupportedEntry("tracked-escape", nativeRoot, path);
    await requireRegularPath(nativeRoot, nativePath);
    files.push(path);
  }
  return [...new Set(files)].toSorted();
}

async function requireDirectory(path, traversalRoot) {
  const entry = await safeLstat(path, traversalRoot);
  if (entry.isSymbolicLink())
    throw unsupportedEntry("symbolic-link", traversalRoot, path);
  if (!entry.isDirectory())
    throw unsupportedEntry("special-entry", traversalRoot, path);
}

async function requireRegularPath(root, nativePath) {
  let current = root;
  const parts = nativePath.split(/[\\/]/u).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const entry = await safeLstat(current, root);
    if (entry.isSymbolicLink())
      throw unsupportedEntry("symbolic-link", root, current);
    const final = index === parts.length - 1;
    if ((!final && !entry.isDirectory()) || (final && !entry.isFile()))
      throw unsupportedEntry("special-entry", root, current);
  }
}

async function safeLstat(path, traversalRoot) {
  try {
    return await lstat(path);
  } catch {
    throw unsupportedEntry("missing-entry", traversalRoot, path);
  }
}

function separator() {
  return process.platform === "win32" ? "\\" : "/";
}

function unsupportedEntry(category, traversalRoot, path) {
  const depth = Math.min(
    relative(traversalRoot, path).split(/[\\/]/u).filter(Boolean).length,
    64,
  );
  return new Error(
    `Native traversal rejected ${category} at <redacted-path> depth:${depth}`,
  );
}

export function mergeNativeInspectionPaths(ephemeral, tracked) {
  return [...new Set([...ephemeral, ...tracked])].toSorted();
}
