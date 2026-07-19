import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { githubRequestFor } from "./github-api.mjs";
import {
  pullRequestAcceptedTarget,
  pullRequestDeliveryIdentityMatches,
  pullRequestIssueNumber,
  validatePullRequestContract,
} from "./pr-contract.mjs";
import {
  LIFECYCLE_STATES,
  planStatusLabelReconciliation,
  validateTransitionRequest,
  validateProviderStatusLabels,
  verifyStatusLabelReadback,
} from "./issue-lifecycle.mjs";
import {
  evaluateClaimPrecondition,
  evaluateClaimRelease,
  evaluateClosurePrecondition,
  evaluateCurrentReadiness,
  evaluatePullRequestTopology,
} from "./issue-lifecycle-readiness.mjs";
import { readinessRecordFromComments } from "./issue-readiness-action.mjs";
import { semanticIssueFingerprint } from "./issue-contract.mjs";

const lifecycleActivationEnabled = "enabled";
const pullRequestContractSuccess = "success";
const githubActionsAppId = "15368";
const githubRequest = githubRequestFor("keiko-native-issue-lifecycle");
const assignmentClaimPermissions = new Set(["admin", "maintain", "write"]);
const devHumanMergers = new Set(["niko4417", "oscharko"]);
const READY = LIFECYCLE_STATES[2];
const PR_OPEN = LIFECYCLE_STATES[4];
const REVIEW = LIFECYCLE_STATES[5];

function labelNames(issue) {
  return Array.isArray(issue?.labels)
    ? issue.labels.map((label) =>
        typeof label === "string" ? label : label?.name,
      )
    : undefined;
}

function statusLabels(issue) {
  return (labelNames(issue) ?? []).filter((name) =>
    name?.startsWith("status: "),
  );
}

function eventIssueNumber(event) {
  return (
    event?.issue?.number ?? pullRequestIssueNumber(event?.pull_request?.body)
  );
}

function labelRequestTarget(event) {
  const label = event?.label?.name;
  if (event?.action !== "labeled" || !label?.startsWith("status: "))
    return undefined;
  return label;
}

function hasTransitionRequest(event) {
  return (
    event?.transitionRequest !== undefined &&
    event.transitionRequest !== null &&
    typeof event.transitionRequest === "object"
  );
}

function transitionRequestFailures(event, currentState, requestedTarget) {
  const transition = event?.transitionRequest ?? {};
  return validateTransitionRequest({
    actorRole: transition.actorRole,
    blockingCondition: transition.blockingCondition,
    currentState,
    eventIdentity: transition.eventIdentity,
    humanInput: transition.humanInput,
    requestedSource: transition.requestedSource ?? currentState,
    requestedTarget,
  }).failures;
}

function currentLifecycleState(issue, event) {
  const states = statusLabels(issue);
  const requestedSource = event?.transitionRequest?.requestedSource;
  return states.includes(requestedSource) ? requestedSource : states[0];
}

function hasSoleLifecycleState(issue, state) {
  const states = statusLabels(issue);
  return states.length === 1 && states[0] === state;
}

function assignedLogins(issue) {
  return new Set(
    (Array.isArray(issue?.assignees) ? issue.assignees : [])
      .map((assignee) => assignee?.login)
      .filter((login) => typeof login === "string" && login.trim() !== ""),
  );
}

function assignmentClaimCandidate(event, issue) {
  const actor = event?.sender?.login;
  const assignee = event?.assignee?.login;
  if (typeof actor !== "string" || typeof assignee !== "string")
    return undefined;
  if (!assignedLogins(issue).has(assignee)) return undefined;
  return {
    id: `${issueIdentity(issue)}:assignment:${assignee}`,
    validated: true,
  };
}

async function actorCanClaimAssignment(repository, actor, request) {
  if (typeof actor !== "string" || actor.trim() === "") return false;
  try {
    const result = await request(
      `/repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`,
    );
    return assignmentClaimPermissions.has(result?.permission);
  } catch {
    return false;
  }
}

async function derivedAssignmentClaim({ event, issue, repository, request }) {
  const claim = assignmentClaimCandidate(event, issue);
  if (claim === undefined) return undefined;
  return (await actorCanClaimAssignment(
    repository,
    event.sender.login,
    request,
  ))
    ? claim
    : undefined;
}

