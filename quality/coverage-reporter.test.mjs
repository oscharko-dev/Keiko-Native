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

const arbitraryValues = [
  "ordinary deterministic assertion",
  "10.24.8.9:8443",
  "AKIAABCDEFGHIJKLMNOP",
  "+49 170 1234567",
  ".customer-record",
  "customer.12345678901234567890",
  "private_key=value",
  "privateKey=value",
  "urn:customer:private-record",
  "data:text,customer-record",
  "C:private-folder",
  "customer-record.mjs:17",
  "\\\\private-server\\customer\\record",
  "/private/customer records/record.mjs:17",
  "-----BEGIN PGP PRIVATE KEY BLOCK----- material",
  "\u001bPcustomer-secret\u001b\\",
];

test("failure diagnostics never emit arbitrary names or messages", () => {
  const expected =
    "✖ test failed [testCodeFailure:ERR_ASSERTION]. Rerun npm test locally with the standard reporter.\n";
  for (const value of arbitraryValues) {
    const diagnostic = failureDiagnostic({
      name: value,
      details: {
        error: {
          failureType: "testCodeFailure",
          code: "ERR_ASSERTION",
          message: value,
        },
      },
    });
    assert.equal(diagnostic, expected);
    assert.ok(!diagnostic.includes(value));
  }
});

test("failure metadata is an exact closed catalog", () => {
  assert.equal(
    failureDiagnostic({
      details: {
        error: { failureType: "testCodeFailure", code: "ERR_TEST_FAILURE" },
      },
    }),
    "✖ test failed [testCodeFailure:ERR_TEST_FAILURE]. Rerun npm test locally with the standard reporter.\n",
  );
  for (const value of [
    ...arbitraryValues,
    "Authorization",
    "ERR_ASSERTION_PRIVATE",
  ]) {
    assert.equal(
      failureDiagnostic({
        details: { error: { failureType: value, code: value } },
      }),
      "✖ test failed [unknown:unknown]. Rerun npm test locally with the standard reporter.\n",
    );
  }
});

test("reporter suppresses pass text and emits only fixed failure text", async () => {
  async function* source() {
    yield { type: "test:pass", data: { nesting: 0, name: arbitraryValues[0] } };
    yield {
      type: "test:fail",
      data: {
        name: arbitraryValues[1],
        details: { error: { message: arbitraryValues[2] } },
      },
    };
  }
  const output = [];
  for await (const chunk of coverageReporter(source())) output.push(chunk);
  assert.deepEqual(output, [
    "✖ test failed [unknown:unknown]. Rerun npm test locally with the standard reporter.\n",
  ]);
  for (const value of arbitraryValues) assert.ok(!output[0].includes(value));
});
