import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { githubRequestFor } from "./github-api.mjs";
import { pullRequestIssueNumber } from "./pr-contract.mjs";
import {
  LIFECYCLE_STATES,
  planStatusLabelReconciliation,
  validateTransitionRequest,
  validateProviderStatusLabels,
  verifyStatusLabelReadback,
} from "./issue-lifecycle.mjs";
import {
  evaluateClaimPrecondition,
  evaluateClaimRelease,
  evaluateClosurePrecondition,
  evaluateCurrentReadiness,
  evaluatePullRequestTopology,
} from "./issue-lifecycle-readiness.mjs";
import { semanticIssueFingerprint } from "./issue-contract.mjs";

const lifecycleActivationEnabled = "enabled";
const githubRequest = githubRequestFor("keiko-native-issue-lifecycle");
const READY = LIFECYCLE_STATES[2];

function labelNames(issue) {
  return Array.isArray(issue?.labels)
    ? issue.labels.map((label) =>
        typeof label === "string" ? label : label?.name,
      )
    : undefined;
}

function statusLabels(issue) {
  return (labelNames(issue) ?? []).filter((name) =>
    name?.startsWith("status: "),
  );
}

function eventIssueNumber(event) {
  return (
    event?.issue?.number ?? pullRequestIssueNumber(event?.pull_request?.body)
  );
}

function labelRequestTarget(event) {
  const label = event?.label?.name;
  if (event?.action !== "labeled" || !label?.startsWith("status: "))
    return undefined;
  return label;
}

function hasTransitionRequest(event) {
  return (
    event?.transitionRequest !== undefined &&
    event.transitionRequest !== null &&
    typeof event.transitionRequest === "object"
  );
}

function transitionRequestFailures(event, currentState, requestedTarget) {
  const transition = event?.transitionRequest ?? {};
  return validateTransitionRequest({
    actorRole: transition.actorRole,
    blockingCondition: transition.blockingCondition,
    currentState,
    eventIdentity: transition.eventIdentity,
    humanInput: transition.humanInput,
    requestedSource: transition.requestedSource ?? currentState,
    requestedTarget,
  }).failures;
}

function currentLifecycleState(issue, event) {
  const states = statusLabels(issue);
  const requestedSource = event?.transitionRequest?.requestedSource;
  return states.includes(requestedSource) ? requestedSource : states[0];
}

function hasSoleLifecycleState(issue, state) {
  const states = statusLabels(issue);
  return states.length === 1 && states[0] === state;
}

function assignedLogins(issue) {
  return new Set(
    (Array.isArray(issue?.assignees) ? issue.assignees : [])
      .map((assignee) => assignee?.login)
      .filter((login) => typeof login === "string" && login.trim() !== ""),
  );
}

function derivedAssignmentClaim(event, issue) {
  const actor = event?.sender?.login;
  const assignee = event?.assignee?.login;
  if (typeof actor !== "string" || typeof assignee !== "string")
    return undefined;
  if (!assignedLogins(issue).has(assignee)) return undefined;
  return {
    id: `${issueIdentity(issue)}:assignment:${assignee}`,
    validated: true,
  };
}

function derivedAssignmentRelease(event, issue) {
  const actor = event?.sender?.login;
  const assignee = event?.assignee?.login;
  if (typeof actor !== "string" || typeof assignee !== "string")
    return undefined;
  if (assignedLogins(issue).has(assignee)) return undefined;
  return {
    id: `${issueIdentity(issue)}:assignment-release:${assignee}`,
    validated: true,
  };
}

function pullRequestIdentity(pullRequest) {
  if (
    typeof pullRequest?.node_id === "string" &&
    pullRequest.node_id.trim() !== ""
  )
    return pullRequest.node_id;
  if (
    Number.isInteger(pullRequest?.id) ||
    (typeof pullRequest?.id === "string" && pullRequest.id.trim() !== "")
  )
    return String(pullRequest.id);
  return undefined;
}

function pullRequestEvidence(event, issueNumber) {
  const pullRequest = event?.pull_request;
  const id = pullRequestIdentity(pullRequest);
  const headSha = pullRequest?.head?.sha;
  return {
    id,
    validated:
      id !== undefined &&
      pullRequestIssueNumber(pullRequest?.body) === issueNumber &&
      /^[0-9a-f]{40}$/u.test(headSha ?? ""),
  };
}

