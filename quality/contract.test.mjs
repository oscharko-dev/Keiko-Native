import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isProductiveSource,
  isSafeRepositoryPath,
  normalizeRepositoryPath,
  unpinnedActionReferences,
  validateManifest,
  validateNativeTarget,
  validateRepository,
  workflowEventTargetsBranch,
} from "./contract.mjs";

const validManifest = {
  baseBranch: "dev",
  minimumCoverage: { branches: 85, functions: 85, lines: 85, statements: 85 },
  nativeTargets: [],
  phase: "bootstrap",
  productiveSourceRoots: [],
  qualityProfile: "keiko-native-bootstrap-v1",
  schemaVersion: 1,
  sourceSpecification: {
    date: "2026-07-15",
    document: "Keiko-Native-Fachkonzept.md",
    repositoryAccess: "private-external",
    sha256: "d77a78fb79fc1de882487195d3f2295936f24a34e6bc0579106ad06104737a98",
    version: "0.6",
  },
};

const validTarget = {
  commands: {
    architecture: "native:architecture",
    build: "native:build",
    coverage: "native:coverage",
    package: "native:package",
    security: "native:security",
    test: "native:test",
  },
  language: "swift",
  name: "KeikoNative",
  platforms: ["macos"],
  sourceRoot: "Sources",
};

