import assert from "node:assert/strict";
import test from "node:test";
import {
  bindEpicMergeAuthorizationSnapshot,
  decideEpicMergeAuthorization,
} from "./epic-merge-broker.mjs";
import {
  classifyLifecycleHandoffLane,
  coalesceLifecycleInputGeneration,
} from "./lifecycle-handoff.mjs";

const sha = (value) => value.repeat(40);
// prettier-ignore
const [repository, target] = ["oscharko-dev/Keiko-Native", "epic/29-repository-backed-contracts"];
const [base, head, fingerprint] = [sha("1"), sha("2"), "c".repeat(64)];
// prettier-ignore
const producers = { "Issue contract current": "issue-current.yml@protected-dev", "Lifecycle handoff": "lifecycle-handoff.yml@protected-dev", "PR contract": "pr-contract.yml@protected-dev" };
// prettier-ignore
const observed = (revision, lifecycle) => ({
  fields: [["issueRevision", revision], ["readiness", `10:v2:${fingerprint}`], ["lifecycle", lifecycle], ["target", target], ["reviews", "reviews-1"], ["conversations", "conversations-1"], ["audit", "audit-1"], ["journey", "journey-1"], ["manual", "manual-1"], ["external", "external-1"], ["platform", "platform-1"], ["upstream", "upstream-1"]].map(([name, value]) => ({ name, value: { type: "string", value } })),
  type: "record",
});
// prettier-ignore
function handoffInput(identity = {}) {
  const currentBase = identity.base ?? base;
  const currentHead = identity.head ?? head;
  const issueIdentity = identity.issueIdentity ?? "issue-33";
  const pullRequest = identity.pullRequest ?? 33;
  const b4Producers = { ...producers, ...identity.b4Producers };
  const laneInput = {
    authority: { head: currentHead, id: `${issueIdentity}-v2`, issueIdentity, lane: "normal", pullRequest, repository, scope: "quality/merge-group*", target },
    diff: { base: currentBase, complete: true, files: [], head: currentHead, normalValidated: true, pullRequest, repository, truncated: false },
    target,
  };
  const classification = classifyLifecycleHandoffLane(laneInput);
  const generationRequest = {
    attemptSequence: 0, classification, expectedProducers: b4Producers,
    inputs: observed("observation-2", "status: ready for human review"),
  };
  let state = coalesceLifecycleInputGeneration(generationRequest);
  for (const context of ["Issue contract current", "PR contract"]) {
    state = coalesceLifecycleInputGeneration({
      ...generationRequest,
      completion: {
        conclusion: "success", context, generation: state.generation.digest, head: currentHead,
        output: { binding: classification.binding, ok: true }, producer: b4Producers[context],
        result: `${context}-result${identity.resultSuffix ?? ""}`,
        workflowRun: `${context}-run${identity.resultSuffix ?? ""}`,
      },
      prior: state.generation,
    });
  }
  const eventIdentity = identity.eventIdentity ?? `handoff-${pullRequest}`;
  const transition = {
    actorRole: "implementer", applied: true, authority: `${issueIdentity}-v2`, eventIdentity, head: currentHead,
    issueIdentity, lockFence: `issue-fence-${pullRequest}`, producer: b4Producers["Lifecycle handoff"],
    pullRequest, repository, result: "handoff-result", resultRevision: "observation-2",
    source: "status: pr open", sourceRevision: "observation-1", target: "status: ready for human review",
    targetRef: target, workflowRun: "handoff-run",
  };
  return {
    classification, generation: state.generation, generationRequest,
    phaseOne: { conversationsCurrent: true, evidenceCurrent: true, excludedContexts: ["Lifecycle handoff"], head: currentHead, inputs: observed("observation-1", "status: pr open"), lockFence: `issue-fence-${pullRequest}`, ok: true, reviewsCurrent: true, sourceState: "status: pr open", target },
    readiness: { comments: [{ body: `<!-- keiko-native-readiness -->\n- Status: \`accepted\`\n- Contract version: \`v2\`\n- Fingerprint: \`${fingerprint}\``, id: 10, user: { id: 41898282, login: "github-actions[bot]", type: "Bot" } }], currentFingerprint: fingerprint, currentVersion: "v2", expectedCommentId: 10 },
    readback: { actualIssueIdentity: issueIdentity, expectedIssueIdentity: issueIdentity, head: currentHead, issueRevision: "observation-2", labels: ["status: ready for human review"], transitionIdentity: eventIdentity },
    transition,
  };
}
// prettier-ignore
const resultIdentity = (name) => ({ current: true, producer: `${name}.yml@protected-dev`, result: `${name}-result`, workflowRun: `${name}-run` });
// prettier-ignore
function brokerInput(identity = {}) {
  const currentBase = identity.base ?? base;
  const currentHead = identity.head ?? head;
  const issueIdentity = identity.issueIdentity ?? "issue-33";
  const pullRequest = identity.pullRequest ?? 33;
  const evidenceNames = ["audit", "conversations", "external", "journey", "manual", "platform", "reviews"];
  const expectedProducers = { ...Object.fromEntries([...evidenceNames, "composition"].map((name) => [name, `${name}.yml@protected-dev`])), ...producers, ...identity.policyProducers };
  const read = {
    composition: { base: currentBase, complete: true, head: currentHead, producer: expectedProducers.composition, result: identity.compositionResult ?? "composition-result", workflowRun: identity.compositionRun ?? "composition-run" },
    contractFingerprint: fingerprint, cursor: "issue-cursor-1", draft: false,
    evidence: Object.fromEntries(evidenceNames.map((name) => [name, resultIdentity(name)])),
    handoffInput: handoffInput(identity), head: currentHead, issueIdentity, issueUpdated: "observation-2",
    lifecycle: "status: ready for human review", mergeable: true,
    pagination: { complete: true, cursor: "issue-cursor-1", pages: [{ count: 7, end: "page-end-1", index: 0, start: "issue-cursor-1" }], truncated: false },
    pullRequest, readiness: `10:v2:${fingerprint}`, repository,
    source: `codex/issue-${pullRequest}-merge-group-broker`, target, targetTip: currentBase,
  };
  const locks = {
    issue: { acquired: true, current: true, fence: `issue-fence-${pullRequest}`, issueIdentity, repository }, order: ["issue", "target"],
    target: { acquired: true, current: true, fence: identity.targetFence ?? "target-fence-1", repository, target },
  };
  const semantics = Object.fromEntries([
    "completePagination", "cursorOrdering", "dualRefConditional", "exactOutcome",
    "fencing", "liveProbe", "stableReads",
  ].map((name) => [name, true]));
  const preSubmitRead = {
    head: currentHead, issueFence: locks.issue.fence, pullRequest, repository, target,
    targetFence: locks.target.fence, targetTip: currentBase,
  };
  return { expectedProducers, firstRead: read, locks, preSubmitRead, secondRead: structuredClone(read), semantics, submittedSnapshots: [] };
}
function prepared(input = brokerInput()) {
  const bound = bindEpicMergeAuthorizationSnapshot(input);
  return {
    bound,
    decide: (overrides = {}) =>
      decideEpicMergeAuthorization({
        ...input,
        snapshotReadback: bound.snapshot,
        ...overrides,
      }),
  };
}
function changedInput(mutate) {
  const input = brokerInput();
  mutate(input);
  input.secondRead = structuredClone(input.firstRead);
  return input;
}
const changedRead = (mutate) =>
  changedInput((input) => mutate(input.firstRead));