function derivedAssignmentRelease(event, issue) {
  const actor = event?.sender?.login;
  const assignee = event?.assignee?.login;
  if (typeof actor !== "string" || typeof assignee !== "string")
    return undefined;
  if (assignedLogins(issue).has(assignee)) return undefined;
  return {
    id: `${issueIdentity(issue)}:assignment-release:${assignee}`,
    validated: true,
  };
}

function retainedAssignmentClaim(issue) {
  const [assignee] = [...assignedLogins(issue)].sort((left, right) =>
    left.localeCompare(right),
  );
  return assignee === undefined
    ? undefined
    : {
        id: `${issueIdentity(issue)}:assignment:${assignee}`,
        validated: true,
      };
}

function pullRequestIdentity(pullRequest) {
  if (
    typeof pullRequest?.node_id === "string" &&
    pullRequest.node_id.trim() !== ""
  )
    return pullRequest.node_id;
  if (
    Number.isInteger(pullRequest?.id) ||
    (typeof pullRequest?.id === "string" && pullRequest.id.trim() !== "")
  )
    return String(pullRequest.id);
  return undefined;
}

function pullRequestEvidence(event, issueNumber) {
  const pullRequest = event?.pull_request;
  const id = pullRequestIdentity(pullRequest);
  const headSha = pullRequest?.head?.sha;
  return {
    id,
    validated:
      id !== undefined &&
      pullRequestIssueNumber(pullRequest?.body) === issueNumber &&
      /^[0-9a-f]{40}$/u.test(headSha ?? ""),
  };
}

function pullRequestLifecycleEvent(event) {
  if (event?.pull_request === undefined) return undefined;
  if (["opened", "reopened"].includes(event.action)) return event.action;
  if (event.action === "ready_for_review") return "opened";
  if (event.action === "synchronize") return "opened";
  if (event.action === "converted_to_draft") return "opened";
  if (event.action === "closed" && event.pull_request?.merged === true)
    return "closed_merged";
  if (event.action === "closed" && event.pull_request?.merged !== true)
    return "closed_unmerged";
  return undefined;
}

function hasTrustedPullRequestContractSuccess(event) {
  return (
    event?.prContract?.validated === true ||
    process.env.KEIKO_PR_CONTRACT_RESULT === pullRequestContractSuccess
  );
}

function hasRetainedPullRequestContractSuccess(event, result) {
  return (
    event?.otherOpenPullRequest?.id === result.pullRequestId &&
    event.otherOpenPullRequest.contractValidated === true
  );
}

function requiresRetainedPullRequestContract(event, result) {
  return (
    result.pullRequestId !== undefined &&
    result.pullRequestId !== pullRequestIdentity(event?.pull_request)
  );
}

function pullRequestContractSucceeded({ event, prEvent, result }) {
  if (prEvent === "closed_merged")
    return (
      event.currentMergedPullRequest?.validated === true &&
      hasTrustedPullRequestContractSuccess(event)
    );
  if (requiresRetainedPullRequestContract(event, result))
    return hasRetainedPullRequestContractSuccess(event, result);
  return hasTrustedPullRequestContractSuccess(event);
}

function unauthorizedRawLabelResult(enabled) {
  return enabled
    ? {
        failures: [
          "Lifecycle label events require explicit transition authority.",
        ],
        outcome: "failed",
      }
    : { outcome: "ignored", reason: "raw_lifecycle_label_event" };
}

function desiredStateForLabelEvent(event, currentState, enabled, readiness) {
  const requestedTarget = labelRequestTarget(event);
  if (requestedTarget === undefined) return undefined;
  if (!hasTransitionRequest(event)) return unauthorizedRawLabelResult(enabled);
  const failures = [
    ...transitionRequestFailures(event, currentState, requestedTarget),
  ];
  if (requestedTarget === READY && readiness.current !== true)
    failures.push("current_readiness_required");
  return failures.length > 0
    ? { failures, outcome: "failed" }
    : { desiredState: requestedTarget };
}

function desiredStateForClosure(event, issue) {
  if (event?.action !== "closed") return undefined;
  if (issue?.state !== "closed")
    return { failures: ["current_closed_state_required"], outcome: "failed" };
  const closure = evaluateClosurePrecondition({
    completionEvidence: event.completionEvidence,
    reason: issue.state_reason,
  });
  if (!closure.ok) return { failures: [closure.reason], outcome: "failed" };
  return closure.removeLifecycleLabels === true
    ? { removeLifecycleLabels: true }
    : { desiredState: closure.target };
}

