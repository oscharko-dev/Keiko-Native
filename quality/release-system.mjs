import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import {
  createReleaseRecords,
  proveDeterministicReleaseBuild,
  runReleaseTransaction,
} from "./internal-release.mjs";
import { normalizeIsoTimestamps } from "./iso-normalization.mjs";
import {
  artifactName,
  assertPublishedInventory,
  assertVerificationReceipt,
  parseFilesystemJson,
  readBundleEvidence,
  releaseDigestText,
  writeFilesystemJson,
} from "./release-evidence.mjs";
import {
  packageManifestFailures,
  releaseManifestFailures,
  spdxFailures,
} from "./release-contract.mjs";
import {
  assertReadOnlyInventory,
  inventoryTree,
  mountedInventoryFailures,
  normalizeInventoryModes,
  ownedReleasePaths,
} from "./release-io.mjs";
import {
  ownedRelative,
  removeOwned,
  requireReleaseFilesystem,
} from "./release-owned-fs.mjs";
import { withMountedDiskImage } from "./release-mounted.mjs";

export { withMountedDiskImage } from "./release-mounted.mjs";
const maxImageBytes = 1024 * 1024 * 1024;

export function diskImageCommand(sourceRoot, outputBase) {
  return [
    "makehybrid",
    "-quiet",
    "-iso",
    "-joliet",
    "-iso-volume-name",
    "KEIKO_INTERNAL",
    "-joliet-volume-name",
    "Keiko Native Internal",
    "-o",
    outputBase,
    sourceRoot,
  ];
}

export async function buildReleaseBundle({
  buildPackage,
  cleanupRun,
  dependencies,
  filesystem,
  inputEvidence,
  packageRoot,
  repositoryRoot,
  revision,
  run,
  signal,
  sourceEpoch,
  workspaceRoot,
}) {
  if (typeof buildPackage !== "function")
    throw new Error("release-package-build-rejected");
  requireReleaseFilesystem(filesystem);
  const { outputRoot } = await ownedReleasePaths(repositoryRoot, filesystem);
  const scratch = join(workspaceRoot, "scratch");
  const staging = join(workspaceRoot, "staging");
  removeOwned(filesystem, workspaceRoot, staging);
  removeOwned(filesystem, workspaceRoot, scratch);
  try {
    return await executeReleaseTransaction({
      dependencies,
      cleanupRun,
      filesystem,
      inputEvidence,
      buildPackage,
      outputRoot,
      packageRoot,
      repositoryRoot,
      revision,
      run,
      signal,
      sourceEpoch,
      scratch,
      staging,
      workspaceRoot,
    });
  } finally {
    removeOwned(filesystem, workspaceRoot, staging);
    removeOwned(filesystem, workspaceRoot, scratch);
  }
}

export async function verifyReleaseBundle({
  cleanupRun,
  directory,
  expectedDependencies,
  expectedInputEvidence,
  expectedInventory,
  expectedRevision,
  expectedSourceEpoch,
  filesystem,
  run,
  scratch,
}) {
  const { dmg, manifest, packageManifest, sbom } = readBundleEvidence(
    directory,
    filesystem,
    maxImageBytes,
  );
  const digest = createHash("sha256").update(dmg).digest("hex");
  const expected = {
    dependencies: expectedDependencies,
    digest,
    inputEvidence: expectedInputEvidence,
    revision: expectedRevision,
    size: dmg.length,
    sourceEpoch: expectedSourceEpoch,
  };
  const failures = [
    ...releaseManifestFailures(manifest, expected),
    ...spdxFailures(sbom, expected),
  ];
  if (
    releaseDigestText(directory, filesystem) !== `${digest}  ${artifactName}\n`
  )
    failures.push("release-digest-file");
  failures.push(
    ...packageManifestFailures(
      packageManifest,
      expectedRevision,
      expectedInventory,
      expectedInputEvidence.policySha256,
    ),
  );
  if (failures.length > 0)
    throw new Error(`release-bundle-invalid:${failures.join(",")}`);
  await verifyMountedPayload({
    cleanupRun,
    directory,
    expectedInventory,
    filesystem,
    run,
    scratch,
  });
}

export async function verifyPublishedRelease({
  cleanupRun,
  directory,
  expectedDependencies,
  expectedInputEvidence,
  expectedRevision,
  expectedSourceEpoch,
  filesystem,
  repositoryRoot,
  run,
  workspaceRoot,
}) {
  requireReleaseFilesystem(filesystem);
  const owned = await ownedReleasePaths(repositoryRoot, filesystem);
  if (directory !== owned.outputRoot)
    throw new Error("release-owned-path-rejected");
  const scratch = join(workspaceRoot, "scratch");
  try {
    assertPublishedInventory(directory, filesystem);
    const manifest = parseFilesystemJson(
      filesystem,
      directory,
      "release-manifest.json",
    );
    const receipt = parseFilesystemJson(
      filesystem,
      directory,
      "release-verification.json",
    );
    assertVerificationReceipt(receipt, manifest, expectedRevision);
    await verifyReleaseBundle({
      cleanupRun,
      directory,
      expectedDependencies,
      expectedInputEvidence,
      expectedInventory: manifest.payloadInventory,
      expectedRevision,
      expectedSourceEpoch,
      filesystem,
      run,
      scratch,
    });
  } finally {
    removeOwned(filesystem, workspaceRoot, scratch);
  }
}

