import assert from "node:assert/strict";
import test from "node:test";
import { LIFECYCLE_STATES } from "./issue-lifecycle.mjs";
import {
  classifyLifecycleHandoffLane,
  coalesceLifecycleInputGeneration,
  evaluateNormalLifecycleHandoff,
} from "./lifecycle-handoff.mjs";
const repository = "oscharko-dev/Keiko-Native";
const base = "1".repeat(40);
const head = "2".repeat(40);
const target = "epic/29-repository-backed-contracts";
const readinessFingerprint = "c".repeat(64);
const PR_OPEN = LIFECYCLE_STATES[4];
const REVIEW = LIFECYCLE_STATES[5];
const contexts = ["Issue contract current", "PR contract"];
const producers = {
  "Contract publication": "publication.yml@protected-dev",
  "Issue contract current": "issue-current.yml@protected-dev",
  "Lifecycle handoff": "lifecycle-handoff.yml@protected-dev",
  "PR contract": "pr-contract.yml@protected-dev",
};
const string = (value) => ({ type: "string", value });
const generationInputs = (revision = "observation-1", lifecycle = REVIEW) => ({
  fields: [
    ["issueRevision", revision],
    ["readiness", `10:v2:${readinessFingerprint}`],
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
  ].map(([name, value]) => ({ name, value: string(value) })),
  type: "record",
});
function diff(files = [], overrides = {}) {
  return {
    base,
    complete: true,
    files,
    head,
    normalValidated: files.length === 0,
    pullRequest: 32,
    repository,
    truncated: false,
    ...overrides,
  };
}
function authority(overrides = {}) {
  return {
    head,
    id: "issue-32-v2",
    issueIdentity: "issue-32",
    lane: "normal",
    pullRequest: 32,
    repository,
    scope: "quality/lifecycle-handoff*",
    target,
    ...overrides,
  };
}
const classify = (overrides = {}) =>
  classifyLifecycleHandoffLane({
    authority: authority(overrides.authority),
    diff: diff([], overrides.diff),
    target: overrides.target ?? target,
  });
