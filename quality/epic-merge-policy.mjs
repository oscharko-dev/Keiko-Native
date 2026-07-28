import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  digestEpicMergeProbeManifest,
  EPIC_MERGE_REPOSITORY,
  isEpicMergeCommit,
  validateEpicMergePolicy,
} from "./epic-merge-policy-schema.mjs";

export {
  canonicalEpicMergeIdentity,
  digestEpicMergeProbeManifest,
  digestEpicMergeValue,
  EPIC_MERGE_REPOSITORY,
  isEpicMergeCommit,
  validateEpicMergePolicy,
} from "./epic-merge-policy-schema.mjs";

const positive = (value) => Number.isSafeInteger(value) && value > 0;

function proofCurrent(policy) {
  const { receipt, status } = policy.liveProof ?? {};
  const manifestDigest = digestEpicMergeProbeManifest(policy.probeManifest);
  const binding = [policy.activation.commit, manifestDigest];
  return (
    receipt?.activationCommit === binding[0] &&
    status?.activationCommit === binding[0] &&
    receipt?.manifestDigest === binding[1] &&
    status?.manifestDigest === binding[1] &&
    receipt?.producer === policy.expectedProducers.proof &&
    status?.producer === policy.expectedProducers.status &&
    receipt?.policyRevision === policy.source.revision &&
    status?.policyRevision === policy.source.revision &&
    receipt?.head === status?.head &&
    isEpicMergeCommit(receipt?.head) &&
    receipt?.matrixComplete === true &&
    receipt?.settled === true &&
    receipt?.ambiguous === false &&
    status?.conclusion === "success"
  );
}

export function findProbeManifestOperation(
  request,
  manifest,
  activationCommit,
) {
  if (
    manifest?.schema !== 2 ||
    manifest.repository !== EPIC_MERGE_REPOSITORY ||
    manifest.issue !== 55 ||
    manifest.activationCommit !== activationCommit ||
    !Array.isArray(manifest.operations)
  ) {
    return undefined;
  }
  return manifest.operations.find(
    (operation) =>
      operation.issue === request.issue &&
      operation.pullRequest === request.pullRequest &&
      operation.requestId === request.requestId &&
      operation.operationId === request.operationId,
  );
}

export function deriveEpicMergeAvailability(policy) {
  if (!validateEpicMergePolicy(policy)) {
    return { reason: "protected_policy_invalid", state: "disabled" };
  }
  if (policy.activation?.state !== "active") {
    return { reason: "activation_inactive", state: "disabled" };
  }
  if (policy.liveProof !== null && proofCurrent(policy)) {
    return { reason: "live_proof_settled", state: "enabled" };
  }
  return { reason: "live_proof_unavailable", state: "probe-only" };
}

export function epicMergeGuardStatus(policy) {
  const availability = deriveEpicMergeAvailability(policy);
  const effects = {
    disabled: "none",
    enabled: "eligible-only",
    "probe-only": "manifest-only",
  }[availability.state];
  return {
    effects,
    mode: "agent-credentialed",
    policyRevision: isEpicMergeCommit(policy?.source?.revision)
      ? policy.source.revision
      : null,
    reason: availability.reason,
    state: availability.state,
  };
}

function observedRef(ref, expectedName, present) {
  return (
    ref?.name === expectedName &&
    ref.exists === present &&
    (present ? isEpicMergeCommit(ref.tip) : ref.tip === null)
  );
}

export function buildEpicMergeProbePlan(input) {
  const primary = input?.parents?.primary;
  const stale = input?.parents?.stale;
  const refs = input?.refs;
  const slug = input?.targetSlug;
  if (
    input?.schema !== 2 ||
    input.repository !== EPIC_MERGE_REPOSITORY ||
    !positive(primary?.number) ||
    !positive(stale?.number) ||
    primary.number === stale.number ||
    primary.providerAssigned !== true ||
    stale.providerAssigned !== true ||
    typeof slug !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(slug) ||
    !observedRef(refs?.dev, "dev", true) ||
    !observedRef(refs?.main, "main", false) ||
    !observedRef(refs?.feature, refs?.feature?.name, true) ||
    !refs.feature.name.startsWith("codex/") ||
    !observedRef(refs?.release, refs?.release?.name, true) ||
    !refs.release.name.startsWith("release/") ||
    !observedRef(refs?.wrongEpic, refs?.wrongEpic?.name, true) ||
    !refs.wrongEpic.name.startsWith("epic/")
  ) {
    throw new Error("invalid_probe_topology");
  }
  const primaryTarget = `epic/${String(primary.number)}-${slug}`;
  const staleTarget = `epic/${String(stale.number)}-${slug}-stale`;
  const denials = Object.fromEntries(
    Object.entries(refs).map(([name, ref]) => [
      name,
      {
        afterReadRequired: true,
        before: { exists: ref.exists, tip: ref.tip },
        createAllowed: name !== "main",
        ref: ref.name,
      },
    ]),
  );
  denials.main.createAllowed = false;
  return {
    concurrency: {
      attempts: ["a", "b"].map((suffix) => ({
        base: refs.dev.tip,
        operationId: `probe-race-${suffix}`,
        requestId: `probe-race-request-${suffix}`,
        target: primaryTarget,
      })),
      serialization: { base: refs.dev.tip, target: primaryTarget },
    },
    denials,
    mode: "non-mutating-plan",
    primary: {
      base: refs.dev.tip,
      parentIssue: primary.number,
      target: primaryTarget,
    },
    refs: structuredClone(refs),
    repository: EPIC_MERGE_REPOSITORY,
    schema: 2,
    stale: {
      advanceBeforeAttempt: true,
      base: refs.dev.tip,
      parentIssue: stale.number,
      target: staleTarget,
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 3 || process.argv[2] !== "status")
    throw new Error("unsupported_epic_merge_policy_command");
  const policy = JSON.parse(
    await readFile(
      new URL("./epic-merge-policy.json", import.meta.url),
      "utf8",
    ),
  );
  policy.source.revision = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 128,
  }).trim();
  process.stdout.write(`${JSON.stringify(epicMergeGuardStatus(policy))}\n`);
}
