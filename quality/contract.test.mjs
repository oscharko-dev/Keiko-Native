import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  foundationEvaluationWorkflowFailures,
  isProductiveSource,
  isAuthorizedExperimentSource,
  isSafeRepositoryPath,
  normalizeRepositoryPath,
  sonarRequiredForEvent,
  sonarWorkflowFailures,
  unpinnedActionReferences,
  validateManifest,
  validateTemporaryExperiment,
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

const validExperiment = {
  commands: [
    "experiment:foundation:verify",
    "experiment:foundation:benchmark",
    "experiment:foundation:diagnostic",
    "experiment:foundation:audit",
  ],
  contractVersion: 2,
  issue: 11,
  kind: "foundation-stack-evaluation",
  sourceRoots: ["experiments/tauri-renderer", "experiments/slint-renderer"],
  workflow: ".github/workflows/foundation-evaluation.yml",
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

test("accepts the governed bootstrap manifest", () => {
  assert.deepEqual(validateManifest(validManifest), []);
});

test("permits only the exact issue 11 experiment roots during bootstrap", () => {
  const manifest = { ...validManifest, temporaryExperiment: validExperiment };
  assert.deepEqual(validateTemporaryExperiment(manifest), []);
  assert.equal(
    isAuthorizedExperimentSource(
      "experiments/tauri-renderer/src/main.rs",
      validManifest,
    ),
    false,
  );
  assert.equal(
    isAuthorizedExperimentSource(
      "experiments/tauri-renderer/src/main.rs",
      manifest,
    ),
    true,
  );
  assert.equal(
    isAuthorizedExperimentSource(
      "experiments/slint-renderer/ui/main.slint",
      manifest,
    ),
    true,
  );
  assert.equal(
    isAuthorizedExperimentSource(
      "experiments/third-candidate/src/main.rs",
      manifest,
    ),
    false,
  );
  assert.ok(
    validateTemporaryExperiment({
      ...manifest,
      temporaryExperiment: {
        ...validExperiment,
        sourceRoots: [
          ...validExperiment.sourceRoots,
          "experiments/third-candidate",
        ],
      },
    }).length > 0,
  );
  assert.ok(
    validateTemporaryExperiment({ ...manifest, phase: "productive" }).length >
      0,
  );
});

test("keeps the temporary foundation diagnostic ARM64 and fail closed", async () => {
  const workflow = await readFile(
    join(
      import.meta.dirname,
      "..",
      ".github/workflows/foundation-evaluation.yml",
    ),
    "utf8",
  );
  const manifest = { ...validManifest, temporaryExperiment: validExperiment };
  assert.deepEqual(
    foundationEvaluationWorkflowFailures(workflow, manifest),
    [],
  );
  assert.ok(
    foundationEvaluationWorkflowFailures(
      workflow.replace('test "${RUNNER_ARCH:-}" = ARM64', "true"),
      manifest,
    ).length > 0,
  );
  assert.ok(
    foundationEvaluationWorkflowFailures(
      workflow.replace(
        "branches: [codex/11-foundation-macos-decision]",
        "branches: [dev]",
      ),
      manifest,
    ).length > 0,
  );
  assert.ok(
    foundationEvaluationWorkflowFailures(
      workflow.replace(
        "  workflow_dispatch:",
        "  pull_request:\n  workflow_dispatch:",
      ),
      manifest,
    ).length > 0,
  );
  assert.ok(
    foundationEvaluationWorkflowFailures(
      workflow.replace(
        "include-hidden-files: true",
        "include-hidden-files: false",
      ),
      manifest,
    ).length > 0,
  );
  assert.ok(
    foundationEvaluationWorkflowFailures(
      `${workflow}\n# secrets.SIGNING`,
      manifest,
    ).length > 0,
  );
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
    "some-other-root/target/generated.rs",
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

test("selects Sonar only for the complete exact-dev event matrix", () => {
  const cases = [
    [{ eventName: "pull_request", baseRef: "dev" }, true],
    [{ eventName: "pull_request", baseRef: "epic/9-foundation-v0.1" }, false],
    [{ eventName: "pull_request", baseRef: "release/v0.1.0" }, false],
    [{ eventName: "push", ref: "refs/heads/dev" }, true],
    [{ eventName: "push", ref: "refs/heads/epic/9-foundation-v0.1" }, false],
    [{ eventName: "push", ref: "refs/heads/release/v0.1.0" }, false],
    [{ eventName: "workflow_dispatch", ref: "refs/heads/dev" }, true],
    [
      {
        eventName: "workflow_dispatch",
        ref: "refs/heads/epic/9-foundation-v0.1",
      },
      false,
    ],
    [{ eventName: "workflow_dispatch", ref: "refs/heads/development" }, false],
    [{ eventName: "schedule", ref: "refs/heads/dev" }, false],
    [{ eventName: "pull_request_target", baseRef: "dev" }, false],
  ];
  for (const [event, expected] of cases)
    assert.equal(sonarRequiredForEvent(event), expected, JSON.stringify(event));
});

test("CI restricts Sonar to the exact dev event matrix while coverage stays unconditional", async () => {
  const workflow = await readFile(
    join(import.meta.dirname, "..", ".github/workflows/ci.yml"),
    "utf8",
  );
  const requiredPredicate = [
    "(github.event_name == 'pull_request' && github.base_ref == 'dev')",
    "(github.event_name == 'push' && github.ref == 'refs/heads/dev')",
    "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/dev')",
  ];
  const coverageStep = workflow.indexOf("- run: npm run coverage");
  const downloadStep = workflow.indexOf(
    "- name: Download and verify Sonar Scanner CLI",
  );
  const analysisStep = workflow.indexOf("- name: SonarQube Cloud analysis");
  assert.ok(coverageStep !== -1 && coverageStep < downloadStep);
  assert.doesNotMatch(workflow.slice(coverageStep, downloadStep), /^\s+if:/mu);
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event_name == 'workflow_dispatch' && 'dev' \|\| github\.ref \}\}/u,
  );
  assert.match(
    workflow,
    /name: Verify manual analysis is bound to remote dev[\s\S]*github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/dev'[\s\S]*git rev-parse HEAD[\s\S]*git rev-parse refs\/remotes\/origin\/dev/u,
  );
  for (const stepStart of [downloadStep, analysisStep]) {
    const step = workflow.slice(
      stepStart,
      workflow.indexOf("\n      - ", stepStart + 1),
    );
    assert.match(step, /^\s*if:/mu);
    for (const clause of requiredPredicate) assert.ok(step.includes(clause));
    assert.doesNotMatch(step, /epic|release/u);
  }
  assert.deepEqual(sonarWorkflowFailures(workflow), []);
});

