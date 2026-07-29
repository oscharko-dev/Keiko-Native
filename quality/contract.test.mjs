import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  hardenedGitArguments,
  noReplaceGitEnvironment,
} from "./git-integrity.mjs";
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
  "quality/epic-merge-adapter.mjs",
  "quality/epic-merge-authorization.mjs",
  "quality/epic-merge-broker.mjs",
  "quality/epic-merge-composition.mjs",
  "quality/epic-merge-evidence.mjs",
  "quality/epic-merge-github.mjs",
  "quality/epic-merge-graphql.mjs",
  "quality/epic-merge-operation.mjs",
  "quality/epic-merge-policy.mjs",
  "quality/epic-merge-policy-schema.mjs",
  "quality/epic-merge-store.mjs",
]);

const coverageScript = canonicalCoverageCommand;

const issueTemplateFiles = [
  ".github/ISSUE_TEMPLATE/decision_evaluation.md",
  ".github/ISSUE_TEMPLATE/defect_finding.md",
  ".github/ISSUE_TEMPLATE/epic.md",
  ".github/ISSUE_TEMPLATE/feature_task.md",
];

const acceptedAdr0009Sha256 =
  "13bf5b3b259b722cbaf29d8d3324ce057d663f33ee0cdb5db2bf848d379c0a2f";

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
    "projection must authorize the existing maintainer credential",
  );
  assert.match(
    document,
    /fully\s+eligible\s+child-issue\s+pull\s+request/iu,
    "projection must restrict automation to an eligible child-issue pull request",
  );
  assert.match(
    document,
    /exact\s+accepted\s+`epic\/\*\*`\s+(?:branch|target)/iu,
    "projection must bind the exact accepted epic target",
  );
  assert.match(
    document,
    /epic\s+(?:and|or)\s+standalone[\s\S]{0,160}human-only[\s\S]{0,160}`dev`/iu,
    "projection must keep epic and standalone delivery to dev human-only",
  );
  assert.match(
    document,
    /`status:\s+ready\s+for\s+human\s+review`/iu,
    "projection must require ready-for-human-review lifecycle state",
  );
  assert.match(
    document,
    /never[\s\S]{0,80}(?:use|using|uses|invoke|invokes|enable)\s+provider\s+auto-merge/iu,
    "projection must deny provider auto-merge",
  );
  assert.match(
    document,
    /GitHub(?:\s+attribution)?\s+(?:therefore\s+)?cannot\s+distinguish[\s\S]{0,120}agent[\s\S]{0,120}human/iu,
    "projection must preserve the shared-identity limitation",
  );
  assert.match(
    document,
    /(?:never|no)[\s\S]{0,120}(?:merge|auto-merge)[\s\S]{0,120}`dev`/iu,
    "projection must keep dev sacred",
  );
  assert.match(
    document,
    /`dev`[\s\S]{0,160}`main`[\s\S]{0,160}`release\/\*\*`/iu,
    "projection must deny all protected branch families",
  );
  assert.match(
    document,
    /(?:must\s+never|must\s+deny)[\s\S]{0,100}(?:agent\s+)?merge[\s\S]{0,60}auto-merge[\s\S]{0,60}enqueue[\s\S]{0,60}push[\s\S]{0,60}update[\s\S]{0,180}`dev`[\s\S]{0,160}`main`[\s\S]{0,160}`release\/\*\*`/iu,
    "projection must deny every protected-branch mutation verb",
  );
  assert.match(
    document,
    /durable\s+single-flight\s+compare-and-set\s+claim/iu,
    "projection must require a durable single-flight claim",
  );
  assert.match(
    document,
    /target\/base\s+serialization\s+uniqueness\s+key[\s\S]{0,220}repository[\s\S]{0,120}exact\s+accepted\s+target[\s\S]{0,120}observed\s+current\s+base/iu,
    "projection must key serialization only by target and observed base",
  );
  assert.doesNotMatch(
    document,
    /target\/base\s+serialization\s+uniqueness\s+key[^.]*\b(?:pull\s+request|head|readiness|request\s+identity)\b/iu,
    "projection must not partition target/base serialization by operation metadata",
  );
  assert.match(
    document,
    /immutable\s+per-operation\s+(?:record|value)[\s\S]{0,180}issue[\s\S]{0,100}contract[\s\S]{0,100}readiness[\s\S]{0,100}pull\s+request[\s\S]{0,100}exact\s+head[\s\S]{0,100}request\s+identity/iu,
    "projection must bind operation metadata outside the serialization key",
  );
  assert.match(
    document,
    /distinct\s+request\s+identit(?:y|ies)[\s\S]{0,140}(?:cannot|must\s+not)[\s\S]{0,100}(?:another|separate)[\s\S]{0,100}serialization\s+claim/iu,
    "projection must reject request-ID partitioning",
  );
  assert.match(
    document,
    /two\s+distinct\s+child-issue\s+pull\s+requests[\s\S]{0,160}same\s+exact\s+(?:accepted\s+)?target[\s\S]{0,100}observed\s+(?:current\s+)?base[\s\S]{0,180}only\s+one[\s\S]{0,120}provider\s+submission/iu,
    "projection must serialize distinct PRs for one target/base",
  );
  assert.match(
    document,
    /new\s+request\s+identity[\s\S]{0,120}only\s+after[\s\S]{0,180}(?:terminal\s+settlement|human\s+reconciliation)[\s\S]{0,180}fresh\s+revalidation/iu,
    "projection must gate a new request identity on settlement and revalidation",
  );
  assert.match(
    document,
    /persist(?:s|ed)?[\s\S]{0,120}claim[\s\S]{0,160}before[\s\S]{0,120}provider\s+(?:call|submission)/iu,
    "projection must persist the claim before provider submission",
  );
  assert.match(
    document,
    /ambiguous[\s\S]{0,160}claim[\s\S]{0,160}blocked[\s\S]{0,180}human[\s\S]{0,180}reconciliation/iu,
    "projection must block ambiguous claims for human reconciliation",
  );
  assert.match(
    document,
    /exact\s+revalidated\s+head\s+SHA[\s\S]{0,160}`sha`\s+parameter/iu,
    "projection must bind the provider request to the revalidated head",
  );
  assert.match(
    document,
    /`merge_method:\s*squash`/iu,
    "projection must request linear-history squash topology",
  );
  assert.match(
    document,
    /squash\s+commit[\s\S]{0,180}sole\s+parent[\s\S]{0,120}observed\s+base[\s\S]{0,180}tree[\s\S]{0,120}observed\s+head\s+tree/iu,
    "projection must reconcile squash parent and tree",
  );
  assert.match(
    document,
    /ambiguous[\s\S]{0,180}(?:no\s+retr(?:y|ies)|never\s+retr(?:y|ies))/iu,
    "projection must prohibit retries after ambiguity",
  );
}

function assertAgentCredentialActivation(document) {
  assert.match(
    document,
    /restricts\s+updates\s+and\s+merges\s+to\s+the\s+explicit\s+authorized-maintainer\s+allowlist/iu,
    "activation must state the structural maintainer allowlist",
  );
  assert.match(
    document,
    /repository-owned\s+agent\/tool-policy\s+guard[\s\S]{0,120}denies[\s\S]{0,120}`dev`/iu,
    "activation must deny agent dev effects before provider calls",
  );
  assert.match(
    document,
    /GitHub\s+cannot\s+distinguish[\s\S]{0,120}agent[\s\S]{0,120}human[\s\S]{0,160}cannot\s+apply\s+a\s+separate\s+automation-identity\s+deny\s+rule/iu,
    "activation must reject provider identity-separation claims",
  );
  assert.doesNotMatch(
    document,
    /excludes\s+every\s+(?:agent|automation)[\s\S]{0,80}identit(?:y|ies)[\s\S]{0,80}`dev`\s+update\s+allowlist/iu,
    "activation must not claim provider-enforced agent exclusion",
  );
  assert.match(
    document,
    /epic-branch\s+ruleset[\s\S]{0,180}strict\s+up-to-date\s+current-branch\s+checks/iu,
    "activation must require strict epic current-branch checks",
  );
  assert.match(
    document,
    /base\s+advance[\s\S]{0,180}invalidates[\s\S]{0,180}rejects\s+the\s+merge\s+before\s+the\s+guarded\s+effect/iu,
    "activation must reject stale-base merge effects",
  );
  assert.match(
    document,
    /merge\s+endpoint's\s+`sha`[\s\S]{0,180}head[\s\S]{0,180}does\s+not\s+atomically\s+bind\s+the\s+base/iu,
    "activation must state head-only merge precondition semantics",
  );
}

function assertGuardRemainsInertBeforeActivation(document) {
  assert.match(
    document,
    /`status:\s+ready\s+for\s+human\s+review`[\s\S]{0,240}cannot\s+(?:truthfully\s+)?exist[\s\S]{0,240}(?:signed\s+)?Contract-as-Code\s+activation/iu,
    "projection must explain why pre-activation merge authority cannot exist",
  );
  assert.match(
    document,
    /guarded\s+operation[\s\S]{0,240}(?:unavailable|unusable)[\s\S]{0,240}no\s+provider\s+merge\s+request/iu,
    "projection must keep the guarded operation effect-free before activation",
  );
}