function inertMissingAuthorityResult(reason, enabled) {
  return enabled ? { failures: [reason], outcome: "failed" } : undefined;
}

function desiredStateForClaimEvent(
  event,
  readiness,
  currentState,
  enabled,
  issue,
) {
  if (event?.action === "assigned") {
    const claim = event.claim;
    const result = evaluateClaimPrecondition({
      claim,
      readiness,
      sourceState: currentState,
    });
    if (result.ok) return { desiredState: result.target };
    return claim === undefined
      ? inertMissingAuthorityResult(result.reason, enabled)
      : { failures: [result.reason], outcome: "failed" };
  }
  if (event?.action === "unassigned") {
    const release = event.release ?? derivedAssignmentRelease(event, issue);
    const result = evaluateClaimRelease({
      hasOpenPullRequest: event.hasOpenPullRequest,
      readiness,
      release,
      sourceState: currentState,
    });
    if (result.ok) return { desiredState: result.target };
    return release === undefined
      ? inertMissingAuthorityResult(result.reason, enabled)
      : { failures: [result.reason], outcome: "failed" };
  }
  return undefined;
}

function desiredStateForPullRequestEvent({
  currentState,
  enabled,
  event,
  issueNumber,
  readiness,
}) {
  const prEvent = pullRequestLifecycleEvent(event);
  if (prEvent === undefined) return undefined;
  const result = evaluatePullRequestTopology({
    claim: event.claim,
    event: prEvent,
    otherOpenPullRequest: event.otherOpenPullRequest,
    pullRequest:
      prEvent === "closed_merged"
        ? event.currentMergedPullRequest
        : pullRequestEvidence(event, issueNumber),
    readiness,
    sourceState: currentState,
  });
  if (result.ok) {
    const reviewDemotion =
      currentState === REVIEW &&
      result.target === PR_OPEN &&
      ["synchronize", "converted_to_draft"].includes(event.action);
    if (
      reviewDemotion &&
      (event.currentPullRequest?.validated !== true ||
        event.otherOpenPullRequest !== undefined)
    )
      return enabled
        ? {
            failures: ["current_pull_request_evidence_required"],
            outcome: "failed",
          }
        : {
            outcome: "ignored",
            reason: "pre_activation_current_pull_request_required",
          };
    const targetRequiresContract =
      prEvent === "closed_merged" ||
      ([PR_OPEN, REVIEW].includes(result.target) && !reviewDemotion);
    const contractSucceeded = pullRequestContractSucceeded({
      event,
      prEvent,
      result,
    });
    if (targetRequiresContract && !contractSucceeded) {
      return enabled
        ? { failures: ["pr_contract_success_required"], outcome: "failed" }
        : { outcome: "ignored", reason: "pre_activation_pr_contract_required" };
    }
    return {
      closeIssue: result.closeIssue === true,
      desiredState: result.target,
    };
  }
  if (!enabled)
    return { outcome: "ignored", reason: "pre_activation_pr_topology" };
  return { failures: [result.reason], outcome: "failed" };
}

function desiredStateForEvent(
  event,
  readiness,
  currentState,
  enabled,
  issue,
  issueNumber,
) {
  if (event?.pull_request !== undefined)
    return (
      desiredStateForPullRequestEvent({
        currentState,
        enabled,
        event,
        issueNumber,
        readiness,
      }) ?? {}
    );
  if (event?.action === "reopened")
    return { desiredState: LIFECYCLE_STATES[0] };
  if (event?.action === "edited" && readiness.current !== true)
    return { desiredState: LIFECYCLE_STATES[0] };
  return (
    desiredStateForLabelEvent(event, currentState, enabled, readiness) ??
    desiredStateForClaimEvent(event, readiness, currentState, enabled, issue) ??
    desiredStateForClosure(event, issue) ??
    {}
  );
}

function failed(failures) {
  return { failures, outcome: "failed" };
}

async function allIssueComments(repository, issueNumber, request) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(
      `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch))
      throw new Error("Issue comments response is malformed.");
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

async function allProviderLabels(repository, request) {
  const labels = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(
      `/repos/${repository}/labels?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch))
      throw new Error("Provider labels response is malformed.");
    labels.push(...batch.map((label) => label?.name));
    if (batch.length < 100) return labels;
  }
}

