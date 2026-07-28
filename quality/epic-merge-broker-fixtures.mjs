import {
  canonicalEpicMergeIdentity,
  digestEpicMergeProbeManifest,
} from "./epic-merge-broker.mjs";
import { digestEpicMergeValue } from "./epic-merge-policy.mjs";

export const sha = (character) => character.repeat(40);
export const repository = "oscharko-dev/Keiko-Native";
export const target = "epic/49-contract-as-code";
export const base = sha("1");
export const head = sha("2");
export const headTree = sha("3");
export const mergeCommit = sha("4");
export const operationIdentity = canonicalEpicMergeIdentity(
  "operation",
  "operation-50-1",
);
export const requestIdentity = canonicalEpicMergeIdentity(
  "request",
  "request-50-1",
);
export const claimIdentity = `clm_${digestEpicMergeValue({
  identity: { base, repository, target },
  operationId: operationIdentity,
})}`;

export function disabledPolicy() {
  return {
    activation: { state: "inactive" },
    expectedProducers: {
      activation: "contract-activation@protected-dev",
      proof: "epic-merge-live-proof@protected-dev",
      status: "epic-merge-guard-status@protected-dev",
    },
    liveProof: null,
    probeManifest: null,
    repository,
    requiredChecks: [],
    requiredEvidence: [],
    schema: 2,
    source: {
      protected: true,
      ref: "refs/heads/dev",
      revision: sha("a"),
    },
  };
}

export function activePolicy() {
  const policy = disabledPolicy();
  policy.activation = {
    commit: sha("b"),
    producer: policy.expectedProducers.activation,
    signed: true,
    state: "active",
  };
  policy.probeManifest = probeManifest(policy);
  policy.requiredChecks = [{ context: "ci", producer: "github-actions@15368" }];
  policy.requiredEvidence = [
    { name: "acceptance", producer: "github-actions[bot]@41898282" },
  ];
  return policy;
}

export function probeManifest(policy) {
  return {
    activationCommit: policy.activation.commit,
    issue: 55,
    operations: [
      {
        base: sha("c"),
        head: sha("d"),
        issue: 5501,
        operationId: canonicalEpicMergeIdentity(
          "operation",
          "operation-probe-1",
        ),
        pullRequest: 155,
        requestId: canonicalEpicMergeIdentity("request", "request-probe-1"),
        target: "epic/5500-guard-proof",
      },
    ],
    repository,
    schema: 2,
  };
}

export function enabledPolicy() {
  const policy = activePolicy();
  policy.probeManifest = probeManifest(policy);
  const binding = {
    activationCommit: policy.activation.commit,
    head: sha("e"),
    manifestDigest: digestEpicMergeProbeManifest(policy.probeManifest),
    policyRevision: policy.source.revision,
    producer: policy.expectedProducers.proof,
  };
  policy.liveProof = {
    receipt: {
      ...binding,
      ambiguous: false,
      matrixComplete: true,
      settled: true,
    },
    status: {
      ...binding,
      conclusion: "success",
      producer: policy.expectedProducers.status,
    },
  };
  return policy;
}

export function guardedPolicy() {
  const policy = enabledPolicy();
  policy.requiredChecks = [{ context: "ci", producer: "github-actions@15368" }];
  policy.requiredEvidence = [
    { name: "acceptance", producer: "github-actions[bot]@41898282" },
    { name: "audit", producer: "maintainer-audit@adr-0009" },
  ];
  return policy;
}

export function probeOnlyPolicy() {
  const policy = guardedPolicy();
  policy.liveProof = null;
  policy.probeManifest = {
    activationCommit: policy.activation.commit,
    issue: 55,
    operations: [
      {
        base,
        head,
        issue: 50,
        operationId: operationIdentity,
        pullRequest: 150,
        requestId: requestIdentity,
        target,
      },
    ],
    repository,
    schema: 2,
  };
  return policy;
}

export function authorization() {
  return {
    checks: [
      {
        base,
        conclusion: "success",
        context: "ci",
        head,
        producer: "github-actions@15368",
        status: "completed",
      },
    ],
    conversations: { complete: true, unresolved: 0 },
    evidence: {
      acceptance: {
        complete: true,
        current: true,
        head,
        producer: "github-actions[bot]@41898282",
      },
      audit: {
        complete: true,
        current: true,
        head,
        producer: "maintainer-audit@adr-0009",
      },
    },
    findings: { blocking: 0, complete: true },
    issue: {
      lifecycle: "status: ready for human review",
      number: 50,
      open: true,
      readiness: {
        accepted: true,
        commentId: 500,
        current: true,
        fingerprint: "5".repeat(64),
        producer: "github-actions[bot]",
        producerId: 41898282,
        version: "v5",
      },
      target,
    },
    pagination: { complete: true, truncated: false },
    pullRequest: {
      base,
      draft: false,
      head,
      headTree,
      issue: 50,
      mergeable: true,
      number: 150,
      open: true,
      source: "codex/50-inert-epic-merge-guard-v5",
      target,
    },
    repository,
  };
}

