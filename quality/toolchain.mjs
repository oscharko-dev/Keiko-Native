import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const exactToolchain = Object.freeze({
  node: "24.18.0",
  npm: "11.16.0",
});

export function exactToolchainFailures({
  nodeVersion,
  npmConfig = "engine-strict=true\n",
  npmVersion,
  packageContract,
}) {
  const failures = [];
  if (nodeVersion !== exactToolchain.node) failures.push("node-version");
  if (npmVersion !== exactToolchain.npm) failures.push("npm-version");
  if (npmConfig !== "engine-strict=true\n") failures.push("npm-engine-strict");
  if (
    packageContract?.engines?.node !== exactToolchain.node ||
    packageContract?.engines?.npm !== exactToolchain.npm ||
    packageContract?.packageManager !== `npm@${exactToolchain.npm}`
  )
    failures.push("package-toolchain");
  if (
    !exactDevEngine(
      packageContract?.devEngines?.packageManager,
      "npm",
      exactToolchain.npm,
    ) ||
    !exactDevEngine(
      packageContract?.devEngines?.runtime,
      "node",
      exactToolchain.node,
    ) ||
    Object.keys(packageContract?.devEngines ?? {})
      .toSorted()
      .join(",") !== "packageManager,runtime"
  )
    failures.push("package-dev-engines");
  if (
    !packageContract?.scripts?.quality?.startsWith(
      "node quality/check-toolchain.mjs && ",
    ) ||
    !packageContract?.scripts?.["native:dependencies"]?.startsWith(
      "node quality/check-toolchain.mjs && ",
    )
  )
    failures.push("package-script-guards");
  return failures;
}

function exactDevEngine(value, name, version) {
  return (
    value?.name === name &&
    value?.version === version &&
    value?.onFail === "error" &&
    Object.keys(value).toSorted().join(",") === "name,onFail,version"
  );
}

export function workflowToolchainFailures(workflow) {
  const failures = [];
  const jobs = workflow.split(/(?=^  [a-z0-9-]+:\s*$)/mu);
  for (const job of jobs) {
    const npmConsumer =
      /^\s*- (?:name:.*\n\s+)?run: npm (?:audit|ci|run|sbom)\b/mu;
    if (!npmConsumer.test(job)) continue;
    const firstNpm = job.search(npmConsumer);
    const activationName = job.indexOf("- name: Activate exact npm 11.16.0");
    const activationEnd =
      activationName < 0 ? -1 : job.indexOf("\n      - ", activationName + 1);
    const activation = job.slice(
      activationName,
      activationEnd < 0 ? undefined : activationEnd,
    );
    if (
      activationName < 0 ||
      activationName > firstNpm ||
      !activation.includes("run: |") ||
      !activation.includes("corepack enable npm") ||
      !activation.includes("corepack install --global npm@11.16.0") ||
      !activation.includes("node quality/check-toolchain.mjs") ||
      /^\s+if:/mu.test(activation)
    )
      failures.push("workflow-npm-activation");
    const setup = job.slice(0, Math.max(activationName, 0));
    if (
      !setup.includes("uses: actions/setup-node@") ||
      !setup.includes('node-version: "24.18.0"')
    )
      failures.push("workflow-node-version");
  }
  return failures;
}

export function enforceExactToolchain({
  nodeVersion = process.versions.node,
  npmCommand = process.platform === "win32" ? "npm.cmd" : "npm",
  npmConfigPath = new URL("../.npmrc", import.meta.url),
  packagePath = new URL("../package.json", import.meta.url),
  run = spawnSync,
} = {}) {
  const npm = run(npmCommand, ["--version"], {
    encoding: "utf8",
    maxBuffer: 1024,
    stdio: "pipe",
  });
  const npmVersion =
    npm.status === 0 && !npm.error ? String(npm.stdout).trim() : "unavailable";
  let packageContract;
  let npmConfig;
  try {
    packageContract = JSON.parse(readFileSync(packagePath, "utf8"));
    npmConfig = readFileSync(npmConfigPath, "utf8");
  } catch {
    throw new Error("Exact toolchain rejected package-contract");
  }
  const failures = exactToolchainFailures({
    nodeVersion,
    npmConfig,
    npmVersion,
    packageContract,
  });
  if (failures.length > 0)
    throw new Error(`Exact toolchain rejected ${failures.join(",")}`);
}