const lifecycleStates = Object.freeze([
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

const coverageScript = [
  "node --test --experimental-test-coverage",
  "--test-coverage-include=quality/issue-lifecycle.mjs",
  "--test-coverage-include=quality/issue-lifecycle-readiness.mjs",
  "--test-coverage-include=quality/issue-lifecycle-action.mjs",
].join(" ");

const issueTemplateFiles = [
  ".github/ISSUE_TEMPLATE/decision_evaluation.md",
  ".github/ISSUE_TEMPLATE/defect_finding.md",
  ".github/ISSUE_TEMPLATE/epic.md",
  ".github/ISSUE_TEMPLATE/feature_task.md",
];

function lifecycleList(states = lifecycleStates) {
  return states.map((state) => `- \`${state}\``).join("\n");
}

function lifecycleProjectionText(states = lifecycleStates) {
  return [
    "Lifecycle contract: [docs/qa/issue-lifecycle.md](../../docs/qa/issue-lifecycle.md).",
    "",
    lifecycleList(states),
  ].join("\n");
}

function lifecycleModuleSource(states = lifecycleStates) {
  return [
    "export const LIFECYCLE_STATES = Object.freeze([",
    ...states.map((state) => `  \"${state}\",`),
    "]);",
  ].join("\n");
}

function lifecycleFixtureSource(states = lifecycleStates) {
  return [
    "const canonicalStates = Object.freeze([",
    ...states.map((state) => `  \"${state}\",`),
    "]);",
  ].join("\n");
}

function packageJson(scripts = {}) {
  return JSON.stringify({
    scripts: { coverage: coverageScript, quality: "fixture", ...scripts },
  });
}

test("accepts the governed bootstrap manifest", () => {
  assert.deepEqual(validateManifest(validManifest), []);
});

test("rejects unsupported manifest identity and phase", () => {
  const failures = validateManifest({
    ...validManifest,
    baseBranch: "main",
    phase: "unknown",
    qualityProfile: "weakened",
    schemaVersion: 2,
  });
  assert.equal(failures.length, 4);
});

test("rejects weakened coverage floors", () => {
  const failures = validateManifest({
    ...validManifest,
    minimumCoverage: { branches: 84, functions: 84, lines: 84, statements: 84 },
  });
  assert.equal(failures.length, 4);
});

test("requires an immutable governed source Fachkonzept identity", () => {
  const failures = validateManifest({
    ...validManifest,
    sourceSpecification: {
      ...validManifest.sourceSpecification,
      document: "other.md",
      sha256: "not-a-digest",
    },
  });
  assert.deepEqual(failures, [
    "The governed source Fachkonzept document is invalid.",
    "The governed source Fachkonzept sha256 is invalid.",
  ]);
});

test("requires productive roots and targets together", () => {
  const failures = validateManifest({ ...validManifest, phase: "productive" });
  assert.deepEqual(failures, [
    "Productive projects must declare source roots and native targets.",
  ]);
});

test("rejects malformed collection fields", () => {
  const failures = validateManifest({
    ...validManifest,
    nativeTargets: "App",
    productiveSourceRoots: "Sources",
  });
  assert.equal(failures.length, 2);
});

test("validates contained source paths and complete native target gates", () => {
  for (const path of ["Sources", "native/core", "src/main.swift"]) {
    assert.equal(isSafeRepositoryPath(path), true);
  }
  for (const path of [
    "",
    "/absolute",
    "../escape",
    "Sources/../escape",
    "space here",
  ]) {
    assert.equal(isSafeRepositoryPath(path), false);
  }
  assert.deepEqual(validateNativeTarget(validTarget, ["Sources"]), []);
  assert.ok(
    validateNativeTarget({ ...validTarget, commands: {}, platforms: [] }, [
      "Other",
    ]).length > 6,
  );
});

test("rejects duplicate, escaping, and untargeted productive roots", () => {
  const failures = validateManifest({
    ...validManifest,
    nativeTargets: [validTarget],
    phase: "productive",
    productiveSourceRoots: ["Sources", "Sources", "../escape", "Other"],
  });
  assert.match(failures.join("\n"), /unique repository-relative paths/u);
  assert.match(failures.join("\n"), /Every productive source root/u);
});

test("recognizes productive native and application sources", () => {
  for (const path of [
    "Sources/App.swift",
    "native/core.rs",
    "src/main.ts",
    "src/bridge.mm",
  ]) {
    assert.equal(isProductiveSource(path), true);
  }
});

test("normalizes Windows repository paths for governed file matching", () => {
  assert.equal(
    normalizeRepositoryPath(".github\\workflows\\ci.yml", "\\"),
    ".github/workflows/ci.yml",
  );
  assert.equal(
    normalizeRepositoryPath(
      ".gitar\\review\\00-governance-and-delivery.md",
      "\\",
    ),
    ".gitar/review/00-governance-and-delivery.md",
  );
});

test("ignores quality tooling and workflow implementation", () => {
  assert.equal(isProductiveSource("quality/contract.mjs"), false);
  assert.equal(isProductiveSource(".github/actions/check.js"), false);
  assert.equal(isProductiveSource("README.md"), false);
});

test("accepts full-SHA, local, and container action references", () => {
  const workflow = [
    "- uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
    "  -   uses:\tactions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
    '- uses: "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"',
    "- uses: 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e'",
    "- uses: ./local-action",
    "- uses: docker://alpine:3.23",
  ].join("\n");
  assert.deepEqual(unpinnedActionReferences(workflow), []);
});

test("rejects tag and branch action references", () => {
  const workflow = [
    "- uses: actions/checkout@v4",
    "uses: owner/action@main # unsafe",
  ].join("\n");
  assert.deepEqual(unpinnedActionReferences(workflow), [
    "actions/checkout@v4",
    "owner/action@main",
  ]);
});

test("recognizes exact branch targets inside workflow events", () => {
  const workflow = [
    "on:",
    "  pull_request:",
    "    branches:",
    "      - dev",
    '      - "epic/**"',
    "  push:",
    "    branches:",
    "      - dev",
  ].join("\n");
  assert.equal(
    workflowEventTargetsBranch(workflow, "pull_request", "epic/**"),
    true,
  );
  assert.equal(workflowEventTargetsBranch(workflow, "push", "epic/**"), false);
  assert.equal(
    workflowEventTargetsBranch(workflow, "pull_request", "release/**"),
    false,
  );
});

test("recognizes exact branch targets in CRLF workflow files", () => {
  const workflow = [
    "on:",
    "  pull_request:",
    "    branches:",
    '      - "epic/**"',
    "  push:",
    "    branches:",
    "      - dev",
  ].join("\r\n");
  assert.equal(
    workflowEventTargetsBranch(workflow, "pull_request", "epic/**"),
    true,
  );
  assert.equal(workflowEventTargetsBranch(workflow, "push", "dev"), true);
});

async function fixtureRepository() {
  const root = await mkdtemp(join(tmpdir(), "keiko-native-quality-"));
  const files = [
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
  ];
  for (const file of files) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), "fixture\n");
  }
  await writeFile(join(root, "package.json"), packageJson());
  await mkdir(join(root, "quality"), { recursive: true });
  await writeFile(
    join(root, "quality/project.json"),
    JSON.stringify(validManifest),
  );
  await writeFile(
    join(root, "docs/product/source-baseline.md"),
    [
      "Keiko-Native-Fachkonzept.md",
      "0.6",
      "2026-07-15",
      "d77a78fb79fc1de882487195d3f2295936f24a34e6bc0579106ad06104737a98",
      "private external source; the document itself must not be committed",
      "provenance only",
      "Agent Planning Baseline",
      "Planning and implementation agents must be able to perform their work",
    ].join("\n"),
  );
  await writeFile(
    join(root, "docs/planning/agent-planning-baseline.md"),
    [
      "# Keiko Native Agent Planning Baseline",
      "## Authority and planning use",
      "## Global acceptance journeys",
      "## Capability planning packets",
      "## Cross-cutting quality contract",
      "### Desktop acceptance automation",
      "## Decision gates",
      "## Epic-authoring contract",
      "Planning and implementation do not require access to the private source.",
    ].join("\n"),
  );
  await mkdir(join(root, "docs/engineering"), { recursive: true });
  await writeFile(
    join(root, "docs/engineering/code-quality-standard.md"),
    [
      "# Code Quality Standard",
      "### Desktop test automation ownership",
      "The repository owns the supported test harnesses and canonical commands.",
      "Computer Use provides complementary manual evidence.",
      "A new foundational test framework requires an accepted decision.",
      "The production release artifact contains no test-only automation capability.",
    ].join("\n"),
  );
  await writeFile(
    join(root, "AGENTS.md"),
    [
      "Lifecycle reference: [docs/qa/issue-lifecycle.md](docs/qa/issue-lifecycle.md).",
      lifecycleList(),
    ].join("\n"),
  );
  await writeFile(
    join(root, "docs/qa/issue-lifecycle.md"),
    [
      "# Issue Lifecycle",
      "## Canonical States",
      lifecycleList(),
      "## Allowed Edge Graph",
      lifecycleList(),
      "## Permitted Label Requests",
      lifecycleList(),
    ].join("\n"),
  );
  await writeFile(
    join(root, "docs/qa/repository-activation.md"),
    ["# Repository activation checklist", lifecycleList()].join("\n"),
  );
  for (const file of issueTemplateFiles)
    await writeFile(join(root, file), lifecycleProjectionText());
  await writeFile(
    join(root, "quality/issue-lifecycle.mjs"),
    lifecycleModuleSource(),
  );
  await writeFile(
    join(root, "quality/issue-lifecycle.test.mjs"),
    lifecycleFixtureSource(),
  );
  await writeFile(
    join(root, ".markdown-quality.json"),
    JSON.stringify({
      allowedHtmlElements: ["div"],
      lineLength: 100,
    }),
  );
  await writeFile(
    join(root, ".github/workflows/ci.yml"),
    [
      "name: CI",
      "on:",
      "  pull_request:",
      "    branches:",
      '      - "epic/**"',
      "  push:",
      "    branches:",
      '      - "epic/**"',
      ...[
        "ci",
        "actionlint",
        "Verify pinned action SHAs",
        "zizmor",
        "Build, scan, SBOM, smoke",
        "native",
      ].map((name) => `  name: ${name}`),
      "quality_gate_wait=true",
      "push:refs/heads/epic/*)",
      "quality_gate_wait=false",
      '-Dsonar.qualitygate.wait="$quality_gate_wait"',
    ].join("\n"),
  );
  for (const name of [
    "codeql.yml",
    "dependency-review.yml",
    "osv-scanner.yml",
  ]) {
    const lines = [
      `name: ${name}`,
      "on:",
      "  pull_request:",
      "    branches:",
      '      - "epic/**"',
    ];
    if (name !== "dependency-review.yml")
      lines.push("  push:", "    branches:", '      - "epic/**"');
    await writeFile(join(root, ".github/workflows", name), lines.join("\n"));
  }
  await writeFile(
    join(root, ".github/workflows/issue-readiness.yml"),
    [
      "name: Issue readiness",
      "types: [closed, edited, labeled, reopened, unlabeled]",
      "name: Validate implementation readiness",
      "issues: write",
      "pull-requests: read",
      "statuses: write",
      "node quality/issue-readiness-action.mjs",
    ].join("\n"),
  );
  await writeFile(
    join(root, ".github/workflows/issue-lifecycle.yml"),
    [
      "name: Issue lifecycle",
      "on:",
      "  issues:",
      "    types: [assigned, closed, edited, labeled, reopened, unassigned, unlabeled]",
      "permissions: {}",
      "concurrency:",
      "  group: issue-lifecycle-${{ github.event.issue.number }}",
      "jobs:",
      "  classify:",
      "    permissions:",
      "      contents: read",
      "      issues: read",
      "      pull-requests: read",
      "    steps:",
      "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "        with:",
      "          persist-credentials: false",
      "          ref: dev",
      "      - name: Compute the inert lifecycle decision",
      "        env:",
      "          KEIKO_ISSUE_LIFECYCLE_ACTIVATION: disabled",
      "        run: node quality/issue-lifecycle-action.mjs",
    ].join("\n"),
  );
  await writeFile(
    join(root, ".github/workflows/pr-contract.yml"),
    [
      "name: Pull request contract",
      "on:",
      "  pull_request_target:",
      "    branches:",
      "      - dev",
      '      - "epic/**"',
      "types: [opened, edited, reopened, synchronize, ready_for_review, converted_to_draft]",
      "name: Evaluate trusted PR metadata",
      "ref: dev",
      "statuses: write",
      "node quality/pr-contract-action.mjs",
    ].join("\n"),
  );
  await writeFile(
    join(root, "sonar-project.properties"),
    [
      "sonar.projectKey=oscharko-dev_Keiko-Native",
      "sonar.organization=oscharko-dev",
      "sonar.javascript.lcov.reportPaths=coverage/lcov.info",
    ].join("\n"),
  );
  await writeFile(
    join(root, ".github/zizmor.yml"),
    [
      "rules:",
      "  dangerous-triggers:",
      "    ignore:",
      "      - pr-contract.yml",
    ].join("\n"),
  );
  return root;
}

