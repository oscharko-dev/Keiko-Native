import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { githubRequestFor } from "./github-api.mjs";
import { issueNumberFromReference } from "./github-reference.mjs";
import { validateIssueContract } from "./issue-contract.mjs";
import { fieldValue } from "./markdown-contract.mjs";

const readinessMarker = "<!-- keiko-native-readiness -->";
const allowedPermissions = new Set(["admin", "maintain", "triage", "write"]);
const initialReadySourceLabels = new Set(["status: new", "status: triaged"]);
const githubRequest = githubRequestFor("keiko-native-issue-readiness");

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
  hasReadyLabel,
  label,
  previousRecord,
  validation,
}) {
  const isRequest = action === "labeled" && label === "status: ready";
  const isRevalidation =
    (["edited", "reopened", "labeled", "unlabeled"].includes(action) &&
      hasReadyLabel) ||
    (action === "unlabeled" && label === "status: ready");
  if (action === "closed" && hasReadyLabel)
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

export async function runIssueReadinessAction({ event, now = new Date() }) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (typeof repository !== "string" || !repository.includes("/"))
    throw new Error("GITHUB_REPOSITORY is missing or invalid.");
  const issue = event.issue;
  if (issue?.pull_request !== undefined) return { outcome: "ignore" };
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  const hasReadyLabel = labels.some((label) => label?.name === "status: ready");
  const relevant =
    (event.action === "labeled" && event.label?.name === "status: ready") ||
    (["edited", "reopened", "labeled", "unlabeled", "closed"].includes(
      event.action,
    ) &&
      hasReadyLabel) ||
    (event.action === "unlabeled" &&
      event.label?.name === "status: ready" &&
      event.sender?.login !== "github-actions[bot]");
  if (!relevant) return { outcome: "ignore" };

  const comments = await allIssueComments(repository, issue.number);
  const validation = validateIssueContract({
    body: issue.body,
    labels,
    title: issue.title,
  });
  const isInitialRequest =
    event.action === "labeled" && event.label?.name === "status: ready";
  if (
    labels.some(
      (label) =>
        label?.name?.startsWith("status: ") &&
        label.name !== "status: ready" &&
        !(isInitialRequest && initialReadySourceLabels.has(label.name)),
    )
  )
    validation.failures.push(
      "Implementation-ready work cannot retain a conflicting lifecycle status label.",
    );
  const actorAuthorized =
    event.action !== "labeled" ||
    (await actorCanRequestReadiness(repository, event.sender?.login ?? ""));
  const decision = decideReadiness({
    action: event.action,
    actorAuthorized,
    hasReadyLabel,
    label: event.label?.name,
    previousRecord: readinessRecordFromComments(comments),
    validation,
  });
  if (decision.outcome === "ignore" || decision.outcome === "keep")
    return decision;

  const comment = readinessComment({
    actor: event.sender?.login ?? "unknown",
    decision,
    now: now.toISOString(),
    validation,
  });
  if (decision.outcome === "accept") {
    await removeLabel(repository, issue.number, "status: new");
    await removeLabel(repository, issue.number, "status: triaged");
    await postComment(repository, issue.number, comment);
  } else {
    await removeLabel(repository, issue.number, "status: ready");
    await addLabel(repository, issue.number, "status: new");
    await postComment(repository, issue.number, comment);
    await invalidateLinkedPullRequestContracts(repository, issue.number);
  }
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