function assertThreeStateGuardAvailability(document) {
  assert.match(
    document,
    /protected\s+`dev`[\s\S]{0,160}sole\s+policy\s+source/iu,
    "projection must keep guard availability owned by protected dev policy",
  );
  assert.match(
    document,
    /`disabled`[\s\S]{0,160}before\s+(?:the\s+signed\s+Contract-as-Code\s+)?activation/iu,
    "projection must select disabled before activation",
  );
  assert.match(
    document,
    /no\s+provider\s+merge\s+request/iu,
    "projection must make pre-activation policy effect-free",
  );
  assert.match(
    document,
    /`probe-only`[\s\S]{0,240}immediately\s+after\s+activation[\s\S]{0,320}Issue\s+#55(?:'s)?[\s\S]{0,240}frozen\s+disposable-probe\s+manifest[\s\S]{0,360}exact\s+issue[\s\S]{0,240}operation\s+identit/iu,
    "projection must limit probe-only effects to frozen exact operation identities",
  );
  assert.match(
    document,
    /`enabled`[\s\S]{0,240}protected\s+Contract-as-Code[\s\S]{0,120}consum(?:e|es)[\s\S]{0,160}expected-producer[,\s-]{1,12}exact-head\s+live(?:-|\s+)proof\s+receipt\s+and\s+status[\s\S]{0,240}signed\s+activation\s+commit[\s\S]{0,360}complete\s+successfully\s+settled\s+matrix/iu,
    "projection must bind enabled to complete expected-producer activation proof",
  );
  assert.match(
    document,
    /(?:evidence|proof\s+receipt\s+and\s+status)[\s\S]{0,160}(?:consumed|validated)\s+inputs?[\s\S]{0,120}not\s+independent\s+authority/iu,
    "projection must keep proof evidence as input rather than authority",
  );
  assert.match(
    document,
    /missing[\s\S]{0,160}stale[\s\S]{0,160}wrong-producer[\s\S]{0,240}ambiguous\s+(?:evidence|proof|capability)[\s\S]{0,180}(?:remains|leaves\s+the\s+state)\s+`probe-only`[\s\S]{0,80}(?:or|\/)\s+`disabled`/iu,
    "projection must fail closed on invalid promotion evidence",
  );
  assert.match(
    document,
    /absent\s+`main`\s+ref[\s\S]{0,240}(?:denial\s+evidence|never\s+created|without\s+creating|must\s+not\s+be\s+created)/iu,
    "projection must preserve an absent main without creating it",
  );
  assert.doesNotMatch(
    document,
    /(?:before\s+|pre-)activation[\s\S]{0,160}(?:(?:may|can|does|makes?)\s+(?:make\s+)?(?:one\s+)?|authorized\s+to\s+submit\s+(?:a\s+)?)provider\s+merge\s+request/iu,
    "projection must reject contradictory pre-activation provider effects",
  );
  assert.doesNotMatch(
    document,
    /general\s+child\s+delivery[\s\S]{0,120}(?:enabled|available)[\s\S]{0,200}(?:before\s+Issue\s+#55(?:'s)?\s+live\s+matrix|even\s+if\s+Issue\s+#55(?:'s)?\s+live\s+matrix\s+has\s+not\s+settled)/iu,
    "projection must reject bypass of the post-Issue-#55 proof gate",
  );
  assert.doesNotMatch(
    document,
    /create(?:s|d)?\s+(?:a\s+)?(?:synthetic|temporary)\s+`main`\s+branch/iu,
    "projection must reject synthetic main creation",
  );
  assert.doesNotMatch(
    document,
    /(?:(?:missing|stale|wrong-producer|ambiguous)\s+evidence|evidence\s+from\s+the\s+wrong\s+producer)[\s\S]{0,120}(?:may\s+)?(?:enable|enables|promote|promotes)\s+(?:general\s+delivery|the\s+guard|availability)/iu,
    "projection must reject promotion from invalid evidence",
  );
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
    epicTemplate,
    pullRequestTemplate,
    supersedingAdr,
    stagingAdr,
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
    readFile(join(root, ".github/ISSUE_TEMPLATE/epic.md"), "utf8"),
    readFile(join(root, ".github/pull_request_template.md"), "utf8"),
    readFile(
      join(
        root,
        "docs/adr/ADR-0009-agent-scoped-maintainer-credential-epic-merge.md",
      ),
      "utf8",
    ),
    readFile(
      join(
        root,
        "docs/adr/ADR-0010-stage-guarded-epic-merge-proof-at-activation.md",
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
  const issueTemplates = [taskTemplate, decisionTemplate, defectTemplate];
  const activeProjections = [...policyProjections, supersedingAdr];
  const stagedActivationProjections = [
    agents,
    baseline,
    gates,
    activation,
    taskTemplate,
    decisionTemplate,
    defectTemplate,
    epicTemplate,
    pullRequestTemplate,
    stagingAdr,
  ];
  assertAgentCredentialActivation(activation);
  const impossibleIdentitySeparation = `${activation}
Provider protection excludes every agent identity from the \`dev\` update allowlist.
`;
  assert.throws(
    () => assertAgentCredentialActivation(impossibleIdentitySeparation),
    {
      name: "AssertionError",
      message: "activation must not claim provider-enforced agent exclusion",
    },
  );
  const permissiveEpicProtection = activation.replace(
    /strict up-to-date current-branch\s+checks/u,
    "non-strict stale-branch checks",
  );
  assert.notEqual(permissiveEpicProtection, activation);
  assert.throws(
    () => assertAgentCredentialActivation(permissiveEpicProtection),
    {
      name: "AssertionError",
      message: "activation must require strict epic current-branch checks",
    },
  );
  const permissiveBaseAdvance = activation.replace(
    /invalidates\s+eligibility\s+and\s+rejects\s+the\s+merge\s+before\s+the\s+guarded\s+effect/u,
    "preserves eligibility and allows the guarded effect",
  );
  assert.notEqual(permissiveBaseAdvance, activation);
  assert.throws(() => assertAgentCredentialActivation(permissiveBaseAdvance), {
    name: "AssertionError",
    message: "activation must reject stale-base merge effects",
  });
  for (const [index, document] of activeProjections.entries()) {
    assertAgentCredentialProjection(document);
    const autoMergeMutation = document.replace(
      /never(?=[\s\S]{0,80}(?:use|using|uses|invoke|invokes|enable)\s+provider\s+auto-merge)/giu,
      "may",
    );
    assert.notEqual(autoMergeMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(autoMergeMutation),
      {
        name: "AssertionError",
        message: "projection must deny provider auto-merge",
      },
      `projection ${index} accepted provider auto-merge authorization`,
    );
    const identityMutation = document.replace(
      /(GitHub(?:\s+attribution)?\s+(?:therefore\s+)?)cannot\s+distinguish/giu,
      "$1can distinguish",
    );
    assert.notEqual(identityMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(identityMutation),
      {
        name: "AssertionError",
        message: "projection must preserve the shared-identity limitation",
      },
      `projection ${index} omitted the shared-identity limitation`,
    );
    const claimMutation = document.replace(
      /durable\s+single-flight\s+compare-and-set\s+claim/giu,
      "volatile observation",
    );
    assert.notEqual(claimMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(claimMutation),
      {
        name: "AssertionError",
        message: "projection must require a durable single-flight claim",
      },
      `projection ${index} accepted a non-durable concurrency control`,
    );
    const requestInKeyMutation = document.replace(
      /observed\s+current\s+base(?=[.;])/giu,
      "observed current base, pull request, exact head, readiness identity, and request identity",
    );
    assert.notEqual(requestInKeyMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(requestInKeyMutation),
      {
        name: "AssertionError",
        message:
          "projection must not partition target/base serialization by operation metadata",
      },
      `projection ${index} partitioned target/base serialization by operation metadata`,
    );
    const requestValueMutation = document.replace(
      /(immutable\s+per-operation\s+(?:record|value)[\s\S]{0,500}?)request\s+identity/giu,
      "$1discarded request marker",
    );
    assert.notEqual(requestValueMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(requestValueMutation),
      {
        name: "AssertionError",
        message:
          "projection must bind operation metadata outside the serialization key",
      },
      `projection ${index} failed to retain request identity as claim metadata`,
    );
    const distinctRequestMutation = document.replace(
      /(distinct\s+request\s+identit(?:y|ies)[\s\S]{0,140})(?:cannot|must\s+not)([\s\S]{0,100}(?:another|separate)[\s\S]{0,100}serialization\s+claim)/giu,
      "$1may$2",
    );
    assert.notEqual(distinctRequestMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(distinctRequestMutation),
      {
        name: "AssertionError",
        message: "projection must reject request-ID partitioning",
      },
      `projection ${index} allowed distinct request IDs to bypass single-flight`,
    );
    const distinctPullRequestMutation = document.replace(
      /(two\s+distinct\s+child-issue\s+pull\s+requests[\s\S]{0,160}same\s+exact\s+(?:accepted\s+)?target[\s\S]{0,100}observed\s+(?:current\s+)?base[\s\S]{0,180})only\s+one/giu,
      "$1both",
    );
    assert.notEqual(distinctPullRequestMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(distinctPullRequestMutation),
      {
        name: "AssertionError",
        message: "projection must serialize distinct PRs for one target/base",
      },
      `projection ${index} allowed two PRs to reach provider for one target/base`,
    );
    const prematureRequestMutation = document.replace(
      /(new\s+request\s+identity[\s\S]{0,120})only\s+after([\s\S]{0,180}(?:terminal\s+settlement|human\s+reconciliation)[\s\S]{0,180}fresh\s+revalidation)/giu,
      "$1before$2",
    );
    assert.notEqual(prematureRequestMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(prematureRequestMutation),
      {
        name: "AssertionError",
        message:
          "projection must gate a new request identity on settlement and revalidation",
      },
      `projection ${index} allowed a fresh request before settlement`,
    );
    const claimOrderingMutation = document.replace(
      /before\s+(?:any|the)\s+provider\s+(?:submission|call)/giu,
      "after provider submission",
    );
    assert.notEqual(claimOrderingMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(claimOrderingMutation),
      {
        name: "AssertionError",
        message: "projection must persist the claim before provider submission",
      },
      `projection ${index} accepted a post-submission claim`,
    );
    const ambiguousClaimMutation = document.replace(
      /ambiguous\s+claims?\s+remain(?:s)?\s+blocked/giu,
      "ambiguous claim is automatically cleared",
    );
    assert.notEqual(ambiguousClaimMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(ambiguousClaimMutation),
      {
        name: "AssertionError",
        message:
          "projection must block ambiguous claims for human reconciliation",
      },
      `projection ${index} accepted automatic ambiguous-claim release`,
    );
    const topologyMutation = document.replace(
      /`merge_method:\s*squash`/giu,
      "`merge_method: merge`",
    );
    assert.notEqual(topologyMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(topologyMutation),
      {
        name: "AssertionError",
        message: "projection must request linear-history squash topology",
      },
      `projection ${index} accepted a non-linear merge topology`,
    );
    const headBindingMutation = document.replace(
      /exact\s+revalidated\s+head\s+SHA/giu,
      "caller-selected head SHA",
    );
    assert.notEqual(headBindingMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(headBindingMutation),
      {
        name: "AssertionError",
        message:
          "projection must bind the provider request to the revalidated head",
      },
      `projection ${index} accepted a caller-selected provider head`,
    );
    const squashReadBackMutation = document.replace(
      /sole\s+parent/giu,
      "arbitrary parent",
    );
    assert.notEqual(squashReadBackMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(squashReadBackMutation),
      {
        name: "AssertionError",
        message: "projection must reconcile squash parent and tree",
      },
      `projection ${index} accepted incomplete squash reconciliation`,
    );
    const protectedVerbMutation = document.replace(
      /enqueue,\s+push,\s+or\s+update/giu,
      "enqueue",
    );
    assert.notEqual(protectedVerbMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(protectedVerbMutation),
      {
        name: "AssertionError",
        message: "projection must deny every protected-branch mutation verb",
      },
      `projection ${index} omitted protected-branch mutation verbs`,
    );
    const retryMutation = document.replace(
      /no\s+retr(?:y|ies)/giu,
      "retries are allowed",
    );
    assert.notEqual(retryMutation, document);
    assert.throws(
      () => assertAgentCredentialProjection(retryMutation),
      {
        name: "AssertionError",
        message: "projection must prohibit retries after ambiguity",
      },
      `projection ${index} accepted an ambiguous retry`,
    );
  }
  for (const [index, template] of issueTemplates.entries()) {
    const childOnlyMutation = template.replace(
      /fully\s+eligible\s+child-issue\s+pull\s+request/iu,
      "fully eligible pull request",
    );
    assert.notEqual(childOnlyMutation, template);
    assert.throws(
      () => assertAgentCredentialProjection(childOnlyMutation),
      {
        name: "AssertionError",
        message:
          "projection must restrict automation to an eligible child-issue pull request",
      },
      `issue template ${index} widened guarded authority beyond child issues`,
    );
    const devDeliveryMutation = template.replace(
      /human-only\s+deliveries\s+to\s+`dev`/iu,
      "agent-enabled deliveries to `dev`",
    );
    assert.notEqual(devDeliveryMutation, template);
    assert.throws(
      () => assertAgentCredentialProjection(devDeliveryMutation),
      {
        name: "AssertionError",
        message:
          "projection must keep epic and standalone delivery to dev human-only",
      },
      `issue template ${index} widened epic or standalone dev delivery`,
    );
  }
  for (const document of policyProjections) {
    assert.doesNotMatch(
      document,
      /server-side\s+merge-authority\s+broker/iu,
      "active projection must not restore the deprecated broker",
    );
    assert.doesNotMatch(
      document,
      /dedicated\s+non-human\s+GitHub\s+App/iu,
      "active projection must not restore the deprecated App",
    );
  }
  for (const [index, document] of stagedActivationProjections.entries()) {
    assertGuardRemainsInertBeforeActivation(document);
    assertThreeStateGuardAvailability(document);
    const prematureEffect = document.replace(
      /no\s+provider\s+merge\s+request/iu,
      "one provider merge request",
    );
    assert.notEqual(prematureEffect, document);
    assert.throws(
      () => assertGuardRemainsInertBeforeActivation(prematureEffect),
      {
        name: "AssertionError",
        message:
          "projection must keep the guarded operation effect-free before activation",
      },
      `staged projection ${index} permitted a pre-activation provider effect`,
    );
    const contradictoryPrematureEffect = `${document}
Before activation the guard may make one provider merge request.
`;
    assert.throws(
      () => assertThreeStateGuardAvailability(contradictoryPrematureEffect),
      {
        name: "AssertionError",
        message:
          "projection must reject contradictory pre-activation provider effects",
      },
      `staged projection ${index} accepted contradictory pre-activation authorization`,
    );
    const bypassedPostProofGate = `${document}
General child delivery is enabled before Issue #55's live matrix settles.
`;
    assert.throws(
      () => assertThreeStateGuardAvailability(bypassedPostProofGate),
      {
        name: "AssertionError",
        message:
          "projection must reject bypass of the post-Issue-#55 proof gate",
      },
      `staged projection ${index} bypassed the post-Issue-#55 proof gate`,
    );
    const syntheticMain = `${document}
The probe creates a synthetic \`main\` branch.
`;
    assert.throws(() => assertThreeStateGuardAvailability(syntheticMain), {
      name: "AssertionError",
      message: "projection must reject synthetic main creation",
    });
    const invalidEvidencePromotion = `${document}
Wrong-producer evidence promotes availability.
`;
    assert.throws(
      () => assertThreeStateGuardAvailability(invalidEvidencePromotion),
      {
        name: "AssertionError",
        message: "projection must reject promotion from invalid evidence",
      },
      `staged projection ${index} accepted invalid-evidence promotion`,
    );
    const semanticContradictions = [
      [
        "Before activation, the guard is authorized to submit a provider merge request.",
        "projection must reject contradictory pre-activation provider effects",
      ],
      [
        "General child delivery is enabled even if Issue #55's live matrix has not settled.",
        "projection must reject bypass of the post-Issue-#55 proof gate",
      ],
      [
        "The probe creates a temporary `main` branch.",
        "projection must reject synthetic main creation",
      ],
      [
        "Evidence from the wrong producer may promote availability.",
        "projection must reject promotion from invalid evidence",
      ],
    ];
    for (const [contradiction, message] of semanticContradictions) {
      assert.throws(
        () =>
          assertThreeStateGuardAvailability(`${document}
${contradiction}
`),
        { name: "AssertionError", message },
        `staged projection ${index} accepted: ${contradiction}`,
      );
    }
  }
  assert.equal(
    createHash("sha256")
      .update(
        execFileSync(
          "git",
          hardenedGitArguments([
            "show",
            "HEAD:docs/adr/ADR-0009-agent-scoped-maintainer-credential-epic-merge.md",
          ]),
          {
            cwd: root,
            env: noReplaceGitEnvironment(process.env),
          },
        ),
      )
      .digest("hex"),
    acceptedAdr0009Sha256,
    "accepted ADR-0009 must remain byte-for-byte immutable",
  );
  assert.match(
    stagingAdr,
    /amends\s+only[\s\S]{0,160}ADR-0009[\s\S]{0,160}rollout/iu,
  );
  assert.match(
    stagingAdr,
    /exactly\s+one\s+current\s+guard-availability\s+state[\s\S]{0,120}three\s+mutually\s+exclusive\s+states/iu,
    "ADR-0010 must define three possible availability states with exactly one current state",
  );
  assert.match(
    stagingAdr,
    /Issue\s+#50[\s\S]{0,240}inert[\s\S]{0,240}(?:v2\s+)?live-probe\s+harness/iu,
    "ADR-0010 must assign inert guard and probe-harness implementation to issue #50",
  );
  assert.match(
    stagingAdr,
    /Issue\s+#55[\s\S]{0,320}post-activation[\s\S]{0,320}(?:positive|exact-target)[\s\S]{0,320}denial[\s\S]{0,320}race[\s\S]{0,320}ambiguity[\s\S]{0,320}redaction[\s\S]{0,320}reconciliation/iu,
    "ADR-0010 must assign the complete post-activation live matrix to issue #55",
  );
  assert.match(
    stagingAdr,
    /provider-assigned\s+parent\s+issue[\s\S]{0,240}derive[\s\S]{0,240}`epic\/\*\*`\s+target/iu,
    "ADR-0010 must derive disposable epic targets from their provider-assigned parents",
  );
  assert.match(
    stagingAdr,
    /stale-base[\s\S]{0,240}separate\s+(?:disposable\s+)?parent/iu,
    "ADR-0010 must isolate the stale-base probe under a separate parent",
  );
  assert.match(
    stagingAdr,
    /prohibited\s+target[\s\S]{0,240}actual\s+tip/iu,
    "ADR-0010 must bind denial evidence to each prohibited target's actual tip",
  );
  assert.match(
    stagingAdr,
    /absent\s+`main`[\s\S]{0,240}denial[\s\S]{0,240}(?:must\s+not|never)\s+(?:be\s+)?create/iu,
    "ADR-0010 must prove absent main without creating it",
  );
  assert.match(supersedingAdr, /Supersedes\s+ADR-0008/u);
  assert.match(supersedingAdr, /amends[\s\S]*ADR-0004/iu);
  assert.match(supersedingAdr, /restores[\s\S]*ADR-0005/iu);
  assert.match(supersedingAdr, /ADR-0005's Sonar[\s\S]*unchanged/u);
  assert.match(supersedingAdr, /Issue #114/u);
  assert.match(
    supersedingAdr,
    /Issue\s+#50\s+owns\s+implementation\s+and\s+live\s+proof/iu,
    "ADR must leave implementation and live proof to issue #50",
  );
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
    /durable\s+single-flight\s+compare-and-set\s+claim[\s\S]{0,600}target\/base\s+serialization\s+uniqueness\s+key[\s\S]{0,200}repository[\s\S]{0,200}exact\s+accepted\s+target[\s\S]{0,200}observed\s+current\s+base/iu,
    "ADR must define the target/base serialization key",
  );
  assert.doesNotMatch(
    supersedingAdr,
    /target\/base\s+serialization\s+uniqueness\s+key[^.]*\b(?:pull\s+request|head|readiness|request\s+identity)\b/iu,
    "ADR must not partition target/base serialization by operation metadata",
  );
  assert.match(
    supersedingAdr,
    /persist(?:s|ed)?[\s\S]{0,120}claim[\s\S]{0,160}before[\s\S]{0,120}provider\s+(?:call|submission)/iu,
    "ADR must persist the single-flight claim before provider submission",
  );
  assert.match(
    supersedingAdr,
    /rejects?[\s\S]{0,160}(?:concurrent[\s\S]{0,80}replayed|replayed[\s\S]{0,80}concurrent)/iu,
    "ADR must reject concurrent and replayed attempts",
  );
  assert.match(
    supersedingAdr,
    /ambiguous[\s\S]{0,160}claim[\s\S]{0,160}blocked[\s\S]{0,200}explicit\s+human\s+reconciliation[\s\S]{0,180}exact[\s\S]{0,120}refs[\s\S]{0,220}squash\s+commit[\s\S]{0,180}parent[\s\S]{0,180}trees/iu,
    "ADR must retain ambiguous claims until explicit human reconciliation",
  );
  assert.match(
    supersedingAdr,
    /`Merge a pull request`[\s\S]{0,220}exact\s+revalidated\s+head\s+SHA[\s\S]{0,160}`sha`\s+parameter[\s\S]{0,160}`merge_method:\s*squash`[\s\S]{0,220}`409 Conflict`/u,
    "ADR must request squash topology with the head precondition",
  );
  assert.match(
    supersedingAdr,
    /linear\s+history[\s\S]{0,500}squash\s+commit[\s\S]{0,180}observed\s+base[\s\S]{0,100}sole\s+parent[\s\S]{0,180}(?:exact\s+)?observed\s+head\s+tree/iu,
    "ADR must reconcile squash topology with linear-history protection",
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
    /A\s+—\s+Guarded\s+existing\s+maintainer\s+credential[\s\S]{0,180}\*\*4\.25\*\*/u,
  );
  assert.match(
    supersedingAdr,
    /B\s+—\s+Dedicated\s+App\s+and\s+broker[\s\S]{0,180}\*\*3\.70\*\*/u,
  );
  assert.match(
    supersedingAdr,
    /C\s+—\s+Human-only\s+child\s+integration[\s\S]{0,180}\*\*3\.95\*\*/u,
  );
  assert.match(supersedingAdr, /recommendation and outcome are unchanged/iu);
  assert.match(
    supersedingAdr,
    /human reconciliation[\s\S]*exact[\s\S]*refs[\s\S]*squash commit[\s\S]*parent[\s\S]*trees/iu,
  );
  assert.match(historicalAdr, /PR #15/u);
  assert.match(historicalAdr, /one-time/u);
  assert.match(historicalAdr, /authenticated maintainer account/u);
  assert.match(brokerAdr, /dedicated\s+non-human\s+GitHub\s+App/u);
  assert.match(brokerAdr, /Supersedes\s+ADR-0005/u);
  assert.match(
    gates,
    /shared identity[\s\S]{0,180}cannot[\s\S]{0,120}distinguish/iu,
  );
});

test("pins the authenticated lifecycle handoff record decision", async () => {
  const root = join(import.meta.dirname, "..");
  const normalizeLf = (source) => source.replaceAll("\r\n", "\n");
  const sources = await Promise.all([
    readFile(
      join(
        root,
        "docs/adr/ADR-0011-authenticated-lifecycle-handoff-record-protocol.md",
      ),
      "utf8",
    ),
    readFile(join(root, "docs/adr/README.md"), "utf8"),
    readFile(join(root, "AGENTS.md"), "utf8"),
    readFile(join(root, "docs/qa/issue-lifecycle.md"), "utf8"),
    readFile(join(root, "docs/qa/quality-gates.md"), "utf8"),
    readFile(join(root, "docs/qa/repository-activation.md"), "utf8"),
  ]);
  const [adr, index, agents, lifecycle, gates, activation] =
    sources.map(normalizeLf);
  const projections = [agents, lifecycle, gates, activation];
  const recordSection = (heading, nextHeading, source = adr) => {
    const normalizedSource = normalizeLf(source);
    const start = normalizedSource.indexOf(`### ${heading}`);
    const end = normalizedSource.indexOf(`### ${nextHeading}`, start + 1);
    assert.notEqual(start, -1, heading);
    assert.notEqual(end, -1, nextHeading);
    return normalizedSource.slice(start, end);
  };
  const recordFields = (heading, nextHeading) => {
    return [
      ...recordSection(heading, nextHeading).matchAll(
        /^\d+\. `([a-z0-9_]+)`: /gmu,
      ),
    ].map((match) => match[1]);
  };
  const recordSchema = (heading, nextHeading, source = adr) => {
    return [
      ...recordSection(heading, nextHeading, source).matchAll(
        /^\d+\. `([a-z0-9_]+)`: ([\s\S]*?)(?=^\d+\. `|^\n)/gmu,
      ),
    ].map(
      (match) =>
        `${match[1]}:${match[2]
          .replace(/\n\s+/gu, " ")
          .replaceAll("`", "")
          .replace(/\s+/gu, " ")
          .trim()}`,
    );
  };
  const asCrLf = (source) => normalizeLf(source).replaceAll("\n", "\r\n");
  for (const [name, source] of [
    ["ADR-0011", adr],
    ["ADR index", index],
    ["AGENTS projection", agents],
    ["lifecycle projection", lifecycle],
    ["quality-gates projection", gates],
    ["activation projection", activation],
  ]) {
    assert.equal(
      normalizeLf(asCrLf(source)),
      source,
      `${name} CRLF normalization`,
    );
  }
  const expectedRecordFields = {
    "Generation request v1": [
      "record_type",
      "schema_version",
      "digest_algorithm",
      "digest_domain",
      "repository",
      "issue_number",
      "pull_request_number",
      "exact_head_sha",
      "exact_target",
      "lane",
      "publication_submode",
      "generation_schema",
      "generation_bytes_sha256",
      "generation_identity",
      "attempt",
      "request_identity",
      "request_payload_digest",
      "expected_producers",
      "source_observation_identity",
      "predecessor_comment_id",
      "predecessor_record_digest",
      "workflow_path",
      "workflow_run_id",
      "workflow_run_attempt",
      "protected_dev_sha",
      "recorded_at",
    ],
    "Producer result v1": [
      "record_type",
      "schema_version",
      "digest_algorithm",
      "digest_domain",
      "repository",
      "issue_number",
      "pull_request_number",
      "exact_head_sha",
      "exact_target",
      "generation_identity",
      "attempt",
      "request_identity",
      "generation_request_comment_id",
      "generation_request_digest",
      "phase_fence_comment_id",
      "phase_fence_digest",
      "expected_producer",
      "producer_contract_version",
      "workflow_path",
      "workflow_id",
      "workflow_run_id",
      "workflow_run_attempt",
      "workflow_job_id",
      "result_identity",
      "protected_dev_sha",
      "provider_observation_identity",
      "conclusion",
      "reason_code",
      "predecessor_comment_id",
      "predecessor_record_digest",
      "recorded_at",
    ],
    "Phase/fence claim v1": [
      "record_type",
      "schema_version",
      "digest_algorithm",
      "digest_domain",
      "repository",
      "issue_number",
      "pull_request_number",
      "exact_head_sha",
      "generation_identity",
      "attempt",
      "request_identity",
      "phase",
      "fence_sequence",
      "fence_identity",
      "owner_workflow_path",
      "owner_run_id",
      "owner_run_attempt",
      "source_observation_identity",
      "claim_outcome",
      "recovery_scan_identity",
      "recovery_scanned_page_count",
      "recovery_scanned_comment_count",
      "recovery_accumulated_suffix_identity",
      "recovery_provider_cursor",
      "recovery_scan_complete",
      "recovery_settlement_identity",
      "predecessor_comment_id",
      "predecessor_record_digest",
      "protected_dev_sha",
      "recorded_at",
    ],
    "Transition/read-back v1": [
      "record_type",
      "schema_version",
      "digest_algorithm",
      "digest_domain",
      "repository",
      "issue_number",
      "pull_request_number",
      "exact_head_sha",
      "exact_target",
      "generation_identity",
      "attempt",
      "request_identity",
      "phase_fence_comment_id",
      "phase_fence_digest",
      "source_state",
      "desired_state",
      "observed_state",
      "transition_owner",
      "effect_identity",
      "read_back_identity",
      "producer_results",
      "checkpoint_sequence",
      "prior_checkpoint_comment_id",
      "prior_checkpoint_record_digest",
      "compacted_prefix_identity",
      "outcome",
      "reason_code",
      "predecessor_comment_id",
      "predecessor_record_digest",
      "protected_dev_sha",
      "recorded_at",
    ],
  };
  const expectedRecordSchemas = {
    "Generation request v1":
      "record_type:enum generation-request|schema_version:uint 1|digest_algorithm:enum sha-256|digest_domain:enum keiko-native.lifecycle-record.generation-request|repository:string|issue_number:uint|pull_request_number:uint or explicit null|exact_head_sha:commit or explicit null|exact_target:string or explicit null|lane:enum normal, publication, or not-applicable|publication_submode:enum ordinary, migration, or not-applicable|generation_schema:uint 1|generation_bytes_sha256:SHA-256|generation_identity:SHA-256|attempt:uint|request_identity:SHA-256|request_payload_digest:SHA-256|expected_producers:sorted set of closed producer identities|source_observation_identity:SHA-256|predecessor_comment_id:uint or explicit null|predecessor_record_digest:SHA-256 or explicit null|workflow_path:closed protected workflow path|workflow_run_id:uint|workflow_run_attempt:uint|protected_dev_sha:commit|recorded_at:timestamp".split(
        "|",
      ),
    "Producer result v1":
      "record_type:enum producer-result|schema_version:uint 1|digest_algorithm:enum sha-256|digest_domain:enum keiko-native.lifecycle-record.producer-result|repository:string|issue_number:uint|pull_request_number:uint or explicit null|exact_head_sha:commit or explicit null|exact_target:string or explicit null|generation_identity:SHA-256|attempt:uint|request_identity:SHA-256|generation_request_comment_id:uint|generation_request_digest:SHA-256|phase_fence_comment_id:uint|phase_fence_digest:SHA-256|expected_producer:closed producer identity|producer_contract_version:uint|workflow_path:closed protected workflow path|workflow_id:uint|workflow_run_id:uint|workflow_run_attempt:uint|workflow_job_id:uint|result_identity:SHA-256|protected_dev_sha:commit|provider_observation_identity:SHA-256|conclusion:enum success, failure, cancelled, timed-out, or unavailable|reason_code:closed redacted enum|predecessor_comment_id:uint|predecessor_record_digest:SHA-256|recorded_at:timestamp".split(
        "|",
      ),
    "Phase/fence claim v1":
      "record_type:enum phase-fence-claim|schema_version:uint 1|digest_algorithm:enum sha-256|digest_domain:enum keiko-native.lifecycle-record.phase-fence-claim|repository:string|issue_number:uint|pull_request_number:uint or explicit null|exact_head_sha:commit or explicit null|generation_identity:SHA-256|attempt:uint|request_identity:SHA-256|phase:enum request, phase-one, mutation, phase-two, terminal, or recovery|fence_sequence:uint|fence_identity:SHA-256|owner_workflow_path:closed protected coordinator path|owner_run_id:uint|owner_run_attempt:uint|source_observation_identity:SHA-256|claim_outcome:enum claimed, settled, abandoned, ambiguous, or superseded|recovery_scan_identity:SHA-256 or explicit null|recovery_scanned_page_count:uint|recovery_scanned_comment_count:uint|recovery_accumulated_suffix_identity:SHA-256 or explicit null|recovery_provider_cursor:string or explicit null|recovery_scan_complete:bool|recovery_settlement_identity:SHA-256 or explicit null|predecessor_comment_id:uint or explicit null|predecessor_record_digest:SHA-256 or explicit null|protected_dev_sha:commit|recorded_at:timestamp".split(
        "|",
      ),
    "Transition/read-back v1":
      "record_type:enum transition-read-back|schema_version:uint 1|digest_algorithm:enum sha-256|digest_domain:enum keiko-native.lifecycle-record.transition-read-back|repository:string|issue_number:uint|pull_request_number:uint or explicit null|exact_head_sha:commit or explicit null|exact_target:string or explicit null|generation_identity:SHA-256|attempt:uint|request_identity:SHA-256|phase_fence_comment_id:uint|phase_fence_digest:SHA-256|source_state:lifecycle-observation enum|desired_state:lifecycle-observation enum|observed_state:lifecycle-observation enum|transition_owner:enum request, assignment, pull-request, handoff, closure, reopen, invalidation, or recovery|effect_identity:SHA-256 or explicit null|read_back_identity:SHA-256|producer_results:sorted set of exact producer-result-reference members|checkpoint_sequence:uint|prior_checkpoint_comment_id:uint or explicit null|prior_checkpoint_record_digest:SHA-256 or explicit null|compacted_prefix_identity:SHA-256|outcome:enum planned, no-op, applied, denied, failed, abandoned, ambiguous, or superseded|reason_code:closed redacted enum|predecessor_comment_id:uint|predecessor_record_digest:SHA-256|protected_dev_sha:commit|recorded_at:timestamp".split(
        "|",
      ),
  };
  const recordHeadings = Object.keys(expectedRecordFields);
  for (const [heading, fields] of Object.entries(expectedRecordFields)) {
    const headingIndex = recordHeadings.indexOf(heading);
    const nextHeading =
      recordHeadings[headingIndex + 1] ??
      "Record authentication and chain reconstruction";
    assert.deepEqual(recordFields(heading, nextHeading), fields, heading);
    assert.deepEqual(
      recordSchema(heading, nextHeading),
      expectedRecordSchemas[heading],
      `${heading} types`,
    );
    const crlfAdr = asCrLf(adr);
    assert.equal(asCrLf(crlfAdr), crlfAdr, `${heading} CRLF fixture`);
    assert.deepEqual(
      recordSchema(heading, nextHeading, crlfAdr),
      expectedRecordSchemas[heading],
      `${heading} CRLF types`,
    );
  }

  assert.match(
    index,
    /ADR-0011: Authenticated lifecycle handoff record protocol/iu,
  );
  assert.match(
    adr,
    /Adopt Option A[\s\S]{0,600}github-actions\[bot\][\s\S]{0,600}short-lived[\s\S]{0,200}`GITHUB_TOKEN`/iu,
  );
  assert.match(
    adr,
    /no added[\s\S]{0,80}account[\s\S]{0,180}installed App[\s\S]{0,180}(?:PAT|personal access token)[\s\S]{0,180}broker[\s\S]{0,180}(?:database|hosted service)/iu,
  );

  for (const marker of [
    "keiko-native-lifecycle-generation-request:v1",
    "keiko-native-lifecycle-producer-result:v1",
    "keiko-native-lifecycle-phase-fence-claim:v1",
    "keiko-native-lifecycle-transition-read-back:v1",
  ])
    assert.match(adr, new RegExp(marker, "u"));

  for (const domain of [
    "keiko-native.lifecycle-record.generation-request",
    "keiko-native.lifecycle-record.producer-result",
    "keiko-native.lifecycle-record.phase-fence-claim",
    "keiko-native.lifecycle-record.transition-read-back",
    "keiko-native.lifecycle-input-generation",
  ])
    assert.match(adr, new RegExp(domain.replaceAll(".", String.raw`\.`), "u"));
  const expectedAuxiliaryDomains = {
    "request identity": "keiko-native.lifecycle-request-identity",
    "request payload": "keiko-native.lifecycle-request-payload",
    "source observation": "keiko-native.lifecycle-source-observation",
    "fence identity": "keiko-native.lifecycle-fence-identity",
    "result identity": "keiko-native.lifecycle-result-identity",
    "provider observation": "keiko-native.lifecycle-provider-observation",
    "effect identity": "keiko-native.lifecycle-effect-identity",
    "read-back identity": "keiko-native.lifecycle-read-back-identity",
    "publication candidate set": "keiko-native.lifecycle-candidate-set",
    "compacted prefix": "keiko-native.lifecycle-compacted-prefix-identity",
    "checkpoint identity": "keiko-native.lifecycle-checkpoint-identity",
    "recovery suffix accumulator":
      "keiko-native.lifecycle-recovery-suffix-identity",
    "recovery scan identity": "keiko-native.lifecycle-recovery-scan-identity",
    "recovery target": "keiko-native.lifecycle-recovery-target-identity",
    "recovery settlement":
      "keiko-native.lifecycle-recovery-settlement-identity",
    "artifact anchor": "keiko-native.lifecycle-artifact-anchor",
  };
  const auxiliaryDomainSection = adr.match(
    /Every auxiliary identity[\s\S]+?fixed domain:\n\n([\s\S]+?)\n\nThat list is/u,
  );
  assert.ok(auxiliaryDomainSection, "auxiliary identity domain list");
  const actualAuxiliaryDomains = [
    ...auxiliaryDomainSection[1].matchAll(/^- ([^:]+): `([^`]+)`$/gmu),
  ].map((match) => [match[1], match[2]]);
  assert.equal(
    actualAuxiliaryDomains.length,
    Object.keys(expectedAuxiliaryDomains).length,
  );
  assert.equal(
    new Set(actualAuxiliaryDomains.map(([identity]) => identity)).size,
    actualAuxiliaryDomains.length,
  );
  assert.deepEqual(
    actualAuxiliaryDomains,
    Object.entries(expectedAuxiliaryDomains),
  );
  assert.match(
    adr,
    /fields are\s+exactly, in order: `digest_domain` as an `enum`[\s\S]{0,240}`schema_version` as `uint` `1`[\s\S]{0,160}`digest_algorithm` as `enum` `sha-256`/iu,
  );

  const expectedReasonCodes = [
    "ok",
    "activation-disabled",
    "not-applicable",
    "unauthorized",
    "invalid-schema",
    "malformed-record",
    "stale-generation",
    "fence-lost",
    "producer-mismatch",
    "evidence-incomplete",
    "provider-rejected",
    "provider-conflict",
    "provider-rate-limited",
    "provider-timeout",
    "provider-unavailable",
    "read-back-mismatch",
    "ambiguous-effect",
    "recovery-required",
    "superseded",
  ];
  const reasonParagraph = adr.match(
    /The closed reason-code enum is exactly ([\s\S]+?)\. Provider status/u,
  );
  assert.ok(reasonParagraph, "closed reason-code enum");
  assert.deepEqual(
    [...reasonParagraph[1].matchAll(/`([^`]+)`/gu)].map((match) => match[1]),
    expectedReasonCodes,
  );

  const expectedAuxiliarySchemas = {
    "request identity": [
      "schema_version:uint=1",
      "repository:string",
      "issue_number:uint",
      "pull_request_number:uint-or-null",
      "exact_head_sha:commit-or-null",
      "exact_target:string-or-null",
      "generation_identity:sha256",
      "attempt:uint",
      "request_payload_digest:sha256",
      "expected_producers:set<producer>",
      "predecessor_comment_id:uint-or-null",
      "predecessor_record_digest:sha256-or-null",
    ],
    "request payload": [
      "schema_version:uint=1",
      "request_kind:enum(event-reconciliation,planner-request,pause-request,recovery-request,scheduled-reconciliation)",
      "requested_state:requested-lifecycle-state-or-null",
      "request_owner:enum(planner,assignment,pull-request,handoff,closure,reopen,invalidation,recovery,schedule)",
      "recovery_target_identity:sha256-or-null",
      "reason_code:closed-reason-code",
    ],
    "source observation": [
      "schema_version:uint=1",
      "generation_bytes_sha256:sha256",
      "observed_state:lifecycle-observation",
      "issue_updated_at:timestamp",
      "readiness_identity:sha256-or-null",
      "assignment_identity:sha256",
      "pr_topology_identity:sha256",
      "reviews_identity:sha256",
      "conversations_identity:sha256",
      "checks_identity:sha256",
      "evidence_identity:sha256",
      "activation_identity:sha256",
    ],
    "fence identity": [
      "schema_version:uint=1",
      "generation_identity:sha256",
      "attempt:uint",
      "phase:phase-enum",
      "fence_sequence:uint",
      "owner_workflow_path:coordinator-path",
      "owner_run_id:uint",
      "owner_run_attempt:uint",
      "source_observation_identity:sha256",
      "predecessor_comment_id:uint-or-null",
      "predecessor_record_digest:sha256-or-null",
    ],
    "result identity": [
      "schema_version:uint=1",
      "expected_producer:producer",
      "producer_contract_version:uint",
      "generation_identity:sha256",
      "attempt:uint",
      "phase_fence_digest:sha256",
      "workflow_path:producer-path",
      "workflow_id:uint",
      "workflow_run_id:uint",
      "workflow_run_attempt:uint",
      "workflow_job_id:uint",
      "provider_observation_identity:sha256",
      "conclusion:producer-conclusion",
      "reason_code:closed-reason-code",
    ],
    "provider observation": [
      "schema_version:uint=1",
      "expected_producer:producer",
      "generation_identity:sha256",
      "exact_head_sha:commit-or-null",
      "phase_fence_digest:sha256",
      "provider_result_id:uint",
      "provider_result_name:closed-producer-result-name",
      "provider_result_conclusion:producer-conclusion",
      "provider_result_sha:commit-or-null",
      "producer_payload_digest:sha256",
    ],
    "effect identity": [
      "schema_version:uint=1",
      "generation_identity:sha256",
      "attempt:uint",
      "phase_fence_digest:sha256",
      "source_state:lifecycle-observation",
      "desired_state:lifecycle-observation",
      "transition_owner:transition-owner",
      "mutation:enum(no-effect,set-lifecycle,remove-lifecycle)",
      "source_observation_identity:sha256",
    ],
    "read-back identity": [
      "schema_version:uint=1",
      "generation_identity:sha256",
      "attempt:uint",
      "phase_fence_digest:sha256",
      "effect_identity:sha256-or-null",
      "observed_state:lifecycle-observation",
      "issue_updated_at:timestamp",
      "source_observation_identity:sha256",
    ],
    "publication candidate set": [
      "schema_version:uint=1",
      "exact_commit_sha:commit",
      "root_tree_sha:tree",
      "entries:set<candidate-entry>",
    ],
    "compacted prefix": [
      "schema_version:uint=1",
      "repository:string",
      "issue_number:uint",
      "checkpoint_sequence:uint",
      "prior_checkpoint_identity:sha256-or-null",
      "members:list<checkpoint-member>",
    ],
    "checkpoint identity": [
      "schema_version:uint=1",
      "repository:string",
      "issue_number:uint",
      "checkpoint_sequence:uint",
      "prior_checkpoint_comment_id:uint-or-null",
      "prior_checkpoint_record_digest:sha256-or-null",
      "compacted_prefix_identity:sha256",
      "chain_tip_comment_id:uint",
      "chain_tip_record_digest:sha256",
    ],
    "recovery suffix accumulator": [
      "schema_version:uint=1",
      "repository:string",
      "issue_number:uint",
      "checkpoint_sequence:uint",
      "scan_direction:enum(backward)",
      "accumulator_step:uint",
      "prior_accumulated_suffix_identity:sha256-or-null",
      "page_members:list<recovery-suffix-member>",
      "cumulative_member_count:uint",
      "next_provider_cursor:string-or-null",
      "complete:bool",
    ],
    "recovery scan identity": [
      "schema_version:uint=1",
      "repository:string",
      "issue_number:uint",
      "checkpoint_sequence:uint",
      "scan_direction:enum(backward)",
      "provider_cursor:string-or-null",
      "scanned_page_count:uint",
      "scanned_comment_count:uint",
      "accumulated_suffix_identity:sha256",
      "complete:bool",
    ],
    "recovery target": [
      "schema_version:uint=1",
      "repository:string",
      "issue_number:uint",
      "orphan_comment_id:uint",
      "orphan_comment_body_sha256:sha256",
      "orphan_record_digest:sha256",
      "last_authenticated_comment_id:uint-or-null",
      "last_authenticated_record_digest:sha256-or-null",
    ],
    "recovery settlement": [
      "schema_version:uint=1",
      "repository:string",
      "issue_number:uint",
      "authorized_request_identity:sha256",
      "recovery_target_identity:sha256",
      "orphan_comment_id:uint",
      "orphan_comment_body_sha256:sha256",
      "orphan_record_digest:sha256",
      "orphan_author_login:enum(github-actions[bot])",
      "orphan_author_id:uint=41898282",
      "orphan_actor_type:enum(Bot)",
      "orphan_app_id:uint=15368",
      "orphan_workflow_path:protected-writer-path",
      "orphan_workflow_run_id:uint",
      "orphan_workflow_run_attempt:uint",
      "orphan_protected_dev_sha:commit",
      "orphan_run_conclusion:enum(failure,cancelled,timed-out)",
      "orphan_anchor_count:uint=0",
      "orphan_attestation_count:uint=0",
      "last_authenticated_comment_id:uint-or-null",
      "last_authenticated_record_digest:sha256-or-null",
      "quarantine_reason:enum(anchor-publication-interrupted)",
    ],
    "artifact anchor": [
      "schema_version:uint=1",
      "repository:string",
      "issue_number:uint",
      "record_type:record-type",
      "record_digest:sha256",
      "comment_id:uint",
      "comment_body_sha256:sha256",
      "generation_identity:sha256",
      "attempt:uint",
      "workflow_path:protected-writer-path",
      "workflow_run_id:uint",
      "workflow_run_attempt:uint",
      "protected_dev_sha:commit",
    ],
  };
  const auxiliarySection = adr.match(
    /The exact auxiliary v1 schemas are:\n\n([\s\S]+?)\n\n`requested-lifecycle-state`/u,
  );
  assert.ok(auxiliarySection, "auxiliary v1 schema table");
  const actualAuxiliarySchemas = Object.fromEntries(
    [
      ...auxiliarySection[1].matchAll(
        /^\|\s*([^|-][^|]*?)\s*\|\s*(.*?)\s*\|$/gmu,
      ),
    ]
      .slice(1)
      .filter((match) => !/^[-:]+$/u.test(match[1].trim()))
      .map((match) => [
        match[1].trim(),
        [...match[2].matchAll(/`([^`]+)`/gu)].map((field) => field[1]),
      ]),
  );
  assert.deepEqual(actualAuxiliarySchemas, expectedAuxiliarySchemas);

  const requestedStateDefinition = adr.match(
    /`requested-lifecycle-state` is exactly ([\s\S]+?); it excludes `no-lifecycle`\./u,
  );
  assert.ok(requestedStateDefinition, "request-specific lifecycle-state enum");
  assert.deepEqual(
    [...requestedStateDefinition[1].matchAll(/`([^`]+)`/gu)].map(
      (match) => match[1],
    ),
    lifecycleStates,
  );
  assert.match(
    adr,
    /request-payload digest preimage contains exactly these five fields in order:[\s\S]{0,100}`request_kind`[\s\S]{0,120}`requested_state`[\s\S]{0,120}`request_owner`[\s\S]{0,140}`recovery_target_identity`[\s\S]{0,140}`reason_code`/iu,
  );

  const nestedSchemas = adr.match(
    /The nested `candidate-entry` schema is exactly ([\s\S]+?), in that order\. The nested\s+`producer-result-reference` schema is exactly ([\s\S]+?), in that order\./u,
  );
  assert.ok(nestedSchemas, "nested candidate and producer-reference schemas");
  assert.deepEqual(
    [...nestedSchemas[1].matchAll(/`([^`]+)`/gu)].map((match) => match[1]),
    [
      "path:string",
      "mode:enum(100644,100755)",
      "blob_object_id:blob",
      "byte_count:uint",
      "content_sha256:sha256",
    ],
  );
  assert.deepEqual(
    [...nestedSchemas[2].matchAll(/`([^`]+)`/gu)].map((match) => match[1]),
    [
      "producer:producer",
      "comment_id:uint",
      "record_digest:sha256",
      "workflow_run_id:uint",
      "workflow_job_id:uint",
      "result_identity:sha256",
    ],
  );
  const checkpointMemberSchema = adr.match(
    /The nested `checkpoint-member` schema is exactly ([\s\S]+?),\s+in\s+that order\./u,
  );
  assert.ok(checkpointMemberSchema, "nested checkpoint-member schema");
  assert.deepEqual(
    [...checkpointMemberSchema[1].matchAll(/`([^`]+)`/gu)].map(
      (match) => match[1],
    ),
    ["comment_id:uint", "record_digest:sha256"],
  );
  const recoverySuffixMemberSchema = adr.match(
    /The nested `recovery-suffix-member` schema is exactly ([\s\S]+?),\s+in\s+that\s+order\./u,
  );
  assert.ok(recoverySuffixMemberSchema, "nested recovery-suffix-member schema");
  assert.deepEqual(
    [...recoverySuffixMemberSchema[1].matchAll(/`([^`]+)`/gu)].map(
      (match) => match[1],
    ),
    [
      "comment_id:uint",
      "comment_body_sha256:sha256",
      "classification:enum(irrelevant,authenticated-record)",
      "record_digest:sha256-or-null",
      "artifact_anchor_identity:sha256-or-null",
      "predecessor_comment_id:uint-or-null",
      "predecessor_record_digest:sha256-or-null",
    ],
  );

  assert.match(
    adr,
    /There is no prefix, suffix[\s\S]{0,180}trailing byte[\s\S]{0,180}full-body\s+parser/iu,
  );
  assert.match(
    adr,
    /constant\s+time[\s\S]{0,280}caller-supplied\s+digest[\s\S]{0,120}never\s+trusted/iu,
  );
  assert.match(
    adr,
    /author\s+login\s+`github-actions\[bot\]`[\s\S]{0,300}41898282[\s\S]{0,300}performed_via_github_app\.id[\s\S]{0,180}15368/iu,
  );
  const attestationSubject = adr.match(
    /name is exactly\n`([^`]+)`\nand whose digest is exactly `([^`]+)`/u,
  );
  assert.ok(attestationSubject, "post-publication attestation subject");
  assert.deepEqual(attestationSubject.slice(1), [
    "keiko-native/lifecycle-comment/v1/{repository}/{decimal-issue}/{decimal-comment-id}/{generation-identity}/{decimal-attempt}/{record-type}/{decimal-run-id}/{decimal-run-attempt}",
    "sha256:{artifact-anchor-identity}",
  ]);
  assert.match(
    adr,
    /first publishes the canonical comment[\s\S]{0,300}provider-assigned comment ID[\s\S]{0,300}`comment_body_sha256`[\s\S]{0,500}artifact-anchor schema/iu,
  );
  assert.match(
    adr,
    /final\s+comment, artifact, attestation, run, and job reread[\s\S]{0,250}complete binding is stable/iu,
  );
  const permissionSet = adr.match(
    /The exact writer permission set is ([\s\S]+?); every other permission/u,
  );
  assert.ok(permissionSet, "protected writer permission set");
  assert.deepEqual(
    [...permissionSet[1].matchAll(/`([^`]+)`/gu)].map((match) => match[1]),
    [
      "actions: read",
      "attestations: write",
      "contents: read",
      "id-token: write",
      "issues: write",
    ],
  );
  const claimSet = adr.match(
    /The exact verified attestation claim set is ([\s\S]+?)\. Claims map/u,
  );
  assert.ok(claimSet, "verified attestation claim set");
  assert.deepEqual(
    [...claimSet[1].matchAll(/`([^`]+)`/gu)].map((match) => match[1]),
    [
      "repository",
      "job_workflow_ref",
      "ref",
      "sha",
      "run_id",
      "run_attempt",
      "iss",
    ],
  );
  assert.match(
    adr,
    /relevant anchor without its exact comment\s+proves an\s+unreferenced suffix deletion/iu,
  );
  assert.match(adr, /100 comments\s+per page and at most two pages/iu);
  assert.match(
    adr,
    /next serialized recovery run[\s\S]{0,200}scans at most 100 more pages/iu,
  );
  assert.match(
    adr,
    /empty-history bootstrap[\s\S]{0,300}any issue comment of any author[\s\S]{0,180}reserved[\s\S]{0,80}keiko-native-lifecycle-[\s\S]{0,500}whether or not[\s\S]{0,300}valid/iu,
  );
  assert.match(
    adr,
    /zero lifecycle-marked comments[\s\S]{0,120}zero exact-name anchor artifacts[\s\S]{0,400}malformed[\s\S]{0,80}edited[\s\S]{0,80}duplicated[\s\S]{0,120}unanchored[\s\S]{0,300}both evidence sets are completely absent[\s\S]{0,300}predecessor fields explicit null[\s\S]{0,200}checkpoint sequence starts at one/iu,
  );
  const genesisNullRootSection = adr.match(
    /The sequence-one null-root compacted-prefix values are:\n\n([\s\S]+?)\n\nA crash before/u,
  );
  assert.ok(genesisNullRootSection, "sequence-one null-root values");
  assert.deepEqual(
    [
      ...genesisNullRootSection[1].matchAll(
        /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|$/gmu,
      ),
    ].map((match) => [match[1], match[2]]),
    [
      ["digest_domain", "keiko-native.lifecycle-compacted-prefix-identity"],
      ["schema_version", "1"],
      ["digest_algorithm", "sha-256"],
      ["repository", "current repository"],
      ["issue_number", "current issue"],
      ["checkpoint_sequence", "1"],
      ["prior_checkpoint_identity", "null"],
      ["members", "ordered authenticated genesis suffix"],
    ],
  );
  assert.match(
    adr,
    /crash before the first checkpoint[\s\S]{0,700}authenticated genesis suffix[\s\S]{0,500}publication[\s\S]{0,40}interrupted[\s\S]{0,300}explicit authorized recovery/iu,
  );
  const forwardSettlementSection = adr.match(
    /The forward orphan-settlement record is exactly:\n\n([\s\S]+?)\n\nThe orphan body/u,
  );
  assert.ok(forwardSettlementSection, "forward orphan-settlement matrix");
  assert.deepEqual(
    [
      ...forwardSettlementSection[1].matchAll(
        /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|$/gmu,
      ),
    ].map((match) => [match[1], match[2]]),
    [
      ["request_kind", "recovery-request"],
      ["phase", "recovery"],
      ["claim_outcome", "settled"],
      ["recovery_scan_identity", "null"],
      ["recovery_scanned_page_count", "0"],
      ["recovery_scanned_comment_count", "0"],
      ["recovery_accumulated_suffix_identity", "null"],
      ["recovery_provider_cursor", "null"],
      ["recovery_scan_complete", "false"],
      [
        "recovery_settlement_identity",
        "sha-256 of exact recovery-settlement preimage",
      ],
      ["predecessor", "last authenticated record or null root"],
      ["orphan_authority", "quarantined-only"],
    ],
  );
  const recoveryAccumulatorSection = adr.match(
    /The recovery suffix accumulator update is exactly:\n\n([\s\S]+?)\n\nA resumed recovery run/u,
  );
  assert.ok(
    recoveryAccumulatorSection,
    "recovery suffix accumulator update matrix",
  );
  assert.deepEqual(
    [
      ...recoveryAccumulatorSection[1].matchAll(
        /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|$/gmu,
      ),
    ].map((match) => [match[1], match[2], match[3]]),
    [
      [
        "checkpoint_sequence",
        "0",
        "0 until root; then exact checkpoint sequence or 0",
      ],
      ["accumulator_step", "1", "prior step + 1"],
      ["prior_accumulated_suffix_identity", "null", "exact prior digest"],
      [
        "page_members",
        "stable provider edge order",
        "stable provider edge order",
      ],
      [
        "cumulative_member_count",
        "page member count",
        "prior count + page member count",
      ],
      [
        "next_provider_cursor",
        "exact non-null cursor",
        "exact cursor; null iff root found",
      ],
      ["complete", "false", "false until root found; then true"],
    ],
  );
  assert.match(
    adr,
    /starts its accumulator at the first[\s\S]{0,100}two normal-load pages[\s\S]{0,140}exactly one accumulator step per[\s\S]{0,80}page/iu,
  );
  assert.match(
    adr,
    /`checkpoint_sequence` is `0` on every incomplete step[\s\S]{0,240}exact sequence from the authenticated checkpoint/iu,
  );
  assert.match(
    adr,
    /fresh transition\/read-back\s+checkpoint is sequence `1` after genesis[\s\S]{0,120}sequence plus one/iu,
  );
  assert.match(
    adr,
    /`recovery_scanned_page_count` equals the accumulator's `accumulator_step`[\s\S]{0,120}`recovery_scanned_comment_count` equals the accumulator's `cumulative_member_count`[\s\S]{0,260}first new step is exactly the prior page count plus one/iu,
  );
  assert.match(adr, /missing predecessor[\s\S]{0,160}fork[\s\S]{0,80}cycle/iu);
  assert.match(
    adr,
    /pagination overflow[\s\S]{0,180}provider-rate-limited[\s\S]{0,120}no effect/iu,
  );
  assert.match(
    adr,
    /issue-lifecycle-\$\{decimal issue number\}[\s\S]{0,180}queue:\s*max[\s\S]{0,180}no `cancel-in-progress`/iu,
  );
  assert.match(
    adr,
    /GitHub Actions workflow syntax[\s\S]{0,300}retrieved 2026-07-28/iu,
  );
  assert.match(
    adr,
    /Waiting start and dispatch order are provider scheduling\s+facts, not authority/iu,
  );
  assert.match(
    adr,
    /repository-wide job concurrency group `issue-lifecycle-provider-budget`[\s\S]{0,180}`queue: max`[\s\S]{0,180}no\s+`cancel-in-progress`/iu,
  );
  assert.match(
    adr,
    /normal stable pass[\s\S]{0,500}93\s+requests[\s\S]{0,180}186\s+requests[\s\S]{0,180}ceiling to 200/iu,
  );
  assert.match(
    adr,
    /Recovery mode has a separate 150-request ceiling[\s\S]{0,180}cannot perform a\s+lifecycle\/status\/branch\/merge effect/iu,
  );
  assert.match(
    adr,
    /Neither mode relies on a racy\s+`x-ratelimit-remaining` read for safety/iu,
  );
  assert.match(
    adr,
    /at most 15 non-checkpoint record anchors[\s\S]{0,180}transition\/read-back checkpoint/iu,
  );
  assert.match(
    adr,
    /stable\s+complete\s+double-read[\s\S]{0,700}same-generation[\s\S]{0,300}expected producer/iu,
  );
  assert.match(
    adr,
    /ambiguous[\s\S]{0,100}never\s+retried[\s\S]{0,300}explicit recovery[\s\S]{0,200}increments the attempt/iu,
  );
  assert.match(
    adr,
    /cannot select lifecycle[\s\S]{0,180}lane[\s\S]{0,180}requested target[\s\S]{0,180}activation[\s\S]{0,180}transition/iu,
  );
  assert.match(
    adr,
    /recursive Git-tree enumeration[\s\S]{0,180}`truncated === false`/iu,
  );
  assert.match(
    adr,
    /pull-request files API[\s\S]{0,180}(?:complete tree authority|tree authority)/iu,
  );

  for (const state of lifecycleStates)
    assert.match(adr, new RegExp(state, "u"));
  const expectedEdges = [
    "new -> triaged, blocked, waiting for user;",
    "triaged -> ready, blocked, waiting for user, new;",
    "ready -> in progress, blocked, waiting for user, new;",
    "in progress -> ready, PR open, blocked, waiting for user, new;",
    "PR open -> ready, in progress, ready for human review, blocked, waiting for user, new;",
    "ready for human review -> PR open, in progress, blocked, waiting for user, new, done;",
    "blocked -> waiting for user, new, triaged, ready, in progress, PR open;",
    "waiting for user -> blocked, new, triaged, ready, in progress, PR open; and",
    "done -> new only through reopen.",
  ];
  const edgeSection = adr.match(
    /The allowed directed edges are exactly[\s\S]+?\n\nA source equal to target/u,
  );
  assert.ok(edgeSection, "complete nine-state edge policy");
  assert.deepEqual(
    [...edgeSection[0].matchAll(/^- (.+)$/gmu)].map((match) => match[1]),
    expectedEdges,
  );
  assert.match(
    adr,
    /Every other ordered pair[\s\S]{0,180}nine-by-nine[\s\S]{0,180}rejected/iu,
  );
  for (const outsideEdge of [
    "issue creation: `no-lifecycle -> status: new`;",
    "reopen after non-completed closure: `no-lifecycle -> status: new`;",
    "non-completed closure: any of the eight open states -> `no-lifecycle`;",
    "completed closure: `status: ready for human review -> status: done`",
  ])
    assert.ok(adr.includes(outsideEdge), outsideEdge);
  assert.match(
    adr,
    /Completed reopen is exactly `status: done -> status: new`/iu,
  );
  assert.match(
    adr,
    /Every other source or target involving\s+`no-lifecycle` is rejected/iu,
  );
  assert.match(
    adr,
    /Before issue #55[\s\S]{0,300}inert[\s\S]{0,420}no lifecycle[\s\S]{0,180}merge mutation/iu,
  );
  assert.match(
    adr,
    /Epic #49 increments to v8[\s\S]{0,240}Issue #51 increments to v5[\s\S]{0,240}Issue #55 increments[\s\S]{0,240}Issue #52 remains unchanged/iu,
  );
  assert.match(adr, /human[\s-]only `dev` boundary/iu);
  assert.match(adr, /does not amend ADR-0009/iu);

  for (const projection of projections) {
    assert.match(projection, /ADR-0011/u);
    assert.match(
      projection,
      /(?:github-actions\[bot\]|built-in bot user)[\s\S]{0,500}(?:short-lived\s+`GITHUB_TOKEN`|App ID `15368`)/iu,
    );
    assert.match(projection, /(?:inert|no pre-activation|Before Issue #55)/iu);
    assert.match(projection, /lifecycle/iu);
  }
});

test("pins the protected lifecycle recovery wake decision", async () => {
  const adr = (
    await readFile(
      join(
        import.meta.dirname,
        "..",
        "docs/adr/ADR-0012-protected-lifecycle-wake-dispatch.md",
      ),
      "utf8",
    )
  ).replaceAll("\r\n", "\n");

  assert.match(adr, /Decision issue #131 v8 selected this outcome/u);
  assert.match(
    adr,
    /adds one ADR-0012-owned auxiliary identity[\s\S]{0,260}does not change ADR-0011's\s+version-1 record schemas/iu,
  );
  assert.match(
    adr,
    /canonical decimal recovery-comment-ID string for `issue_comment`, otherwise the empty string/iu,
  );
  assert.match(
    adr,
    /recovery_comment_id:\s*\$\{\{\s*matrix\.locator\.recovery_comment_id\s*\}\}/u,
  );
  assert.match(
    adr,
    /required `recovery_comment_id` of type `string`[\s\S]{0,220}empty string[\s\S]{0,220}positive safe decimal integer/iu,
  );

  for (const predicate of [
    "`createdAt` must equal `updatedAt`",
    "`lastEditedAt` and `editor` must be null",
    "`includesCreatedEdit` must be false",
    "keiko-native.lifecycle-recovery-authorized-request",
    "`command_body_sha256:sha256`",
    "`recovery_target_identity:sha256`",
  ])
    assert.ok(adr.includes(predicate), predicate);

  assert.match(
    adr,
    /REST `GET \/repos\/\{owner\}\/\{repo\}\/issues\/comments\/\{comment_id\}`[\s\S]{0,500}GraphQL `node\(id: \$node_id\)`[\s\S]{0,500}collaborator-permission/iu,
  );
  assert.match(
    adr,
    /authentication consumes six requests[\s\S]{0,500}at most ten requests[\s\S]{0,500}remaining 140 requests[\s\S]{0,500}151st total request/iu,
  );
  assert.match(
    adr,
    /At most one authenticated recovery record may consume a recovery-target identity[\s\S]{0,400}replay no-op/iu,
  );
  assert.match(
    adr,
    /at most two\s+100-comment pages[\s\S]{0,400}never start history-wide or\s+cursor-resumed recovery-command enumeration/iu,
  );
  assert.match(
    adr,
    /one protected repository allowlist constant[\s\S]{0,260}two immutable\s+numeric `User` identities[\s\S]{0,260}copied numeric identities[\s\S]{0,120}denied/iu,
  );
  assert.match(
    adr,
    /This needs no workflow dispatch and no Actions-write\s+permission/iu,
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
    ".github/workflows/epic-merge-guard-status.yml",
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
    "docs/qa/guarded-epic-merge.md",
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
    "quality/epic-merge-policy.json",
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
    join(root, "quality/epic-merge-policy.json"),
    await readFile(join(import.meta.dirname, "epic-merge-policy.json"), "utf8"),
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
    join(root, ".github/workflows/epic-merge-guard-status.yml"),
    [
      "name: Epic merge guard status",
      "on:",
      "  push:",
      "    branches: [dev]",
      "  workflow_dispatch:",
      "permissions: {}",
      "jobs:",
      "  status:",
      "    runs-on: ubuntu-latest",
      "    permissions:",
      "      contents: read",
      "    steps:",
      "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "        with:",
      "          persist-credentials: false",
      "          ref: ${{ github.sha }}",
      "      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
      "        with:",
      '          node-version: "24.18.0"',
      "          package-manager-cache: false",
      "      - name: Produce the protected guard status",
      "        run: |",
      '          test "$GITHUB_REF" = "refs/heads/dev"',
      '          test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
      "          node --check quality/epic-merge-adapter.mjs",
      "          node --check quality/epic-merge-broker.mjs",
      "          node --check quality/epic-merge-composition.mjs",
      "          node --check quality/epic-merge-evidence.mjs",
      "          node --check quality/epic-merge-github.mjs",
      "          node --check quality/epic-merge-graphql.mjs",
      "          node --check quality/epic-merge-operation.mjs",
      "          node --check quality/epic-merge-policy.mjs",
      "          node --check quality/epic-merge-policy-schema.mjs",
      "          node --check quality/epic-merge-store.mjs",
      "          node quality/epic-merge-policy.mjs status",
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
      "          node --check quality/epic-merge-operation.mjs",
      "          node --check quality/epic-merge-policy.mjs",
      "          node quality/epic-merge-policy.mjs status",
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

test("Sonar classifies epic merge support modules as test code", async () => {
  const lines = new Set(
    (
      await readFile(
        join(import.meta.dirname, "..", "sonar-project.properties"),
        "utf8",
      )
    ).split(/\r?\n/u),
  );
  assert.equal(
    lines.has(
      "sonar.test.inclusions=quality/*.test.mjs,quality/epic-merge-*.cases.mjs,quality/epic-merge-*-fixtures.mjs",
    ),
    true,
  );
  assert.equal(
    lines.has(
      "sonar.exclusions=quality/*.test.mjs,quality/epic-merge-*.cases.mjs,quality/epic-merge-*-fixtures.mjs,coverage/**,node_modules/**",
    ),
    true,
  );
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
    ".github/workflows/epic-merge-guard-status.yml",
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

test("keeps checked-in epic merge policy inactive and producer-bound", async () => {
  const root = await fixtureRepository();
  try {
    const path = join(root, "quality/epic-merge-policy.json");
    const policy = JSON.parse(await readFile(path, "utf8"));
    policy.activation = {
      commit: "a".repeat(40),
      producer: policy.expectedProducers.activation,
      signed: true,
      state: "active",
    };
    await writeFile(path, JSON.stringify(policy));
    const result = await validateRepository(root);
    assert.match(
      result.failures.join("\n"),
      /must remain protected-dev sourced and inactive before activation/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("guard status producer stays protected-dev, read-only, and caller-free", async () => {
  const root = await fixtureRepository();
  try {
    const path = join(root, ".github/workflows/epic-merge-guard-status.yml");
    const workflow = await readFile(path, "utf8");
    await writeFile(
      path,
      workflow
        .replace("      contents: read", "      contents: write")
        .replace("    runs-on: ubuntu-latest", "    runs-on: windows-latest")
        .replace(
          "          ref: ${{ github.sha }}",
          "          ref: caller-selected",
        ),
    );
    const result = await validateRepository(root);
    const failures = result.failures.join("\n");
    assert.match(failures, /must not request write permissions/u);
    assert.match(failures, /missing marker: runs-on: ubuntu-latest/u);
    assert.match(failures, /missing marker: ref: \$\{\{ github\.sha \}\}/u);
  } finally {
    await rm(root, { force: true, recursive: true });
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
