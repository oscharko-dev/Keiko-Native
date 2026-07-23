import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

const coverageModules = Object.freeze([
  "deterministic-order.mjs",
  "git-integrity.mjs",
  "contract.mjs",
  "coverage-reporter.mjs",
  "epic-merge-broker-capability.mjs",
  "epic-merge-broker-effect.mjs",
  "epic-merge-broker-receipt-crypto.mjs",
  "epic-merge-broker-receipt.mjs",
  "epic-merge-broker.mjs",
  "github-api.mjs",
  "github-reference.mjs",
  "issue-contract.mjs",
  "issue-lifecycle.mjs",
  "issue-lifecycle-action.mjs",
  "issue-lifecycle-readiness.mjs",
  "issue-readiness-action.mjs",
  "lifecycle-generation.mjs",
  "lifecycle-handoff-generation.mjs",
  "lifecycle-handoff-publication.mjs",
  "lifecycle-handoff.mjs",
  "merge-group.mjs",
  "internal-release.mjs",
  "internal-release-workflow.mjs",
  "attestation-policy.mjs",
  "iso-normalization.mjs",
  "markdown-contract.mjs",
  "markdown-policy.mjs",
  "native-architecture-contract.mjs",
  "native-contract.mjs",
  "native-dependencies.mjs",
  "native-files.mjs",
  "native-gate.mjs",
  "native-lifecycle.mjs",
  "native-package.mjs",
  "native-package-policy.mjs",
  "native-process.mjs",
  "native-repository.mjs",
  "native-snapshot.mjs",
  "native-snapshot-runtime.mjs",
  "pr-contract.mjs",
  "pr-contract-action.mjs",
  "publication-candidate.mjs",
  "publication-contract-schema.mjs",
  "publication-contract.mjs",
  "repository-contract-chain.mjs",
  "repository-contract.mjs",
  "repository-controls-evidence.mjs",
  "repository-controls-policy.mjs",
  "repository-controls-probe.mjs",
  "repository-controls-probe-denials.mjs",
  "repository-controls-probe-identities.mjs",
  "repository-controls-probe-scenarios.mjs",
  "repository-controls-probes.mjs",
  "repository-controls-readback.mjs",
  "repository-controls.mjs",
  "release-contract.mjs",
  "release-evidence.mjs",
  "release-inputs.mjs",
  "release-io.mjs",
  "release-mounted.mjs",
  "release-native-fs.mjs",
  "release-owned-fs.mjs",
  "release-system.mjs",
  "release-verify.mjs",
  "update-metadata.mjs",
  "native-fs.mjs",
  "native-package-io.mjs",
  "native-package-publication.mjs",
  "toolchain.mjs",
  "workflow-job-contracts.mjs",
  "workflow-structure.mjs",
]);

export const canonicalCoverageCommand = [
  "node --test",
  "--test-concurrency=1",
  "--experimental-test-coverage",
  ...coverageModules.map(
    (module) => `--test-coverage-include=quality/${module}`,
  ),
  "--test-coverage-branches=85",
  "--test-coverage-functions=85",
  "--test-coverage-lines=85",
  "--test-reporter=./quality/coverage-reporter.mjs",
  "quality/*.test.mjs",
].join(" ");

const failureTypes = new Set(["testCodeFailure"]);
const errorCodes = new Set(["ERR_ASSERTION", "ERR_TEST_FAILURE"]);

function metadata(value, catalog) {
  return typeof value === "string" && catalog.has(value) ? value : "unknown";
}

export function failureDiagnostic(data) {
  const error = data?.details?.error;
  const type = metadata(
    error?.failureType ?? data?.details?.type,
    failureTypes,
  );
  const code = metadata(error?.code, errorCodes);
  return `✖ test failed [${type}:${code}]. Rerun npm test locally with the standard reporter.\n`;
}

function repositoryPath(workingDirectory, path) {
  const value = relative(workingDirectory, path);
  if (value.startsWith("..") || isAbsolute(value))
    throw new Error("Coverage source escaped the repository.");
  return value.split(sep).join("/");
}

function functionRecords(functions) {
  const definitions = [];
  const counts = [];
  for (const [index, entry] of functions.entries()) {
    const name = `${entry.name || "(anonymous)"}@${String(entry.line)}:${String(index)}`;
    definitions.push(`FN:${String(entry.line)},${name}`);
    counts.push(`FNDA:${String(entry.count)},${name}`);
  }
  return [...definitions, `FNF:${String(functions.length)}`, ...counts];
}

function branchRecords(branches) {
  return branches.map(
    (entry, index) =>
      `BRDA:${String(entry.line)},0,${String(index)},${String(entry.count)}`,
  );
}

function lineRecords(lines) {
  return lines.map(
    (entry) => `DA:${String(entry.line)},${String(entry.count)}`,
  );
}

export function toLcov(summary) {
  return `${summary.files
    .flatMap((file) => [
      "TN:",
      `SF:${repositoryPath(summary.workingDirectory, file.path)}`,
      ...functionRecords(file.functions),
      `FNH:${String(file.functions.filter((entry) => entry.count > 0).length)}`,
      ...lineRecords(file.lines),
      `LF:${String(file.totalLineCount)}`,
      `LH:${String(file.coveredLineCount)}`,
      ...branchRecords(file.branches),
      `BRF:${String(file.totalBranchCount)}`,
      `BRH:${String(file.coveredBranchCount)}`,
      "end_of_record",
    ])
    .join("\n")}\n`;
}

function percent(value) {
  return value.toFixed(2);
}

export function coverageStatusLine(summary) {
  const totals = summary.totals;
  const thresholds = summary.thresholds;
  const passed =
    totals.coveredLinePercent >= thresholds.line &&
    totals.coveredBranchPercent >= thresholds.branch &&
    totals.coveredFunctionPercent >= thresholds.function;
  return [
    `coverage: ${passed ? "passed" : "failed"}`,
    `lines=${percent(totals.coveredLinePercent)}%`,
    `branches=${percent(totals.coveredBranchPercent)}%`,
    `functions=${percent(totals.coveredFunctionPercent)}%`,
    "statements=line-instrumented",
  ].join(" ");
}

async function writeCoverage(summary) {
  await mkdir("coverage", { recursive: true });
  await writeFile("coverage/lcov.info", toLcov(summary));
  return coverageStatusLine(summary);
}

export default async function* coverageReporter(source) {
  for await (const event of source) {
    if (event.type === "test:fail") yield failureDiagnostic(event.data);
    if (event.type === "test:coverage")
      yield `${await writeCoverage(event.data.summary)}\n`;
  }
}
