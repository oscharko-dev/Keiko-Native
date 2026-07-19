import assert from "node:assert/strict";
import test from "node:test";

import {
  evidenceFailures,
  manifestFailures,
  sourceSecurityFailures,
  sourceDeclarationFailures,
} from "./native-contract.mjs";
import { architectureFailures } from "./native-architecture-contract.mjs";
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

test("tracked files remain inspected when generated directories are ignored", () => {
  const generated = "/repo/native/apps/keiko-desktop/gen/runtime.json";
  assert.deepEqual(
    nativeGateTestSupport.mergeNativeInspectionPaths(
      ["/repo/native/crates/keiko-application/src/lib.rs"],
      [generated, generated],
    ),
    [generated, "/repo/native/crates/keiko-application/src/lib.rs"].toSorted(),
  );
  assert.deepEqual(
    sourceDeclarationFailures(
      ["native/apps/keiko-desktop/gen/runtime.json"],
      project,
    ),
    ["undeclared-native-file:native/apps/keiko-desktop/gen/runtime.json"],
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

test("desktop main remains thin declarative wiring", () => {
  const mainPath = "native/apps/keiko-desktop/src/main.rs";
  const declarative = [
    "fn main() {",
    "  tauri::Builder::default()",
    "    .plugin(navigation_policy())",
    "    .run(handle_run_event);",
    "}",
  ].join("\n");
  assert.ok(
    !architectureFailures(
      [...roots, { path: mainPath, text: declarative }],
      project,
    ).some((failure) => failure.startsWith("non-declarative-main:")),
  );
  for (const text of [
    `${declarative}\nif authority { decide(); }`,
    `${declarative}\nlet document_nonce = generate();`,
    Array.from({ length: 41 }, () => "wire();").join("\n"),
  ]) {
    assert.ok(
      architectureFailures([...roots, { path: mainPath, text }], project).some(
        (failure) => failure === `non-declarative-main:${mainPath}`,
      ),
    );
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
      { path: "z", sha256: "2", bytes: Buffer.from(""), mode: "0755" },
      { path: "a", sha256: "1", bytes: Buffer.from(""), mode: "0644" },
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
  assert.deepEqual(
    evidenceFailures(evidence, {
      cargoLockSha256: evidence.cargoLockSha256,
      npmLockSha256: evidence.npmLockSha256,
      packageManifestSha256: evidence.packageManifestSha256,
      readinessFingerprint: evidence.readinessFingerprint,
      sourceRevision: evidence.sourceRevision,
    }),
    [],
  );
  assert.equal(evidence.outcomes.length, 4);
  assert.equal(evidence.boundedReasonCodes.length, 6);

  const env = nativeGateTestSupport.productiveRustEnv();
  assert.equal(env.RUSTFLAGS, "");
  assert.match(env.CARGO_ENCODED_RUSTFLAGS, /\/workspace/u);
  assert.match(env.CARGO_ENCODED_RUSTFLAGS, /\/toolchain\/cargo/u);
  assert.match(env.CARGO_ENCODED_RUSTFLAGS, /\/toolchain\/rustup/u);
  assert.match(env.CARGO_ENCODED_RUSTFLAGS, /\/operator/u);
  assert.match(env.KEIKO_NATIVE_SOURCE_REVISION, /^[0-9a-f]{40}$/u);

  const revision = "e".repeat(40);
  const testPlan = nativeGateTestSupport.rustTestPlan(revision);
  assert.equal(testPlan.options.env.KEIKO_NATIVE_SOURCE_REVISION, revision);
  assert.equal(
    testPlan.options.env.CARGO_ENCODED_RUSTFLAGS,
    nativeGateTestSupport.productiveRustEnv(revision).CARGO_ENCODED_RUSTFLAGS,
  );
  assert.deepEqual(testPlan.args.slice(0, 4), [
    "+1.92.0",
    "test",
    "--locked",
    "--workspace",
  ]);
});

test("command failures expose bounded sanitized status and spawn causes", () => {
  const payload = [
    "x".repeat(4000),
    "/Users/operator/private/project",
    'token="sensitive-value"',
    "api_key=private-api-key",
    "authorization: Bearer private-credential",
    "https://internal.example/path?q=secret",
    "-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----",
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
  assert.ok(!failure.message.includes("private-api-key"));
  assert.ok(!failure.message.includes("private-credential"));
  assert.ok(!failure.message.includes("internal.example"));
  assert.ok(!failure.message.includes("private-key-material"));
  assert.ok(!failure.message.includes("raw-body"));
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

test("source security rejects hostile content without ordinary false positives", () => {
  for (const text of [
    "operator@example.invalid",
    "https://172.16.0.9/private",
    "wss://service.internal/socket",
    "http://[::1]/private",
    "api_key=private-value",
    "authorization: Bearer private-value",
  ]) {
    assert.deepEqual(sourceSecurityFailures([{ text }]), [
      "source-sensitive-content",
    ]);
  }
  assert.deepEqual(
    sourceSecurityFailures([
      { text: 'name = "serde"\nchecksum = "abc"' },
      { text: "Copyright 2026 Example Authors; MIT" },
      { text: "https://react.dev/errors/123 http://ipc.localhost" },
    ]),
    [],
  );
});