test("Sonar workflow validation rejects predicate expansion and weakened failure behavior", async () => {
  const workflow = await readFile(
    join(import.meta.dirname, "..", ".github/workflows/ci.yml"),
    "utf8",
  );
  const mutations = [
    workflow.replace(
      "(github.event_name == 'push' && github.ref == 'refs/heads/dev')",
      "(github.event_name == 'push')",
    ),
    workflow.replace(
      "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/dev')",
      "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/dev') || true",
    ),
    workflow.replace(
      "      - run: npm run coverage",
      "      - run: npm run coverage\n        if: github.ref == 'refs/heads/dev'",
    ),
    workflow.replace('[ -z "$SONAR_TOKEN" ]', '[ -n "$SONAR_TOKEN" ]'),
    workflow.replace(
      "      - name: SonarQube Cloud analysis",
      "      - name: SonarQube Cloud analysis\n        continue-on-error: true",
    ),
    workflow.replace(
      "ref: ${{ github.event_name == 'workflow_dispatch' && 'dev' || github.ref }}",
      "ref: ${{ github.ref }}",
    ),
    workflow.replace(
      "if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/dev'",
      "if: github.event_name == 'workflow_dispatch'",
    ),
    workflow.replace(
      'if [ "$(git rev-parse HEAD)" != "$(git rev-parse refs/remotes/origin/dev)" ]; then',
      'if [ "$(git rev-parse HEAD)" != "$(git rev-parse refs/remotes/origin/main)" ]; then',
    ),
    workflow.replace(
      "      - name: Verify manual analysis is bound to remote dev",
      "      - name: Verify manual analysis was requested",
    ),
  ];
  for (const mutation of mutations)
    assert.ok(sonarWorkflowFailures(mutation).length > 0);
});

