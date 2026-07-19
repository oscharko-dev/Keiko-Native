import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const maxJsonBytes = 4 * 1024 * 1024;
const maxPayloadFileBytes = 512 * 1024 * 1024;

export async function inventoryTree(
  root,
  { beforeFinalIdentity, filesystem } = {},
) {
  if (filesystem) return nativeInventory(root, filesystem);
  const inventory = await Promise.all(
    (await regularFiles(root)).map(async (path) => {
      const { bytes, status } = await readBoundRegularFile(
        path,
        maxPayloadFileBytes,
        beforeFinalIdentity,
      );
      return {
        mode: (status.mode & 0o777n).toString(8).padStart(4, "0"),
        path: relative(root, path).split("\\").join("/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      };
    }),
  );
  return inventory.toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function nativeInventory(root, filesystem) {
  return filesystem
    .list(root)
    .filter(({ type }) => type === "F")
    .map(({ mode, path }) => {
      const bytes = filesystem.read(root, path);
      return {
        mode,
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      };
    });
}

export function parseReleaseJson(bytes) {
  const text = decodeReleaseText(bytes, maxJsonBytes);
  if (hasDuplicateObjectKey(text))
    throw new Error("release-json-duplicate-rejected");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("release-json-syntax-rejected");
  }
  return value;
}

export function decodeReleaseText(bytes, maximum) {
  if (
    !(bytes instanceof Uint8Array) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    bytes.byteLength > maximum
  )
    throw new Error("release-json-size-rejected");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("release-json-encoding-rejected");
  }
}

export async function readReleaseJson(path) {
  return parseReleaseJson(
    (await readBoundRegularFile(path, maxJsonBytes)).bytes,
  );
}

export async function publishReleaseDirectory({
  outputRoot,
  staging,
  renameEntry = rename,
  removeEntry = rm,
}) {
  const backup = `${outputRoot}.previous`;
  await removeEntry(backup, { force: true, recursive: true });
  const prior = await movePriorOutput({ backup, outputRoot, renameEntry });
  try {
    await renameEntry(staging, outputRoot);
  } catch {
    await restorePriorOutput({ backup, outputRoot, prior, renameEntry });
    throw new Error("release-publish-failed");
  }
  if (prior) await removeEntry(backup, { force: true, recursive: true });
}

export async function ownedReleasePaths(repositoryRoot, filesystem) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0)
    throw new Error("release-owned-path-rejected");
  const root = resolve(repositoryRoot);
  const native = join(root, "native");
  const target = join(native, "target");
  const outputRoot = join(target, "keiko-native-internal-release");
  const staging = `${outputRoot}.staging`;
  const scratch = `${outputRoot}.verify`;
  await requireOwnedDirectories([root, native]);
  try {
    filesystem.mkdir(root, "native/target");
  } catch {
    throw new Error("release-owned-path-rejected");
  }
  await requireOwnedDirectories([target]);
  await rejectGeneratedPathAliases([
    outputRoot,
    staging,
    scratch,
    `${outputRoot}.previous`,
  ]);
  return { outputRoot, scratch, staging };
}

export async function readBoundRegularFile(path, maximum, beforeFinalIdentity) {
  let handle;
  try {
    const namedBefore = await lstat(path, { bigint: true });
    rejectInitialFile(namedBefore);
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    rejectOpenedFile(namedBefore, before, maximum);
    const bytes = await handle.readFile();
    await beforeFinalIdentity?.(path);
    await verifyFinalFile(path, before, bytes, handle);
    return { bytes, status: before };
  } finally {
    await handle?.close();
  }
}

export function mountedInventoryFailures(mounted, expected) {
  if (!Array.isArray(mounted) || !Array.isArray(expected))
    return ["release-mounted-inventory"];
  const content = (entries) =>
    entries.map(({ path, sha256, size }) => ({ path, sha256, size }));
  const executable = mounted.find(
    ({ path }) => path === "Contents/MacOS/keiko-native-desktop",
  );
  if (
    JSON.stringify(content(mounted)) !== JSON.stringify(content(expected)) ||
    mounted.some(invalidMountedMode) ||
    executable === undefined ||
    (parseInt(executable.mode, 8) & 0o111) === 0
  )
    return ["release-mounted-inventory"];
  return [];
}

