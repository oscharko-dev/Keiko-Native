import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { sanitizeOutput } from "./native-process.mjs";

const coverageModules = Object.freeze([
  "contract.mjs",
  "coverage-reporter.mjs",
  "github-api.mjs",
  "github-reference.mjs",
  "issue-contract.mjs",
  "issue-readiness-action.mjs",
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

const safeMetadata = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const tokenLikeMetadata = /^[A-Za-z0-9+_=-]{24,}$/u;
const safeDiagnosticCharacters = /^[A-Za-z0-9 .,:;!?()_+=%-]*$/u;
const sensitiveDiagnosticMarker =
  /\b(?:api[-_ ]?key|authorization|bearer|cookie|credential|password|private[-_ ]?key|secret|token)\b/iu;
const tokenLikeDiagnostic =
  /(?:^|[^A-Za-z0-9+_=-])[A-Za-z0-9+_=-]{24,}(?=$|[^A-Za-z0-9+_=-])/u;
const uriSchemeDiagnostic = /\b[A-Za-z][A-Za-z0-9+.-]*:[^ ]/u;
const driveRelativeDiagnostic = /\b[A-Za-z]:[A-Za-z0-9._-]/u;
const filenameDiagnostic =
  /\b[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_+-]+)*\.[A-Za-z][A-Za-z0-9_+-]{0,15}(?::\d+(?::\d+)?)?(?=$|[ .,;!?()])/u;
const redactedDiagnostic = "<redacted-diagnostic>";

function sanitizeDiagnostic(value, maximum, fallback) {
  if (typeof value !== "string") return fallback;
  const sharedSanitized = sanitizeOutput(value);
  if (
    sharedSanitized !== value ||
    !safeDiagnosticCharacters.test(value) ||
    sensitiveDiagnosticMarker.test(value) ||
    tokenLikeDiagnostic.test(value) ||
    uriSchemeDiagnostic.test(value) ||
    driveRelativeDiagnostic.test(value) ||
    filenameDiagnostic.test(value)
  )
    return redactedDiagnostic;
  let sanitized = value.trim();
  if (!sanitized) return fallback;
  if (sanitized.length > maximum)
    sanitized = `${sanitized.slice(0, maximum - 1)}…`;
  return sanitized;
}

function metadata(value) {
  return typeof value === "string" &&
    safeMetadata.test(value) &&
    !sensitiveDiagnosticMarker.test(value) &&
    !tokenLikeMetadata.test(value)
    ? value
    : "unknown";
}

export function failureDiagnostic(data) {
  const error = data?.details?.error;
  const name = sanitizeDiagnostic(data?.name, 120, "(unnamed test)");
  const type = metadata(error?.failureType ?? data?.details?.type);
  const code = metadata(error?.code);
  const message = sanitizeDiagnostic(
    typeof error === "string" ? error : error?.message,
    240,
    "Test failed without a bounded diagnostic.",
  );
  return `✖ ${name} [${type}:${code}] ${message}\n`;
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
    if (event.type === "test:pass" && event.data.nesting === 0)
      yield `✔ ${event.data.name}\n`;
    if (event.type === "test:fail") yield failureDiagnostic(event.data);
    if (event.type === "test:coverage")
      yield `${await writeCoverage(event.data.summary)}\n`;
  }
}
