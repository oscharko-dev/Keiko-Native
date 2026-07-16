import assert from "node:assert/strict";
import test from "node:test";

import {
  issueNumberFromReference,
  readinessCommentReference,
} from "./github-reference.mjs";

test("parses exact issue and readiness references", () => {
  assert.equal(issueNumberFromReference("#42"), 42);
  assert.equal(
    issueNumberFromReference("https://github.com/keiko/native/issues/42/"),
    42,
  );
  assert.deepEqual(
    readinessCommentReference(
      "https://github.com/keiko/native/issues/42#issuecomment-73",
    ),
    { commentId: 73, issueNumber: 42, repository: "keiko/native" },
  );
});

test("rejects ambiguous or non-GitHub references", () => {
  for (const reference of [
    undefined,
    "#0",
    "#01",
    "later",
    "http://github.com/keiko/native/issues/42",
    "https://example.com/keiko/native/issues/42",
    "https://github.com/keiko/native/issues/42?view=1",
    "https://github.com/keiko//issues/42",
    "https://github.com/keiko/native/pull/42",
  ]) {
    assert.equal(issueNumberFromReference(reference), undefined);
  }
  assert.equal(
    readinessCommentReference(
      "https://github.com/keiko/native/issues/42#issuecomment-invalid",
    ),
    undefined,
  );
  assert.equal(
    readinessCommentReference("https://github.com/keiko/native/issues/42"),
    undefined,
  );
});
