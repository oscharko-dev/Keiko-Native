import { appendFile, readFile } from "node:fs/promises";
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
  evaluateResumePrecondition,
} from "./issue-lifecycle-readiness.mjs";
import { readinessRecordFromComments } from "./issue-readiness-action.mjs";
import {
  issueSchemaForLabels,
  semanticIssueFingerprint,
} from "./issue-contract.mjs";
import {
  LIFECYCLE_OBSERVATION_MARKER,
  lifecycleObservation,
  lifecycleObservationComment,
  lifecycleRequestReplay,
  parseLifecycleDispatchRequest,
  trustedLifecycleObservation,
} from "./issue-lifecycle-request.mjs";

const lifecycleActivationEnabled = "enabled";
const pullRequestContractSuccess = "success";
const githubActionsAppId = "15368";
const maxProviderPages = 100;
const githubRequest = githubRequestFor("keiko-native-issue-lifecycle");
const assignmentClaimPermissions = new Set(["admin", "maintain", "write"]);
const planningRequestPermissions = new Set([
  "admin",
  "maintain",
  "triage",
  "write",
]);
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

async function pullRequestEventAuthorityFailures(repository, event, request) {
  const actor = event?.sender?.login;
  const pullRequest = event?.pull_request;
  const failures = [];
  if (
    typeof actor !== "string" ||
    !(await actorCanClaimAssignment(repository, actor, request))
  )
    failures.push("pull_request_actor_not_authorized");
  if (
    pullRequest?.head?.repo?.full_name !== repository ||
    pullRequest?.base?.repo?.full_name !== repository
  )
    failures.push("pull_request_repository_not_authorized");
  return failures;
}

function isLifecycleDispatch(event) {
  return (
    event?.inputs !== undefined &&
    event.inputs !== null &&
    typeof event.inputs === "object" &&
    event?.pull_request === undefined &&
    event?.issue === undefined
  );
}

function dispatchContextFromEnvironment() {
  return {
    actor: process.env.GITHUB_ACTOR,
    protectedRef: process.env.GITHUB_REF,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    runId: process.env.GITHUB_RUN_ID,
  };
}

async function dispatchActorRole(repository, dispatch, request) {
  let permission;
  try {
    const result = await request(
      `/repos/${repository}/collaborators/${encodeURIComponent(dispatch.actor)}/permission`,
    );
    permission = result?.permission;
  } catch {
    return undefined;
  }
  if (
    devHumanMergers.has(dispatch.actor.toLowerCase()) &&
    assignmentClaimPermissions.has(permission)
  )
    return "maintainer";
  if (
    [LIFECYCLE_STATES[1], LIFECYCLE_STATES[2]].includes(
      dispatch.requestedTarget,
    ) &&
    ![LIFECYCLE_STATES[6], LIFECYCLE_STATES[7]].includes(
      dispatch.expectedSource,
    )
  )
    return planningRequestPermissions.has(permission) ? "planner" : undefined;
  return assignmentClaimPermissions.has(permission) ? "implementer" : undefined;
}

function eventForLifecycleDispatch(dispatch, actorRole) {
  return {
    action: "labeled",
    issue: { number: dispatch.issueNumber },
    label: { name: dispatch.requestedTarget },
    sender: { login: dispatch.actor },
    transitionRequest: {
      actorRole,
      blockingCondition:
        dispatch.requestedTarget === LIFECYCLE_STATES[6]
          ? dispatch.reason
          : undefined,
      eventIdentity: dispatch.eventIdentity,
      humanInput:
        dispatch.requestedTarget === LIFECYCLE_STATES[7]
          ? dispatch.reason
          : undefined,
      requestedSource: dispatch.expectedSource,
    },
  };
}

function dispatchAuthorityFailures({ actorRole, dispatch, issue }) {
  const states = statusLabels(issue);
  const failures = [];
  if (actorRole === undefined) failures.push("actor_not_authorized");
  if (states.length !== 1) failures.push("sole_source_state_required");
  else if (states[0] !== dispatch.expectedSource)
    failures.push("stale_expected_source");
  if (
    dispatch.requestedTarget === LIFECYCLE_STATES[1] &&
    issueSchemaForLabels(issue.labels) === undefined
  )
    failures.push("exact_issue_type_required");
  return failures;
}

