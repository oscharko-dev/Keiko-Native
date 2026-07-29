import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { githubRequestFor } from "./github-api.mjs";
import { pullRequestIssueNumber } from "./pr-contract.mjs";

const REPOSITORY = "oscharko-dev/Keiko-Native";
const SHA = /^[0-9a-f]{40}$/u;
const ROUTED_EVENTS = new Set([
  "check_run",
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_target",
  "workflow_dispatch",
  "workflow_run",
]);
const request = githubRequestFor("keiko-native-lifecycle-wakeup-router");

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function eventPullRequestNumbers(event) {
  const values = [
    event?.pull_request?.number,
    event?.issue?.pull_request === undefined ? undefined : event.issue.number,
    ...(Array.isArray(event?.check_run?.pull_requests)
      ? event.check_run.pull_requests.map((pullRequest) => pullRequest?.number)
      : []),
    ...(Array.isArray(event?.workflow_run?.pull_requests)
      ? event.workflow_run.pull_requests.map(
          (pullRequest) => pullRequest?.number,
        )
      : []),
  ];
  return [
    ...new Set(
      values
        .map((value) => positiveInteger(value))
        .filter((value) => value !== undefined),
    ),
  ];
}

function routeFailure(reason) {
  return Object.freeze({ ok: false, reason });
}

function pullRequestSnapshot(pullRequest) {
  return JSON.stringify({
    base: pullRequest?.base?.ref,
    body: pullRequest?.body,
    head: pullRequest?.head?.sha,
    number: pullRequest?.number,
    state: pullRequest?.state,
    updatedAt: pullRequest?.updated_at,
  });
}

async function readStablePullRequest(repository, number, providerRequest) {
  const path = `/repos/${repository}/pulls/${number}`;
  const first = await providerRequest(path);
  const second = await providerRequest(path);
  if (
    pullRequestSnapshot(first) !== pullRequestSnapshot(second) ||
    first?.number !== number ||
    first?.state !== "open" ||
    !SHA.test(first?.head?.sha ?? "")
  )
    return undefined;
  return second;
}

export async function resolveLifecycleWakeup({
  environment = process.env,
  event,
  providerRequest = request,
} = {}) {
  const eventName = environment.GITHUB_EVENT_NAME;
  const repository = environment.GITHUB_REPOSITORY;
  if (!ROUTED_EVENTS.has(eventName)) return routeFailure("unsupported_event");
  if (
    repository !== REPOSITORY ||
    event?.repository?.full_name !== repository
  )
    return routeFailure("repository_mismatch");

  const eventNumbers = eventPullRequestNumbers(event);
  const dispatchNumber = positiveInteger(event?.inputs?.pull_request_number);
  const pullRequestNumber =
    eventName === "workflow_dispatch" ? dispatchNumber : eventNumbers[0];
  if (
    pullRequestNumber === undefined ||
    (eventName !== "workflow_dispatch" && eventNumbers.length !== 1)
  )
    return routeFailure("exact_pull_request_required");

  try {
    const pullRequest = await readStablePullRequest(
      repository,
      pullRequestNumber,
      providerRequest,
    );
    if (pullRequest === undefined)
      return routeFailure("pull_request_unstable");
    const issueNumber = pullRequestIssueNumber(pullRequest.body);
    if (issueNumber === undefined) return routeFailure("linked_issue_required");
    return Object.freeze({
      exactHeadSha: pullRequest.head.sha,
      issueNumber,
      ok: true,
      pullRequestNumber,
      wakeEvent: eventName,
    });
  } catch {
    return routeFailure("provider_unavailable");
  }
}

export async function runLifecycleWakeupRouterCli({
  eventPath = process.env.GITHUB_EVENT_PATH,
  githubOutput = process.env.GITHUB_OUTPUT,
} = {}) {
  if (typeof eventPath !== "string" || eventPath === "")
    throw new Error("GITHUB_EVENT_PATH is required.");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const result = await resolveLifecycleWakeup({ event });
  if (!result.ok) throw new Error(`Lifecycle wake-up rejected: ${result.reason}`);
  if (typeof githubOutput === "string" && githubOutput !== "") {
    await appendFile(
      githubOutput,
      [
        `issue-number=${result.issueNumber}`,
        `pull-request-number=${result.pullRequestNumber}`,
        `exact-head-sha=${result.exactHeadSha}`,
        `wake-event=${result.wakeEvent}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
  return result;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  await runLifecycleWakeupRouterCli();
