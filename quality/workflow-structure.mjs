import { governedWorkflowJobs } from "./workflow-job-contracts.mjs";

const jobBoundary = /(?=^  [A-Za-z0-9_-]+:\s*$)/mu;
const stepBoundary = /(?=^      - )/mu;
const safeEnvironment = Object.freeze({ KEIKO_NATIVE_REQUIRE_MACOS: "1" });

export function workflowJobs(workflow) {
  const normalized = workflow.replaceAll("\r", "");
  const marker = /^jobs:\s*$/mu.exec(normalized);
  if (!marker) return [];
  return normalized
    .slice(marker.index + marker[0].length)
    .split(jobBoundary)
    .flatMap((source) => {
      const id = /^  ([A-Za-z0-9_-]+):\s*$/mu.exec(source)?.[1];
      return id ? [{ id, source, steps: workflowSteps(source) }] : [];
    });
}

export function workflowSteps(job) {
  const marker = /^    steps:\s*$/mu.exec(job);
  if (!marker) return [];
  return job
    .slice(marker.index + marker[0].length)
    .split(stepBoundary)
    .filter((source) => /^      - /u.test(source))
    .map((source) => source.trimEnd());
}

export function inheritedWorkflowControlFailures(workflow) {
  const normalized = workflow.replaceAll("\r", "");
  const failures = [];
  if (hasNonBareMappingKey(normalized, 0)) failures.push("workflow-key-shape");
  if (hasMappingKey(normalized, 0, "continue-on-error"))
    failures.push("workflow-continue-on-error");
  if (hasMappingKey(normalized, 0, "defaults"))
    failures.push("workflow-defaults");
  if (hasMappingKey(normalized, 0, "env"))
    failures.push("workflow-environment");
  for (const { source } of workflowJobs(normalized)) {
    if (hasNonBareMappingKey(source, 4))
      failures.push("workflow-job-key-shape");
    if (hasMappingKey(source, 4, "continue-on-error"))
      failures.push("workflow-job-continue-on-error");
    if (hasMappingKey(source, 4, "defaults"))
      failures.push("workflow-job-defaults");
    if (hasMappingKey(source, 4, "env"))
      failures.push("workflow-job-environment");
  }
  return failures;
}

export function protectedStepControlFailures(step) {
  const failures = [];
  if (!canonicalStepShape(step)) failures.push("shape");
  const normalized = step.replace(/^      - /u, "        ");
  if (
    ["continue-on-error", "if", "shell", "working-directory"].some((key) =>
      hasMappingKey(normalized, 8, key),
    )
  )
    failures.push("control");
  const environment = literalStepEnvironment(step);
  if (!environment.valid) failures.push("environment");
  else if (
    Object.entries(environment.entries).some(
      ([name, value]) => safeEnvironment[name] !== value,
    )
  )
    failures.push("environment");
  return failures;
}

export function workflowStepShapeFailures(workflow) {
  return workflowJobs(workflow).some(({ steps }) =>
    steps.some((step) => !canonicalStepShape(step)),
  )
    ? ["workflow-step-shape"]
    : [];
}

export function governedWorkflowJobFailures(workflow, requiredJobs = []) {
  const failures = [];
  const jobs = workflowJobs(workflow);
  for (const id of requiredJobs) {
    if (!jobs.some((job) => job.id === id))
      failures.push(`workflow-job-contract-missing-${id}`);
  }
  for (const { id, source } of jobs) {
    const expected = governedWorkflowJobs[id];
    if (!expected) continue;
    if (source.trimEnd() !== expected)
      failures.push(`workflow-job-contract-${id}`);
  }
  return failures;
}

export function nativeMatrixCommandFailures(workflow, commands) {
  const matrix = workflowJobs(workflow).find(
    ({ id }) => id === "native-matrix",
  );
  if (!matrix) return ["Native CI command steps require native-matrix."];
  const failures = [];
  const positions = [];
  for (const command of commands) {
    const invocation = `npm run ${command}`;
    const references = occurrences(matrix.source, invocation);
    const matchingSteps = matrix.steps.filter((step) =>
      step.includes(invocation),
    );
    const expected = canonicalCommandStep(command);
    if (
      references.length !== 1 ||
      matchingSteps.length !== 1 ||
      matchingSteps[0] !== expected
    )
      failures.push(`Native CI command step must be exact once: ${command}.`);
    positions.push(references[0] ?? -1);
  }
  if (
    positions.some(
      (position, index) =>
        position < 0 || (index > 0 && position <= positions[index - 1]),
    )
  )
    failures.push("Native CI command steps must retain canonical order.");
  return failures;
}

