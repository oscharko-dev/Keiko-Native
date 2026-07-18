import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

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

async function digest(path) {
  return createHash("sha256")
    .update(await readFile(path))
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
      .map(({ path, sha256 }) => ({ path, sha256 }))
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
      "c68478df272e1add068e7b1bba9e8c973920b4e3eae29a293d1cba3bc54ab61a",
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

export const nativePackageTestSupport = {
  packageManifest,
  packagedShellEvidence,
  sortedInventory,
};

export function createNativePackageGate({
  build,
  cargoMetadata,
  filesBelow,
  frontendRoot,
  nativeRoot,
  onMacOs,
  packageRoot,
  processControl = defaultProcessControl,
  repositoryRoot,
  run,
  rustBuildEnv,
  sourceRevision,
  targetRoot,
  testNative,
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
      await readFile(join(frontendRoot, "package-lock.json"), "utf8"),
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

  async function packageNative() {
    await build();
    if (!onMacOs()) return;
    await rm(packageRoot, { force: true, recursive: true });
    await mkdir(packageRoot, { recursive: true });
    run(
      join(frontendRoot, "node_modules/.bin/tauri"),
      ["build", "--config", "tauri.conf.json", "--bundles", "app"],
      {
        cwd: join(nativeRoot, "apps/keiko-desktop"),
        env: rustBuildEnv(),
      },
    );
    await cp(
      join(targetRoot, "release/bundle/macos/Keiko Native.app"),
      appRoot,
      { recursive: true },
    );
    const files = await Promise.all(
      (await filesBelow(appRoot)).map(async (path) => ({
        bytes: await readFile(path),
        path: relative(appRoot, path).split("\\").join("/"),
        sha256: await digest(path),
      })),
    );
    const policy = JSON.parse(
      await readFile(join(nativeRoot, "package-policy.json"), "utf8"),
    );
    const dependencies = await dependencyInventory();
    const noticePath = join(
      appRoot,
      "Contents/Resources/THIRD-PARTY-NOTICES.json",
    );
    const notice = JSON.parse(await readFile(noticePath, "utf8"));
    run("plutil", ["-lint", join(appRoot, "Contents/Info.plist")]);
    const executableType = run(
      "file",
      [join(appRoot, "Contents/MacOS/keiko-native-desktop")],
      { capture: true },
    );
    if (!executableType.includes("Mach-O 64-bit executable arm64"))
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
      (await digest(join(nativeRoot, "Cargo.lock"))) !==
      policy.expectedLocks.cargoSha256
    )
      failures.push("cargo-lock-digest");
    if (
      (await digest(join(frontendRoot, "package-lock.json"))) !==
      policy.expectedLocks.npmSha256
    )
      failures.push("npm-lock-digest");
    if (failures.length > 0)
      throw new Error(`Native package rejected: ${failures.join(",")}`);
    const manifest = packageManifest({
      files,
      policySha256: await digest(join(nativeRoot, "package-policy.json")),
      revision: sourceRevision(),
    });
    const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
    if (redactionMatches(encoded).length > 0)
      throw new Error("Package evidence failed redaction");
    await writeFile(join(packageRoot, "package-manifest.json"), encoded);
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
    await packageNative();
    await testNative();
    const lifecycle = await launchPackagedShell();
    const evidence = packagedShellEvidence({
      architecture: process.arch,
      cargoLockSha256: await digest(join(nativeRoot, "Cargo.lock")),
      lifecycle,
      npmLockSha256: await digest(join(frontendRoot, "package-lock.json")),
      packageManifestSha256: await digest(
        join(packageRoot, "package-manifest.json"),
      ),
      revision: sourceRevision(),
      runner: process.env.ImageOS
        ? `${process.env.ImageOS}-${process.env.ImageVersion ?? "current"}`
        : "local-macos",
    });
    const failures = evidenceFailures(evidence);
    const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
    if (redactionMatches(encoded).length > 0)
      failures.push("evidence-redaction-match");
    if (failures.length > 0)
      throw new Error(`Acceptance evidence rejected: ${failures.join(",")}`);
    await writeFile(join(packageRoot, "acceptance-evidence.json"), encoded);
  }

  return { acceptance, packageNative };
}
