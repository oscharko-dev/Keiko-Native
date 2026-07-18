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
  const jobs = workflow.split(/(?=^  [A-Za-z0-9_-]+:\s*$)/mu);
  for (const job of jobs) {
    const firstNpm = runCommands(job)
      .filter(({ command }) => containsNpmExecutable(command))
      .map(({ index }) => index)
      .toSorted((left, right) => left - right)[0];
    if (firstNpm === undefined) continue;
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
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/u.exec(line);
    if (!match) continue;
    const start = offsets[index];
    const style = match[2].trim();
    if (/^[|>][+-]?$/u.test(style)) {
      const body = [];
      const indentation = match[1].length;
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        const nextIndent = /^\s*/u.exec(next)[0].length;
        if (next.trim() && nextIndent <= indentation) break;
        index += 1;
        body.push(next.trimStart());
      }
      commands.push({ command: body.join("\n"), index: start });
    } else {
      commands.push({ command: unwrapYamlScalar(match[2]), index: start });
    }
  }
  return commands;
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
