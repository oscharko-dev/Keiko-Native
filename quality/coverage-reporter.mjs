import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

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

async function writeCoverage(summary) {
  await mkdir("coverage", { recursive: true });
  await writeFile("coverage/lcov.info", toLcov(summary));
  const totals = summary.totals;
  return [
    "coverage: passed",
    `lines=${percent(totals.coveredLinePercent)}%`,
    `branches=${percent(totals.coveredBranchPercent)}%`,
    `functions=${percent(totals.coveredFunctionPercent)}%`,
    "statements=line-instrumented",
  ].join(" ");
}

export default async function* coverageReporter(source) {
  for await (const event of source) {
    if (event.type === "test:pass" && event.data.nesting === 0)
      yield `✔ ${event.data.name}\n`;
    if (event.type === "test:fail") yield `✖ ${event.data.name}\n`;
    if (event.type === "test:coverage")
      yield `${await writeCoverage(event.data.summary)}\n`;
  }
}
