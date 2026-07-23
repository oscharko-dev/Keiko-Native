import { brokerCapabilityFailures } from "./epic-merge-broker-capability.mjs";
import {
  REPOSITORY_CONTROLS_POLICY_SCHEMA,
  RESTRICTED_CALLER_PERMISSIONS,
  add,
  exactAppCoordinates,
  exactChecks,
  exactKeys,
  exactPermissions,
  exactStrings,
  repositoryControlsPolicyFailures,
  text,
  unsafeEvidenceValue,
} from "./repository-controls-policy.mjs";
import {
  REPOSITORY_CONTROLS_PROBES_SCHEMA,
  repositoryControlProbeFailures,
} from "./repository-controls-probes.mjs";
import { configurationReadFailures } from "./repository-controls-readback.mjs";

export {
  REPOSITORY_CONTROLS_POLICY_SCHEMA,
  REPOSITORY_CONTROLS_PROBES_SCHEMA,
  RESTRICTED_CALLER_PERMISSIONS,
  repositoryControlsPolicyFailures,
};

export const REPOSITORY_CONTROLS_EVIDENCE_SCHEMA =
  "keiko-native-repository-controls-evidence/v3";

const shaPattern = /^[0-9a-f]{40}$/u;
const evidenceKeys = Object.freeze([
  "actions",
  "administration",
  "broker",
  "caller",
  "capturedAt",
  "configurationReads",
  "devHeadSha",
  "devProtection",
  "epicProtection",
  "mergeQueue",
  "probes",
  "repository",
  "schema",
  "sources",
]);
const appKeys = Object.freeze([
  "account",
  "appId",
  "appSlug",
  "installationId",
  "permissions",
  "repositories",
  "repositorySelection",
  "suspended",
]);
const protectionKeys = Object.freeze([
  "adminsEnforced",
  "branchDeletionAllowed",
  "conversationResolutionRequired",
  "forcePushAllowed",
  "linearHistoryRequired",
  "pullRequestRequired",
  "requiredChecks",
  "signedCommitsRequired",
  "strictChecks",
  "updateAllowlist",
]);
const epicProtectionKeys = Object.freeze([
  "adminsEnforced",
  "branchDeletionAllowed",
  "bypassActors",
  "conversationResolutionRequired",
  "enforcement",
  "exclude",
  "forcePushAllowed",
  "include",
  "linearHistoryRequired",
  "pullRequestRequired",
  "requiredChecks",
  "rulesetId",
  "signedCommitsRequired",
  "strictChecks",
  "updateAllowlist",
]);

function evidenceShapeValid(evidence) {
  return (
    exactKeys(evidence, evidenceKeys) &&
    exactKeys(evidence.actions, [
      "canApprovePullRequestReviews",
      "defaultWorkflowPermissions",
    ]) &&
    exactKeys(evidence.administration, ["humanAdmins"]) &&
    exactKeys(evidence.caller, ["app", "credential"]) &&
    exactKeys(evidence.configurationReads, [
      "administration",
      "broker",
      "caller",
    ]) &&
    exactKeys(evidence.caller.app, appKeys) &&
    exactKeys(evidence.caller.credential, [
      "agentReadable",
      "custody",
      "expiresAt",
      "kind",
      "ordinaryWorkflowReadable",
    ]) &&
    exactKeys(evidence.devProtection, protectionKeys) &&
    exactKeys(evidence.epicProtection, epicProtectionKeys) &&
    exactKeys(evidence.mergeQueue, ["maxEntriesToMerge"]) &&
    exactKeys(evidence.sources, [
      "administration",
      "broker",
      "caller",
      "probes",
    ])
  );
}

function timestamp(value) {
  if (!text(value)) return undefined;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}

