import { access, readFile, readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

const sourceSpecificationIdentity = {
  date: "2026-07-15",
  document: "Keiko-Native-Fachkonzept.md",
  repositoryAccess: "private-external",
  sha256: "d77a78fb79fc1de882487195d3f2295936f24a34e6bc0579106ad06104737a98",
  version: "0.6",
};

const requiredFiles = [
  ".gitar/review/00-governance-and-delivery.md",
  ".gitar/review/10-security-and-trust-boundaries.md",
  ".gitar/review/20-native-architecture-quality-and-evidence.md",
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  ".github/ISSUE_TEMPLATE/decision_evaluation.md",
  ".github/ISSUE_TEMPLATE/defect_finding.md",
  ".github/ISSUE_TEMPLATE/epic.md",
  ".github/ISSUE_TEMPLATE/feature_task.md",
  ".github/pull_request_template.md",
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/dependency-review.yml",
  ".github/workflows/issue-lifecycle.yml",
  ".github/workflows/issue-readiness.yml",
  ".github/workflows/mutation-security.yml",
  ".github/workflows/osv-scanner.yml",
  ".github/workflows/pr-contract.yml",
  ".github/zizmor.yml",
  ".markdown-quality.json",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/engineering/code-quality-standard.md",
  "docs/planning/agent-planning-baseline.md",
  "docs/product/source-baseline.md",
  "docs/qa/issue-lifecycle.md",
  "docs/qa/repository-activation.md",
  "package.json",
  "quality/github-api.mjs",
  "quality/github-reference.mjs",
  "quality/issue-contract.mjs",
  "quality/issue-lifecycle-action.mjs",
  "quality/issue-lifecycle-readiness.mjs",
  "quality/issue-lifecycle.mjs",
  "quality/issue-lifecycle.test.mjs",
  "quality/issue-readiness-action.mjs",
  "quality/markdown-contract.mjs",
  "quality/pr-contract-action.mjs",
  "quality/pr-contract.mjs",
  "socket.yml",
  "sonar-project.properties",
];

const expectedWorkflowChecks = [
  "name: ci",
  "name: actionlint",
  "name: Verify pinned action SHAs",
  "name: zizmor",
  "name: Build, scan, SBOM, smoke",
  "name: native",
];

const epicPullRequestWorkflows = [
  "ci.yml",
  "codeql.yml",
  "dependency-review.yml",
  "osv-scanner.yml",
];
const epicPushWorkflows = ["ci.yml", "codeql.yml", "osv-scanner.yml"];

const issueReadinessMarkers = [
  "types: [closed, edited, labeled, reopened, unlabeled]",
  "name: Validate implementation readiness",
  "issues: write",
  "pull-requests: read",
  "statuses: write",
  "node quality/issue-readiness-action.mjs",
];

const issueLifecycleTriggerTypes = [
  "assigned",
  "closed",
  "edited",
  "labeled",
  "reopened",
  "unassigned",
  "unlabeled",
];

const issueLifecycleMarkers = [
  "name: Issue lifecycle",
  "group: issue-lifecycle-${{ github.event.issue.number }}",
  "ref: dev",
  "persist-credentials: false",
  "KEIKO_ISSUE_LIFECYCLE_ACTIVATION: disabled",
  "node quality/issue-lifecycle-action.mjs",
];

const issueLifecyclePermissionMarkers = [
  "permissions: {}",
  "    permissions:",
  "      contents: read",
  "      issues: read",
  "      pull-requests: read",
];

const pullRequestContractMarkers = [
  "types:",
  "opened",
  "edited",
  "reopened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
  "name: Evaluate trusted PR metadata",
  "ref: dev",
  "statuses: write",
  "node quality/pr-contract-action.mjs",
];

const canonicalLifecycleStates = Object.freeze([
  "status: new",
  "status: triaged",
  "status: ready",
  "status: in progress",
  "status: pr open",
  "status: ready for human review",
  "status: blocked",
  "status: waiting for user",
  "status: done",
]);

const issueTemplateFiles = [
  ".github/ISSUE_TEMPLATE/decision_evaluation.md",
  ".github/ISSUE_TEMPLATE/defect_finding.md",
  ".github/ISSUE_TEMPLATE/epic.md",
  ".github/ISSUE_TEMPLATE/feature_task.md",
];

const lifecycleCoverageIncludes = [
  "quality/issue-lifecycle.mjs",
  "quality/issue-lifecycle-readiness.mjs",
  "quality/issue-lifecycle-action.mjs",
];

const productiveExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".m",
  ".mm",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
]);

