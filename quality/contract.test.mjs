import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalCoverageCommand } from "./coverage-reporter.mjs";
import {
  aggregateCiBindingFailures,
  coverageCommandFailures,
  dependencyReviewWorkflowFailures,
  isProductiveSource,
  isSafeRepositoryPath,
  mutationWorkflowFailures,
  nativeCiWorkflowFailures,
  normalizeRepositoryPath,
  sonarRequiredForEvent,
  sonarWorkflowFailures,
  unpinnedActionReferences,
  validateManifest,
  validateNativeTarget,
  validateRepository,
  workflowEventTargetsBranch,
} from "./contract.mjs";
import { governedWorkflowJobs } from "./workflow-job-contracts.mjs";

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
    format: "native:format",
    lint: "native:lint",
    package: "native:package",
    platform: "native:platform",
    security: "native:security",
    signing: "native:signing",
    test: "native:test",
  },
  language: "swift",
  name: "KeikoNative",
  platforms: ["macos"],
  sourceRoot: "Sources",
};
const qualityControlScript =
  "npm run native:dependencies && npm run check:contract && npm run lint && npm run format:check && npm run coverage && npm run build";

const adr0006SourceRoots = [
  "native/crates/keiko-application/src/",
  "native/crates/keiko-ui-port/src/",
  "native/crates/keiko-host-macos/src/",
  "native/apps/keiko-desktop/src/",
  "native/frontend/src/",
];

const adr0006TestRoots = ["native/tests/"];

const adr0006SupportFiles = [
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

const coverageToolchains = {
  productiveRust: "1.92.0",
  rustBranch: "nightly-2026-07-17",
  cargoLlvmCov: "0.8.7",
  frontend: "vitest-v8",
};

const adr0006Target = {
  architectures: ["arm64"],
  commands: {
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
  },
  language: "rust",
  name: "keiko-native-desktop",
  platforms: ["macos"],
  sourceRoots: adr0006SourceRoots,
};

const productiveCommands = [
  ...Object.values(adr0006Target.commands),
  "acceptance:macos",
];

function productiveManifest(overrides = {}) {
  return {
    ...validManifest,
    coverageExclusions: [
      {
        path: "native/apps/keiko-desktop/src/main.rs",
        evidence: "acceptance:macos",
      },
    ],
    coverageToolchains,
    nativeTargets: [adr0006Target],
    phase: "productive",
    productiveSourceRoots: adr0006SourceRoots,
    qualityProfile: "keiko-native-productive-v1",
    supportFiles: adr0006SupportFiles,
    testSourceRoots: adr0006TestRoots,
    ...overrides,
  };
}

async function createDeclaredNativePaths(root) {
  for (const sourceRoot of [...adr0006SourceRoots, ...adr0006TestRoots]) {
    await mkdir(join(root, sourceRoot), { recursive: true });
  }
  for (const file of adr0006SupportFiles) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), "fixture\n");
  }
}

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

const repositoryControlPlaneModules = Object.freeze([
  "quality/publication-contract-schema.mjs",
  "quality/repository-contract-chain.mjs",
  "quality/repository-contract.mjs",
  "quality/publication-candidate.mjs",
  "quality/publication-contract.mjs",
  "quality/lifecycle-generation.mjs",
  "quality/lifecycle-handoff-generation.mjs",
  "quality/lifecycle-handoff-publication.mjs",
  "quality/lifecycle-handoff.mjs",
  "quality/merge-group.mjs",
  "quality/epic-merge-broker.mjs",
]);

const coverageScript = canonicalCoverageCommand;

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
  assert.ok(
    failures.includes(
      "The keiko-native-productive-v1 quality profile is required.",
    ),
  );
  assert.ok(
    failures.includes("testSourceRoots must be an array in productive mode."),
  );
  assert.ok(
    failures.includes("supportFiles must be an array in productive mode."),
  );
  assert.ok(
    failures.includes(
      "Productive projects must declare source roots and native targets.",
    ),
  );
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
    ]).length > 8,
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

function assertAgentCredentialProjection(document) {
  assert.match(
    document,
    /existing\s+authenticated\s+maintainer\s+credential/iu,
  );
  assert.match(document, /exact\s+accepted\s+`epic\/\*\*`\s+target/iu);
  assert.match(document, /`status:\s+ready\s+for\s+human\s+review`/iu);
  assert.match(
    document,
    /never[\s\S]{0,80}(?:use|using|uses|invoke|invokes|enable)\s+provider\s+auto-merge/iu,
  );
  assert.match(
    document,
    /GitHub(?:\s+attribution)?\s+(?:therefore\s+)?cannot\s+distinguish[\s\S]{0,120}agent[\s\S]{0,120}human/iu,
  );
  assert.match(
    document,
    /(?:never|no)[\s\S]{0,120}(?:merge|auto-merge)[\s\S]{0,120}`dev`/iu,
  );
  assert.match(
    document,
    /`dev`[\s\S]{0,160}`main`[\s\S]{0,160}`release\/\*\*`/iu,
  );
  assert.match(document, /ambiguous[\s\S]{0,180}(?:no\s+retry|never\s+retr)/iu);
}

