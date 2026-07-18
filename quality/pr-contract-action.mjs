import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { githubRequestFor } from "./github-api.mjs";
import {
  pullRequestIssueNumber,
  validatePullRequestContract,
} from "./pr-contract.mjs";

const githubRequest = githubRequestFor("keiko-native-pr-contract");

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

async function publishContractStatus(
  repository,
  headSha,
  context,
  state,
  description,
) {
  await githubRequest(`/repos/${repository}/statuses/${headSha}`, {
    method: "POST",
    payload: { context, description, state },
  });
}

export async function runPullRequestContractAction({ event }) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (typeof repository !== "string" || !repository.includes("/"))
    throw new Error("GITHUB_REPOSITORY is missing or invalid.");
  const pullRequest = event.pull_request;
  if (pullRequest === undefined)
    throw new Error("The event does not contain a pull request.");
  const headSha = pullRequest.head?.sha;
  if (!/^[0-9a-f]{40}$/u.test(headSha ?? ""))
    throw new Error("The pull request has no valid head SHA.");

  const issueNumber = pullRequestIssueNumber(pullRequest.body);
  let issue;
  let comments = [];
  try {
    [issue, comments] =
      issueNumber === undefined
        ? [undefined, []]
        : await Promise.all([
            githubRequest(`/repos/${repository}/issues/${issueNumber}`),
            allIssueComments(repository, issueNumber),
          ]);
  } catch (error) {
    try {
      await publishContractStatus(
        repository,
        headSha,
        "PR contract",
        "error",
        "Issue or readiness evidence could not be loaded",
      );
    } catch {
      process.stderr.write("pr-contract: unable to publish API-error status\n");
    }
    throw error;
  }
  const result = validatePullRequestContract({
    comments,
    issue,
    pullRequest,
    repository,
  });
  for (const failure of result.failures)
    process.stdout.write(`::error title=PR contract::${failure}\n`);
  if (result.failures.length > 0) {
    await publishContractStatus(
      repository,
      headSha,
      "PR contract",
      "failure",
      `PR contract has ${result.failures.length} required correction(s)`,
    );
    throw new Error(
      `PR contract failed with ${result.failures.length} correction(s).`,
    );
  }
  await publishContractStatus(
    repository,
    headSha,
    "PR contract",
    "success",
    "Planning, evidence, and delivery contracts pass",
  );
  await publishContractStatus(
    repository,
    headSha,
    "Issue contract current",
    "success",
    `Issue #${issueNumber} contract and readiness record match`,
  );
  process.stdout.write("pr-contract: passed\n");
  return result;
}

export async function writePullRequestIssueOutput({ event, outputPath }) {
  const issueNumber = pullRequestIssueNumber(event.pull_request?.body);
  if (!Number.isInteger(issueNumber) || outputPath === undefined) return;
  await appendFile(outputPath, `issue-number=${issueNumber}\n`, "utf8");
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath === undefined) throw new Error("GITHUB_EVENT_PATH is missing.");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  await runPullRequestContractAction({ event });
  await writePullRequestIssueOutput({
    event,
    outputPath: process.env.GITHUB_OUTPUT,
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