const ignoredDirectories = new Set([".git", "coverage", "node_modules"]);
const ignoredProductRoots = new Set([".github", "quality"]);
const requiredTargetCommands = [
  "architecture",
  "build",
  "coverage",
  "package",
  "security",
  "test",
];

export function isSafeRepositoryPath(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._/-]+$/u.test(value) &&
    !value.startsWith("/") &&
    !value.split("/").includes("..")
  );
}

export function normalizeRepositoryPath(value, pathSeparator = sep) {
  return value.split(pathSeparator).join("/");
}

export function validateNativeTarget(target, productiveSourceRoots) {
  const failures = [];
  if (
    typeof target?.name !== "string" ||
    !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(target.name)
  )
    failures.push("Native target name is invalid.");
  if (
    typeof target?.language !== "string" ||
    !/^[a-z][a-z0-9+-]{0,31}$/u.test(target.language)
  )
    failures.push("Native target language is invalid.");
  if (
    !isSafeRepositoryPath(target?.sourceRoot) ||
    !productiveSourceRoots.includes(target.sourceRoot)
  )
    failures.push(
      "Native target sourceRoot must name a declared repository source root.",
    );
  if (
    !Array.isArray(target?.platforms) ||
    target.platforms.length === 0 ||
    target.platforms.some(
      (platform) => !["linux", "macos", "windows"].includes(platform),
    ) ||
    new Set(target.platforms).size !== target.platforms.length
  ) {
    failures.push(
      "Native target platforms must be a non-empty supported platform list.",
    );
  }
  for (const command of requiredTargetCommands) {
    if (!/^[a-z0-9][a-z0-9:_-]*$/u.test(target?.commands?.[command] ?? ""))
      failures.push(`Native target command is missing: ${command}.`);
  }
  return failures;
}

