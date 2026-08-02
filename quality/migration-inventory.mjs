import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  semanticIssueFingerprint,
  validateIssueContract,
} from "./issue-contract.mjs";
import { evaluateCurrentReadiness } from "./issue-lifecycle-readiness.mjs";
import { readinessRecordFromComments } from "./issue-readiness-action.mjs";
import { issueDeliveryTarget, pullRequestIssueNumber } from "./pr-contract.mjs";
import { contractSha256, parseContractPath } from "./repository-contract.mjs";
import { compareCodeUnits } from "./deterministic-order.mjs";

const canonicalStates = new Set([
  "status: new",
  "status: triaged",
  "status: ready",
  "status: in progress",
  "status: pr open",
  "status: ready for human review",
  "status: blocked",
  "status: waiting for user",
  "status: done",
]);
const retainedStates = new Set([
  "status: ready",
  "status: in progress",
  "status: pr open",
  "status: ready for human review",
  "status: blocked",
  "status: waiting for user",
]);
const prTrackedStates = new Set([
  "status: pr open",
  "status: ready for human review",
]);
const shaPattern = /^[0-9a-f]{40}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const actorPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const manifestPath = "docs/qa/repository-migration-manifest-v1.md";
const readinessProducer = "issue-readiness.yml@protected-dev";

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const compareNumber = (left, right) => left.number - right.number;
const canonicalBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const digestBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

function indeterminate(code) {
  return {
    candidateInputs: [],
    code,
    dispositions: [],
    inventory: null,
    kind: "indeterminate",
    manifest: null,
    ok: false,
    publishable: false,
    receiptInput: null,
    reconciliation: [],
  };
}

function pageSet(value, identity) {
  if (!record(value) || !Array.isArray(value.pages) || value.pages.length === 0)
    return { failure: "pagination-unavailable" };
  let priorEnd = null;
  let total;
  const nodes = [];
  for (let index = 0; index < value.pages.length; index += 1) {
    const page = value.pages[index];
    if (
      !record(page) ||
      page.cursor !== priorEnd ||
      !Array.isArray(page.nodes) ||
      typeof page.hasNextPage !== "boolean" ||
      !Number.isSafeInteger(page.totalCount) ||
      page.totalCount < 0 ||
      (page.endCursor !== null && typeof page.endCursor !== "string") ||
      page.totalCount !== (total ?? page.totalCount) ||
      page.hasNextPage !== index < value.pages.length - 1 ||
      (page.hasNextPage && page.endCursor === null)
    ) {
      return { failure: "pagination-incomplete" };
    }
    total = page.totalCount;
    priorEnd = page.endCursor;
    nodes.push(...page.nodes);
  }
  if (nodes.length !== total) return { failure: "pagination-count-mismatch" };
  const identities = [];
  try {
    for (const node of nodes) {
      const id = identity(node);
      if (id === undefined || id === null || identities.includes(id))
        return { failure: "pagination-identity-conflict" };
      identities.push(id);
    }
  } catch {
    return { failure: "pagination-malformed" };
  }
  return { nodes };
}

function lifecycleLabels(labels) {
  return Array.isArray(labels)
    ? labels.filter(
        (label) => typeof label === "string" && label.startsWith("status: "),
      )
    : [];
}

function typeLabels(labels) {
  return Array.isArray(labels)
    ? labels.filter(
        (label) => typeof label === "string" && label.startsWith("type: "),
      )
    : [];
}

