import { decodeReleaseText, parseReleaseJson } from "./release-io.mjs";

export const artifactName = "Keiko-Native-0.1.0-internal-arm64.dmg";
export const bundleFiles = [
  "SHA256SUMS",
  artifactName,
  "package-manifest.json",
  "release-manifest.json",
  "release-verification.json",
  "sbom.spdx.json",
];

export function readBundleEvidence(directory, filesystem, maximumImageBytes) {
  const dmg = filesystem.read(directory, artifactName);
  if (dmg.length < 1 || dmg.length > maximumImageBytes)
    throw new Error("release-image-size-rejected");
  const manifest = parseFilesystemJson(
    filesystem,
    directory,
    "release-manifest.json",
  );
  const sbom = parseFilesystemJson(filesystem, directory, "sbom.spdx.json");
  const packageManifest = parseFilesystemJson(
    filesystem,
    directory,
    "package-manifest.json",
  );
  return { dmg, manifest, packageManifest, sbom };
}

export function releaseDigestText(directory, filesystem) {
  return decodeReleaseText(filesystem.read(directory, "SHA256SUMS"), 1024);
}

export function assertPublishedInventory(directory, filesystem) {
  const inventory = filesystem.list(directory);
  const names = inventory
    .filter(({ type }) => type === "F")
    .map(({ path }) => path)
    .toSorted();
  if (JSON.stringify(names) !== JSON.stringify([...bundleFiles].toSorted()))
    throw new Error("release-bundle-files-rejected");
  if (inventory.length !== names.length)
    throw new Error("release-bundle-files-rejected");
}

export function assertVerificationReceipt(receipt, manifest, expectedRevision) {
  const keys = [
    "artifactSha256",
    "outcomes",
    "redaction",
    "schema",
    "sourceRevision",
  ];
  const outcomes = [
    "two-build-byte-identity",
    "mounted-payload-inventory",
    "copy-verification",
    "spdx-2.3",
    "redaction-closed",
  ];
  if (
    JSON.stringify(Object.keys(receipt).toSorted()) !==
      JSON.stringify(keys.toSorted()) ||
    receipt.schema !== "keiko-native-release-verification/v1" ||
    receipt.sourceRevision !== expectedRevision ||
    receipt.artifactSha256 !== manifest?.artifact?.sha256 ||
    receipt.redaction !== "closed" ||
    JSON.stringify(receipt.outcomes) !== JSON.stringify(outcomes)
  )
    throw new Error("release-verification-receipt-rejected");
}

export function parseFilesystemJson(filesystem, root, path) {
  return parseReleaseJson(filesystem.read(root, path));
}

export function writeFilesystemJson(filesystem, root, path, value) {
  filesystem.write(root, path, `${JSON.stringify(value, null, 2)}\n`, 0o644);
}
