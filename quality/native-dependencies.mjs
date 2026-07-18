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
      const findingBindings = validateFindingBindings(
        entry.groups,
        entry.vulnerabilities,
      );
      const classifications = entry.vulnerabilities.map((vulnerability) =>
        vulnerabilityClassification(
          vulnerability,
          entry.package,
          findingBindings.get(vulnerability.id),
        ),
      );
      if (
        classifications.includes("informational-unmaintained") &&
        classifications.includes("scored")
      )
        throw vulnerabilityPolicyRejected("mixed-finding");
      if (
        classifications.every((value) => value === "informational-unmaintained")
      ) {
        if (!validInformationalBindings(entry.groups, entry.vulnerabilities))
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
    ["crates.io", "npm"].includes(value.ecosystem) &&
    typeof value.name === "string" &&
    validPackageName(value.ecosystem, value.name) &&
    typeof value.version === "string" &&
    value.version.length > 0 &&
    !/[\s\u0000-\u001f\u007f]/u.test(value.version)
  );
}

function validPackageName(ecosystem, name) {
  if (ecosystem === "crates.io")
    return /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name);
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(name);
}

function validateFindingBindings(groups, vulnerabilities) {
  const vulnerabilityIds = new Set();
  for (const vulnerability of vulnerabilities) {
    if (!object(vulnerability) || !validAdvisoryId(vulnerability.id))
      throw vulnerabilityPolicyRejected("advisory-identity");
    if (vulnerabilityIds.has(vulnerability.id))
      throw vulnerabilityPolicyRejected("duplicate-advisory");
    vulnerabilityIds.add(vulnerability.id);
  }
  const boundIds = new Set();
  const aliases = new Set();
  const bindings = new Map();
  for (const group of groups) {
    if (
      !object(group) ||
      Object.keys(group).toSorted().join(",") !== "aliases,ids,max_severity" ||
      !validIdList(group.ids, false) ||
      !validIdList(group.aliases, true)
    )
      throw vulnerabilityPolicyRejected("group-shape");
    for (const id of group.ids) {
      if (!vulnerabilityIds.has(id) || boundIds.has(id))
        throw vulnerabilityPolicyRejected("group-advisory-binding");
      boundIds.add(id);
      bindings.set(id, group);
    }
    for (const alias of group.aliases) {
      if (aliases.has(alias))
        throw vulnerabilityPolicyRejected("duplicate-alias");
      aliases.add(alias);
    }
  }
  if (boundIds.size !== vulnerabilityIds.size)
    throw vulnerabilityPolicyRejected("unbound-advisory");
  return bindings;
}

function validIdList(values, allowEmpty) {
  return (
    Array.isArray(values) &&
    (allowEmpty || values.length > 0) &&
    new Set(values).size === values.length &&
    values.every(validAdvisoryId)
  );
}

function validAdvisoryId(value) {
  return (
    typeof value === "string" &&
    /^(?:RUSTSEC-\d{4}-\d{4}|CVE-\d{4}-\d{4,}|GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})$/u.test(
      value,
    )
  );
}

function severityScore(group) {
  if (
    typeof group.max_severity !== "string" ||
    !/^(?:0|[1-9]|10)(?:\.\d+)?$/u.test(group.max_severity)
  )
    throw vulnerabilityPolicyRejected("severity-shape");
  const score = Number(group.max_severity);
  if (!Number.isFinite(score) || score < 0 || score > 10)
    throw vulnerabilityPolicyRejected("severity-range");
  return score;
}

function validInformationalBindings(groups, vulnerabilities) {
  if (groups.length !== vulnerabilities.length) return false;
  const groupsById = new Map(groups.map((group) => [group.ids[0], group]));
  if (groupsById.size !== groups.length) return false;
  return vulnerabilities.every(({ id }) => {
    const group = groupsById.get(id);
    return (
      /^RUSTSEC-\d{4}-\d{4}$/u.test(id) &&
      group?.ids.length === 1 &&
      group.ids[0] === id &&
      group.aliases.length === 1 &&
      group.aliases[0] === id &&
      group.max_severity === ""
    );
  });
}

function vulnerabilityClassification(vulnerability, packageIdentity, group) {
  if (
    !Array.isArray(vulnerability.affected) ||
    vulnerability.affected.length === 0
  )
    throw vulnerabilityPolicyRejected("advisory-shape");
  const classifications = [];
  for (const affected of vulnerability.affected) {
    validateAffectedPackage(affected, packageIdentity);
    const informational = affected.database_specific?.informational;
    if (informational !== undefined && informational !== "unmaintained")
      throw vulnerabilityPolicyRejected("informational-classification");
    classifications.push(
      informational === "unmaintained"
        ? "informational-unmaintained"
        : "scored",
    );
  }
  if (new Set(classifications).size !== 1)
    throw vulnerabilityPolicyRejected("mixed-advisory");
  const classification = classifications[0];
  if (classification === "informational-unmaintained")
    validateInformationalAdvisory(vulnerability, packageIdentity);
  else validateScoredAdvisory(vulnerability, group);
  return classification;
}