function prepareIssue(item) {
  if (
    !record(item) ||
    !positiveInteger(item.number) ||
    typeof item.title !== "string" ||
    typeof item.body !== "string" ||
    !["open", "closed"].includes(item.state) ||
    !Array.isArray(item.labels) ||
    !Array.isArray(item.assignees) ||
    item.assignees.some((actor) => !actorPattern.test(actor)) ||
    typeof item.updatedAt !== "string"
  ) {
    return { failure: "issue-observation-malformed" };
  }
  const types = typeLabels(item.labels);
  const declaredType =
    types.length === 1 ? /^type: (.+)$/u.exec(types[0])?.[1] : undefined;
  const validation = validateIssueContract({
    body: item.body,
    labels: types,
    title: item.title,
  });
  const versionMatch = /^v([1-9][0-9]*)$/u.exec(validation.version ?? "");
  const version = versionMatch === null ? null : Number(versionMatch[1]);
  const type = validation.kind ?? declaredType ?? null;
  const target =
    type === null ? null : (issueDeliveryTarget(item.body, type) ?? null);
  const contractFailure =
    types.length !== 1
      ? "issue-type-ambiguous"
      : validation.failures.length !== 0
        ? "issue-contract-invalid"
        : !positiveInteger(version)
          ? "issue-version-invalid"
          : typeof target !== "string" || target === ""
            ? "issue-target-invalid"
            : null;
  return {
    fact: {
      assignees: [...item.assignees].sort(compareCodeUnits),
      body: item.body,
      contractFailure,
      fingerprint: semanticIssueFingerprint(item.body, item.title),
      lifecycle: lifecycleLabels(item.labels),
      number: item.number,
      state: item.state,
      stateReason: item.stateReason,
      target,
      title: item.title,
      type,
      updatedAt: item.updatedAt,
      version,
    },
  };
}

function prepareSnapshot(input) {
  if (
    !record(input) ||
    !repositoryPattern.test(input.repository ?? "") ||
    !shaPattern.test(input.protectedDev ?? "") ||
    typeof input.observedAt !== "string" ||
    !Number.isFinite(Date.parse(input.observedAt)) ||
    !Array.isArray(input.allowlistedMergers) ||
    input.allowlistedMergers.some((actor) => !actorPattern.test(actor)) ||
    !(input.comments instanceof Map)
  ) {
    return indeterminate("snapshot-identity-invalid");
  }
  const labels = pageSet(input.labels, (label) =>
    typeof label === "string" ? label : undefined,
  );
  const issues = pageSet(input.issues, (item) => item?.number);
  const pullRequests = pageSet(input.pullRequests, (item) => item?.number);
  const contracts = pageSet(input.contracts, (item) => item?.path);
  const failed = [labels, issues, pullRequests, contracts].find(
    (value) => value.failure !== undefined,
  );
  if (failed !== undefined) return indeterminate(failed.failure);
  if (
    labels.nodes.some(
      (label) => label.startsWith("status: ") && !canonicalStates.has(label),
    )
  ) {
    return indeterminate("unknown-lifecycle-label");
  }
  const contractBindings = [];
  for (const item of contracts.nodes) {
    const parsed = parseContractPath(item?.path);
    if (
      parsed.ok !== true ||
      !/^[0-9a-f]{64}$/u.test(item?.digest ?? "") ||
      item.mode !== "100644"
    ) {
      return indeterminate("contract-observation-invalid");
    }
    contractBindings.push({
      digest: item.digest,
      identity: parsed.contract,
      path: item.path,
    });
  }
  const issueFacts = [];
  for (const item of issues.nodes) {
    const prepared = prepareIssue(item);
    if (prepared.failure !== undefined) return indeterminate(prepared.failure);
    issueFacts.push(prepared.fact);
  }
  return {
    contractBindings,
    issueFacts: issueFacts.sort(compareNumber),
    labels: labels.nodes.toSorted(compareCodeUnits),
    ok: true,
    pullRequests: pullRequests.nodes,
  };
}

function commentsFor(input, issue) {
  const comments = pageSet(
    input.comments.get(issue.number),
    (item) => item?.id,
  );
  return comments.failure === undefined ? comments.nodes : undefined;
}

function readinessFor(input, issue, comments) {
  const record = readinessRecordFromComments(comments);
  const result = evaluateCurrentReadiness({
    availability: "available",
    comments,
    currentBody: issue.body,
    currentFingerprint: issue.fingerprint,
    currentTitle: issue.title,
    currentVersion: `v${issue.version}`,
    expectedCommentId: record?.commentId,
  });
  return result.ok
    ? {
        current: true,
        producer: readinessProducer,
        url: `https://github.com/${input.repository}/issues/${issue.number}#issuecomment-${record.commentId}`,
      }
    : { current: false, reason: result.reason };
}

