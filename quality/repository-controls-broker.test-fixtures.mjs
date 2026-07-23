import {
  bindEpicMergeAuthorizationSnapshot,
  decideEpicMergeAuthorization,
} from "./epic-merge-broker.mjs";
import {
  classifyLifecycleHandoffLane,
  coalesceLifecycleInputGeneration,
} from "./lifecycle-handoff.mjs";

const repository = "oscharko-dev/Keiko-Native";
const target = "epic/50-controls-probe";
const base = "1".repeat(40);
const head = "2".repeat(40);
const fingerprint = "c".repeat(64);
const issueIdentity = "issue-5050";
const pullRequest = 5050;
const producers = {
  "Issue contract current": "issue-current.yml@protected-dev",
  "Lifecycle handoff": "lifecycle-handoff.yml@protected-dev",
  "PR contract": "pr-contract.yml@protected-dev",
};

const observed = (revision, lifecycle) => ({
  fields: [
    ["issueRevision", revision],
    ["readiness", `10:v2:${fingerprint}`],
    ["lifecycle", lifecycle],
    ["target", target],
    ["reviews", "reviews-1"],
    ["conversations", "conversations-1"],
    ["audit", "audit-1"],
    ["journey", "journey-1"],
    ["manual", "manual-1"],
    ["external", "external-1"],
    ["platform", "platform-1"],
    ["upstream", "upstream-1"],
  ].map(([name, value]) => ({
    name,
    value: { type: "string", value },
  })),
  type: "record",
});

function laneInput() {
  return {
    authority: {
      evidence: "normal-observation-1",
      head,
      id: `${issueIdentity}-v2`,
      issueIdentity,
      lane: "normal",
      pullRequest,
      repository,
      scope: "quality/merge-group*",
      target,
    },
    diff: {
      base,
      complete: true,
      files: [],
      head,
      normalValidated: true,
      pullRequest,
      repository,
      truncated: false,
    },
    target,
  };
}

function handoffInput() {
  const classification = classifyLifecycleHandoffLane(laneInput());
  const generationRequest = {
    attemptSequence: 0,
    classification,
    expectedProducers: producers,
    inputs: observed("observation-2", "status: ready for human review"),
  };
  let state = coalesceLifecycleInputGeneration(generationRequest);
  for (const context of ["Issue contract current", "PR contract"]) {
    state = coalesceLifecycleInputGeneration({
      ...generationRequest,
      completion: {
        conclusion: "success",
        context,
        generation: state.generation.digest,
        head,
        output: { binding: classification.binding, ok: true },
        producer: producers[context],
        result: `${context}-result`,
        workflowRun: `${context}-run`,
      },
      prior: state.generation,
    });
  }
  const binding = classification.binding;
  const eventIdentity = `handoff-${pullRequest}`;
  return {
    classification,
    generation: state.generation,
    generationRequest,
    phaseOne: {
      conversationsCurrent: true,
      evidenceCurrent: true,
      excludedContexts: ["Lifecycle handoff"],
      head,
      inputs: observed("observation-1", "status: pr open"),
      lockFence: `issue-fence-${pullRequest}`,
      ok: true,
      reviewsCurrent: true,
      sourceState: "status: pr open",
      target,
    },
    readiness: {
      comments: [
        {
          body: `<!-- keiko-native-readiness -->\n- Status: \`accepted\`\n- Contract version: \`v2\`\n- Fingerprint: \`${fingerprint}\``,
          id: 10,
          user: {
            id: 41898282,
            login: "github-actions[bot]",
            type: "Bot",
          },
        },
      ],
      currentFingerprint: fingerprint,
      currentVersion: "v2",
      expectedCommentId: 10,
    },
    readback: {
      actualIssueIdentity: binding.issueIdentity,
      expectedIssueIdentity: binding.issueIdentity,
      head,
      issueRevision: "observation-2",
      labels: ["status: ready for human review"],
      transitionIdentity: eventIdentity,
    },
    transition: {
      actorRole: "implementer",
      applied: true,
      authority: binding.authority,
      eventIdentity,
      head,
      issueIdentity,
      lockFence: `issue-fence-${pullRequest}`,
      producer: producers["Lifecycle handoff"],
      pullRequest,
      repository,
      result: "handoff-result",
      resultRevision: "observation-2",
      source: "status: pr open",
      sourceRevision: "observation-1",
      target: "status: ready for human review",
      targetRef: target,
      workflowRun: "handoff-run",
    },
  };
}

