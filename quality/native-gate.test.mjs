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
  for (const capability of [
    "std::fs",
    "std::process",
    "std::net",
    "reqwest",
    "keyring",
    "security_framework",
    "tauri_plugin_fs",
  ]) {
    for (const rootIndex of [0, 1]) {
      const mutated = structuredClone(roots);
      mutated[rootIndex].text = `use ${capability};`;
      assert.ok(
        architectureFailures(mutated, project).some((failure) =>
          failure.startsWith("forbidden-domain-capability:"),
        ),
      );
    }
  }
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
    target: "keiko-native-desktop",
    bundleIdentifier: "dev.oscharko.keiko-native",
    expectedLocks: {
      cargoSha256: "a".repeat(64),
      npmSha256: "b".repeat(64),
    },
    allowedBundlePaths: [
      "Contents/Info.plist",
      "Contents/MacOS/keiko-native-desktop",
      "Contents/Resources/THIRD-PARTY-NOTICES.json",
    ],
    requiredNoticePaths: ["Contents/Resources/THIRD-PARTY-NOTICES.json"],
    allowedFileClasses: {
      "Contents/Info.plist": "plist",
      "Contents/MacOS/keiko-native-desktop": "mach-o-executable",
      "Contents/Resources/THIRD-PARTY-NOTICES.json": "dependency-notice",
    },
    cargoInventory: [dependency],
    npmInventory: [],
    acceptedSpdxExpressions: ["MIT"],
    security: {
      allowedBundledOrigins: ["tauri://localhost", "http://tauri.localhost"],
      csp: "default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' asset: http://asset.localhost; script-src 'self'; style-src 'self'",
      prohibitedMarkers: ["test-listener"],
      prohibitedPathFragments: ["fixture"],
    },
  };
  const files = [
    { path: "Contents/Info.plist", bytes: Buffer.from("plist") },
    {
      path: "Contents/MacOS/keiko-native-desktop",
      bytes: Buffer.from("product"),
    },
    {
      path: "Contents/Resources/THIRD-PARTY-NOTICES.json",
      bytes: Buffer.from("notice"),
    },
  ];
  const fileClasses = { ...policy.allowedFileClasses };
  assert.deepEqual(
    packagePolicyFailures({
      cargo: [dependency],
      fileClasses,
      files,
      npm: [],
      policy,
    }),
    [],
  );
  assert.ok(
    packagePolicyFailures({
      cargo: [dependency],
      fileClasses: { ...fileClasses, extra: "raw" },
      files: [
        ...files,
        { path: "fixture", bytes: Buffer.from("test-listener") },
      ],
      npm: [],
      policy,
    }).length >= 2,
  );
  for (const key of Object.keys(policy)) {
    const mutated = structuredClone(policy);
    delete mutated[key];
    assert.ok(
      packagePolicyFailures({
        cargo: [dependency],
        fileClasses,
        files,
        npm: [],
        policy: mutated,
      }).length > 0,
      `missing ${key}`,
    );
  }
  for (const mutated of [
    { ...policy, extra: true },
    { ...policy, schema: "other" },
    { ...policy, target: "other" },
    { ...policy, bundleIdentifier: "other" },
    { ...policy, expectedLocks: { ...policy.expectedLocks, extra: "x" } },
    { ...policy, security: { ...policy.security, csp: "default-src *" } },
    { ...policy, allowedBundlePaths: [...policy.allowedBundlePaths, "extra"] },
    { ...policy, requiredNoticePaths: [] },
    { ...policy, allowedFileClasses: { ...fileClasses, extra: "raw" } },
    { ...policy, cargoInventory: [] },
    { ...policy, npmInventory: [dependency] },
    { ...policy, acceptedSpdxExpressions: [] },
  ]) {
    assert.ok(
      packagePolicyFailures({
        cargo: [dependency],
        fileClasses,
        files,
        npm: [],
        policy: mutated,
      }).length > 0,
    );
  }
  const redactedFiles = structuredClone(files);
  redactedFiles[1].bytes = Buffer.from("/Users/operator/work");
  assert.ok(
    packagePolicyFailures({
      cargo: [dependency],
      fileClasses,
      files: redactedFiles,
      npm: [],
      policy,
    }).includes("package-redaction:Contents/MacOS/keiko-native-desktop"),
  );
});

