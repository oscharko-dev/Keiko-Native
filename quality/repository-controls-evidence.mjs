import { BROKER_CAPABILITY_SCHEMA } from "./epic-merge-broker-capability.mjs";
import {
  REPOSITORY_CONTROLS_EVIDENCE_SCHEMA,
  REPOSITORY_CONTROLS_PROBES_SCHEMA,
} from "./repository-controls.mjs";
import { unsafeEvidenceValue } from "./repository-controls-policy.mjs";

function permissionMap(permissions) {
  if (permissions === null || typeof permissions !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(permissions).map(([name, access]) => [name, access]),
  );
}

function repositoryNames(value) {
  return value?.repositories?.map((repository) => repository?.full_name);
}

function appIdentity(value) {
  const appMatchesInstallation =
    Number.isSafeInteger(value?.app?.id) &&
    value.app.id === value?.installation?.app_id;
  return {
    account: value?.installation?.account?.login,
    appId: appMatchesInstallation ? value.app.id : undefined,
    appSlug:
      appMatchesInstallation && value.app.slug === value?.installation?.app_slug
        ? value.app.slug
        : undefined,
    installationId: value?.installation?.id,
    permissions: permissionMap(value?.installation?.permissions),
    repositories: repositoryNames(value?.repositories),
    repositorySelection: value?.installation?.repository_selection,
    suspended: value?.installation?.suspended_at !== null,
  };
}

export function sanitizedRepositoryAppIdentity(value) {
  if (unsafeEvidenceValue(value))
    throw new Error("repository_control_identity_rejected");
  return appIdentity(value);
}

function requiredChecks(value) {
  return value?.required_status_checks?.checks?.map((check) => ({
    appId: check?.app_id,
    context: check?.context,
  }));
}

function rulesetRequiredChecks(rule) {
  return rule?.parameters?.required_status_checks?.map((check) => ({
    appId: check?.integration_id,
    context: check?.context,
  }));
}

function updateAllowlist(protection) {
  return {
    apps: protection?.restrictions?.apps?.map((entry) => ({
      appId: entry?.id,
      appSlug: entry?.slug,
    })),
    teams: protection?.restrictions?.teams?.map((entry) => entry?.slug),
    users: protection?.restrictions?.users?.map((entry) => entry?.login),
  };
}

function devProtection(value) {
  return {
    adminsEnforced: value?.enforce_admins?.enabled,
    branchDeletionAllowed: value?.allow_deletions?.enabled,
    conversationResolutionRequired:
      value?.required_conversation_resolution?.enabled,
    forcePushAllowed: value?.allow_force_pushes?.enabled,
    linearHistoryRequired: value?.required_linear_history?.enabled,
    pullRequestRequired:
      value?.required_pull_request_reviews !== null &&
      typeof value?.required_pull_request_reviews === "object",
    requiredChecks: requiredChecks(value),
    signedCommitsRequired: value?.required_signatures?.enabled,
    strictChecks: value?.required_status_checks?.strict,
    updateAllowlist: updateAllowlist(value),
  };
}

function rulesetRule(ruleset, type) {
  return ruleset?.rules?.find((rule) => rule?.type === type);
}

function bypassActors(ruleset) {
  return ruleset?.bypass_actors?.map(
    (actor) =>
      `${String(actor?.actor_type ?? "unknown")}:${String(
        actor?.actor_id ?? "unknown",
      )}`,
  );
}

function epicProtection(raw) {
  const ruleset = raw?.epicRuleset;
  const statusChecks = rulesetRule(ruleset, "required_status_checks");
  return {
    adminsEnforced: ruleset?.enforcement === "active",
    branchDeletionAllowed: rulesetRule(ruleset, "deletion") === undefined,
    bypassActors: bypassActors(ruleset),
    conversationResolutionRequired:
      rulesetRule(ruleset, "required_conversation_resolution") !== undefined,
    enforcement: ruleset?.enforcement,
    exclude: ruleset?.conditions?.ref_name?.exclude,
    forcePushAllowed: rulesetRule(ruleset, "non_fast_forward") === undefined,
    include: ruleset?.conditions?.ref_name?.include,
    linearHistoryRequired:
      rulesetRule(ruleset, "required_linear_history") !== undefined,
    pullRequestRequired: rulesetRule(ruleset, "pull_request") !== undefined,
    requiredChecks: rulesetRequiredChecks(statusChecks),
    rulesetId: ruleset?.id,
    signedCommitsRequired:
      rulesetRule(ruleset, "required_signatures") !== undefined,
    strictChecks:
      statusChecks?.parameters?.strict_required_status_checks_policy,
    updateAllowlist: updateAllowlist(raw?.epicProtection),
  };
}

