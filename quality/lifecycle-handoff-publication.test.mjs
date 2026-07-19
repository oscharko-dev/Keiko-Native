import assert from "node:assert/strict";
import test from "node:test";
import { issueSchemaForLabels } from "./issue-contract.mjs";
import { semanticIssueFingerprint } from "./issue-contract.mjs";
import { coalesceLifecycleInputGeneration } from "./lifecycle-handoff-generation.mjs";
import { evaluatePublicationLifecycleHandoff } from "./lifecycle-handoff-publication.mjs";
import { classifyLifecycleHandoffLane } from "./lifecycle-handoff.mjs";
import { verifyPublicationCandidate } from "./publication-candidate.mjs";
import { contractSha256 } from "./repository-contract.mjs";
const repository = "oscharko-dev/Keiko-Native";
const base = "1".repeat(40);
const head = "2".repeat(40);
const contractPath = "docs/contracts/task-30-v3-r1.md";
const receiptPath = "docs/contracts/publications/pr-77.md";
const issueTitle = "Publication candidate contract";
const contexts =
  "Contract publication|Issue contract current|PR contract".split("|");
// prettier-ignore
const producers = { "Contract publication": "publication.yml@protected-dev", "Issue contract current": "issue-current.yml@protected-dev", "Lifecycle handoff": "lifecycle-handoff.yml@protected-dev", "PR contract": "pr-contract.yml@protected-dev" };
const text = (value) => ({ type: "string", value });
const taskHeadings = issueSchemaForLabels(["type: task"]).requiredHeadings;
const completeSection =
  "- Contract version: `v3`\n- Applicability: Required\n- Actor: Developer\n- [x] Scope and verification are complete.\n\n```text\nnode --test quality/lifecycle-handoff-publication.test.mjs\n```";
