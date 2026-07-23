import {
  exactKeys,
  exactStrings,
  positiveInteger,
  record,
  text,
} from "./repository-controls-policy.mjs";

const digestPattern = /^[0-9a-f]{64}$/u;
export const denialEffects = Object.freeze([
  "broker_broader_target",
  "broker_dev_administration",
  "broker_dev_auto_merge",
  "broker_dev_bypass",
  "broker_dev_enqueue",
  "broker_dev_merge",
  "broker_dev_update",
  "broker_environments",
  "broker_maintainer_impersonation",
  "broker_secrets",
  "caller_broker_credential",
  "caller_broader_target",
  "caller_dev_administration",
  "caller_dev_auto_merge",
  "caller_dev_bypass",
  "caller_dev_enqueue",
  "caller_dev_merge",
  "caller_dev_update",
  "caller_direct_merge",
  "caller_environments",
  "caller_maintainer_impersonation",
  "caller_secrets",
  "caller_wrong_branch",
  "caller_wrong_issue",
  "caller_wrong_lifecycle_request",
  "caller_wrong_pull_request",
]);

const observedAt = (value) => text(value) && Number.isFinite(Date.parse(value));
const issueNumber = (identity) => {
  const match = /^issue-([1-9][0-9]*)$/u.exec(identity ?? "");
  const value = match ? Number(match[1]) : undefined;
  return positiveInteger(value) ? value : undefined;
};

function exactRows(values, names, nameKey, valid) {
  return (
    Array.isArray(values) &&
    values.every(
      (value) => record(value) && text(value[nameKey]) && valid(value),
    ) &&
    exactStrings(
      values.map((value) => value[nameKey]),
      names,
    )
  );
}

const denialKeys = Object.freeze([
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
]);

const devEffect = /^((?:broker|caller)_dev_)(.+)$/u;

export function denialAttemptForEffect(name, effect) {
  const dev = devEffect.exec(name);
  if (dev)
    return {
      attemptedArtifact: `refs/heads/dev#${dev[2]}`,
      attemptedTarget: "dev",
    };
  const issue = issueNumber(effect.issueIdentity);
  const attempts = {
    broker_broader_target: {
      attemptedArtifact: "refs/heads/epic/**",
      attemptedTarget: "epic/**",
    },
    broker_environments: {
      attemptedArtifact: "repository/environments",
      attemptedTarget: null,
    },
    broker_maintainer_impersonation: {
      attemptedArtifact: "maintainers/impersonation",
      attemptedTarget: null,
    },
    broker_secrets: {
      attemptedArtifact: "repository/secrets",
      attemptedTarget: null,
    },
    caller_broker_credential: {
      attemptedArtifact: "broker/credential",
      attemptedTarget: null,
    },
    caller_broader_target: {
      attemptedArtifact: "refs/heads/epic/**",
      attemptedTarget: "epic/**",
    },
    caller_direct_merge: {
      attemptedArtifact: `pulls/${String(effect.pullRequest)}/merge`,
      attemptedTarget: effect.target,
    },
    caller_environments: {
      attemptedArtifact: "repository/environments",
      attemptedTarget: null,
    },
    caller_maintainer_impersonation: {
      attemptedArtifact: "maintainers/impersonation",
      attemptedTarget: null,
    },
    caller_secrets: {
      attemptedArtifact: "repository/secrets",
      attemptedTarget: null,
    },
    caller_wrong_branch: {
      attemptedArtifact: "refs/heads/codex/wrong-branch",
      attemptedTarget: effect.target,
    },
    caller_wrong_issue: {
      attemptedArtifact: `issues/${String(issue + 1)}`,
      attemptedTarget: null,
    },
    caller_wrong_lifecycle_request: {
      attemptedArtifact: `issues/${String(issue + 1)}#lifecycle`,
      attemptedTarget: null,
    },
    caller_wrong_pull_request: {
      attemptedArtifact: `pulls/${String(effect.pullRequest + 1)}`,
      attemptedTarget: effect.target,
    },
  };
  return attempts[name];
}

function denialRowValid(row, effect, policy) {
  const broker = row.effect.startsWith("broker_");
  const expectedActor = broker
    ? policy.identities.broker.appId
    : policy.identities.caller.appId;
  const attempt = denialAttemptForEffect(row.effect, effect);
  return (
    exactKeys(row, denialKeys) &&
    attempt !== undefined &&
    row.actorAppId === expectedActor &&
    row.attemptedArtifact === attempt.attemptedArtifact &&
    row.attemptedTarget === attempt.attemptedTarget &&
    row.base === effect.base &&
    row.head === effect.head &&
    row.issue === issueNumber(effect.issueIdentity) &&
    row.issueFence === effect.issueFence &&
    observedAt(row.observedAt) &&
    row.protectedStateUnchanged === true &&
    row.pullRequest === effect.pullRequest &&
    row.repository === effect.repository &&
    digestPattern.test(row.requestId) &&
    row.result === "denied" &&
    row.snapshotId === effect.snapshotId &&
    row.source === effect.source &&
    row.target === effect.target &&
    row.targetFence === effect.targetFence
  );
}

export function denialProbeInvalid(probes, effect, policy) {
  const rows = probes.denials;
  return (
    !exactRows(rows, denialEffects, "effect", (row) =>
      denialRowValid(row, effect, policy),
    ) || new Set(rows?.map((row) => row.requestId)).size !== rows?.length
  );
}