test("public governance records exact-target authenticated epic merge and sacred dev", async () => {
  const root = join(import.meta.dirname, "..");
  const [agents, gates, activation, adr] = await Promise.all([
    readFile(join(root, "AGENTS.md"), "utf8"),
    readFile(join(root, "docs/qa/quality-gates.md"), "utf8"),
    readFile(join(root, "docs/qa/repository-activation.md"), "utf8"),
    readFile(
      join(root, "docs/adr/ADR-0003-free-tier-sonar-and-epic-delivery.md"),
      "utf8",
    ),
  ]);
  for (const document of [agents, gates, activation, adr]) {
    assert.match(document, /authenticated maintainer account/u);
    assert.match(document, /exact accepted epic/u);
    assert.match(
      document,
      /Never\s+(?:merge|enable auto-merge)[\s\S]{0,80}`dev`/u,
    );
  }
  assert.match(adr, /PR #15/u);
  assert.match(adr, /one-time/u);
  assert.match(
    gates,
    /for actions\s+targeting `dev`, operate through a human merge-capable credential/u,
  );
  assert.doesNotMatch(
    gates,
    /or operate through a\s+human merge-capable credential\./u,
  );
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
  ];
  for (const file of files) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), "fixture\n");
  }
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { quality: "fixture" } }),
  );
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
      "jobs:",
      "  core-quality:",
      "    name: Core quality",
      "    steps:",
      "      - run: npm run quality",
      "  coverage-sonar:",
      "    name: Coverage and SonarCloud",
      "    steps:",
      "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "        with:",
      "          ref: ${{ github.event_name == 'workflow_dispatch' && 'dev' || github.ref }}",
      "      - name: Verify manual analysis is bound to remote dev",
      "        if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/dev'",
      "        run: |",
      '          if [ "$(git rev-parse HEAD)" != "$(git rev-parse refs/remotes/origin/dev)" ]; then',
      "            exit 1",
      "          fi",
      "      - run: npm run coverage",
      "      - name: Download and verify Sonar Scanner CLI",
      "        if: >-",
      "          (github.event_name == 'pull_request' && github.base_ref == 'dev') ||",
      "          (github.event_name == 'push' && github.ref == 'refs/heads/dev') ||",
      "          (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/dev')",
      "        run: verify-scanner",
      "      - name: SonarQube Cloud analysis",
      "        if: >-",
      "          (github.event_name == 'pull_request' && github.base_ref == 'dev') ||",
      "          (github.event_name == 'push' && github.ref == 'refs/heads/dev') ||",
      "          (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/dev')",
      "        env:",
      "          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}",
      "        run: |",
      '          if [ -z "$SONAR_TOKEN" ]; then',
      "            exit 1",
      "          fi",
      "          sonar-scanner -Dsonar.qualitygate.wait=true",
      "  cross-platform-smoke:",
      "    name: Cross-platform smoke",
      "    steps:",
      "      - run: npm test",
      "  ci:",
      "    name: ci",
      "    if: ${{ always() }}",
      "    needs:",
      "      - core-quality",
      "      - coverage-sonar",
      "      - cross-platform-smoke",
      "    steps:",
      "      - run: verify-results",
      "  actionlint:",
      "    name: actionlint",
      "    steps:",
      "      - run: actionlint",
      "  verify-pinned-shas:",
      "    name: Verify pinned action SHAs",
      "    steps:",
      "      - run: verify-pinned-shas",
      "  zizmor:",
      "    name: zizmor",
      "    steps:",
      "      - run: zizmor",
      "  build-scan-sbom-smoke:",
      "    name: Build, scan, SBOM, smoke",
      "    steps:",
      "      - run: build-scan-sbom-smoke",
      "  native:",
      "    name: native",
      "    steps:",
      "      - run: native",
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

