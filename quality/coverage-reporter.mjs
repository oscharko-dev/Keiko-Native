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

function stripTerminalSequences(value) {
  return value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)/gu, "")
    .replace(/\u009d[^\u0007\u009c]*(?:\u0007|\u009c|$)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[@-_]/gu, "");
}

function sanitizeDiagnostic(value, maximum, fallback) {
  if (typeof value !== "string") return fallback;
  let sanitized = stripTerminalSequences(sanitizeOutput(value))
    .split(/[\r\n]/u, 1)[0]
    .replace(/[\u0000-\u001f\u007f]/gu, " ");
  if (/^\s*[\[{]/u.test(sanitized)) sanitized = "<redacted-structured-output>";
  else
    sanitized = sanitized
      .replace(
        /\b(authorization|cookie|password|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu,
        "$1=<redacted>",
      )
      .replace(
        /\b(authorization\s*:?[ \t]*bearer)[ \t]+[^\s,;]+/giu,
        "$1 <redacted>",
      )
      .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/giu, "<uri>")
      .replace(
        /\\\\[^\\\s"'<>|]+\\(?:[^\\\s"'<>|]+\\)*[^\\\s"'<>|]+/gu,
        "<path>",
      )
      .replace(/\b[A-Za-z]:[\\/][^\s"'<>|]+/gu, "<path>")
      .replace(/\/(?:[^\s"'<>/]+\/)*[^\s"'<>/]+/gu, "<path>")
      .replace(/<redacted-path>(?:<path>)?/gu, "<path>")
      .replace(/\{[^{}]*\}|\[[^\[\]]*\]/gu, "<redacted-structured-output>")
      .replace(/(["'`])(?:\\.|(?!\1).)*\1/gu, "<value>")
      .replace(/\b[A-Za-z0-9+_=-]{24,}\b/gu, "<redacted>")
      .replace(/\s+/gu, " ")
      .trim();
  if (!sanitized) return fallback;
  if (sanitized.length > maximum)
    sanitized = `${sanitized.slice(0, maximum - 1)}…`;
  return sanitized;
}

function metadata(value) {
  return typeof value === "string" &&
    safeMetadata.test(value) &&
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