function linkedPullRequestEvidence(pullRequest, issueNumber, excludeId) {
  const id = pullRequestIdentity(pullRequest);
  const headSha = pullRequest?.head?.sha;
  if (
    id === undefined ||
    id === excludeId ||
    pullRequestIssueNumber(pullRequest?.body) !== issueNumber ||
    !/^[0-9a-f]{40}$/u.test(headSha ?? "")
  )
    return undefined;
  return { headSha, id, validated: true };
}

async function requiredPullRequestStatusesSucceeded(
  repository,
  headSha,
  request,
  requiredContexts,
) {
  try {
    const status = await request(
      `/repos/${repository}/commits/${headSha}/status`,
    );
    if (
      status?.sha !== headSha ||
      status?.repository?.full_name !== repository ||
      !Array.isArray(status?.statuses)
    )
      return false;
    return requiredContexts.every((context) => {
      const current = status.statuses.find(
        (entry) => entry?.context === context,
      );
      return (
        current?.state === "success" && statusProducedByGitHubActions(current)
      );
    });
  } catch {
    return false;
  }
}

function statusProducedByGitHubActions(status) {
  try {
    const avatar = new URL(status?.avatar_url);
    return (
      avatar.protocol === "https:" &&
      avatar.hostname === "avatars.githubusercontent.com" &&
      avatar.pathname === `/in/${githubActionsAppId}`
    );
  } catch {
    return false;
  }
}

function retainedPullRequestStatusesSucceeded(repository, headSha, request) {
  return requiredPullRequestStatusesSucceeded(repository, headSha, request, [
    "PR contract",
    "Issue contract current",
  ]);
}

async function firstValidatedLinkedOpenPullRequest(
  repository,
  issueNumber,
  request,
  excludeId,
) {
  for (let page = 1; ; page += 1) {
    const batch = await request(
      `/repos/${repository}/pulls?state=open&per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch))
      throw new Error("Open pull requests response is malformed.");
    for (const pullRequest of batch) {
      const linked = linkedPullRequestEvidence(
        pullRequest,
        issueNumber,
        excludeId,
      );
      if (
        linked !== undefined &&
        (await retainedPullRequestStatusesSucceeded(
          repository,
          linked.headSha,
          request,
        ))
      )
        return { contractValidated: true, id: linked.id, validated: true };
    }
    if (batch.length < 100) return undefined;
  }
}

function acceptedDeliveryBoundary(pullRequest) {
  const target = pullRequestAcceptedTarget(pullRequest?.body);
  if (target !== pullRequest?.base?.ref) return false;
  if (target !== "dev") return true;
  return devHumanMergers.has(pullRequest?.merged_by?.login?.toLowerCase());
}

function terminalLifecycleActivation(issue) {
  return [REVIEW, LIFECYCLE_STATES[8]].some((state) =>
    hasSoleLifecycleState(issue, state),
  )
    ? "enabled"
    : "disabled";
}

function finalDeliveryDetailMatches({
  comments,
  detail,
  issue,
  issueNumber,
  linked,
  pullRequest,
  repository,
}) {
  if (detail?.number !== pullRequest.number) return false;
  if (detail?.merged !== true || detail?.state !== "closed") return false;
  if (!Number.isFinite(Date.parse(detail?.updated_at ?? ""))) return false;
  if (detail?.head?.sha !== linked.headSha) return false;
  if (linkedPullRequestEvidence(detail, issueNumber)?.id !== linked.id)
    return false;
  if (!acceptedDeliveryBoundary(detail)) return false;
  return (
    validatePullRequestContract({
      comments,
      issue,
      lifecycleActivation: terminalLifecycleActivation(issue),
      pullRequest: detail,
      repository,
      terminalDelivery: true,
    }).failures.length === 0
  );
}

async function finalDeliveryCandidateEvidence({
  comments,
  issue,
  issueNumber,
  pullRequest,
  repository,
  request,
}) {
  const linked = linkedPullRequestEvidence(pullRequest, issueNumber);
  if (linked === undefined || !Number.isInteger(pullRequest?.number))
    return undefined;
  const detail = await request(
    `/repos/${repository}/pulls/${pullRequest.number}`,
  );
  if (
    !finalDeliveryDetailMatches({
      comments,
      detail,
      issue,
      issueNumber,
      linked,
      pullRequest,
      repository,
    })
  )
    return undefined;
  return (await retainedPullRequestStatusesSucceeded(
    repository,
    linked.headSha,
    request,
  ))
    ? { headSha: linked.headSha, id: linked.id, validated: true }
    : undefined;
}

async function finalDeliveryEvidence({
  comments,
  issue,
  issueNumber,
  repository,
  request,
}) {
  for (let page = 1; ; page += 1) {
    const batch = await request(
      `/repos/${repository}/pulls?state=closed&per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch))
      throw new Error("Closed pull requests response is malformed.");
    for (const pullRequest of batch) {
      const evidence = await finalDeliveryCandidateEvidence({
        comments,
        issue,
        issueNumber,
        pullRequest,
        repository,
        request,
      });
      if (evidence !== undefined) return evidence;
    }
    if (batch.length < 100) return undefined;
  }
}