function pullRequestLifecycleEvent(event) {
  if (event?.pull_request === undefined) return undefined;
  if (["opened", "reopened"].includes(event.action)) return event.action;
  if (
    ["synchronize", "ready_for_review", "converted_to_draft"].includes(
      event.action,
    )
  )
    return "opened";
  if (event.action === "closed" && event.pull_request?.merged !== true)
    return "closed_unmerged";
  return undefined;
}

function unauthorizedRawLabelResult(enabled) {
  return enabled
    ? {
        failures: [
          "Lifecycle label events require explicit transition authority.",
        ],
        outcome: "failed",
      }
    : { outcome: "ignored", reason: "raw_lifecycle_label_event" };
}

function desiredStateForLabelEvent(event, currentState, enabled, readiness) {
  const requestedTarget = labelRequestTarget(event);
  if (requestedTarget === undefined) return undefined;
  if (!hasTransitionRequest(event)) return unauthorizedRawLabelResult(enabled);
  const failures = [
    ...transitionRequestFailures(event, currentState, requestedTarget),
  ];
  if (requestedTarget === READY && readiness.current !== true)
    failures.push("current_readiness_required");
  return failures.length > 0
    ? { failures, outcome: "failed" }
    : { desiredState: requestedTarget };
}

function desiredStateForClosure(event, issue) {
  if (event?.action !== "closed") return undefined;
  if (issue?.state !== "closed")
    return { failures: ["current_closed_state_required"], outcome: "failed" };
  const closure = evaluateClosurePrecondition({
    completionEvidence: {
      validated: hasSoleLifecycleState(issue, LIFECYCLE_STATES[5]),
    },
    reason: issue.state_reason,
  });
  if (!closure.ok) return { failures: [closure.reason], outcome: "failed" };
  return closure.removeLifecycleLabels === true
    ? { removeLifecycleLabels: true }
    : { desiredState: closure.target };
}

function inertMissingAuthorityResult(reason, enabled) {
  return enabled ? { failures: [reason], outcome: "failed" } : undefined;
}

function desiredStateForClaimEvent(
  event,
  readiness,
  currentState,
  enabled,
  issue,
) {
  if (event?.action === "assigned") {
    const claim = event.claim ?? derivedAssignmentClaim(event, issue);
    const result = evaluateClaimPrecondition({
      claim,
      readiness,
      sourceState: currentState,
    });
    if (result.ok) return { desiredState: result.target };
    return claim === undefined
      ? inertMissingAuthorityResult(result.reason, enabled)
      : { failures: [result.reason], outcome: "failed" };
  }
  if (event?.action === "unassigned") {
    const release = event.release ?? derivedAssignmentRelease(event, issue);
    const result = evaluateClaimRelease({
      hasOpenPullRequest: event.hasOpenPullRequest,
      readiness,
      release,
      sourceState: currentState,
    });
    if (result.ok) return { desiredState: result.target };
    return release === undefined
      ? inertMissingAuthorityResult(result.reason, enabled)
      : { failures: [result.reason], outcome: "failed" };
  }
  return undefined;
}

function desiredStateForPullRequestEvent({
  currentState,
  enabled,
  event,
  issueNumber,
  readiness,
}) {
  const prEvent = pullRequestLifecycleEvent(event);
  if (prEvent === undefined) return undefined;
  const result = evaluatePullRequestTopology({
    claim: event.claim,
    event: prEvent,
    otherOpenPullRequest: event.otherOpenPullRequest,
    pullRequest: pullRequestEvidence(event, issueNumber),
    readiness,
    sourceState: currentState,
  });
  if (result.ok) return { desiredState: result.target };
  if (
    !enabled &&
    currentState === READY &&
    result.reason === "lifecycle_edge_not_allowed"
  )
    return { outcome: "ignored", reason: "pre_activation_pr_ready_source" };
  return { failures: [result.reason], outcome: "failed" };
}

function desiredStateForEvent(
  event,
  readiness,
  currentState,
  enabled,
  issue,
  issueNumber,
) {
  if (event?.pull_request !== undefined)
    return (
      desiredStateForPullRequestEvent({
        currentState,
        enabled,
        event,
        issueNumber,
        readiness,
      }) ?? {}
    );
  if (event?.action === "reopened")
    return { desiredState: LIFECYCLE_STATES[0] };
  if (event?.action === "edited" && readiness.current !== true)
    return { desiredState: LIFECYCLE_STATES[0] };
  return (
    desiredStateForLabelEvent(event, currentState, enabled, readiness) ??
    desiredStateForClaimEvent(event, readiness, currentState, enabled, issue) ??
    desiredStateForClosure(event, issue) ??
    {}
  );
}