function pullRequestFact(item, issueByNumber, allowlistedMergers) {
  const associatedIssue = pullRequestIssueNumber(item?.body);
  const hasAssociationLocator =
    typeof item?.body === "string" && /- Accepted issue:/u.test(item.body);
  const lifecycle = lifecycleLabels(item?.labels);
  const base = item?.base;
  const head = item?.head;
  const basicFact = {
    associatedIssue: associatedIssue ?? null,
    base: base?.sha ?? null,
    checksPassing: item?.checks?.allPassing ?? null,
    head: head?.sha ?? null,
    lifecycle,
    merged: item?.merged ?? null,
    number: item?.number ?? null,
    state: item?.state ?? null,
    target: base?.ref ?? null,
  };
  const coreValid =
    record(item) &&
    positiveInteger(item.number) &&
    ["open", "closed"].includes(item.state) &&
    typeof item.merged === "boolean" &&
    record(base) &&
    typeof base.ref === "string" &&
    shaPattern.test(base.sha ?? "") &&
    record(head) &&
    typeof head.ref === "string" &&
    shaPattern.test(head.sha ?? "") &&
    (associatedIssue === undefined || positiveInteger(associatedIssue));
  if (!coreValid)
    return {
      disposition: "pull-request-observation-malformed",
      fact: basicFact,
    };
  const issue = issueByNumber.get(associatedIssue);
  if (associatedIssue === undefined && !hasAssociationLocator)
    return {
      fact: {
        ...basicFact,
      },
      verified: false,
    };
  if (issue === undefined)
    return {
      disposition: "pull-request-association-unverifiable",
      fact: {
        associatedIssue: associatedIssue ?? null,
        lifecycle,
        number: item.number,
      },
    };
  const fact = {
    associatedIssue,
    base: base.sha,
    checksPassing: item?.checks?.allPassing ?? null,
    head: head.sha,
    lifecycle,
    merged: item.merged,
    number: item.number,
    state: item.state,
    target: base.ref,
  };
  if (base.ref !== issue.target)
    return { disposition: "pull-request-target-mismatch", fact };
  if (
    item?.headCommit?.verified !== true ||
    item?.headCommit?.reason !== "valid"
  )
    return { disposition: "pr-head-signature-invalid", fact };
  if (
    !record(item.checks) ||
    typeof item.checks.allPassing !== "boolean" ||
    item.checks.complete !== true ||
    item.checks.head !== head.sha ||
    !Array.isArray(item.checks.required)
  ) {
    return { disposition: "pr-check-head-mismatch", fact };
  }
  const exactContextsRequired =
    issue.state === "open" &&
    issue.lifecycle.length === 1 &&
    prTrackedStates.has(issue.lifecycle[0]);
  if (
    (exactContextsRequired && item.checks.allPassing !== true) ||
    new Set(item.checks.required.map((check) => check?.name)).size !==
      item.checks.required.length ||
    (exactContextsRequired &&
      !["Issue contract current", "PR contract"].every((name) =>
        item.checks.required.some(
          (check) => check?.name === name && check?.conclusion === "SUCCESS",
        ),
      )) ||
    item.checks.required.some(
      (check) =>
        !record(check) ||
        typeof check.name !== "string" ||
        !["ERROR", "FAILURE", "PENDING", "SUCCESS"].includes(
          check.conclusion,
        ) ||
        (exactContextsRequired && check.conclusion !== "SUCCESS"),
    )
  ) {
    return { disposition: "pr-required-check-failed", fact };
  }
  if (item.merged) {
    const merge = item.mergeCommit;
    if (
      item.state !== "closed" ||
      !record(merge) ||
      !shaPattern.test(merge.sha ?? "") ||
      merge.verified !== true ||
      merge.reason !== "valid" ||
      !Array.isArray(merge.parents) ||
      merge.parents.length !== 1 ||
      !shaPattern.test(merge.parents[0] ?? "") ||
      !allowlistedMergers.includes(item.mergedBy)
    ) {
      return { disposition: "pr-merge-proof-invalid", fact };
    }
  } else if (item.state !== "open" || item.mergeCommit !== null) {
    return { disposition: "pr-state-inconsistent", fact };
  }
  return { fact, verified: true };
}