test("public governance restricts agent credential merges to exact epic targets and keeps dev sacred", async () => {
  const root = join(import.meta.dirname, "..");
  const [
    agents,
    baseline,
    gates,
    activation,
    taskTemplate,
    decisionTemplate,
    defectTemplate,
    pullRequestTemplate,
    supersedingAdr,
    historicalAdr,
    brokerAdr,
  ] = await Promise.all([
    readFile(join(root, "AGENTS.md"), "utf8"),
    readFile(join(root, "docs/planning/agent-planning-baseline.md"), "utf8"),
    readFile(join(root, "docs/qa/quality-gates.md"), "utf8"),
    readFile(join(root, "docs/qa/repository-activation.md"), "utf8"),
    readFile(join(root, ".github/ISSUE_TEMPLATE/feature_task.md"), "utf8"),
    readFile(
      join(root, ".github/ISSUE_TEMPLATE/decision_evaluation.md"),
      "utf8",
    ),
    readFile(join(root, ".github/ISSUE_TEMPLATE/defect_finding.md"), "utf8"),
    readFile(join(root, ".github/pull_request_template.md"), "utf8"),
    readFile(
      join(
        root,
        "docs/adr/ADR-0009-agent-scoped-maintainer-credential-epic-merge.md",
      ),
      "utf8",
    ),
    readFile(
      join(root, "docs/adr/ADR-0005-free-tier-sonar-and-epic-delivery.md"),
      "utf8",
    ),
    readFile(
      join(root, "docs/adr/ADR-0008-restricted-broker-epic-auto-merge.md"),
      "utf8",
    ),
  ]);
  const policyProjections = [
    agents,
    baseline,
    gates,
    activation,
    taskTemplate,
    decisionTemplate,
    defectTemplate,
    pullRequestTemplate,
  ];
  const activeProjections = [...policyProjections, supersedingAdr];
  for (const [index, document] of activeProjections.entries()) {
    assertAgentCredentialProjection(document);
    const autoMergeMutation = document.replace(
      /never(?=[\s\S]{0,80}(?:use|using|uses|invoke|invokes|enable)\s+provider\s+auto-merge)/giu,
      "may",
    );
    assert.notEqual(autoMergeMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(autoMergeMutation),
      { name: "AssertionError" },
      `projection ${index} accepted provider auto-merge authorization`,
    );
    const identityMutation = document.replace(
      /(GitHub(?:\s+attribution)?\s+(?:therefore\s+)?)cannot\s+distinguish/giu,
      "$1can distinguish",
    );
    assert.notEqual(identityMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(identityMutation),
      { name: "AssertionError" },
      `projection ${index} omitted the shared-identity limitation`,
    );
  }
  for (const document of policyProjections) {
    assert.doesNotMatch(document, /server-side\s+merge-authority broker/iu);
    assert.doesNotMatch(document, /dedicated non-human GitHub App/iu);
  }
  assert.match(supersedingAdr, /Supersedes ADR-0008/u);
  assert.match(supersedingAdr, /amends[\s\S]*ADR-0004/iu);
  assert.match(supersedingAdr, /restores[\s\S]*ADR-0005/iu);
  assert.match(supersedingAdr, /ADR-0005's Sonar[\s\S]*unchanged/u);
  assert.match(supersedingAdr, /Issue #114/u);
  assert.match(
    supersedingAdr,
    /cannot distinguish[\s\S]{0,120}agent[\s\S]{0,120}human/iu,
  );
  assert.match(
    supersedingAdr,
    /exact current head[\s\S]{0,180}exact current base/iu,
  );
  assert.match(supersedingAdr, /at most once/iu);
  assert.match(
    supersedingAdr,
    /`Merge a pull request`[\s\S]{0,180}request field `sha`[\s\S]{0,180}`409 Conflict`/u,
  );
  assert.match(
    supersedingAdr,
    /`expected_head_sha`[\s\S]{0,260}`Update a pull request branch`[\s\S]{0,260}not\s+the\s+merge\s+precondition/iu,
  );
  assert.match(
    supersedingAdr,
    /https:\/\/docs\.github\.com\/en\/rest\/pulls\/pulls#merge-a-pull-request/u,
  );
  assert.match(
    supersedingAdr,
    /A — Guarded existing maintainer credential[\s\S]{0,180}\*\*4\.25\*\*/u,
  );
  assert.match(
    supersedingAdr,
    /B — Dedicated App and broker[\s\S]{0,180}\*\*3\.70\*\*/u,
  );
  assert.match(
    supersedingAdr,
    /C — Human-only child integration[\s\S]{0,180}\*\*3\.95\*\*/u,
  );
  assert.match(supersedingAdr, /recommendation and outcome are unchanged/iu);
  assert.match(
    supersedingAdr,
    /human reconciliation[\s\S]*exact[\s\S]*parents/iu,
  );
  assert.match(historicalAdr, /PR #15/u);
  assert.match(historicalAdr, /one-time/u);
  assert.match(historicalAdr, /authenticated maintainer account/u);
  assert.match(brokerAdr, /dedicated non-human GitHub App/u);
  assert.match(brokerAdr, /Supersedes ADR-0005/u);
  assert.match(
    gates,
    /shared identity[\s\S]{0,180}cannot[\s\S]{0,120}distinguish/iu,
  );
});

async function fixtureRepository() {
  const root = await mkdtemp(join(tmpdir(), "keiko-native-quality-"));
  const files = [
    ".npmrc",
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
    ".github/workflows/contract-publication.yml",
    ".github/workflows/dependency-review.yml",
    ".github/workflows/issue-lifecycle.yml",
    ".github/workflows/issue-readiness.yml",
    ".github/workflows/merge-group.yml",
    ".github/workflows/internal-release.yml",
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
    "quality/check-native-vulnerability-results.mjs",
    "quality/generate-native-vulnerability-inventory.mjs",
    "quality/github-api.mjs",
    "quality/github-reference.mjs",
    "quality/issue-contract.mjs",
    "quality/issue-lifecycle-action.mjs",
    "quality/issue-lifecycle-readiness.mjs",
    "quality/issue-lifecycle.mjs",
    "quality/issue-lifecycle.test.mjs",
    "quality/issue-readiness-action.mjs",
    "quality/internal-release.mjs",
    "quality/internal-release-workflow.mjs",
    "quality/attestation-policy.mjs",
    "quality/iso-normalization.mjs",
    "quality/markdown-contract.mjs",
    "quality/pr-contract-action.mjs",
    "quality/pr-contract.mjs",
    ...repositoryControlPlaneModules,
    "quality/release-contract.mjs",
    "quality/release-evidence.mjs",
    "quality/release-inputs.mjs",
    "quality/release-io.mjs",
    "quality/release-mounted.mjs",
    "quality/release-native-fs.mjs",
    "quality/release-owned-fs.mjs",
    "quality/release-system.mjs",
    "quality/release-verify.mjs",
    "quality/update-metadata.mjs",
    "socket.yml",
  ];
  for (const file of files) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), "fixture\n");
  }
  await writeFile(join(root, "package.json"), packageJson());
  await writeFile(join(root, ".npmrc"), "engine-strict=true\n");
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
    [
      "# Repository activation checklist",
      lifecycleList(),
      "## Pending contract-publication controls",
      "Contract publication remains disabled until the human activation probes pass.",
      "The `Contract publication` context is not enrolled as required.",
      "## Pending merge-queue and epic-merge controls",
      "The merge queue remains disabled until its human liveness and ordering probe passes.",
      "Automated epic-branch merge remains disabled until provider semantics are proven.",
    ].join("\n"),
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
      "jobs:",
      governedWorkflowJobs["core-quality"],
      governedWorkflowJobs["coverage-sonar"],
      governedWorkflowJobs["cross-platform-smoke"],
      governedWorkflowJobs.ci,
      governedWorkflowJobs.actionlint,
      governedWorkflowJobs["verify-pinned-shas"],
      governedWorkflowJobs.zizmor,
      governedWorkflowJobs["build-scan-sbom-smoke"],
      governedWorkflowJobs["native-matrix"],
      governedWorkflowJobs.native,
    ].join("\n"),
  );
  await writeFile(
    join(root, ".github/workflows/internal-release.yml"),
    await readFile(
      join(import.meta.dirname, "../.github/workflows/internal-release.yml"),
      "utf8",
    ),
  );
  await writeFile(
    join(root, ".github/workflows/mutation-security.yml"),
    ["jobs:", governedWorkflowJobs["native-mutation-security"]].join("\n"),
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
    if (name === "codeql.yml")
      lines.push("  push:", "    branches:", '      - "epic/**"');
    else if (name === "dependency-review.yml") {
      lines.push(
        "permissions: {}",
        "jobs:",
        governedWorkflowJobs["dependency-review"],
      );
    } else
      lines.push(
        "  push:",
        "    branches:",
        '      - "epic/**"',
        "permissions: {}",
        "jobs:",
        governedWorkflowJobs["osv-scan"],
      );
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
    join(root, ".github/workflows/contract-publication.yml"),
    [
      "name: Contract publication (inert)",
      "on:",
      "  workflow_dispatch:",
      "permissions: {}",
      "jobs:",
      "  validate:",
      "    if: ${{ vars.KEIKO_CONTRACT_PUBLICATION_ACTIVATION == 'enabled' }}",
      "    permissions:",
      "      contents: read",
      "    steps:",
      "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "        with:",
      "          persist-credentials: false",
      "          ref: dev",
      "      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
      "        with:",
      '          node-version: "24.18.0"',
      "          package-manager-cache: false",
      "      - name: Validate protected publication policy",
      "        env:",
      "          KEIKO_CONTRACT_PUBLICATION_ACTIVATION: disabled",
      "        run: |",
      "          node --check quality/publication-contract.mjs",
      "          node --check quality/lifecycle-handoff-publication.mjs",
    ].join("\n"),
  );
  await writeFile(
    join(root, ".github/workflows/merge-group.yml"),
    [
      "name: Merge group policy (inert)",
      "on:",
      "  merge_group:",
      "    types: [checks_requested]",
      "  workflow_dispatch:",
      "permissions: {}",
      "jobs:",
      "  evaluate:",
      "    if: ${{ vars.KEIKO_MERGE_GROUP_ACTIVATION == 'enabled' }}",
      "    permissions:",
      "      contents: read",
      "    steps:",
      "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "        with:",
      "          persist-credentials: false",
      "          ref: dev",
      "      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
      "        with:",
      '          node-version: "24.18.0"',
      "          package-manager-cache: false",
      "      - name: Validate protected merge policy",
      "        env:",
      "          KEIKO_EPIC_MERGE_AUTOMATION: disabled",
      "          KEIKO_MERGE_GROUP_ACTIVATION: disabled",
      "        run: |",
      "          node --check quality/merge-group.mjs",
      "          node --check quality/epic-merge-broker.mjs",
    ].join("\n"),
  );
  await writeFile(
    join(root, ".github/workflows/issue-lifecycle.yml"),
    [
      "name: Issue lifecycle",
      "on:",
      "  issues:",
      "    types: [assigned, closed, edited, labeled, reopened, unassigned, unlabeled]",
      "  workflow_call:",
      "    inputs:",
      "      issue_number:",
      "      pr_contract_result:",
      "permissions: {}",
      "concurrency:",
      "  group: issue-lifecycle-${{ inputs.issue_number || github.event.issue.number }}",
      "  cancel-in-progress: false",
      "jobs:",
      "  classify:",
      "    permissions:",
      "      contents: read",
      "      issues: read",
      "      pull-requests: read",
      "      statuses: read",
      "    steps:",
      "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "        with:",
      "          persist-credentials: false",
      "          ref: dev",
      "      - name: Compute the inert lifecycle decision",
      "        env:",
      "          KEIKO_ISSUE_LIFECYCLE_ACTIVATION: disabled",
      "          KEIKO_PR_CONTRACT_RESULT: ${{ inputs.pr_contract_result }}",
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
      "types: [opened, edited, reopened, synchronize, ready_for_review, converted_to_draft, closed]",
      "cancel-in-progress: false",
      "name: Evaluate trusted PR metadata",
      "issue-number: ${{ steps.contract.outputs.issue-number }}",
      "ref: dev",
      "statuses: read",
      "statuses: write",
      "  KEIKO_ISSUE_LIFECYCLE_ACTIVATION: disabled",
      "node quality/pr-contract-action.mjs",
      "uses: ./.github/workflows/issue-lifecycle.yml",
      "always() && needs.contract.outputs.issue-number != ''",
      "  issue_number: ${{ needs.contract.outputs.issue-number }}",
      "  pr_contract_result: ${{ needs.contract.result }}",
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

test("rejects temporary experiment source during bootstrap", async () => {
  const root = await fixtureRepository();
  try {
    await mkdir(join(root, "experiments/tauri-renderer/src"), {
      recursive: true,
    });
    await writeFile(
      join(root, "experiments/tauri-renderer/src/main.rs"),
      "fn main() {}\n",
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

test("root npm configuration accepts only exact LF or CRLF content", async () => {
  const root = await fixtureRepository();
  try {
    const npmConfig = join(root, ".npmrc");
    await writeFile(npmConfig, "engine-strict=true\r\n");
    assert.doesNotMatch(
      (await validateRepository(root)).failures.join("\n"),
      /Root npm configuration/u,
    );
    for (const invalid of [
      "engine-strict=true\r",
      "engine-strict=true \r\n",
      "engine-strict=true\r\nextra=true\r\n",
    ]) {
      await writeFile(npmConfig, invalid);
      assert.match(
        (await validateRepository(root)).failures.join("\n"),
        /Root npm configuration/u,
      );
    }
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
      JSON.stringify(productiveManifest()),
    );
    const commandNames = productiveCommands;
    await writeFile(
      join(root, "package.json"),
      packageJson(
        Object.fromEntries([
          ...commandNames.map((command) => [command, "node --version"]),
          ["coverage", canonicalCoverageCommand],
          ["quality:control", qualityControlScript],
          [
            "quality",
            [
              "node quality/check-toolchain.mjs",
              "npm run quality:control",
              ...commandNames.map((command) => `npm run ${command}`),
            ].join(" && "),
          ],
        ]),
      ),
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
    await createDeclaredNativePaths(root);
    await writeFile(
      join(root, "native/crates/keiko-application/src/lib.rs"),
      'pub fn health() -> &\'static str { "healthy" }\n',
    );
    await writeFile(
      join(root, "quality/project.json"),
      JSON.stringify(productiveManifest()),
    );
    const commandNames = productiveCommands;
    await writeFile(
      join(root, "package.json"),
      packageJson(
        Object.fromEntries([
          ...commandNames.map((command) => [command, "node --version"]),
          ["coverage", canonicalCoverageCommand],
          ["quality:control", qualityControlScript],
          [
            "quality",
            [
              "node quality/check-toolchain.mjs",
              "npm run quality:control",
              ...commandNames.map((command) => `npm run ${command}`),
            ].join(" && "),
          ],
        ]),
      ),
    );
    const result = await validateRepository(root);
    assert.deepEqual(result.failures, []);
    assert.equal(result.productiveSourceCount, 3);
    const packagePath = join(root, "package.json");
    const packageContract = JSON.parse(await readFile(packagePath, "utf8"));
    packageContract.scripts["quality:control"] = "npm run build";
    await writeFile(packagePath, JSON.stringify(packageContract));
    assert.ok(
      (await validateRepository(root)).failures.includes(
        "Portable quality control composition must remain exact.",
      ),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("productive coverage exclusion stays bound to packaged acceptance", () => {
  assert.ok(
    validateManifest(productiveManifest({ coverageExclusions: [] })).includes(
      "Coverage exclusions must bind only thin Tauri wiring to packaged acceptance.",
    ),
  );
});

test("fails closed when productive commands are not wired locally and in CI", async () => {
  const root = await fixtureRepository();
  try {
    await createDeclaredNativePaths(root);
    await writeFile(
      join(root, "native/crates/keiko-application/src/lib.rs"),
      'pub fn health() -> &\'static str { "healthy" }\n',
    );
    await writeFile(
      join(root, "quality/project.json"),
      JSON.stringify(productiveManifest()),
    );
    const ciPath = join(root, ".github/workflows/ci.yml");
    const ci = await readFile(ciPath, "utf8");
    await writeFile(
      ciPath,
      ci
        .replace("  native-matrix:\n", "  native-matrix-removed:\n")
        .replace('          test "$(uname -m)" = arm64', "          true"),
    );
    const result = await validateRepository(root);
    const failures = result.failures.join("\n");
    assert.match(failures, /Native target package script is missing/u);
    assert.match(failures, /Local quality does not execute/u);
    assert.match(failures, /Native CI command step/u);
    assert.match(failures, /Native acceptance package script is missing/u);
    assert.match(failures, /Native CI marker is missing/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("reports malformed productive manifests without throwing", async () => {
  const root = await fixtureRepository();
  try {
    const manifests = [
      productiveManifest({
        nativeTargets: [{ ...validTarget, commands: undefined }],
        productiveSourceRoots: ["Sources"],
      }),
      productiveManifest({
        nativeTargets: "App",
        productiveSourceRoots: 42,
      }),
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

test("native CI exposes one exact aggregate check over separate matrix legs", () => {
  const valid = [
    "jobs:",
    "  native-matrix:",
    "    name: native (${{ matrix.runner }})",
    "    strategy:",
    "      matrix:",
    "        runner: [macos-14, macos-26]",
    "  native:",
    "    name: native",
    "    if: ${{ always() }}",
    "    needs:",
    "      - native-matrix",
    "    steps:",
    "      - env:",
    "          RESULT: ${{ needs.native-matrix.result }}",
  ].join("\n");
  assert.deepEqual(nativeCiWorkflowFailures(valid), []);
  for (const mutation of [
    valid.replace("native-matrix:", "native-other:"),
    valid.replace("name: native (${{ matrix.runner }})", "name: native"),
    valid.replace("macos-14, macos-26", "macos-14"),
    valid.replace("name: native\n", "name: native result\n"),
    valid.replace("if: ${{ always() }}", "if: ${{ success() }}"),
    valid.replace("- native-matrix", "- native-other"),
    valid.replace("needs.native-matrix.result", "needs.native-other.result"),
  ]) {
    assert.ok(nativeCiWorkflowFailures(mutation).length > 0);
  }
});

test("productive CI aggregate binds and checks every exact dependency result", () => {
  const valid = [
    "jobs:",
    "  ci:",
    "    env:",
    "      CORE_QUALITY_RESULT: ${{ needs.core-quality.result }}",
    "      COVERAGE_SONAR_RESULT: ${{ needs.coverage-sonar.result }}",
    "      CROSS_PLATFORM_RESULT: ${{ needs.cross-platform-smoke.result }}",
    "      NATIVE_RESULT: ${{ needs.native.result }}",
    "    run: |",
    '      for result in "$CORE_QUALITY_RESULT" "$COVERAGE_SONAR_RESULT" "$CROSS_PLATFORM_RESULT" "$NATIVE_RESULT"; do',
    "        true",
    "      done",
  ].join("\n");
  assert.deepEqual(aggregateCiBindingFailures(valid), []);
  for (const mutation of [
    valid.replace("needs.core-quality.result", "needs.native.result"),
    valid.replace("needs.coverage-sonar.result", "needs.core-quality.result"),
    valid.replace("needs.cross-platform-smoke.result", "needs.native.result"),
    valid.replace("needs.native.result", "needs.core-quality.result"),
    valid.replace(' "$CORE_QUALITY_RESULT"', ""),
    valid.replace(' "$COVERAGE_SONAR_RESULT"', ""),
    valid.replace(' "$CROSS_PLATFORM_RESULT"', ""),
    valid.replace(' "$NATIVE_RESULT"', ""),
  ]) {
    assert.ok(aggregateCiBindingFailures(mutation).length > 0);
  }
});

test("mutation workflow pins cargo-mutants execution to Rust 1.92", () => {
  const valid = [
    "cargo +1.92.0 install cargo-mutants --version 27.1.0 --locked",
    "cargo +1.92.0 mutants --manifest-path native/Cargo.toml",
  ].join("\n");
  assert.deepEqual(mutationWorkflowFailures(valid), []);
  for (const mutation of [
    valid.replace("+1.92.0 install", "install"),
    valid.replace("+1.92.0 mutants", "mutants"),
    `${valid}\ncargo mutants --manifest-path native/Cargo.toml`,
  ]) {
    assert.ok(mutationWorkflowFailures(mutation).length > 0);
  }
});

test("dependency review closes target-aware vulnerability and license policy", () => {
  const valid = [
    "        run: node quality/generate-native-vulnerability-inventory.mjs",
    "          scan-args: |-",
    "            --lockfile=package-lock.json",
    "            --lockfile=native/frontend/package-lock.json",
    "            --lockfile=osv-scanner:native/target/osv/native-macos-arm64.osv-scanner.json",
    "          node quality/check-native-vulnerability-results.mjs",
    "        with:",
    "          fail-on-severity: moderate",
    "          fail-on-scopes: development, runtime, unknown",
    "          vulnerability-check: false",
    "          allow-licenses: >-",
    "            0BSD, Apache-2.0, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, CC-BY-4.0,",
    "            CC0-1.0, ISC, MIT, MPL-2.0, Python-2.0, Unicode-3.0, Unlicense, WTFPL, Zlib",
    "          allow-dependencies-licenses: pkg:cargo/target-lexicon@0.12.16",
    "          retry-on-snapshot-warnings: true",
  ].join("\n");
  assert.deepEqual(dependencyReviewWorkflowFailures(valid), []);
  for (const mutation of [
    valid.replace("moderate", "high"),
    valid.replace("development, runtime, unknown", "runtime"),
    valid.replace("vulnerability-check: false", "vulnerability-check: true"),
    valid.replace(
      "generate-native-vulnerability-inventory.mjs",
      "native/Cargo.lock",
    ),
    valid.replace("check-native-vulnerability-results.mjs", "smoke.mjs"),
    valid.replace(
      "--lockfile=osv-scanner:native/target/osv/native-macos-arm64.osv-scanner.json",
      "--lockfile=native/Cargo.lock",
    ),
    `${valid}\n            --recursive`,
    valid.replace("MPL-2.0, ", ""),
    valid.replace("Unicode-3.0, ", ""),
    valid.replace(", Zlib", ""),
    valid.replace("Zlib", "Zlib-plus"),
    valid.replace(
      "          allow-dependencies-licenses: pkg:cargo/target-lexicon@0.12.16\n",
      "",
    ),
    valid.replace("target-lexicon@0.12.16", "target-lexicon@0.12.15"),
    valid.replace(
      "target-lexicon@0.12.16",
      "target-lexicon@0.12.16,pkg:cargo/owned@1.0.0",
    ),
  ]) {
    assert.ok(dependencyReviewWorkflowFailures(mutation).length > 0);
  }
});

test("coverage command freezes deterministic serial execution", async () => {
  const packageContract = JSON.parse(
    await readFile(join(import.meta.dirname, "../package.json"), "utf8"),
  );
  const command = packageContract.scripts.coverage;
  assert.deepEqual(coverageCommandFailures(command), []);
  for (const mutation of [
    command.replace(" --test-concurrency=1", ""),
    command.replace("--test-concurrency=1", "--test-concurrency=2"),
    command.replace("--test-concurrency=1", "--test-concurrency=4"),
    `${command} --test-concurrency=1`,
    command.replace(
      "--test-reporter=./quality/coverage-reporter.mjs",
      "--test-reporter=spec",
    ),
  ]) {
    assert.ok(coverageCommandFailures(mutation).length > 0);
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

test("fails closed when the PR lifecycle caller loses status read access", async () => {
  const root = await fixtureRepository();
  try {
    const workflowPath = join(root, ".github/workflows/pr-contract.yml");
    const workflow = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, workflow.replace("statuses: read\n", ""));
    const result = await validateRepository(root);
    assert.match(
      result.failures.join("\n"),
      /Pull-request contract workflow is missing marker: statuses: read/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("requires every repository control-plane module and inert workflow", async () => {
  for (const path of [
    ...repositoryControlPlaneModules,
    ".github/workflows/contract-publication.yml",
    ".github/workflows/merge-group.yml",
  ]) {
    const root = await fixtureRepository();
    try {
      await rm(join(root, path));
      const result = await validateRepository(root);
      assert.match(
        result.failures.join("\n"),
        new RegExp(
          `Missing required quality file: ${path.replaceAll(".", "\\.")}`,
          "u",
        ),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("fails closed on unsafe or pull-request-authored inert workflow input", async () => {
  const root = await fixtureRepository();
  try {
    const publicationPath = join(
      root,
      ".github/workflows/contract-publication.yml",
    );
    const publication = await readFile(publicationPath, "utf8");
    await writeFile(
      publicationPath,
      [
        publication.replace("contents: read", "contents: write"),
        "  active:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: ./local-action",
        "      - run: node quality/publication-contract.mjs",
        "      - run: echo ${{ github.event.pull_request.head.sha }}",
      ].join("\n"),
    );
    const mergePath = join(root, ".github/workflows/merge-group.yml");
    const merge = await readFile(mergePath, "utf8");
    await writeFile(
      mergePath,
      merge
        .replace("persist-credentials: false", "persist-credentials: true")
        .replace("ref: dev", "ref: main"),
    );
    const result = await validateRepository(root);
    const failures = result.failures.join("\n");
    assert.match(failures, /must not request write permissions: contents/u);
    assert.match(failures, /contains unsafe marker/u);
    assert.match(failures, /persist-credentials: false/u);
    assert.match(failures, /unexpected job set/u);
    assert.match(failures, /unexpected checkout ref/u);
    assert.match(failures, /unexpected action set/u);
    assert.match(failures, /unexpected command set/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects ambiguous YAML constructs that conceal unsafe workflow shape", async () => {
  const hidden = [
    '"hidden":\n  "permissions":\n    "contents": write\n  "steps":\n    - "run": echo unsafe',
    'hidden: {"contents": write}',
    "defaults: &unsafe\n  contents: write\nhidden: *unsafe",
    "hidden: !unsafe value",
    "<<: *unsafe",
    "? hidden\n: unsafe",
    '- { ? "run" : echo unsafe }',
    "hidden: {<<: {contents: write}}",
    "hidden: !<tag:example.com,2026:foo> value",
    "hidden: !!str value",
    'steps: [ "run": echo unsafe ]',
    'steps: [ ? "run" : echo unsafe ]',
    "steps: [run: echo unsafe]",
    "on:\n  workflow_dispatch:\n  <<:\n    pull_request_target:",
    'on:\n  workflow_dispatch:\n  ? "pull_request_target"\n  :',
  ];
  for (const syntax of hidden) {
    const root = await fixtureRepository();
    try {
      const workflowPath = join(
        root,
        ".github/workflows/contract-publication.yml",
      );
      const workflow = await readFile(workflowPath, "utf8");
      await writeFile(workflowPath, `${workflow}\n${syntax}\n`);
      const result = await validateRepository(root);
      assert.match(
        result.failures.join("\n"),
        /unsupported YAML syntax: contract-publication\.yml/u,
        syntax,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("binds each inert workflow to its exact activation-variable guard", async () => {
  const root = await fixtureRepository();
  try {
    const workflowPath = join(root, ".github/workflows/merge-group.yml");
    const workflow = await readFile(workflowPath, "utf8");
    await writeFile(
      workflowPath,
      workflow.replace(
        "if: ${{ vars.KEIKO_MERGE_GROUP_ACTIVATION == 'enabled' }}",
        "if: ${{ false }}",
      ),
    );
    const result = await validateRepository(root);
    const failures = result.failures.join("\n");
    assert.match(failures, /missing marker: if:/u);
    assert.match(failures, /unexpected job guard/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("accepts inert workflow permission blocks with Windows line endings", async () => {
  const root = await fixtureRepository();
  try {
    for (const path of [
      ".github/workflows/contract-publication.yml",
      ".github/workflows/merge-group.yml",
    ]) {
      const workflowPath = join(root, path);
      const workflow = await readFile(workflowPath, "utf8");
      await writeFile(workflowPath, workflow.replaceAll("\n", "\r\n"));
    }
    const result = await validateRepository(root);
    assert.deepEqual(result.failures, []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("requires complete control-plane coverage inclusion", async () => {
  const root = await fixtureRepository();
  try {
    await writeFile(
      join(root, "package.json"),
      packageJson({
        coverage: coverageScript.replace(
          "--test-coverage-include=quality/epic-merge-broker.mjs",
          "--test-coverage-include=quality/epic-merge-broker.mjs.disabled",
        ),
      }),
    );
    const result = await validateRepository(root);
    assert.match(
      result.failures.join("\n"),
      /Coverage command must include repository control-plane module: quality\/epic-merge-broker\.mjs/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects scalar and misplaced inert workflow permissions", async () => {
  const root = await fixtureRepository();
  try {
    const workflowPath = join(
      root,
      ".github/workflows/contract-publication.yml",
    );
    const workflow = await readFile(workflowPath, "utf8");
    await writeFile(
      workflowPath,
      workflow.replace(
        "    permissions:\n      contents: read\n    steps:",
        "    permissions: read-all\n    env:\n      contents: read\n    steps:",
      ),
    );
    const result = await validateRepository(root);
    const failures = result.failures.join("\n");
    assert.match(failures, /unexpected permission declarations/u);
    assert.match(failures, /exact job permission block/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("binds coverage includes to the direct Node test invocation", async () => {
  const root = await fixtureRepository();
  try {
    const option = "--test-coverage-include=quality/epic-merge-broker.mjs";
    await writeFile(
      join(root, "package.json"),
      packageJson({
        coverage: `true ${option} && ${coverageScript.replace(` ${option}`, "")}`,
      }),
    );
    const result = await validateRepository(root);
    const failures = result.failures.join("\n");
    assert.match(failures, /one direct Node test invocation/u);
    assert.match(
      failures,
      /Coverage command must include repository control-plane module: quality\/epic-merge-broker\.mjs/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects shell-comment coverage token smuggling", async () => {
  const root = await fixtureRepository();
  try {
    await writeFile(
      join(root, "package.json"),
      packageJson({
        coverage: coverageScript.replace(
          "--test-coverage-include=quality/epic-merge-broker.mjs",
          "# --test-coverage-include=quality/epic-merge-broker.mjs",
        ),
      }),
    );
    const result = await validateRepository(root);
    const failures = result.failures.join("\n");
    assert.match(failures, /one direct Node test invocation/u);
    assert.match(
      failures,
      /Coverage command must include repository control-plane module: quality\/epic-merge-broker\.mjs/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("requires pending activation controls without external orchestration", async () => {
  const root = await fixtureRepository();
  try {
    await writeFile(
      join(root, "docs/qa/repository-activation.md"),
      ["# Repository activation checklist", lifecycleList()].join("\n"),
    );
    const workflowPath = join(root, ".github/workflows/merge-group.yml");
    const workflow = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, `${workflow}\nAgent-Workflow-Setup\n`);
    const result = await validateRepository(root);
    const failures = result.failures.join("\n");
    assert.match(failures, /Activation runbook is missing pending control/u);
    assert.match(failures, /must not consult external orchestration/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
