import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyContractVerification,
  contractSha256,
  parseContractPath,
  parseQuarantineRecoveryDeclarations,
  parseSupersessionDeclaration,
} from "./repository-contract.mjs";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

test("parses only canonical add-only contract paths", () => {
  assert.deepEqual(parseContractPath("docs/contracts/task-35-v2-r3.md"), {
    contract: {
      issue: 35,
      path: "docs/contracts/task-35-v2-r3.md",
      revision: 3,
      type: "task",
      version: 2,
    },
    ok: true,
  });

  for (const path of [
    "docs/contracts/task-035-v2-r3.md",
    "docs/contracts/task-35-v0-r3.md",
    "docs/contracts/task-35-v2-r03.md",
    "docs/contracts/publications/task-35-v2-r3.md",
    "../docs/contracts/task-35-v2-r3.md",
    "docs/contracts/unknown-35-v2-r3.md",
    "docs/contracts/task-9007199254740992-v2-r3.md",
    "docs/contracts/task-35-v9007199254740992-r3.md",
    "docs/contracts/task-35-v2-r999999999999999999999.md",
    undefined,
  ]) {
    const result = parseContractPath(path);
    assert.equal(result.ok, false, path);
    assert.equal(result.rejection.code, "invalid_contract_path", path);
    assert.doesNotMatch(result.rejection.message, /035|unknown|\.\./u);
  }
  assert.equal(
    parseContractPath(
      "docs/contracts/task-9007199254740991-v9007199254740991-r9007199254740991.md",
    ).ok,
    true,
  );
});

test("hashes exact blob bytes without text normalization", () => {
  const lf = Buffer.from("line one\nline two\n");
  const crlf = Buffer.from("line one\r\nline two\r\n");
  const binary = Uint8Array.from([0x66, 0x6f, 0x80, 0x0a]);

  assert.equal(
    contractSha256(lf).digest,
    "e9024f1a07d29d52ad3aa5e1a18e94db1f3a9fd32b89e39d47c472cd99071e13",
  );
  assert.notEqual(contractSha256(lf).digest, contractSha256(crlf).digest);
  assert.equal(
    contractSha256(binary).digest,
    "e1376c9665f5016fa8bfdc14c38d488eae21f72b13bc72d718c148af138fc93a",
  );
  assert.equal(contractSha256("line one\n").ok, false);
});

test("parses an optional exact supersession binding", () => {
  const path = "docs/contracts/task-35-v1-r1.md";
  assert.deepEqual(
    parseSupersessionDeclaration(`Heading\nSupersedes: ${digestA} ${path}`),
    { ok: true, supersedes: { digest: digestA, path } },
  );
  assert.deepEqual(parseSupersessionDeclaration("No predecessor"), {
    ok: true,
    supersedes: null,
  });

  for (const body of [
    `Supersedes: ${digestA} ${path}\nSupersedes: ${digestA} ${path}`,
    `Supersedes: ${digestA.toUpperCase()} ${path}`,
    `Supersedes: ${digestA} docs/contracts/task-035-v1-r1.md`,
    `Supersedes: ${digestA} ${path} SECRET-CONTENT`,
    undefined,
  ]) {
    const result = parseSupersessionDeclaration(body);
    assert.equal(result.ok, false);
    assert.match(result.rejection.code, /supersession|body/u);
    assert.doesNotMatch(result.rejection.message, /SECRET|aaaa/u);
  }
});

test("ignores declaration marker text embedded in prose", () => {
  const path = "docs/contracts/task-35-v1-r1.md";
  assert.deepEqual(
    parseSupersessionDeclaration(
      `The field Supersedes: ${digestA} ${path} is documented here.`,
    ),
    { ok: true, supersedes: null },
  );
  assert.deepEqual(
    parseQuarantineRecoveryDeclarations(
      `The field Recovers-Publication: ${digestA} ${path} is documented here.`,
    ),
    { ok: true, recoveries: [] },
  );
  assert.equal(
    parseSupersessionDeclaration("Supersedes: malformed").rejection.code,
    "malformed_supersession",
  );
  assert.equal(
    parseQuarantineRecoveryDeclarations("Recovers-Publication: malformed")
      .rejection.code,
    "malformed_recovery",
  );
});

