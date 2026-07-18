import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  architectureFailures,
  manifestFailures,
  redactDiagnostic,
  redactionMatches,
  sourceDeclarationFailures,
} from "./native-contract.mjs";
import {
  createNativePackageGate,
  nativePackageTestSupport,
} from "./native-package.mjs";

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

function sanitizeOutput(value) {
  return value
    .replaceAll(/\/Users\/[^/\s]+/gu, "<redacted-path>")
    .replaceAll(/\/home\/[^/\s]+/gu, "<redacted-path>")
    .replaceAll(/[A-Z]:\\Users\\[^\\\s]+/gu, "<redacted-path>");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    maxBuffer: 30 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args[0] ?? ""} failed`);
  if (!options.capture) {
    if (result.stdout) process.stdout.write(sanitizeOutput(result.stdout));
    if (result.stderr) process.stderr.write(sanitizeOutput(result.stderr));
  }
  return options.capture ? result.stdout.trim() : "";
}

function sourceRevision() {
  return run("git", ["rev-parse", "HEAD"], { capture: true });
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

async function filesBelow(root, ignored = new Set()) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path, ignored)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function coverageFailures(report) {
  const totals = report.data?.[0]?.totals;
  return ["branches", "functions", "lines", "regions"]
    .filter((metric) => (totals?.[metric]?.percent ?? 0) < 85)
    .map((metric) => `Native ${metric} coverage is below 85 percent`);
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
  return filesBelow(nativeRoot, ignoredNativeDirectories);
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

function workspaceDependencyNames(text) {
  const section =
    text.split("[workspace.dependencies]")[1]?.split(/^\[/mu)[0] ?? "";
  return [...section.matchAll(/^([A-Za-z0-9_-]+)\s*=/gmu)].map(
    (match) => match[1],
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

async function build() {
  await ensureFrontendDependencies();
  run("npm", ["--prefix", "native/frontend", "run", "build"]);
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
        env: { KEIKO_NATIVE_SOURCE_REVISION: sourceRevision() },
      },
    );
  }
}

async function testNative() {
  await ensureFrontendDependencies();
  run("npm", ["--prefix", "native/frontend", "run", "test"]);
  const contractTests = (await filesBelow(join(nativeRoot, "tests")))
    .filter((path) => path.endsWith(".test.mjs"))
    .map((path) => relative(repositoryRoot, path));
  run("node", ["--test", ...contractTests]);
  if (onMacOs()) {
    run("npm", ["--prefix", "native/frontend", "run", "build"]);
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
  run("npm", ["--prefix", "native/frontend", "run", "coverage"]);
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
  const encoded = entries.map(({ text }) => text).join("\n");
  if (redactionMatches(encoded).length > 0)
    throw new Error("Native source contains sensitive material");
  if (/tauri-plugin-(?:shell|fs|http|process|updater)/u.test(encoded))
    throw new Error("Native source exposes a prohibited generic capability");
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
  ...nativePackageTestSupport,
  sanitizeOutput,
  workspaceDependencyNames,
};

const { acceptance, packageNative } = createNativePackageGate({
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
  await command();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => {
    console.error(redactDiagnostic(error.message));
    process.exitCode = 1;
  });
}