function canonicalCommandStep(command) {
  if (command !== "acceptance:macos") return `      - run: npm run ${command}`;
  return [
    "      - run: npm run acceptance:macos",
    "        env:",
    '          KEIKO_NATIVE_REQUIRE_MACOS: "1"',
  ].join("\n");
}

function canonicalStepShape(step) {
  const lines = step.replaceAll("\r", "").trimEnd().split("\n");
  if (!/^      - [A-Za-z][A-Za-z0-9-]*:(?:\s.*)?$/u.test(lines[0]))
    return false;
  return lines.slice(1).every((line) => {
    if (!line.trim()) return true;
    const indentation = /^\s*/u.exec(line)[0].length;
    if (indentation < 8) return false;
    return (
      indentation !== 8 ||
      /^        [A-Za-z][A-Za-z0-9-]*:(?:\s.*)?$/u.test(line)
    );
  });
}

function hasMappingKey(source, indentation, expected) {
  const prefix = " ".repeat(indentation);
  return source.split("\n").some((line) => {
    if (!line.startsWith(prefix) || line[indentation] === " ") return false;
    const rest = line.slice(indentation);
    const colon = rest.indexOf(":");
    if (colon < 0) return false;
    return semanticMappingKey(rest.slice(0, colon)) === expected;
  });
}

function hasNonBareMappingKey(source, indentation) {
  const prefix = " ".repeat(indentation);
  return source.split("\n").some((line) => {
    if (!line.startsWith(prefix) || line[indentation] === " ") return false;
    const rest = line.slice(indentation);
    const colon = rest.indexOf(":");
    if (colon < 0) return false;
    return !/^[A-Za-z][A-Za-z0-9-]*$/u.test(rest.slice(0, colon).trim());
  });
}

function semanticMappingKey(source) {
  let key = source.trim().replace(/^\?\s*/u, "");
  key = key.replace(/^!(?:<[^>]+>|\S+)\s+/u, "");
  const quoted = /^(?:"([^"\\]*)"|'([^']*)')$/u.exec(key);
  return quoted ? (quoted[1] ?? quoted[2]) : key;
}

function occurrences(source, value) {
  const positions = [];
  for (let index = source.indexOf(value); index >= 0; ) {
    positions.push(index);
    index = source.indexOf(value, index + value.length);
  }
  return positions;
}

function literalStepEnvironment(step) {
  const normalized = step.replace(/^      - /u, "        ");
  const lines = normalized.split("\n");
  const indexes = lines.flatMap((line, index) =>
    /^        env:/u.test(line) ? [index] : [],
  );
  if (indexes.length === 0) return { entries: {}, valid: true };
  if (indexes.length !== 1) return { entries: {}, valid: false };
  const index = indexes[0];
  const value = lines[index].slice("        env:".length).trim();
  if (value) return literalFlowEnvironment(value);
  const entries = {};
  let count = 0;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (!line.trim()) continue;
    if (/^        \S/u.test(line)) break;
    const match = /^          ([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/u.exec(line);
    if (!match || entries[match[1]] !== undefined)
      return { entries, valid: false };
    const literal = literalValue(match[2]);
    if (literal === undefined) return { entries, valid: false };
    entries[match[1]] = literal;
    count += 1;
  }
  return { entries, valid: count > 0 };
}

function literalFlowEnvironment(value) {
  if (!value.startsWith("{") || !value.endsWith("}"))
    return { entries: {}, valid: false };
  const body = value.slice(1, -1).trim();
  if (!body) return { entries: {}, valid: false };
  const entries = {};
  for (const field of body.split(",")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.+?)\s*$/u.exec(field);
    if (!match || entries[match[1]] !== undefined)
      return { entries, valid: false };
    const literal = literalValue(match[2]);
    if (literal === undefined) return { entries, valid: false };
    entries[match[1]] = literal;
  }
  return { entries, valid: true };
}

function literalValue(value) {
  const quoted = /^(?:"([^"\\]*)"|'([^']*)')$/u.exec(value);
  if (quoted) return quoted[1] ?? quoted[2];
  return /^[A-Za-z0-9._/-]+$/u.test(value) ? value : undefined;
}
