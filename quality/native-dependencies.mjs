import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { filesBelow } from "./native-files.mjs";
import { readOpenedRegular } from "./native-snapshot-runtime.mjs";

const ignoredLaunchers = new Set([".bin"]);

export async function captureDependencySnapshot({
  frontendRoot,
  snapshotRoot,
  writeFile,
}) {
  const sourceRoot = join(frontendRoot, "node_modules");
  const lockBytes = await readOpenedRegular(
    join(frontendRoot, "package-lock.json"),
    frontendRoot,
  );
  const paths = await filesBelow(sourceRoot, ignoredLaunchers, sourceRoot);
  const relativePaths = paths.map((path) =>
    portable(relative(sourceRoot, path)),
  );
  const markerPath = ".package-lock.json";
  if (!relativePaths.includes(markerPath))
    throw rejected("missing-npm-ci-marker");

  const lock = parseJson(lockBytes, "dependency-lock");
  const markerSource = paths[relativePaths.indexOf(markerPath)];
  const markerBytes = await readOpenedRegular(markerSource, sourceRoot);
  const marker = parseJson(markerBytes, "npm-ci-marker");
  const roots = validateInventory(lock, marker, relativePaths);
  await validateTopLevel(sourceRoot, roots);
  const contents = [];
  for (const [index, source] of paths.entries())
    contents.push(
      source === markerSource
        ? markerBytes
        : await readOpenedRegular(source, sourceRoot),
    );
  validatePackageIdentities(marker, relativePaths, contents);

  const files = [];
  for (const [index, source] of paths.entries()) {
    const bytes = contents[index];
    const path = relativePaths[index];
    const destination = join(snapshotRoot, ...path.split("/"));
    await writeFile(destination, bytes);
    files.push({ path, sha256: digest(bytes) });
  }
  const lockSha256 = digest(lockBytes);
  const markerSha256 = digest(markerBytes);
  const treeSha256 = digest(
    Buffer.from(JSON.stringify({ files, lockSha256, markerSha256 })),
  );
  return { files, lockSha256, markerSha256, treeSha256 };
}

function validatePackageIdentities(marker, paths, contents) {
  for (const [path, expected] of Object.entries(marker.packages)) {
    const root = path.slice("node_modules/".length);
    const packageJson = `${root}/package.json`;
    const index = paths.indexOf(packageJson);
    if (index === -1) throw rejected("package-inventory");
    const actual = parseJson(contents[index], "package-json");
    const expectedName = expected.name ?? root;
    if (actual.name !== expectedName || actual.version !== expected.version)
      throw rejected("package-identity");
  }
}

function validateInventory(lock, marker, paths) {
  if (lock?.lockfileVersion !== 3 || marker?.lockfileVersion !== 3)
    throw rejected("lock-version");
  const locked = lock.packages;
  const installed = marker.packages;
  if (!object(locked) || !object(installed)) throw rejected("lock-shape");
  const roots = [];
  for (const path of Object.keys(installed).toSorted()) {
    if (!path.startsWith("node_modules/") || !object(installed[path]))
      throw rejected("marker-inventory");
    if (JSON.stringify(installed[path]) !== JSON.stringify(locked[path]))
      throw rejected("lock-marker-mismatch");
    const root = path.slice("node_modules/".length);
    if (!packageRoot(root)) throw rejected("marker-inventory");
    roots.push(root);
  }
  if (roots.length === 0) throw rejected("empty-inventory");
  const actualRoots = paths
    .filter((path) => /^(?:@[^/]+\/)?[^/]+\/package\.json$/u.test(path))
    .map((path) => dirname(path))
    .toSorted();
  if (JSON.stringify(actualRoots) !== JSON.stringify(roots))
    throw rejected("package-inventory");
  for (const path of paths) {
    if (
      path !== ".package-lock.json" &&
      !roots.some((root) => path.startsWith(`${root}/`))
    )
      throw rejected("unexpected-entry");
  }
  return roots;
}

async function validateTopLevel(sourceRoot, roots) {
  const allowed = new Set([".bin", ".package-lock.json"]);
  for (const root of roots)
    allowed.add(root.startsWith("@") ? root.split("/")[0] : root);
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (!allowed.has(entry.name)) throw rejected("unexpected-top-level");
  }
}

function parseJson(bytes, category) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw rejected(category);
  }
}

function packageRoot(path) {
  return /^(?:@[^/]+\/)?[^/]+$/u.test(path) && !path.split("/").includes("..");
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function portable(path) {
  return path.split(sep).join("/");
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rejected(category) {
  return new Error(`Immutable snapshot rejected dependency-${category}`);
}
