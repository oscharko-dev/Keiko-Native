import assert from "node:assert/strict";
import test from "node:test";

import {
  architectureFailures,
  evidenceFailures,
  manifestFailures,
  packagePolicyFailures,
  redactionMatches,
  sourceDeclarationFailures,
} from "./native-contract.mjs";
import { main, nativeGateTestSupport } from "./native-gate.mjs";

const project = {
  productiveSourceRoots: [
    "native/crates/keiko-application/src/",
    "native/crates/keiko-ui-port/src/",
    "native/crates/keiko-host-macos/src/",
    "native/apps/keiko-desktop/src/",
    "native/frontend/src/",
  ],
  testSourceRoots: ["native/tests/"],
  supportFiles: ["native/Cargo.toml"],
};

const roots = project.productiveSourceRoots.map((root) => ({
  path: `${root}lib.rs`,
  text: "closed contract",
}));

test("source declarations reject every unknown native file", () => {
  assert.deepEqual(
    sourceDeclarationFailures(
      ["native/Cargo.toml", "native/tests/contract.test.mjs"],
      project,
    ),
    [],
  );
  assert.deepEqual(
    sourceDeclarationFailures(["native/undeclared.ts"], project),
    ["undeclared-native-file:native/undeclared.ts"],
  );
});

test("architecture scans every source and rejects generic capabilities", () => {
  assert.deepEqual(architectureFailures(roots, project), []);
  const failures = architectureFailures(
    [
      ...roots.slice(0, 1),
      {
        path: "native/crates/keiko-ui-port/src/extra.rs",
        text: "use tauri::Manager;",
      },
      {
        path: "native/frontend/src/main.ts",
        text: "fetch('https://host.invalid')",
      },
    ],
    project,
  );
  assert.ok(failures.some((failure) => failure.startsWith("missing-root:")));
  assert.ok(
    failures.some((failure) =>
      failure.startsWith("forbidden-adapter-dependency:"),
    ),
  );
  assert.ok(
    failures.some((failure) =>
      failure.startsWith("forbidden-frontend-capability:"),
    ),
  );
});

test("manifest policy closes dependency, CSP and build-path surfaces", () => {
  const valid = {
    cargo: {
      workspace: {
        dependencies: Object.fromEntries(
          [
            "keiko-application",
            "keiko-host-macos",
            "keiko-ui-port",
            "serde",
            "serde_json",
            "tauri",
            "tauri-build",
            "wry",
          ].map((name) => [name, true]),
        ),
        members: [1, 2, 3, 4],
      },
    },
    crates: [
      {
        name: "keiko-application",
        manifest: { dependencies: { serde: true } },
      },
      {
        name: "keiko-host-macos",
        manifest: {
          dependencies: {
            "keiko-application": true,
            "keiko-ui-port": true,
            serde_json: true,
            tauri: true,
            wry: true,
          },
        },
      },
      {
        name: "keiko-native-desktop",
        manifest: { dependencies: { "keiko-host-macos": true, tauri: true } },
      },
      {
        name: "keiko-ui-port",
        manifest: {
          dependencies: {
            "keiko-application": true,
            serde: true,
            serde_json: true,
          },
        },
      },
    ],
    desktopConfig: {
      app: {
        security: {
          csp: "default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' asset: http://asset.localhost; script-src 'self'; style-src 'self'",
        },
      },
      build: { beforeBuildCommand: "npm --prefix ../frontend run build" },
      bundle: {
        resources: {
          "../../third-party-notices.json": "THIRD-PARTY-NOTICES.json",
        },
      },
    },
    frontend: {
      dependencies: { "@tauri-apps/api": "2", react: "19", "react-dom": "19" },
      devDependencies: { "@vitest/coverage-v8": "4.1.8", vitest: "4.1.8" },
    },
  };
  assert.deepEqual(manifestFailures(valid), []);
  valid.frontend.dependencies.fetch = "1";
  valid.desktopConfig.build.beforeBuildCommand =
    "npm --prefix ../../frontend run build";
  assert.deepEqual(manifestFailures(valid), [
    "frontend-production-dependencies",
    "frontend-build-path",
  ]);
});

