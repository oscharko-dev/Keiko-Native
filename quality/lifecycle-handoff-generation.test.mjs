import assert from "node:assert/strict";
import test from "node:test";
import {
  coalesceLifecycleInputGeneration,
  createHandoffBinding,
  matchesCurrentLifecycleGeneration,
  validateTransitionBinding,
} from "./lifecycle-handoff-generation.mjs";

const head = "2".repeat(40);
const contexts = ["Issue contract current", "PR contract"];
const producers = {
  "Contract publication": "publication.yml@protected-dev",
  "Issue contract current": "issue-current.yml@protected-dev",
  "Lifecycle handoff": "lifecycle-handoff.yml@protected-dev",
  "PR contract": "pr-contract.yml@protected-dev",
};
const classification = {
  binding: {
    authority: "issue-32-v2",
    base: "1".repeat(40),
    contractPaths: [],
    diff: [],
    head,
    issueIdentity: "issue-32",
    lane: "normal",
    pullRequest: 32,
    repository: "oscharko-dev/Keiko-Native",
    scope: "quality/lifecycle-handoff*",
    target: "epic/29-repository-backed-contracts",
  },
  lane: "normal",
  ok: true,
};
const inputs = (
  value = "observation-1",
  lifecycle = "status: ready for human review",
) => ({
  fields: [
    ["issueRevision", value],
    ["readiness", "readiness-1"],
    ["lifecycle", lifecycle],
    ["target", classification.binding.target],
    ["reviews", "reviews-1"],
    ["conversations", "conversations-1"],
    ["audit", "audit-1"],
    ["journey", "journey-1"],
    ["manual", "manual-1"],
    ["external", "external-1"],
    ["platform", "platform-1"],
    ["upstream", "upstream-1"],
  ].map(([name, item]) => ({
    name,
    value: { type: "string", value: item },
  })),
  type: "record",
});
const request = (overrides = {}) => ({
  attemptSequence: 0,
  classification,
  expectedProducers: producers,
  inputs: inputs(),
  ...overrides,
});
const completion = (state, conclusion = "success", overrides = {}) => ({
  conclusion,
  context: contexts[0],
  generation: state.generation.digest,
  head,
  producer: producers[contexts[0]],
  result: "result-1",
  workflowRun: "run-1",
  ...overrides,
});
function assertInvalidRecovery(failed, recovery) {
  for (const change of [
    {},
    { recovery: { authorized: true } },
    { attemptSequence: 2, recovery },
  ]) {
    const result = coalesceLifecycleInputGeneration({
      ...request({ attemptSequence: 1, prior: failed.generation }),
      ...change,
    });
    assert.equal(result.ok, false);
  }
}

test("coalesces one generation and accepts a validated input change", () => {
  const initial = coalesceLifecycleInputGeneration(request());
  assert.equal(initial.ok, true);
  assert.equal(
    matchesCurrentLifecycleGeneration(initial.generation, request()),
    true,
  );
  assert.equal(
    createHandoffBinding(classification, initial.generation).generation,
    initial.generation.digest,
  );
  assert.deepEqual(
    initial.starts.map(({ context }) => context),
    contexts,
  );
  assert.equal(
    coalesceLifecycleInputGeneration({
      ...request(),
      prior: initial.generation,
    }).decision,
    "noop",
  );
  const changed = coalesceLifecycleInputGeneration({
    ...request({ inputs: inputs("observation-2") }),
    prior: initial.generation,
  });
  assert.equal(changed.ok, true);
  assert.notEqual(changed.generation.digest, initial.generation.digest);
});

