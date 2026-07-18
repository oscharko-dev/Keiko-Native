import assert from "node:assert/strict";
import test from "node:test";

import { runNativeGateCli } from "./native-process.mjs";

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
});
