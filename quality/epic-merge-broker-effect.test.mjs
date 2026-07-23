import assert from "node:assert/strict";
import test from "node:test";

import { proveAcceptedEpicMergeEffect } from "./epic-merge-broker-effect.mjs";
import { acceptedBrokerAuthorizationInput } from "./repository-controls-broker.test-fixtures.mjs";

test("derives one accepted effect from the canonical broker decision", () => {
  const input = acceptedBrokerAuthorizationInput();
  assert.deepEqual(proveAcceptedEpicMergeEffect(input), {
    base: "1".repeat(40),
    head: "2".repeat(40),
    issueFence: "issue-fence-5050",
    issueIdentity: "issue-5050",
    mergeCommit: "5".repeat(40),
    parents: ["1".repeat(40), "2".repeat(40)],
    pullRequest: 5050,
    repository: "oscharko-dev/Keiko-Native",
    snapshotId: input.snapshotReadback.id,
    source: "codex/50-controls-probe",
    target: "epic/50-controls-probe",
    targetFence: "target-fence-50",
    targetTip: "5".repeat(40),
  });
});

test("rejects detached snapshots, effects, eligibility, and surplus input", () => {
  const mutations = [
    (input) => (input.surplus = true),
    (input) => (input.conditionalResponse.target = "dev"),
    (input) => input.conditionalResponse.parents.reverse(),
    (input) => (input.firstRead.lifecycle = "status: pr open"),
    (input) => (input.secondRead.evidence.audit.current = false),
    (input) => (input.locks.issue.current = false),
    (input) => (input.submittedSnapshots = []),
  ];
  for (const mutate of mutations) {
    const input = acceptedBrokerAuthorizationInput();
    mutate(input);
    assert.equal(proveAcceptedEpicMergeEffect(input), undefined);
  }
});

test("does not accept digest-shaped snapshot or fence substitutions", () => {
  for (const mutate of [
    (snapshot) => (snapshot.id = "d".repeat(64)),
    (snapshot) => (snapshot.preSubmit.issueFence = "arbitrary"),
    (snapshot) => (snapshot.preSubmit.targetFence = "arbitrary"),
  ]) {
    const input = acceptedBrokerAuthorizationInput();
    const snapshot = structuredClone(input.snapshotReadback);
    mutate(snapshot);
    input.snapshotReadback = snapshot;
    assert.equal(proveAcceptedEpicMergeEffect(input), undefined);
  }
});
