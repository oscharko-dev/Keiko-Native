import assert from "node:assert/strict";
import test from "node:test";

import { coverageStatusLine, toLcov } from "./coverage-reporter.mjs";

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