function freshnessFailures(evidence, policy, now) {
  const failures = [];
  const capturedAt = timestamp(evidence.capturedAt);
  add(failures, capturedAt === undefined, "evidence_capture_time_invalid");
  add(
    failures,
    capturedAt !== undefined &&
      (capturedAt > now + 5 * 60 * 1000 ||
        now - capturedAt > policy.evidenceMaxAgeMinutes * 60 * 1000),
    "evidence_stale",
  );
  return failures;
}

function sourceFailures(sources) {
  return Object.entries(sources).flatMap(([source, status]) =>
    status === "ok" ? [] : [`source_${source}_unavailable`],
  );
}

function appIdentityFailures(app, expected, prefix, permissions, repository) {
  const failures = [];
  add(
    failures,
    app.appId !== expected.appId ||
      app.installationId !== expected.installationId ||
      app.appSlug !== expected.appSlug ||
      app.account !== expected.installationAccount,
    `${prefix}_identity_mismatch`,
  );
  add(
    failures,
    app.repositorySelection !== "selected" ||
      !exactStrings(app.repositories, [repository]),
    `${prefix}_repository_scope_invalid`,
  );
  add(failures, app.suspended !== false, `${prefix}_installation_suspended`);
  add(
    failures,
    !exactPermissions(app.permissions, permissions),
    `${prefix}_permissions_mismatch`,
  );
  return failures;
}

function callerCredentialFailures(evidence, now) {
  const failures = [];
  const credential = evidence.caller.credential;
  add(
    failures,
    credential.agentReadable !== false ||
      credential.custody !== "server-side-restricted-caller-only" ||
      credential.kind !== "short-lived-installation-token" ||
      credential.ordinaryWorkflowReadable !== false,
    "caller_credential_custody_invalid",
  );
  const capturedAt = timestamp(evidence.capturedAt);
  const expiresAt = timestamp(credential.expiresAt);
  add(failures, expiresAt === undefined, "caller_token_expiry_invalid");
  add(
    failures,
    capturedAt !== undefined &&
      expiresAt !== undefined &&
      expiresAt <= capturedAt,
    "caller_token_expired_at_capture",
  );
  add(
    failures,
    capturedAt !== undefined &&
      expiresAt !== undefined &&
      (expiresAt <= now || expiresAt - capturedAt > 60 * 60 * 1000),
    "caller_token_expired",
  );
  return failures;
}

function allowlistMatches(actual, expected) {
  return (
    exactKeys(actual, ["apps", "teams", "users"]) &&
    exactAppCoordinates(actual.apps, expected.apps) &&
    exactStrings(actual.teams, expected.teams) &&
    exactStrings(actual.users, expected.users)
  );
}

function devProtectionFailures(value, policy) {
  const failures = [];
  add(
    failures,
    !exactChecks(value.requiredChecks, policy.requiredChecks),
    "dev_required_checks_mismatch",
  );
  add(
    failures,
    !allowlistMatches(value.updateAllowlist, {
      apps: [],
      teams: [],
      users: policy.humanAllowlist,
    }),
    "dev_update_allowlist_mismatch",
  );
  add(
    failures,
    value.adminsEnforced !== true ||
      value.pullRequestRequired !== true ||
      value.strictChecks !== true ||
      value.signedCommitsRequired !== true ||
      value.linearHistoryRequired !== true ||
      value.conversationResolutionRequired !== true ||
      value.forcePushAllowed !== false ||
      value.branchDeletionAllowed !== false,
    "dev_protection_mismatch",
  );
  return failures;
}