const resultIdentity = (name) => ({
  current: true,
  producer: `${name}.yml@protected-dev`,
  result: `${name}-result`,
  workflowRun: `${name}-run`,
});

function brokerInput() {
  const evidenceNames = [
    "audit",
    "conversations",
    "external",
    "journey",
    "manual",
    "platform",
    "reviews",
  ];
  const expectedProducers = {
    ...Object.fromEntries(
      [...evidenceNames, "composition"].map((name) => [
        name,
        `${name}.yml@protected-dev`,
      ]),
    ),
    ...producers,
  };
  const read = {
    composition: {
      base,
      complete: true,
      head,
      producer: expectedProducers.composition,
      result: "composition-result",
      workflowRun: "composition-run",
    },
    contractFingerprint: fingerprint,
    cursor: "issue-cursor-1",
    draft: false,
    evidence: Object.fromEntries(
      evidenceNames.map((name) => [name, resultIdentity(name)]),
    ),
    handoffInput: handoffInput(),
    head,
    issueIdentity,
    issueUpdated: "observation-2",
    laneInput: laneInput(),
    lifecycle: "status: ready for human review",
    mergeable: true,
    pagination: {
      complete: true,
      cursor: "issue-cursor-1",
      pages: [
        {
          count: 7,
          end: "page-end-1",
          index: 0,
          start: "issue-cursor-1",
        },
      ],
      truncated: false,
    },
    pullRequest,
    readiness: `10:v2:${fingerprint}`,
    repository,
    source: "codex/50-controls-probe",
    target,
    targetTip: base,
  };
  const locks = {
    issue: {
      acquired: true,
      current: true,
      fence: `issue-fence-${pullRequest}`,
      issueIdentity,
      repository,
    },
    order: ["issue", "target"],
    target: {
      acquired: true,
      current: true,
      fence: "target-fence-50",
      repository,
      target,
    },
  };
  return {
    expectedProducers,
    firstRead: read,
    locks,
    preSubmitRead: {
      head,
      issueFence: locks.issue.fence,
      pullRequest,
      repository,
      target,
      targetFence: locks.target.fence,
      targetTip: base,
    },
    secondRead: structuredClone(read),
    semantics: {
      completePagination: true,
      cursorOrdering: true,
      dualRefConditional: true,
      exactOutcome: true,
      fencing: true,
      liveProbe: true,
      stableReads: true,
    },
    submittedSnapshots: [],
  };
}

export function acceptedBrokerAuthorizationInput() {
  const input = brokerInput();
  const bound = bindEpicMergeAuthorizationSnapshot(input);
  const proof = bound.snapshot.preSubmit;
  const mergeCommit = "5".repeat(40);
  const accepted = {
    head: proof.head,
    mergeCommit,
    parents: [proof.targetTip, proof.head],
    pullRequest: proof.pullRequest,
    repository: proof.repository,
    snapshotId: bound.snapshot.id,
    status: "accepted",
    target: proof.target,
    targetTip: mergeCommit,
  };
  const result = {
    ...input,
    conditionalResponse: accepted,
    snapshotReadback: bound.snapshot,
    submittedSnapshots: [bound.snapshot.id],
  };
  if (decideEpicMergeAuthorization(result).action !== "accepted")
    throw new Error("accepted_broker_fixture_invalid");
  return result;
}