function needsOtherOpenPullRequestEvidence(event) {
  return (
    event?.pull_request !== undefined &&
    event.action === "closed" &&
    event.pull_request?.merged !== true &&
    event.otherOpenPullRequest === undefined
  );
}

function needsRetainedClaimEvidence(event) {
  return (
    event?.pull_request !== undefined &&
    event.action === "closed" &&
    event.pull_request?.merged !== true &&
    event.claim === undefined
  );
}

function needsCurrentPullRequestEvidence(event) {
  return (
    event?.pull_request !== undefined &&
    ["synchronize", "converted_to_draft"].includes(event.action)
  );
}

function needsMergedPullRequestEvidence(event) {
  return (
    event?.pull_request !== undefined &&
    event.action === "closed" &&
    event.pull_request?.merged === true
  );
}

async function currentMergedPullRequestEvidence(
  event,
  issue,
  repository,
  request,
) {
  const eventPullRequest = event.pull_request;
  const number = eventPullRequest?.number;
  if (!Number.isInteger(number)) return { validated: false };
  try {
    const current = await request(`/repos/${repository}/pulls/${number}`);
    const currentIdentity = pullRequestIdentity(current);
    const eventIdentity = pullRequestIdentity(eventPullRequest);
    const currentUpdatedAt = Date.parse(current?.updated_at ?? "");
    const issueUpdatedAt = Date.parse(issue?.updated_at ?? "");
    const headSha = current?.head?.sha;
    const completedIssue =
      issue?.state === "closed" &&
      issue?.state_reason === "completed" &&
      (hasSoleLifecycleState(issue, REVIEW) ||
        hasSoleLifecycleState(issue, LIFECYCLE_STATES[8]));
    const validated =
      current?.number === number &&
      currentIdentity !== undefined &&
      currentIdentity === eventIdentity &&
      current?.base?.ref === eventPullRequest?.base?.ref &&
      current?.head?.sha === eventPullRequest?.head?.sha &&
      current?.head?.ref === eventPullRequest?.head?.ref &&
      current?.body === eventPullRequest?.body &&
      current?.state === "closed" &&
      current?.merged === true &&
      eventPullRequest?.state === "closed" &&
      eventPullRequest?.merged === true &&
      current?.updated_at === eventPullRequest?.updated_at &&
      Number.isFinite(currentUpdatedAt) &&
      Number.isFinite(issueUpdatedAt) &&
      (completedIssue || currentUpdatedAt > issueUpdatedAt) &&
      pullRequestDeliveryIdentityMatches({ issue, pullRequest: current }) &&
      acceptedDeliveryBoundary(current) &&
      /^[0-9a-f]{40}$/u.test(headSha ?? "") &&
      (await retainedPullRequestStatusesSucceeded(
        repository,
        headSha,
        request,
      ));
    return {
      completedIssue,
      id: validated ? currentIdentity : undefined,
      validated,
    };
  } catch {
    return { validated: false };
  }
}

async function currentPullRequestEvidence(event, issue, repository, request) {
  const eventPullRequest = event.pull_request;
  const number = eventPullRequest?.number;
  if (!Number.isInteger(number)) return { validated: false };
  try {
    const current = await request(`/repos/${repository}/pulls/${number}`);
    const currentUpdatedAt = Date.parse(current?.updated_at ?? "");
    const issueUpdatedAt = Date.parse(issue?.updated_at ?? "");
    return {
      validated:
        current?.number === number &&
        pullRequestIdentity(current) ===
          pullRequestIdentity(eventPullRequest) &&
        current?.base?.ref === eventPullRequest?.base?.ref &&
        current?.head?.sha === eventPullRequest?.head?.sha &&
        current?.head?.ref === eventPullRequest?.head?.ref &&
        current?.body === eventPullRequest?.body &&
        current?.state === "open" &&
        current?.draft === eventPullRequest?.draft &&
        current?.updated_at === eventPullRequest?.updated_at &&
        Number.isFinite(currentUpdatedAt) &&
        Number.isFinite(issueUpdatedAt) &&
        currentUpdatedAt > issueUpdatedAt &&
        pullRequestDeliveryIdentityMatches({ issue, pullRequest: current }),
    };
  } catch {
    return { validated: false };
  }
}

