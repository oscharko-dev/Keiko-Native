import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { githubRequestFor } from "./github-api.mjs";
import {
  LIFECYCLE_STATES,
  planStatusLabelReconciliation,
  validateTransitionRequest,
  validateProviderStatusLabels,
  verifyStatusLabelReadback,
} from "./issue-lifecycle.mjs";
import { evaluateCurrentReadiness } from "./issue-lifecycle-readiness.mjs";
import { semanticIssueFingerprint } from "./issue-contract.mjs";

const lifecycleActivationEnabled = "enabled";
const githubRequest = githubRequestFor("keiko-native-issue-lifecycle");

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
  return event?.issue?.number;
}

function labelRequestTarget(event) {
  const label = event?.label?.name;
  if (event?.action !== "labeled" || !label?.startsWith("status: "))
    return undefined;
  return label;
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

function desiredStateForEvent(event, readiness, currentState) {
  const requestedTarget = labelRequestTarget(event);
  if (requestedTarget !== undefined) {
    const failures = transitionRequestFailures(
      event,
      currentState,
      requestedTarget,
    );
    return failures.length > 0
      ? { failures, outcome: "failed" }
      : { desiredState: requestedTarget };
  }
  if (event?.action === "reopened") return LIFECYCLE_STATES[0];
  if (event?.action === "closed" && event.issue?.state_reason === "completed")
    return LIFECYCLE_STATES[8];
  if (event?.action === "edited" && readiness.current !== true)
    return LIFECYCLE_STATES[0];
  return undefined;
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
  if (issue?.number !== issueNumber || typeof issue?.title !== "string")
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
  if (!providerValidation.ok)
    return { failures: providerValidation.failures, outcome: "failed" };
  if (statusLabels(issue).length !== 1)
    return {
      failures: [
        "Issue lifecycle reload must contain exactly one status label.",
      ],
      outcome: "failed",
    };
  const currentState = statusLabels(issue)[0];

  const readiness = evaluateCurrentReadiness({
    comments,
    currentFingerprint: semanticIssueFingerprint(issue.body ?? "", issue.title),
    currentVersion: /^- Contract version: `([^`]+)`$/mu.exec(
      issue.body ?? "",
    )?.[1],
    event:
      event.action === "edited"
        ? { action: "edited", editKind: event.editKind ?? "unknown" }
        : { action: event.action },
    expectedCommentId: event.expectedReadinessCommentId,
  });
  const desired = desiredStateForEvent(event, readiness, currentState);
  if (desired?.outcome === "failed") return desired;
  const desiredState =
    typeof desired === "string" ? desired : desired?.desiredState;
  if (desiredState === undefined)
    return { failures: [], outcome: "ignored", readiness };

  const reconciliation = planStatusLabelReconciliation(
    labelNames(issue),
    desiredState,
  );
  if (!reconciliation.ok)
    return { failures: reconciliation.failures, outcome: "failed" };
  const enabled =
    process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION === lifecycleActivationEnabled;
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
    actualIssueIdentity: readback.node_id ?? String(readback.id),
    desiredState,
    expectedIssueIdentity: issue.node_id ?? String(issue.id),
    labels: labelNames(readback),
  });
  return verified.ok
    ? { desiredState, outcome: "applied", plan: reconciliation }
    : { failures: verified.failures, outcome: "failed" };
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
