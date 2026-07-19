import assert from "node:assert/strict";
import test from "node:test";

import {
  evidenceFailures,
  packagePolicyFailures,
  redactionMatches,
} from "./native-contract.mjs";

test("package policy requires exact paths, dependencies, notices and SPDX", () => {
  const reviewedSpdx = [
    "(MIT OR Apache-2.0) AND Unicode-3.0",
    "0BSD OR MIT OR Apache-2.0",
    "Apache-2.0",
    "Apache-2.0 AND MIT",
    "Apache-2.0 OR BSL-1.0",
    "Apache-2.0 OR MIT",
    "Apache-2.0 WITH LLVM-exception",
    "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT",
    "BSD-3-Clause",
    "BSD-3-Clause OR MIT OR Apache-2.0",
    "CC0-1.0 OR MIT-0 OR Apache-2.0",
    "ISC",
    "MIT",
    "MIT OR Apache-2.0",
    "MIT OR Apache-2.0 OR LGPL-2.1-or-later",
    "MIT OR Apache-2.0 OR Zlib",
    "MIT OR Zlib OR Apache-2.0",
    "MPL-2.0",
    "Unicode-3.0",
    "Unlicense OR MIT",
    "Zlib",
    "Zlib OR Apache-2.0 OR MIT",
  ];
  const dependencies = reviewedSpdx.map((license, index) => ({
    license,
    name: `owned-${index}`,
    source: "workspace",
    version: "0.1.0",
  }));
  const dependency = dependencies.find(({ license }) => license === "MIT");
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
    allowedFileModes: {
      "Contents/Info.plist": "0644",
      "Contents/MacOS/keiko-native-desktop": "0755",
      "Contents/Resources/THIRD-PARTY-NOTICES.json": "0644",
    },
    cargoInventory: dependencies,
    npmInventory: [],
    acceptedSpdxExpressions: reviewedSpdx,
    security: {
      allowedBundledOrigins: ["tauri://localhost", "http://tauri.localhost"],
      csp: "default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' asset: http://asset.localhost; script-src 'self'; style-src 'self'",
      prohibitedMarkers: [
        "--health-json",
        "codex/9-desktop-host-evaluation",
        "dummy.test",
        "example.invalid",
        "experiment-command",
        "generic-ping",
        "secret-value",
        "test-listener",
        "remote-debugging",
      ],
      prohibitedPathFragments: [
        "node_modules",
        "/target/",
        "/tests/",
        "fixture",
        "experiment",
        "listener",
        "driver",
      ],
    },
  };
  const files = [
    { path: "Contents/Info.plist", bytes: Buffer.from("plist"), mode: "0644" },
    {
      path: "Contents/MacOS/keiko-native-desktop",
      bytes: Buffer.from("product"),
      mode: "0755",
    },
    {
      path: "Contents/Resources/THIRD-PARTY-NOTICES.json",
      bytes: Buffer.from("notice"),
      mode: "0644",
    },
  ];
  const fileClasses = { ...policy.allowedFileClasses };
  assert.deepEqual(
    packagePolicyFailures({
      cargo: dependencies,
      fileClasses,
      files,
      npm: [],
      policy,
    }),
    [],
  );
  assert.ok(
    packagePolicyFailures({
      cargo: dependencies,
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
        cargo: dependencies,
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
    {
      ...policy,
      allowedFileModes: { ...policy.allowedFileModes, extra: "0644" },
    },
    { ...policy, cargoInventory: [] },
    { ...policy, npmInventory: [dependency] },
    { ...policy, acceptedSpdxExpressions: [] },
  ]) {
    assert.ok(
      packagePolicyFailures({
        cargo: dependencies,
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
      cargo: dependencies,
      fileClasses,
      files: redactedFiles,
      npm: [],
      policy,
    }).includes("package-redaction:Contents/MacOS/keiko-native-desktop"),
  );
  for (const hostile of [
    "operator@example.invalid",
    "https://10.0.0.7/private",
    "wss://service.local/socket",
    "authorization=Bearer-private-value",
    "http://dummy.test",
  ]) {
    const mutatedFiles = structuredClone(files);
    mutatedFiles[1].bytes = Buffer.from(hostile);
    assert.ok(
      packagePolicyFailures({
        cargo: dependencies,
        fileClasses,
        files: mutatedFiles,
        npm: [],
        policy,
      }).some((failure) =>
        failure.startsWith(
          hostile.includes("dummy.test")
            ? "production-marker:"
            : "package-redaction:",
        ),
      ),
    );
  }
  for (const key of ["prohibitedMarkers", "prohibitedPathFragments"]) {
    const values = policy.security[key];
    for (const changed of [
      [],
      values.slice(1),
      [...values.slice(0, -1), "replacement"],
      [...values, "extra"],
      [...values].reverse(),
    ]) {
      assert.ok(
        packagePolicyFailures({
          cargo: dependencies,
          fileClasses,
          files,
          npm: [],
          policy: {
            ...policy,
            security: { ...policy.security, [key]: changed },
          },
        }).includes("package-policy-security"),
      );
    }
  }
  const coordinatedInvalid = dependencies.map((entry, index) =>
    index === 0 ? { ...entry, license: "not-spdx" } : entry,
  );
  assert.ok(
    packagePolicyFailures({
      cargo: coordinatedInvalid,
      fileClasses,
      files,
      npm: [],
      policy: {
        ...policy,
        cargoInventory: coordinatedInvalid,
        acceptedSpdxExpressions: [
          ...reviewedSpdx.filter((license) => license !== reviewedSpdx[0]),
          "not-spdx",
        ].sort(),
      },
    }).includes("spdx-reviewed-expressions"),
  );
});

test("evidence schema and redaction fail closed", () => {
  const evidence = {
    schema: "keiko-native-packaged-shell-evidence/v1",
    sourceRevision: "0".repeat(40),
    readinessFingerprint:
      "da2459bd3becc6cbf651a24ef1b64d1b11a8ed642bfddc92923f0d6ed6dc8e5e",
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
  const bindings = {
    sourceRevision: evidence.sourceRevision,
    readinessFingerprint: evidence.readinessFingerprint,
    packageManifestSha256: evidence.packageManifestSha256,
    cargoLockSha256: evidence.cargoLockSha256,
    npmLockSha256: evidence.npmLockSha256,
  };
  assert.deepEqual(evidenceFailures(evidence, bindings), []);
  for (const acknowledgementMs of [5_001, 30_000]) {
    assert.deepEqual(
      evidenceFailures({ ...evidence, acknowledgementMs }, bindings),
      [],
    );
  }
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
    { ...evidence, acknowledgementMs: 30_001 },
    { ...evidence, shutdownMs: 1.5 },
    { ...evidence, cleanupOwnedDescendants: 1 },
    { ...evidence, redaction: "open" },
  ]) {
    assert.ok(evidenceFailures(mutation, bindings).length > 0);
  }
  for (const key of Object.keys(bindings)) {
    const wrong = key === "sourceRevision" ? "f".repeat(40) : "f".repeat(64);
    assert.ok(
      evidenceFailures({ ...evidence, [key]: wrong }, bindings).some(
        (failure) => failure.endsWith("binding"),
      ),
    );
  }
  assert.equal(redactionMatches("bounded reason code").length, 0);
  assert.equal(redactionMatches("password:!0").length, 0);
  assert.ok(redactionMatches('password="actual-value"').length > 0);
  assert.ok(redactionMatches("/Users/operator/project").length > 0);
  for (const hostile of [
    "operator@example.invalid",
    "https://192.168.1.10/private",
    "credential=private-value",
    "authorization: Bearer private-value",
  ]) {
    assert.ok(redactionMatches(hostile).length > 0, hostile);
  }
  for (const ordinary of [
    'name = "serde"\nchecksum = "abc"',
    "Copyright 2026 Example Authors; MIT",
    "tauri://localhost http://ipc.localhost http://asset.localhost",
    "https://react.dev/errors/123",
  ]) {
    assert.deepEqual(redactionMatches(ordinary), [], ordinary);
  }
});