test("classifies an immutable normal lane and rejects ambiguity", () => {
  const normal = classify();
  assert.equal(normal.ok, true);
  assert.deepEqual(
    {
      authority: normal.binding.authority,
      issueIdentity: normal.binding.issueIdentity,
      lane: normal.binding.lane,
      scope: normal.binding.scope,
      target: normal.binding.target,
    },
    {
      authority: "issue-32-v2",
      issueIdentity: "issue-32",
      lane: "normal",
      scope: "quality/lifecycle-handoff*",
      target,
    },
  );
  for (const invalid of [
    classify({ target: "dev" }),
    classify({ authority: { head: base } }),
    classify({ authority: { lane: "publication" } }),
    classify({ diff: { complete: false } }),
    classify({ diff: { truncated: true } }),
    classify({ diff: { normalValidated: false } }),
  ]) {
    assert.equal(invalid.ok, false);
  }
});
function generationRequest(classification, overrides = {}) {
  return {
    attemptSequence: 0,
    classification,
    expectedProducers: producers,
    inputs: generationInputs(
      classification.binding.lane === "normal"
        ? "observation-2"
        : "observation-1",
      classification.binding.lane === "normal"
        ? REVIEW
        : `publication:${classification.binding.submode}`,
    ),
    ...overrides,
  };
}
function completion(state, context, conclusion = "success", overrides = {}) {
  return {
    conclusion,
    context,
    generation: state.generation.digest,
    head,
    producer: producers[context],
    result: `${context}-result-1`,
    workflowRun: `${context}-run-1`,
    ...overrides,
  };
}
function completedGeneration(classification) {
  const request = generationRequest(classification);
  let state = coalesceLifecycleInputGeneration(request);
  for (const context of contexts) {
    state = coalesceLifecycleInputGeneration({
      ...request,
      completion: completion(state, context, "success", {
        output: { binding: classification.binding, ok: true },
      }),
      prior: state.generation,
    });
  }
  return { ...state, request };
}
function readiness(overrides = {}) {
  return {
    comments: [
      {
        body: `<!-- keiko-native-readiness -->\n- Status: \`accepted\`\n- Contract version: \`v2\`\n- Fingerprint: \`${readinessFingerprint}\``,
        id: 10,
        user: {
          id: 41898282,
          login: "github-actions[bot]",
          type: "Bot",
        },
      },
    ],
    currentFingerprint: readinessFingerprint,
    currentVersion: "v2",
    expectedCommentId: 10,
    ...overrides,
  };
}
function normalInput(overrides = {}) {
  const classification = classify();
  const completed = completedGeneration(classification);
  return {
    classification,
    generation: completed.generation,
    generationRequest: completed.request,
    phaseOne: {
      conversationsCurrent: true,
      evidenceCurrent: true,
      excludedContexts: ["Lifecycle handoff"],
      head,
      inputs: generationInputs("observation-1", PR_OPEN),
      lockFence: "lifecycle-lock-32-1",
      ok: true,
      reviewsCurrent: true,
      sourceState: PR_OPEN,
      target,
    },
    readiness: readiness(),
    readback: {
      actualIssueIdentity: "issue-32",
      expectedIssueIdentity: "issue-32",
      head,
      issueRevision: "observation-2",
      labels: [REVIEW],
      transitionIdentity: "handoff-32-1",
    },
    transition: {
      actorRole: "implementer",
      applied: true,
      authority: classification.binding.authority,
      eventIdentity: "handoff-32-1",
      head,
      issueIdentity: "issue-32",
      lockFence: "lifecycle-lock-32-1",
      producer: producers["Lifecycle handoff"],
      pullRequest: 32,
      repository,
      result: "handoff-result-1",
      resultRevision: "observation-2",
      source: PR_OPEN,
      sourceRevision: "observation-1",
      target: REVIEW,
      targetRef: target,
      workflowRun: "handoff-run-1",
    },
    ...overrides,
  };
}
function stableInput() {
  const input = normalInput();
  input.phaseOne = {
    ...input.phaseOne,
    inputs: input.generationRequest.inputs,
    sourceState: REVIEW,
  };
  input.existingHandoff = {
    authority: input.classification.binding.authority,
    eventIdentity: "handoff-32-1",
    generation: input.generation.digest,
    head,
    issueIdentity: "issue-32",
    lockFence: input.phaseOne.lockFence,
    producer: producers["Lifecycle handoff"],
    pullRequest: 32,
    repository,
    result: "existing-handoff-1",
    resultRevision: "observation-2",
    sourceRevision: "observation-1",
    status: "success",
    targetRef: target,
    workflowRun: "existing-handoff-run-1",
  };
  return input;
}
test("accepts only the serialized normal two-phase exact-head handshake", () => {
  const accepted = evaluateNormalLifecycleHandoff(normalInput());
  assert.deepEqual(
    { ok: accepted.ok, status: accepted.status, target: accepted.target },
    { ok: true, status: "success", target: REVIEW },
  );
  const stable = stableInput();
  assert.equal(evaluateNormalLifecycleHandoff(stable).decision, "noop");
  stable.phaseOne.reviewsCurrent = false;
  assert.equal(evaluateNormalLifecycleHandoff(stable).target, PR_OPEN);
  for (const input of [
    normalInput({ readiness: readiness({ expectedCommentId: 11 }) }),
    normalInput({ phaseOne: { ...normalInput().phaseOne, head: base } }),
    normalInput({
      phaseOne: { ...normalInput().phaseOne, reviewsCurrent: false },
    }),
    normalInput({ readback: { ...normalInput().readback, labels: [PR_OPEN] } }),
    normalInput({
      readback: { ...normalInput().readback, issueRevision: "stale" },
    }),
    normalInput({
      readback: { ...normalInput().readback, transitionIdentity: "stale" },
    }),
    normalInput({
      transition: { ...normalInput().transition, actorRole: "" },
    }),
  ]) {
    assert.equal(evaluateNormalLifecycleHandoff(input).ok, false);
  }
  const missingObservation = { ...stable, generationRequest: {} };
  assert.equal(evaluateNormalLifecycleHandoff(missingObservation).ok, false);
  const missingHandoff = { ...stable, existingHandoff: undefined };
  assert.equal(evaluateNormalLifecycleHandoff(missingHandoff).ok, false);
  const downgrade = normalInput({
    phaseOne: { ...normalInput().phaseOne, reviewsCurrent: false },
  });
  assert.equal(evaluateNormalLifecycleHandoff(downgrade).target, PR_OPEN);
  assert.equal(
    evaluateNormalLifecycleHandoff({ classification: { ok: false } }).target,
    undefined,
  );
  const replay = normalInput();
  replay.generationRequest = {
    ...replay.generationRequest,
    inputs: generationInputs("observation-3"),
  };
  assert.equal(evaluateNormalLifecycleHandoff(replay).ok, false);
  const pending = normalInput();
  pending.generation.status = "pending";
  assert.equal(evaluateNormalLifecycleHandoff(pending).status, "pending");
  assert.equal(evaluateNormalLifecycleHandoff(pending).target, PR_OPEN);
});
test("returns the exact validated lock and transition revisions", () => {
  const result = evaluateNormalLifecycleHandoff(normalInput());
  assert.deepEqual(
    {
      eventIdentity: result.binding.eventIdentity,
      lockFence: result.binding.lockFence,
      resultRevision: result.binding.resultRevision,
      sourceRevision: result.binding.sourceRevision,
    },
    {
      eventIdentity: "handoff-32-1",
      lockFence: "lifecycle-lock-32-1",
      resultRevision: "observation-2",
      sourceRevision: "observation-1",
    },
  );
});
test("stable review output uses only the validated existing handoff", () => {
  const input = stableInput();
  input.transition = {
    eventIdentity: "unvalidated-event",
    lockFence: "unvalidated-lock",
    resultRevision: "unvalidated-result",
    sourceRevision: "unvalidated-source",
  };
  const result = evaluateNormalLifecycleHandoff(input);
  assert.deepEqual(
    [result.binding.eventIdentity, result.binding.lockFence],
    ["handoff-32-1", "lifecycle-lock-32-1"],
  );
});
test("rejects an unknown prerequisite result context", () => {
  const input = normalInput();
  input.generation.results.Injected = completion(
    { generation: input.generation },
    "Injected",
    "success",
    { producer: "untrusted-producer" },
  );
  assert.equal(evaluateNormalLifecycleHandoff(input).ok, false);
});
test("rejects issue identity substitution", () => {
  const substitutedIssue = normalInput();
  substitutedIssue.readback.actualIssueIdentity = "issue-999";
  substitutedIssue.readback.expectedIssueIdentity = "issue-999";
  substitutedIssue.transition.issueIdentity = "issue-999";
  assert.equal(evaluateNormalLifecycleHandoff(substitutedIssue).ok, false);
});
test("rejects independently substituted read-back identity", () => {
  const input = normalInput();
  input.readback.actualIssueIdentity = "issue-999";
  input.readback.expectedIssueIdentity = "issue-999";
  assert.equal(evaluateNormalLifecycleHandoff(input).ok, false);
});
test("rejects a stale lifecycle lock", () => {
  const staleLock = normalInput();
  staleLock.transition.lockFence = "arbitrary-stale-lock";
  assert.equal(evaluateNormalLifecycleHandoff(staleLock).ok, false);
});
test("rejects stable review without transition and revision identity", () => {
  const input = stableInput();
  delete input.existingHandoff.eventIdentity;
  delete input.existingHandoff.resultRevision;
  delete input.readback.issueRevision;
  delete input.readback.transitionIdentity;
  assert.equal(evaluateNormalLifecycleHandoff(input).ok, false);
});
test("rejects stale transition revision replay at stable review", () => {
  const input = stableInput();
  input.existingHandoff.resultRevision = "stale-revision";
  input.readback.issueRevision = "stale-revision";
  assert.equal(evaluateNormalLifecycleHandoff(input).ok, false);
});
test("fails closed when hostile provider-shaped input throws", () => {
  const hostile = new Proxy({}, { get: () => assert.fail("hostile getter") });
  for (const decide of [
    classifyLifecycleHandoffLane,
    coalesceLifecycleInputGeneration,
    evaluateNormalLifecycleHandoff,
  ]) {
    assert.equal(decide(hostile).ok, false);
  }
  const request = generationRequest(classify());
  for (const invalid of [
    undefined,
    {},
    { ...request, attemptSequence: -1 },
    { ...request, attemptSequence: Number.NaN },
    { ...request, expectedProducers: {} },
  ]) {
    assert.equal(coalesceLifecycleInputGeneration(invalid).ok, false);
  }
  const normal = normalInput();
  const duplicateRun = normalInput();
  duplicateRun.generation.results["PR contract"].workflowRun =
    duplicateRun.generation.results["Issue contract current"].workflowRun;
  const wrongRequest = normalInput();
  wrongRequest.generationRequest.classification = {
    ...classify(),
    binding: { ...classify().binding, head: base },
  };
  for (const invalid of [
    { ...normal, transition: { ...normal.transition, producer: "forged" } },
    duplicateRun,
    wrongRequest,
  ]) {
    assert.equal(evaluateNormalLifecycleHandoff(invalid).ok, false);
  }
});