export async function assertReadOnlyInventory(root, inventory) {
  for (const entry of inventory) {
    const path = join(root, ...entry.path.split("/"));
    let handle;
    try {
      handle = await open(
        path,
        constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) continue;
      throw new Error("release-mounted-readonly-rejected");
    }
    await handle.close();
    throw new Error("release-mounted-readonly-rejected");
  }
}

export function normalizeInventoryModes(root, inventory, filesystem) {
  for (const entry of inventory) {
    filesystem.chmod(root, entry.path, parseInt(entry.mode, 8));
  }
}

function invalidMountedMode({ mode }) {
  return !/^[0-7]{4}$/u.test(mode) || (parseInt(mode, 8) & 0o6000) !== 0;
}

async function movePriorOutput({ backup, outputRoot, renameEntry }) {
  try {
    await renameEntry(outputRoot, backup);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error("release-publish-prepare-failed");
  }
}

async function restorePriorOutput({ backup, outputRoot, prior, renameEntry }) {
  if (!prior) return;
  try {
    await renameEntry(backup, outputRoot);
  } catch {
    throw new Error("release-publish-rollback-failed");
  }
}

async function requireOwnedDirectories(paths) {
  for (const path of paths) {
    let status;
    try {
      status = await lstat(path);
    } catch {
      throw new Error("release-owned-path-rejected");
    }
    if (status.isSymbolicLink() || !status.isDirectory())
      throw new Error("release-owned-path-rejected");
  }
}

async function rejectGeneratedPathAliases(paths) {
  for (const path of paths) {
    try {
      const status = await lstat(path);
      if (status.isSymbolicLink() || !status.isDirectory())
        throw new Error("release-owned-path-rejected");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function regularFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      const status = await lstat(path);
      if (status.isSymbolicLink()) throw new Error("release-symlink-rejected");
      if (status.isDirectory()) await visit(path);
      else if (status.isFile()) files.push(path);
      else throw new Error("release-file-class-rejected");
    }
  }
  await visit(root);
  return files;
}

function rejectInitialFile(status) {
  if (status.isSymbolicLink() || !status.isFile())
    throw new Error("release-file-class-rejected");
}

function rejectOpenedFile(named, opened, maximum) {
  if (
    !opened.isFile() ||
    !sameFileIdentity(named, opened) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    opened.size < 0n ||
    opened.size > BigInt(maximum)
  )
    throw new Error("release-file-identity-rejected");
}

async function verifyFinalFile(path, before, bytes, handle) {
  const after = await handle.stat({ bigint: true });
  let namedAfter;
  try {
    namedAfter = await lstat(path, { bigint: true });
  } catch {
    throw new Error("release-file-drift-rejected");
  }
  if (
    !sameFileIdentity(before, after) ||
    !sameFileIdentity(after, namedAfter) ||
    BigInt(bytes.length) !== after.size
  )
    throw new Error("release-file-drift-rejected");
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function hasDuplicateObjectKey(text) {
  const stack = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      let escaped = false;
      for (index += 1; index < text.length; index += 1) {
        const current = text[index];
        if (!escaped && current === '"') break;
        escaped = !escaped && current === "\\";
        if (current !== "\\") escaped = false;
      }
      const context = stack.at(-1);
      if (context?.kind === "object" && context.expectKey) {
        let key;
        try {
          key = JSON.parse(text.slice(start, index + 1));
        } catch {
          continue;
        }
        if (context.keys.has(key)) return true;
        context.keys.add(key);
        context.expectKey = false;
      }
    } else if (character === "{" || character === "[") {
      if (stack.length >= 256) throw new Error("release-json-depth-rejected");
      stack.push(
        character === "{"
          ? { expectKey: true, keys: new Set(), kind: "object" }
          : { kind: "array" },
      );
    } else if (character === "}" || character === "]") stack.pop();
    else if (character === ",") {
      const context = stack.at(-1);
      if (context?.kind === "object") context.expectKey = true;
    }
  }
  return false;
}