test("evidence schema and redaction fail closed", () => {
  const evidence = {
    schema: "keiko-native-packaged-shell-evidence/v1",
    sourceRevision: "0".repeat(40),
    readinessFingerprint:
      "c68478df272e1add068e7b1bba9e8c973920b4e3eae29a293d1cba3bc54ab61a",
    packageManifestSha256: "b".repeat(64),
    cargoLockSha256: "c".repeat(64),
    npmLockSha256: "d".repeat(64),
    runner: "local-macos",
    architecture: "arm64",
    outcomes: [
      "packaged-health-acknowledged",
      "normal-shutdown",
      "zero-owned-descendants",
      "package-policy",
    ],
    boundedReasonCodes: [
      "invalid-request",
      "unauthorized",
      "cancelled",
      "timed-out",
      "host-unavailable",
      "shutting-down",
    ],
    acknowledgementMs: 1,
    shutdownMs: 2,
    cleanupOwnedDescendants: 0,
    redaction: "closed",
  };
  assert.deepEqual(evidenceFailures(evidence), []);
  for (const mutation of [
    { ...evidence, extra: true },
    { ...evidence, schema: "other" },
    { ...evidence, sourceRevision: "bad" },
    { ...evidence, readinessFingerprint: "0".repeat(64) },
    { ...evidence, packageManifestSha256: "bad" },
    { ...evidence, cargoLockSha256: "bad" },
    { ...evidence, npmLockSha256: "bad" },
    { ...evidence, runner: "unknown" },
    { ...evidence, architecture: "x64" },
    { ...evidence, outcomes: [...evidence.outcomes, "extra"] },
    {
      ...evidence,
      boundedReasonCodes: [...evidence.boundedReasonCodes, "extra"],
    },
    { ...evidence, acknowledgementMs: 5001 },
    { ...evidence, shutdownMs: 1.5 },
    { ...evidence, cleanupOwnedDescendants: 1 },
    { ...evidence, redaction: "open" },
  ]) {
    assert.ok(evidenceFailures(mutation).length > 0);
  }
  assert.equal(redactionMatches("bounded reason code").length, 0);
  assert.equal(redactionMatches("password:!0").length, 0);
  assert.ok(redactionMatches('password="actual-value"').length > 0);
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
    lifecycle: {
      acknowledgementMs: 12,
      cleanupOwnedDescendants: 0,
      shutdownMs: 8,
    },
    npmLockSha256: "c".repeat(64),
    packageManifestSha256: "d".repeat(64),
    revision: "a".repeat(40),
    runner: "macos26-current",
  });
  assert.deepEqual(evidenceFailures(evidence), []);
  assert.equal(evidence.outcomes.length, 4);
  assert.equal(evidence.boundedReasonCodes.length, 6);

  const env = nativeGateTestSupport.productiveRustEnv();
  assert.equal(env.RUSTFLAGS, "");
  assert.match(env.CARGO_ENCODED_RUSTFLAGS, /\/workspace/u);
  assert.match(env.CARGO_ENCODED_RUSTFLAGS, /\/toolchain\/cargo/u);
  assert.match(env.CARGO_ENCODED_RUSTFLAGS, /\/toolchain\/rustup/u);
  assert.match(env.CARGO_ENCODED_RUSTFLAGS, /\/operator/u);
  assert.match(env.KEIKO_NATIVE_SOURCE_REVISION, /^[0-9a-f]{40}$/u);
});

test("command failures expose bounded sanitized status and spawn causes", () => {
  const payload = [
    "x".repeat(4000),
    "/Users/operator/private/project",
    'token="sensitive-value"',
    JSON.stringify({ response: "raw-body", email: "operator@example.invalid" }),
  ].join("\n");
  const failure = nativeGateTestSupport.commandFailure("cargo", ["build"], {
    status: 7,
    stderr: payload,
    stdout: "",
  });
  assert.match(failure.message, /status:7/u);
  assert.ok(failure.message.length < 1200);
  assert.ok(!failure.message.includes("sensitive-value"));
  assert.ok(!failure.message.includes("operator@example.invalid"));
  assert.ok(!failure.message.includes("/Users/operator"));
  const spawnFailure = nativeGateTestSupport.commandFailure(
    "cargo",
    ["build"],
    {
      error: { code: "ENOENT" },
      stderr: "",
      stdout: "",
    },
  );
  assert.match(spawnFailure.message, /spawn:ENOENT/u);
});

test("closed repository-only security and signing gates pass", async () => {
  await main("security");
  await main("signing");
});
