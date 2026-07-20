import assert from "node:assert/strict";
import test from "node:test";

import {
  isDirectInvocation,
  runNativeGateCli,
  sanitizeOutput,
} from "./native-process.mjs";

test("gate CLI recognizes canonical aliases without accepting another module", () => {
  const aliases = new Map([
    ["/var/snapshot/native-gate.mjs", "/private/var/snapshot/native-gate.mjs"],
    [
      "/private/var/snapshot/native-gate.mjs",
      "/private/var/snapshot/native-gate.mjs",
    ],
    ["/private/var/snapshot/other.mjs", "/private/var/snapshot/other.mjs"],
  ]);
  const canonicalize = (path) => aliases.get(path);
  assert.equal(
    isDirectInvocation(
      "/var/snapshot/native-gate.mjs",
      "/private/var/snapshot/native-gate.mjs",
      canonicalize,
    ),
    true,
  );
  assert.equal(
    isDirectInvocation(
      "/private/var/snapshot/other.mjs",
      "/private/var/snapshot/native-gate.mjs",
      canonicalize,
    ),
    false,
  );
  assert.equal(isDirectInvocation(undefined, "module", canonicalize), false);
});

test("top-level diagnostics remove PII while retaining actionable status", async () => {
  const diagnostics = [];
  const exitCode = await runNativeGateCli(
    async () => {
      throw new Error(
        [
          "Native architecture rejected status:7 operator@example.invalid https://internal.invalid token=private-value credential=loose-value",
          "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
          JSON.stringify({
            credential: "raw-value",
            path: "/Users/operator/project",
          }),
        ].join("\n"),
      );
    },
    "architecture",
    (diagnostic) => diagnostics.push(diagnostic),
  );
  assert.equal(exitCode, 1);
  assert.equal(diagnostics.length, 1);
  const [diagnostic] = diagnostics;
  assert.match(diagnostic, /Native architecture rejected/u);
  assert.match(diagnostic, /status:7/u);
  assert.ok(diagnostic.length <= 1024);
  assert.doesNotMatch(
    diagnostic,
    /operator@example\.invalid|internal\.invalid|private-value|loose-value|private-material|raw-value|\/Users\/operator/u,
  );
  assert.equal(
    await runNativeGateCli(
      async () => {},
      "security",
      (message) => diagnostics.push(message),
    ),
    0,
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(await runNativeGateCli(async () => 7, "package"), 7);
  assert.equal(
    await runNativeGateCli(
      async () => "0",
      "package",
      () => {},
    ),
    1,
  );
});

test("shared output sanitization closes private-key block markers without an end marker", () => {
  for (const marker of [
    "PGP PRIVATE KEY BLOCK",
    "PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
  ]) {
    assert.equal(
      sanitizeOutput(`failure -----BEGIN ${marker}----- material`),
      "failure <redacted-private-key>",
    );
  }
  assert.equal(
    sanitizeOutput("PRIVATE KEY policy check failed"),
    "PRIVATE KEY policy check failed",
  );
  assert.equal(
    sanitizeOutput("-----BEGIN PUBLIC KEY----- public-material"),
    "-----BEGIN PUBLIC KEY----- public-material",
  );
});