const changedBinding = (mutate) =>
  bindEpicMergeAuthorizationSnapshot(changedRead(mutate));
const changedDecision = (mutate) =>
  decideEpicMergeAuthorization(changedInput(mutate));
function assertMutations(mutations, action, select = (input) => input) {
  for (const mutate of mutations)
    assert.equal(
      changedDecision((input) => mutate(select(input))).action,
      action,
    );
}
// prettier-ignore
const staleReadMutations = [(read) => (read.issueUpdated = "semantic-edit"), (read) => (read.readiness = "lost"), (read) => (read.lifecycle = "status: pr open"), (read) => (read.head = sha("3")), (read) => (read.targetTip = sha("4")), (read) => (read.target = "dev"), (read) => (read.source = ""), (read) => (read.pullRequest = Number.NaN), (read) => (read.contractFingerprint = "bad"), (read) => (read.evidence.conversations.current = false), (read) => (read.evidence.audit.current = false), (read) => (read.evidence.audit.producer = ""), (read) => (read.evidence.Injected = resultIdentity("injected")), (read) => (read.pagination.complete = false), (read) => (read.pagination.truncated = true), (read) => (read.pagination.pages = []), (read) => (read.pagination.pages[0].count = -1), (read) => (read.pagination.pages[0].end = ""), (read) => (read.pagination.pages[0].index = 1), (read) => (read.composition.complete = false), (read) => (read.composition.result = ""), (read) => (read.draft = true), (read) => (read.mergeable = false), (read) => (read.handoffInput.generation.digest = "f".repeat(64)), (read) => (read.issueIdentity = "issue-34")];
// prettier-ignore
const unavailableMutations = [(input) => (input.firstRead = undefined), (input) => (input.firstRead.pagination.truncated = true), (input) => (input.firstRead.target = "dev")];
// prettier-ignore
const malformedEligibility = [(read) => (read.lifecycle = "status: invented"), (read) => (read.draft = "false"), (read) => (read.mergeable = null)];
// prettier-ignore
const ineligibleMutations = [(read) => (read.lifecycle = "status: pr open"), (read) => (read.draft = true), (read) => (read.mergeable = false)];
// prettier-ignore
const unprovenMutations = [(input) => delete input.submittedSnapshots, (input) => (input.submittedSnapshots = ["bad"]), (input) => (input.firstRead.evidence.audit.producer = "forged"), (input) => (input.firstRead.evidence.audit.conclusion = "failure"), (input) => (input.firstRead.Injected = true), (input) => (input.firstRead.composition.producer = "forged"), (input) => (input.expectedProducers.audit = ""), (input) => (input.expectedProducers.surplus = "forged"), (input) => (input.locks.issue.issueIdentity = "issue-34"), (input) => (input.locks.target.target = "epic/other"), (input) => (input.firstRead.contractFingerprint = "d".repeat(64))];
function acceptedResponse(snapshot, overrides = {}) {
  const mergeCommit = overrides.mergeCommit ?? sha("5");
  const proof = snapshot.preSubmit;
  // prettier-ignore
  return { head: proof.head, mergeCommit, parents: [proof.targetTip, proof.head], pullRequest: proof.pullRequest, repository: proof.repository, snapshotId: snapshot.id, status: "accepted", target: proof.target, targetTip: mergeCommit, ...overrides };
}