test("creates publication generation and requires its producer", () => {
  const publication = structuredClone(classification);
  Object.assign(publication.binding, {
    contractPaths: ["docs/contracts/task-32-v2-r1.md"],
    diff: [
      {
        mode: "100644",
        path: "docs/contracts/task-32-v2-r1.md",
        previous: null,
        status: "added",
      },
    ],
    evidence: "publication-1",
    lane: "publication",
    receipt: { digest: "a".repeat(64), path: "receipt" },
    scope: null,
    submode: "ordinary",
  });
  publication.lane = "publication";
  assert.equal(
    coalesceLifecycleInputGeneration(request({ classification: publication }))
      .starts.length,
    3,
  );
  const missingHandoff = { ...producers };
  delete missingHandoff["Lifecycle handoff"];
  assert.equal(
    coalesceLifecycleInputGeneration(
      request({ expectedProducers: missingHandoff }),
    ).ok,
    false,
  );
});

test("binds issue identity into canonical generation and results", () => {
  const initial = coalesceLifecycleInputGeneration(request());
  const attached = coalesceLifecycleInputGeneration({
    ...request(),
    completion: completion(initial),
    prior: initial.generation,
  });
  const changedClassification = {
    ...classification,
    binding: { ...classification.binding, issueIdentity: "issue-33" },
  };
  const changedRequest = request({ classification: changedClassification });
  const changed = coalesceLifecycleInputGeneration({
    ...changedRequest,
    prior: attached.generation,
  });
  assert.notEqual(changed.generation.digest, attached.generation.digest);
  assert.equal(
    matchesCurrentLifecycleGeneration(attached.generation, changedRequest),
    false,
  );
  assert.deepEqual(changed.generation.results, {});
  assert.equal(
    coalesceLifecycleInputGeneration({
      ...changedRequest,
      completion: completion(initial),
      prior: changed.generation,
    }).ok,
    false,
  );
});

test("settles pending completion without accepting replacement identity", () => {
  const initial = coalesceLifecycleInputGeneration(request());
  const pending = coalesceLifecycleInputGeneration({
    ...request(),
    completion: completion(initial, "pending"),
    prior: initial.generation,
  });
  const succeeded = coalesceLifecycleInputGeneration({
    ...request(),
    completion: completion(pending),
    prior: pending.generation,
  });
  assert.equal(succeeded.ok, true);
  assert.equal(
    createHandoffBinding(classification, succeeded.generation)
      .prerequisiteResults[contexts[0]].result,
    "result-1",
  );
  for (const change of [
    { generation: "f".repeat(64) },
    { head: "1".repeat(40) },
    { producer: "forged" },
  ]) {
    assert.equal(
      coalesceLifecycleInputGeneration({
        ...request(),
        completion: completion(initial, "success", change),
        prior: initial.generation,
      }).ok,
      false,
    );
  }
  for (const change of [
    { workflowRun: "replacement" },
    { result: "replacement" },
  ]) {
    assert.equal(
      coalesceLifecycleInputGeneration({
        ...request(),
        completion: completion(pending, "success", change),
        prior: pending.generation,
      }).ok,
      false,
    );
  }
});

test("requires authenticated single-step recovery from a terminal generation", () => {
  const initial = coalesceLifecycleInputGeneration(request());
  const failed = coalesceLifecycleInputGeneration({
    ...request(),
    completion: completion(initial, "failure"),
    prior: initial.generation,
  });
  const recovery = {
    workflowRun: "recovery-run-1",
    authorized: true,
    generation: failed.generation.digest,
    head: failed.generation.head,
    producer: producers["Lifecycle handoff"],
    result: "recovery-1",
  };
  assertInvalidRecovery(failed, recovery);
  const recovered = coalesceLifecycleInputGeneration(
    request({ attemptSequence: 1, prior: failed.generation, recovery }),
  );
  assert.equal(recovered.ok, true);
  const settled = coalesceLifecycleInputGeneration({
    ...request({ attemptSequence: 1, prior: recovered.generation, recovery }),
    completion: completion(recovered),
  });
  assert.equal(settled.decision, "attach");
  assert.deepEqual(settled.starts, []);
  for (const replacement of [
    undefined,
    { ...recovery, result: "replacement" },
  ]) {
    assert.equal(
      coalesceLifecycleInputGeneration({
        ...request({ attemptSequence: 1, prior: recovered.generation }),
        completion: completion(recovered),
        recovery: replacement,
      }).ok,
      false,
    );
  }
});

