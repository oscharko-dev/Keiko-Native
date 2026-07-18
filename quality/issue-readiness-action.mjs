import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { githubRequestFor } from "./github-api.mjs";
import { issueNumberFromReference } from "./github-reference.mjs";
import { validateIssueContract } from "./issue-contract.mjs";
import { fieldValue } from "./markdown-contract.mjs";

const readinessMarker = "<!-- keiko-native-readiness -->";
const allowedPermissions = new Set(["admin", "maintain", "triage", "write"]);
const initialReadySourceLabels = new Set(["status: new", "status: triaged"]);
const currentReadinessLifecycleLabels = new Set([
  "status: ready",
  "status: in progress",
  "status: pr open",
  "status: ready for human review",
]);
const prTrackedLifecycleLabels = new Set([
  "status: pr open",
  "status: ready for human review",
]);
const pausedLifecycleLabels = new Set([
  "status: blocked",
  "status: waiting for user",
]);
const githubRequest = githubRequestFor("keiko-native-issue-readiness");

function labelNames(labels) {
  return (Array.isArray(labels) ? labels : []).map((label) =>
    typeof label === "string" ? label : (label?.name ?? ""),
  );
}

function lifecycleLabels(labels) {
  return labelNames(labels).filter((name) => name.startsWith("status: "));
}

export function readinessRecordFromComments(comments) {
  const records = comments
    .filter(
      (comment) =>
        comment?.body?.includes(readinessMarker) &&
        comment?.user?.id === 41898282 &&
        comment?.user?.login === "github-actions[bot]" &&
        comment?.user?.type === "Bot",
    )
    .map((comment) => {
      const body = comment.body;
      return {
        commentId: comment.id,
        fingerprint: /^- Fingerprint: `([0-9a-f]{64})`$/mu.exec(body)?.[1],
        status: /^- Status: `(accepted|rejected)`$/mu.exec(body)?.[1],
        version: /^- Contract version: `([^`]+)`$/mu.exec(body)?.[1],
      };
    });
  return records.at(-1);
}

export function decideReadiness({
  action,
  actorAuthorized,
  hasCurrentReadinessLifecycle,
  hasReadyLabel,
  label,
  previousRecord,
  validation,
}) {
  const currentReadinessLifecycle =
    hasCurrentReadinessLifecycle ?? hasReadyLabel;
  const isRequest = action === "labeled" && label === "status: ready";
  const isRevalidation =
    (["edited", "reopened", "labeled", "unlabeled"].includes(action) &&
      currentReadinessLifecycle) ||
    (action === "unlabeled" && label === "status: ready");
  if (action === "closed" && currentReadinessLifecycle)
    return {
      outcome: "reject",
      reasons: ["A closed issue cannot remain implementation ready."],
    };
  if (!isRequest && !isRevalidation) return { outcome: "ignore", reasons: [] };
  if (action === "unlabeled" && label === "status: ready")
    return {
      outcome: "reject",
      reasons: ["The implementation-ready label was removed."],
    };
  if (isRequest && !actorAuthorized)
    return {
      outcome: "reject",
      reasons: [
        "Readiness was requested by an actor without triage or write authority.",
      ],
    };
  if (validation.failures.length > 0)
    return { outcome: "reject", reasons: validation.failures };
  if (isRequest) return { outcome: "accept", reasons: [] };
  if (
    previousRecord?.status !== "accepted" ||
    previousRecord.version !== validation.version ||
    previousRecord.fingerprint !== validation.fingerprint
  )
    return {
      outcome: "reject",
      reasons: [
        "The current contract does not match the latest accepted readiness fingerprint.",
      ],
    };
  return { outcome: "keep", reasons: [] };
}

export function readinessComment({ actor, decision, now, validation }) {
  const accepted = decision.outcome === "accept";
  const lines = [
    readinessMarker,
    `### Issue readiness ${accepted ? "accepted" : "rejected"}`,
    "",
    `- Status: \`${accepted ? "accepted" : "rejected"}\``,
    `- Contract version: \`${validation.version ?? "unresolved"}\``,
    `- Fingerprint: \`${validation.fingerprint ?? "unavailable"}\``,
    `- Triggering actor: @${actor}`,
    `- Evaluated at: \`${now}\``,
  ];
  if (decision.reasons.length > 0) {
    lines.push("", "#### Required corrections", "");
    for (const reason of decision.reasons) lines.push(`- ${reason}`);
  }
  lines.push(
    "",
    accepted
      ? "This exact contract is `Implementation Ready` while `status: ready` remains present."
      : "The issue remains non-executable with `status: new` until validation succeeds.",
  );
  return lines.join("\n");
}

async function allIssueComments(repository, issueNumber) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubRequest(
      `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
    );
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

function acceptedIssueNumber(body) {
  if (typeof body !== "string") return undefined;
  return issueNumberFromReference(fieldValue(body, "Accepted issue"));
}

async function allOpenPullRequests(repository) {
  const pullRequests = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubRequest(
      `/repos/${repository}/pulls?state=open&per_page=100&page=${page}`,
    );
    pullRequests.push(...batch);
    if (batch.length < 100) return pullRequests;
  }
}

export async function invalidateLinkedPullRequestContracts(
  repository,
  issueNumber,
) {
  const linked = (await allOpenPullRequests(repository)).filter(
    (pullRequest) => acceptedIssueNumber(pullRequest.body) === issueNumber,
  );
  for (const pullRequest of linked) {
    if (!/^[0-9a-f]{40}$/u.test(pullRequest?.head?.sha ?? ""))
      throw new Error("A linked pull request has no valid head SHA.");
    await githubRequest(
      `/repos/${repository}/statuses/${pullRequest.head.sha}`,
      {
        method: "POST",
        payload: {
          context: "Issue contract current",
          description: `Issue #${issueNumber} changed or lost readiness`,
          state: "failure",
        },
      },
    );
  }
  return linked.length;
}