test("keeps automated merge disabled without proven provider semantics", () => {
  // prettier-ignore
  assert.deepEqual(decideEpicMergeAuthorization({}), { action: "human_only", automation: false, code: "automation_not_proven", ok: false, retry: false });
});

test("binds all stable facts and emits one dual-ref conditional request", () => {
  const input = brokerInput();
  const { bound, decide } = prepared(input);
  assert.equal(bound.ok, true);
  const decision = decide();
  assert.equal(decision.ok, true);
  assert.equal(decision.action, "submit_once");
  assert.equal(decision.request.expectedHead, head);
  assert.equal(decision.request.expectedTargetTip, base);
  assert.equal(decision.retry, false);
});

test("binds eligibility, pagination boundaries, and composition into identity", () => {
  const input = brokerInput();
  const original = bindEpicMergeAuthorizationSnapshot(input);
  const fields = original.snapshot.value.inputs.fields.map(({ name }) => name);
  for (const name of ["observation", "expectedProducers", "locks"])
    assert.equal(fields.includes(name), true, name);
  const changed = brokerInput();
  changed.firstRead.pagination.pages[0].end = "page-end-2";
  changed.secondRead.pagination.pages[0].end = "page-end-2";
  const rebound = bindEpicMergeAuthorizationSnapshot(changed);
  assert.notEqual(rebound.snapshot.id, original.snapshot.id);
});

test("binds every authenticated handoff result and transition identity", () => {
  const original = bindEpicMergeAuthorizationSnapshot(brokerInput());
  const changedResult = bindEpicMergeAuthorizationSnapshot(
    brokerInput({ resultSuffix: "-2" }),
  );
  const changedTransition = bindEpicMergeAuthorizationSnapshot(
    brokerInput({ eventIdentity: "handoff-33-2" }),
  );
  assert.equal(original.ok, true);
  assert.equal(changedResult.ok, true);
  assert.equal(changedTransition.ok, true);
  assert.notEqual(changedResult.snapshot.id, original.snapshot.id);
  assert.notEqual(changedTransition.snapshot.id, original.snapshot.id);
});