async function eventWithDerivedEvidence({
  comments,
  event,
  issue,
  issueNumber,
  repository,
  request,
}) {
  let evidencedEvent = event;
  if (event?.action === "assigned" && event.claim === undefined) {
    const claim = await derivedAssignmentClaim({
      event,
      issue,
      repository,
      request,
    });
    if (claim !== undefined) evidencedEvent = { ...evidencedEvent, claim };
  }
  if (event?.action === "unassigned" && event.hasOpenPullRequest === undefined)
    evidencedEvent = {
      ...evidencedEvent,
      hasOpenPullRequest:
        (await firstValidatedLinkedOpenPullRequest(
          repository,
          issueNumber,
          request,
        )) !== undefined,
    };
  if (
    event?.pull_request === undefined &&
    event?.action === "closed" &&
    issue?.state_reason === "completed"
  )
    evidencedEvent = {
      ...evidencedEvent,
      completionEvidence: [REVIEW, LIFECYCLE_STATES[8]].some((state) =>
        hasSoleLifecycleState(issue, state),
      )
        ? await finalDeliveryEvidence({
            comments,
            issue,
            issueNumber,
            repository,
            request,
          })
        : undefined,
    };
  if (needsOtherOpenPullRequestEvidence(event)) {
    const otherOpenPullRequest = await firstValidatedLinkedOpenPullRequest(
      repository,
      issueNumber,
      request,
      pullRequestIdentity(event.pull_request),
    );
    if (otherOpenPullRequest !== undefined)
      evidencedEvent = { ...evidencedEvent, otherOpenPullRequest };
  }
  if (needsRetainedClaimEvidence(event)) {
    const claim = retainedAssignmentClaim(issue);
    if (claim !== undefined) evidencedEvent = { ...evidencedEvent, claim };
  }
  if (needsCurrentPullRequestEvidence(event))
    evidencedEvent = {
      ...evidencedEvent,
      currentPullRequest: await currentPullRequestEvidence(
        event,
        issue,
        repository,
        request,
      ),
      otherOpenPullRequest: await firstValidatedLinkedOpenPullRequest(
        repository,
        issueNumber,
        request,
        pullRequestIdentity(event.pull_request),
      ),
    };
  if (needsMergedPullRequestEvidence(event))
    evidencedEvent = {
      ...evidencedEvent,
      currentMergedPullRequest: await currentMergedPullRequestEvidence(
        event,
        issue,
        repository,
        request,
      ),
    };
  return evidencedEvent;
}

async function reloadIssue(repository, issueNumber, request) {
  const issue = await request(`/repos/${repository}/issues/${issueNumber}`);
  if (
    issue?.number !== issueNumber ||
    typeof issue?.title !== "string" ||
    issueIdentity(issue) === undefined
  )
    throw new Error("Reloaded issue response is malformed.");
  return issue;
}

