import { createHash, timingSafeEqual } from "node:crypto";

import {
  internalArtifactName,
  releaseManifestFailures,
  spdxFailures,
} from "./release-contract.mjs";

const version = "0.1.0";
const architecture = "arm64";

export function createReleaseRecords({
  appInventory,
  dependencies,
  dmgBytes,
  inputEvidence,
  revision,
  sourceEpoch,
}) {
  const digest = sha256(dmgBytes);
  const artifactName = internalArtifactName(version, architecture);
  const manifest = {
    schema: "keiko-native-internal-release/v1",
    channel: "internal",
    applicationIdentifier: "dev.oscharko.keiko-native",
    version,
    architecture,
    sourceRevision: revision,
    sourceEpoch,
    artifact: { name: artifactName, sha256: digest, size: dmgBytes.length },
    payloadInventory: [...appInventory].toSorted((left, right) =>
      left.path.localeCompare(right.path),
    ),
    evidence: {
      digest: "SHA256SUMS",
      inputs: inputEvidence,
      packageManifest: "package-manifest.json",
      sbom: "sbom.spdx.json",
    },
    toolchains: { node: "24.18.0", npm: "11.16.0", rust: "1.92.0" },
  };
  const sbom = createSpdx({
    artifactName,
    dependencies,
    digest,
    revision,
    sourceEpoch,
  });
  const expected = {
    dependencies,
    digest,
    inputEvidence,
    revision,
    size: dmgBytes.length,
    sourceEpoch,
  };
  const failures = [
    ...releaseManifestFailures(manifest, expected),
    ...spdxFailures(sbom, expected),
  ];
  if (failures.length > 0)
    throw new Error(`release-records-invalid:${failures.join(",")}`);
  return {
    digest,
    manifest,
    sbom,
    sha256s: `${digest}  ${artifactName}\n`,
  };
}

export async function proveDeterministicImage(build) {
  const first = await build(1);
  const second = await build(2);
  const left = sha256Bytes(first);
  const right = sha256Bytes(second);
  if (!timingSafeEqual(left, right) || first.length !== second.length)
    throw new Error("release-image-nondeterministic");
  return first;
}

export async function proveDeterministicReleaseBuild(build) {
  const first = await build(1);
  const second = await build(2);
  if (
    !validBuildCandidate(first) ||
    !validBuildCandidate(second) ||
    JSON.stringify(first.inventory) !== JSON.stringify(second.inventory) ||
    !exactBytes(first.packageManifest, second.packageManifest)
  )
    throw new Error("release-package-nondeterministic");
  if (!exactBytes(first.dmg, second.dmg))
    throw new Error("release-image-nondeterministic");
  return first;
}

export async function runReleaseTransaction({
  build,
  publish,
  signal,
  verify,
}) {
  throwIfCancelled(signal);
  const candidate = await build();
  throwIfCancelled(signal);
  await verify(candidate);
  throwIfCancelled(signal);
  return publish(candidate);
}

function createSpdx({
  artifactName,
  dependencies,
  digest,
  revision,
  sourceEpoch,
}) {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `keiko-native-internal-${revision}`,
    documentNamespace: `https://github.com/oscharko-dev/Keiko-Native/sbom/${revision}/${digest}`,
    creationInfo: {
      created: new Date(sourceEpoch * 1000).toISOString(),
      creators: ["Tool: keiko-native-release-verify/1"],
    },
    packages: [...dependencies]
      .toSorted((left, right) =>
        `${left.name}@${left.version}`.localeCompare(
          `${right.name}@${right.version}`,
        ),
      )
      .map((dependency, index) => ({
        SPDXID: `SPDXRef-Package-${String(index + 1)}`,
        name: dependency.name,
        versionInfo: dependency.version,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: dependency.license,
        licenseDeclared: dependency.license,
      })),
    files: [
      {
        SPDXID: "SPDXRef-Internal-DMG",
        fileName: artifactName,
        checksums: [{ algorithm: "SHA256", checksumValue: digest }],
      },
    ],
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: "SPDXRef-Internal-DMG",
      },
    ],
  };
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new Error("release-cancelled");
}

function validBuildCandidate(candidate) {
  return (
    Array.isArray(candidate?.inventory) &&
    candidate.dmg instanceof Uint8Array &&
    candidate.packageManifest instanceof Uint8Array
  );
}

function exactBytes(left, right) {
  return (
    left.byteLength === right.byteLength &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function sha256(value) {
  return sha256Bytes(value).toString("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest();
}
