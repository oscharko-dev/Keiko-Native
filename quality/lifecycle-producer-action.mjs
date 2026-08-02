import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { semanticIssueFingerprint } from "./issue-contract.mjs";
import { readinessRecordFromComments } from "./issue-readiness-action.mjs";
import { lifecycleCoordinatorFacts } from "./lifecycle-coordinator.mjs";
import { createLifecycleGithubProvider } from "./lifecycle-github-provider.mjs";
import { planInertLifecycleProducerResult } from "./lifecycle-producer.mjs";
import { validateLifecycleProducerWire } from "./lifecycle-producer-wire.mjs";
import { createLifecycleProviderBudget } from "./lifecycle-record-budget.mjs";
import { reconstructLifecycleHistory } from "./lifecycle-record-store.mjs";
import { validatePullRequestContract } from "./pr-contract.mjs";

const environmentFields = Object.freeze({
  schema_version: "KEIKO_PRODUCER_SCHEMA_VERSION",
  producer_contract_version: "KEIKO_PRODUCER_CONTRACT_VERSION",
  repository: "KEIKO_PRODUCER_REPOSITORY",
  issue_number: "KEIKO_PRODUCER_ISSUE_NUMBER",
  pull_request_number: "KEIKO_PRODUCER_PULL_REQUEST_NUMBER",
  exact_head_sha: "KEIKO_PRODUCER_EXACT_HEAD_SHA",
  exact_target: "KEIKO_PRODUCER_EXACT_TARGET",
  generation_bytes_base64: "KEIKO_PRODUCER_GENERATION_BYTES_BASE64",
  generation_bytes_sha256: "KEIKO_PRODUCER_GENERATION_BYTES_SHA256",
  generation_identity: "KEIKO_PRODUCER_GENERATION_IDENTITY",
  attempt: "KEIKO_PRODUCER_ATTEMPT",
  phase_fence_comment_id: "KEIKO_PRODUCER_PHASE_FENCE_COMMENT_ID",
  phase_fence_digest: "KEIKO_PRODUCER_PHASE_FENCE_DIGEST",
  generation_request_comment_id: "KEIKO_PRODUCER_GENERATION_REQUEST_COMMENT_ID",
  generation_request_digest: "KEIKO_PRODUCER_GENERATION_REQUEST_DIGEST",
  request_identity: "KEIKO_PRODUCER_REQUEST_IDENTITY",
  request_payload_digest: "KEIKO_PRODUCER_REQUEST_PAYLOAD_DIGEST",
  expected_producer: "KEIKO_PRODUCER_EXPECTED_PRODUCER",
});
const COMMIT = /^[0-9a-f]{40}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;

function producerRuntimeFromEnvironment(environment) {
  if (!COMMIT.test(environment.GITHUB_WORKFLOW_SHA ?? ""))
    throw new TypeError("producer workflow SHA is invalid");
  const positive = (name) => {
    const value = environment[name] ?? "";
    const parsed = Number(value);
    if (
      !POSITIVE_DECIMAL.test(value) ||
      !Number.isSafeInteger(parsed) ||
      String(parsed) !== value
    )
      throw new TypeError(`${name} must be a canonical positive decimal`);
    return parsed;
  };
  return Object.freeze({
    protectedDevSha: environment.GITHUB_WORKFLOW_SHA,
    runAttempt: positive("GITHUB_RUN_ATTEMPT"),
    runId: positive("GITHUB_RUN_ID"),
  });
}

export function lifecycleProducerWireFromEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environmentFields).map(([field, name]) => [
      field,
      environment[name] ?? "",
    ]),
  );
}

export async function runLifecycleProducerAction({
  environment = process.env,
  githubOutput = process.env.GITHUB_OUTPUT,
} = {}) {
  const rawWire = lifecycleProducerWireFromEnvironment(environment);
  const wire = validateLifecycleProducerWire(rawWire);
  if (githubOutput)
    await appendFile(
      githubOutput,
      `producer-path=${wire.producer_path}\nproducer=${wire.expected_producer}\n`,
      "utf8",
    );
  return wire;
}

