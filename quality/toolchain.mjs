import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import { compareCodeUnits } from "./deterministic-order.mjs";
import {
  governedWorkflowJobFailures,
  inheritedWorkflowControlFailures,
  protectedStepControlFailures,
  workflowJobs,
  workflowStepShapeFailures,
} from "./workflow-structure.mjs";

export const exactToolchain = Object.freeze({
  node: "24.18.0",
  npm: "11.16.0",
});

export function canonicalLineEndings(value) {
  return value.replaceAll("\r\n", "\n");
}

export function exactToolchainFailures({
  nodeVersion,
  npmConfig = "engine-strict=true\n",
  npmVersion,
  packageContract,
}) {
  const failures = [];
  if (nodeVersion !== exactToolchain.node) failures.push("node-version");
  if (npmVersion !== exactToolchain.npm) failures.push("npm-version");
  if (canonicalLineEndings(npmConfig) !== "engine-strict=true\n")
    failures.push("npm-engine-strict");
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
      .toSorted(compareCodeUnits)
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
    Object.keys(value).toSorted(compareCodeUnits).join(",") ===
      "name,onFail,version"
  );
}

export function workflowToolchainFailures(workflow, requiredJobs = []) {
  const failures = [
    ...inheritedWorkflowControlFailures(workflow),
    ...workflowStepShapeFailures(workflow),
    ...governedWorkflowJobFailures(workflow, requiredJobs),
  ];
  for (const { source: job, steps } of workflowJobs(workflow)) {
    if (npmStepHasDirectControl(steps))
      failures.push("workflow-npm-step-control");
    const npmCommandIndexes = runCommands(job)
      .filter(({ command }) => containsNpmExecutable(command))
      .map(({ index }) => index);
    if (npmCommandIndexes.length === 0) continue;
    const firstNpm = Math.min(...npmCommandIndexes);
    const activationName = job.indexOf("- name: Verify exact npm 11.16.0");
    const activationEnd =
      activationName < 0 ? -1 : job.indexOf("\n      - ", activationName + 1);
    const activation = job.slice(
      activationName,
      activationEnd < 0 ? undefined : activationEnd,
    );
    if (
      activationName < 0 ||
      activationName > firstNpm ||
      !validActivationStep(activation)
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

function npmStepHasDirectControl(steps) {
  return steps.some(
    (step) =>
      runCommands(step).some(({ command }) => containsNpmExecutable(command)) &&
      protectedStepControlFailures(step).length > 0,
  );
}

function validActivationStep(activation) {
  return (
    activation.replaceAll("\r", "").trimEnd() ===
    [
      "- name: Verify exact npm 11.16.0",
      "        run: node quality/check-toolchain.mjs",
    ].join("\n")
  );
}

function runCommands(job) {
  const lines = job.split("\n");
  const offsets = [];
  let total = 0;
  for (const line of lines) {
    offsets.push(total);
    total += line.length + 1;
  }
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const parsed = runLine(line);
    if (!parsed) continue;
    const start = offsets[index];
    const style = parsed.value.trim();
    if (/^[|>][+-]?$/u.test(style)) {
      const body = [];
      const indentation = parsed.indentation;
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        const nextIndent = /^\s*/u.exec(next)[0].length;
        if (next.trim() && nextIndent <= indentation) break;
        index += 1;
        body.push(next.trimStart());
      }
      commands.push({ command: body.join("\n"), index: start });
    } else {
      commands.push({ command: unwrapYamlScalar(parsed.value), index: start });
    }
  }
  return commands;
}

function runLine(line) {
  const indentation = line.length - line.trimStart().length;
  let content = line.slice(indentation);
  if (content.startsWith("-")) {
    if (!/^\s/u.test(content[1] ?? "")) return undefined;
    content = content.slice(1).trimStart();
  }
  if (!content.startsWith("run:")) return undefined;
  return { indentation, value: content.slice("run:".length).trimStart() };
}

function unwrapYamlScalar(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  )
    return trimmed.slice(1, -1);
  return trimmed;
}

