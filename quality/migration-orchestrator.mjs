import { createHash } from "node:crypto";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const manifestPathPattern =
  /^docs\/qa\/repository-migration-manifest-v[1-9]\d*\.md$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const hour = 60 * 60 * 1000;

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

function instant(value) {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
    ? milliseconds
    : undefined;
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function rejected(code) {
  return { code, ok: false };
}

function validManifest(manifest) {
  return (
    record(manifest) &&
    digestPattern.test(manifest.digest ?? "") &&
    manifestPathPattern.test(manifest.path ?? "")
  );
}

function attemptIdentity(attempt) {
  return (
    record(attempt) &&
    attempt.schemaVersion === 1 &&
    repositoryPattern.test(attempt.repository ?? "") &&
    positiveInteger(attempt.generation) &&
    validManifest(attempt.manifest) &&
    instant(attempt.startedAt) !== undefined &&
    instant(attempt.expiresAt) === instant(attempt.startedAt) + hour &&
    attempt.authority === "legacy-issue-authority" &&
    attempt.mutation === "none" &&
    attempt.recovery === "fresh-inventory-and-generation" &&
    record(attempt.recoveryPlan) &&
    attempt.recoveryPlan.postSwitch === "forward-only-repository-recovery" &&
    attempt.recoveryPlan.preSwitch ===
      "cancel-and-rebuild-from-fresh-inventory" &&
    attempt.recoveryPlan.switchAuthority === "not-authorized-by-dry-run"
  );
}

export function beginMigrationAttempt(input = {}) {
  const started = instant(input.now);
  if (
    !repositoryPattern.test(input.repository ?? "") ||
    !positiveInteger(input.generation) ||
    !validManifest(input.manifest) ||
    started === undefined
  ) {
    return rejected("invalid-migration-attempt");
  }
  const attempt = {
    authority: "legacy-issue-authority",
    expiresAt: new Date(started + hour).toISOString(),
    generation: input.generation,
    manifest: { digest: input.manifest.digest, path: input.manifest.path },
    mutation: "none",
    recovery: "fresh-inventory-and-generation",
    recoveryPlan: {
      postSwitch: "forward-only-repository-recovery",
      preSwitch: "cancel-and-rebuild-from-fresh-inventory",
      switchAuthority: "not-authorized-by-dry-run",
    },
    repository: input.repository,
    schemaVersion: 1,
    startedAt: input.now,
    state: "dry-run",
  };
  const bytes = canonicalBytes(attempt);
  return {
    attempt,
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
    ok: true,
  };
}

export function decideMigrationAttempt(attempt, now) {
  const current = instant(now);
  if (
    !attemptIdentity(attempt) ||
    attempt.state !== "dry-run" ||
    current === undefined
  )
    return rejected("invalid-migration-attempt");
  if (current < instant(attempt.startedAt))
    return rejected("migration-clock-regressed");
  return current < instant(attempt.expiresAt)
    ? { decision: "continue", ok: true }
    : {
        decision: "cancel",
        ok: true,
        reason: "attempt-expired",
        recovery: "fresh-inventory-and-generation",
      };
}

export function cancelMigrationAttempt(attempt, input = {}) {
  const current = instant(input.now);
  if (
    !attemptIdentity(attempt) ||
    attempt.state !== "dry-run" ||
    current === undefined ||
    current < instant(attempt.startedAt) ||
    typeof input.reason !== "string" ||
    !/^[a-z][a-z0-9-]{2,63}$/u.test(input.reason)
  ) {
    return rejected("invalid-migration-cancellation");
  }
  return {
    attempt: {
      ...attempt,
      cancelledAt: input.now,
      reason: input.reason,
      state: "cancelled",
    },
    ok: true,
  };
}

export function supersedeMigrationAttempt(attempt, input = {}) {
  const current = instant(input.now);
  if (
    !attemptIdentity(attempt) ||
    attempt.state !== "dry-run" ||
    current === undefined ||
    current < instant(attempt.startedAt) ||
    !positiveInteger(input.nextGeneration) ||
    input.nextGeneration !== attempt.generation + 1 ||
    typeof input.reason !== "string" ||
    !/^[a-z][a-z0-9-]{2,63}$/u.test(input.reason)
  ) {
    return rejected("invalid-migration-supersession");
  }
  return {
    attempt: {
      ...attempt,
      nextGeneration: input.nextGeneration,
      reason: input.reason,
      state: "superseded",
      supersededAt: input.now,
    },
    ok: true,
  };
}