async function actorCanRequestReadiness(repository, actor) {
  try {
    const result = await githubRequest(
      `/repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`,
    );
    return allowedPermissions.has(result?.permission);
  } catch {
    return false;
  }
}

async function addLabel(repository, issueNumber, label) {
  await githubRequest(`/repos/${repository}/issues/${issueNumber}/labels`, {
    method: "POST",
    payload: { labels: [label] },
  });
}

async function removeLabel(repository, issueNumber, label) {
  try {
    await githubRequest(
      `/repos/${repository}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      { method: "DELETE" },
    );
  } catch (error) {
    if (!error.message.includes("failed with 404")) throw error;
  }
}

async function postComment(repository, issueNumber, body) {
  await githubRequest(`/repos/${repository}/issues/${issueNumber}/comments`, {
    method: "POST",
    payload: { body },
  });
}

function readinessEventFacts(event, labels) {
  const statuses = lifecycleLabels(labels);
  const hasReadyLabel = statuses.includes("status: ready");
  const hasCurrentReadinessLifecycle = statuses.some((label) =>
    currentReadinessLifecycleLabels.has(label),
  );
  const isInitialRequest =
    event.action === "labeled" && event.label?.name === "status: ready";
  const isReadinessRemoval =
    event.action === "unlabeled" &&
    event.label?.name === "status: ready" &&
    event.sender?.login !== "github-actions[bot]";
  const isLifecycleRevalidation =
    ["edited", "reopened", "labeled", "unlabeled", "closed"].includes(
      event.action,
    ) && hasCurrentReadinessLifecycle;
  const pausesPrTrackedWork =
    event.action === "labeled" &&
    pausedLifecycleLabels.has(event.label?.name) &&
    statuses.some((status) => prTrackedLifecycleLabels.has(status));
  return {
    hasCurrentReadinessLifecycle,
    hasReadyLabel,
    isInitialRequest,
    pausesPrTrackedWork,
    relevant: isInitialRequest || isLifecycleRevalidation || isReadinessRemoval,
    statuses,
  };
}

function validationWithLifecycleConflicts({
  hasReadyLabel,
  isInitialRequest,
  issue,
  labels,
  statuses,
}) {
  const validation = validateIssueContract({
    body: issue.body,
    labels,
    title: issue.title,
  });
  const hasConflictingInitialReadyStatus =
    isInitialRequest &&
    statuses.some(
      (status) =>
        status !== "status: ready" && !initialReadySourceLabels.has(status),
    );
  const hasConflictingReadyRetentionStatus =
    !isInitialRequest &&
    hasReadyLabel &&
    statuses.some((status) => status !== "status: ready");
  if (hasConflictingInitialReadyStatus || hasConflictingReadyRetentionStatus)
    validation.failures.push(
      "Implementation-ready work cannot retain a conflicting lifecycle status label.",
    );
  return validation;
}

async function applyReadinessDecision({
  comment,
  decision,
  issueNumber,
  repository,
  statuses,
}) {
  if (decision.outcome === "accept") {
    await removeLabel(repository, issueNumber, "status: new");
    await removeLabel(repository, issueNumber, "status: triaged");
    await postComment(repository, issueNumber, comment);
    return;
  }
  for (const status of statuses)
    await removeLabel(repository, issueNumber, status);
  await addLabel(repository, issueNumber, "status: new");
  await postComment(repository, issueNumber, comment);
  await invalidateLinkedPullRequestContracts(repository, issueNumber);
}

export async function runIssueReadinessAction({ event, now = new Date() }) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (typeof repository !== "string" || !repository.includes("/"))
    throw new Error("GITHUB_REPOSITORY is missing or invalid.");
  const issue = event.issue;
  if (issue?.pull_request !== undefined) return { outcome: "ignore" };
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  const facts = readinessEventFacts(event, labels);
  if (!facts.relevant) return { outcome: "ignore" };

  const comments = await allIssueComments(repository, issue.number);
  const validation = validationWithLifecycleConflicts({
    hasReadyLabel: facts.hasReadyLabel,
    isInitialRequest: facts.isInitialRequest,
    issue,
    labels,
    statuses: facts.statuses,
  });
  const actorAuthorized =
    event.action !== "labeled" ||
    (await actorCanRequestReadiness(repository, event.sender?.login ?? ""));
  const decision = decideReadiness({
    action: event.action,
    actorAuthorized,
    hasCurrentReadinessLifecycle: facts.hasCurrentReadinessLifecycle,
    hasReadyLabel: facts.hasReadyLabel,
    label: event.label?.name,
    previousRecord: readinessRecordFromComments(comments),
    validation,
  });
  if (decision.outcome === "ignore") return decision;
  if (decision.outcome === "keep") {
    if (facts.pausesPrTrackedWork) {
      const invalidatedLinkedPullRequests =
        await invalidateLinkedPullRequestContracts(repository, issue.number);
      return { ...decision, invalidatedLinkedPullRequests };
    }
    return decision;
  }

  const comment = readinessComment({
    actor: event.sender?.login ?? "unknown",
    decision,
    now: now.toISOString(),
    validation,
  });
  await applyReadinessDecision({
    comment,
    decision,
    issueNumber: issue.number,
    repository,
    statuses: facts.statuses,
  });
  return decision;
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath === undefined) throw new Error("GITHUB_EVENT_PATH is missing.");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const result = await runIssueReadinessAction({ event });
  process.stdout.write(`issue-readiness: ${result.outcome}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
