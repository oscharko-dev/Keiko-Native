import { acceptedEpicMergeEffectFromReceipt } from "./epic-merge-broker-receipt.mjs";
import {
  exactKeys,
  exactStrings,
  positiveInteger,
  record,
  text,
} from "./repository-controls-policy.mjs";

const digestPattern = /^[0-9a-f]{64}$/u;
const sourcePattern = /^codex\/[a-z0-9][a-z0-9/-]{0,127}$/u;
export const callerCapabilities = Object.freeze([
  "branch",
  "issue",
  "lifecycle_request",
  "pull_request",
]);

const observedAt = (value) => text(value) && Number.isFinite(Date.parse(value));
const issueNumber = (identity) => {
  const match = /^issue-([1-9]\d*)$/u.exec(identity ?? "");
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

export function brokerEffect(probe, policy) {
  if (
    !exactKeys(probe, [
      "actorAppId",
      "mergeCommitSigned",
      "observedAt",
      "receipt",
    ]) ||
    probe.actorAppId !== policy.identities.broker.appId ||
    probe.mergeCommitSigned !== true ||
    !observedAt(probe.observedAt)
  )
    return undefined;
  const effect = acceptedEpicMergeEffectFromReceipt(
    probe.receipt,
    policy.identities.broker.receiptVerificationKey,
    policy.identities.broker.receiptVerificationKeyFingerprint,
  );
  if (
    effect?.repository !== policy.repository ||
    effect?.target !== policy.epic.probeTarget ||
    !sourcePattern.test(effect?.source ?? "") ||
    issueNumber(effect?.issueIdentity) === undefined
  )
    return undefined;
  return effect;
}

const commonKeys = Object.freeze([
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
]);

function callerCoordinateValid(row, effect, policy) {
  return (
    exactKeys(row, commonKeys) &&
    row.actorAppId === policy.identities.caller.appId &&
    row.repository === effect.repository &&
    row.issue === issueNumber(effect.issueIdentity) &&
    digestPattern.test(row.requestId) &&
    observedAt(row.observedAt) &&
    row.result === "accepted"
  );
}

function callerRowValid(row, effect, policy) {
  if (!callerCoordinateValid(row, effect, policy)) return false;
  const active = ["branch", "pull_request"].includes(row.capability);
  if (
    row.commitSigned !== (active ? true : "not_applicable") ||
    (active
      ? row.base !== effect.base ||
        row.head !== effect.head ||
        row.source !== effect.source ||
        row.target !== effect.target
      : ![row.base, row.head, row.source, row.target].every(
          (value) => value === null,
        ))
  )
    return false;
  const artifacts = {
    branch: `refs/heads/${effect.source}`,
    issue: `issues/${String(row.issue)}`,
    lifecycle_request: `issues/${String(row.issue)}#lifecycle`,
    pull_request: `pulls/${String(effect.pullRequest)}`,
  };
  return (
    row.artifact === artifacts[row.capability] &&
    row.pullRequest ===
      (row.capability === "pull_request" ? effect.pullRequest : null)
  );
}

export function callerProbeInvalid(probes, effect, policy) {
  const rows = probes.callerCapabilities;
  return (
    !exactRows(rows, callerCapabilities, "capability", (row) =>
      callerRowValid(row, effect, policy),
    ) || new Set(rows?.map((row) => row.requestId)).size !== rows?.length
  );
}