test("permits experiment source only under the exact issue 11 roots", async () => {
  const root = await fixtureRepository();
  try {
    await writeFile(
      join(root, "quality/project.json"),
      JSON.stringify({
        ...validManifest,
        temporaryExperiment: validExperiment,
      }),
    );
    const packageJson = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    packageJson.scripts = {
      ...packageJson.scripts,
      "experiment:foundation:audit":
        "node quality/foundation-evaluation/cli.mjs audit",
      "experiment:foundation:benchmark":
        "node quality/foundation-evaluation/cli.mjs benchmark",
      "experiment:foundation:diagnostic":
        "node quality/foundation-evaluation/cli.mjs diagnostic",
      "experiment:foundation:verify":
        "node quality/foundation-evaluation/cli.mjs verify",
    };
    await writeFile(join(root, "package.json"), JSON.stringify(packageJson));
    await writeFile(
      join(root, ".github/workflows/foundation-evaluation.yml"),
      await readFile(
        join(
          import.meta.dirname,
          "..",
          ".github/workflows/foundation-evaluation.yml",
        ),
        "utf8",
      ),
    );
    await mkdir(join(root, "experiments/tauri-renderer/src"), {
      recursive: true,
    });
    await writeFile(
      join(root, "experiments/tauri-renderer/src/main.rs"),
      "fn main() {}\n",
    );
    const accepted = await validateRepository(root);
    assert.deepEqual(accepted.failures, []);

    await mkdir(join(root, "some-other-root/target"), { recursive: true });
    await writeFile(
      join(root, "some-other-root/target/generated.rs"),
      "fn hidden() {}\n",
    );
    const rejected = await validateRepository(root);
    assert.equal(rejected.productiveSourceCount, 1);
    assert.match(
      rejected.failures.join("\n"),
      /Productive source exists while the project is in bootstrap phase/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed when an applicable CI job becomes dev-only", async () => {
  const root = await fixtureRepository();
  try {
    const path = join(root, ".github/workflows/ci.yml");
    const workflow = await readFile(path, "utf8");
    for (const jobName of [
      "core-quality",
      "coverage-sonar",
      "cross-platform-smoke",
      "actionlint",
      "verify-pinned-shas",
      "zizmor",
      "build-scan-sbom-smoke",
      "native",
    ]) {
      const mutation = workflow.replace(
        "  " + jobName + ":\n",
        "  " + jobName + ":\n    if: github.ref == 'refs/heads/dev'\n",
      );
      assert.notEqual(mutation, workflow);
      await writeFile(path, mutation);
      const result = await validateRepository(root);
      assert.ok(
        result.failures.includes(
          `CI job must remain applicable and unconditional on accepted events: ${jobName}.`,
        ),
        `expected unconditional-job failure for ${jobName}`,
      );
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed when the aggregate ci job no longer always needs every core result", async () => {
  const root = await fixtureRepository();
  try {
    const path = join(root, ".github/workflows/ci.yml");
    const workflow = await readFile(path, "utf8");
    const mutations = [
      workflow.replace(
        "    if: ${{ always() }}",
        "    if: github.ref == 'refs/heads/dev'",
      ),
      workflow.replace("      - coverage-sonar\n", ""),
    ];
    for (const mutation of mutations) {
      assert.notEqual(mutation, workflow);
      await writeFile(path, mutation);
      const result = await validateRepository(root);
      assert.match(result.failures.join("\n"), /aggregate ci job/u);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed when security workflows omit an epic event", async () => {
  const cases = [
    {
      event: "pull_request",
      expected:
        "Workflow must validate pull requests targeting epic branches: codeql.yml.",
      workflow: "codeql.yml",
    },
    {
      event: "push",
      expected: "Workflow must validate epic branch heads: codeql.yml.",
      workflow: "codeql.yml",
    },
    {
      event: "pull_request",
      expected:
        "Workflow must validate pull requests targeting epic branches: osv-scanner.yml.",
      workflow: "osv-scanner.yml",
    },
    {
      event: "push",
      expected: "Workflow must validate epic branch heads: osv-scanner.yml.",
      workflow: "osv-scanner.yml",
    },
    {
      event: "pull_request",
      expected:
        "Workflow must validate pull requests targeting epic branches: dependency-review.yml.",
      workflow: "dependency-review.yml",
    },
  ];

  for (const scenario of cases) {
    const root = await fixtureRepository();
    try {
      const path = join(root, ".github/workflows", scenario.workflow);
      const workflow = await readFile(path, "utf8");
      const eventBlock = [
        `  ${scenario.event}:`,
        "    branches:",
        '      - "epic/**"',
      ].join("\n");
      const mutation = workflow.replace(
        eventBlock,
        [`  ${scenario.event}:`, "    branches:"].join("\n"),
      );
      assert.notEqual(
        mutation,
        workflow,
        `expected ${scenario.workflow} ${scenario.event} fixture mutation`,
      );
      await writeFile(path, mutation);
      const result = await validateRepository(root);
      assert.ok(
        result.failures.includes(scenario.expected),
        `expected epic workflow failure for ${scenario.workflow} ${scenario.event}`,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
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
      JSON.stringify({
        scripts: Object.fromEntries([
          ...commandNames.map((command) => [command, "node --version"]),
          [
            "quality",
            commandNames.map((command) => `npm run ${command}`).join(" && "),
          ],
        ]),
      }),
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
      JSON.stringify({
        scripts: Object.fromEntries([
          ...commandNames.map((command) => [command, "node --version"]),
          [
            "quality",
            commandNames.map((command) => `npm run ${command}`).join(" && "),
          ],
        ]),
      }),
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
