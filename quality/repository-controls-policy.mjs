import { isDeepStrictEqual } from "node:util";

import { BROKER_CAPABILITY_SCHEMA } from "./epic-merge-broker-capability.mjs";
import { receiptVerificationKeyValid } from "./epic-merge-broker-receipt-crypto.mjs";

export const REPOSITORY_CONTROLS_POLICY_SCHEMA =
  "keiko-native-repository-controls-policy/v4";

export const RESTRICTED_CALLER_PERMISSIONS = Object.freeze({
  contents: "write",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
});
export const REPOSITORY_CONTROLS_REPOSITORY = "oscharko-dev/Keiko-Native";
export const REPOSITORY_CONTROLS_ACCOUNT = "oscharko-dev";
export const REPOSITORY_CONTROLS_PROBE_TARGET = "epic/50-controls-probe";

const checks = (entries) =>
  Object.freeze(
    entries.map(([context, appId]) => Object.freeze({ appId, context })),
  );

export const REQUIRED_CHECKS = checks([
  ["PR contract", 15368],
  ["Issue contract current", 15368],
  ["ci", 15368],
  ["actionlint", 15368],
  ["Verify pinned action SHAs", 15368],
  ["zizmor", 15368],
  ["Analyze (actions)", 15368],
  ["Analyze (javascript-typescript)", 15368],
  ["Build, scan, SBOM, smoke", 15368],
  ["Review dependency diff (dev/main)", 15368],
  ["native", 15368],
  ["Scan dependency lockfiles", 15368],
  ["SonarCloud Code Analysis", 12526],
  ["Socket Security: Project Report", 156372],
  ["Socket Security: Pull Request Alerts", 156372],
]);
export const DEV_ACTIVATION_CHECKS = checks([
  ["Contract publication", 15368],
  ["Lifecycle handoff", 15368],
]);
export const EPIC_ACTIVATION_CHECKS = checks([["Lifecycle handoff", 15368]]);
export const EPIC_REQUIRED_CHECKS = Object.freeze(
  REQUIRED_CHECKS.filter(
    ({ context }) =>
      ![
        "Review dependency diff (dev/main)",
        "SonarCloud Code Analysis",
      ].includes(context),
  ),
);

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const policyKeys = Object.freeze([
  "devBranch",
  "epic",
  "evidenceMaxAgeMinutes",
  "humanAllowlist",
  "identities",
  "mergeQueue",
  "pendingChecks",
  "repository",
  "requiredChecks",
  "schema",
]);

export const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const text = (value) => typeof value === "string" && value.length > 0;
export const positiveInteger = (value) =>
  Number.isSafeInteger(value) && value > 0;

export function exactKeys(value, expected) {
  return (
    record(value) &&
    isDeepStrictEqual(
      Object.keys(value).toSorted(compare),
      [...expected].toSorted(compare),
    )
  );
}

function canonicalStrings(values) {
  if (!Array.isArray(values) || values.some((value) => !text(value)))
    return undefined;
  const result = values.toSorted(compare);
  return new Set(result).size === result.length ? result : undefined;
}

export function exactStrings(actual, expected) {
  const left = canonicalStrings(actual);
  const right = canonicalStrings(expected);
  return (
    left !== undefined && right !== undefined && isDeepStrictEqual(left, right)
  );
}

export function canonicalChecks(values) {
  if (
    !Array.isArray(values) ||
    values.some(
      (item) =>
        !exactKeys(item, ["appId", "context"]) ||
        !positiveInteger(item.appId) ||
        !text(item.context),
    )
  )
    return undefined;
  const result = values
    .map(({ appId, context }) => `${context}\0${String(appId)}`)
    .toSorted(compare);
  return new Set(result).size === result.length ? result : undefined;
}

export function exactChecks(actual, expected) {
  const left = canonicalChecks(actual);
  const right = canonicalChecks(expected);
  return (
    left !== undefined && right !== undefined && isDeepStrictEqual(left, right)
  );
}

export function exactPermissions(actual, expected) {
  return (
    exactKeys(actual, Object.keys(expected)) &&
    isDeepStrictEqual(actual, expected)
  );
}