function disposition(kind, number, code) {
  return { code, kind, number };
}

function candidateIdentity(issue, contractBindings) {
  const existing = contractBindings
    .filter((item) => item.identity.issue === issue.number)
    .toSorted(
      (left, right) => left.identity.revision - right.identity.revision,
    );
  if (existing.length !== 0)
    return { failure: "existing-contract-requires-chain-plan" };
  return {
    candidatePath: `docs/contracts/${issue.type}-${issue.number}-v${issue.version}-r1.md`,
    predecessor: null,
    recoveries: [],
    revision: 1,
  };
}

function safeIssue(issue, classification, readiness) {
  return {
    assignees: issue.assignees,
    classification,
    lifecycle: [...issue.lifecycle].sort(compareCodeUnits),
    number: issue.number,
    readiness: readiness.current ? "current" : readiness.reason,
    state: issue.state,
    stateReason: issue.stateReason,
    target: issue.target,
    type: issue.type,
    version: issue.version,
  };
}

function build(input) {
  const prepared = prepareSnapshot(input);
  if (prepared.ok !== true) return prepared;
  const issueByNumber = new Map(
    prepared.issueFacts.map((issue) => [issue.number, issue]),
  );
  const dispositions = [];
  const pullRequestFacts = [];
  const verifiedPullRequests = [];
  for (const item of prepared.pullRequests) {
    const result = pullRequestFact(
      item,
      issueByNumber,
      input.allowlistedMergers,
    );
    if (result.fact !== undefined) pullRequestFacts.push(result.fact);
    if (result.disposition !== undefined)
      dispositions.push(
        disposition("pull-request", item?.number ?? 0, result.disposition),
      );
    if (result.verified === true) verifiedPullRequests.push(result.fact);
  }
  pullRequestFacts.sort(compareNumber);
  const issueInventory = [];
  const observations = [];
  const candidateInputs = [];
  const reconciliation = [];
  for (const issue of prepared.issueFacts) {
    const comments = commentsFor(input, issue);
    if (comments === undefined)
      return indeterminate("comment-pagination-incomplete");
    const readiness =
      issue.contractFailure === null
        ? readinessFor(input, issue, comments)
        : { current: false, reason: issue.contractFailure };
    const associated = verifiedPullRequests.filter(
      (pullRequest) => pullRequest.associatedIssue === issue.number,
    );
    const current = [...issue.lifecycle].sort(compareCodeUnits);
    if (issue.contractFailure !== null)
      dispositions.push(
        disposition("issue", issue.number, issue.contractFailure),
      );
    if (issue.state === "closed") {
      const completed =
        issue.stateReason === "completed" &&
        associated.length === 1 &&
        associated[0].merged === true;
      const classification = completed
        ? "completed"
        : "closed-without-completion";
      issueInventory.push(safeIssue(issue, classification, readiness));
      reconciliation.push({
        current,
        desired: completed ? ["status: done"] : [],
        kind: "issue",
        number: issue.number,
      });
      if (issue.stateReason === "completed" && !completed)
        dispositions.push(
          disposition("issue", issue.number, "completion-unverifiable"),
        );
      continue;
    }
    if (!readiness.current) {
      issueInventory.push(safeIssue(issue, "not-current-ready", readiness));
      if (issue.contractFailure === null) {
        const reason =
          readiness.reason === "stale"
            ? "stale-readiness"
            : `readiness-${readiness.reason}`;
        dispositions.push(disposition("issue", issue.number, reason));
      }
      continue;
    }
    if (
      issue.lifecycle.length !== 1 ||
      !retainedStates.has(issue.lifecycle[0])
    ) {
      issueInventory.push(
        safeIssue(issue, "lifecycle-unverifiable", readiness),
      );
      dispositions.push(
        disposition("issue", issue.number, "retained-lifecycle-invalid"),
      );
      continue;
    }
    const state = issue.lifecycle[0];
    const tracked = prTrackedStates.has(state);
    const openAssociated = associated.filter(
      (pullRequest) => pullRequest.state === "open" && !pullRequest.merged,
    );
    if (tracked !== (openAssociated.length === 1)) {
      issueInventory.push(
        safeIssue(issue, "linked-pr-unverifiable", readiness),
      );
      dispositions.push(
        disposition("issue", issue.number, "linked-pr-topology-invalid"),
      );
      continue;
    }
    const identity = candidateIdentity(issue, prepared.contractBindings);
    if (identity.failure !== undefined) {
      issueInventory.push(
        safeIssue(issue, "contract-chain-unverifiable", readiness),
      );
      dispositions.push(disposition("issue", issue.number, identity.failure));
      continue;
    }
    const linkedPullRequest = tracked
      ? {
          head: openAssociated[0].head,
          number: openAssociated[0].number,
          target: openAssociated[0].target,
        }
      : null;
    const readinessUrl = readiness.url;
    const observation = {
      candidatePath: identity.candidatePath,
      fingerprint: issue.fingerprint,
      lifecycleLabels: [state],
      linkedPullRequest,
      number: issue.number,
      predecessor: identity.predecessor,
      readiness: readinessUrl,
      readinessProducer: readiness.producer,
      recoveries: identity.recoveries,
      revision: identity.revision,
      state: "open",
      type: issue.type,
      version: issue.version,
    };
    observations.push(observation);
    candidateInputs.push({
      candidatePath: identity.candidatePath,
      fingerprint: issue.fingerprint,
      number: issue.number,
      predecessor: identity.predecessor,
      readiness: readinessUrl,
      recoveries: identity.recoveries,
      revision: identity.revision,
      type: issue.type,
      version: issue.version,
    });
    issueInventory.push(safeIssue(issue, "migration-member", readiness));
    reconciliation.push({
      current,
      desired: [state],
      kind: "issue",
      number: issue.number,
    });
  }
  for (const pullRequest of pullRequestFacts) {
    reconciliation.push({
      current: [...pullRequest.lifecycle].sort(compareCodeUnits),
      desired: [],
      kind: "pull-request",
      number: pullRequest.number,
    });
  }
  dispositions.sort((left, right) =>
    left.kind === right.kind
      ? left.number - right.number || compareCodeUnits(left.code, right.code)
      : compareCodeUnits(left.kind, right.kind),
  );
  reconciliation.sort((left, right) =>
    left.kind === right.kind
      ? left.number - right.number
      : left.kind === "issue"
        ? -1
        : 1,
  );
  observations.sort(compareNumber);
  candidateInputs.sort(compareNumber);
  const inventory = {
    issues: issueInventory.sort(compareNumber),
    protectedDev: input.protectedDev,
    pullRequests: pullRequestFacts,
    repository: input.repository,
  };
  if (dispositions.length !== 0 || observations.length === 0) {
    return {
      candidateInputs: [],
      dispositions,
      inventory,
      manifest: null,
      ok: true,
      publishable: false,
      receiptInput: null,
      reconciliation,
    };
  }
  const manifestBytes = canonicalBytes({ entries: observations });
  const digest = contractSha256(manifestBytes).digest;
  const manifest = {
    bytes: manifestBytes,
    digest,
    entries: observations,
    path: manifestPath,
  };
  return {
    candidateInputs,
    dispositions,
    inventory,
    manifest,
    ok: true,
    publishable: true,
    receiptInput: {
      candidateInputs,
      observations,
      target: "dev",
      terminalManifest: { digest, path: manifestPath },
    },
    reconciliation,
  };
}

export function buildMigrationInventory(input) {
  try {
    return build(input);
  } catch {
    return indeterminate("inventory-evaluation-failed");
  }
}

buildMigrationInventory.prepare = prepareSnapshot;

export function verifyMigrationInventory(input, output) {
  const rebuilt = buildMigrationInventory(input);
  return rebuilt.ok === true && isDeepStrictEqual(rebuilt, output)
    ? {
        digest:
          rebuilt.manifest === null
            ? null
            : digestBytes(rebuilt.manifest.bytes),
        ok: true,
      }
    : { code: "inventory-output-mismatch", ok: false };
}
