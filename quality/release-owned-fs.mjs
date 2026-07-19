import { relative } from "node:path";

export function requireReleaseFilesystem(filesystem) {
  if (
    ["copyTree", "list", "mkdir", "publish", "read", "remove", "write"].some(
      (operation) => typeof filesystem?.[operation] !== "function",
    )
  )
    throw new Error("release-filesystem-rejected");
}

export function ownedRelative(repositoryRoot, path) {
  const contained = relative(repositoryRoot, path).split("\\").join("/");
  if (!contained || contained.startsWith("../") || contained === "..")
    throw new Error("release-owned-path-rejected");
  return contained;
}

export function removeOwned(filesystem, repositoryRoot, path) {
  filesystem.remove(repositoryRoot, ownedRelative(repositoryRoot, path));
}