function containsNpmExecutable(command, depth = 0) {
  if (depth > 4) return true;
  for (const nested of commandSubstitutions(command))
    if (containsNpmExecutable(nested, depth + 1)) return true;
  const tokens = shellTokens(command);
  if (
    tokens.some(
      (token) => !token.operator && containsLexicalNpmToken(token.value),
    )
  )
    return true;
  let expectsCommand = true;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.operator) {
      expectsCommand = true;
      continue;
    }
    if (!expectsCommand) continue;
    const normalized = token.value.toLowerCase();
    if (assignment(normalized) || commandPrefix(normalized)) continue;
    if (/^(?:npm|npx)(?:\.cmd)?$/u.test(normalized)) return true;
    if (
      /^(?:ba|z|c|k)?sh$|^(?:power)?pwsh$|^powershell(?:\.exe)?$|^cmd(?:\.exe)?$/u.test(
        normalized,
      )
    ) {
      const flagIndex = tokens.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index &&
          !candidate.operator &&
          /^(?:-c|-lc|-command|\/c)$/iu.test(candidate.value),
      );
      if (flagIndex >= 0) {
        const script = tokens[flagIndex + 1]?.value;
        if (!script || /\$(?!\()/u.test(script)) return true;
        if (containsNpmExecutable(script, depth + 1)) return true;
      }
    }
    expectsCommand = false;
  }
  return false;
}

function containsLexicalNpmToken(value) {
  return value
    .split(/[^A-Za-z0-9_.-]+/u)
    .some((token) => /^(?:npm|npx)(?:\.cmd)?$/iu.test(token));
}

function commandSubstitutions(command) {
  let singleQuoted = false;
  let visible = "";
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "'" && command[index - 1] !== "\\") {
      singleQuoted = !singleQuoted;
      visible += " ";
    } else visible += singleQuoted ? " " : character;
  }
  return [...visible.matchAll(/\$\(([^)]*)\)|`([^`]*)`/gu)].map(
    (match) => match[1] ?? match[2],
  );
}

function assignment(value) {
  return (
    /^[a-z_][a-z0-9_]*=/iu.test(value) ||
    /^\$env:[a-z_][a-z0-9_]*=/iu.test(value)
  );
}

function commandPrefix(value) {
  return new Set([
    "!",
    "&",
    "call",
    "command",
    "do",
    "env",
    "exec",
    "if",
    "nohup",
    "sudo",
    "then",
    "time",
    "until",
    "while",
  ]).has(value);
}

function shellTokens(command) {
  const tokens = [];
  let value = "";
  let quote;
  const emit = () => {
    if (value) tokens.push({ operator: false, value });
    value = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = undefined;
      else if (
        character === "\\" &&
        quote === '"' &&
        index + 1 < command.length
      )
        value += command[++index];
      else value += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && value === "") {
      while (index < command.length && command[index] !== "\n") index += 1;
      emit();
      tokens.push({ operator: true, value: "\n" });
      continue;
    }
    if (/\s/u.test(character)) {
      emit();
      if (character === "\n") tokens.push({ operator: true, value: "\n" });
      continue;
    }
    if (";|&()".includes(character)) {
      emit();
      if (
        (character === "|" || character === "&") &&
        command[index + 1] === character
      )
        index += 1;
      tokens.push({ operator: true, value: character });
      continue;
    }
    value += character;
  }
  emit();
  return tokens;
}

export function enforceExactToolchain({
  execPath = process.execPath,
  nodeVersion = process.versions.node,
  npmConfigPath = new URL("../.npmrc", import.meta.url),
  packagePath = new URL("../package.json", import.meta.url),
  platform = process.platform,
  readFile = readFileSync,
  realpath = realpathSync,
  run = spawnSync,
  stat = statSync,
} = {}) {
  let node;
  let npmCli;
  try {
    node = realpath(execPath);
    if (!isAbsolute(node) || !stat(node).isFile()) throw new Error();
    const prefix = dirname(node);
    const npmRoot = realpath(
      platform === "win32"
        ? join(prefix, "node_modules/npm")
        : join(prefix, "../lib/node_modules/npm"),
    );
    npmCli = realpath(join(npmRoot, "bin/npm-cli.js"));
    const npmPackage = JSON.parse(
      readFile(join(npmRoot, "package.json"), "utf8"),
    );
    const inside = relative(npmRoot, npmCli);
    if (
      !stat(npmCli).isFile() ||
      inside === "" ||
      inside.startsWith("..") ||
      isAbsolute(inside) ||
      npmPackage.name !== "npm" ||
      npmPackage.version !== exactToolchain.npm ||
      npmPackage.bin?.npm !== "bin/npm-cli.js"
    )
      throw new Error();
  } catch {
    throw new Error("Exact toolchain rejected bundled-npm");
  }
  const npm = run(node, [npmCli, "--version"], {
    encoding: "utf8",
    env: {},
    maxBuffer: 1024,
    shell: false,
    stdio: "pipe",
  });
  const npmVersion =
    npm.status === 0 && !npm.error ? String(npm.stdout).trim() : "unavailable";
  let packageContract;
  let npmConfig;
  try {
    packageContract = JSON.parse(readFile(packagePath, "utf8"));
    npmConfig = readFile(npmConfigPath, "utf8");
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
