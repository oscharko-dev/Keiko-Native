import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export async function filesBelow(
  root,
  ignored = new Set(),
  traversalRoot = root,
) {
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
