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
  "docs/qa/repository-activation.md",
  "package.json",
  "quality/github-api.mjs",
  "quality/github-reference.mjs",
  "quality/issue-contract.mjs",
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

const requiredUnconditionalCiJobs = [
  "core-quality",
  "coverage-sonar",
  "cross-platform-smoke",
  "actionlint",
  "verify-pinned-shas",
  "zizmor",
  "build-scan-sbom-smoke",
  "native",
];

const aggregateCiNeeds = [
  "core-quality",
  "coverage-sonar",
  "cross-platform-smoke",
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

const ignoredDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
const ignoredProductRoots = new Set([".github", "quality"]);
const requiredTargetCommands = [
  "architecture",
  "build",
  "coverage",
  "format",
  "lint",
  "package",
  "platform",
  "security",
  "signing",
  "test",
];

const adr0004SourceRoots = [
  "native/crates/keiko-application/src/",
  "native/crates/keiko-ui-port/src/",
  "native/crates/keiko-host-macos/src/",
  "native/apps/keiko-desktop/src/",
  "native/frontend/src/",
];

const adr0004TestRoots = ["native/tests/"];

const adr0004SupportFiles = [
  "native/Cargo.toml",
  "native/Cargo.lock",
  "native/rust-toolchain.toml",
  "native/apps/keiko-desktop/Cargo.toml",
  "native/apps/keiko-desktop/build.rs",
  "native/apps/keiko-desktop/icons/icon.png",
  "native/apps/keiko-desktop/tauri.conf.json",
  "native/crates/keiko-application/Cargo.toml",
  "native/crates/keiko-ui-port/Cargo.toml",
  "native/crates/keiko-host-macos/Cargo.toml",
  "native/frontend/index.html",
  "native/frontend/package.json",
  "native/frontend/package-lock.json",
  "native/frontend/tsconfig.json",
  "native/frontend/vite.config.ts",
  "native/package-policy.json",
  "native/third-party-notices.json",
];

const adr0004TargetCommands = {
  architecture: "native:architecture",
  build: "native:build",
  coverage: "native:coverage",
  format: "native:format",
  lint: "native:lint",
  package: "native:package",
  platform: "native:platform",
  security: "native:security",
  signing: "native:signing",
  test: "native:test",
};

function sameStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((value) => actual.includes(value)) &&
    new Set(actual).size === actual.length
  );
}

