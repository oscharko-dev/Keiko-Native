import { semanticIssueFingerprint } from "./issue-contract.mjs";
import { readinessRecordFromComments } from "./issue-readiness-action.mjs";
import { buildEpicMergeEvidence } from "./epic-merge-evidence.mjs";
import {
  EPIC_MERGE_REPOSITORY,
  isEpicMergeCommit,
  validateEpicMergePolicy,
} from "./epic-merge-policy.mjs";
import { normalizeEpicMergeResults } from "./epic-merge-authorization.mjs";

const PROTECTED_REF = "refs/heads/dev";
const PAGE_LIMIT = 100;

async function collect(method, input) {
  const items = [];
  const visited = new Set();
  let page = 1;
  for (let count = 0; count < PAGE_LIMIT; count += 1) {
    if (visited.has(page)) return { complete: false, items, truncated: true };
    visited.add(page);
    const response = await method({ ...input, page, perPage: 100 });
    if (
      response === null ||
      typeof response !== "object" ||
      !Array.isArray(response.items) ||
      !(
        response.nextPage === null ||
        (Number.isSafeInteger(response.nextPage) && response.nextPage > page)
      )
    )
      return { complete: false, items: [], truncated: true };
    items.push(...response.items);
    if (response.nextPage === null)
      return { complete: true, items, truncated: false };
    page = response.nextPage;
  }
  return { complete: false, items, truncated: true };
}

function labelNames(issue) {
  return Array.isArray(issue?.labels)
    ? issue.labels.map((label) =>
        typeof label === "string" ? label : label?.name,
      )
    : [];
}

