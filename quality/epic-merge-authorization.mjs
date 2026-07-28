import { isDeepStrictEqual } from "node:util";

import {
  EPIC_MERGE_REPOSITORY,
  isEpicMergeCommit,
} from "./epic-merge-policy.mjs";

const positive = (value) => Number.isSafeInteger(value) && value > 0;
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).toSorted(), keys.toSorted());

function requiredResultsCurrent(snapshot, policy) {
  if (
    !Array.isArray(snapshot.checks) ||
    snapshot.evidence === null ||
    typeof snapshot.evidence !== "object" ||
    Array.isArray(snapshot.evidence)
  )
    return false;
  const pullRequest = snapshot.pullRequest;
  return (
    policy.requiredChecks.every(({ context, producer }) => {
      const matches = snapshot.checks.filter(
        (check) => check?.context === context && check.producer === producer,
      );
      return (
        matches.length === 1 &&
        matches[0].status === "completed" &&
        matches[0].conclusion === "success" &&
        matches[0].head === pullRequest.head &&
        matches[0].base === pullRequest.base
      );
    }) &&
    policy.requiredEvidence.every(({ name, producer }) => {
      const evidence = snapshot.evidence[name];
      return (
        evidence?.producer === producer &&
        evidence.current === true &&
        evidence.complete === true &&
        evidence.head === pullRequest.head
      );
    })
  );
}

function checkAssociationCurrent(check, pullRequest) {
  if (!Array.isArray(check?.pull_requests)) return false;
  if (check.pull_requests.length === 0) return true;
  const matches = check.pull_requests.filter(
    (association) => association?.number === pullRequest?.number,
  );
  return (
    matches.length === 1 &&
    matches[0]?.base?.sha === pullRequest?.base?.sha &&
    matches[0]?.head?.sha === pullRequest?.head?.sha
  );
}

function checkRuns(checks, pullRequest) {
  const valid = checks.items.every(
    (check) =>
      checkAssociationCurrent(check, pullRequest) &&
      check?.head_sha === pullRequest?.head?.sha &&
      Number.isSafeInteger(check?.id) &&
      check.id > 0 &&
      typeof check?.name === "string" &&
      typeof check?.app?.slug === "string" &&
      Number.isSafeInteger(check?.app?.id),
  );
  return {
    items: checks.items.map((check) => ({
      base: valid ? pullRequest.base.sha : null,
      conclusion: check?.conclusion,
      context: check?.name,
      head: check?.head_sha,
      producer:
        typeof check?.app?.slug === "string" &&
        Number.isSafeInteger(check?.app?.id)
          ? `${check.app.slug}@${String(check.app.id)}`
          : null,
      resultId: check?.id,
      status: check?.status,
    })),
    valid,
  };
}

function statusProducer(status) {
  const creator = status?.creator;
  return creator?.type === "Bot" &&
    typeof creator.login === "string" &&
    Number.isSafeInteger(creator.id) &&
    creator.id > 0
    ? `${creator.login}@${String(creator.id)}`
    : null;
}

function commitStatuses(statuses, pullRequest) {
  let previous = Number.POSITIVE_INFINITY;
  const identities = new Set();
  const latest = [];
  let valid = true;
  for (const status of statuses.items) {
    const producer = statusProducer(status);
    const id = status?.id;
    const identity = `${status?.context}\0${producer}`;
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      id >= previous ||
      typeof status?.context !== "string" ||
      producer === null ||
      !["error", "failure", "pending", "success"].includes(status?.state) ||
      !(status?.sha === null || status?.sha === pullRequest?.head?.sha)
    )
      valid = false;
    previous = id;
    if (identities.has(identity)) continue;
    identities.add(identity);
    latest.push(status);
  }
  return {
    items: latest.map((status) => ({
      base: pullRequest?.base?.sha,
      conclusion:
        status.state === "success"
          ? "success"
          : status.state === "pending"
            ? null
            : "failure",
      context: status.context,
      head: pullRequest?.head?.sha,
      producer: statusProducer(status),
      resultId: status.id,
      status: status.state === "pending" ? "in_progress" : "completed",
    })),
    valid,
  };
}

export function normalizeEpicMergeResults(checks, statuses, pullRequest) {
  const runs = checkRuns(checks, pullRequest);
  const commits = commitStatuses(statuses, pullRequest);
  return {
    items: [...runs.items, ...commits.items],
    valid: runs.valid && commits.valid,
  };
}

export function epicMergePullResponseCurrent(
  raw,
  pullRequest,
  requireEligibility = true,
) {
  return (
    raw?.number === pullRequest &&
    ["closed", "open"].includes(raw.state) &&
    (!requireEligibility ||
      (typeof raw.draft === "boolean" &&
        typeof raw.mergeable === "boolean" &&
        typeof raw.body === "string")) &&
    typeof raw.base?.ref === "string" &&
    isEpicMergeCommit(raw.base.sha) &&
    typeof raw.head?.ref === "string" &&
    isEpicMergeCommit(raw.head.sha)
  );
}