async function removeLabel(repository, issueNumber, label, request) {
  try {
    await request(
      `/repos/${repository}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      { method: "DELETE" },
    );
  } catch (error) {
    if (!error.message.includes("failed with 404")) throw error;
  }
}

async function addLabels(repository, issueNumber, labels, request) {
  if (labels.length === 0) return;
  await request(`/repos/${repository}/issues/${issueNumber}/labels`, {
    method: "POST",
    payload: { labels },
  });
}

async function closeIssueAsCompleted({
  desiredState,
  issue,
  issueNumber,
  repository,
  request,
}) {
  const labels = labelNames(issue);
  if (!Array.isArray(labels))
    return {
      failures: ["Issue labels are unavailable for completed closure."],
      ok: false,
    };
  const desiredLabels = [
    ...labels.filter((label) => !label?.startsWith("status: ")),
    desiredState,
  ];
  await request(`/repos/${repository}/issues/${issueNumber}`, {
    method: "PATCH",
    payload: {
      labels: desiredLabels,
      state: "closed",
      state_reason: "completed",
    },
  });
  const readback = await reloadIssue(repository, issueNumber, request);
  const statusReadback = verifyStatusLabelReadback({
    actualIssueIdentity: issueIdentity(readback),
    desiredState,
    expectedIssueIdentity: issueIdentity(issue),
    labels: labelNames(readback),
  });
  return statusReadback.ok &&
    readback.state === "closed" &&
    readback.state_reason === "completed"
    ? { issue: readback, ok: true }
    : {
        failures: ["Completed issue closure read-back did not match."],
        ok: false,
      };
}

function planLifecycleLabelRemoval(issue) {
  const labels = labelNames(issue);
  if (!Array.isArray(labels))
    return {
      apply: [],
      failures: ["Issue lifecycle labels are unavailable."],
      ok: false,
      remove: [],
    };
  return {
    apply: [],
    failures: [],
    ok: true,
    remove: labels.filter((name) => name?.startsWith("status: ")),
  };
}

function verifyLifecycleLabelRemoval({
  actualIssueIdentity,
  expectedIssueIdentity,
  labels,
}) {
  const failures = [];
  if (actualIssueIdentity !== expectedIssueIdentity)
    failures.push("Issue identity changed during lifecycle reconciliation.");
  if (!Array.isArray(labels))
    failures.push("Issue lifecycle read-back labels are unavailable.");
  const remaining = Array.isArray(labels)
    ? labels.filter((name) => name?.startsWith("status: "))
    : [];
  if (remaining.length > 0)
    failures.push("Issue lifecycle read-back still contains status labels.");
  return failures.length === 0 ? { ok: true } : { failures, ok: false };
}

function issueIdentity(issue) {
  if (typeof issue?.node_id === "string" && issue.node_id.trim() !== "")
    return issue.node_id;
  if (
    Number.isInteger(issue?.id) ||
    (typeof issue?.id === "string" && issue.id.trim() !== "")
  )
    return String(issue.id);
  return undefined;
}

function readinessEvent(event) {
  if (event?.pull_request !== undefined) return { action: "pull_request" };
  return event.action === "edited"
    ? { action: "edited", editKind: event.editKind }
    : { action: event.action };
}

function evaluateReadinessForIssue({ comments, event, issue }) {
  const expectedCommentId =
    event.expectedReadinessCommentId ??
    readinessRecordFromComments(comments)?.commentId;
  return evaluateCurrentReadiness({
    comments,
    currentFingerprint: semanticIssueFingerprint(issue.body ?? "", issue.title),
    currentVersion: /^- Contract version: `([^`]+)`$/mu.exec(
      issue.body ?? "",
    )?.[1],
    event: readinessEvent(event),
    expectedCommentId,
  });
}

function enabledLifecycleActivation() {
  return (
    process.env.KEIKO_ISSUE_LIFECYCLE_ACTIVATION === lifecycleActivationEnabled
  );
}

function ignoredDesiredResult(desired, readiness) {
  if (desired?.outcome !== "ignored") return undefined;
  return {
    failures: [],
    outcome: "ignored",
    readiness,
    reason: desired.reason,
  };
}

function exactLifecycleLabelFailure(issue) {
  return statusLabels(issue).length === 1
    ? undefined
    : failed(["Issue lifecycle reload must contain exactly one status label."]);
}

async function reconcileLifecycleRemoval({
  enabled,
  issue,
  issueNumber,
  now,
  readiness,
  repository,
  request,
}) {
  const reconciliation = planLifecycleLabelRemoval(issue);
  if (!reconciliation.ok) return failed(reconciliation.failures);
  if (!enabled)
    return {
      activation: "disabled",
      now: now.toISOString(),
      outcome: "planned",
      plan: reconciliation,
      readiness,
      removeLifecycleLabels: true,
    };
  for (const label of reconciliation.remove)
    await removeLabel(repository, issueNumber, label, request);
  const readback = await reloadIssue(repository, issueNumber, request);
  const verified = verifyLifecycleLabelRemoval({
    actualIssueIdentity: issueIdentity(readback),
    expectedIssueIdentity: issueIdentity(issue),
    labels: labelNames(readback),
  });
  return verified.ok
    ? { outcome: "applied", plan: reconciliation, removeLifecycleLabels: true }
    : failed(verified.failures);
}

async function reconcileDesiredStatus({
  closeIssue,
  desiredState,
  enabled,
  issue,
  issueNumber,
  now,
  readiness,
  repository,
  request,
}) {
  if (desiredState === undefined) {
    const labelFailure = exactLifecycleLabelFailure(issue);
    if (labelFailure !== undefined) return labelFailure;
    return { failures: [], outcome: "ignored", readiness };
  }

  const reconciliation = planStatusLabelReconciliation(
    labelNames(issue),
    desiredState,
  );
  if (!reconciliation.ok) return failed(reconciliation.failures);
  if (!enabled)
    return {
      activation: "disabled",
      closeIssue,
      desiredState,
      now: now.toISOString(),
      outcome: "planned",
      plan: reconciliation,
      readiness,
    };

  if (closeIssue === true) {
    const closure = await closeIssueAsCompleted({
      desiredState,
      issue,
      issueNumber,
      repository,
      request,
    });
    return closure.ok
      ? { closeIssue, desiredState, outcome: "applied", plan: reconciliation }
      : failed(closure.failures);
  }

  for (const label of reconciliation.remove)
    await removeLabel(repository, issueNumber, label, request);
  await addLabels(repository, issueNumber, reconciliation.apply, request);
  const readback = await reloadIssue(repository, issueNumber, request);
  const verified = verifyStatusLabelReadback({
    actualIssueIdentity: issueIdentity(readback),
    desiredState,
    expectedIssueIdentity: issueIdentity(issue),
    labels: labelNames(readback),
  });
  return verified.ok
    ? { closeIssue, desiredState, outcome: "applied", plan: reconciliation }
    : failed(verified.failures);
}

export async function runIssueLifecycleAction({
  event,
  now = new Date(),
  request = githubRequest,
} = {}) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (typeof repository !== "string" || !repository.includes("/"))
    throw new Error("GITHUB_REPOSITORY is missing or invalid.");
  if (event?.issue?.pull_request !== undefined)
    return { outcome: "ignored", reason: "pull_request_issue" };
  const issueNumber = eventIssueNumber(event);
  if (!Number.isInteger(issueNumber))
    throw new Error("Issue number is missing.");

  const [issue, comments, providerLabels] = await Promise.all([
    reloadIssue(repository, issueNumber, request),
    allIssueComments(repository, issueNumber, request),
    allProviderLabels(repository, request),
  ]);
  const providerValidation = validateProviderStatusLabels(providerLabels);
  if (!providerValidation.ok) return failed(providerValidation.failures);
  if (event?.pull_request !== undefined) {
    const labelFailure = exactLifecycleLabelFailure(issue);
    if (labelFailure !== undefined) return labelFailure;
  }
  const currentState = currentLifecycleState(issue, event);

  const readiness = evaluateReadinessForIssue({
    comments,
    event,
    issue,
  });
  const enabled = enabledLifecycleActivation();
  const evidencedEvent = await eventWithDerivedEvidence({
    comments,
    event,
    issue,
    issueNumber,
    repository,
    request,
  });
  const desired = desiredStateForEvent(
    evidencedEvent,
    readiness,
    currentState,
    enabled,
    issue,
    issueNumber,
  );
  if (desired?.outcome === "failed") return desired;
  const ignored = ignoredDesiredResult(desired, readiness);
  if (ignored !== undefined) return ignored;
  if (desired.removeLifecycleLabels === true)
    return reconcileLifecycleRemoval({
      enabled,
      issue,
      issueNumber,
      now,
      readiness,
      repository,
      request,
    });
  return reconcileDesiredStatus({
    closeIssue: desired.closeIssue === true,
    desiredState: desired.desiredState,
    enabled,
    issue,
    issueNumber,
    now,
    readiness,
    repository,
    request,
  });
}

export async function runIssueLifecycleCli({
  eventPath = process.env.GITHUB_EVENT_PATH,
  output = process.stdout,
  request = githubRequest,
} = {}) {
  if (typeof eventPath !== "string" || eventPath.trim() === "")
    throw new Error("GITHUB_EVENT_PATH is missing.");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const result = await runIssueLifecycleAction({ event, request });
  output.write(`issue-lifecycle: ${result.outcome}\n`);
  if (result.outcome === "failed")
    throw new Error(`Issue lifecycle failed: ${result.failures.join("; ")}`);
  return result;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runIssueLifecycleCli();
}
