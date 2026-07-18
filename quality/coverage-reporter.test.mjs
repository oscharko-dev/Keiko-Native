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

test("failure diagnostics are bounded and fail closed for paths, secrets, and stacks", () => {
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
  assert.equal(
    diagnostic,
    "✖ <redacted-diagnostic> [testCodeFailure:ERR_ASSERTION] <redacted-diagnostic>\n",
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
    "✖ structured assertion [testCodeFailure:ERR_ASSERTION] <redacted-diagnostic>\n",
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
    "✖ fixture [testCodeFailure:ERR_TEST_FAILURE] <redacted-diagnostic>\n",
  );
});

test("failure diagnostics handle hostile and missing error metadata", () => {
  assert.equal(
    failureDiagnostic({
      details: { error: {}, type: "bad type with spaces" },
      name: "\u0000".repeat(300),
    }),
    "✖ <redacted-diagnostic> [unknown:unknown] Test failed without a bounded diagnostic.\n",
  );
});

test("failure diagnostics reject token-like metadata at the safe boundary", () => {
  assert.equal(
    failureDiagnostic({
      details: {
        error: {
          code: "A".repeat(32),
          failureType: "B".repeat(24),
          message: "bounded assertion failure",
        },
      },
      name: "metadata boundary",
    }),
    "✖ metadata boundary [unknown:unknown] bounded assertion failure\n",
  );
  assert.equal(
    failureDiagnostic({
      details: {
        error: {
          code: "A".repeat(23),
          failureType: "testCodeFailure",
          message: "bounded assertion failure",
        },
      },
      name: "metadata boundary",
    }),
    `✖ metadata boundary [testCodeFailure:${"A".repeat(23)}] bounded assertion failure\n`,
  );
});

test("failure diagnostics reject credential-like metadata", () => {
  for (const value of [
    "Authorization",
    "Bearer",
    "private_key",
    "secret",
    "token",
  ]) {
    assert.equal(
      failureDiagnostic({
        details: {
          error: {
            code: value,
            failureType: value,
            message: "bounded assertion failure",
          },
        },
        name: "metadata closure",
      }),
      "✖ metadata closure [unknown:unknown] bounded assertion failure\n",
    );
  }
});

test("failure diagnostics redact bearer credentials, UNC paths, and OSC controls", () => {
  const diagnostic = failureDiagnostic({
    details: {
      error: {
        code: "ERR_ASSERTION",
        failureType: "testCodeFailure",
        message: [
          "Authorization Bearer short-secret",
          String.raw`\\private-server\customer\record`,
          "\u001b]0;customer-secret\u0007visible failure",
        ].join(" "),
      },
    },
    name: [
      "hostile transport",
      "Authorization Bearer name-secret",
      String.raw`\\name-server\customer\record`,
      "\u001b]0;name-secret\u0007visible name",
    ].join(" "),
  });
  assert.equal(
    diagnostic,
    "✖ <redacted-diagnostic> [testCodeFailure:ERR_ASSERTION] <redacted-diagnostic>\n",
  );
  for (const forbidden of [
    "short-secret",
    "name-secret",
    "private-server",
    "name-server",
    "customer\\record",
    "]0;customer-secret",
  ]) {
    assert.ok(!diagnostic.includes(forbidden));
  }
});

test("failure diagnostics fail closed for credential markers", () => {
  assert.equal(
    failureDiagnostic({
      details: {
        error: {
          code: "ERR_AUTHORIZATION",
          failureType: "testCodeFailure",
          message:
            "Authorization failed; bearer policy unavailable; visible text",
        },
      },
      name: "useful diagnostic",
    }),
    "✖ useful diagnostic [testCodeFailure:ERR_AUTHORIZATION] <redacted-diagnostic>\n",
  );
});

test("failure diagnostics fail closed for relative and spaced paths in every field", () => {
  const diagnostic = failureDiagnostic({
    details: {
      error: {
        code: "ERR_ASSERTION",
        failureType: "testCodeFailure",
        message:
          "failed at /private/customer records/record.mjs:17 and C:\\private folder\\customer\\record.mjs:18",
      },
    },
    name: String.raw`private\customer\record.mjs:17`,
  });
  assert.equal(
    diagnostic,
    "✖ <redacted-diagnostic> [testCodeFailure:ERR_ASSERTION] <redacted-diagnostic>\n",
  );
  for (const forbidden of [
    "private\\customer",
    "customer records",
    "private folder",
    "record.mjs",
  ]) {
    assert.ok(!diagnostic.includes(forbidden));
  }
});

