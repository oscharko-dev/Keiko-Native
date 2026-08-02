import { appendFile, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import { githubBinaryRequestFor, githubRequestFor } from "./github-api.mjs";
import {
  LIFECYCLE_WAKE_REPOSITORY,
  LIFECYCLE_WAKE_RESOLVER_BUDGETS,
  LIFECYCLE_WAKE_SOURCE_WORKFLOWS,
  boundedScheduledLocators,
  directLifecycleWakeLocator,
  parseLifecycleWakeLocator,
  validateLifecycleWakeSource,
} from "./lifecycle-wake.mjs";
import { pullRequestIssueNumber } from "./pr-contract.mjs";
import { readSingleFileZip } from "./single-file-zip.mjs";

const request = githubRequestFor("keiko-native-lifecycle-wakeup-router");
const binaryRequest = githubBinaryRequestFor(
  "keiko-native-lifecycle-wakeup-router",
);
const SHA = /^[0-9a-f]{40}$/u;

export class LifecycleWakeRouterError extends Error {
  constructor(code) {
    super(code);
    this.name = "LifecycleWakeRouterError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new LifecycleWakeRouterError(code);
};
const positive = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};
const commentId = (eventName, event) =>
  eventName === "issue_comment" ? String(event?.comment?.id ?? "") : "";

function countedProvider(provider, limit) {
  let used = 0;
  return Object.freeze({
    get used() {
      return used;
    },
    async binary(path) {
      used += 1;
      if (used > limit) fail("resolver-request-budget");
      return provider.binary(path);
    },
    async json(path) {
      used += 1;
      if (used > limit) fail("resolver-request-budget");
      return provider.json(path);
    },
  });
}

async function stableRead(read) {
  const first = await read();
  const second = await read();
  if (!isDeepStrictEqual(first, second)) fail("resolver-unstable");
  return second;
}

function pullRequestSnapshot(value) {
  return {
    base: value?.base?.ref,
    body: value?.body,
    head: value?.head?.sha,
    number: value?.number,
    state: value?.state,
    updatedAt: value?.updated_at,
  };
}

async function stablePullRequest(provider, number) {
  const path = `/repos/${LIFECYCLE_WAKE_REPOSITORY}/pulls/${number}`;
  const value = await stableRead(async () =>
    pullRequestSnapshot(await provider.json(path)),
  );
  if (
    value.number !== number ||
    typeof value.body !== "string" ||
    !SHA.test(value.head ?? "") ||
    typeof value.base !== "string"
  )
    fail("pull-request-invalid");
  return value;
}

function directLocator(
  eventName,
  action,
  issueNumber,
  pullRequestNumber,
  event,
) {
  const locator = directLifecycleWakeLocator({
    action,
    eventName,
    issueNumber,
    protectedDevSha: event.workflowSha,
    pullRequestNumber,
    recoveryCommentId: commentId(eventName, event),
    repository: event?.repository?.full_name,
  });
  return [
    {
      issue_number: locator.issue_number,
      recovery_comment_id: locator.recovery_comment_id,
    },
  ];
}

async function resolveIssue(eventName, event) {
  const issueNumber = positive(event?.issue?.number);
  if (issueNumber === undefined) fail("issue-locator-invalid");
  return directLocator(eventName, event.action, issueNumber, null, event);
}

function directPullRequestNumbers(eventName, event) {
  if (eventName === "pull_request_target")
    return [positive(event?.pull_request?.number)].filter(Boolean);
  if (eventName === "issue_comment")
    return [positive(event?.issue?.number)].filter(Boolean);
  if (eventName === "check_run")
    return [
      ...new Set(
        (event?.check_run?.pull_requests ?? [])
          .map((item) => positive(item?.number))
          .filter(Boolean),
      ),
    ];
  return [];
}

async function resolvePullRequest(eventName, event, provider) {
  const numbers = directPullRequestNumbers(eventName, event);
  if (numbers.length !== 1) fail("exact-pull-request-required");
  const pullRequest = await stablePullRequest(provider, numbers[0]);
  const issueNumber = pullRequestIssueNumber(pullRequest.body);
  if (issueNumber === undefined) fail("accepted-issue-locator-required");
  return directLocator(
    eventName,
    event.action,
    issueNumber,
    pullRequest.number,
    event,
  );
}

function sourceRunShape(run) {
  return {
    attempt: run?.run_attempt,
    event: run?.event,
    headSha: run?.head_sha,
    id: run?.id,
    name: run?.name,
    path: run?.path,
    pullRequests: Array.isArray(run?.pull_requests)
      ? run.pull_requests.map((pullRequest) => ({
          base: {
            ref: pullRequest?.base?.ref,
            repository: pullRequest?.base?.repo?.url,
            sha: pullRequest?.base?.sha,
          },
          number: pullRequest?.number,
        }))
      : undefined,
    ref: run?.head_branch === "dev" ? "refs/heads/dev" : run?.head_branch,
    repository: run?.repository?.full_name,
    status: run?.status,
  };
}

async function resolveGovernance(event, provider) {
  const runId = positive(event?.workflow_run?.id);
  if (runId === undefined) fail("source-run-invalid");
  const runPath = `/repos/${LIFECYCLE_WAKE_REPOSITORY}/actions/runs/${runId}`;
  const artifactPath = `${runPath}/artifacts?per_page=100`;
  const run = await stableRead(async () =>
    sourceRunShape(await provider.json(runPath)),
  );
  const artifacts = await stableRead(async () => provider.json(artifactPath));
  const matches = (artifacts?.artifacts ?? []).filter(
    (artifact) =>
      artifact?.name === "keiko-lifecycle-wake-locator-v1" &&
      artifact?.expired === false &&
      positive(artifact?.id) !== undefined &&
      artifact?.size_in_bytes <= 65_536,
  );
  if (matches.length !== 1) fail("locator-artifact-cardinality");
  const archivePath = `/repos/${LIFECYCLE_WAKE_REPOSITORY}/actions/artifacts/${matches[0].id}/zip`;
  const firstBytes = await provider.binary(archivePath);
  const secondBytes = await provider.binary(archivePath);
  if (!firstBytes.equals(secondBytes)) fail("locator-artifact-unstable");
  const locator = parseLifecycleWakeLocator(
    readSingleFileZip(secondBytes, {
      expectedName: "locator.bin",
      maximumFileBytes: 512,
    }),
  );
  validateLifecycleWakeSource(
    {
      attempt: run.attempt,
      event: run.event,
      id: run.id,
      name: run.name,
      repository: run.repository,
      status: run.status,
      workflowPath: run.path,
      headSha: run.headSha,
      pullRequests: run.pullRequests,
      ref: run.ref,
    },
    locator,
    event.workflowSha,
  );
  return [{ issue_number: locator.issue_number, recovery_comment_id: "" }];
}

async function resolveEvidence(event, provider) {
  const payloadSource = Object.values(LIFECYCLE_WAKE_SOURCE_WORKFLOWS).find(
    (source) =>
      source.sourceClass === "evidence" &&
      source.name === event?.workflow_run?.name,
  );
  if (payloadSource === undefined) fail("evidence-source-invalid");
  if (event?.workflow_run?.event !== payloadSource.event) return [];
  const runId = positive(event?.workflow_run?.id);
  const runAttempt = positive(event?.workflow_run?.run_attempt);
  if (runId === undefined || runAttempt === undefined)
    fail("source-run-invalid");
  const path = `/repos/${LIFECYCLE_WAKE_REPOSITORY}/actions/runs/${runId}`;
  const run = await stableRead(async () =>
    sourceRunShape(await provider.json(path)),
  );
  if (positive(run.id) !== runId || positive(run.attempt) !== runAttempt)
    fail("source-run-invalid");
  const expected = LIFECYCLE_WAKE_SOURCE_WORKFLOWS[run.path];
  if (
    expected?.sourceClass !== "evidence" ||
    expected.name !== run.name ||
    expected.event !== run.event ||
    run.status !== "completed" ||
    run.repository !== LIFECYCLE_WAKE_REPOSITORY
  )
    fail("evidence-source-invalid");
  if (!Array.isArray(run.pullRequests) || run.pullRequests.length !== 1)
    fail("exact-pull-request-required");
  const pullRequestNumber = positive(run.pullRequests[0]?.number);
  if (pullRequestNumber === undefined) fail("exact-pull-request-required");
  const payloadPullRequests = event?.workflow_run?.pull_requests;
  if (
    payloadPullRequests !== undefined &&
    (!Array.isArray(payloadPullRequests) ||
      (payloadPullRequests.length > 0 &&
        (payloadPullRequests.length !== 1 ||
          positive(payloadPullRequests[0]?.number) !== pullRequestNumber)))
  )
    fail("exact-pull-request-required");
  const pullRequest = await stablePullRequest(provider, pullRequestNumber);
  const issueNumber = pullRequestIssueNumber(pullRequest.body);
  if (issueNumber === undefined) fail("accepted-issue-locator-required");
  return [{ issue_number: issueNumber, recovery_comment_id: "" }];
}

async function twoPageStable(provider, endpoint) {
  const read = async () => {
    const pages = [];
    for (const page of [1, 2])
      pages.push(
        await provider.json(
          `/repos/${LIFECYCLE_WAKE_REPOSITORY}/${endpoint}?state=open&per_page=100&page=${page}`,
        ),
      );
    if (!pages.every(Array.isArray) || pages[1].length === 100)
      fail("schedule-pagination-incomplete");
    return pages.flat();
  };
  return stableRead(read);
}

async function resolveSchedule(provider) {
  const issues = await twoPageStable(provider, "issues");
  const pullRequests = await twoPageStable(provider, "pulls");
  const issueNumbers = issues
    .filter((issue) => issue?.pull_request === undefined)
    .map((issue) => positive(issue?.number));
  for (const pullRequest of pullRequests) {
    const issueNumber = pullRequestIssueNumber(pullRequest?.body);
    if (issueNumber === undefined) fail("schedule-pr-locator-invalid");
    issueNumbers.push(issueNumber);
  }
  if (issueNumbers.includes(undefined)) fail("schedule-issue-invalid");
  return boundedScheduledLocators(issueNumbers, provider.used);
}

export async function resolveLifecycleWakeup({
  environment = process.env,
  event,
  provider = { binary: binaryRequest, json: request },
} = {}) {
  const resolver = environment.KEIKO_LIFECYCLE_RESOLVER;
  const eventName = environment.GITHUB_EVENT_NAME;
  if (
    environment.GITHUB_REPOSITORY !== LIFECYCLE_WAKE_REPOSITORY ||
    event?.repository?.full_name !== LIFECYCLE_WAKE_REPOSITORY ||
    event?.workflowSha !== environment.GITHUB_WORKFLOW_SHA
  )
    fail("caller-environment-mismatch");
  const budgetKey = resolver === "pull-request" ? "pullRequest" : resolver;
  const limit = LIFECYCLE_WAKE_RESOLVER_BUDGETS[budgetKey];
  if (limit === undefined) fail("resolver-unsupported");
  const counted = countedProvider(provider, limit);
  let locators;
  if (resolver === "issue") locators = await resolveIssue(eventName, event);
  else if (resolver === "pull-request")
    locators = await resolvePullRequest(eventName, event, counted);
  else if (resolver === "governance")
    locators = await resolveGovernance(event, counted);
  else if (resolver === "evidence")
    locators = await resolveEvidence(event, counted);
  else if (resolver === "schedule") locators = await resolveSchedule(counted);
  else fail("resolver-unsupported");
  return Object.freeze({
    locators: Object.freeze(locators.map((item) => Object.freeze(item))),
    requestCount: counted.used,
    resolver,
  });
}

export async function runLifecycleWakeupRouterCli({
  eventPath = process.env.GITHUB_EVENT_PATH,
  githubOutput = process.env.GITHUB_OUTPUT,
} = {}) {
  if (typeof eventPath !== "string" || eventPath === "")
    throw new Error("GITHUB_EVENT_PATH is required.");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  event.workflowSha = process.env.GITHUB_WORKFLOW_SHA;
  const result = await resolveLifecycleWakeup({ event });
  if (typeof githubOutput === "string" && githubOutput !== "")
    await appendFile(
      githubOutput,
      `locators=${JSON.stringify(result.locators)}\n`,
      "utf8",
    );
  return result;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  await runLifecycleWakeupRouterCli();