export function sanitizedAdministrationProjection(raw) {
  if (unsafeEvidenceValue(raw))
    throw new Error("repository_control_administration_rejected");
  return {
    actions: {
      canApprovePullRequestReviews:
        raw?.actions?.can_approve_pull_request_reviews,
      defaultWorkflowPermissions: raw?.actions?.default_workflow_permissions,
    },
    administration: {
      humanAdmins: raw?.humanPermissions
        ?.filter((entry) => entry?.permission === "admin")
        .map((entry) => entry?.user?.login),
    },
    devHeadSha: raw?.branch?.commit?.sha,
    devProtection: devProtection(raw?.devProtection),
    epicProtection: epicProtection(raw),
    mergeQueue: {
      maxEntriesToMerge: raw?.mergeQueue?.parameters?.max_entries_to_merge,
    },
  };
}

function sanitizedBrokerProbe(probe) {
  if (
    Object.hasOwn(probe ?? {}, "brokerDecisionInput") ||
    Object.hasOwn(probe ?? {}, "signingCapability")
  )
    throw new Error("repository_control_broker_input_rejected");
  return {
    actorAppId: probe?.actorAppId,
    mergeCommitSigned: probe?.mergeCommitSigned,
    observedAt: probe?.observedAt,
    receipt: structuredClone(probe?.receipt),
  };
}

function sanitizedProbeRows(values, fields) {
  if (!Array.isArray(values)) return undefined;
  return values.map((value) =>
    Object.fromEntries(
      fields.map((field) => [field, structuredClone(value?.[field])]),
    ),
  );
}

function sanitizedProbes(probes) {
  return {
    broker: sanitizedBrokerProbe(probes?.broker),
    brokerRejections: sanitizedProbeRows(probes?.brokerRejections, [
      "actorAppId",
      "automationDisabled",
      "base",
      "details",
      "head",
      "issue",
      "issueFence",
      "observedAt",
      "protectedStateUnchanged",
      "pullRequest",
      "repository",
      "requestId",
      "result",
      "scenario",
      "snapshotId",
      "source",
      "target",
      "targetFence",
    ]),
    callerCapabilities: sanitizedProbeRows(probes?.callerCapabilities, [
      "actorAppId",
      "artifact",
      "base",
      "capability",
      "commitSigned",
      "head",
      "issue",
      "observedAt",
      "pullRequest",
      "repository",
      "requestId",
      "result",
      "source",
      "target",
    ]),
    cleanup: {
      artifactsRemaining: probes?.cleanup?.artifactsRemaining,
      observedAt: probes?.cleanup?.observedAt,
      result: probes?.cleanup?.result,
    },
    denials: sanitizedProbeRows(probes?.denials, [
      "actorAppId",
      "attemptedArtifact",
      "attemptedTarget",
      "base",
      "effect",
      "head",
      "issue",
      "issueFence",
      "observedAt",
      "protectedStateUnchanged",
      "pullRequest",
      "repository",
      "requestId",
      "result",
      "snapshotId",
      "source",
      "target",
      "targetFence",
    ]),
    recovery: sanitizedProbeRows(probes?.recovery, [
      "automationDisabled",
      "capabilityReproven",
      "humanReconciled",
      "noRetry",
      "observedAt",
      "result",
      "scenario",
    ]),
    schema:
      probes?.schema === REPOSITORY_CONTROLS_PROBES_SCHEMA
        ? probes.schema
        : probes?.schema,
  };
}

function brokerEvidence(raw, metadata) {
  return {
    app: appIdentity(raw?.broker),
    capturedAt: metadata?.capturedAt,
    credential: {
      callerReadable: metadata?.brokerCredential?.callerReadable,
      custody: metadata?.brokerCredential?.custody,
      expiresAt: metadata?.brokerCredential?.expiresAt,
      kind: metadata?.brokerCredential?.kind,
      ordinaryWorkflowReadable:
        metadata?.brokerCredential?.ordinaryWorkflowReadable,
    },
    protocol: { ...metadata?.protocol },
    repository: metadata?.repository,
    schema: BROKER_CAPABILITY_SCHEMA,
  };
}

function callerEvidence(raw, metadata) {
  return {
    app: appIdentity(raw?.caller),
    credential: {
      agentReadable: metadata?.callerCredential?.agentReadable,
      custody: metadata?.callerCredential?.custody,
      expiresAt: metadata?.callerCredential?.expiresAt,
      kind: metadata?.callerCredential?.kind,
      ordinaryWorkflowReadable:
        metadata?.callerCredential?.ordinaryWorkflowReadable,
    },
  };
}

export function sanitizedRepositoryControlEvidence(raw, metadata) {
  if (unsafeEvidenceValue(raw) || unsafeEvidenceValue(metadata))
    throw new Error("repository_control_evidence_rejected");
  return {
    ...sanitizedAdministrationProjection(raw),
    broker: brokerEvidence(raw, metadata),
    caller: callerEvidence(raw, metadata),
    capturedAt: metadata?.capturedAt,
    configurationReads: structuredClone(metadata?.configurationReads),
    probes: sanitizedProbes(metadata?.probes),
    repository: metadata?.repository,
    schema: REPOSITORY_CONTROLS_EVIDENCE_SCHEMA,
    sources: {
      administration: metadata?.sourceStatuses?.administration,
      broker: metadata?.sourceStatuses?.broker,
      caller: metadata?.sourceStatuses?.caller,
      probes: metadata?.sourceStatuses?.probes,
    },
  };
}