test("makes no submission decision after stale or incomplete stable reads", () => {
  for (const result of staleReadMutations.map(changedBinding)) {
    assert.equal(result.ok, false);
    assert.notEqual(result.action, "submit_once");
  }
  const race = brokerInput();
  race.secondRead.cursor = "hidden-pre-boundary-mutation";
  assert.equal(bindEpicMergeAuthorizationSnapshot(race).ok, false);
});

test("selects human-only for unavailable observations and dev authority", () => {
  assertMutations(unavailableMutations, "human_only");
});

test("distinguishes malformed eligibility facts from proven ineligibility", () => {
  const read = (input) => input.firstRead;
  assertMutations(malformedEligibility, "human_only", read);
  assertMutations(ineligibleMutations, "none", read);
});

test("distinguishes malformed post-bind proofs from valid changed identities", () => {
  const current = prepared();
  // prettier-ignore
  const otherInput = brokerInput({ head: sha("6"), issueIdentity: "issue-34", pullRequest: 34 });
  const other = bindEpicMergeAuthorizationSnapshot(otherInput).snapshot;
  // prettier-ignore
  for (const snapshotReadback of [undefined, {}, { ...current.bound.snapshot, surplus: true }])
    assert.equal(current.decide({ snapshotReadback }).action, "human_only");
  assert.equal(current.decide({ snapshotReadback: other }).action, "none");
  // prettier-ignore
  for (const preSubmitRead of [undefined, {}, { ...current.bound.snapshot, surplus: true }])
    assert.equal(current.decide({ preSubmitRead }).action, "human_only");
  assert.equal(
    current.decide({
      preSubmitRead: { ...brokerInput().preSubmitRead, head: sha("7") },
    }).action,
    "none",
  );
});

test("requires exact ledgers, producers, lock scopes, and readiness fingerprint", () => {
  assertMutations(unprovenMutations, "human_only");
});

test("accepts and binds an alternate exact protected producer policy", () => {
  const original = bindEpicMergeAuthorizationSnapshot(brokerInput());
  // prettier-ignore
  const alternateB4 = Object.fromEntries(Object.keys(producers).map((key) => [key, `alternate-${key}.yml@protected-dev`]));
  const input = brokerInput({
    b4Producers: alternateB4,
    policyProducers: alternateB4,
  });
  for (const key of Object.keys(input.expectedProducers)) {
    if (key in producers) continue;
    input.expectedProducers[key] = `alternate-${key}.yml@protected-dev`;
    // prettier-ignore
    const item = key === "composition" ? input.firstRead.composition : input.firstRead.evidence[key];
    item.producer = input.expectedProducers[key];
  }
  input.secondRead = structuredClone(input.firstRead);
  const alternate = bindEpicMergeAuthorizationSnapshot(input);
  assert.equal(alternate.ok, true);
  assert.notEqual(alternate.snapshot.id, original.snapshot.id);
});

test("rejects a self-consistent forged normal handoff producer policy", () => {
  const input = brokerInput({
    b4Producers: { "Issue contract current": "forged" },
  });
  assert.equal(decideEpicMergeAuthorization(input).action, "human_only");
});