export function protection() {
  return {
    authorization: {
      bypass: false,
      merge: true,
      source: "repository-permission",
    },
    base,
    current: true,
    pagination: { complete: true, truncated: false },
    repository,
    rules: [
      {
        bypassActors: [],
        controls: {
          deletionBlocked: true,
          forcePushBlocked: true,
          pullRequestRequired: true,
          requiredSignatures: true,
          requiredStatusChecks: { strict: true },
        },
        enforcement: "active",
        id: 49,
        target,
      },
    ],
    target,
  };
}

export function successfulPorts(events, options = {}) {
  let claim;
  let operation;
  const currentAuthorization = options.authorization ?? authorization();
  const refReads = options.refReads?.map((value) => structuredClone(value));
  const snapshots = options.snapshots ?? [
    currentAuthorization,
    currentAuthorization,
    currentAuthorization,
  ];
  const protections = options.protections?.map((value) =>
    structuredClone(value),
  );
  const policies = options.policies?.map((value) => structuredClone(value));
  return {
    claimSerialization: async (value) => {
      events.push(["claim", value]);
      if (options.claim) return structuredClone(options.claim);
      claim = { ...value, claimId: "claim-1", state: "claimed" };
      return structuredClone(claim);
    },
    clock: () => "2026-07-27T19:00:00.000Z",
    loadAuthorization: async () => {
      events.push(["authorization"]);
      return structuredClone(snapshots.shift());
    },
    loadProtectedPolicy: async () => {
      events.push(["policy"]);
      return structuredClone(
        policies?.shift() ?? options.policy ?? guardedPolicy(),
      );
    },
    loadPullRequest: async () => {
      events.push(["pull-request"]);
      return structuredClone(
        options.finalPullRequest ?? currentAuthorization.pullRequest,
      );
    },
    loadTargetProtection: async () => {
      events.push(["protection"]);
      return structuredClone(
        protections?.shift() ?? options.protection ?? protection(),
      );
    },
    mergePullRequest: async (value) => {
      events.push(["merge", value]);
      if (options.mergeError) throw new Error("provider failed");
      return options.providerResponse ?? { kind: "accepted", mergeCommit };
    },
    markOperationSubmitted: async (value) => {
      events.push(["mark-submitted", value]);
      if (options.markSubmittedResult)
        return structuredClone(options.markSubmittedResult);
      if (operation) {
        operation.state = "submitted";
        operation.submitted = true;
      }
      return { submitted: true };
    },
    prepareOperation: async (value) => {
      events.push(["prepare", value]);
      const requestedClaim = options.claim ?? value.claim;
      if (
        requestedClaim.state !== "claimed" ||
        options.persistResult?.persisted === false
      )
        return { state: requestedClaim.state ?? "failed" };
      claim = structuredClone(requestedClaim);
      operation = structuredClone(value.operation);
      events.push(["claim", claim], ["operation", operation]);
      return {
        claim: structuredClone(claim),
        operation: structuredClone(operation),
        state: "prepared",
      };
    },
    persistOperation: async (value) => {
      events.push(["operation", value]);
      operation = structuredClone(value);
      return options.persistResult ?? { persisted: true };
    },
    readMergeOutcome: async () =>
      options.outcome ?? {
        commit: {
          parents: [currentAuthorization.pullRequest.base],
          sha: mergeCommit,
          tree: currentAuthorization.pullRequest.headTree,
        },
        merged: true,
        pullRequest: currentAuthorization.pullRequest.number,
        base: currentAuthorization.pullRequest.base,
        source: currentAuthorization.pullRequest.source,
        sourceHead: currentAuthorization.pullRequest.head,
        target: currentAuthorization.pullRequest.target,
        targetTip: mergeCommit,
      },
    readOperation: async () => {
      events.push(["read-operation"]);
      if (options.submittedReadbackMismatch && operation?.state === "submitted")
        return {
          ...structuredClone(operation),
          state: "prepared",
          submitted: false,
        };
      return structuredClone(options.operationReadback ?? operation);
    },
    readPreparation: async () => {
      events.push(["read-preparation"]);
      return {
        claim: structuredClone(options.claimReadback ?? claim),
        operation: structuredClone(options.operationReadback ?? operation),
        state: "prepared",
      };
    },
    readRefs: async () => {
      events.push(["refs"]);
      return (
        refReads?.shift() ??
        options.refs ?? {
          base: currentAuthorization.pullRequest.base,
          head: currentAuthorization.pullRequest.head,
        }
      );
    },
    readSerialization: async () => {
      events.push(["read-claim"]);
      return structuredClone(options.claimReadback ?? claim);
    },
    settleOperation: async (value) => {
      events.push(["settle", value]);
      if (options.settleError)
        throw new Error("sensitive settlement failure must stay redacted");
      const result = options.settleResult ?? { settled: true };
      if (operation && result.settled === true) operation.state = value.result;
      return result;
    },
  };
}

export function request(overrides = {}) {
  return {
    issue: 50,
    mode: "agent-credentialed",
    operationId: "operation-50-1",
    pullRequest: 150,
    repository,
    requestId: "request-50-1",
    ...overrides,
  };
}
