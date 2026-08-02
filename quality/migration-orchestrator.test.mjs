import assert from "node:assert/strict";
import test from "node:test";

import {
  beginMigrationAttempt,
  cancelMigrationAttempt,
  decideMigrationAttempt,
  supersedeMigrationAttempt,
} from "./migration-orchestrator.mjs";

const digest = "a".repeat(64);
const startedAt = "2026-08-01T12:00:00.000Z";

test("freezes one immutable generation and remains dry-run only", () => {
  const result = beginMigrationAttempt({
    generation: 1,
    manifest: { digest, path: "docs/qa/repository-migration-manifest-v1.md" },
    now: startedAt,
    repository: "oscharko-dev/Keiko-Native",
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempt.state, "dry-run");
  assert.equal(result.attempt.authority, "legacy-issue-authority");
  assert.equal(result.attempt.mutation, "none");
  assert.deepEqual(result.attempt.recoveryPlan, {
    postSwitch: "forward-only-repository-recovery",
    preSwitch: "cancel-and-rebuild-from-fresh-inventory",
    switchAuthority: "not-authorized-by-dry-run",
  });
  assert.equal(result.attempt.expiresAt, "2026-08-01T13:00:00.000Z");
  assert.equal(result.bytes.at(-1), 10);
});

test("expires at exactly 60 minutes and requires a fresh generation", () => {
  const attempt = beginMigrationAttempt({
    generation: 1,
    manifest: { digest, path: "docs/qa/repository-migration-manifest-v1.md" },
    now: startedAt,
    repository: "oscharko-dev/Keiko-Native",
  }).attempt;
  assert.equal(
    decideMigrationAttempt(attempt, "2026-08-01T12:59:59.999Z").decision,
    "continue",
  );
  const expired = decideMigrationAttempt(attempt, "2026-08-01T13:00:00.000Z");
  assert.equal(expired.decision, "cancel");
  assert.equal(expired.reason, "attempt-expired");
  assert.equal(expired.recovery, "fresh-inventory-and-generation");
});

test("cancellation and supersession are terminal and preserve old authority", () => {
  const attempt = beginMigrationAttempt({
    generation: 4,
    manifest: { digest, path: "docs/qa/repository-migration-manifest-v1.md" },
    now: startedAt,
    repository: "oscharko-dev/Keiko-Native",
  }).attempt;
  const cancelled = cancelMigrationAttempt(attempt, {
    now: "2026-08-01T12:05:00.000Z",
    reason: "provider-drift",
  });
  assert.equal(cancelled.attempt.state, "cancelled");
  assert.equal(cancelled.attempt.authority, "legacy-issue-authority");
  assert.equal(cancelled.attempt.recovery, "fresh-inventory-and-generation");
  assert.equal(
    cancelMigrationAttempt(cancelled.attempt, {
      now: startedAt,
      reason: "again",
    }).ok,
    false,
  );

  const superseded = supersedeMigrationAttempt(attempt, {
    nextGeneration: 5,
    now: "2026-08-01T12:06:00.000Z",
    reason: "manifest-changed",
  });
  assert.equal(superseded.attempt.state, "superseded");
  assert.equal(superseded.attempt.nextGeneration, 5);
  assert.equal(superseded.attempt.recovery, "fresh-inventory-and-generation");
});

test("malformed times, generations, and manifests fail closed", () => {
  const invalid = [
    {
      generation: 0,
      manifest: { digest, path: "docs/qa/repository-migration-manifest-v1.md" },
      now: startedAt,
    },
    {
      generation: 1,
      manifest: {
        digest: "bad",
        path: "docs/qa/repository-migration-manifest-v1.md",
      },
      now: startedAt,
    },
    {
      generation: 1,
      manifest: { digest, path: "docs/qa/other.md" },
      now: startedAt,
    },
    {
      generation: 1,
      manifest: { digest, path: "docs/qa/repository-migration-manifest-v1.md" },
      now: "soon",
    },
  ];
  for (const value of invalid) {
    assert.equal(
      beginMigrationAttempt({
        repository: "oscharko-dev/Keiko-Native",
        ...value,
      }).ok,
      false,
    );
  }
});