test("rejects hostile generation evidence", () => {
  const hostile = new Proxy({}, { get: () => assert.fail("hostile getter") });
  assert.equal(matchesCurrentLifecycleGeneration(hostile, hostile), false);
});

test("binds recovery authorization to one terminal generation and head", () => {
  const first = coalesceLifecycleInputGeneration(request());
  const failed = coalesceLifecycleInputGeneration({
    ...request(),
    completion: completion(first, "failure"),
    prior: first.generation,
  });
  const otherHead = "3".repeat(40);
  const otherClassification = {
    ...classification,
    binding: { ...classification.binding, head: otherHead },
  };
  const second = coalesceLifecycleInputGeneration(
    request({ classification: otherClassification }),
  );
  const otherFailed = coalesceLifecycleInputGeneration({
    ...request({ classification: otherClassification }),
    completion: completion(second, "failure", { head: otherHead }),
    prior: second.generation,
  });
  const recovery = {
    authorized: true,
    generation: failed.generation.digest,
    head: failed.generation.head,
    producer: producers["Lifecycle handoff"],
    result: "recovery-1",
    workflowRun: "recovery-run-1",
  };
  assert.equal(
    coalesceLifecycleInputGeneration(
      request({ attemptSequence: 1, prior: failed.generation, recovery }),
    ).ok,
    true,
  );
  assert.equal(
    coalesceLifecycleInputGeneration(
      request({ attemptSequence: 1, prior: otherFailed.generation, recovery }),
    ).ok,
    false,
  );
});

test("binds transition issue identity and lifecycle lock fence", () => {
  const transition = {
    actorRole: "implementer",
    applied: true,
    authority: classification.binding.authority,
    eventIdentity: "handoff-1",
    head,
    issueIdentity: classification.binding.issueIdentity,
    lockFence: "lock-1",
    producer: producers["Lifecycle handoff"],
    pullRequest: 32,
    repository: classification.binding.repository,
    result: "result-1",
    resultRevision: "observation-2",
    source: "status: pr open",
    sourceRevision: "observation-1",
    target: "status: ready for human review",
    targetRef: classification.binding.target,
    workflowRun: "run-1",
  };
  const input = {
    generation: { expectedProducers: producers },
    generationRequest: { inputs: inputs("observation-2") },
    phaseOne: {
      inputs: inputs("observation-1", "status: pr open"),
      lockFence: "lock-1",
    },
    transition,
  };
  assert.equal(validateTransitionBinding(input, classification), true);
  for (const changed of [
    { transition: { ...transition, issueIdentity: "other" } },
    { phaseOne: { ...input.phaseOne, lockFence: "other" } },
    { transition: null },
  ]) {
    assert.equal(
      validateTransitionBinding({ ...input, ...changed }, classification),
      false,
    );
  }
});

test("rejects malformed initial, observation, orphan, and stored generations", () => {
  const initial = coalesceLifecycleInputGeneration(request());
  const malformedInputs = structuredClone(inputs());
  malformedInputs.fields[0].name = "unknown";
  for (const invalid of [
    null,
    request({ classification: null }),
    request({ classification: { ok: false } }),
    request({ attemptSequence: Number.NaN }),
    request({ attemptSequence: 1 }),
    request({ recovery: { authorized: true } }),
    request({ completion: completion(initial) }),
    request({ inputs: malformedInputs }),
    request({
      inputs: inputs(),
      classification: {
        ...classification,
        binding: { ...classification.binding, target: "dev" },
      },
    }),
  ]) {
    assert.equal(coalesceLifecycleInputGeneration(invalid).ok, false);
  }
  for (const change of [
    { digest: "f".repeat(64) },
    { head: "f".repeat(40) },
    { status: "success" },
    { results: { "Lifecycle handoff": completion(initial) } },
  ]) {
    assert.equal(
      coalesceLifecycleInputGeneration({
        ...request(),
        prior: { ...initial.generation, ...change },
      }).ok,
      false,
    );
  }
});