function validateAffectedPackage(affected, packageIdentity) {
  if (
    !object(affected) ||
    !object(affected.package) ||
    affected.package.ecosystem !== packageIdentity.ecosystem ||
    affected.package.name !== packageIdentity.name ||
    typeof affected.package.purl !== "string" ||
    !validPurl(affected.package.purl, packageIdentity) ||
    !Array.isArray(affected.ranges) ||
    affected.ranges.length === 0
  )
    throw vulnerabilityPolicyRejected("affected-shape");
}

function validPurl(purl, packageIdentity) {
  const prefix =
    packageIdentity.ecosystem === "crates.io" ? "pkg:cargo/" : "pkg:npm/";
  if (!purl.startsWith(prefix) || /[?#]/u.test(purl)) return false;
  try {
    return (
      decodeURIComponent(purl.slice(prefix.length)) === packageIdentity.name
    );
  } catch {
    return false;
  }
}

function validateInformationalAdvisory(vulnerability, packageIdentity) {
  if (
    !/^RUSTSEC-\d{4}-\d{4}$/u.test(vulnerability.id) ||
    vulnerability.schema_version !== "1.7.3" ||
    Object.hasOwn(vulnerability, "severity") ||
    !object(vulnerability.database_specific) ||
    Object.keys(vulnerability.database_specific).join(",") !== "license" ||
    vulnerability.database_specific.license !== "CC0-1.0"
  )
    throw vulnerabilityPolicyRejected("informational-advisory-shape");
  for (const affected of vulnerability.affected) {
    const classification = affected.database_specific;
    if (
      !object(classification) ||
      Object.keys(classification).toSorted().join(",") !==
        "categories,cvss,informational,source" ||
      classification.informational !== "unmaintained" ||
      classification.cvss !== null ||
      !Array.isArray(classification.categories) ||
      classification.categories.length !== 0 ||
      classification.source !==
        `https://github.com/rustsec/advisory-db/blob/osv/crates/${vulnerability.id}.json` ||
      Object.keys(affected.package).toSorted().join(",") !==
        "ecosystem,name,purl"
    )
      throw vulnerabilityPolicyRejected("informational-database-shape");
    for (const range of affected.ranges) {
      if (
        !object(range) ||
        Object.keys(range).toSorted().join(",") !== "events,type" ||
        range.type !== "SEMVER" ||
        !Array.isArray(range.events) ||
        range.events.length === 0 ||
        range.events.some(
          (event) =>
            !object(event) ||
            Object.keys(event).join(",") !== "introduced" ||
            typeof event.introduced !== "string" ||
            event.introduced.length === 0,
        )
      )
        throw vulnerabilityPolicyRejected("informational-range-shape");
    }
  }
  if (!validPurl(vulnerability.affected[0].package.purl, packageIdentity))
    throw vulnerabilityPolicyRejected("informational-purl");
}

function validateScoredAdvisory(vulnerability, group) {
  if (
    typeof vulnerability.schema_version !== "string" ||
    !/^1\.\d+\.\d+$/u.test(vulnerability.schema_version)
  )
    throw vulnerabilityPolicyRejected("scored-advisory-shape");
  const claimedSeverities = [];
  if (Object.hasOwn(vulnerability, "severity")) {
    if (
      !Array.isArray(vulnerability.severity) ||
      vulnerability.severity.length !== 1
    )
      throw vulnerabilityPolicyRejected("severity-shape");
    const [severity] = vulnerability.severity;
    if (
      !object(severity) ||
      Object.keys(severity).toSorted().join(",") !== "score,type" ||
      severity.type !== "CVSS_V3" ||
      typeof severity.score !== "string"
    )
      throw vulnerabilityPolicyRejected("severity-shape");
    claimedSeverities.push(severityBand(parseCvss31(severity.score)));
  }
  collectDatabaseSeverities(vulnerability.database_specific, claimedSeverities);
  for (const affected of vulnerability.affected) {
    collectDatabaseSeverities(affected.database_specific, claimedSeverities);
    for (const range of affected.ranges) {
      if (
        !object(range) ||
        range.type !== "SEMVER" ||
        !Array.isArray(range.events) ||
        range.events.length === 0 ||
        range.events.some((event) => {
          if (!object(event)) return true;
          const keys = Object.keys(event);
          return (
            keys.length !== 1 ||
            !["fixed", "introduced", "last_affected", "limit"].includes(
              keys[0],
            ) ||
            typeof event[keys[0]] !== "string" ||
            event[keys[0]].length === 0
          );
        })
      )
        throw vulnerabilityPolicyRejected("scored-range-shape");
    }
  }
  const groupBand = severityBand(severityScore(group));
  if (claimedSeverities.some((severity) => severity !== groupBand))
    throw vulnerabilityPolicyRejected("severity-coherence");
}

function collectDatabaseSeverities(database, severities) {
  if (database === undefined) return;
  if (!object(database)) throw vulnerabilityPolicyRejected("database-shape");
  if (Object.hasOwn(database, "cvss")) {
    if (database.cvss !== null && typeof database.cvss !== "string")
      throw vulnerabilityPolicyRejected("cvss-shape");
    if (typeof database.cvss === "string")
      severities.push(severityBand(parseCvss31(database.cvss)));
  }
  if (Object.hasOwn(database, "severity")) {
    const severity = normalizedSeverityBand(database.severity);
    if (!severity) throw vulnerabilityPolicyRejected("severity-shape");
    severities.push(severity);
  }
  if (Object.hasOwn(database, "categories")) {
    if (
      !Array.isArray(database.categories) ||
      !database.categories.every((category) => typeof category === "string")
    )
      throw vulnerabilityPolicyRejected("category-shape");
    for (const category of database.categories) {
      const severity = normalizedSeverityBand(category);
      if (severity) severities.push(severity);
    }
  }
}

function normalizedSeverityBand(value) {
  if (typeof value !== "string") return undefined;
  if (value === "medium") return "moderate";
  return ["critical", "high", "low", "moderate"].includes(value)
    ? value
    : undefined;
}

function severityBand(score) {
  if (!Number.isFinite(score) || score < 0 || score > 10)
    throw vulnerabilityPolicyRejected("severity-range");
  if (score < 4) return "low";
  if (score < 7) return "moderate";
  if (score < 9) return "high";
  return "critical";
}

function parseCvss31(vector) {
  const parts = vector.split("/");
  if (parts.shift() !== "CVSS:3.1")
    throw vulnerabilityPolicyRejected("cvss-version");
  const metrics = new Map();
  for (const part of parts) {
    const [name, value, ...extra] = part.split(":");
    if (!name || !value || extra.length > 0 || metrics.has(name))
      throw vulnerabilityPolicyRejected("cvss-shape");
    metrics.set(name, value);
  }
  const expected = ["A", "AC", "AV", "C", "I", "PR", "S", "UI"];
  if (
    metrics.size !== expected.length ||
    expected.some((name) => !metrics.has(name))
  )
    throw vulnerabilityPolicyRejected("cvss-metrics");

  const scope = metric(metrics, "S", { C: "C", U: "U" });
  const attackVector = metric(metrics, "AV", {
    A: 0.62,
    L: 0.55,
    N: 0.85,
    P: 0.2,
  });
  const attackComplexity = metric(metrics, "AC", { H: 0.44, L: 0.77 });
  const privilegesRequired = metric(
    metrics,
    "PR",
    scope === "C"
      ? { H: 0.5, L: 0.68, N: 0.85 }
      : { H: 0.27, L: 0.62, N: 0.85 },
  );
  const userInteraction = metric(metrics, "UI", { N: 0.85, R: 0.62 });
  const confidentiality = metric(metrics, "C", { H: 0.56, L: 0.22, N: 0 });
  const integrity = metric(metrics, "I", { H: 0.56, L: 0.22, N: 0 });
  const availability = metric(metrics, "A", { H: 0.56, L: 0.22, N: 0 });
  const impactSubscore =
    1 - (1 - confidentiality) * (1 - integrity) * (1 - availability);
  const impact =
    scope === "U"
      ? 6.42 * impactSubscore
      : 7.52 * (impactSubscore - 0.029) -
        3.25 * Math.pow(impactSubscore * 0.9731 - 0.02, 13);
  if (impact <= 0) return 0;
  const exploitability =
    8.22 *
    attackVector *
    attackComplexity *
    privilegesRequired *
    userInteraction;
  const base =
    scope === "U"
      ? Math.min(impact + exploitability, 10)
      : Math.min(1.08 * (impact + exploitability), 10);
  return Math.ceil(base * 10 - 1e-10) / 10;
}

function metric(metrics, name, values) {
  const value = metrics.get(name);
  if (!Object.hasOwn(values, value))
    throw vulnerabilityPolicyRejected("cvss-metric-value");
  return values[value];
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