export function exactAppCoordinates(actual, expected) {
  const canonical = (values) => {
    if (
      !Array.isArray(values) ||
      values.some(
        (value) =>
          !exactKeys(value, ["appId", "appSlug"]) ||
          !positiveInteger(value.appId) ||
          !text(value.appSlug),
      )
    )
      return undefined;
    const result = values
      .map(({ appId, appSlug }) => `${appSlug}\0${String(appId)}`)
      .toSorted(compare);
    return new Set(result).size === result.length ? result : undefined;
  };
  const left = canonical(actual);
  const right = canonical(expected);
  return (
    left !== undefined && right !== undefined && isDeepStrictEqual(left, right)
  );
}

export function add(failures, condition, code) {
  if (condition && !failures.includes(code)) failures.push(code);
}

const secretKeyPattern =
  /^(?:access[_-]?token|authorization|client[_-]?secret|password|private[_-]?key|secret|token)$/iu;
const secretValuePattern =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_|gh[pousr]_|Bearer\s+[A-Za-z0-9._~-]|(?:^|[^A-Za-z0-9_-])eyj[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})/iu;

export function unsafeEvidenceValue(value) {
  const ancestors = new Set();
  let nodes = 0;
  function visit(item, depth) {
    nodes += 1;
    if (nodes > 10_000 || depth > 32) return true;
    if (typeof item === "string")
      return item.length > 512 || secretValuePattern.test(item);
    if (
      item === null ||
      ["boolean", "number", "undefined"].includes(typeof item)
    )
      return false;
    if (typeof item !== "object" || ancestors.has(item)) return true;
    ancestors.add(item);
    let unsafe;
    if (Array.isArray(item))
      unsafe =
        item.length > 1000 || item.some((entry) => visit(entry, depth + 1));
    else {
      const entries = Object.entries(item);
      unsafe =
        entries.length > 200 ||
        entries.some(
          ([key, entry]) =>
            key.length > 128 ||
            secretKeyPattern.test(key) ||
            visit(entry, depth + 1),
        );
    }
    ancestors.delete(item);
    return unsafe;
  }
  return visit(value, 0);
}

function identityConfigured(identity) {
  return (
    positiveInteger(identity?.appId) &&
    positiveInteger(identity?.installationId) &&
    text(identity?.appSlug)
  );
}

function identityPending(identity) {
  return (
    identity?.appId === null &&
    identity?.installationId === null &&
    identity?.appSlug === null
  );
}

function policyShapeValid(policy) {
  return (
    exactKeys(policy, policyKeys) &&
    exactKeys(policy.identities, ["broker", "caller"]) &&
    exactKeys(policy.pendingChecks, ["dev", "epic"]) &&
    exactKeys(policy.identities.broker, [
      "appId",
      "appSlug",
      "capabilityPolicy",
      "installationAccount",
      "installationId",
      "receiptVerificationKey",
      "receiptVerificationKeyFingerprint",
    ]) &&
    exactKeys(policy.identities.caller, [
      "appId",
      "appSlug",
      "installationAccount",
      "installationId",
      "permissions",
    ]) &&
    exactKeys(policy.epic, [
      "include",
      "probeTarget",
      "requiredChecks",
      "rulesetId",
    ]) &&
    exactKeys(policy.mergeQueue, ["maxEntriesToMerge"])
  );
}

function policyIdentityFailures(policy) {
  const failures = [];
  const { broker, caller } = policy.identities;
  add(
    failures,
    !identityConfigured(caller) && !identityPending(caller),
    "policy_caller_identity_invalid",
  );
  add(
    failures,
    !identityConfigured(broker) && !identityPending(broker),
    "policy_broker_identity_invalid",
  );
  add(failures, identityPending(caller), "policy_caller_identity_pending");
  add(failures, identityPending(broker), "policy_broker_identity_pending");
  const verificationPending =
    broker.receiptVerificationKey === null &&
    broker.receiptVerificationKeyFingerprint === null;
  add(
    failures,
    (identityPending(broker) && !verificationPending) ||
      (identityConfigured(broker) &&
        !receiptVerificationKeyValid(
          broker.receiptVerificationKey,
          broker.receiptVerificationKeyFingerprint,
        )),
    "policy_broker_receipt_verification_invalid",
  );
  add(
    failures,
    identityConfigured(caller) &&
      identityConfigured(broker) &&
      (caller.appId === broker.appId ||
        caller.installationId === broker.installationId ||
        caller.appSlug === broker.appSlug),
    "policy_identity_separation_invalid",
  );
  return failures;
}