function currentReadiness(issue, comments) {
  const readiness = readinessRecordFromComments(comments);
  return readiness?.status === "accepted" &&
    readiness.fingerprint ===
      semanticIssueFingerprint(issue?.body ?? "", issue?.title ?? "")
    ? readiness
    : undefined;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function producerEvaluation(producer, issue, comments, pullRequest) {
  if (producer === "issue-contract-current") {
    const readiness = currentReadiness(issue, comments);
    const accepted = readiness !== undefined;
    return {
      conclusion: accepted ? "success" : "failure",
      payloadDigest: digest({
        fingerprint: readiness?.fingerprint ?? null,
        status: readiness?.status ?? "unavailable",
        version: readiness?.version ?? null,
      }),
      providerResultId: readiness?.commentId ?? issue.id,
      providerResultSha: pullRequest?.head?.sha ?? null,
      reasonCode: accepted ? "ok" : "evidence-incomplete",
      resultName: "Issue contract current",
    };
  }
  if (producer === "pr-contract") {
    if (pullRequest === null)
      throw new TypeError("pull-request producer has no current pull request");
    const result = validatePullRequestContract({
      comments,
      issue,
      lifecycleActivation: "disabled",
      pullRequest,
      repository: "oscharko-dev/Keiko-Native",
    });
    const accepted = result.failures.length === 0;
    return {
      conclusion: accepted ? "success" : "failure",
      payloadDigest: digest({
        failureCount: result.failures.length,
        head: pullRequest.head.sha,
      }),
      providerResultId: pullRequest.id,
      providerResultSha: pullRequest.head.sha,
      reasonCode: accepted ? "ok" : "evidence-incomplete",
      resultName: "PR contract",
    };
  }
  const providerResult = pullRequest ?? issue;
  return {
    conclusion: "unavailable",
    payloadDigest: digest({
      activation: "disabled",
      producer: "contract-publication",
    }),
    providerResultId: providerResult.id,
    providerResultSha: pullRequest?.head?.sha ?? null,
    reasonCode: "activation-disabled",
    resultName: "Contract publication",
  };
}

function outputLines(values) {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

export async function runLifecycleProducerRecordAction({
  environment = process.env,
  githubOutput = process.env.GITHUB_OUTPUT,
  loadFacts,
  loadHistory = reconstructLifecycleHistory,
  now = new Date(),
  provider,
  providerFactory = createLifecycleGithubProvider,
} = {}) {
  const rawWire = lifecycleProducerWireFromEnvironment(environment);
  const wire = validateLifecycleProducerWire(rawWire);
  const runtime = producerRuntimeFromEnvironment(environment);
  const issueNumber = Number(wire.issue_number);
  const budget = createLifecycleProviderBudget("normal", {
    providerOwnsCounting: provider === undefined,
  });
  budget.selectMode("normal");
  const activeProvider = provider ?? providerFactory({ budget });
  const history = await loadHistory({
    budget,
    issueNumber,
    mode: "normal",
    provider: activeProvider,
    repository: wire.repository,
  });
  if (history.state !== "authenticated")
    throw new Error("producer lifecycle history is unavailable");
  const current = await (loadFacts === undefined
    ? activeProvider.loadCoordinatorFacts({ issueNumber })
    : loadFacts({ issueNumber }));
  const facts = lifecycleCoordinatorFacts({
    comments: activeProvider.comments(),
    issue: current.issue,
    protectedDevSha: runtime.protectedDevSha,
    pullRequest: current.pullRequest,
  });
  const workflow = await activeProvider.currentProducerRuntime({
    expectedProducer: wire.expected_producer,
    runId: runtime.runId,
  });
  const result = planInertLifecycleProducerResult({
    evaluation: producerEvaluation(
      wire.expected_producer,
      current.issue,
      activeProvider.comments(),
      current.pullRequest,
    ),
    facts,
    records: history.records,
    runtime: {
      jobId: workflow.jobId,
      recordedAt: now.toISOString(),
      runAttempt: runtime.runAttempt,
      runId: runtime.runId,
      workflowId: workflow.workflowId,
    },
    wire: rawWire,
  });
  if (typeof githubOutput === "string" && githubOutput !== "")
    await appendFile(
      githubOutput,
      outputLines({
        "issue-number": String(result.issueNumber),
        "record-plan": result.recordPlan,
        "result-identity": result.resultIdentity,
      }),
      "utf8",
    );
  return Object.freeze({
    budgetUsed: Math.max(budget.used, activeProvider.requestCount?.() ?? 0),
    facts,
    history,
    result,
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  await runLifecycleProducerRecordAction();
