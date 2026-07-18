import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { filesBelow } from "./native-files.mjs";
import { readOpenedRegular } from "./native-snapshot-runtime.mjs";

const ignoredLaunchers = new Set([".bin"]);
const cratesIoSource = "registry+https://github.com/rust-lang/crates.io-index";

export function createTargetVulnerabilityInventory(metadata) {
  if (
    !Array.isArray(metadata?.packages) ||
    !Array.isArray(metadata?.resolve?.nodes)
  )
    throw targetInventoryRejected("metadata-shape");
  const packages = new Map(
    metadata.packages.map((entry) => [entry?.id, entry]),
  );
  const nodeIds = new Set(metadata.resolve.nodes.map(({ id }) => id));
  if (nodeIds.size === 0 || nodeIds.has(undefined))
    throw targetInventoryRejected("resolve-shape");
  for (const node of metadata.resolve.nodes) {
    if (!packages.has(node.id) || !Array.isArray(node.dependencies))
      throw targetInventoryRejected("resolve-package");
    if (node.dependencies.some((dependency) => !nodeIds.has(dependency)))
      throw targetInventoryRejected("resolve-edge");
  }
  const inventory = metadata.resolve.nodes
    .map(({ id }) => packages.get(id))
    .filter(({ source }) => source !== null)
    .map(({ name, source, version }) => {
      if (
        source !== cratesIoSource ||
        typeof name !== "string" ||
        !name ||
        typeof version !== "string" ||
        !version
      )
        throw targetInventoryRejected("package-source");
      return {
        package: { ecosystem: "crates.io", name, version },
      };
    })
    .toSorted((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  if (inventory.length === 0) throw targetInventoryRejected("empty-resolve");
  return {
    results: [
      {
        packages: inventory,
        source: {
          path: "native/Cargo.lock#aarch64-apple-darwin",
          type: "lockfile",
        },
      },
    ],
  };
}

export function evaluateVulnerabilityResults(report) {
  if (!object(report) || !Array.isArray(report.results))
    throw vulnerabilityPolicyRejected("report-shape");
  const summary = { blocking: 0, informationalUnmaintained: 0, low: 0 };
  for (const result of report.results) {
    if (
      !validVulnerabilitySource(result?.source) ||
      !Array.isArray(result?.packages)
    )
      throw vulnerabilityPolicyRejected("result-shape");
    for (const entry of result.packages) {
      if (!validVulnerablePackage(entry?.package))
        throw vulnerabilityPolicyRejected("package-shape");
      if (!Array.isArray(entry.groups) || !Array.isArray(entry.vulnerabilities))
        throw vulnerabilityPolicyRejected("finding-shape");
      if (entry.groups.length === 0 || entry.vulnerabilities.length === 0)
        throw vulnerabilityPolicyRejected("empty-finding");
      const classifications = entry.vulnerabilities.map((vulnerability) =>
        informationalUnmaintained(vulnerability, entry.package),
      );
      if (classifications.some(Boolean) && !classifications.every(Boolean))
        throw vulnerabilityPolicyRejected("mixed-finding");
      if (classifications.every(Boolean)) {
        if (entry.groups.some((group) => !validInformationalGroup(group)))
          throw vulnerabilityPolicyRejected("informational-severity");
        summary.informationalUnmaintained += entry.vulnerabilities.length;
        continue;
      }
      for (const group of entry.groups) {
        const score = severityScore(group);
        if (score >= 4) summary.blocking += 1;
        else summary.low += 1;
      }
    }
  }
  if (summary.blocking > 0)
    throw vulnerabilityPolicyRejected("moderate-or-higher");
  return summary;
}

function validVulnerabilitySource(source) {
  if (source?.type !== "lockfile" || typeof source.path !== "string")
    return false;
  const path = source.path.replaceAll("\\", "/");
  return [
    "/package-lock.json",
    "/native/frontend/package-lock.json",
    "/native/target/osv/native-macos-arm64.osv-scanner.json",
  ].some((suffix) => path === suffix.slice(1) || path.endsWith(suffix));
}

function validVulnerablePackage(value) {
  return (
    object(value) &&
    typeof value.ecosystem === "string" &&
    value.ecosystem.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.version === "string" &&
    value.version.length > 0
  );
}

function severityScore(group) {
  if (
    !object(group) ||
    !Array.isArray(group.ids) ||
    group.ids.length === 0 ||
    !Array.isArray(group.aliases) ||
    typeof group.max_severity !== "string" ||
    !/^(?:0|[1-9]|10)(?:\.\d+)?$/u.test(group.max_severity)
  )
    throw vulnerabilityPolicyRejected("severity-shape");
  const score = Number(group.max_severity);
  if (!Number.isFinite(score) || score < 0 || score > 10)
    throw vulnerabilityPolicyRejected("severity-range");
  return score;
}

function validInformationalGroup(group) {
  return (
    object(group) &&
    Array.isArray(group.ids) &&
    group.ids.length > 0 &&
    group.ids.every((id) => /^RUSTSEC-\d{4}-\d{4}$/u.test(id)) &&
    Array.isArray(group.aliases) &&
    group.aliases.every((id) => /^RUSTSEC-\d{4}-\d{4}$/u.test(id)) &&
    group.max_severity === ""
  );
}

function informationalUnmaintained(vulnerability, packageIdentity) {
  if (
    !object(vulnerability) ||
    !/^RUSTSEC-\d{4}-\d{4}$/u.test(vulnerability.id ?? "") ||
    vulnerability.schema_version !== "1.7.3" ||
    !Array.isArray(vulnerability.affected) ||
    vulnerability.affected.length === 0
  )
    throw vulnerabilityPolicyRejected("advisory-shape");
  let informational = true;
  for (const affected of vulnerability.affected) {
    const classification = affected?.database_specific;
    const affectedPackage = affected?.package;
    if (
      classification?.informational !== "unmaintained" ||
      classification?.cvss !== null ||
      !Array.isArray(classification?.categories) ||
      classification.categories.length !== 0 ||
      classification.source !==
        `https://github.com/rustsec/advisory-db/blob/osv/crates/${vulnerability.id}.json`
    )
      informational = false;
    if (
      affectedPackage?.ecosystem !== packageIdentity.ecosystem ||
      affectedPackage?.name !== packageIdentity.name ||
      !Array.isArray(affected.ranges) ||
      affected.ranges.length === 0
    )
      throw vulnerabilityPolicyRejected("affected-shape");
    for (const range of affected.ranges) {
      if (range?.type !== "SEMVER" || !Array.isArray(range.events))
        throw vulnerabilityPolicyRejected("range-shape");
      if (
        range.events.some(
          (event) =>
            !object(event) ||
            Object.keys(event).some((key) => key !== "introduced"),
        )
      )
        throw vulnerabilityPolicyRejected("informational-patch");
    }
  }
  return informational;
}

export async function captureDependencySnapshot({
  frontendRoot,
  listFiles = (root) => filesBelow(root, ignoredLaunchers, root),
  listTopLevel = async (root) =>
    (await readdir(root, { withFileTypes: true })).map(({ name }) => name),
  readRegular = readOpenedRegular,
  snapshotRoot,
  sourceRoot = join(frontendRoot, "node_modules"),
  writeFile,
}) {
  const lockBytes = await readRegular(
    join(frontendRoot, "package-lock.json"),
    frontendRoot,
  );
  const paths = await listFiles(sourceRoot);
  const relativePaths = paths.map((path) =>
    portable(relative(sourceRoot, path)),
  );
  const markerPath = ".package-lock.json";
  if (!relativePaths.includes(markerPath))
    throw rejected("missing-npm-ci-marker");

  const lock = parseJson(lockBytes, "dependency-lock");
  const markerSource = paths[relativePaths.indexOf(markerPath)];
  const markerBytes = await readRegular(markerSource, sourceRoot);
  const marker = parseJson(markerBytes, "npm-ci-marker");
  const roots = validateInventory(lock, marker, relativePaths);
  await validateTopLevel(sourceRoot, roots, listTopLevel);
  const contents = [];
  for (const [index, source] of paths.entries())
    contents.push(
      source === markerSource
        ? markerBytes
        : await readRegular(source, sourceRoot),
    );
  validatePackageIdentities(marker, relativePaths, contents);

  const files = [];
  for (const [index, source] of paths.entries()) {
    const bytes = contents[index];
    const path = relativePaths[index];
    if (writeFile) {
      const destination = join(snapshotRoot, ...path.split("/"));
      await writeFile(destination, bytes);
    }
    files.push({ path, sha256: digest(bytes) });
  }
  const lockSha256 = digest(lockBytes);
  const markerSha256 = digest(markerBytes);
  const treeSha256 = digest(
    Buffer.from(JSON.stringify({ files, lockSha256, markerSha256 })),
  );
  return { files, lockSha256, markerSha256, treeSha256 };
}

async function validateTopLevel(sourceRoot, roots, listTopLevel) {
  const allowed = new Set([".bin", ".package-lock.json"]);
  for (const root of roots)
    allowed.add(root.startsWith("@") ? root.split("/")[0] : root);
  for (const name of await listTopLevel(sourceRoot))
    if (!allowed.has(name)) throw rejected("unexpected-top-level");
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

function targetInventoryRejected(category) {
  return new Error(`Target dependency inventory rejected ${category}`);
}

function vulnerabilityPolicyRejected(category) {
  return new Error(`Vulnerability policy rejected ${category}`);
}