function policyStaticFailures(policy) {
  const failures = [];
  add(
    failures,
    policy.schema !== REPOSITORY_CONTROLS_POLICY_SCHEMA,
    "policy_schema_invalid",
  );
  add(
    failures,
    policy.repository !== REPOSITORY_CONTROLS_REPOSITORY,
    "policy_repository_invalid",
  );
  add(failures, policy.devBranch !== "dev", "policy_dev_branch_invalid");
  add(
    failures,
    !Number.isSafeInteger(policy.evidenceMaxAgeMinutes) ||
      policy.evidenceMaxAgeMinutes <= 0 ||
      policy.evidenceMaxAgeMinutes > 60,
    "policy_freshness_invalid",
  );
  add(
    failures,
    policy.identities.caller.installationAccount !==
      REPOSITORY_CONTROLS_ACCOUNT ||
      policy.identities.broker.installationAccount !==
        REPOSITORY_CONTROLS_ACCOUNT,
    "policy_installation_account_invalid",
  );
  add(
    failures,
    !exactStrings(policy.humanAllowlist, ["Niko4417", "oscharko"]),
    "policy_human_allowlist_invalid",
  );
  add(
    failures,
    !exactPermissions(
      policy.identities.caller.permissions,
      RESTRICTED_CALLER_PERMISSIONS,
    ),
    "policy_caller_permissions_invalid",
  );
  add(
    failures,
    policy.identities.broker.capabilityPolicy !== BROKER_CAPABILITY_SCHEMA,
    "policy_broker_capability_invalid",
  );
  return failures;
}

function policyEpicFailures(policy) {
  const failures = [];
  add(
    failures,
    !positiveInteger(policy.epic.rulesetId) && policy.epic.rulesetId !== null,
    "policy_epic_ruleset_invalid",
  );
  add(failures, policy.epic.rulesetId === null, "policy_epic_ruleset_pending");
  add(
    failures,
    !exactStrings(policy.epic.include, ["refs/heads/epic/**"]),
    "policy_epic_target_invalid",
  );
  add(
    failures,
    policy.epic.probeTarget !== REPOSITORY_CONTROLS_PROBE_TARGET,
    "policy_epic_probe_target_invalid",
  );
  const staged =
    exactChecks(policy.requiredChecks, REQUIRED_CHECKS) &&
    exactChecks(policy.pendingChecks.dev, DEV_ACTIVATION_CHECKS) &&
    exactChecks(policy.pendingChecks.epic, EPIC_ACTIVATION_CHECKS) &&
    exactChecks(policy.epic.requiredChecks, EPIC_REQUIRED_CHECKS);
  const activated =
    exactChecks(policy.requiredChecks, [
      ...REQUIRED_CHECKS,
      ...DEV_ACTIVATION_CHECKS,
    ]) &&
    exactChecks(policy.pendingChecks.dev, []) &&
    exactChecks(policy.pendingChecks.epic, []) &&
    exactChecks(policy.epic.requiredChecks, [
      ...EPIC_REQUIRED_CHECKS,
      ...EPIC_ACTIVATION_CHECKS,
    ]);
  add(failures, !staged && !activated, "policy_checks_invalid");
  add(
    failures,
    policy.pendingChecks.dev.length > 0 || policy.pendingChecks.epic.length > 0,
    "policy_pending_checks_block_activation",
  );
  add(
    failures,
    policy.mergeQueue.maxEntriesToMerge !== 1,
    "policy_merge_queue_invalid",
  );
  return failures;
}

export function repositoryControlsPolicyFailures(policy) {
  try {
    if (!policyShapeValid(policy)) return ["policy_shape_invalid"];
    return [
      ...policyStaticFailures(policy),
      ...policyIdentityFailures(policy),
      ...policyEpicFailures(policy),
    ];
  } catch {
    return ["policy_invalid"];
  }
}
