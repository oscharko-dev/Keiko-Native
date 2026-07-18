import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  coverageFailures,
  manifestFailures,
  sourceDeclarationFailures,
  sourceSecurityFailures,
  workspaceDependencyNames,
} from "./native-contract.mjs";
import { architectureFailures } from "./native-architecture-contract.mjs";
import {
  filesBelow,
  mergeNativeInspectionPaths,
  trackedFiles,
} from "./native-files.mjs";
import {
  createNativePackageGate,
  nativePackageTestSupport,
} from "./native-package.mjs";
import {
  commandFailure,
  productiveRustEnv as createProductiveRustEnv,
  runNativeGateCli,
  sanitizeOutput,
} from "./native-process.mjs";
import { createExactHeadGuard } from "./native-repository.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(repositoryRoot, "native");
const frontendRoot = join(nativeRoot, "frontend");
const targetRoot = join(nativeRoot, "target");
const packageRoot = join(targetRoot, "keiko-native-package");
const stableCargo = ["+1.92.0"];
const ignoredNativeDirectories = new Set([
  "coverage",
  "dist",
  "gen",
  "node_modules",
  "target",
]);

function productiveRustEnv(revision = sourceRevision()) {
  return createProductiveRustEnv(repositoryRoot, revision);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    maxBuffer: 30 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error)
    throw commandFailure(command, args, result);
  if (!options.capture) {
    if (result.stdout) process.stdout.write(sanitizeOutput(result.stdout));
    if (result.stderr) process.stderr.write(sanitizeOutput(result.stderr));
  }
  return options.capture
    ? options.raw
      ? result.stdout
      : result.stdout.trim()
    : "";
}

function sourceRevision() {
  return run("git", ["rev-parse", "HEAD"], { capture: true });
}

function readGit(args) {
  return run("git", args, { capture: true, raw: true });
}

function onMacOs() {
  return process.platform === "darwin";
}

async function ensureFrontendDependencies() {
  for (const path of [
    "node_modules/.bin/tsc",
    "node_modules/.bin/vite",
    "node_modules/.bin/vitest",
  ]) {
    try {
      await readFile(join(frontendRoot, path));
    } catch {
      run("npm", ["--prefix", "native/frontend", "ci", "--ignore-scripts"]);
      return;
    }
  }
}

function cargoMetadata() {
  return JSON.parse(
    run(
      "cargo",
      [
        ...stableCargo,
        "metadata",
        "--locked",
        "--format-version=1",
        "--manifest-path",
        "native/Cargo.toml",
      ],
      {
        capture: true,
      },
    ),
  );
}

async function nativeFiles() {
  const ephemeral = await filesBelow(nativeRoot, ignoredNativeDirectories);
  const tracked = await trackedFiles(
    run("git", ["ls-files", "--stage", "-z", "--", "native/"], {
      capture: true,
      raw: true,
    }),
    repositoryRoot,
    nativeRoot,
  );
  return mergeNativeInspectionPaths(ephemeral, tracked);
}

async function sourceEntries(project) {
  const paths = (await nativeFiles()).filter(
    (path) =>
      /\.(?:rs|ts)$/u.test(path) &&
      project.productiveSourceRoots.some((root) =>
        path.startsWith(join(repositoryRoot, root)),
      ),
  );
  return Promise.all(
    paths.map(async (path) => ({
      path: relative(repositoryRoot, path).split("\\").join("/"),
      text: await readFile(path, "utf8"),
    })),
  );
}

async function projectContract() {
  return JSON.parse(
    await readFile(join(repositoryRoot, "quality/project.json"), "utf8"),
  );
}

async function architecture() {
  const project = await projectContract();
  const paths = (await nativeFiles()).map((path) =>
    relative(repositoryRoot, path).split("\\").join("/"),
  );
  const metadata = cargoMetadata();
  const workspacePackages = metadata.packages.filter(({ id }) =>
    metadata.workspace_members.includes(id),
  );
  const cargoText = await readFile(join(nativeRoot, "Cargo.toml"), "utf8");
  const failures = [
    ...sourceDeclarationFailures(paths, project),
    ...architectureFailures(await sourceEntries(project), project),
    ...manifestFailures({
      cargo: {
        workspace: {
          dependencies: Object.fromEntries(
            workspaceDependencyNames(cargoText).map((name) => [name, true]),
          ),
          members: metadata.workspace_members,
        },
      },
      crates: workspacePackages.map((pkg) => ({
        manifest: {
          dependencies: Object.fromEntries(
            pkg.dependencies
              .filter(({ kind }) => kind === null)
              .map(({ name }) => [name, true]),
          ),
        },
        name: pkg.name,
      })),
      desktopConfig: JSON.parse(
        await readFile(
          join(nativeRoot, "apps/keiko-desktop/tauri.conf.json"),
          "utf8",
        ),
      ),
      frontend: JSON.parse(
        await readFile(join(frontendRoot, "package.json"), "utf8"),
      ),
    }),
  ];
  if (failures.length > 0)
    throw new Error(`Native architecture rejected: ${failures.join(",")}`);
}

async function format() {
  run("cargo", [
    ...stableCargo,
    "fmt",
    "--manifest-path",
    "native/Cargo.toml",
    "--all",
    "--",
    "--check",
  ]);
}