function productiveManifestFailures(manifest) {
  if (manifest.phase !== "productive") return [];
  const roots = manifest.productiveSourceRoots;
  const targets = manifest.nativeTargets;
  if (roots.length === 0 || targets.length === 0)
    return [
      "Productive projects must declare source roots and native targets.",
    ];
  const failures = [];
  if (
    roots.some((root) => !isSafeRepositoryPath(root)) ||
    new Set(roots).size !== roots.length
  )
    failures.push(
      "Productive source roots must be unique repository-relative paths.",
    );
  failures.push(
    ...targets.flatMap((target) => validateNativeTarget(target, roots)),
  );
  const targetedRoots = new Set(targets.map((target) => target?.sourceRoot));
  if (roots.some((root) => !targetedRoots.has(root)))
    failures.push(
      "Every productive source root must belong to a declared native target.",
    );
  return failures;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function validateManifest(manifest) {
  const failures = [];
  if (manifest?.schemaVersion !== 1)
    failures.push("Unsupported quality manifest schema.");
  if (manifest?.qualityProfile !== "keiko-native-bootstrap-v1")
    failures.push("The Keiko Native bootstrap quality profile is required.");
  if (!new Set(["bootstrap", "productive"]).has(manifest?.phase))
    failures.push("Project phase must be bootstrap or productive.");
  if (manifest?.baseBranch !== "dev")
    failures.push("The protected base branch must be dev.");
  for (const [field, expected] of Object.entries(sourceSpecificationIdentity)) {
    if (manifest?.sourceSpecification?.[field] !== expected)
      failures.push(`The governed source Fachkonzept ${field} is invalid.`);
  }
  if (!Array.isArray(manifest?.productiveSourceRoots))
    failures.push("productiveSourceRoots must be an array.");
  if (!Array.isArray(manifest?.nativeTargets))
    failures.push("nativeTargets must be an array.");
  for (const metric of ["branches", "functions", "lines", "statements"]) {
    if (manifest?.minimumCoverage?.[metric] !== 85)
      failures.push(`Minimum ${metric} coverage must remain 85.`);
  }
  if (
    Array.isArray(manifest?.productiveSourceRoots) &&
    Array.isArray(manifest?.nativeTargets)
  )
    failures.push(...productiveManifestFailures(manifest));
  return failures;
}

export function isProductiveSource(path) {
  const normalized = normalizeRepositoryPath(path);
  const root = normalized.split("/")[0];
  return (
    !ignoredProductRoots.has(root) &&
    productiveExtensions.has(extname(normalized))
  );
}

export function unpinnedActionReferences(workflow) {
  return workflow
    .split("\n")
    .map(actionReference)
    .filter((reference) => reference !== undefined)
    .filter(
      (reference) =>
        !reference.startsWith("./") &&
        !reference.startsWith("docker://") &&
        !/@[0-9a-f]{40}$/u.test(reference),
    );
}

export function workflowEventTargetsBranch(workflow, event, branch) {
  const lines = workflow.split(/\r?\n/u);
  const eventStart = lines.findIndex(
    (line) => line === `  ${event}:` || line === `  ${event}: {}`,
  );
  if (eventStart === -1) return false;
  const eventEnd = lines.findIndex(
    (line, index) =>
      index > eventStart && /^ {2}[A-Za-z_][A-Za-z0-9_-]*:/u.test(line),
  );
  const section = lines.slice(
    eventStart + 1,
    eventEnd === -1 ? lines.length : eventEnd,
  );
  return section.some((line) => {
    const candidate = line.trim().replace(/^-\s*/u, "");
    return candidate.replace(/^(["'])(.*)\1$/u, "$2") === branch;
  });
}

function actionReference(line) {
  let candidate = line.trimStart();
  if (candidate.startsWith("-")) candidate = candidate.slice(1).trimStart();
  if (!candidate.startsWith("uses:")) return undefined;
  candidate = candidate.slice("uses:".length).trimStart();
  let end = 0;
  while (
    end < candidate.length &&
    candidate[end] !== "#" &&
    candidate[end]?.trim() !== ""
  )
    end += 1;
  if (end === 0) return undefined;
  const reference = candidate.slice(0, end);
  const quote = reference[0];
  return (quote === '"' || quote === "'") && reference.at(-1) === quote
    ? reference.slice(1, -1)
    : reference;
}

async function repositoryFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await repositoryFiles(root, path)));
    else if (entry.isFile())
      files.push(normalizeRepositoryPath(relative(root, path)));
  }
  return files;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readText(root, files, path) {
  return files.includes(path) ? readFile(join(root, path), "utf8") : "";
}

function unique(values) {
  return [...new Set(values)];
}

function backtickStatusNames(text) {
  return unique(
    [...text.matchAll(/`(status: [^`]+)`/gu)].map((match) => match[1]),
  );
}

function stringArrayConstant(source, name) {
  const pattern = new RegExp(
    `(?:export\\s+)?const\\s+${name}\\s*=\\s*(?:Object\\.freeze\\()?\\s*\\[([\\s\\S]*?)\\]\\s*\\)?;`,
    "u",
  );
  const body = pattern.exec(source)?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

function lifecycleStateProjectionFailures(surface, states) {
  const observed = new Set(states);
  const expected = new Set(canonicalLifecycleStates);
  const missing = canonicalLifecycleStates.filter(
    (state) => !observed.has(state),
  );
  const unexpected = states.filter((state) => !expected.has(state));
  return missing.length === 0 && unexpected.length === 0
    ? []
    : [
        [
          `Lifecycle state projection drift in ${surface}.`,
          missing.length > 0 ? `Missing: ${missing.join(", ")}.` : "",
          unexpected.length > 0
            ? `Unexpected: ${unique(unexpected).join(", ")}.`
            : "",
        ]
          .filter((part) => part !== "")
          .join(" "),
      ];
}

function requiredFileFailures(files) {
  return requiredFiles
    .filter((file) => !files.includes(file))
    .map((file) => `Missing required quality file: ${file}.`);
}

function gitarConfigurationFailures(files) {
  const gitarFiles = files
    .filter((file) => file.startsWith(".gitar/"))
    .toSorted((left, right) => left.localeCompare(right));
  const expectedGitarFiles = requiredFiles
    .filter((file) => file.startsWith(".gitar/"))
    .toSorted((left, right) => left.localeCompare(right));
  return JSON.stringify(gitarFiles) === JSON.stringify(expectedGitarFiles)
    ? []
    : ["Gitar configuration must contain exactly the governed review lenses."];
}

function privateSourceFileFailures(files) {
  const committedFachkonzeptFiles = files.filter(
    (file) =>
      file !== "docs/product/source-baseline.md" && /fachkonzept/iu.test(file),
  );
  return committedFachkonzeptFiles.length === 0
    ? []
    : [
        "The private source Fachkonzept must not be committed to this repository.",
      ];
}

async function sourceBaselineFailures(root, files) {
  if (!files.includes("docs/product/source-baseline.md")) return [];
  const sourceBaseline = await readFile(
    join(root, "docs/product/source-baseline.md"),
    "utf8",
  );
  return [
    sourceSpecificationIdentity.document,
    sourceSpecificationIdentity.version,
    sourceSpecificationIdentity.date,
    sourceSpecificationIdentity.sha256,
    "private external source; the document itself must not be committed",
    "provenance only",
    "Agent Planning Baseline",
    "Planning and implementation agents must be able to perform their work",
  ]
    .filter((marker) => !sourceBaseline.includes(marker))
    .map(
      (marker) =>
        `Private source baseline is missing governed marker: ${marker}.`,
    );
}

async function agentPlanningBaselineFailures(root, files) {
  const path = "docs/planning/agent-planning-baseline.md";
  if (!files.includes(path)) return [];
  const baseline = await readFile(join(root, path), "utf8");
  return [
    "# Keiko Native Agent Planning Baseline",
    "## Authority and planning use",
    "## Global acceptance journeys",
    "## Capability planning packets",
    "## Cross-cutting quality contract",
    "### Desktop acceptance automation",
    "## Decision gates",
    "## Epic-authoring contract",
    "Planning and implementation do not require access to the private source.",
  ]
    .filter((marker) => !baseline.includes(marker))
    .map(
      (marker) =>
        `Agent Planning Baseline is missing governed marker: ${marker}.`,
    );
}

async function codeQualityStandardFailures(root, files) {
  const path = "docs/engineering/code-quality-standard.md";
  if (!files.includes(path)) return [];
  const standard = await readFile(join(root, path), "utf8");
  return [
    "### Desktop test automation ownership",
    "The repository owns the supported test harnesses",
    "Computer Use",
    "A new foundational test framework",
    "The production release artifact contains no",
    "test-only automation capability",
  ]
    .filter((marker) => !standard.includes(marker))
    .map(
      (marker) =>
        `Code Quality Standard is missing governed marker: ${marker}.`,
    );
}

async function lifecycleLinkFailures(root, files) {
  const paths = ["AGENTS.md", ...issueTemplateFiles];
  const results = await Promise.all(
    paths.map(async (path) => ({
      path,
      text: await readText(root, files, path),
    })),
  );
  return results
    .filter((result) => !result.text.includes("docs/qa/issue-lifecycle.md"))
    .map((result) => `Governance lifecycle link missing from ${result.path}.`);
}

async function lifecycleProjectionFailures(root, files) {
  const surfaces = [
    [
      "quality/issue-lifecycle.mjs",
      stringArrayConstant(
        await readText(root, files, "quality/issue-lifecycle.mjs"),
        "LIFECYCLE_STATES",
      ),
    ],
    [
      "quality/issue-lifecycle.test.mjs",
      stringArrayConstant(
        await readText(root, files, "quality/issue-lifecycle.test.mjs"),
        "canonicalStates",
      ),
    ],
    [
      "docs/qa/issue-lifecycle.md",
      backtickStatusNames(
        await readText(root, files, "docs/qa/issue-lifecycle.md"),
      ),
    ],
    [
      "docs/qa/repository-activation.md",
      backtickStatusNames(
        await readText(root, files, "docs/qa/repository-activation.md"),
      ),
    ],
    [
      "AGENTS.md",
      backtickStatusNames(await readText(root, files, "AGENTS.md")),
    ],
  ];
  for (const path of issueTemplateFiles) {
    surfaces.push([
      path,
      backtickStatusNames(await readText(root, files, path)),
    ]);
  }
  return surfaces.flatMap(([surface, states]) =>
    lifecycleStateProjectionFailures(surface, states),
  );
}

async function coverageIncludeFailures(root, files) {
  if (!files.includes("package.json")) return [];
  const packageJson = await readJson(join(root, "package.json"));
  const coverage = packageJson.scripts?.coverage ?? "";
  return lifecycleCoverageIncludes
    .filter(
      (include) => !coverage.includes(`--test-coverage-include=${include}`),
    )
    .map(
      (include) =>
        `Coverage command must include lifecycle control-plane module: ${include}.`,
    );
}

async function sourceRootFailures(root, manifest) {
  const sourceRoots = Array.isArray(manifest?.productiveSourceRoots)
    ? manifest.productiveSourceRoots
    : [];
  const results = await Promise.all(
    sourceRoots.map(async (sourceRoot) => ({
      exists: await exists(join(root, sourceRoot)),
      sourceRoot,
    })),
  );
  return results
    .filter((result) => !result.exists)
    .map((result) => `Declared source root is missing: ${result.sourceRoot}.`);
}

async function contractFailures(root, files, manifest) {
  const productiveSources = files.filter(isProductiveSource);
  const bootstrapFailures =
    manifest?.phase === "bootstrap" && productiveSources.length > 0
      ? [
          "Productive source exists while the project is in bootstrap phase; declare native targets and gates first.",
        ]
      : [];
  const failures = [
    ...requiredFileFailures(files),
    ...gitarConfigurationFailures(files),
    ...validateManifest(manifest),
    ...privateSourceFileFailures(files),
    ...(await sourceBaselineFailures(root, files)),
    ...(await agentPlanningBaselineFailures(root, files)),
    ...(await codeQualityStandardFailures(root, files)),
    ...(await lifecycleLinkFailures(root, files)),
    ...(await lifecycleProjectionFailures(root, files)),
    ...(await coverageIncludeFailures(root, files)),
    ...bootstrapFailures,
    ...(await sourceRootFailures(root, manifest)),
  ];
  return { failures, productiveSources };
}

async function productiveCommandFailures(root, ci, manifest) {
  if (
    manifest?.phase !== "productive" ||
    !Array.isArray(manifest.nativeTargets)
  )
    return [];
  const packageJson = await readJson(join(root, "package.json"));
  const localQuality =
    typeof packageJson.scripts?.quality === "string"
      ? packageJson.scripts.quality
      : "";
  return manifest.nativeTargets.flatMap((target) =>
    Object.values(
      target?.commands !== null &&
        typeof target?.commands === "object" &&
        !Array.isArray(target.commands)
        ? target.commands
        : {},
    )
      .filter((command) => typeof command === "string")
      .flatMap((command) => {
        const failures = [];
        if (typeof packageJson.scripts?.[command] !== "string")
          failures.push(`Native target package script is missing: ${command}.`);
        if (!localQuality.includes(`npm run ${command}`))
          failures.push(
            `Local quality does not execute native target command: ${command}.`,
          );
        if (!ci.includes(`npm run ${command}`))
          failures.push(
            `CI does not execute native target command: ${command}.`,
          );
        return failures;
      }),
  );
}

function unpinnedWorkflowFailures(workflows) {
  return [...workflows].flatMap(([name, workflow]) =>
    unpinnedActionReferences(workflow).map(
      (reference) => `Unpinned action reference in ${name}: ${reference}.`,
    ),
  );
}

function ciWorkflowFailures(ci) {
  return expectedWorkflowChecks
    .filter((check) => !ci.includes(check))
    .map(
      (check) => `CI workflow does not emit required check marker: ${check}.`,
    );
}

function epicWorkflowFailures(workflows) {
  const pullRequestFailures = epicPullRequestWorkflows
    .filter(
      (name) =>
        !workflowEventTargetsBranch(
          workflows.get(name) ?? "",
          "pull_request",
          "epic/**",
        ),
    )
    .map(
      (name) =>
        `Workflow must validate pull requests targeting epic branches: ${name}.`,
    );
  const pushFailures = epicPushWorkflows
    .filter(
      (name) =>
        !workflowEventTargetsBranch(
          workflows.get(name) ?? "",
          "push",
          "epic/**",
        ),
    )
    .map((name) => `Workflow must validate epic branch heads: ${name}.`);
  return [...pullRequestFailures, ...pushFailures];
}

function issueReadinessWorkflowFailures(workflow) {
  const failures = issueReadinessMarkers
    .filter((marker) => !workflow.includes(marker))
    .map((marker) => `Issue readiness workflow is missing marker: ${marker}.`);
  if (workflow.includes("pull_request_target"))
    failures.push("Issue readiness must not use pull_request_target.");
  return failures;
}

function bracketList(marker, text) {
  return (
    new RegExp(`${marker}:\\s*\\[([^\\]]*)\\]`, "u")
      .exec(text)?.[1]
      ?.split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "") ?? []
  );
}

function workflowWritePermissions(workflow) {
  return workflow
    .split(/\r?\n/u)
    .map(
      (line) =>
        /^\s*([A-Za-z][A-Za-z-]*):\s*(?:write|write-all)\s*(?:#.*)?$/u.exec(
          line,
        )?.[1],
    )
    .filter((name) => name !== undefined);
}

function issueLifecycleWorkflowFailures(workflow) {
  const failures = issueLifecycleMarkers
    .filter((marker) => !workflow.includes(marker))
    .map((marker) => `Issue lifecycle workflow is missing marker: ${marker}.`);
  failures.push(
    ...issueLifecyclePermissionMarkers
      .filter((marker) => !workflow.includes(marker))
      .map(
        (marker) =>
          `Issue lifecycle workflow permission drift, missing marker: ${marker}.`,
      ),
  );
  const triggerTypes = bracketList("types", workflow);
  if (
    JSON.stringify(triggerTypes) !== JSON.stringify(issueLifecycleTriggerTypes)
  )
    failures.push(
      `Issue lifecycle workflow trigger types drifted: ${triggerTypes.join(", ")}.`,
    );
  if (workflow.includes("pull_request_target"))
    failures.push("Issue lifecycle must not use pull_request_target.");
  const writePermissions = [...new Set(workflowWritePermissions(workflow))];
  if (writePermissions.length > 0)
    failures.push(
      `Issue lifecycle must not request write permissions: ${writePermissions.join(", ")}.`,
    );
  return failures;
}

function pullRequestContractWorkflowFailures(workflow) {
  const markerFailures = pullRequestContractMarkers
    .filter((marker) => !workflow.includes(marker))
    .map(
      (marker) =>
        `Pull-request contract workflow is missing marker: ${marker}.`,
    );
  const unsafeFailures = [
    "github.event.pull_request.head.sha",
    "github.head_ref",
    "npm ci",
    "npm run",
  ]
    .filter((marker) => workflow.includes(marker))
    .map(
      (marker) =>
        `Privileged pull-request metadata workflow contains unsafe marker: ${marker}.`,
    );
  const branchFailures = ["dev", "epic/**"]
    .filter(
      (branch) =>
        !workflowEventTargetsBranch(workflow, "pull_request_target", branch),
    )
    .map(
      (branch) =>
        `Pull-request contract must validate target branch: ${branch}.`,
    );
  return [...markerFailures, ...unsafeFailures, ...branchFailures];
}

async function workflowFailures(root, manifest) {
  const workflowDirectory = join(root, ".github", "workflows");
  if (!(await exists(workflowDirectory)))
    return ["Missing workflow directory."];
  const workflowNames = (await readdir(workflowDirectory)).filter((name) =>
    name.endsWith(".yml"),
  );
  const workflows = new Map(
    await Promise.all(
      workflowNames.map(async (name) => [
        name,
        await readFile(join(workflowDirectory, name), "utf8"),
      ]),
    ),
  );
  const ci = workflows.get("ci.yml") ?? "";
  return [
    ...unpinnedWorkflowFailures(workflows),
    ...ciWorkflowFailures(ci),
    ...epicWorkflowFailures(workflows),
    ...issueReadinessWorkflowFailures(
      workflows.get("issue-readiness.yml") ?? "",
    ),
    ...issueLifecycleWorkflowFailures(
      workflows.get("issue-lifecycle.yml") ?? "",
    ),
    ...pullRequestContractWorkflowFailures(
      workflows.get("pr-contract.yml") ?? "",
    ),
    ...(await productiveCommandFailures(root, ci, manifest)),
  ];
}

async function providerFailures(root) {
  const sonar = await readFile(join(root, "sonar-project.properties"), "utf8");
  const zizmor = await readFile(join(root, ".github", "zizmor.yml"), "utf8");
  const failures = [];
  if (!sonar.includes("sonar.projectKey=oscharko-dev_Keiko-Native"))
    failures.push("Sonar project key is not bound to Keiko-Native.");
  if (!sonar.includes("sonar.organization=oscharko-dev"))
    failures.push("Sonar organization is not bound to oscharko-dev.");
  if (!sonar.includes("coverage/lcov.info"))
    failures.push("Sonar LCOV evidence is not configured.");
  if (
    !zizmor.includes("dangerous-triggers:") ||
    !zizmor.includes("- pr-contract.yml") ||
    zizmor.includes("disable: true")
  )
    failures.push(
      "Zizmor must contain only a scoped dangerous-trigger disposition for the trusted PR metadata workflow.",
    );
  const ignoredWorkflowFiles = zizmor
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).split("#")[0].trim())
    .filter((value) => value.endsWith(".yml") || value.endsWith(".yaml"));
  if (
    ignoredWorkflowFiles.length !== 1 ||
    ignoredWorkflowFiles[0] !== "pr-contract.yml"
  )
    failures.push(
      "Zizmor workflow ignores must remain limited to pr-contract.yml.",
    );
  return failures;
}

export async function validateRepository(root) {
  const files = await repositoryFiles(root);
  const manifest = await readJson(join(root, "quality", "project.json"));
  const contract = await contractFailures(root, files, manifest);
  const failures = [
    ...contract.failures,
    ...(await workflowFailures(root, manifest)),
    ...(await providerFailures(root)),
  ];
  return {
    failureCount: failures.length,
    failures,
    fileCount: files.length,
    phase: manifest?.phase,
    productiveSourceCount: contract.productiveSources.length,
  };
}