function planningField(body, name) {
  if (typeof body !== "string") return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^- ${escaped}: \\x60([^\\x60]+)\\x60$`, "mu").exec(
    body,
  )?.[1];
}

function readiness(issue, comments) {
  const record = readinessRecordFromComments(comments.items);
  const version = planningField(issue?.body, "Contract version");
  const fingerprint =
    typeof issue?.body === "string" && typeof issue?.title === "string"
      ? semanticIssueFingerprint(issue.body, issue.title)
      : undefined;
  const forged = comments.items.some(
    (comment) =>
      comment?.body?.includes("<!-- keiko-native-readiness -->") &&
      (comment?.user?.id !== 41898282 ||
        comment?.user?.login !== "github-actions[bot]" ||
        comment?.user?.type !== "Bot"),
  );
  return {
    accepted: record?.status === "accepted",
    commentId: record?.commentId ?? null,
    current:
      comments.complete &&
      !comments.truncated &&
      !forged &&
      record?.status === "accepted" &&
      record.version === version &&
      record.fingerprint === fingerprint,
    fingerprint: record?.fingerprint ?? null,
    producer: "github-actions[bot]",
    producerId: 41898282,
    version: record?.version ?? null,
  };
}

function normalizedPullRequest(pullRequest, issue) {
  return {
    base: pullRequest?.base?.sha,
    draft: pullRequest?.draft,
    head: pullRequest?.head?.sha,
    headTree: pullRequest?.head?.tree,
    issue: pullRequest?.issue,
    mergeable: pullRequest?.mergeable,
    number: pullRequest?.number,
    open: pullRequest?.state === "open",
    source: pullRequest?.head?.ref,
    target: pullRequest?.base?.ref,
  };
}

function providerResult(response) {
  if ([403, 404, 409, 422].includes(response?.status))
    return { kind: "rejected", status: response.status };
  if (response?.status === 429) return { kind: "timeout" };
  if (
    [200, 201].includes(response?.status) &&
    response.body?.merged === true &&
    isEpicMergeCommit(response.body.sha)
  )
    return { kind: "accepted", mergeCommit: response.body.sha };
  return { kind: "malformed" };
}

export function createInertEpicMergeAdapter({ clock, github, store }) {
  if (
    github === null ||
    typeof github !== "object" ||
    store === null ||
    typeof store !== "object" ||
    typeof clock !== "function"
  )
    throw new Error("invalid_epic_merge_adapter_configuration");

  async function loadProtectedPolicy() {
    const source = await github.readPolicy({
      path: "quality/epic-merge-policy.json",
      ref: PROTECTED_REF,
    });
    if (
      source?.ref !== PROTECTED_REF ||
      source.protected !== true ||
      !isEpicMergeCommit(source.revision)
    )
      throw new Error("protected_policy_source_invalid");
    const policy = structuredClone(source.document);
    policy.source = {
      protected: true,
      ref: PROTECTED_REF,
      revision: source.revision,
    };
    if (!validateEpicMergePolicy(policy))
      throw new Error("protected_policy_document_invalid");
    return policy;
  }

  async function loadAuthorization(request) {
    const [issue, pullRequest] = await Promise.all([
      github.readIssue({
        issue: request.issue,
        repository: request.repository,
      }),
      github.readPullRequest({
        pullRequest: request.pullRequest,
        repository: request.repository,
      }),
    ]);
    const [comments, auditComments, checks, statuses, findings, conversations] =
      await Promise.all([
        collect(github.listIssueComments, {
          issue: request.issue,
          repository: request.repository,
        }),
        collect(github.listIssueComments, {
          issue: request.pullRequest,
          repository: request.repository,
        }),
        collect(github.listChecks, {
          head: pullRequest?.head?.sha,
          pullRequest: request.pullRequest,
          repository: request.repository,
        }),
        collect(github.listCommitStatuses, {
          head: pullRequest?.head?.sha,
          pullRequest: request.pullRequest,
          repository: request.repository,
        }),
        collect(github.listFindings, {
          pullRequest: request.pullRequest,
          repository: request.repository,
        }),
        collect(github.listConversations, {
          pullRequest: request.pullRequest,
          repository: request.repository,
        }),
      ]);
    const results = normalizeEpicMergeResults(checks, statuses, pullRequest);
    const lifecycle = labelNames(issue).filter((name) =>
      name?.startsWith("status: "),
    );
    const complete =
      [
        comments,
        auditComments,
        checks,
        statuses,
        findings,
        conversations,
      ].every((value) => value.complete && !value.truncated) && results.valid;
    return {
      checks: results.items,
      conversations: {
        complete: conversations.complete,
        unresolved: conversations.items.filter(
          (item) => item?.resolved !== true,
        ).length,
      },
      evidence: buildEpicMergeEvidence({
        auditComments,
        pullRequest,
        results: results.items,
        resultsComplete:
          checks.complete &&
          !checks.truncated &&
          statuses.complete &&
          !statuses.truncated &&
          results.valid,
      }),
      findings: {
        blocking: findings.items.filter((item) => item?.blocking === true)
          .length,
        complete: findings.complete,
      },
      issue: {
        lifecycle: lifecycle.length === 1 ? lifecycle[0] : null,
        number: issue?.number,
        open: issue?.state === "open",
        readiness: readiness(issue, comments),
        target: planningField(issue?.body, "Exact delivery target"),
      },
      pagination: { complete, truncated: !complete },
      pullRequest: normalizedPullRequest(pullRequest, issue),
      repository: request.repository,
    };
  }

  async function loadTargetProtection(target, base) {
    const [permission, rules] = await Promise.all([
      github.readPermission({ repository: EPIC_MERGE_REPOSITORY, target }),
      collect(github.listTargetRules, {
        repository: EPIC_MERGE_REPOSITORY,
        target,
      }),
    ]);
    return {
      authorization: {
        bypass:
          permission !== null &&
          typeof permission === "object" &&
          Object.hasOwn(permission, "bypass") &&
          typeof permission.bypass === "boolean"
            ? permission.bypass
            : null,
        merge: ["admin", "maintain"].includes(permission?.permission),
        source: "repository-permission",
      },
      base,
      current: rules.complete && !rules.truncated,
      pagination: {
        complete: rules.complete,
        truncated: rules.truncated,
      },
      repository: EPIC_MERGE_REPOSITORY,
      rules: structuredClone(rules.items),
      target,
    };
  }

  async function mergePullRequest(input) {
    try {
      return providerResult(await github.merge(input));
    } catch (error) {
      return error?.code === "ETIMEDOUT" || error?.status === 429
        ? { kind: "timeout" }
        : { kind: "malformed" };
    }
  }

  return Object.freeze({
    authorizeMaintainer: async (actor, target) => {
      if (!/^epic\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(target ?? ""))
        return false;
      const permission = await github.readPermission({
        actor,
        repository: EPIC_MERGE_REPOSITORY,
        target,
      });
      return (
        ["admin", "maintain"].includes(permission?.permission) &&
        permission?.bypass !== true
      );
    },
    clock,
    loadAuthorization,
    loadProtectedPolicy,
    loadPullRequest: async (request) =>
      normalizedPullRequest(
        await github.readPullRequest({
          pullRequest: request.pullRequest,
          repository: request.repository,
        }),
      ),
    loadTargetProtection,
    markOperationSubmitted: store.markOperationSubmitted,
    mergePullRequest,
    prepareOperation: store.prepareOperation,
    readMergeOutcome: github.readMergeOutcome,
    readOperation: store.readOperation,
    readPreparation: store.readPreparation,
    readReconciliation: github.readReconciliation,
    readRefs: async (target, source) => ({
      base: (
        await github.readRef({ ref: target, repository: EPIC_MERGE_REPOSITORY })
      )?.sha,
      head: (
        await github.readRef({ ref: source, repository: EPIC_MERGE_REPOSITORY })
      )?.sha,
    }),
    settleOperation: store.settleOperation,
    settleReconciliation: store.settleReconciliation,
  });
}