test("rejects discontinuous broker pages and surplus accepted outcomes", () => {
  const paged = brokerInput();
  // prettier-ignore
  paged.firstRead.pagination.pages = [{ count: 3, end: "boundary-1", index: 0, start: paged.firstRead.cursor }, { count: 4, end: "boundary-2", index: 1, start: "gap" }];
  paged.secondRead = structuredClone(paged.firstRead);
  assert.equal(decideEpicMergeAuthorization(paged).action, "human_only");
  paged.firstRead.pagination.pages[1].start = "boundary-1";
  paged.firstRead.pagination.pages[1].end = "boundary-1";
  paged.secondRead = structuredClone(paged.firstRead);
  assert.equal(decideEpicMergeAuthorization(paged).action, "human_only");
  const loop = brokerInput();
  loop.firstRead.pagination.pages[0].end = loop.firstRead.cursor;
  loop.secondRead = structuredClone(loop.firstRead);
  assert.equal(decideEpicMergeAuthorization(loop).action, "human_only");
  const current = prepared();
  const response = acceptedResponse(current.bound.snapshot, { surplus: true });
  const submittedSnapshots = [current.bound.snapshot.id];
  assert.equal(
    current.decide({ conditionalResponse: response, submittedSnapshots })
      .action,
    "human_only",
  );
  delete response.surplus;
  delete response.parents;
  assert.equal(
    current.decide({ conditionalResponse: response, submittedSnapshots })
      .action,
    "human_only",
  );
});
test("serializes two children and requires fresh composition after target advance", () => {
  const first = prepared();
  const child = { head: sha("6"), issueIdentity: "issue-34", pullRequest: 34 };
  const secondInput = brokerInput(child);
  const second = prepared(secondInput);
  const mergeCommit = sha("5");
  const accepted = first.decide({
    conditionalResponse: acceptedResponse(first.bound.snapshot),
    submittedSnapshots: [first.bound.snapshot.id],
  });
  const stale = second.decide({
    preSubmitRead: { ...secondInput.preSubmitRead, targetTip: mergeCommit },
  });
  assert.equal(accepted.action, "accepted");
  assert.equal(stale.action, "none");
  const freshInput = brokerInput({
    ...child,
    base: mergeCommit,
    compositionResult: "composition-result-2",
    compositionRun: "composition-run-2",
    targetFence: "target-fence-2",
  });
  const fresh = prepared(freshInput);
  assert.equal(fresh.bound.ok, true);
  assert.notEqual(fresh.bound.snapshot.id, second.bound.snapshot.id);
  assert.equal(fresh.decide().action, "submit_once");
  assert.equal(fresh.decide().request.expectedTargetTip, mergeCommit);
});
test("fails human-only on unproven semantics and lost lock fences", () => {
  for (const key of Object.keys(brokerInput().semantics)) {
    const input = brokerInput();
    input.semantics[key] = false;
    assert.equal(decideEpicMergeAuthorization(input).action, "human_only");
  }
  for (const mutate of [
    (input) => (input.locks.issue.current = false),
    (input) => (input.locks.target.current = false),
    (input) => (input.locks.order = ["target", "issue"]),
  ]) {
    const input = brokerInput();
    mutate(input);
    assert.equal(decideEpicMergeAuthorization(input).action, "human_only");
  }
});
test("never reuses a snapshot and rejects changed refs or fences", () => {
  const current = prepared();
  const submitted = current.decide({
    submittedSnapshots: [current.bound.snapshot.id],
  });
  assert.equal(submitted.action, "human_only");
  for (const change of [
    { head: sha("3") },
    { targetTip: sha("4") },
    { issueFence: "lost" },
    { targetFence: "lost" },
  ]) {
    const result = current.decide({
      preSubmitRead: { ...brokerInput().preSubmitRead, ...change },
    });
    assert.equal(result.action, "none");
    assert.equal(result.retry, false);
  }
});
test("accepts an exact outcome and never retries ambiguous responses", () => {
  const current = prepared();
  const snapshot = current.bound.snapshot;
  const decide = (conditionalResponse) =>
    current.decide({ conditionalResponse, submittedSnapshots: [snapshot.id] });
  assert.equal(
    current.decide({ conditionalResponse: acceptedResponse(snapshot) }).code,
    "conditional_response_without_submission",
  );
  assert.equal(
    decide(acceptedResponse(snapshot, { mergeCommit: sha("5") })).action,
    "accepted",
  );
  for (const status of ["timeout", "partial", "forbidden"]) {
    const result = decide({ status });
    assert.equal(result.action, "human_only");
    assert.equal(result.retry, false);
  }
  assert.equal(decide({ status: "rejected" }).action, "none");
  assert.equal(
    decide({ accepted: true, status: "rejected" }).action,
    "human_only",
  );
});
test("fails closed on hostile broker evidence without exposing content", () => {
  const hostile = new Proxy({}, { get: () => assert.fail("SECRET") });
  const result = decideEpicMergeAuthorization(hostile);
  assert.equal(result.ok, false);
  assert.equal(result.retry, false);
  assert.doesNotMatch(result.code, /SECRET/iu);
  const input = brokerInput();
  const readback = new Proxy(input, {
    get: (value, key) =>
      key === "snapshotReadback"
        ? assert.fail("SECRET")
        : Reflect.get(value, key),
  });
  assert.equal(decideEpicMergeAuthorization(readback).ok, false);
});