test("package policy requires exact paths, dependencies, notices and SPDX", () => {
  const dependency = {
    license: "MIT",
    name: "owned",
    source: "workspace",
    version: "0.1.0",
  };
  const policy = {
    schema: "keiko-native-package-policy/v1",
    allowedBundlePaths: ["Contents/app", "Contents/NOTICE"],
    requiredNoticePaths: ["Contents/NOTICE"],
    cargoInventory: [dependency],
    npmInventory: [],
    acceptedSpdxExpressions: ["MIT"],
    security: {
      prohibitedMarkers: ["test-listener"],
      prohibitedPathFragments: ["fixture"],
    },
  };
  const files = [
    { path: "Contents/app", bytes: Buffer.from("product") },
    { path: "Contents/NOTICE", bytes: Buffer.from("notice") },
  ];
  assert.deepEqual(
    packagePolicyFailures({ cargo: [dependency], files, npm: [], policy }),
    [],
  );
  assert.ok(
    packagePolicyFailures({
      cargo: [dependency],
      files: [
        ...files,
        { path: "fixture", bytes: Buffer.from("test-listener") },
      ],
      npm: [],
      policy,
    }).length >= 2,
  );
});

test("evidence schema and redaction fail closed", () => {
  const evidence = {
    schema: "keiko-native-packaged-shell-evidence/v1",
    sourceRevision: "0".repeat(40),
    readinessFingerprint: "a".repeat(64),
    packageManifestSha256: "b".repeat(64),
    cargoLockSha256: "c".repeat(64),
    npmLockSha256: "d".repeat(64),
    runner: "local-macos",
    architecture: "arm64",
    outcomes: [],
    boundedReasonCodes: [],
    elapsedMs: 1,
    cleanupOwnedDescendants: 0,
    redaction: "closed",
  };
  assert.deepEqual(evidenceFailures(evidence), []);
  assert.ok(
    evidenceFailures({ ...evidence, extra: true }).includes("evidence-fields"),
  );
  assert.ok(
    evidenceFailures({ ...evidence, cleanupOwnedDescendants: 1 }).includes(
      "evidence-descendants",
    ),
  );
  assert.equal(redactionMatches("bounded reason code").length, 0);
  assert.ok(redactionMatches("/Users/operator/project").length > 0);
});

test("gate rejects unknown modes", async () => {
  await assert.rejects(main("unknown"), /Unknown native gate/u);
});

test("gate helpers produce closed deterministic evidence", () => {
  assert.equal(
    nativeGateTestSupport.sanitizeOutput(
      "/Users/operator/work C:\\Users\\operator\\work /home/operator/work",
    ),
    "<redacted-path>/work <redacted-path>\\work <redacted-path>/work",
  );
  assert.deepEqual(
    nativeGateTestSupport.sortedInventory([
      { name: "zeta" },
      { name: "alpha" },
    ]),
    [{ name: "alpha" }, { name: "zeta" }],
  );
  assert.deepEqual(
    nativeGateTestSupport.workspaceDependencyNames(`
[workspace.dependencies]
serde = "1"
keiko-application = { path = "crates/keiko-application" }

[profile.release]
lto = true
`),
    ["serde", "keiko-application"],
  );
  const completeCoverage = Object.fromEntries(
    ["branches", "functions", "lines", "regions"].map((metric) => [
      metric,
      { percent: 85 },
    ]),
  );
  assert.deepEqual(
    nativeGateTestSupport.coverageFailures({
      data: [{ totals: completeCoverage }],
    }),
    [],
  );
  assert.deepEqual(nativeGateTestSupport.coverageFailures({}), [
    "Native branches coverage is below 85 percent",
    "Native functions coverage is below 85 percent",
    "Native lines coverage is below 85 percent",
    "Native regions coverage is below 85 percent",
  ]);

  const manifest = nativeGateTestSupport.packageManifest({
    files: [
      { path: "z", sha256: "2", bytes: Buffer.from("") },
      { path: "a", sha256: "1", bytes: Buffer.from("") },
    ],
    policySha256: "b".repeat(64),
    revision: "a".repeat(40),
  });
  assert.deepEqual(
    manifest.inventory.map(({ path }) => path),
    ["a", "z"],
  );
  assert.deepEqual(Object.keys(manifest), [
    "schema",
    "sourceRevision",
    "target",
    "platform",
    "policySha256",
    "inventory",
    "redaction",
  ]);

  const evidence = nativeGateTestSupport.packagedShellEvidence({
    architecture: "arm64",
    cargoLockSha256: "b".repeat(64),
    lifecycle: { cleanupOwnedDescendants: 0, elapsedMs: 12 },
    npmLockSha256: "c".repeat(64),
    packageManifestSha256: "d".repeat(64),
    revision: "a".repeat(40),
    runner: "macos-26-current",
  });
  assert.deepEqual(evidenceFailures(evidence), []);
  assert.equal(evidence.outcomes.length, 4);
  assert.equal(evidence.boundedReasonCodes.length, 6);
});

test("closed repository-only security and signing gates pass", async () => {
  await main("security");
  await main("signing");
});
