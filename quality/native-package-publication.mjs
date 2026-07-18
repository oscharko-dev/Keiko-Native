import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { evidenceFailures, redactionMatches } from "./native-contract.mjs";
import {
  CLOSED_FILE_MODES,
  CLOSED_PACKAGE_PATHS,
} from "./native-package-policy.mjs";

const MANIFEST = "package-manifest.json";
const EVIDENCE = "acceptance-evidence.json";
const APP = "Keiko Native.app";

export function publishValidatedPackage({
  beforePublish,
  cargoLockSha256,
  destinationPath,
  destinationRoot,
  mode,
  nativeFs,
  npmLockSha256,
  packageRoot,
  policySha256,
  revision,
}) {
  const expected = expectedEntries(mode);
  assertInventory(nativeFs.list(packageRoot), expected);
  const bound = bindEntries(packageRoot, expected);
  try {
    validatePackage(bound, {
      cargoLockSha256,
      mode,
      npmLockSha256,
      policySha256,
      revision,
    });
    beforePublish?.();
    nativeFs.publishBound(destinationRoot, destinationPath, bound);
    verifyBoundEntries(bound);
  } finally {
    for (const entry of bound) closeSync(entry.fd);
  }
}

function expectedEntries(mode) {
  if (!["package", "acceptance"].includes(mode))
    throw rejected("publication-mode");
  const files = CLOSED_PACKAGE_PATHS.map((path) => ({
    mode: CLOSED_FILE_MODES[path],
    path: `${APP}/${path}`,
    type: "F",
  }));
  files.push({ mode: "0600", path: MANIFEST, type: "F" });
  if (mode === "acceptance")
    files.push({ mode: "0600", path: EVIDENCE, type: "F" });
  const directories = new Set();
  for (const { path } of files) {
    let current = dirname(path);
    while (current !== ".") {
      directories.add(current);
      current = dirname(current);
    }
  }
  return [
    { mode: "0700", path: ".", type: "D" },
    ...[
      ...[...directories].map((path) => ({ mode: "0755", path, type: "D" })),
      ...files,
    ].toSorted((left, right) => left.path.localeCompare(right.path)),
  ];
}

function assertInventory(inventory, expected) {
  const reviewed = expected.filter(({ path }) => path !== ".");
  if (JSON.stringify(inventory) !== JSON.stringify(reviewed))
    throw rejected("package-inventory");
}

function bindEntries(packageRoot, expected) {
  const bound = [];
  try {
    for (const entry of expected) {
      const absolute =
        entry.path === "."
          ? packageRoot
          : join(packageRoot, ...entry.path.split("/"));
      const named = lstatSync(absolute, { bigint: true });
      const flags =
        constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (entry.type === "D" ? (constants.O_DIRECTORY ?? 0) : 0);
      const fd = openSync(absolute, flags);
      const metadata = fstatSync(fd, { bigint: true });
      bound.push({ ...entry, absolute, fd, metadata });
      if (
        (entry.type === "D" ? !metadata.isDirectory() : !metadata.isFile()) ||
        named.isSymbolicLink() ||
        !sameMetadata(named, metadata) ||
        octalMode(metadata) !== entry.mode
      )
        throw rejected("package-entry");
    }
    return bound;
  } catch (error) {
    for (const { fd } of bound) closeSync(fd);
    throw error;
  }
}

function validatePackage(
  bound,
  { cargoLockSha256, mode, npmLockSha256, policySha256, revision },
) {
  const files = new Map(
    bound
      .filter(({ type }) => type === "F")
      .map((entry) => [entry.path, readBound(entry)]),
  );
  const manifestBytes = files.get(MANIFEST);
  const manifest = parseJson(manifestBytes, "package-manifest");
  const expectedManifestKeys = [
    "inventory",
    "platform",
    "policySha256",
    "redaction",
    "schema",
    "sourceRevision",
    "target",
  ].toSorted();
  if (
    JSON.stringify(Object.keys(manifest).toSorted()) !==
      JSON.stringify(expectedManifestKeys) ||
    manifest.schema !== "keiko-native-package-manifest/v1" ||
    manifest.sourceRevision !== revision ||
    manifest.target !== "keiko-native-desktop" ||
    manifest.platform !== "macos-arm64" ||
    manifest.redaction !== "closed" ||
    !/^[0-9a-f]{64}$/u.test(policySha256 ?? "") ||
    manifest.policySha256 !== policySha256
  )
    throw rejected("package-manifest");
  const expectedInventory = CLOSED_PACKAGE_PATHS.map((path) => ({
    mode: CLOSED_FILE_MODES[path],
    path,
    sha256: digest(files.get(`${APP}/${path}`)),
  })).toSorted((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(manifest.inventory) !== JSON.stringify(expectedInventory))
    throw rejected("package-manifest-binding");
  if (redactionMatches(manifestBytes.toString("utf8")).length)
    throw rejected("package-manifest-redaction");
  if (mode === "acceptance") {
    const evidenceBytes = files.get(EVIDENCE);
    const evidence = parseJson(evidenceBytes, "acceptance-evidence");
    const failures = evidenceFailures(evidence, {
      cargoLockSha256,
      npmLockSha256,
      packageManifestSha256: digest(manifestBytes),
      readinessFingerprint:
        "da2459bd3becc6cbf651a24ef1b64d1b11a8ed642bfddc92923f0d6ed6dc8e5e",
      sourceRevision: revision,
    });
    if (redactionMatches(evidenceBytes.toString("utf8")).length)
      failures.push("evidence-redaction-match");
    if (failures.length) throw rejected("acceptance-evidence");
  }
}

function readBound(entry) {
  if (entry.metadata.size < 0n || entry.metadata.size > 64n * 1024n * 1024n)
    throw rejected("package-file-size");
  const bytes = Buffer.alloc(Number(entry.metadata.size));
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(
      entry.fd,
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (!count) throw rejected("package-file-read");
    offset += count;
  }
  if (!sameMetadata(entry.metadata, fstatSync(entry.fd, { bigint: true })))
    throw rejected("package-file-drift");
  return bytes;
}

function verifyBoundEntries(bound) {
  for (const entry of bound) {
    const descriptor = fstatSync(entry.fd, { bigint: true });
    const named = lstatSync(entry.absolute, { bigint: true });
    if (
      !sameMetadata(entry.metadata, descriptor) ||
      !sameMetadata(descriptor, named)
    )
      throw rejected("package-entry-drift");
  }
}

function sameMetadata(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function octalMode(metadata) {
  return (metadata.mode & 0o777n).toString(8).padStart(4, "0");
}

function parseJson(bytes, category) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw rejected(category);
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rejected(category) {
  return new Error(`Immutable snapshot rejected ${category}`);
}
