import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import {
  evidenceFailures,
  packagePolicyFailures,
  redactionMatches,
} from "./native-contract.mjs";
import {
  defaultProcessControl,
  runPackagedLifecycle,
} from "./native-lifecycle.mjs";

function sortedInventory(entries) {
  return entries.toSorted((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function normalizeLicense(license) {
  return (
    {
      "Apache-2.0 / MIT": "Apache-2.0 OR MIT",
      "Apache-2.0/MIT": "Apache-2.0 OR MIT",
      "MIT/Apache-2.0": "MIT OR Apache-2.0",
      "Unlicense/MIT": "Unlicense OR MIT",
    }[license] ?? license
  );
}

async function digest(path, reader = readFile) {
  return createHash("sha256")
    .update(await reader(path))
    .digest("hex");
}

function packageManifest({ files, policySha256, revision }) {
  return {
    schema: "keiko-native-package-manifest/v1",
    sourceRevision: revision,
    target: "keiko-native-desktop",
    platform: "macos-arm64",
    policySha256,
    inventory: files
      .map(({ mode, path, sha256 }) => ({ mode, path, sha256 }))
      .toSorted((a, b) => a.path.localeCompare(b.path)),
    redaction: "closed",
  };
}

function packagedShellEvidence({
  architecture,
  cargoLockSha256,
  lifecycle,
  npmLockSha256,
  packageManifestSha256,
  revision,
  runner,
}) {
  return {
    schema: "keiko-native-packaged-shell-evidence/v1",
    sourceRevision: revision,
    readinessFingerprint:
      "da2459bd3becc6cbf651a24ef1b64d1b11a8ed642bfddc92923f0d6ed6dc8e5e",
    packageManifestSha256,
    cargoLockSha256,
    npmLockSha256,
    runner,
    architecture,
    outcomes: [
      "packaged-health-acknowledged",
      "normal-shutdown",
      "zero-owned-descendants",
      "package-policy",
    ],
    boundedReasonCodes: [
      "invalid-request",
      "unauthorized",
      "cancelled",
      "timed-out",
      "host-unavailable",
      "shutting-down",
    ],
    acknowledgementMs: lifecycle.acknowledgementMs,
    shutdownMs: lifecycle.shutdownMs,
    cleanupOwnedDescendants: lifecycle.cleanupOwnedDescendants,
    redaction: "closed",
  };
}

async function prepareAcceptancePackage({
  packageNative,
  repositoryState,
  testNative,
}) {
  await testNative(repositoryState.expectedHead);
  await repositoryState.assertUnchanged("after-test");
  return packageNative(repositoryState);
}

export const nativePackageTestSupport = {
  packageManifest,
  packagedShellEvidence,
  prepareAcceptancePackage,
  sortedInventory,
};

export function createNativePackageGate({
  build,
  captureOutputTree,
  captureRepositoryState,
  cargoMetadata,
  fileMode = async (path) => ((await lstat(path)).mode & 0o777).toString(8),
  filesBelow,
  frontendRoot,
  nativeRoot,
  onMacOs,
  packageRoot,
  preparePackageRoot = async () => {
    await rm(packageRoot, { force: true, recursive: true });
    await mkdir(packageRoot, { recursive: true });
  },
  processControl = defaultProcessControl,
  readInputFile = readFile,
  readOutputFile = readFile,
  repositoryRoot,
  run,
  rustBuildEnv,
  targetRoot,
  testNative,
  writeOutputFile = async (path, bytes, mode) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, mode === undefined ? undefined : { mode });
  },
}) {
  const appRoot = join(packageRoot, "Keiko Native.app");

  async function dependencyInventory() {
    const cargo = sortedInventory(
      cargoMetadata().packages.map(({ license, name, source, version }) => ({
        license: normalizeLicense(license),
        name,
        source: source === null ? "workspace" : "registry",
        version,
      })),
    );
    const npmLock = JSON.parse(
      await readInputFile(join(frontendRoot, "package-lock.json"), "utf8"),
    );
    const npm = sortedInventory(
      Object.entries(npmLock.packages)
        .filter(([path]) => path !== "")
        .map(([path, metadata]) => ({
          dev: metadata.dev === true,
          license: normalizeLicense(metadata.license),
          name: path.replace(/^node_modules\//u, ""),
          version: metadata.version,
        })),
    );
    return { cargo, npm };
  }

  async function packageNative(repositoryState) {
    if (!onMacOs() || process.arch !== "arm64")
      throw new Error("native:package requires Apple Silicon macOS");
    repositoryState ??= await captureRepositoryState();
    const revision = repositoryState.expectedHead;
    await repositoryState.assertUnchanged("before-build");
    await build(revision);
    await repositoryState.assertUnchanged("after-build");
    await preparePackageRoot();
    run(
      join(frontendRoot, "node_modules/.bin/tauri"),
      ["build", "--config", "tauri.conf.json", "--bundles", "app"],
      {
        cwd: join(nativeRoot, "apps/keiko-desktop"),
        env: rustBuildEnv(revision),
      },
    );
    const builtAppRoot = join(
      targetRoot,
      "release/bundle/macos/Keiko Native.app",
    );
    if (captureOutputTree)
      await captureOutputTree(builtAppRoot, packageRoot, "Keiko Native.app");
    const inventoryRoot = captureOutputTree ? appRoot : builtAppRoot;
    const files = await Promise.all(
      (await filesBelow(inventoryRoot)).map(async (path) => ({
        bytes: await readOutputFile(path, inventoryRoot),
        mode: String(await fileMode(path, inventoryRoot)).padStart(4, "0"),
        path: relative(inventoryRoot, path).split("\\").join("/"),
        sha256: "",
      })),
    );
    for (const file of files)
      file.sha256 = createHash("sha256").update(file.bytes).digest("hex");
    if (!captureOutputTree)
      for (const file of files)
        await writeOutputFile(
          join(appRoot, file.path),
          file.bytes,
          file.path === "Contents/MacOS/keiko-native-desktop" ? 0o755 : 0o644,
        );
    const policy = JSON.parse(
      await readInputFile(join(nativeRoot, "package-policy.json"), "utf8"),
    );
    const dependencies = await dependencyInventory();
    const noticePath = join(
      appRoot,
      "Contents/Resources/THIRD-PARTY-NOTICES.json",
    );
    const notice = JSON.parse(
      files
        .find(
          ({ path }) => path === "Contents/Resources/THIRD-PARTY-NOTICES.json",
        )
        ?.bytes.toString("utf8") ?? "null",
    );
    const plist = files.find(
      ({ path }) => path === "Contents/Info.plist",
    )?.bytes;
    if (!plist) throw new Error("Package plist is absent");
    run("plutil", ["-lint", "-"], { input: plist });
    const executable = files.find(
      ({ path }) => path === "Contents/MacOS/keiko-native-desktop",
    )?.bytes;
    if (
      !executable ||
      executable.subarray(0, 8).toString("hex") !== "cffaedfe0c000001"
    )
      throw new Error("Package executable class rejected");
    const fileClasses = {
      "Contents/Info.plist": "plist",
      "Contents/MacOS/keiko-native-desktop": "mach-o-executable",
      "Contents/Resources/THIRD-PARTY-NOTICES.json": "dependency-notice",
    };
    const failures = packagePolicyFailures({
      ...dependencies,
      fileClasses,
      files,
      policy,
    });
    const expectedNotice = {
      schema: "keiko-native-third-party-notices/v1",
      target: policy.target,
      locks: policy.expectedLocks,
      acceptedSpdxExpressions: policy.acceptedSpdxExpressions,
      cargoInventory: dependencies.cargo,
      npmInventory: dependencies.npm,
    };
    if (JSON.stringify(notice) !== JSON.stringify(expectedNotice)) {
      failures.push("third-party-notice-content");
    }
    if (
      (await digest(join(nativeRoot, "Cargo.lock"), readInputFile)) !==
      policy.expectedLocks.cargoSha256
    )
      failures.push("cargo-lock-digest");
    if (
      (await digest(join(frontendRoot, "package-lock.json"), readInputFile)) !==
      policy.expectedLocks.npmSha256
    )
      failures.push("npm-lock-digest");
    if (failures.length > 0)
      throw new Error(`Native package rejected: ${failures.join(",")}`);
    const manifest = packageManifest({
      files,
      policySha256: await digest(
        join(nativeRoot, "package-policy.json"),
        readInputFile,
      ),
      revision,
    });
    const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
    if (redactionMatches(encoded).length > 0)
      throw new Error("Package evidence failed redaction");
    await writeOutputFile(join(packageRoot, "package-manifest.json"), encoded);
    await repositoryState.assertUnchanged("after-package-evidence");
    return revision;
  }

  async function launchPackagedShell() {
    const executable = join(appRoot, "Contents/MacOS/keiko-native-desktop");
    return runPackagedLifecycle({
      executable,
      packageRoot,
      processControl,
    });
  }

  async function acceptance() {
    if (!onMacOs() || process.arch !== "arm64")
      throw new Error("acceptance:macos requires Apple Silicon macOS");
    const repositoryState = await captureRepositoryState();
    const revision = await prepareAcceptancePackage({
      packageNative,
      repositoryState,
      testNative,
    });
    const lifecycle = await launchPackagedShell();
    await repositoryState.assertUnchanged("after-lifecycle");
    const bindings = {
      cargoLockSha256: await digest(
        join(nativeRoot, "Cargo.lock"),
        readInputFile,
      ),
      npmLockSha256: await digest(
        join(frontendRoot, "package-lock.json"),
        readInputFile,
      ),
      packageManifestSha256: await digest(
        join(packageRoot, "package-manifest.json"),
        (path) => readOutputFile(path, packageRoot),
      ),
      readinessFingerprint:
        "da2459bd3becc6cbf651a24ef1b64d1b11a8ed642bfddc92923f0d6ed6dc8e5e",
      sourceRevision: revision,
    };
    const evidence = packagedShellEvidence({
      architecture: process.arch,
      cargoLockSha256: bindings.cargoLockSha256,
      lifecycle,
      npmLockSha256: bindings.npmLockSha256,
      packageManifestSha256: bindings.packageManifestSha256,
      revision: bindings.sourceRevision,
      runner: process.env.ImageOS
        ? `${process.env.ImageOS}-${process.env.ImageVersion ?? "current"}`
        : "local-macos",
    });
    const failures = evidenceFailures(evidence, bindings);
    const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
    if (redactionMatches(encoded).length > 0)
      failures.push("evidence-redaction-match");
    if (failures.length > 0)
      throw new Error(`Acceptance evidence rejected: ${failures.join(",")}`);
    await writeOutputFile(
      join(packageRoot, "acceptance-evidence.json"),
      encoded,
    );
    await repositoryState.assertUnchanged("after-acceptance-evidence");
  }

  return { acceptance, packageNative };
}