async function lint() {
  await ensureFrontendDependencies();
  run("npm", ["--prefix", "native/frontend", "run", "typecheck"]);
  if (onMacOs())
    run("cargo", [
      ...stableCargo,
      "clippy",
      "--locked",
      "--workspace",
      "--all-targets",
      "--manifest-path",
      "native/Cargo.toml",
      "--",
      "-D",
      "warnings",
    ]);
}

async function build(revision = sourceRevision()) {
  await ensureFrontendDependencies();
  run("npm", ["--prefix", "native/frontend", "run", "build"], {
    env: { KEIKO_NATIVE_SOURCE_REVISION: revision },
  });
  if (onMacOs()) {
    run(
      "cargo",
      [
        ...stableCargo,
        "build",
        "--locked",
        "--manifest-path",
        "native/Cargo.toml",
      ],
      {
        env: productiveRustEnv(revision),
      },
    );
  }
}

async function testNative(revision = sourceRevision()) {
  await ensureFrontendDependencies();
  run("npm", ["--prefix", "native/frontend", "run", "test"], {
    env: { KEIKO_NATIVE_SOURCE_REVISION: revision },
  });
  const contractTests = (await filesBelow(join(nativeRoot, "tests")))
    .filter((path) => path.endsWith(".test.mjs"))
    .map((path) => relative(repositoryRoot, path));
  run("node", ["--test", ...contractTests]);
  if (onMacOs()) {
    run("npm", ["--prefix", "native/frontend", "run", "build"], {
      env: { KEIKO_NATIVE_SOURCE_REVISION: revision },
    });
    run("cargo", [
      ...stableCargo,
      "test",
      "--locked",
      "--workspace",
      "--manifest-path",
      "native/Cargo.toml",
    ]);
  }
}

async function coverageNative() {
  await ensureFrontendDependencies();
  run("npm", ["--prefix", "native/frontend", "run", "coverage"], {
    env: { KEIKO_NATIVE_SOURCE_REVISION: sourceRevision() },
  });
  if (!onMacOs()) return;
  const exclusion = (await projectContract()).coverageExclusions?.[0];
  if (
    exclusion?.path !== "native/apps/keiko-desktop/src/main.rs" ||
    exclusion.evidence !== "acceptance:macos"
  ) {
    throw new Error("Rust coverage exclusion contract rejected");
  }
  const version = run("cargo-llvm-cov", ["llvm-cov", "--version"], {
    capture: true,
  });
  if (version !== "cargo-llvm-cov 0.8.7")
    throw new Error("cargo-llvm-cov version rejected");
  const report = JSON.parse(
    run(
      "cargo",
      [
        "+nightly-2026-07-17",
        "llvm-cov",
        "--locked",
        "--workspace",
        "--all-features",
        "--branch",
        "--json",
        "--summary-only",
        "--ignore-filename-regex",
        exclusion.path,
        "--manifest-path",
        "native/Cargo.toml",
      ],
      { capture: true },
    ),
  );
  const failures = coverageFailures(report);
  if (failures.length > 0) throw new Error(failures.join(","));
}

async function platform() {
  const metadata = cargoMetadata();
  if (!metadata.packages.some(({ name }) => name === "keiko-native-desktop"))
    throw new Error("Declared native package is absent");
  if (onMacOs() && process.arch !== "arm64")
    throw new Error("Authoritative native execution requires macOS arm64");
}

async function security() {
  const project = await projectContract();
  const entries = await sourceEntries(project);
  const failures = sourceSecurityFailures(entries);
  if (failures.length > 0)
    throw new Error(`Native source security rejected: ${failures.join(",")}`);
}

async function signing() {
  const config = JSON.parse(
    await readFile(
      join(nativeRoot, "apps/keiko-desktop/tauri.conf.json"),
      "utf8",
    ),
  );
  if (
    config.identifier !== "dev.oscharko.keiko-native" ||
    config.bundle?.active !== true
  )
    throw new Error("Unsigned package contract is incomplete");
  if (process.env.APPLE_CERTIFICATE || process.env.APPLE_SIGNING_IDENTITY)
    throw new Error("Signing credentials are outside CH-3 authority");
}

export const nativeGateTestSupport = {
  coverageFailures,
  commandFailure,
  mergeNativeInspectionPaths,
  ...nativePackageTestSupport,
  productiveRustEnv,
  sanitizeOutput,
  workspaceDependencyNames,
};

const { acceptance, packageNative } = createNativePackageGate({
  build,
  captureRepositoryState: () => createExactHeadGuard(readGit),
  cargoMetadata,
  filesBelow,
  frontendRoot,
  nativeRoot,
  onMacOs,
  packageRoot,
  repositoryRoot,
  run,
  rustBuildEnv: productiveRustEnv,
  targetRoot,
  testNative,
});

const modes = {
  acceptance,
  architecture,
  build,
  coverage: coverageNative,
  format,
  lint,
  package: packageNative,
  platform,
  security,
  signing,
  test: testNative,
};

export async function main(mode) {
  const command = modes[mode];
  if (command === undefined)
    throw new Error(`Unknown native gate: ${mode ?? "missing"}`);
  await nativeFiles();
  await command();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runNativeGateCli(main, process.argv[2]).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
