import assert from "node:assert/strict";
import test from "node:test";
import { LIFECYCLE_STATES } from "./issue-lifecycle.mjs";
import {
  classifyLifecycleHandoffLane,
  coalesceLifecycleInputGeneration,
  evaluateNormalLifecycleHandoff,
} from "./lifecycle-handoff.mjs";
const repository = "oscharko-dev/Keiko-Native";
const [base, head] = ["1".repeat(40), "2".repeat(40)];
const target = "epic/29-repository-backed-contracts";
const readinessFingerprint = "c".repeat(64);
const [PR_OPEN, REVIEW] = LIFECYCLE_STATES.slice(4, 6);
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
  stable.readiness.comments = [];
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
test("returns exact validated transition and stable handoff identity", () => {
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
  const input = stableInput();
  input.transition = {
    eventIdentity: "unvalidated-event",
    lockFence: "unvalidated-lock",
    resultRevision: "unvalidated-result",
    sourceRevision: "unvalidated-source",
  };
  const stableResult = evaluateNormalLifecycleHandoff(input);
  assert.deepEqual(
    [stableResult.binding.eventIdentity, stableResult.binding.lockFence],
    ["handoff-32-1", "lifecycle-lock-32-1"],
  );
});
test("rejects surplus, substituted, stale, and replayed evidence", () => {
  const input = normalInput();
  input.generation.results.Injected = completion(
    { generation: input.generation },
    "Injected",
    "success",
    { producer: "untrusted-producer" },
  );
  assert.equal(evaluateNormalLifecycleHandoff(input).ok, false);
  const substitutedIssue = normalInput();
  substitutedIssue.transition.issueIdentity = "issue-999";
  assert.equal(evaluateNormalLifecycleHandoff(substitutedIssue).ok, false);
  const staleOutput = normalInput();
  const stale = { issueIdentity: "issue-999", target: "dev" };
  for (const context of contexts) {
    const output = staleOutput.generation.results[context].output;
    output.binding = { ...output.binding, ...stale };
  }
  assert.equal(evaluateNormalLifecycleHandoff(staleOutput).ok, false);
  const hostileOutput = normalInput();
  hostileOutput.generation.results["PR contract"].output = new Proxy(
    {},
    {
      ownKeys: () => assert.fail("hostile output"),
    },
  );
  assert.equal(evaluateNormalLifecycleHandoff(hostileOutput).target, PR_OPEN);
  const readback = normalInput();
  readback.readback.actualIssueIdentity = "issue-999";
  readback.readback.expectedIssueIdentity = "issue-999";
  assert.equal(evaluateNormalLifecycleHandoff(readback).ok, false);
  const staleLock = normalInput();
  staleLock.transition.lockFence = "arbitrary-stale-lock";
  assert.equal(evaluateNormalLifecycleHandoff(staleLock).ok, false);
  const missing = stableInput();
  delete missing.existingHandoff.eventIdentity;
  delete missing.existingHandoff.resultRevision;
  delete missing.readback.issueRevision;
  delete missing.readback.transitionIdentity;
  assert.equal(evaluateNormalLifecycleHandoff(missing).ok, false);
  const replay = stableInput();
  replay.existingHandoff.resultRevision = "stale-revision";
  replay.readback.issueRevision = "stale-revision";
  assert.equal(evaluateNormalLifecycleHandoff(replay).ok, false);
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
