import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  evidenceFailures,
  packagePolicyFailures,
  redactionMatches,
} from "./native-contract.mjs";

function sortedInventory(entries) {
  return entries.toSorted((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
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
    elapsedMs: lifecycle.elapsedMs,
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
  repositoryRoot,
  run,
  sourceRevision,
  targetRoot,
  testNative,
}) {
  const appRoot = join(packageRoot, "Keiko Native.app");

  async function dependencyInventory() {
    const cargo = sortedInventory(
      cargoMetadata().packages.map(({ license, name, source, version }) => ({
        license,
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
          license: metadata.license,
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
        env: { KEIKO_NATIVE_SOURCE_REVISION: sourceRevision() },
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
    const failures = packagePolicyFailures({
      ...dependencies,
      files,
      policy,
    });
    const notice = JSON.parse(
      await readFile(
        join(appRoot, "Contents/Resources/THIRD-PARTY-NOTICES.json"),
        "utf8",
      ),
    );
    if (
      notice.schema !== "keiko-native-third-party-notices/v1" ||
      JSON.stringify(notice.cargoInventory) !==
        JSON.stringify(dependencies.cargo) ||
      JSON.stringify(notice.npmInventory) !==
        JSON.stringify(dependencies.npm) ||
      JSON.stringify(notice.acceptedSpdxExpressions) !==
        JSON.stringify(policy.acceptedSpdxExpressions)
    ) {
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
    run("plutil", ["-lint", join(appRoot, "Contents/Info.plist")]);
    const executableType = run(
      "file",
      [join(appRoot, "Contents/MacOS/keiko-native-desktop")],
      { capture: true },
    );
    if (!executableType.includes("Mach-O 64-bit executable arm64"))
      throw new Error("Package executable class rejected");
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

  function descendantCount(processGroup) {
    const result = spawnSync("pgrep", ["-g", String(processGroup)], {
      encoding: "utf8",
    });
    if (![0, 1].includes(result.status))
      throw new Error("Process cleanup inspection failed");
    return result.stdout.trim().split("\n").filter(Boolean).length;
  }

  function terminateProcessGroup(child) {
    if (child.exitCode !== null) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }

  async function launchPackagedShell() {
    const executable = join(appRoot, "Contents/MacOS/keiko-native-desktop");
    const startedAt = performance.now();
    const child = spawn(executable, [], {
      cwd: packageRoot,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      await new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => {
          terminateProcessGroup(child);
          reject(new Error("Packaged health acknowledgement timed out"));
        }, 5000);
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          output = `${output}${chunk}`.slice(-1024);
          if (!output.includes("keiko-native-health-ack/v1 sequence=2")) return;
          clearTimeout(timer);
          resolve();
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Packaged shell exited before acknowledgement"));
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      run("osascript", [
        "-e",
        'tell application id "dev.oscharko.keiko-native" to quit',
      ]);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          terminateProcessGroup(child);
          reject(new Error("Packaged shell did not shut down within 5000 ms"));
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return {
        cleanupOwnedDescendants: descendantCount(child.pid),
        elapsedMs: Math.round(performance.now() - startedAt),
      };
    } finally {
      terminateProcessGroup(child);
    }
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
