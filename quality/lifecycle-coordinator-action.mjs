import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  lifecycleCoordinatorFacts,
  planInertLifecycleCoordinatorStep,
  planInertLifecycleRecoverySettlement,
} from "./lifecycle-coordinator.mjs";
import { createLifecycleGithubProvider } from "./lifecycle-github-provider.mjs";
import { createLifecycleProviderBudget } from "./lifecycle-record-budget.mjs";
import { reconstructLifecycleHistory } from "./lifecycle-record-store.mjs";
import { verifyAuthorizedOrphanSettlement } from "./lifecycle-record-recovery.mjs";

const REPOSITORY = "oscharko-dev/Keiko-Native";
const COMMIT = /^[0-9a-f]{40}$/u;
const POSITIVE = /^[1-9][0-9]*$/u;

function positiveDecimal(value, name) {
  if (!POSITIVE.test(value ?? ""))
    throw new TypeError(`${name} must be a canonical positive decimal`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new TypeError(`${name} exceeds the safe integer range`);
  return parsed;
}

function routeFromEnvironment(environment) {
  if (environment.GITHUB_REPOSITORY !== REPOSITORY)
    throw new TypeError("coordinator repository mismatch");
  if (!COMMIT.test(environment.GITHUB_WORKFLOW_SHA ?? ""))
    throw new TypeError("coordinator workflow SHA is invalid");
  const recovery = environment.KEIKO_ROUTED_RECOVERY_COMMENT_ID ?? "";
  if (recovery !== "" && !POSITIVE.test(recovery))
    throw new TypeError("recovery comment ID is invalid");
  return Object.freeze({
    issueNumber: positiveDecimal(
      environment.KEIKO_ROUTED_ISSUE_NUMBER,
      "issue number",
    ),
    protectedDevSha: environment.GITHUB_WORKFLOW_SHA,
    recordedAt: new Date().toISOString(),
    recoveryCommentId: recovery,
    runAttempt: positiveDecimal(environment.GITHUB_RUN_ATTEMPT, "run attempt"),
    runId: positiveDecimal(environment.GITHUB_RUN_ID, "run ID"),
  });
}

function outputValues(plan) {
  const base = {
    "issue-number": String(plan.issueNumber),
    "next-writer": plan.kind,
    "should-record": String(plan.kind === "record"),
  };
  if (plan.kind === "record")
    return { ...base, "record-plan": plan.recordPlan };
  if (plan.kind === "noop") return { ...base, observation: plan.observation };
  return {
    ...base,
    producer: plan.producer,
    ...Object.fromEntries(
      Object.entries(plan.wire).map(([name, value]) => [
        name.replaceAll("_", "-"),
        value,
      ]),
    ),
  };
}

function outputLines(values) {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

function noopPlan(route, reason) {
  return Object.freeze({
    issueNumber: route.issueNumber,
    kind: "noop",
    observation: createHash("sha256")
      .update(`${reason}:${route.issueNumber}:${route.recoveryCommentId}`)
      .digest("hex"),
  });
}

export async function runLifecycleCoordinatorAction({
  environment = process.env,
  githubOutput = process.env.GITHUB_OUTPUT,
  now = new Date(),
  provider,
  providerFactory = createLifecycleGithubProvider,
  loadFacts,
} = {}) {
  const route = routeFromEnvironment(environment);
  const budget = createLifecycleProviderBudget("recovery", {
    providerOwnsCounting: provider === undefined,
  });
  const activeProvider =
    provider ??
    providerFactory({
      budget,
    });
  const selectedRecoveryComment =
    route.recoveryCommentId === ""
      ? await activeProvider.discoverRecoveryComment({
          issueNumber: route.issueNumber,
        })
      : Number(route.recoveryCommentId);
  budget.selectMode(selectedRecoveryComment === null ? "normal" : "recovery");
  if (selectedRecoveryComment !== null) {
    const authorizedRecovery = await activeProvider.authenticateRecoveryComment(
      {
        commentId: selectedRecoveryComment,
        issueNumber: route.issueNumber,
      },
    );
    if (authorizedRecovery === null) {
      const plan = noopPlan(route, "unsupported-comment");
      if (typeof githubOutput === "string" && githubOutput !== "")
        await appendFile(githubOutput, outputLines(outputValues(plan)), "utf8");
      return Object.freeze({
        budgetUsed: activeProvider.requestCount?.() ?? 0,
        facts: undefined,
        history: undefined,
        plan,
      });
    }
    const orphanReads = await activeProvider.loadRecoveryOrphan({
      issueNumber: route.issueNumber,
      recoveryTargetIdentity: authorizedRecovery.recoveryTargetIdentity,
    });
    const history = await reconstructLifecycleHistory({
      budget,
      ignoredOrphan: {
        bodySha256: orphanReads.first.comment_body_sha256,
        commentId: orphanReads.first.comment_id,
      },
      issueNumber: route.issueNumber,
      mode: "recovery",
      provider: activeProvider,
      repository: REPOSITORY,
    });
    if (!["empty", "authenticated"].includes(history.state))
      throw new Error("recovery history is incomplete");
    const records = history.records ?? [];
    const predecessor = history.predecessor ?? {
      commentId: null,
      recordDigest: null,
    };
    if (
      predecessor.commentId !==
        orphanReads.first.last_authenticated_comment_id ||
      predecessor.recordDigest !==
        orphanReads.first.last_authenticated_record_digest
    )
      throw new Error("recovery predecessor mismatch");
    const settlement = verifyAuthorizedOrphanSettlement({
      authorizedRequestIdentity: authorizedRecovery.identity,
      expectedRecoveryTargetIdentity: authorizedRecovery.recoveryTargetIdentity,
      firstRead: orphanReads.first,
      issueNumber: route.issueNumber,
      repository: REPOSITORY,
      secondRead: orphanReads.second,
    });
    if (
      records.some(
        (record) =>
          record.parsed.fields.recovery_settlement_identity ===
          settlement.settlementIdentity,
      )
    ) {
      if (route.recoveryCommentId !== "") {
        const plan = noopPlan(route, "recovery-target-consumed");
        if (typeof githubOutput === "string" && githubOutput !== "")
          await appendFile(
            githubOutput,
            outputLines(outputValues(plan)),
            "utf8",
          );
        return Object.freeze({
          budgetUsed: Math.max(
            budget.used,
            activeProvider.requestCount?.() ?? 0,
          ),
          facts: undefined,
          history,
          plan,
        });
      }
      const current = await (loadFacts === undefined
        ? activeProvider.loadCoordinatorFacts({
            issueNumber: route.issueNumber,
          })
        : loadFacts({ issueNumber: route.issueNumber }));
      const facts = lifecycleCoordinatorFacts({
        comments: activeProvider.comments(),
        issue: current.issue,
        protectedDevSha: route.protectedDevSha,
        pullRequest: current.pullRequest,
      });
      const plan = planInertLifecycleCoordinatorStep({
        facts,
        records,
        runtime: {
          recordedAt: now.toISOString(),
          runAttempt: route.runAttempt,
          runId: route.runId,
        },
      });
      if (typeof githubOutput === "string" && githubOutput !== "")
        await appendFile(githubOutput, outputLines(outputValues(plan)), "utf8");
      return Object.freeze({
        budgetUsed: Math.max(budget.used, activeProvider.requestCount?.() ?? 0),
        facts,
        history,
        plan,
      });
    }
    const current = await (loadFacts === undefined
      ? activeProvider.loadCoordinatorFacts({
          issueNumber: route.issueNumber,
        })
      : loadFacts({ issueNumber: route.issueNumber }));
    const facts = lifecycleCoordinatorFacts({
      comments: activeProvider.comments(),
      issue: current.issue,
      protectedDevSha: route.protectedDevSha,
      pullRequest: current.pullRequest,
    });
    const plan = planInertLifecycleRecoverySettlement({
      authorizedRecovery,
      facts,
      records,
      recoveryAttempt: orphanReads.first.attempt + 1,
      recoverySettlementIdentity: settlement.settlementIdentity,
      runtime: {
        recordedAt: now.toISOString(),
        runAttempt: route.runAttempt,
        runId: route.runId,
      },
    });
    if (typeof githubOutput === "string" && githubOutput !== "")
      await appendFile(githubOutput, outputLines(outputValues(plan)), "utf8");
    return Object.freeze({
      budgetUsed: Math.max(budget.used, activeProvider.requestCount?.() ?? 0),
      facts,
      history,
      plan,
    });
  }
  const history = await reconstructLifecycleHistory({
    budget,
    issueNumber: route.issueNumber,
    mode: "normal",
    provider: activeProvider,
    repository: REPOSITORY,
  });
  if (!["empty", "authenticated"].includes(history.state))
    throw new Error("lifecycle history requires explicit recovery");
  const current = await (loadFacts === undefined
    ? activeProvider.loadCoordinatorFacts({ issueNumber: route.issueNumber })
    : loadFacts({ issueNumber: route.issueNumber }));
  const facts = lifecycleCoordinatorFacts({
    comments: activeProvider.comments(),
    issue: current.issue,
    protectedDevSha: route.protectedDevSha,
    pullRequest: current.pullRequest,
  });
  const plan = planInertLifecycleCoordinatorStep({
    facts,
    records: history.records ?? [],
    runtime: {
      recordedAt: now.toISOString(),
      runAttempt: route.runAttempt,
      runId: route.runId,
    },
  });
  if (typeof githubOutput === "string" && githubOutput !== "")
    await appendFile(githubOutput, outputLines(outputValues(plan)), "utf8");
  return Object.freeze({
    budgetUsed: Math.max(budget.used, activeProvider.requestCount?.() ?? 0),
    facts,
    history,
    plan,
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  await runLifecycleCoordinatorAction();
