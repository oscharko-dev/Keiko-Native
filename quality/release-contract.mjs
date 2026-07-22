const hex40 = /^[0-9a-f]{40}$/u;
const hex64 = /^[0-9a-f]{64}$/u;
const safePath = /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/u;

const manifestKeys = [
  "applicationIdentifier",
  "architecture",
  "artifact",
  "channel",
  "evidence",
  "payloadInventory",
  "schema",
  "sourceEpoch",
  "sourceRevision",
  "toolchains",
  "version",
];

export function internalArtifactName(version, architecture) {
  return `Keiko-Native-${version}-internal-${architecture}.dmg`;
}

export function releaseManifestFailures(manifest, expected) {
  const failures = [];
  if (!exactKeys(manifest, manifestKeys)) failures.push("manifest-fields");
  if (manifest?.schema !== "keiko-native-internal-release/v1")
    failures.push("manifest-schema");
  if (
    manifest?.channel !== "internal" ||
    manifest?.applicationIdentifier !== "dev.oscharko.keiko-native" ||
    manifest?.version !== "0.1.0" ||
    manifest?.architecture !== "arm64"
  )
    failures.push("manifest-identity");
  if (
    !hex40.test(manifest?.sourceRevision ?? "") ||
    manifest?.sourceRevision !== expected.revision ||
    !positiveInteger(manifest?.sourceEpoch) ||
    manifest?.sourceEpoch !== expected.sourceEpoch
  )
    failures.push("manifest-source");
  failures.push(...artifactFailures(manifest?.artifact, expected, manifest));
  failures.push(...inventoryFailures(manifest?.payloadInventory));
  if (
    !exactKeys(manifest?.evidence, [
      "digest",
      "inputs",
      "packageManifest",
      "sbom",
    ]) ||
    manifest?.evidence?.digest !== "SHA256SUMS" ||
    manifest?.evidence?.packageManifest !== "package-manifest.json" ||
    manifest?.evidence?.sbom !== "sbom.spdx.json" ||
    !exactInputEvidence(manifest?.evidence?.inputs) ||
    JSON.stringify(manifest?.evidence?.inputs) !==
      JSON.stringify(expected.inputEvidence)
  )
    failures.push("manifest-evidence");
  if (
    !exactKeys(manifest?.toolchains, ["node", "npm", "rust"]) ||
    manifest?.toolchains?.node !== "24.18.0" ||
    manifest?.toolchains?.npm !== "11.16.0" ||
    manifest?.toolchains?.rust !== "1.92.0"
  )
    failures.push("manifest-toolchains");
  return failures;
}

export function spdxFailures(sbom, expected) {
  const failures = [];
  if (
    !exactKeys(sbom, [
      "SPDXID",
      "creationInfo",
      "dataLicense",
      "documentNamespace",
      "files",
      "name",
      "packages",
      "relationships",
      "spdxVersion",
    ])
  )
    failures.push("spdx-fields");
  failures.push(...spdxIdentityFailures(sbom, expected));
  failures.push(...spdxCreationFailures(sbom, expected));
  failures.push(...spdxArtifactFailures(sbom, expected));
  if (
    spdxPackageFailures(sbom?.packages).length > 0 ||
    !sameSpdxPackages(sbom?.packages, expected.dependencies)
  )
    failures.push("spdx-packages");
  if (
    JSON.stringify(sbom?.relationships) !==
    JSON.stringify([
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: "SPDXRef-Internal-DMG",
      },
    ])
  )
    failures.push("spdx-relationships");
  return failures;
}

export function packageManifestFailures(
  manifest,
  expectedRevision,
  expectedInventory,
  expectedPolicySha256,
) {
  const expectedKeys = [
    "inventory",
    "platform",
    "policySha256",
    "redaction",
    "schema",
    "sourceRevision",
    "target",
  ];
  const keys =
    manifest !== null &&
    typeof manifest === "object" &&
    !Array.isArray(manifest)
      ? Object.keys(manifest).toSorted(compareCodeUnits)
      : [];
  const inventory = Array.isArray(manifest?.inventory)
    ? manifest.inventory
    : [];
  if (
    JSON.stringify(keys) !==
      JSON.stringify(expectedKeys.toSorted(compareCodeUnits)) ||
    manifest?.schema !== "keiko-native-package-manifest/v1" ||
    manifest?.sourceRevision !== expectedRevision ||
    manifest?.target !== "keiko-native-desktop" ||
    manifest?.platform !== "macos-arm64" ||
    manifest?.redaction !== "closed" ||
    manifest?.policySha256 !== expectedPolicySha256 ||
    inventory.some(invalidPackageInventoryEntry) ||
    !samePackageInventory(inventory, expectedInventory)
  )
    return ["release-package-manifest"];
  return [];
}

function exactInputEvidence(value) {
  return (
    exactKeys(value, [
      "cargoLockSha256",
      "frontendLockSha256",
      "policySha256",
      "rootLockSha256",
    ]) && Object.values(value).every((digest) => hex64.test(digest))
  );
}