function epicProtectionFailures(value, policy) {
  const failures = [];
  add(
    failures,
    value.rulesetId !== policy.epic.rulesetId ||
      value.enforcement !== "active" ||
      !exactStrings(value.include, policy.epic.include) ||
      !exactStrings(value.exclude, []),
    "epic_ruleset_mismatch",
  );
  add(
    failures,
    !exactChecks(value.requiredChecks, policy.epic.requiredChecks),
    "epic_required_checks_mismatch",
  );
  add(
    failures,
    !allowlistMatches(value.updateAllowlist, {
      apps: [
        {
          appId: policy.identities.broker.appId,
          appSlug: policy.identities.broker.appSlug,
        },
      ],
      teams: [],
      users: policy.humanAllowlist,
    }),
    "epic_update_allowlist_mismatch",
  );
  add(
    failures,
    !exactStrings(value.bypassActors, []),
    "epic_bypass_actor_present",
  );
  add(
    failures,
    value.adminsEnforced !== true ||
      value.pullRequestRequired !== true ||
      value.strictChecks !== true ||
      value.signedCommitsRequired !== true ||
      value.linearHistoryRequired !== true ||
      value.conversationResolutionRequired !== true ||
      value.forcePushAllowed !== false ||
      value.branchDeletionAllowed !== false,
    "epic_protection_mismatch",
  );
  return failures;
}

function identityFailures(evidence, policy, now) {
  const failures = appIdentityFailures(
    evidence.caller.app,
    policy.identities.caller,
    "caller",
    RESTRICTED_CALLER_PERMISSIONS,
    policy.repository,
  );
  failures.push(...callerCredentialFailures(evidence, now));
  failures.push(...brokerCapabilityFailures(evidence.broker, now));
  add(
    failures,
    evidence.broker?.repository !== policy.repository,
    "broker_repository_mismatch",
  );
  add(
    failures,
    evidence.broker?.capturedAt !== evidence.capturedAt,
    "broker_capture_mismatch",
  );
  add(
    failures,
    evidence.broker?.app?.appId !== policy.identities.broker.appId ||
      evidence.broker?.app?.installationId !==
        policy.identities.broker.installationId ||
      evidence.broker?.app?.appSlug !== policy.identities.broker.appSlug ||
      evidence.broker?.app?.account !==
        policy.identities.broker.installationAccount,
    "broker_identity_mismatch",
  );
  return failures;
}

function repositoryAuthorityFailures(evidence, policy) {
  const failures = [];
  add(
    failures,
    evidence.repository !== policy.repository,
    "evidence_repository_mismatch",
  );
  add(failures, !shaPattern.test(evidence.devHeadSha), "dev_head_invalid");
  add(
    failures,
    !exactStrings(evidence.administration.humanAdmins, policy.humanAllowlist),
    "human_admin_authority_mismatch",
  );
  add(
    failures,
    evidence.mergeQueue.maxEntriesToMerge !==
      policy.mergeQueue.maxEntriesToMerge,
    "merge_queue_mismatch",
  );
  add(
    failures,
    evidence.actions.defaultWorkflowPermissions !== "read" ||
      evidence.actions.canApprovePullRequestReviews !== false,
    "actions_permissions_mismatch",
  );
  return failures;
}

function controlFailures(evidence, policy, now) {
  return [
    ...freshnessFailures(evidence, policy, now),
    ...sourceFailures(evidence.sources),
    ...configurationReadFailures(evidence),
    ...repositoryAuthorityFailures(evidence, policy),
    ...identityFailures(evidence, policy, now),
    ...devProtectionFailures(evidence.devProtection, policy),
    ...epicProtectionFailures(evidence.epicProtection, policy),
    ...repositoryControlProbeFailures(
      evidence.probes,
      policy,
      evidence.capturedAt,
      now,
    ),
  ];
}

export function validateRepositoryControls(evidence, policy, now = Date.now()) {
  try {
    const policyFailures = repositoryControlsPolicyFailures(policy);
    if (policyFailures.length > 0) return policyFailures;
    if (unsafeEvidenceValue(evidence)) return ["evidence_secret_or_unbounded"];
    if (!evidenceShapeValid(evidence)) return ["evidence_shape_invalid"];
    const failures = [];
    add(
      failures,
      evidence.schema !== REPOSITORY_CONTROLS_EVIDENCE_SCHEMA,
      "evidence_schema_invalid",
    );
    failures.push(...controlFailures(evidence, policy, now));
    return [...new Set(failures)];
  } catch {
    return ["repository_controls_invalid"];
  }
}
