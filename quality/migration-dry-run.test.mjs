import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runMigrationDryRun } from "./migration-dry-run.mjs";

const repository = "oscharko-dev/Keiko-Native";

function inventory({ publishable = false } = {}) {
  const manifest = publishable
    ? {
        digest: "a".repeat(64),
        path: "docs/qa/repository-migration-manifest-v1.md",
      }
    : null;
  return {
    dispositions: publishable
      ? []
      : [{ code: "completion-unverifiable", kind: "issue", number: 9 }],
    inventory: {
      issues: [
        { classification: "migration-member", number: 49 },
        { classification: "completed", number: 94 },
      ],
      pullRequests: [{ number: 107 }],
    },
    manifest,
    ok: true,
    publishable,
    reconciliation: [
      {
        current: ["status: ready"],
        desired: ["status: done"],
        kind: "issue",
        number: 94,
      },
    ],
  };
}

const snapshot = {
  observedAt: "2026-08-01T12:00:00.000Z",
  protectedDev: "d".repeat(40),
};

test("emits a sanitized disposition-required live report with zero mutation", async () => {
  const result = await runMigrationDryRun({
    build: () => inventory(),
    generation: 1,
    now: snapshot.observedAt,
    provider: { snapshot: async () => snapshot },
    repository,
    verify: () => ({ ok: true }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.report.status, "disposition-required");
  assert.equal(result.report.mutation, "none");
  assert.equal(result.report.attempt, null);
  assert.deepEqual(result.report.memberIssues, [49]);
  assert.deepEqual(result.report.dispositionCounts, [
    { code: "completion-unverifiable", count: 1 },
  ]);
  assert.equal(result.digest.length, 64);
  assert.doesNotMatch(JSON.stringify(result), /body|title|credential/iu);
});

test("binds a publishable report to the bounded dry-run attempt", async () => {
  const result = await runMigrationDryRun({
    build: () => inventory({ publishable: true }),
    generation: 3,
    now: snapshot.observedAt,
    provider: { snapshot: async () => snapshot },
    repository,
    verify: () => ({ ok: true }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.report.status, "publishable-dry-run");
  assert.equal(result.report.attempt.generation, 3);
  assert.equal(result.report.attempt.expiresAt, "2026-08-01T13:00:00.000Z");
  assert.equal(
    result.report.attempt.recoveryPlan.postSwitch,
    "forward-only-repository-recovery",
  );
});

test("fails closed on invalid input, provider failure, and verifier mismatch", async () => {
  const base = {
    build: () => inventory(),
    generation: 1,
    now: snapshot.observedAt,
    provider: { snapshot: async () => snapshot },
    repository,
    verify: () => ({ ok: true }),
  };
  assert.deepEqual(await runMigrationDryRun({ ...base, generation: 0 }), {
    code: "dry-run-input-invalid",
    ok: false,
  });
  assert.deepEqual(
    await runMigrationDryRun({
      ...base,
      provider: { snapshot: async () => Promise.reject(new Error("SECRET")) },
    }),
    { code: "provider-unavailable", ok: false },
  );
  assert.deepEqual(
    await runMigrationDryRun({ ...base, verify: () => ({ ok: false }) }),
    { code: "independent-verification-failed", ok: false },
  );
});

test("passes publishable manifest bytes unchanged to independent verification", async () => {
  const bytes = Buffer.from('{"entries":[]}\n');
  let observed;
  const result = await runMigrationDryRun({
    build: () => ({
      ...inventory({ publishable: true }),
      manifest: {
        bytes,
        digest: "a".repeat(64),
        entries: [],
        path: "docs/qa/repository-migration-manifest-v1.md",
      },
    }),
    generation: 1,
    now: snapshot.observedAt,
    provider: { snapshot: async () => snapshot },
    repository,
    verify: (_snapshot, output) => {
      observed = output.manifest.bytes;
      return { ok: Buffer.isBuffer(observed) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(observed, bytes);
});

test("keeps repository credentials out of candidate-controlled pull-request code", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/migration-dry-run.yml", import.meta.url),
    "utf8",
  );
  const candidateJob =
    /  candidate-contracts:\n(?<body>[\s\S]*?)\n  protected-inventory:/u.exec(
      workflow,
    )?.groups?.body;
  assert.match(candidateJob, /if: github\.event_name == 'pull_request'/u);
  assert.doesNotMatch(candidateJob, /GITHUB_TOKEN|github\.token/u);
  assert.match(
    workflow,
    /protected-inventory:\n    if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/dev'/u,
  );
});
