import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function filesBelow(root, ignored = new Set()) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path, ignored)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function mergeNativeInspectionPaths(ephemeral, tracked) {
  return [...new Set([...ephemeral, ...tracked])].toSorted();
}