function nativeTargetSourceRoots(target) {
  if (Array.isArray(target?.sourceRoots)) return target.sourceRoots;
  if (typeof target?.sourceRoot === "string") return [target.sourceRoot];
  return [];
}

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
  const sourceRoots = nativeTargetSourceRoots(target);
  if (
    sourceRoots.length === 0 ||
    sourceRoots.some(
      (sourceRoot) =>
        !isSafeRepositoryPath(sourceRoot) ||
        !productiveSourceRoots.includes(sourceRoot),
    ) ||
    new Set(sourceRoots).size !== sourceRoots.length
  )
    failures.push(
      "Native target source roots must name declared repository source roots.",
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

function adr0004DeclarationFailures(manifest) {
  if (manifest.phase !== "productive") return [];
  const failures = [];
  if (!sameStringSet(manifest.productiveSourceRoots, adr0004SourceRoots))
    failures.push("Productive source roots must match ADR-0004 exactly.");
  if (!sameStringSet(manifest.testSourceRoots, adr0004TestRoots))
    failures.push("Test source roots must match ADR-0004 exactly.");
  if (!sameStringSet(manifest.supportFiles, adr0004SupportFiles))
    failures.push("Support files must match ADR-0004 exactly.");
  if (
    JSON.stringify(manifest.coverageToolchains) !==
    JSON.stringify({
      productiveRust: "1.92.0",
      rustBranch: "nightly-2026-07-17",
      cargoLlvmCov: "0.8.7",
      frontend: "vitest-v8",
    })
  )
    failures.push("Coverage toolchains must match the ADR-0004 amendment.");
  if (
    JSON.stringify(manifest.coverageExclusions) !==
    JSON.stringify([
      {
        path: "native/apps/keiko-desktop/src/main.rs",
        evidence: "acceptance:macos",
      },
    ])
  ) {
    failures.push(
      "Coverage exclusions must bind only thin Tauri wiring to packaged acceptance.",
    );
  }
  if (manifest.nativeTargets.length !== 1) {
    failures.push("ADR-0004 declares exactly one native target.");
    return failures;
  }
  const [target] = manifest.nativeTargets;
  if (target?.name !== "keiko-native-desktop")
    failures.push("ADR-0004 native target name must be keiko-native-desktop.");
  if (target?.language !== "rust")
    failures.push("ADR-0004 native target language must be rust.");
  if (!sameStringSet(target?.platforms, ["macos"]))
    failures.push("ADR-0004 native target platform must be macos only.");
  if (!sameStringSet(target?.architectures, ["arm64"]))
    failures.push("ADR-0004 native target architecture must be arm64.");
  if (!sameStringSet(nativeTargetSourceRoots(target), adr0004SourceRoots))
    failures.push("ADR-0004 native target roots must match its source roots.");
  if (
    JSON.stringify(target?.commands) !== JSON.stringify(adr0004TargetCommands)
  )
    failures.push("ADR-0004 native target commands must match the root gates.");
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
  const targetedRoots = new Set(targets.flatMap(nativeTargetSourceRoots));
  if (roots.some((root) => !targetedRoots.has(root)))
    failures.push(
      "Every productive source root must belong to a declared native target.",
    );
  failures.push(...adr0004DeclarationFailures(manifest));
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
  const expectedProfile =
    manifest?.phase === "productive"
      ? "keiko-native-productive-v1"
      : "keiko-native-bootstrap-v1";
  if (manifest?.qualityProfile !== expectedProfile)
    failures.push(`The ${expectedProfile} quality profile is required.`);
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
  if (
    manifest?.phase === "productive" &&
    !Array.isArray(manifest?.testSourceRoots)
  )
    failures.push("testSourceRoots must be an array in productive mode.");
  if (
    manifest?.phase === "productive" &&
    !Array.isArray(manifest?.supportFiles)
  )
    failures.push("supportFiles must be an array in productive mode.");
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

const sonarEventCondition = [
  "(github.event_name == 'pull_request' && github.base_ref == 'dev')",
  "||",
  "(github.event_name == 'push' && github.ref == 'refs/heads/dev')",
  "||",
  "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/dev')",
].join(" ");

export function sonarRequiredForEvent({ eventName, baseRef = "", ref = "" }) {
  return (
    (eventName === "pull_request" && baseRef === "dev") ||
    (eventName === "push" && ref === "refs/heads/dev") ||
    (eventName === "workflow_dispatch" && ref === "refs/heads/dev")
  );
}

function workflowSection(lines, marker) {
  const start = lines.findIndex((line) => line === marker);
  if (start === -1) return [];
  const indent = marker.length - marker.trimStart().length;
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      line.trim() !== "" &&
      line.length - line.trimStart().length <= indent,
  );
  return lines.slice(start, end === -1 ? lines.length : end);
}

function jobPreamble(job) {
  const steps = job.findIndex((line) => line.trim() === "steps:");
  return job.slice(0, steps === -1 ? job.length : steps);
}

function normalizedStepCondition(section) {
  const conditionIndex = section.findIndex((line) =>
    line.trimStart().startsWith("if:"),
  );
  if (conditionIndex === -1) return undefined;
  const conditionLine = section[conditionIndex];
  const conditionIndent =
    conditionLine.length - conditionLine.trimStart().length;
  const first = conditionLine.trimStart().slice("if:".length).trim();
  const parts = [first];
  for (const line of section.slice(conditionIndex + 1)) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= conditionIndent) break;
    parts.push(line.trim());
  }
  return parts
    .join(" ")
    .replace(/^(?:>-|\|[-+]?)\s*/u, "")
    .replace(/\$\{\{|\}\}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function sonarWorkflowFailures(workflow) {
  const lines = workflow.split(/\r?\n/u);
  const coverageJob = workflowSection(lines, "  coverage-sonar:");
  if (coverageJob.length === 0)
    return ["CI must retain the Coverage and SonarCloud job."];

  const coverage = workflowSection(
    coverageJob,
    "      - run: npm run coverage",
  );
  const failures = [];
  if (coverage.length === 0) {
    failures.push("CI must run repository coverage on every accepted event.");
  } else if (
    normalizedStepCondition(coverage) !== undefined ||
    coverage.some((line) => line.includes("continue-on-error"))
  ) {
    failures.push("CI coverage must remain unconditional and fail closed.");
  }

  const coverageJobPreamble = jobPreamble(coverageJob);
  if (coverageJobPreamble.some((line) => line.trimStart().startsWith("if:")))
    failures.push("The coverage job must remain unconditional.");

  const checkoutMarker = coverageJob.find((line) =>
    line.trimStart().startsWith("- uses: actions/checkout@"),
  );
  const checkout =
    checkoutMarker === undefined
      ? []
      : workflowSection(coverageJob, checkoutMarker);
  const dispatchCheckoutRef =
    "ref: ${{ github.event_name == 'workflow_dispatch' && 'dev' || github.ref }}";
  if (checkout.length === 0) {
    failures.push("The coverage job must retain its repository checkout.");
  } else if (!checkout.some((line) => line.trim() === dispatchCheckoutRef)) {
    failures.push(
      "The coverage checkout must bind manual dispatch analysis to dev.",
    );
  }

  const manualBinding = workflowSection(
    coverageJob,
    "      - name: Verify manual analysis is bound to remote dev",
  );
  if (manualBinding.length === 0) {
    failures.push(
      "CI must verify manual analysis against the remote dev head.",
    );
  } else {
    if (
      normalizedStepCondition(manualBinding) !==
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/dev'"
    )
      failures.push(
        "Manual analysis verification must use the exact-dev dispatch predicate.",
      );
    for (const marker of [
      'if [ "$(git rev-parse HEAD)" != "$(git rev-parse refs/remotes/origin/dev)" ]; then',
      "exit 1",
    ]) {
      if (!manualBinding.some((line) => line.trim() === marker))
        failures.push(
          `Manual analysis dev-head binding is missing marker: ${marker}.`,
        );
    }
    if (manualBinding.some((line) => line.includes("continue-on-error")))
      failures.push("Manual analysis dev-head verification must fail closed.");
  }

  for (const name of [
    "Download and verify Sonar Scanner CLI",
    "SonarQube Cloud analysis",
  ]) {
    const step = workflowSection(coverageJob, `      - name: ${name}`);
    if (step.length === 0) {
      failures.push(`CI is missing required Sonar step: ${name}.`);
      continue;
    }
    if (normalizedStepCondition(step) !== sonarEventCondition)
      failures.push(
        `Sonar step must use the exact dev event predicate: ${name}.`,
      );
    if (step.some((line) => line.includes("continue-on-error")))
      failures.push(`Sonar step must fail closed when required: ${name}.`);
  }

  const analysis = workflowSection(
    coverageJob,
    "      - name: SonarQube Cloud analysis",
  ).join("\n");
  for (const marker of [
    "SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}",
    '[ -z "$SONAR_TOKEN" ]',
    "exit 1",
    "-Dsonar.qualitygate.wait=true",
  ]) {
    if (!analysis.includes(marker))
      failures.push(`Required Sonar fail-closed marker is missing: ${marker}.`);
  }
  return failures;
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

async function sourceRootFailures(root, manifest) {
  const sourceRoots = [
    ...(Array.isArray(manifest?.productiveSourceRoots)
      ? manifest.productiveSourceRoots
      : []),
    ...(Array.isArray(manifest?.testSourceRoots)
      ? manifest.testSourceRoots
      : []),
    ...(Array.isArray(manifest?.supportFiles) ? manifest.supportFiles : []),
  ];
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

function nativeDeclarationFailures(files, manifest) {
  if (manifest?.phase !== "productive") return [];
  const roots = [
    ...(Array.isArray(manifest.productiveSourceRoots)
      ? manifest.productiveSourceRoots
      : []),
    ...(Array.isArray(manifest.testSourceRoots)
      ? manifest.testSourceRoots
      : []),
  ];
  const support = new Set(
    Array.isArray(manifest.supportFiles) ? manifest.supportFiles : [],
  );
  return files
    .filter((file) => file.startsWith("native/"))
    .filter((file) => !file.startsWith("native/apps/keiko-desktop/gen/"))
    .filter(
      (file) =>
        !support.has(file) && !roots.some((root) => file.startsWith(root)),
    )
    .map((file) => `Undeclared native source, test, or support file: ${file}.`);
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
    ...bootstrapFailures,
    ...nativeDeclarationFailures(files, manifest),
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
  const failures = manifest.nativeTargets.flatMap((target) =>
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
  for (const command of ["acceptance:macos"]) {
    if (typeof packageJson.scripts?.[command] !== "string")
      failures.push(`Native acceptance package script is missing: ${command}.`);
    if (!ci.includes(`npm run ${command}`))
      failures.push(
        `CI does not execute native acceptance command: ${command}.`,
      );
  }
  for (const marker of ["macos-14", "macos-26", 'test "$(uname -m)" = arm64']) {
    if (!ci.includes(marker))
      failures.push(`Native CI marker is missing: ${marker}.`);
  }
  return failures;
}

function unpinnedWorkflowFailures(workflows) {
  return [...workflows].flatMap(([name, workflow]) =>
    unpinnedActionReferences(workflow).map(
      (reference) => `Unpinned action reference in ${name}: ${reference}.`,
    ),
  );
}

function ciWorkflowFailures(ci) {
  const failures = expectedWorkflowChecks
    .filter((check) => !ci.includes(check))
    .map(
      (check) => `CI workflow does not emit required check marker: ${check}.`,
    );
  const lines = ci.split(/\r?\n/u);
  for (const jobName of requiredUnconditionalCiJobs) {
    const job = workflowSection(lines, `  ${jobName}:`);
    if (job.length === 0) {
      failures.push(`CI must retain required job section: ${jobName}.`);
      continue;
    }
    if (jobPreamble(job).some((line) => line.trimStart().startsWith("if:")))
      failures.push(
        `CI job must remain applicable and unconditional on accepted events: ${jobName}.`,
      );
  }

  const aggregate = workflowSection(lines, "  ci:");
  if (aggregate.length === 0) {
    failures.push("CI must retain the aggregate ci job.");
    return failures;
  }
  const aggregatePreamble = jobPreamble(aggregate);
  if (normalizedStepCondition(aggregatePreamble) !== "always()")
    failures.push(
      "The aggregate ci job must always evaluate dependency results.",
    );
  const needs = workflowSection(aggregatePreamble, "    needs:");
  for (const dependency of aggregateCiNeeds) {
    if (!needs.some((line) => line.trim() === `- ${dependency}`))
      failures.push(
        `The aggregate ci job must depend on required job: ${dependency}.`,
      );
  }
  return failures;
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
    ...sonarWorkflowFailures(ci),
    ...epicWorkflowFailures(workflows),
    ...issueReadinessWorkflowFailures(
      workflows.get("issue-readiness.yml") ?? "",
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