test("failure diagnostics fail closed for scheme, drive-relative, and filename grammars", () => {
  for (const value of [
    "urn:customer:private-record",
    "data:text,customer-record",
    "C:private-folder",
    "customer-record.mjs:17",
    "customer-record.test.mjs:17:9",
  ]) {
    const diagnostic = failureDiagnostic({
      details: {
        error: {
          code: "ERR_ASSERTION",
          failureType: "testCodeFailure",
          message: value,
        },
      },
      name: value,
    });
    assert.equal(
      diagnostic,
      "✖ <redacted-diagnostic> [testCodeFailure:ERR_ASSERTION] <redacted-diagnostic>\n",
    );
    assert.ok(!diagnostic.includes(value));
  }
});

test("failure diagnostics fail closed for every ECMA control-string family", () => {
  const hostileValues = [
    "\u009b31mC1-CSI-secret",
    "\u001bP1;2|DCS-secret\u001b\\visible",
    "\u001b_APC-secret\u0007visible",
    "\u001b^PM-secret\u001b\\visible",
    "\u001bXSOS-secret",
    "\u0090C1-DCS-secret\u009cvisible",
    "\u009fC1-APC-secret\u0007visible",
    "\u009eC1-PM-secret\u009cvisible",
    "\u0098C1-SOS-secret",
  ];
  for (const value of hostileValues) {
    const diagnostic = failureDiagnostic({
      details: {
        error: {
          code: "ERR_ASSERTION",
          failureType: "testCodeFailure",
          message: value,
        },
      },
      name: value,
    });
    assert.equal(
      diagnostic,
      "✖ <redacted-diagnostic> [testCodeFailure:ERR_ASSERTION] <redacted-diagnostic>\n",
    );
    assert.doesNotMatch(diagnostic, /secret|\u001b|[\u0080-\u009f]/u);
  }
});

test("failure diagnostics retain ordinary bounded ASCII text", () => {
  assert.equal(
    failureDiagnostic({
      details: {
        error: {
          code: "ERR_ASSERTION",
          failureType: "testCodeFailure",
          message: "Expected status 7 but received 9; retry is unavailable.",
        },
      },
      name: "ordinary deterministic assertion",
    }),
    "✖ ordinary deterministic assertion [testCodeFailure:ERR_ASSERTION] Expected status 7 but received 9; retry is unavailable.\n",
  );
  assert.equal(
    failureDiagnostic({
      details: {
        error: {
          code: "ERR_ASSERTION",
          failureType: "testCodeFailure",
          message: "status: 7; version 1.2.3. Recovery is unavailable.",
        },
      },
      name: "ordinary version boundary",
    }),
    "✖ ordinary version boundary [testCodeFailure:ERR_ASSERTION] status: 7; version 1.2.3. Recovery is unavailable.\n",
  );
});

test("failure diagnostics fail closed at the padded token boundary", () => {
  assert.equal(
    failureDiagnostic({
      details: {
        error: {
          code: "ERR_ASSERTION",
          failureType: "testCodeFailure",
          message: `${"A".repeat(22)}==`,
        },
      },
      name: "A".repeat(23),
    }),
    `✖ ${"A".repeat(23)} [testCodeFailure:ERR_ASSERTION] <redacted-diagnostic>\n`,
  );
});

test("failure diagnostics fail closed for private-key markers in every field", () => {
  const diagnostic = failureDiagnostic({
    details: {
      error: {
        code: "ERR_ASSERTION",
        failureType: "testCodeFailure",
        message: "-----BEGIN EC PRIVATE KEY----- message-material",
      },
    },
    name: "-----BEGIN PGP PRIVATE KEY BLOCK----- name-material",
  });
  assert.equal(
    diagnostic,
    "✖ <redacted-diagnostic> [testCodeFailure:ERR_ASSERTION] <redacted-diagnostic>\n",
  );
  assert.doesNotMatch(diagnostic, /PGP|EC PRIVATE|material/u);
});