export function epicMergeFindingCurrent(item, pullRequest) {
  const state = item?.state;
  const dismissed =
    state === "dismissed" &&
    typeof item.dismissed_at === "string" &&
    typeof item.dismissed_by?.login === "string" &&
    ["false positive", "used in tests", "won't fix"].includes(
      item.dismissed_reason,
    );
  const notDismissed =
    ["fixed", "open"].includes(state) &&
    item?.dismissed_at === null &&
    item.dismissed_by === null &&
    item.dismissed_reason === null;
  return (
    positive(item?.number) &&
    item?.most_recent_instance?.ref ===
      `refs/pull/${String(pullRequest)}/merge` &&
    (dismissed || notDismissed)
  );
}

export function epicMergeAuthorizationCurrent(snapshot, request, policy) {
  const issue = snapshot?.issue;
  const pullRequest = snapshot?.pullRequest;
  const readiness = issue?.readiness;
  return [
    snapshot?.repository === EPIC_MERGE_REPOSITORY,
    issue?.number === request.issue,
    issue?.open === true,
    issue?.lifecycle === "status: ready for human review",
    /^epic\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(issue?.target ?? ""),
    readiness?.accepted === true,
    readiness?.current === true,
    /^v[1-9][0-9]*$/u.test(readiness?.version ?? ""),
    /^[0-9a-f]{64}$/u.test(readiness?.fingerprint ?? ""),
    readiness?.producer === "github-actions[bot]",
    readiness?.producerId === 41898282,
    positive(readiness?.commentId),
    pullRequest?.number === request.pullRequest,
    pullRequest?.issue === request.issue,
    pullRequest?.open === true,
    pullRequest?.draft === false,
    pullRequest?.mergeable === true,
    pullRequest?.target === issue?.target,
    isEpicMergeCommit(pullRequest?.head),
    isEpicMergeCommit(pullRequest?.base),
    isEpicMergeCommit(pullRequest?.headTree),
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(pullRequest?.source ?? ""),
    snapshot?.pagination?.complete === true,
    snapshot?.pagination?.truncated === false,
    snapshot?.findings?.complete === true,
    snapshot?.findings?.blocking === 0,
    snapshot?.conversations?.complete === true,
    snapshot?.conversations?.unresolved === 0,
    requiredResultsCurrent(snapshot, policy),
  ].every(Boolean);
}

export function epicMergeProtectionCurrent(snapshot, authorization) {
  if (
    !exactKeys(snapshot, [
      "authorization",
      "base",
      "current",
      "pagination",
      "repository",
      "rules",
      "target",
    ]) ||
    snapshot.repository !== EPIC_MERGE_REPOSITORY ||
    snapshot.target !== authorization.issue.target ||
    snapshot.base !== authorization.pullRequest.base ||
    snapshot.current !== true ||
    !exactKeys(snapshot.authorization, ["bypass", "merge", "source"]) ||
    snapshot.authorization.merge !== true ||
    snapshot.authorization.bypass !== false ||
    snapshot.authorization.source !== "repository-permission" ||
    !exactKeys(snapshot.pagination, ["complete", "truncated"]) ||
    snapshot.pagination.complete !== true ||
    snapshot.pagination.truncated !== false ||
    !Array.isArray(snapshot.rules) ||
    snapshot.rules.length === 0
  )
    return false;
  for (const rule of snapshot.rules) {
    if (
      !exactKeys(rule, [
        "bypassActors",
        "controls",
        "enforcement",
        "id",
        "target",
      ]) ||
      !positive(rule.id) ||
      rule.enforcement !== "active" ||
      rule.target !== authorization.issue.target ||
      !Array.isArray(rule.bypassActors) ||
      rule.bypassActors.length !== 0 ||
      !exactKeys(rule.controls, [
        "deletionBlocked",
        "forcePushBlocked",
        "pullRequestRequired",
        "requiredSignatures",
        "requiredStatusChecks",
      ]) ||
      rule.controls.deletionBlocked !== true ||
      rule.controls.forcePushBlocked !== true ||
      rule.controls.pullRequestRequired !== true ||
      rule.controls.requiredSignatures !== true ||
      !exactKeys(rule.controls.requiredStatusChecks, ["strict"]) ||
      rule.controls.requiredStatusChecks.strict !== true
    )
      return false;
  }
  return true;
}

export function epicMergeManifestMatches(operation, authorization) {
  const pullRequest = authorization.pullRequest;
  return (
    operation.issue === authorization.issue.number &&
    operation.pullRequest === pullRequest.number &&
    operation.target === authorization.issue.target &&
    operation.head === pullRequest.head &&
    operation.base === pullRequest.base
  );
}