async function executeReleaseTransaction(options) {
  const { revision, run, sourceEpoch, scratch, staging } = options;
  return runReleaseTransaction({
    signal: options.signal,
    build: () => stageRelease(options),
    verify: (candidate) =>
      verifyReleaseBundle({
        directory: staging,
        cleanupRun: options.cleanupRun,
        expectedDependencies: options.dependencies,
        expectedInputEvidence: options.inputEvidence,
        expectedInventory: candidate.inventory,
        expectedRevision: revision,
        expectedSourceEpoch: sourceEpoch,
        filesystem: options.filesystem,
        run,
        scratch,
      }),
    publish: (candidate) => publishCandidate(candidate, options),
  });
}

async function publishCandidate(
  candidate,
  { filesystem, outputRoot, repositoryRoot, revision, staging, workspaceRoot },
) {
  writeFilesystemJson(
    filesystem,
    workspaceRoot,
    "staging/release-verification.json",
    {
      schema: "keiko-native-release-verification/v1",
      sourceRevision: revision,
      artifactSha256: candidate.records.digest,
      outcomes: [
        "two-build-byte-identity",
        "mounted-payload-inventory",
        "copy-verification",
        "spdx-2.3",
        "redaction-closed",
      ],
      redaction: "closed",
    },
  );
  filesystem.publish(
    workspaceRoot,
    ownedRelative(workspaceRoot, staging),
    repositoryRoot,
    ownedRelative(repositoryRoot, outputRoot),
  );
  return outputRoot;
}

async function stageRelease({
  buildPackage,
  dependencies,
  filesystem,
  inputEvidence,
  packageRoot,
  revision,
  run,
  sourceEpoch,
  staging,
  workspaceRoot,
}) {
  const candidate = await proveDeterministicReleaseBuild(async (attempt) => {
    await buildPackage();
    const source = join(staging, `image-source-${String(attempt)}`);
    const sourceApp = join(source, "Keiko Native.app");
    filesystem.copyTree(
      packageRoot,
      "Keiko Native.app",
      workspaceRoot,
      ownedRelative(workspaceRoot, sourceApp),
    );
    normalizeTimes(source, sourceEpoch, filesystem);
    const output = join(staging, `candidate-${String(attempt)}`);
    await run("hdiutil", diskImageCommand(source, output));
    return {
      dmg: normalizeIsoTimestamps(
        filesystem.read(
          workspaceRoot,
          ownedRelative(workspaceRoot, `${output}.iso`),
        ),
        sourceEpoch,
      ),
      inventory: await inventoryTree(sourceApp, { filesystem }),
      packageManifest: filesystem.read(packageRoot, "package-manifest.json"),
    };
  });
  const records = createReleaseRecords({
    appInventory: candidate.inventory,
    dependencies,
    dmgBytes: candidate.dmg,
    inputEvidence,
    revision,
    sourceEpoch,
  });
  filesystem.write(workspaceRoot, `staging/${artifactName}`, candidate.dmg);
  filesystem.write(
    workspaceRoot,
    "staging/package-manifest.json",
    candidate.packageManifest,
  );
  writeFilesystemJson(
    filesystem,
    workspaceRoot,
    "staging/release-manifest.json",
    records.manifest,
  );
  writeFilesystemJson(
    filesystem,
    workspaceRoot,
    "staging/sbom.spdx.json",
    records.sbom,
  );
  filesystem.write(workspaceRoot, "staging/SHA256SUMS", records.sha256s);
  for (const attempt of [1, 2])
    for (const path of [
      `candidate-${String(attempt)}.iso`,
      `image-source-${String(attempt)}`,
    ])
      removeOwned(filesystem, workspaceRoot, join(staging, path));
  return { inventory: candidate.inventory, records };
}

async function verifyMountedPayload({
  cleanupRun,
  directory,
  expectedInventory,
  filesystem,
  run,
  scratch,
}) {
  const workspaceRoot = dirname(scratch);
  const mountPoint = join(scratch, "mount");
  const copiedApp = join(scratch, "copied", "Keiko Native.app");
  filesystem.mkdir(workspaceRoot, ownedRelative(workspaceRoot, scratch));
  removeOwned(filesystem, workspaceRoot, mountPoint);
  filesystem.mkdir(workspaceRoot, ownedRelative(workspaceRoot, mountPoint));
  await withMountedDiskImage({
    image: join(directory, artifactName),
    cleanupMountPoint: async () =>
      removeOwned(filesystem, workspaceRoot, mountPoint),
    cleanupRun,
    mountPoint,
    run,
    action: async () => {
      const names = filesystem
        .list(mountPoint)
        .filter(({ path }) => !path.includes("/"))
        .map(({ path }) => path);
      if (JSON.stringify(names) !== JSON.stringify(["Keiko Native.app"]))
        throw new Error("release-mounted-root-rejected");
      const mountedApp = join(mountPoint, "Keiko Native.app");
      const mountedInventory = await inventoryTree(mountedApp, { filesystem });
      if (mountedInventoryFailures(mountedInventory, expectedInventory).length)
        throw new Error("release-mounted-inventory-mismatch");
      await assertReadOnlyInventory(mountedApp, mountedInventory);
      filesystem.copyTree(
        mountPoint,
        "Keiko Native.app",
        workspaceRoot,
        ownedRelative(workspaceRoot, copiedApp),
      );
      normalizeInventoryModes(copiedApp, expectedInventory, filesystem);
      if (
        !sameInventory(
          await inventoryTree(copiedApp, { filesystem }),
          expectedInventory,
        )
      )
        throw new Error("release-copied-inventory-mismatch");
    },
  });
}

function normalizeTimes(root, sourceEpoch, filesystem) {
  const entries = filesystem.list(root);
  for (const { path } of entries.toReversed())
    filesystem.touch(root, path, sourceEpoch);
  filesystem.touch(
    dirname(root),
    root.slice(dirname(root).length + 1),
    sourceEpoch,
  );
}

function sameInventory(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