function failed(failures) {
  return { failures, outcome: "failed" };
}

async function allIssueComments(repository, issueNumber, request) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(
      `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch))
      throw new Error("Issue comments response is malformed.");
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

async function allProviderLabels(repository, request) {
  const labels = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(
      `/repos/${repository}/labels?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch))
      throw new Error("Provider labels response is malformed.");
    labels.push(...batch.map((label) => label?.name));
    if (batch.length < 100) return labels;
  }
}

async function reloadIssue(repository, issueNumber, request) {
  const issue = await request(`/repos/${repository}/issues/${issueNumber}`);
  if (
    issue?.number !== issueNumber ||
    typeof issue?.title !== "string" ||
    issueIdentity(issue) === undefined
  )
    throw new Error("Reloaded issue response is malformed.");
  return issue;
}

async function removeLabel(repository, issueNumber, label, request) {
  await request(
    `/repos/${repository}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    { method: "DELETE" },
  );
}

async function addLabels(repository, issueNumber, labels, request) {
  if (labels.length === 0) return;
  await request(`/repos/${repository}/issues/${issueNumber}/labels`, {
    method: "POST",
    payload: { labels },
  });
}

function planLifecycleLabelRemoval(issue) {
  const labels = labelNames(issue);
  if (!Array.isArray(labels))
    return {
      apply: [],
      failures: ["Issue lifecycle labels are unavailable."],
      ok: false,
      remove: [],
    };
  return {
    apply: [],
    failures: [],
    ok: true,
    remove: labels.filter((name) => name?.startsWith("status: ")),
  };
}

function verifyLifecycleLabelRemoval({
  actualIssueIdentity,
  expectedIssueIdentity,
  labels,
}) {
  const failures = [];
  if (actualIssueIdentity !== expectedIssueIdentity)
    failures.push("Issue identity changed during lifecycle reconciliation.");
  if (!Array.isArray(labels))
    failures.push("Issue lifecycle read-back labels are unavailable.");
  const remaining = Array.isArray(labels)
    ? labels.filter((name) => name?.startsWith("status: "))
    : [];
  if (remaining.length > 0)
    failures.push("Issue lifecycle read-back still contains status labels.");
  return failures.length === 0 ? { ok: true } : { failures, ok: false };
}

function issueIdentity(issue) {
  if (typeof issue?.node_id === "string" && issue.node_id.trim() !== "")
    return issue.node_id;
  if (
    Number.isInteger(issue?.id) ||
    (typeof issue?.id === "string" && issue.id.trim() !== "")
  )
    return String(issue.id);
  return undefined;
}

function readinessEvent(event) {
  if (event?.pull_request !== undefined) return { action: "pull_request" };
  return event.action === "edited"
    ? { action: "edited", editKind: event.editKind ?? "unknown" }
    : { action: event.action };
}

function evaluateReadinessForIssue({ comments, event, issue }) {
  return evaluateCurrentReadiness({
    comments,
    currentFingerprint: semanticIssueFingerprint(issue.body ?? "", issue.title),
    currentVersion: /^- Contract version: `([^`]+)`$/mu.exec(
      issue.body ?? "",
    )?.[1],
    event: readinessEvent(event),
    expectedCommentId: event.expectedReadinessCommentId,
  });
}

function enabledLifecycleActivation() {
  return (
    process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION === lifecycleActivationEnabled
  );
}

function ignoredDesiredResult(desired, readiness) {
  if (desired?.outcome !== "ignored") return undefined;
  return {
    failures: [],
    outcome: "ignored",
    readiness,
    reason: desired.reason,
  };
}

function exactLifecycleLabelFailure(issue) {
  return statusLabels(issue).length === 1
    ? undefined
    : failed(["Issue lifecycle reload must contain exactly one status label."]);
}

async function reconcileLifecycleRemoval({
  enabled,
  issue,
  issueNumber,
  now,
  readiness,
  repository,
  request,
}) {
  const reconciliation = planLifecycleLabelRemoval(issue);
  if (!reconciliation.ok) return failed(reconciliation.failures);
  if (!enabled)
    return {
      activation: "disabled",
      now: now.toISOString(),
      outcome: "planned",
      plan: reconciliation,
      readiness,
      removeLifecycleLabels: true,
    };
  for (const label of reconciliation.remove)
    await removeLabel(repository, issueNumber, label, request);
  const readback = await reloadIssue(repository, issueNumber, request);
  const verified = verifyLifecycleLabelRemoval({
    actualIssueIdentity: issueIdentity(readback),
    expectedIssueIdentity: issueIdentity(issue),
    labels: labelNames(readback),
  });
  return verified.ok
    ? { outcome: "applied", plan: reconciliation, removeLifecycleLabels: true }
    : failed(verified.failures);
}

async function reconcileDesiredStatus({
  desiredState,
  enabled,
  issue,
  issueNumber,
  now,
  readiness,
  repository,
  request,
}) {
  if (desiredState === undefined) {
    const labelFailure = exactLifecycleLabelFailure(issue);
    if (labelFailure !== undefined) return labelFailure;
    return { failures: [], outcome: "ignored", readiness };
  }

  const reconciliation = planStatusLabelReconciliation(
    labelNames(issue),
    desiredState,
  );
  if (!reconciliation.ok) return failed(reconciliation.failures);
  if (!enabled)
    return {
      activation: "disabled",
      desiredState,
      now: now.toISOString(),
      outcome: "planned",
      plan: reconciliation,
      readiness,
    };

  for (const label of reconciliation.remove)
    await removeLabel(repository, issueNumber, label, request);
  await addLabels(repository, issueNumber, reconciliation.apply, request);
  const readback = await reloadIssue(repository, issueNumber, request);
  const verified = verifyStatusLabelReadback({
    actualIssueIdentity: issueIdentity(readback),
    desiredState,
    expectedIssueIdentity: issueIdentity(issue),
    labels: labelNames(readback),
  });
  return verified.ok
    ? { desiredState, outcome: "applied", plan: reconciliation }
    : failed(verified.failures);
}

export async function runIssueLifecycleAction({
  event,
  now = new Date(),
  request = githubRequest,
} = {}) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (typeof repository !== "string" || !repository.includes("/"))
    throw new Error("GITHUB_REPOSITORY is missing or invalid.");
  if (event?.issue?.pull_request !== undefined)
    return { outcome: "ignored", reason: "pull_request_issue" };
  const issueNumber = eventIssueNumber(event);
  if (!Number.isInteger(issueNumber))
    throw new Error("Issue number is missing.");

  const [issue, comments, providerLabels] = await Promise.all([
    reloadIssue(repository, issueNumber, request),
    allIssueComments(repository, issueNumber, request),
    allProviderLabels(repository, request),
  ]);
  const providerValidation = validateProviderStatusLabels(providerLabels);
  if (!providerValidation.ok) return failed(providerValidation.failures);
  const currentState = currentLifecycleState(issue, event);

  const readiness = evaluateReadinessForIssue({
    comments,
    event,
    issue,
  });
  const enabled = enabledLifecycleActivation();
  const desired = desiredStateForEvent(
    event,
    readiness,
    currentState,
    enabled,
    issue,
    issueNumber,
  );
  if (desired?.outcome === "failed") return desired;
  const ignored = ignoredDesiredResult(desired, readiness);
  if (ignored !== undefined) return ignored;
  if (desired.removeLifecycleLabels === true)
    return reconcileLifecycleRemoval({
      enabled,
      issue,
      issueNumber,
      now,
      readiness,
      repository,
      request,
    });
  return reconcileDesiredStatus({
    desiredState: desired.desiredState,
    enabled,
    issue,
    issueNumber,
    now,
    readiness,
    repository,
    request,
  });
}

export async function runIssueLifecycleCli({
  eventPath = process.env.GITHUB_EVENT_PATH,
  output = process.stdout,
  request = githubRequest,
} = {}) {
  if (typeof eventPath !== "string" || eventPath.trim() === "")
    throw new Error("GITHUB_EVENT_PATH is missing.");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const result = await runIssueLifecycleAction({ event, request });
  output.write(`issue-lifecycle: ${result.outcome}\n`);
  if (result.outcome === "failed")
    throw new Error(`Issue lifecycle failed: ${result.failures.join("; ")}`);
  return result;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runIssueLifecycleCli();
}
