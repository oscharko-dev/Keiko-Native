import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  createMigrationGithubProvider,
  sanitizedMigrationProviderFailure,
} from "./migration-github-provider.mjs";
import {
  buildMigrationInventory,
  verifyMigrationInventory,
} from "./migration-inventory.mjs";
import { beginMigrationAttempt } from "./migration-orchestrator.mjs";

const repository = "oscharko-dev/Keiko-Native";

const canonicalBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);

function reportDigest(report) {
  return createHash("sha256").update(canonicalBytes(report)).digest("hex");
}

function dispositionCounts(dispositions) {
  const counts = new Map();
  for (const item of dispositions)
    counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
  return [...counts]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([code, count]) => ({ code, count }));
}

export async function runMigrationDryRun({
  build = buildMigrationInventory,
  generation,
  now,
  provider,
  repository: repositoryIdentity,
  verify = verifyMigrationInventory,
}) {
  if (
    repositoryIdentity !== repository ||
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    typeof now !== "string"
  ) {
    return { code: "dry-run-input-invalid", ok: false };
  }
  let snapshot;
  try {
    snapshot = await provider.snapshot(repositoryIdentity);
  } catch (error) {
    return { code: sanitizedMigrationProviderFailure(error), ok: false };
  }
  const inventory = build(snapshot);
  if (inventory.ok !== true)
    return {
      code: inventory.code,
      ok: false,
      status: "indeterminate",
    };
  if (verify(snapshot, inventory).ok !== true)
    return { code: "independent-verification-failed", ok: false };
  const memberIssues = inventory.inventory.issues
    .filter((issue) => issue.classification === "migration-member")
    .map((issue) => issue.number);
  const attempt =
    inventory.publishable === true
      ? beginMigrationAttempt({
          generation,
          manifest: inventory.manifest,
          now,
          repository: repositoryIdentity,
        })
      : null;
  if (attempt !== null && attempt.ok !== true)
    return { code: attempt.code, ok: false };
  const report = {
    attempt:
      attempt === null
        ? null
        : {
            digest: attempt.digest,
            expiresAt: attempt.attempt.expiresAt,
            generation: attempt.attempt.generation,
            recoveryPlan: attempt.attempt.recoveryPlan,
            state: attempt.attempt.state,
          },
    dispositionCounts: dispositionCounts(inventory.dispositions),
    dispositions: inventory.dispositions,
    issueCount: inventory.inventory.issues.length,
    manifest:
      inventory.manifest === null
        ? null
        : {
            digest: inventory.manifest.digest,
            path: inventory.manifest.path,
          },
    memberIssues,
    mutation: "none",
    observedAt: snapshot.observedAt,
    protectedDev: snapshot.protectedDev,
    publishable: inventory.publishable,
    pullRequestCount: inventory.inventory.pullRequests.length,
    reconciliation: inventory.reconciliation,
    repository: repositoryIdentity,
    schemaVersion: 1,
    status:
      inventory.publishable === true
        ? "publishable-dry-run"
        : "disposition-required",
  };
  return { digest: reportDigest(report), ok: true, report };
}

async function main() {
  const provider = createMigrationGithubProvider({
    expectedProtectedDev: process.env.KEIKO_MIGRATION_PROTECTED_DEV,
  });
  const result = await runMigrationDryRun({
    generation: Number(process.env.KEIKO_MIGRATION_GENERATION ?? "1"),
    now: new Date().toISOString(),
    provider,
    repository: process.env.GITHUB_REPOSITORY ?? repository,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