async function derivedAssignmentClaim({ event, issue, repository, request }) {
  const claim = assignmentClaimCandidate(event, issue);
  if (claim === undefined) return undefined;
  return (
    await Promise.all([
      actorCanClaimAssignment(repository, event.sender.login, request),
      actorCanClaimAssignment(repository, event.assignee.login, request),
    ])
  ).every(Boolean) && assignedLogins(issue).size === 1
    ? claim
    : undefined;
}

async function derivedAssignmentRelease(event, issue, repository, request) {
  const actor = event?.sender?.login;
  const assignee = event?.assignee?.login;
  if (typeof actor !== "string" || typeof assignee !== "string")
    return undefined;
  if (assignedLogins(issue).has(assignee)) return undefined;
  if (!(await actorCanClaimAssignment(repository, actor, request)))
    return undefined;
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

function unauthorizedRawLabelResult(enabled, issue, requestedTarget) {
  if (!enabled)
    return { outcome: "ignored", reason: "raw_lifecycle_label_event" };
  const priorStates = statusLabels(issue).filter(
    (state) => state !== requestedTarget,
  );
  return {
    desiredState:
      priorStates.length === 1 ? priorStates[0] : LIFECYCLE_STATES[0],
    repairUnauthorizedLabel: requestedTarget,
  };
}

function desiredStateForLabelEvent(
  event,
  currentState,
  enabled,
  readiness,
  issue,
) {
  const requestedTarget = labelRequestTarget(event);
  if (requestedTarget === undefined) return undefined;
  if (!hasTransitionRequest(event))
    return unauthorizedRawLabelResult(enabled, issue, requestedTarget);
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
    if (
      [LIFECYCLE_STATES[6], LIFECYCLE_STATES[7]].includes(currentState) &&
      claim?.validated === true
    ) {
      const resumed = evaluateResumePrecondition({
        claim,
        pauseEvidence: { suspendedSource: currentState, validated: true },
        readiness,
      });
      return { desiredState: resumed.target };
    }
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
    const release = event.release;
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
    desiredStateForLabelEvent(event, currentState, enabled, readiness, issue) ??
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
  for (let page = 1; page <= maxProviderPages; page += 1) {
    const batch = await request(
      `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch))
      throw new Error("Issue comments response is malformed.");
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error("Issue comments pagination limit exceeded.");
}

async function allProviderLabels(repository, request) {
  const labels = [];
  for (let page = 1; page <= maxProviderPages; page += 1) {
    const batch = await request(
      `/repos/${repository}/labels?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch))
      throw new Error("Provider labels response is malformed.");
    labels.push(...batch.map((label) => label?.name));
    if (batch.length < 100) return labels;
  }
  throw new Error("Provider labels pagination limit exceeded.");
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
  for (let page = 1; page <= maxProviderPages; page += 1) {
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
  throw new Error("Open pull request pagination limit exceeded.");
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
  for (let page = 1; page <= maxProviderPages; page += 1) {
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
  throw new Error("Closed pull request pagination limit exceeded.");
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
  if (event?.action === "unassigned" && event.release === undefined) {
    const release = await derivedAssignmentRelease(
      event,
      issue,
      repository,
      request,
    );
    if (release !== undefined) evidencedEvent = { ...evidencedEvent, release };
  }
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

async function replaceLifecycleLabels({
  desiredState,
  issue,
  issueNumber,
  repository,
  request,
}) {
  const originalLabels = labelNames(issue);
  if (!Array.isArray(originalLabels))
    return failed(["Issue lifecycle labels are unavailable."]);
  const desiredLabels = [
    ...originalLabels.filter((label) => !label?.startsWith("status: ")),
    desiredState,
  ];
  let mutationError;
  try {
    await request(`/repos/${repository}/issues/${issueNumber}`, {
      method: "PATCH",
      payload: { labels: desiredLabels },
    });
  } catch (error) {
    mutationError = error;
  }
  const readback = await reloadIssue(repository, issueNumber, request);
  const verified = verifyStatusLabelReadback({
    actualIssueIdentity: issueIdentity(readback),
    desiredState,
    expectedIssueIdentity: issueIdentity(issue),
    labels: labelNames(readback),
  });
  if (verified.ok)
    return {
      issue: readback,
      mutationResult: "applied",
      ok: true,
      readbackResult: "verified",
    };

  if (!issueObservationMatches(issue, readback)) {
    let recovered;
    try {
      await request(`/repos/${repository}/issues/${issueNumber}`, {
        method: "PATCH",
        payload: { labels: originalLabels },
      });
      recovered = await reloadIssue(repository, issueNumber, request);
    } catch {
      recovered = undefined;
    }
    if (
      recovered === undefined ||
      !issueLabelObservationMatches(issue, recovered)
    )
      return {
        failures: [
          "Lifecycle mutation failed and original labels could not be restored.",
        ],
        mutationResult: "failed",
        ok: false,
        readbackResult: "not-verified",
      };
  }
  return {
    failures: [
      mutationError === undefined
        ? "Lifecycle label replacement did not match desired state."
        : "Lifecycle label replacement failed without a verified desired state.",
    ],
    mutationResult: "failed",
    ok: false,
    readbackResult: "not-verified",
  };
}

async function recordLifecycleObservation(
  repository,
  issueNumber,
  observation,
  request,
) {
  const body = lifecycleObservationComment(observation);
  const comment = await request(
    `/repos/${repository}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      payload: { body },
    },
  );
  if (!trustedLifecycleObservation(comment, body))
    throw new Error("Lifecycle observation read-back failed.");
}

async function finalizeLifecycleDispatch({
  dispatch,
  enabled,
  issueNumber,
  now,
  repository,
  request,
  result,
}) {
  if (dispatch === undefined) return result;
  const observation = lifecycleObservation({
    activation: enabled ? "enabled" : "disabled",
    issueNumber,
    now,
    request: dispatch,
    result,
  });
  await recordLifecycleObservation(
    repository,
    issueNumber,
    observation,
    request,
  );
  return { ...result, observation };
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

function issueLabelObservationMatches(expected, actual) {
  const expectedLabelNames = labelNames(expected);
  const actualLabelNames = labelNames(actual);
  if (!Array.isArray(expectedLabelNames) || !Array.isArray(actualLabelNames))
    return false;
  const expectedLabels = [...expectedLabelNames].sort((left, right) =>
    left.localeCompare(right),
  );
  const actualLabels = [...actualLabelNames].sort((left, right) =>
    left.localeCompare(right),
  );
  return (
    issueIdentity(actual) === issueIdentity(expected) &&
    actual?.number === expected?.number &&
    JSON.stringify(actualLabels) === JSON.stringify(expectedLabels)
  );
}

function issueObservationMatches(expected, actual) {
  const expectedAssignees = [...assignedLogins(expected)].sort((left, right) =>
    left.localeCompare(right),
  );
  const actualAssignees = [...assignedLogins(actual)].sort((left, right) =>
    left.localeCompare(right),
  );
  return (
    issueLabelObservationMatches(expected, actual) &&
    actual?.state === expected?.state &&
    actual?.state_reason === expected?.state_reason &&
    actual?.updated_at === expected?.updated_at &&
    actual?.title === expected?.title &&
    semanticIssueFingerprint(actual?.body ?? "", actual?.title ?? "") ===
      semanticIssueFingerprint(expected?.body ?? "", expected?.title ?? "") &&
    JSON.stringify(actualAssignees) === JSON.stringify(expectedAssignees)
  );
}

function governanceCommentSnapshot(comments) {
  return (Array.isArray(comments) ? comments : [])
    .filter(
      (comment) =>
        comment?.body?.includes("<!-- keiko-native-readiness -->") ||
        comment?.body?.includes(LIFECYCLE_OBSERVATION_MARKER),
    )
    .map((comment) => ({
      body: comment.body,
      id: comment.id,
      user: {
        id: comment?.user?.id,
        login: comment?.user?.login,
        type: comment?.user?.type,
      },
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function providerLabelSnapshot(labels) {
  return [...labels].sort((left, right) => left.localeCompare(right));
}

async function stableLifecycleInputs({
  comments,
  event,
  issue,
  issueNumber,
  providerLabels,
  readiness,
  repository,
  request,
}) {
  const [currentIssue, currentComments, currentProviderLabels] =
    await Promise.all([
      reloadIssue(repository, issueNumber, request),
      allIssueComments(repository, issueNumber, request),
      allProviderLabels(repository, request),
    ]);
  if (!issueObservationMatches(issue, currentIssue)) return undefined;
  if (
    JSON.stringify(governanceCommentSnapshot(currentComments)) !==
      JSON.stringify(governanceCommentSnapshot(comments)) ||
    JSON.stringify(providerLabelSnapshot(currentProviderLabels)) !==
      JSON.stringify(providerLabelSnapshot(providerLabels))
  )
    return undefined;
  const currentReadiness = evaluateReadinessForIssue({
    comments: currentComments,
    event,
    issue: currentIssue,
  });
  return JSON.stringify(currentReadiness) === JSON.stringify(readiness)
    ? currentIssue
    : undefined;
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
  comments,
  enabled,
  event,
  issue,
  issueNumber,
  now,
  providerLabels,
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
  if (
    (await stableLifecycleInputs({
      comments,
      event,
      issue,
      issueNumber,
      providerLabels,
      readiness,
      repository,
      request,
    })) === undefined
  )
    return failed(["issue_changed_before_reconciliation"]);
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
  comments,
  desiredState,
  enabled,
  event,
  issue,
  issueNumber,
  now,
  providerLabels,
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

  if (
    (await stableLifecycleInputs({
      comments,
      event,
      issue,
      issueNumber,
      providerLabels,
      readiness,
      repository,
      request,
    })) === undefined
  )
    return failed(["issue_changed_before_reconciliation"]);

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

  const replacement = await replaceLifecycleLabels({
    desiredState,
    issue,
    issueNumber,
    repository,
    request,
  });
  return replacement.ok
    ? {
        closeIssue,
        desiredState,
        mutationResult: replacement.mutationResult,
        outcome: "applied",
        plan: reconciliation,
        readbackResult: replacement.readbackResult,
      }
    : {
        ...failed(replacement.failures),
        mutationResult: replacement.mutationResult,
        readbackResult: replacement.readbackResult,
      };
}

async function repairUnauthorizedRawGesture({
  comments,
  desiredState,
  event,
  issue,
  issueNumber,
  providerLabels,
  readiness,
  repository,
  request,
  unauthorizedLabel,
}) {
  if (
    (await stableLifecycleInputs({
      comments,
      event,
      issue,
      issueNumber,
      providerLabels,
      readiness,
      repository,
      request,
    })) === undefined
  )
    return failed(["issue_changed_before_reconciliation"]);
  await removeLabel(repository, issueNumber, unauthorizedLabel, request);
  const readback = await reloadIssue(repository, issueNumber, request);
  const verified = verifyStatusLabelReadback({
    actualIssueIdentity: issueIdentity(readback),
    desiredState,
    expectedIssueIdentity: issueIdentity(issue),
    labels: labelNames(readback),
  });
  return verified.ok
    ? {
        failures: ["unauthorized_raw_lifecycle_gesture_repaired"],
        mutationResult: "applied",
        outcome: "failed",
        readbackResult: "verified",
      }
    : {
        ...failed([
          "unauthorized_raw_lifecycle_gesture_repair_failed",
          ...verified.failures,
        ]),
        mutationResult: "failed",
        readbackResult: "not-verified",
      };
}

export async function runIssueLifecycleAction({
  dispatchContext = dispatchContextFromEnvironment(),
  event,
  now = new Date(),
  request = githubRequest,
} = {}) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (typeof repository !== "string" || !repository.includes("/"))
    throw new Error("GITHUB_REPOSITORY is missing or invalid.");
  if (event?.issue?.pull_request !== undefined)
    return { outcome: "ignored", reason: "pull_request_issue" };

  let dispatch;
  let lifecycleEvent = event;
  if (isLifecycleDispatch(event)) {
    const parsed = parseLifecycleDispatchRequest({
      event,
      repository,
      ...dispatchContext,
    });
    if (!parsed.ok) return failed(parsed.failures);
    dispatch = parsed.request;
    lifecycleEvent = eventForLifecycleDispatch(dispatch);
  }
  const issueNumber = dispatch?.issueNumber ?? eventIssueNumber(lifecycleEvent);
  if (!Number.isInteger(issueNumber))
    throw new Error("Issue number is missing.");

  const [issue, comments, providerLabels] = await Promise.all([
    reloadIssue(repository, issueNumber, request),
    allIssueComments(repository, issueNumber, request),
    allProviderLabels(repository, request),
  ]);
  const providerValidation = validateProviderStatusLabels(providerLabels);
  const enabled = enabledLifecycleActivation();
  if (!providerValidation.ok)
    return finalizeLifecycleDispatch({
      dispatch,
      enabled,
      issueNumber,
      now,
      repository,
      request,
      result: failed(providerValidation.failures),
    });
  if (dispatch !== undefined) {
    const replay = lifecycleRequestReplay(comments, dispatch);
    if (replay !== undefined)
      return finalizeLifecycleDispatch({
        dispatch,
        enabled,
        issueNumber,
        now,
        repository,
        request,
        result: failed([replay]),
      });
    const actorRole = await dispatchActorRole(repository, dispatch, request);
    const authorityFailures = dispatchAuthorityFailures({
      actorRole,
      dispatch,
      issue,
    });
    if (authorityFailures.length > 0)
      return finalizeLifecycleDispatch({
        dispatch,
        enabled,
        issueNumber,
        now,
        repository,
        request,
        result: failed(authorityFailures),
      });
    lifecycleEvent = eventForLifecycleDispatch(dispatch, actorRole);
  }
  if (lifecycleEvent?.pull_request !== undefined) {
    const labelFailure = exactLifecycleLabelFailure(issue);
    if (labelFailure !== undefined) return labelFailure;
  }
  const currentState = currentLifecycleState(issue, lifecycleEvent);

  const readiness = evaluateReadinessForIssue({
    comments,
    event: lifecycleEvent,
    issue,
  });
  const evidencedEvent = await eventWithDerivedEvidence({
    comments,
    event: lifecycleEvent,
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
  if (desired?.outcome === "failed")
    return finalizeLifecycleDispatch({
      dispatch,
      enabled,
      issueNumber,
      now,
      repository,
      request,
      result: desired,
    });
  if (enabled && lifecycleEvent?.pull_request !== undefined) {
    const authorityFailures = await pullRequestEventAuthorityFailures(
      repository,
      lifecycleEvent,
      request,
    );
    if (authorityFailures.length > 0) return failed(authorityFailures);
  }
  const ignored = ignoredDesiredResult(desired, readiness);
  let result;
  if (ignored !== undefined) result = ignored;
  else if (desired.repairUnauthorizedLabel !== undefined)
    result = await repairUnauthorizedRawGesture({
      comments,
      desiredState: desired.desiredState,
      event: lifecycleEvent,
      issue,
      issueNumber,
      providerLabels,
      readiness,
      repository,
      request,
      unauthorizedLabel: desired.repairUnauthorizedLabel,
    });
  else if (desired.removeLifecycleLabels === true)
    result = await reconcileLifecycleRemoval({
      comments,
      enabled,
      event: lifecycleEvent,
      issue,
      issueNumber,
      now,
      providerLabels,
      readiness,
      repository,
      request,
    });
  else
    result = await reconcileDesiredStatus({
      closeIssue: desired.closeIssue === true,
      comments,
      desiredState: desired.desiredState,
      enabled,
      event: lifecycleEvent,
      issue,
      issueNumber,
      now,
      providerLabels,
      readiness,
      repository,
      request,
    });
  return finalizeLifecycleDispatch({
    dispatch,
    enabled,
    issueNumber,
    now,
    repository,
    request,
    result,
  });
}

export async function runIssueLifecycleCli({
  eventPath = process.env.GITHUB_EVENT_PATH,
  githubOutput = process.env.GITHUB_OUTPUT,
  output = process.stdout,
  request = githubRequest,
} = {}) {
  if (typeof eventPath !== "string" || eventPath.trim() === "")
    throw new Error("GITHUB_EVENT_PATH is missing.");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const result = await runIssueLifecycleAction({ event, request });
  output.write(`issue-lifecycle: ${result.outcome}\n`);
  if (result.observation !== undefined) {
    const serialized = JSON.stringify(result.observation);
    output.write(`issue-lifecycle-observation: ${serialized}\n`);
    if (typeof githubOutput === "string" && githubOutput.trim() !== "")
      await appendFile(githubOutput, `observation=${serialized}\n`, "utf8");
  }
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
