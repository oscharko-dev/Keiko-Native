import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  semanticIssueFingerprint,
  validateIssueContract,
} from "./issue-contract.mjs";
import { evaluateCurrentReadiness } from "./issue-lifecycle-readiness.mjs";
import { readinessRecordFromComments } from "./issue-readiness-action.mjs";
import {
  issueDeliveryTarget,
  pullRequestIssueNumber,
  validatePullRequestContract,
} from "./pr-contract.mjs";
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
const manifestPathPattern =
  /^docs\/qa\/repository-migration-manifest-v([1-9]\d*)\.md$/u;
const readinessProducer = "issue-readiness.yml@protected-dev";
const trustedActionsProducer = Object.freeze({
  id: 41898282,
  login: "github-actions[bot]",
  type: "Bot",
});

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

function issueContractFailure(types, validation, version, target) {
  if (types.length !== 1) return "issue-type-ambiguous";
  if (validation.failures.length !== 0) return "issue-contract-invalid";
  if (!positiveInteger(version)) return "issue-version-invalid";
  if (typeof target !== "string" || target === "")
    return "issue-target-invalid";
  return null;
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
    typeof item.updatedAt !== "string" ||
    ![item.lastEditedAt, item.reopenedAt].every(
      (value) => value === null || typeof value === "string",
    ) ||
    ![item.lastEditedAt, item.reopenedAt]
      .filter((value) => value !== null)
      .every((value) => Number.isFinite(Date.parse(value))) ||
    !(item.claim === null || record(item.claim))
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
  const versionMatch = /^v([1-9]\d*)$/u.exec(validation.version ?? "");
  const version = versionMatch === null ? null : Number(versionMatch[1]);
  const type = validation.kind ?? declaredType ?? null;
  const target =
    type === null ? null : (issueDeliveryTarget(item.body, type) ?? null);
  const contractFailure = issueContractFailure(
    types,
    validation,
    version,
    target,
  );
  return {
    fact: {
      assignees: [...item.assignees].sort(compareCodeUnits),
      body: item.body,
      contractFailure,
      claim: item.claim,
      fingerprint: semanticIssueFingerprint(item.body, item.title),
      lifecycle: lifecycleLabels(item.labels),
      lastEditedAt: item.lastEditedAt,
      number: item.number,
      reopenedAt: item.reopenedAt,
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

function manifestBinding(value) {
  return (
    record(value) &&
    typeof value.path === "string" &&
    manifestPathPattern.test(value.path) &&
    /^[0-9a-f]{64}$/u.test(value.digest ?? "")
  );
}

function manifestSuccessor(nodes) {
  const chain = [];
  for (const item of nodes) {
    const match = manifestPathPattern.exec(item?.path ?? "");
    if (
      match === null ||
      item.mode !== "100644" ||
      !/^[0-9a-f]{64}$/u.test(item?.digest ?? "") ||
      !(item.predecessor === null || manifestBinding(item.predecessor))
    )
      return { failure: "migration-manifest-observation-invalid" };
    chain.push({
      digest: item.digest,
      path: item.path,
      predecessor: item.predecessor,
      version: Number(match[1]),
    });
  }
  chain.sort((left, right) => left.version - right.version);
  for (let index = 0; index < chain.length; index += 1) {
    const item = chain[index];
    if (item.version !== index + 1)
      return { failure: "migration-manifest-chain-invalid" };
    if (index === 0) {
      if (item.predecessor !== null)
        return { failure: "migration-manifest-chain-invalid" };
      continue;
    }
    const prior = chain[index - 1];
    if (
      !isDeepStrictEqual(item.predecessor, {
        digest: prior.digest,
        path: prior.path,
      })
    )
      return { failure: "migration-manifest-chain-invalid" };
  }
  const terminal = chain.at(-1) ?? null;
  const version = chain.length + 1;
  return {
    path: `docs/qa/repository-migration-manifest-v${version}.md`,
    predecessor:
      terminal === null
        ? null
        : { digest: terminal.digest, path: terminal.path },
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
  const manifests = pageSet(input.manifests, (item) => item?.path);
  const failed = [labels, issues, pullRequests, contracts, manifests].find(
    (value) => value.failure !== undefined,
  );
  if (failed !== undefined) return indeterminate(failed.failure);
  const observedLifecycleLabels = labels.nodes.filter((label) =>
    label.startsWith("status: "),
  );
  if (observedLifecycleLabels.some((label) => !canonicalStates.has(label))) {
    return indeterminate("unknown-lifecycle-label");
  }
  if (
    observedLifecycleLabels.length !== canonicalStates.size ||
    [...canonicalStates].some(
      (label) => !observedLifecycleLabels.includes(label),
    )
  )
    return indeterminate("canonical-lifecycle-labels-missing");
  if (
    input.contractsProtectedDev !== input.protectedDev ||
    input.manifestsProtectedDev !== input.protectedDev
  )
    return indeterminate("contract-tree-not-protected-dev");
  const manifestIdentity = manifestSuccessor(manifests.nodes);
  if (manifestIdentity.failure !== undefined)
    return indeterminate(manifestIdentity.failure);
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
    issueFacts: issueFacts.toSorted(compareNumber),
    labels: labels.nodes.toSorted(compareCodeUnits),
    manifestIdentity,
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
  const readinessRecord = readinessRecordFromComments(comments);
  const result = evaluateCurrentReadiness({
    availability: "available",
    comments,
    currentBody: issue.body,
    currentFingerprint: issue.fingerprint,
    currentTitle: issue.title,
    currentVersion: `v${issue.version}`,
    expectedCommentId: readinessRecord?.commentId,
  });
  if (!result.ok) return { current: false, reason: result.reason };
  const acceptedComment = comments.find(
    (comment) => comment?.id === readinessRecord.commentId,
  );
  const invalidations = [issue.lastEditedAt, issue.reopenedAt].filter(
    (value) => value !== null,
  );
  if (
    typeof acceptedComment?.createdAt !== "string" ||
    !Number.isFinite(Date.parse(acceptedComment.createdAt)) ||
    invalidations.some(
      (value) => Date.parse(value) >= Date.parse(acceptedComment.createdAt),
    )
  )
    return { current: false, reason: "stale" };
  return {
    current: true,
    producer: readinessProducer,
    url: `https://github.com/${input.repository}/issues/${issue.number}#issuecomment-${readinessRecord.commentId}`,
  };
}

function validPullRequestCore(item, associatedIssue, base, head) {
  return (
    record(item) &&
    positiveInteger(item.number) &&
    ["open", "closed"].includes(item.state) &&
    typeof item.merged === "boolean" &&
    typeof item.isDraft === "boolean" &&
    ["CONFLICTING", "MERGEABLE", "UNKNOWN"].includes(item.mergeable) &&
    record(base) &&
    typeof base.ref === "string" &&
    shaPattern.test(base.sha ?? "") &&
    record(head) &&
    typeof head.ref === "string" &&
    repositoryPattern.test(head.repository ?? "") &&
    shaPattern.test(head.sha ?? "") &&
    (associatedIssue === undefined || positiveInteger(associatedIssue))
  );
}

function requiredChecksDisposition(item, issue, head) {
  if (
    !record(item.checks) ||
    typeof item.checks.allPassing !== "boolean" ||
    item.checks.complete !== true ||
    item.checks.head !== head.sha ||
    !Array.isArray(item.checks.required)
  ) {
    return "pr-check-head-mismatch";
  }
  const prOpen =
    issue.lifecycle.length === 1 && issue.lifecycle[0] === "status: pr open";
  const reviewReady =
    issue.lifecycle.length === 1 &&
    issue.lifecycle[0] === "status: ready for human review";
  const exactContextsRequired = prOpen || reviewReady || item.merged === true;
  const expectedContexts = [
    "Issue contract current",
    "PR contract",
    ...(reviewReady || item.merged === true ? ["Lifecycle handoff"] : []),
  ];
  const required = item.checks.required;
  const unique = new Set(required.map((check) => check?.name)).size;
  const exactContextsPresent = expectedContexts.every((name) =>
    required.some(
      (check) => check?.name === name && check?.conclusion === "SUCCESS",
    ),
  );
  const producerInvalid = required.some(
    (check) =>
      expectedContexts.includes(check?.name) &&
      !isDeepStrictEqual(check?.producer, trustedActionsProducer),
  );
  const invalidEntry = required.some(
    (check) =>
      !record(check) ||
      typeof check.name !== "string" ||
      !["ERROR", "FAILURE", "PENDING", "SUCCESS"].includes(check.conclusion) ||
      (expectedContexts.includes(check.name) && check.conclusion !== "SUCCESS"),
  );
  if (producerInvalid) return "pr-required-check-producer-invalid";
  return ((reviewReady || item.merged === true) &&
    item.checks.allPassing !== true) ||
    unique !== required.length ||
    (exactContextsRequired && !exactContextsPresent) ||
    invalidEntry
    ? "pr-required-check-failed"
    : null;
}

function validMergeProof(item, allowlistedMergers) {
  const merge = item.mergeCommit;
  return (
    item.state === "closed" &&
    record(merge) &&
    shaPattern.test(merge.sha ?? "") &&
    merge.verified === true &&
    merge.reason === "valid" &&
    Array.isArray(merge.parents) &&
    merge.parents.length === 1 &&
    shaPattern.test(merge.parents[0] ?? "") &&
    allowlistedMergers.includes(item.mergedBy)
  );
}

function terminalDeliveryValid(input, item, issue, comments) {
  if (item.merged !== true || typeof item.title !== "string") return false;
  const invalidations = [issue.lastEditedAt, issue.reopenedAt].filter(
    (value) => value !== null,
  );
  const freshAcceptedReadiness = comments.some((comment) => {
    const accepted = readinessRecordFromComments([comment]);
    return (
      accepted?.status === "accepted" &&
      accepted.version === `v${issue.version}` &&
      accepted.fingerprint === issue.fingerprint &&
      typeof comment.createdAt === "string" &&
      invalidations.every(
        (value) => Date.parse(value) < Date.parse(comment.createdAt),
      )
    );
  });
  if (!freshAcceptedReadiness) return false;
  const validation = validatePullRequestContract({
    comments,
    issue: {
      body: issue.body,
      labels: [
        { name: `type: ${issue.type}` },
        ...issue.lifecycle.map((name) => ({ name })),
      ],
      number: issue.number,
      state: issue.state,
      state_reason: issue.stateReason,
      title: issue.title,
    },
    lifecycleActivation: "disabled",
    pullRequest: item,
    repository: input.repository,
    terminalDelivery: true,
  });
  return validation.failures.length === 0;
}

function validateMergedPullRequest(
  input,
  item,
  issue,
  fact,
  head,
  allowlistedMergers,
) {
  if (!validMergeProof(item, allowlistedMergers))
    return { disposition: "pr-merge-proof-invalid", fact };
  const comments = commentsFor(input, issue);
  if (comments === undefined)
    return { disposition: "comment-pagination-incomplete", fact };
  fact.finalDeliveryValidated = terminalDeliveryValid(
    input,
    item,
    issue,
    comments,
  );
  if (!fact.finalDeliveryValidated) return { fact, verified: true };
  const checksDisposition = requiredChecksDisposition(item, issue, head);
  return checksDisposition === null
    ? { fact, verified: true }
    : { disposition: checksDisposition, fact };
}

function validateOpenPullRequest(item, issue, fact, head) {
  if (item.state !== "open" || item.mergeCommit !== null)
    return { disposition: "pr-state-inconsistent", fact };
  const reviewReady =
    issue.lifecycle.length === 1 &&
    issue.lifecycle[0] === "status: ready for human review";
  if (reviewReady && (item.isDraft || item.mergeable !== "MERGEABLE"))
    return { disposition: "pr-review-state-ineligible", fact };
  const checksDisposition = requiredChecksDisposition(item, issue, head);
  return checksDisposition === null
    ? { fact, verified: true }
    : { disposition: checksDisposition, fact };
}

function validateAssociatedPullRequest(
  input,
  item,
  issue,
  fact,
  base,
  head,
  allowlistedMergers,
) {
  if (head.repository !== input.repository)
    return { disposition: "pr-head-repository-mismatch", fact };
  const paused =
    issue.lifecycle.length === 1 &&
    ["status: blocked", "status: waiting for user"].includes(
      issue.lifecycle[0],
    );
  if (item.state === "open" && !item.merged && paused)
    return { fact, verified: true };
  if (base.ref !== issue.target)
    return { disposition: "pull-request-target-mismatch", fact };
  if (item.headCommit?.verified !== true || item.headCommit?.reason !== "valid")
    return { disposition: "pr-head-signature-invalid", fact };
  return item.merged
    ? validateMergedPullRequest(
        input,
        item,
        issue,
        fact,
        head,
        allowlistedMergers,
      )
    : validateOpenPullRequest(item, issue, fact, head);
}

function pullRequestFact(input, item, issueByNumber, allowlistedMergers) {
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
    headRepository: head?.repository ?? null,
    isDraft: item?.isDraft ?? null,
    lifecycle,
    merged: item?.merged ?? null,
    mergeable: item?.mergeable ?? null,
    number: item?.number ?? null,
    state: item?.state ?? null,
    target: base?.ref ?? null,
  };
  if (!validPullRequestCore(item, associatedIssue, base, head))
    return {
      disposition: "pull-request-observation-malformed",
      fact: basicFact,
    };
  const issue = issueByNumber.get(associatedIssue);
  if (associatedIssue === undefined && !hasAssociationLocator)
    return item.state === "open"
      ? {
          disposition: "pull-request-association-missing",
          fact: basicFact,
        }
      : { fact: basicFact, verified: false };
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
    headRepository: head.repository,
    isDraft: item.isDraft,
    lifecycle,
    merged: item.merged,
    mergeable: item.mergeable,
    number: item.number,
    state: item.state,
    target: base.ref,
  };
  if (item.state === "closed" && item.merged === false) {
    return item.mergeCommit === null
      ? { fact, verified: false }
      : { disposition: "pr-state-inconsistent", fact };
  }
  return validateAssociatedPullRequest(
    input,
    item,
    issue,
    fact,
    base,
    head,
    allowlistedMergers,
  );
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

function collectPullRequestFacts(
  input,
  prepared,
  issueByNumber,
  allowlistedMergers,
) {
  const dispositions = [];
  const facts = [];
  const verified = [];
  for (const item of prepared.pullRequests) {
    const result = pullRequestFact(
      input,
      item,
      issueByNumber,
      allowlistedMergers,
    );
    facts.push(result.fact);
    if (result.disposition !== undefined)
      dispositions.push(
        disposition("pull-request", item?.number ?? 0, result.disposition),
      );
    if (result.verified === true) verified.push(result.fact);
  }
  facts.sort(compareNumber);
  return { dispositions, facts, verified };
}

function recordClosedIssue(state, issue, readiness, associated, current) {
  const finalDeliveries = associated.filter(
    (pullRequest) =>
      pullRequest.merged === true &&
      pullRequest.finalDeliveryValidated === true,
  );
  const completed =
    issue.stateReason === "completed" && finalDeliveries.length === 1;
  const classification = completed ? "completed" : "closed-without-completion";
  state.issueInventory.push(safeIssue(issue, classification, readiness));
  state.reconciliation.push({
    current,
    desired: completed ? ["status: done"] : [],
    kind: "issue",
    number: issue.number,
  });
  if (issue.stateReason === "completed" && !completed)
    state.dispositions.push(
      disposition("issue", issue.number, "completion-unverifiable"),
    );
}

function recordNonReadyIssue(state, issue, readiness) {
  state.issueInventory.push(safeIssue(issue, "not-current-ready", readiness));
  if (issue.contractFailure !== null) return;
  const reason =
    readiness.reason === "stale"
      ? "stale-readiness"
      : `readiness-${readiness.reason}`;
  state.dispositions.push(disposition("issue", issue.number, reason));
}

function recordPlanningExcludedIssue(state, issue, readiness, current) {
  state.issueInventory.push(safeIssue(issue, "planning-excluded", readiness));
  state.reconciliation.push({
    current,
    desired: current,
    kind: "issue",
    number: issue.number,
  });
}

function recordMigrationMember(
  state,
  issue,
  readiness,
  identity,
  linked,
  current,
) {
  const readinessUrl = readiness.url;
  const observation = {
    candidatePath: identity.candidatePath,
    fingerprint: issue.fingerprint,
    lifecycleLabels: [issue.lifecycle[0]],
    linkedPullRequest: linked,
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
  state.observations.push(observation);
  state.candidateInputs.push({
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
  state.issueInventory.push(safeIssue(issue, "migration-member", readiness));
  state.reconciliation.push({
    current,
    desired: [issue.lifecycle[0]],
    kind: "issue",
    number: issue.number,
  });
}

function recordReadyIssue(
  state,
  issue,
  readiness,
  associated,
  prepared,
  current,
) {
  if (issue.lifecycle.length !== 1 || !retainedStates.has(issue.lifecycle[0])) {
    state.issueInventory.push(
      safeIssue(issue, "lifecycle-unverifiable", readiness),
    );
    state.dispositions.push(
      disposition("issue", issue.number, "retained-lifecycle-invalid"),
    );
    return;
  }
  const tracked = prTrackedStates.has(issue.lifecycle[0]);
  const paused = ["status: blocked", "status: waiting for user"].includes(
    issue.lifecycle[0],
  );
  const openAssociated = associated.filter(
    (pullRequest) => pullRequest.state === "open" && !pullRequest.merged,
  );
  let topologyValid = openAssociated.length === 0;
  if (tracked) topologyValid = openAssociated.length === 1;
  else if (paused) topologyValid = openAssociated.length <= 1;
  if (!topologyValid) {
    state.issueInventory.push(
      safeIssue(issue, "linked-pr-unverifiable", readiness),
    );
    state.dispositions.push(
      disposition("issue", issue.number, "linked-pr-topology-invalid"),
    );
    return;
  }
  if (
    issue.lifecycle[0] === "status: in progress" &&
    issue.claim?.validated !== true
  ) {
    state.issueInventory.push(
      safeIssue(issue, "claim-unverifiable", readiness),
    );
    state.dispositions.push(
      disposition("issue", issue.number, "assignment-claim-invalid"),
    );
    return;
  }
  const identity = candidateIdentity(issue, prepared.contractBindings);
  if (identity.failure !== undefined) {
    state.issueInventory.push(
      safeIssue(issue, "contract-chain-unverifiable", readiness),
    );
    state.dispositions.push(
      disposition("issue", issue.number, identity.failure),
    );
    return;
  }
  const linked =
    tracked && openAssociated.length === 1
      ? {
          head: openAssociated[0].head,
          number: openAssociated[0].number,
          target: openAssociated[0].target,
        }
      : null;
  recordMigrationMember(state, issue, readiness, identity, linked, current);
}

function recordIssue(state, input, issue, prepared, verifiedPullRequests) {
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
  const planningState = issue.lifecycle[0];
  const planningExcluded =
    issue.state === "open" &&
    issue.lifecycle.length === 1 &&
    !readiness.current &&
    (["status: new", "status: blocked", "status: waiting for user"].includes(
      planningState,
    ) ||
      (planningState === "status: triaged" && issue.contractFailure === null));
  if (planningExcluded) {
    recordPlanningExcludedIssue(state, issue, readiness, current);
    return undefined;
  }
  if (issue.state === "closed") {
    if (issue.stateReason === "completed" && issue.contractFailure !== null)
      state.dispositions.push(
        disposition("issue", issue.number, issue.contractFailure),
      );
    recordClosedIssue(state, issue, readiness, associated, current);
    return undefined;
  }
  if (issue.contractFailure !== null)
    state.dispositions.push(
      disposition("issue", issue.number, issue.contractFailure),
    );
  if (!readiness.current) {
    recordNonReadyIssue(state, issue, readiness);
    return undefined;
  }
  recordReadyIssue(state, issue, readiness, associated, prepared, current);
  return undefined;
}

function compareReconciliation(left, right) {
  if (left.kind === right.kind) return left.number - right.number;
  return left.kind === "issue" ? -1 : 1;
}

function finalInventoryResult(input, state, pullRequestFacts) {
  state.dispositions.sort((left, right) =>
    left.kind === right.kind
      ? left.number - right.number || compareCodeUnits(left.code, right.code)
      : compareCodeUnits(left.kind, right.kind),
  );
  state.reconciliation.sort(compareReconciliation);
  state.observations.sort(compareNumber);
  state.candidateInputs.sort(compareNumber);
  const inventory = {
    issues: state.issueInventory.toSorted(compareNumber),
    protectedDev: input.protectedDev,
    pullRequests: pullRequestFacts,
    repository: input.repository,
  };
  if (state.dispositions.length !== 0) {
    return {
      candidateInputs: [],
      dispositions: state.dispositions,
      inventory,
      manifest: null,
      ok: true,
      publishable: false,
      receiptInput: null,
      reconciliation: state.reconciliation,
    };
  }
  const manifestBytes = canonicalBytes({
    entries: state.observations,
    predecessor: state.manifestIdentity.predecessor,
  });
  const digest = contractSha256(manifestBytes).digest;
  const manifest = {
    bytes: manifestBytes,
    digest,
    entries: state.observations,
    path: state.manifestIdentity.path,
    predecessor: state.manifestIdentity.predecessor,
  };
  return {
    candidateInputs: state.candidateInputs,
    dispositions: state.dispositions,
    inventory,
    manifest,
    ok: true,
    publishable: true,
    receiptInput: {
      candidateInputs: state.candidateInputs,
      observations: state.observations,
      target: "dev",
      terminalManifest: { digest, path: state.manifestIdentity.path },
    },
    reconciliation: state.reconciliation,
  };
}

function build(input) {
  const prepared = prepareSnapshot(input);
  if (prepared.ok !== true) return prepared;
  const issueByNumber = new Map(
    prepared.issueFacts.map((issue) => [issue.number, issue]),
  );
  const pullRequests = collectPullRequestFacts(
    input,
    prepared,
    issueByNumber,
    input.allowlistedMergers,
  );
  const state = {
    candidateInputs: [],
    dispositions: pullRequests.dispositions,
    issueInventory: [],
    observations: [],
    reconciliation: [],
    manifestIdentity: prepared.manifestIdentity,
  };
  for (const issue of prepared.issueFacts) {
    const failure = recordIssue(
      state,
      input,
      issue,
      prepared,
      pullRequests.verified,
    );
    if (failure !== undefined) return failure;
  }
  for (const pullRequest of pullRequests.facts) {
    state.reconciliation.push({
      current: [...pullRequest.lifecycle].sort(compareCodeUnits),
      desired: [],
      kind: "pull-request",
      number: pullRequest.number,
    });
  }
  return finalInventoryResult(input, state, pullRequests.facts);
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
