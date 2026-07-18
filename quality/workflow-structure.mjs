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
  return job
    .split(stepBoundary)
    .filter((source) => /^      - /u.test(source))
    .map((source) => source.trimEnd());
}

export function inheritedWorkflowControlFailures(workflow) {
  const normalized = workflow.replaceAll("\r", "");
  const failures = [];
  if (/^defaults:/mu.test(normalized)) failures.push("workflow-defaults");
  if (/^env:/mu.test(normalized)) failures.push("workflow-environment");
  for (const { source } of workflowJobs(normalized)) {
    if (/^    continue-on-error:/mu.test(source))
      failures.push("workflow-job-continue-on-error");
    if (/^    defaults:/mu.test(source)) failures.push("workflow-job-defaults");
    if (/^    env:/mu.test(source)) failures.push("workflow-job-environment");
  }
  return failures;
}

export function protectedStepControlFailures(step) {
  const failures = [];
  if (
    /^(?:      - |        )(?:continue-on-error|if|shell|working-directory):/mu.test(
      step,
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
