import assert from "node:assert/strict";
import test from "node:test";

import {
  default as coverageReporter,
  coverageStatusLine,
  failureDiagnostic,
  toLcov,
} from "./coverage-reporter.mjs";

test("renders deterministic repository-relative LCOV evidence", () => {
  const summary = {
    workingDirectory: "/workspace",
    files: [
      {
        path: "/workspace/quality/example.mjs",
        totalLineCount: 2,
        coveredLineCount: 1,
        totalBranchCount: 1,
        coveredBranchCount: 0,
        functions: [{ name: "example", line: 1, count: 1 }],
        branches: [{ line: 2, count: 0 }],
        lines: [
          { line: 1, count: 1 },
          { line: 2, count: 0 },
        ],
      },
    ],
  };
  const lcov = toLcov(summary);
  assert.match(lcov, /SF:quality\/example\.mjs/u);
  assert.match(lcov, /FNDA:1,example@1:0/u);
  assert.match(lcov, /DA:2,0/u);
  assert.match(lcov, /BRDA:2,0,0,0/u);
  assert.match(lcov, /LF:2\nLH:1/u);
  assert.match(lcov, /BRF:1\nBRH:0/u);
});

test("rejects coverage sources outside the repository", () => {
  assert.throws(
    () =>
      toLcov({
        workingDirectory: "/workspace",
        files: [
          {
            path: "/outside/example.mjs",
            totalLineCount: 0,
            coveredLineCount: 0,
            totalBranchCount: 0,
            coveredBranchCount: 0,
            functions: [],
            branches: [],
            lines: [],
          },
        ],
      }),
    /escaped the repository/u,
  );
});

test("reports threshold status from measured coverage", () => {
  const summary = {
    thresholds: { branch: 85, function: 85, line: 85 },
    totals: {
      coveredBranchPercent: 84.9,
      coveredFunctionPercent: 100,
      coveredLinePercent: 100,
    },
  };
  assert.match(coverageStatusLine(summary), /^coverage: failed\b/u);
  assert.match(
    coverageStatusLine({
      ...summary,
      totals: { ...summary.totals, coveredBranchPercent: 85 },
    }),
    /^coverage: passed\b/u,
  );
});

test("failure diagnostics are bounded and redact paths, secrets, and stacks", () => {
  const diagnostic = failureDiagnostic({
    details: {
      error: {
        code: "ERR_ASSERTION",
        message: [
          "\u001b[31m",
          "fixture failed at /Users/customer/private/workspace/source.mjs",
          "token=super-secret-token-value-1234567890",
          "https://private.invalid/customer/record",
          "C:\\customer\\private\\source.mjs",
          'input="raw customer input"',
          "operator@example.invalid",
          '{"payload":"customer record"}',
          "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
          "x".repeat(600),
        ].join(" "),
        stack: "RAW STACK MUST NOT APPEAR",
      },
      type: "testCodeFailure",
    },
    name: "fixture /Users/customer/private/workspace secret=owned",
  });
  assert.match(
    diagnostic,
    /^✖ fixture <path> secret=<redacted> \[testCodeFailure:ERR_ASSERTION\] /u,
  );
  assert.ok(diagnostic.length <= 512);
  for (const forbidden of [
    "/Users/customer",
    "super-secret-token",
    "private.invalid",
    "C:\\customer",
    "raw customer input",
    "operator@example.invalid",
    "customer record",
    "BEGIN PRIVATE KEY",
    "RAW STACK",
    "[31m",
  ]) {
    assert.ok(!diagnostic.includes(forbidden));
  }
});

test("structured failure messages are replaced instead of exposing payloads", () => {
  assert.equal(
    failureDiagnostic({
      details: {
        error: {
          code: "ERR_ASSERTION",
          message: '{"actual":{"customer":"private"}}',
        },
        type: "testCodeFailure",
      },
      name: "structured assertion",
    }),
    "✖ structured assertion [testCodeFailure:ERR_ASSERTION] <redacted-structured-output>\n",
  );
});

test("reporter emits only the sanitized bounded failure diagnostic", async () => {
  const event = {
    data: {
      details: {
        error: {
          code: "ERR_TEST_FAILURE",
          failureType: "testCodeFailure",
          message: "failed at /private/a",
        },
      },
      name: "fixture",
    },
    type: "test:fail",
  };
  async function* source() {
    yield event;
  }
  const output = [];
  for await (const chunk of coverageReporter(source())) output.push(chunk);
  assert.deepEqual(output, [failureDiagnostic(event.data)]);
  assert.equal(
    output[0],
    "✖ fixture [testCodeFailure:ERR_TEST_FAILURE] failed at <path>\n",
  );
});

test("failure diagnostics handle hostile and missing error metadata", () => {
  assert.equal(
    failureDiagnostic({
      details: { error: {}, type: "bad type with spaces" },
      name: "\u0000".repeat(300),
    }),
    "✖ (unnamed test) [unknown:unknown] Test failed without a bounded diagnostic.\n",
  );
});