function sameSpdxPackages(packages, dependencies) {
  if (!Array.isArray(packages) || !Array.isArray(dependencies)) return false;
  const projection = dependencies
    .map(({ license, name, version }) => ({ license, name, version }))
    .toSorted((left, right) =>
      `${left.name}@${left.version}`.localeCompare(
        `${right.name}@${right.version}`,
      ),
    );
  const actual = packages.map(({ licenseDeclared, name, versionInfo }) => ({
    license: licenseDeclared,
    name,
    version: versionInfo,
  }));
  return JSON.stringify(actual) === JSON.stringify(projection);
}

function spdxIdentityFailures(sbom, expected) {
  if (
    sbom?.spdxVersion !== "SPDX-2.3" ||
    sbom?.dataLicense !== "CC0-1.0" ||
    sbom?.SPDXID !== "SPDXRef-DOCUMENT" ||
    sbom?.name !== `keiko-native-internal-${expected.revision}` ||
    sbom?.documentNamespace !==
      `https://github.com/oscharko-dev/Keiko-Native/sbom/${expected.revision}/${expected.digest}`
  )
    return ["spdx-document"];
  return [];
}

function spdxCreationFailures(sbom, expected) {
  if (
    !exactKeys(sbom?.creationInfo, ["created", "creators"]) ||
    sbom?.creationInfo?.created !==
      new Date(expected.sourceEpoch * 1000).toISOString() ||
    JSON.stringify(sbom?.creationInfo?.creators) !==
      JSON.stringify(["Tool: keiko-native-release-verify/1"])
  )
    return ["spdx-creation"];
  return [];
}

function spdxArtifactFailures(sbom, expected) {
  const files = Array.isArray(sbom?.files) ? sbom.files : [];
  if (
    files.length !== 1 ||
    files[0]?.SPDXID !== "SPDXRef-Internal-DMG" ||
    files[0]?.fileName !== "Keiko-Native-0.1.0-internal-arm64.dmg" ||
    JSON.stringify(files[0]?.checksums) !==
      JSON.stringify([{ algorithm: "SHA256", checksumValue: expected.digest }])
  )
    return ["spdx-artifact"];
  return [];
}

function artifactFailures(artifact, expected, manifest) {
  if (
    !exactKeys(artifact, ["name", "sha256", "size"]) ||
    artifact?.name !==
      internalArtifactName(manifest?.version, manifest?.architecture) ||
    !hex64.test(artifact?.sha256 ?? "") ||
    artifact?.sha256 !== expected.digest ||
    !positiveInteger(artifact?.size) ||
    artifact?.size !== expected.size
  )
    return ["manifest-artifact"];
  return [];
}

function inventoryFailures(inventory) {
  if (!Array.isArray(inventory) || inventory.length === 0)
    return ["manifest-inventory"];
  const paths = inventory.map((entry) => entry?.path);
  if (
    new Set(paths).size !== paths.length ||
    JSON.stringify(paths) !==
      JSON.stringify([...paths].toSorted(compareCodeUnits)) ||
    inventory.some(
      (entry) =>
        !exactKeys(entry, ["mode", "path", "sha256", "size"]) ||
        !/^(?:0644|0755)$/u.test(entry.mode ?? "") ||
        !safeRepositoryPath(entry.path) ||
        !hex64.test(entry.sha256 ?? "") ||
        !positiveInteger(entry.size),
    )
  )
    return ["manifest-inventory"];
  return [];
}

function spdxPackageFailures(packages) {
  if (!Array.isArray(packages) || packages.length === 0)
    return ["spdx-package-list"];
  const identities = packages.map(
    (entry) => `${entry?.name}@${entry?.versionInfo}`,
  );
  if (
    new Set(identities).size !== identities.length ||
    JSON.stringify(identities) !==
      JSON.stringify(
        [...identities].toSorted((left, right) => left.localeCompare(right)),
      ) ||
    packages.some(
      (entry, index) =>
        !exactKeys(entry, [
          "SPDXID",
          "downloadLocation",
          "filesAnalyzed",
          "licenseConcluded",
          "licenseDeclared",
          "name",
          "versionInfo",
        ]) ||
        entry.SPDXID !== `SPDXRef-Package-${String(index + 1)}` ||
        !boundedText(entry.name) ||
        !boundedText(entry.versionInfo) ||
        !boundedText(entry.licenseDeclared) ||
        entry.licenseConcluded !== entry.licenseDeclared ||
        entry.downloadLocation !== "NOASSERTION" ||
        entry.filesAnalyzed !== false,
    )
  )
    return ["spdx-package-entry"];
  return [];
}

function boundedText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function invalidPackageInventoryEntry(entry) {
  return (
    entry === null ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    JSON.stringify(Object.keys(entry).toSorted(compareCodeUnits)) !==
      JSON.stringify(["mode", "path", "sha256"])
  );
}

function samePackageInventory(packageInventory, expected) {
  if (!Array.isArray(packageInventory) || !Array.isArray(expected))
    return false;
  const project = (entries) =>
    entries.map(({ mode, path, sha256 }) => ({ mode, path, sha256 }));
  return (
    JSON.stringify(project(packageInventory)) ===
    JSON.stringify(project(expected))
  );
}

function safeRepositoryPath(value) {
  return (
    typeof value === "string" &&
    safePath.test(value) &&
    !value.startsWith("/") &&
    !value.split("/").includes("..")
  );
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).toSorted(compareCodeUnits)) ===
      JSON.stringify([...expected].toSorted(compareCodeUnits))
  );
}
import { compareCodeUnits } from "./deterministic-order.mjs";