// prettier-ignore
const contractBody = taskHeadings.map((heading) => `## ${heading}\n\n${heading === "Acceptance criteria" ? "- [ ] AC1 — Candidate is accepted." : completeSection}`).join("\n\n");
function ordinaryCandidate() {
  const contractBytes = Buffer.from(contractBody);
  const fingerprint = semanticIssueFingerprint(contractBody, issueTitle);
  const candidate = {
    digest: contractSha256(contractBytes).digest,
    mode: "100644",
    path: contractPath,
  };
  const observation = {
    candidatePath: contractPath,
    fingerprint,
    lifecycleLabels: ["status: new"],
    linkedPullRequest: null,
    number: 30,
    predecessor: null,
    readiness: null,
    readinessProducer: null,
    recoveries: [],
    revision: 1,
    state: "open",
    type: "task",
    version: 3,
  };
  const receiptValue = {
    candidates: [candidate],
    observations: [observation],
    pullRequest: 77,
    target: "dev",
    terminalManifest: null,
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receiptValue)}\n`);
  const files = [
    { mode: "100644", path: contractPath, status: "added" },
    { mode: "100644", path: receiptPath, status: "added" },
  ];
  const entries = [
    { bytes: receiptBytes, mode: "100644", path: receiptPath },
    { bytes: contractBytes, mode: "100644", path: contractPath },
  ];
  return {
    diff: {
      base,
      complete: true,
      files,
      head,
      normalValidated: false,
      pullRequest: 77,
      repository,
      truncated: false,
    },
    issueObservations: [observation],
    issueTitles: [{ number: 30, title: issueTitle }],
    newlyAdded: { base, entries, head, pullRequest: 77, repository },
    pullRequest: {
      base,
      baseRef: "dev",
      head,
      merged: false,
      number: 77,
      state: "open",
    },
    receipt: {
      bytes: receiptBytes,
      digest: contractSha256(receiptBytes).digest,
      path: receiptPath,
    },
    repository,
    target: "dev",
    terminalManifest: null,
  };
}
function rewriteReceipt(input, mutate) {
  const value = JSON.parse(Buffer.from(input.receipt.bytes).toString("utf8"));
  mutate(value);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  input.receipt.bytes = bytes;
  input.receipt.digest = contractSha256(bytes).digest;
  input.newlyAdded.entries[0].bytes = bytes;
  input.issueObservations = structuredClone(value.observations);
}
function reversedMultiCandidate() {
  const input = ordinaryCandidate();
  const path = "docs/contracts/task-31-v3-r1.md";
  const title = "Second publication candidate contract";
  // prettier-ignore
  const bytes = Buffer.from(contractBody.replace("Candidate", "Second candidate"));
  const digest = contractSha256(bytes).digest;
  input.diff.files.unshift({ mode: "100644", path, status: "added" });
  input.newlyAdded.entries.push({ bytes, mode: "100644", path });
  rewriteReceipt(input, ({ candidates, observations }) => {
    candidates.push({ digest, mode: "100644", path });
    // prettier-ignore
    observations.push({ ...observations[0], candidatePath: path, fingerprint: semanticIssueFingerprint(bytes.toString(), title), number: 31 });
  });
  input.issueTitles.push({ number: 31, title });
  return input;
}
function migrationCandidate(lifecycle) {
  const input = ordinaryCandidate();
  const readiness =
    "https://github.com/oscharko-dev/Keiko-Native/issues/30#issuecomment-123";
  rewriteReceipt(input, (receipt) => {
    const observation = receipt.observations[0];
    observation.lifecycleLabels = [lifecycle];
    observation.linkedPullRequest = [
      "status: pr open",
      "status: ready for human review",
    ].includes(lifecycle)
      ? { head: "3".repeat(40), number: 88, target: "epic/29-contracts" }
      : null;
    observation.readiness = readiness;
    observation.readinessProducer = "issue-readiness.yml@protected-dev";
  });
  const entries = structuredClone(input.issueObservations);
  const bytes = Buffer.from("# Terminal migration manifest\n");
  const manifest = {
    digest: contractSha256(bytes).digest,
    path: "docs/qa/repository-migration-manifest-v1.md",
  };
  rewriteReceipt(input, (receipt) => (receipt.terminalManifest = manifest));
  input.terminalManifest = {
    base,
    bytes,
    digest: manifest.digest,
    entries,
    mode: "100644",
    path: manifest.path,
    repository,
  };
  return input;
}
function lifecycleInputs(accepted) {
  const identity = contractSha256(
    Buffer.from(JSON.stringify(accepted.binding)),
  ).digest;
  return {
    fields: [
      ["issueRevision", "publication-1"],
      ["readiness", "publication-snapshot"],
      ["lifecycle", `publication:${accepted.binding.submode}`],
      ["target", accepted.binding.target],
      ["reviews", "reviews-1"],
      ["conversations", "conversations-1"],
      ["audit", "audit-1"],
      ["journey", "journey-1"],
      ["manual", "manual-1"],
      ["external", "external-1"],
      ["platform", "platform-1"],
      ["upstream", identity],
    ].map(([name, value]) => ({ name, value: text(value) })),
    type: "record",
  };
}
function classification(input, accepted, authorityOverrides = {}, ok = true) {
  const lane = classifyLifecycleHandoffLane({
    authority: {
      evidence: "publication-observation-1",
      head: input.pullRequest.head,
      id: "publication-pr-77",
      issueIdentity: "issue-32",
      lane: "publication",
      manifest: accepted.binding.terminalManifest,
      pullRequest: input.pullRequest.number,
      receipt: accepted.binding.receipt,
      repository: input.repository,
      scope: null,
      submode: accepted.binding.submode,
      target: input.target,
      ...authorityOverrides,
    },
    candidate: input,
    diff: input.diff,
    target: input.target,
  });
  assert.equal(lane.ok, ok);
  return lane;
}
function completion(state, context, output, overrides = {}) {
  return {
    conclusion: "success",
    context,
    generation: state.generation.digest,
    head,
    output,
    producer: producers[context],
    result: `${context}-result-1`,
    workflowRun: `${context}-run-1`,
    ...overrides,
  };
}
function handoffInput(candidate) {
  const accepted = verifyPublicationCandidate(candidate);
  assert.equal(accepted.ok, true);
  const lane = classification(candidate, accepted);
  const request = {
    attemptSequence: 0,
    classification: lane,
    expectedProducers: producers,
    inputs: lifecycleInputs(accepted),
  };
  let state = coalesceLifecycleInputGeneration(request);
  for (const context of contexts) {
    const output = structuredClone(accepted);
    state = coalesceLifecycleInputGeneration({
      ...request,
      completion: completion(state, context, output),
      prior: state.generation,
    });
  }
  return {
    candidate,
    classification: lane,
    generation: state.generation,
    generationRequest: request,
  };
}
test("re-evaluates and accepts the exact ordinary B2 candidate and matrix", () => {
  const candidate = reversedMultiCandidate();
  const accepted = verifyPublicationCandidate(candidate);
  for (const authority of [
    { evidence: "" },
    { scope: "ordinary-delivery" },
    { submode: "migration" },
    { receipt: { digest: "a".repeat(64), path: receiptPath } },
  ]) {
    assert.equal(
      classification(candidate, accepted, authority, false).code,
      "invalid_publication_authority",
    );
  }
  const result = evaluatePublicationLifecycleHandoff(handoffInput(candidate));
  assert.equal(result.ok, true);
  assert.equal(result.readinessClaim, false);
  assert.deepEqual(result.lifecycleMutations, []);
});
test("accepts all six retained migration lifecycles through real B2", () => {
  for (const lifecycle of [
    "status: ready",
    "status: in progress",
    "status: pr open",
    "status: ready for human review",
    "status: blocked",
    "status: waiting for user",
  ]) {
    const result = evaluatePublicationLifecycleHandoff(
      handoffInput(migrationCandidate(lifecycle)),
    );
    assert.equal(result.ok, true, lifecycle);
    assert.equal(result.binding.laneIdentity.candidate.submode, "migration");
  }
});
test("rejects stale current candidate and post-merge-only evidence", () => {
  const altered = (mutate, create = ordinaryCandidate) => {
    const input = create();
    mutate(input);
    return input;
  };
  const valid = handoffInput(ordinaryCandidate());
  for (const candidate of [
    altered((input) => (input.target = "epic/29-contracts")),
    altered((input) => (input.receipt.digest = "a".repeat(64))),
    altered((input) => (input.receipt.bytes = Buffer.from("stale\n"))),
    altered((input) => (input.pullRequest.state = "closed")),
    altered((input) => (input.pullRequest.merged = true)),
    altered((input) => (input.diff.head = "4".repeat(40))),
    altered(
      (input) => (input.issueObservations[0].fingerprint = "a".repeat(64)),
      () => migrationCandidate("status: ready"),
    ),
    altered(
      (input) => (input.terminalManifest.digest = "a".repeat(64)),
      () => migrationCandidate("status: blocked"),
    ),
    altered(
      (input) =>
        (input.issueObservations[0].linkedPullRequest.head = "4".repeat(40)),
      () => migrationCandidate("status: pr open"),
    ),
  ]) {
    assert.equal(
      evaluatePublicationLifecycleHandoff({ ...valid, candidate }).ok,
      false,
    );
  }
  assert.equal(
    evaluatePublicationLifecycleHandoff({ ...valid, candidate: undefined }).ok,
    false,
  );
});
test("rejects fabricated output, stale generations, and identity replay", () => {
  const mutate = (change) => {
    const input = handoffInput(ordinaryCandidate());
    change(input);
    return evaluatePublicationLifecycleHandoff(input);
  };
  for (const [index, result] of [
    ...contexts.flatMap((context) => [
      mutate((input) => {
        input.generation.results[context].output = { context, ok: true };
      }),
      mutate((input) => {
        input.generation.results[context].output.binding.observations = [];
      }),
    ]),
    mutate(
      (input) =>
        (input.generation.results["Contract publication"].generation =
          "f".repeat(64)),
    ),
    mutate(
      (input) =>
        (input.generation.results["Issue contract current"].producer =
          "forged"),
    ),
    mutate((input) => {
      input.generation.results["PR contract"].workflowRun =
        input.generation.results["Issue contract current"].workflowRun;
    }),
    mutate((input) => {
      input.generation.results["PR contract"].result =
        input.generation.results["Issue contract current"].result;
    }),
    mutate(
      (input) =>
        (input.generation.results["PR contract"].output.readinessClaim = true),
    ),
    mutate(
      (input) => (input.generation.results["PR contract"].output.ok = false),
    ),
    mutate(
      (input) =>
        (input.classification.binding.candidate.receipt.digest = "a".repeat(
          64,
        )),
    ),
    mutate(
      (input) =>
        (input.generationRequest.inputs.fields[11].value.value = "stale"),
    ),
    mutate((input) => {
      const result = input.generation.results["PR contract"];
      input.generation.results.Injected = { ...result, context: "Injected" };
    }),
  ].entries()) {
    assert.equal(result.ok, false, `${index}`);
  }
});
test("fails closed and redacts hostile publication evidence", () => {
  assert.equal(
    evaluatePublicationLifecycleHandoff(null).code,
    "invalid_publication_input",
  );
  const hostile = new Proxy({}, { ownKeys: () => assert.fail("SECRET") });
  const result = evaluatePublicationLifecycleHandoff({ candidate: hostile });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.message, /SECRET/iu);
  const throwing = new Proxy({}, { get: () => assert.fail("SECRET") });
  assert.equal(evaluatePublicationLifecycleHandoff(throwing).ok, false);
});
test("fails the matrix when trusted lane identity changes during evaluation", () => {
  const input = handoffInput(ordinaryCandidate());
  let headReads = 0;
  const binding = new Proxy(input.classification.binding, {
    get(target, key, receiver) {
      if (key === "head" && (headReads += 1) > 4) return base;
      return Reflect.get(target, key, receiver);
    },
  });
  const classification = { ...input.classification, binding };
  input.classification = classification;
  input.generationRequest.classification = classification;
  const result = evaluatePublicationLifecycleHandoff(input);
  assert.equal(result.code, "publication_matrix_failed");
});