test("requires unique quarantine recoveries in lexical path order", () => {
  const first = "docs/contracts/task-35-v2-r1.md";
  const second = "docs/contracts/task-35-v2-r2.md";
  assert.deepEqual(
    parseQuarantineRecoveryDeclarations(
      `Recovers-Publication: ${digestA} ${first}\nRecovers-Publication: ${digestB} ${second}`,
    ),
    {
      ok: true,
      recoveries: [
        { digest: digestA, path: first },
        { digest: digestB, path: second },
      ],
    },
  );

  const invalidBodies = [
    [
      `Recovers-Publication: ${digestA} ${first}`.repeat(2),
      "malformed_recovery",
    ],
    [
      `Recovers-Publication: ${digestB} ${second}\nRecovers-Publication: ${digestA} ${first}`,
      "unsorted_recovery",
    ],
    [
      `Recovers-Publication: ${digestA} ${first}\nRecovers-Publication: ${digestA} ${first}`,
      "duplicate_recovery",
    ],
    [
      `Recovers-Publication: ${digestA} ${first}\nRecovers-Publication: ${digestB} ${first}`,
      "conflicting_recovery",
    ],
  ];
  for (const [body, code] of invalidBodies) {
    assert.equal(
      parseQuarantineRecoveryDeclarations(body).rejection.code,
      code,
    );
  }
  assert.equal(
    parseQuarantineRecoveryDeclarations(undefined).rejection.code,
    "invalid_contract_body",
  );
});

test("classifies complete valid evidence as authoritative", () => {
  assert.deepEqual(
    classifyContractVerification({
      checks: [
        { origin: "protected-commit", status: "valid" },
        { origin: "protected-tree", status: "valid" },
        { origin: "protected-bytes", status: "valid" },
        { origin: "stable-provider-identity", status: "valid" },
      ],
    }),
    {
      consumesRevision: false,
      ok: true,
      reason: "all_required_facts_valid",
      retry: "none",
      state: "authoritative",
    },
  );
});

test("requires a unique complete immutable evidence set for authority", () => {
  for (const origin of ["workflow", "comment", "protected-tree", "api"]) {
    assert.equal(
      classifyContractVerification({ checks: [{ origin, status: "valid" }] })
        .state,
      "indeterminate",
      origin,
    );
  }
  const complete = [
    { origin: "protected-bytes", status: "valid" },
    { origin: "protected-commit", status: "valid" },
    { origin: "protected-tree", status: "valid" },
    { origin: "stable-provider-identity", status: "valid" },
  ];
  assert.equal(
    classifyContractVerification({ checks: complete.slice(1) }).state,
    "indeterminate",
  );
  assert.equal(
    classifyContractVerification({ checks: [...complete, complete[0]] }).state,
    "indeterminate",
  );
  assert.equal(
    classifyContractVerification({
      checks: [...complete, { origin: "workflow", status: "valid" }],
    }).state,
    "authoritative",
  );
});

test("keeps unavailable, failed, malformed, or inconsistent evidence indeterminate", () => {
  for (const status of [
    "unavailable",
    "transient",
    "malformed",
    "inconsistent",
    "permission-denied",
    "rate-limited",
  ]) {
    const result = classifyContractVerification({
      checks: [{ origin: "api", status }],
    });
    assert.equal(result.state, "indeterminate", status);
    assert.equal(result.retry, "same_revision", status);
    assert.equal(result.consumesRevision, false, status);
  }
  assert.equal(
    classifyContractVerification({ checks: [] }).state,
    "indeterminate",
  );
  assert.equal(
    classifyContractVerification({ checks: "SECRET" }).state,
    "indeterminate",
  );
});

test("quarantines only a reproducible immutable contradiction", () => {
  for (const origin of [
    "protected-commit",
    "protected-tree",
    "protected-bytes",
  ]) {
    const result = classifyContractVerification({
      checks: [{ origin, reproducible: true, status: "contradiction" }],
    });
    assert.equal(result.state, "quarantined", origin);
    assert.equal(result.consumesRevision, true, origin);
  }
  assert.equal(
    classifyContractVerification({
      checks: [
        {
          origin: "stable-provider-identity",
          reproducible: true,
          status: "contradiction",
        },
      ],
    }).state,
    "quarantined",
  );
});

test("never derives quarantine from workflow, API, comment, or one-off failure", () => {
  for (const origin of ["workflow", "api", "comment"]) {
    assert.equal(
      classifyContractVerification({
        checks: [{ origin, reproducible: true, status: "contradiction" }],
      }).state,
      "indeterminate",
      origin,
    );
  }
  assert.equal(
    classifyContractVerification({
      checks: [
        {
          origin: "protected-tree",
          reproducible: false,
          status: "contradiction",
        },
      ],
    }).state,
    "indeterminate",
  );
});