test("validates a complete bootstrap repository", async () => {
  const root = await fixtureRepository();
  try {
    const result = await validateRepository(root);
    assert.deepEqual(result.failures, []);
    assert.equal(result.phase, "bootstrap");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed when the private source Fachkonzept is committed", async () => {
  const root = await fixtureRepository();
  try {
    await writeFile(
      join(root, "docs/product/Keiko-Native-Fachkonzept-v0.6.md"),
      "private source\n",
    );
    const result = await validateRepository(root);
    assert.match(
      result.failures.join("\n"),
      /private source Fachkonzept must not be committed/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed when private source provenance rules drift", async () => {
  const root = await fixtureRepository();
  try {
    await writeFile(join(root, "docs/product/source-baseline.md"), "drift\n");
    const result = await validateRepository(root);
    assert.match(
      result.failures.join("\n"),
      /Private source baseline is missing governed marker/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed when the agent planning baseline contract drifts", async () => {
  const root = await fixtureRepository();
  try {
    await writeFile(
      join(root, "docs/planning/agent-planning-baseline.md"),
      "drift\n",
    );
    const result = await validateRepository(root);
    assert.match(
      result.failures.join("\n"),
      /Agent Planning Baseline is missing governed marker/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed when desktop test automation governance drifts", async () => {
  const root = await fixtureRepository();
  try {
    await writeFile(
      join(root, "docs/engineering/code-quality-standard.md"),
      "drift\n",
    );
    const result = await validateRepository(root);
    assert.match(
      result.failures.join("\n"),
      /Code Quality Standard is missing governed marker/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed when productive code appears during bootstrap", async () => {
  const root = await fixtureRepository();
  try {
    await mkdir(join(root, "Sources"));
    await writeFile(join(root, "Sources/App.swift"), "struct App {}\n");
    const result = await validateRepository(root);
    assert.equal(result.productiveSourceCount, 1);
    assert.match(
      result.failures.join("\n"),
      /declare native targets and gates first/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed for missing declared productive roots", async () => {
  const root = await fixtureRepository();
  try {
    await writeFile(
      join(root, "quality/project.json"),
      JSON.stringify({
        ...validManifest,
        nativeTargets: [validTarget],
        phase: "productive",
        productiveSourceRoots: ["Sources"],
      }),
    );
    const commandNames = Object.values(validTarget.commands);
    await writeFile(
      join(root, "package.json"),
      packageJson(
        Object.fromEntries([
          ...commandNames.map((command) => [command, "node --version"]),
          [
            "quality",
            commandNames.map((command) => `npm run ${command}`).join(" && "),
          ],
        ]),
      ),
    );
    const ciPath = join(root, ".github/workflows/ci.yml");
    const ci = await readFile(ciPath, "utf8");
    await writeFile(
      ciPath,
      `${ci}\n${commandNames.map((command) => `npm run ${command}`).join("\n")}`,
    );
    const result = await validateRepository(root);
    assert.match(
      result.failures.join("\n"),
      /Declared source root is missing/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("accepts declared productive source roots and targets", async () => {
  const root = await fixtureRepository();
  try {
    await mkdir(join(root, "Sources"));
    await writeFile(join(root, "Sources/App.swift"), "struct App {}\n");
    await writeFile(
      join(root, "quality/project.json"),
      JSON.stringify({
        ...validManifest,
        nativeTargets: [validTarget],
        phase: "productive",
        productiveSourceRoots: ["Sources"],
      }),
    );
    const commandNames = Object.values(validTarget.commands);
    await writeFile(
      join(root, "package.json"),
      packageJson(
        Object.fromEntries([
          ...commandNames.map((command) => [command, "node --version"]),
          [
            "quality",
            commandNames.map((command) => `npm run ${command}`).join(" && "),
          ],
        ]),
      ),
    );
    const ciPath = join(root, ".github/workflows/ci.yml");
    const ci = await readFile(ciPath, "utf8");
    await writeFile(
      ciPath,
      `${ci}\n${commandNames.map((command) => `npm run ${command}`).join("\n")}`,
    );
    const result = await validateRepository(root);
    assert.deepEqual(result.failures, []);
    assert.equal(result.productiveSourceCount, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed when productive commands are not wired locally and in CI", async () => {
  const root = await fixtureRepository();
  try {
    await mkdir(join(root, "Sources"));
    await writeFile(join(root, "Sources/App.swift"), "struct App {}\n");
    await writeFile(
      join(root, "quality/project.json"),
      JSON.stringify({
        ...validManifest,
        nativeTargets: [validTarget],
        phase: "productive",
        productiveSourceRoots: ["Sources"],
      }),
    );
    const result = await validateRepository(root);
    const failures = result.failures.join("\n");
    assert.match(failures, /Native target package script is missing/u);
    assert.match(failures, /Local quality does not execute/u);
    assert.match(failures, /CI does not execute/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("reports malformed productive manifests without throwing", async () => {
  const root = await fixtureRepository();
  try {
    const manifests = [
      {
        ...validManifest,
        nativeTargets: [{ ...validTarget, commands: undefined }],
        phase: "productive",
        productiveSourceRoots: ["Sources"],
      },
      {
        ...validManifest,
        nativeTargets: "App",
        phase: "productive",
        productiveSourceRoots: 42,
      },
    ];
    for (const manifest of manifests) {
      await writeFile(
        join(root, "quality/project.json"),
        JSON.stringify(manifest),
      );
      const result = await validateRepository(root);
      assert.ok(result.failureCount > 0);
      assert.match(
        result.failures.join("\n"),
        /must be an array|command is missing/u,
      );
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed when workflow checks or the workflow directory are missing", async () => {
  const root = await fixtureRepository();
  try {
    await writeFile(join(root, ".github/workflows/ci.yml"), "name: CI\n");
    const missingChecks = await validateRepository(root);
    assert.match(missingChecks.failures.join("\n"), /required check marker/u);
    await rm(join(root, ".github/workflows"), { force: true, recursive: true });
    const missingDirectory = await validateRepository(root);
    assert.match(
      missingDirectory.failures.join("\n"),
      /Missing workflow directory/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed when the CI Sonar quality-gate wait guard drifts", async () => {
  const root = await fixtureRepository();
  try {
    const ciPath = join(root, ".github/workflows/ci.yml");
    const ci = await readFile(ciPath, "utf8");
    await writeFile(ciPath, ci.replace("push:refs/heads/epic/*)", ""));
    const result = await validateRepository(root);
    assert.match(
      result.failures.join("\n"),
      /CI Sonar quality-gate wait guard is missing marker/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("reports provider and workflow drift without leaking file contents", async () => {
  const root = await fixtureRepository();
  try {
    await writeFile(
      join(root, "sonar-project.properties"),
      "sonar.projectKey=wrong\n",
    );
    await writeFile(
      join(root, ".github/workflows/codeql.yml"),
      "steps:\n  - uses: actions/checkout@v4\n",
    );
    const result = await validateRepository(root);
    assert.match(result.failures.join("\n"), /Unpinned action reference/u);
    assert.match(result.failures.join("\n"), /Sonar project key/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects undeclared Gitar rules and configuration surfaces", async () => {
  const root = await fixtureRepository();
  try {
    await mkdir(join(root, ".gitar/rules"), { recursive: true });
    await writeFile(join(root, ".gitar/rules/pro.md"), "# Unsupported rule\n");
    const result = await validateRepository(root);
    assert.match(
      result.failures.join("\n"),
      /exactly the governed review lenses/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed when lifecycle governance links drift", async () => {
  const root = await fixtureRepository();
  try {
    await writeFile(join(root, "AGENTS.md"), lifecycleList());
    const result = await validateRepository(root);
    assert.match(
      result.failures.join("\n"),
      /Governance lifecycle link missing from AGENTS.md/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed on lifecycle state projection drift", async () => {
  const driftCases = [
    {
      path: "quality/issue-lifecycle.mjs",
      text: lifecycleModuleSource([...lifecycleStates, "status: archived"]),
    },
    {
      path: "quality/issue-lifecycle.test.mjs",
      text: lifecycleFixtureSource(
        lifecycleStates.map((state) =>
          state === "status: done" ? "status: complete" : state,
        ),
      ),
    },
    {
      path: "docs/qa/issue-lifecycle.md",
      text: lifecycleProjectionText(lifecycleStates.slice(1)),
    },
    {
      path: "docs/qa/repository-activation.md",
      text: lifecycleProjectionText(
        lifecycleStates.filter((state) => state !== "status: triaged"),
      ),
    },
    {
      path: ".github/ISSUE_TEMPLATE/feature_task.md",
      text: lifecycleProjectionText(
        lifecycleStates.map((state) =>
          state === "status: ready" ? "status: prepared" : state,
        ),
      ),
    },
  ];

  for (const { path, text } of driftCases) {
    const root = await fixtureRepository();
    try {
      await writeFile(join(root, path), text);
      const result = await validateRepository(root);
      assert.match(result.failures.join("\n"), new RegExp(path, "u"));
      assert.match(
        result.failures.join("\n"),
        /Lifecycle state projection drift/u,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("fails closed when lifecycle workflow or coverage wiring drifts", async () => {
  const root = await fixtureRepository();
  try {
    await writeFile(
      join(root, ".github/workflows/issue-lifecycle.yml"),
      "name: Issue lifecycle\ntypes: [closed, edited]\n",
    );
    await writeFile(
      join(root, "package.json"),
      packageJson({
        coverage: coverageScript.replace(
          " --test-coverage-include=quality/issue-lifecycle-action.mjs",
          "",
        ),
      }),
    );
    const result = await validateRepository(root);
    const failures = result.failures.join("\n");
    assert.match(failures, /Issue lifecycle workflow trigger types drifted/u);
    assert.match(failures, /Coverage command must include/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed when lifecycle workflow permissions drift", async () => {
  const root = await fixtureRepository();
  try {
    const workflowPath = join(root, ".github/workflows/issue-lifecycle.yml");
    const workflow = await readFile(workflowPath, "utf8");
    await writeFile(
      workflowPath,
      workflow.replace("      issues: read", "      issues: write"),
    );
    const result = await validateRepository(root);
    const failures = result.failures.join("\n");
    assert.match(
      failures,
      /Issue lifecycle workflow permission drift, missing marker:       issues: read/u,
    );
    assert.match(
      failures,
      /Issue lifecycle must not request write permissions: issues/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
