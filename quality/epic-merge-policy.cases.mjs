import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildEpicMergeProbePlan,
  deriveEpicMergeAvailability,
  epicMergeGuardStatus,
  runGuardedEpicMerge,
} from "./epic-merge-broker.mjs";
import {
  activePolicy,
  disabledPolicy,
  enabledPolicy,
  probeManifest,
  probeOnlyPolicy,
  repository,
  request,
  sha,
  successfulPorts,
} from "./epic-merge-broker-fixtures.mjs";

test("protected policy derives disabled before signed activation", () => {
  assert.deepEqual(deriveEpicMergeAvailability(disabledPolicy()), {
    reason: "activation_inactive",
    state: "disabled",
  });
});

test("repository policy produces a redacted disabled pre-activation status", async () => {
  const policy = JSON.parse(
    await readFile(
      new URL("./epic-merge-policy.json", import.meta.url),
      "utf8",
    ),
  );
  policy.source.revision = sha("a");
  assert.deepEqual(epicMergeGuardStatus(policy), {
    effects: "none",
    mode: "agent-credentialed",
    policyRevision: sha("a"),
    reason: "activation_inactive",
    state: "disabled",
  });
});

test("shape-only protected ref without exact revision remains disabled", () => {
  const policy = disabledPolicy();
  delete policy.source.revision;
  assert.deepEqual(deriveEpicMergeAvailability(policy), {
    reason: "protected_policy_invalid",
    state: "disabled",
  });
});

test("disabled guard makes no authorization, persistence, or provider call", async () => {
  const calls = [];
  const ports = {
    loadAuthorization: async () => calls.push("authorization"),
    loadProtectedPolicy: async () => disabledPolicy(),
    mergePullRequest: async () => calls.push("merge"),
    persistOperation: async () => calls.push("operation"),
    claimSerialization: async () => calls.push("claim"),
  };
  assert.deepEqual(await runGuardedEpicMerge(request(), ports), {
    mode: "agent-credentialed",
    reason: "activation_inactive",
    result: "denied",
  });
  assert.deepEqual(calls, []);
});

test("signed activation selects probe-only until exact live proof settles", () => {
  assert.deepEqual(deriveEpicMergeAvailability(activePolicy()), {
    reason: "live_proof_unavailable",
    state: "probe-only",
  });
});

test("unsigned or wrong-producer activation remains disabled", () => {
  for (const change of [
    (policy) => (policy.activation.signed = false),
    (policy) => (policy.activation.producer = "caller-selected"),
    (policy) => (policy.activation.commit = "not-a-commit"),
  ]) {
    const policy = activePolicy();
    change(policy);
    assert.deepEqual(deriveEpicMergeAvailability(policy), {
      reason: "protected_policy_invalid",
      state: "disabled",
    });
  }
});

test("complete expected-producer proof promotes protected policy to enabled", () => {
  assert.deepEqual(deriveEpicMergeAvailability(enabledPolicy()), {
    reason: "live_proof_settled",
    state: "enabled",
  });
});

test("invalid proof cannot promote general delivery", () => {
  const changes = [
    (policy) => (policy.liveProof = null),
    (policy) => (policy.liveProof.receipt.manifestDigest = "f".repeat(64)),
    (policy) => (policy.liveProof.receipt.producer = "caller-selected"),
    (policy) => (policy.liveProof.status.producer = "caller-selected"),
    (policy) => (policy.liveProof.receipt.matrixComplete = false),
    (policy) => (policy.liveProof.receipt.ambiguous = true),
    (policy) => (policy.liveProof.status.conclusion = "skipped"),
  ];
  for (const change of changes) {
    const policy = enabledPolicy();
    change(policy);
    assert.deepEqual(deriveEpicMergeAvailability(policy), {
      reason: "live_proof_unavailable",
      state: "probe-only",
    });
  }
});

test("active policy rejects malformed, empty, duplicate, or unknown authority", () => {
  const mutations = [
    (policy) => (policy.probeManifest = null),
    (policy) => (policy.requiredChecks = []),
    (policy) => (policy.requiredEvidence = []),
    (policy) => policy.requiredChecks.push(policy.requiredChecks[0]),
    (policy) => policy.requiredEvidence.push(policy.requiredEvidence[0]),
    (policy) => (policy.callerOverride = true),
    (policy) => (policy.probeManifest.operations = []),
    (policy) => (policy.probeManifest.issue = 50),
  ];
  for (const mutate of mutations) {
    const policy = enabledPolicy();
    mutate(policy);
    assert.deepEqual(deriveEpicMergeAvailability(policy), {
      reason: "protected_policy_invalid",
      state: "disabled",
    });
  }
});

test("protected policy freezes exact canonical producer identities", () => {
  const policy = enabledPolicy();
  policy.expectedProducers = {
    activation: "evil-activation@protected-dev",
    proof: "evil-proof@protected-dev",
    status: "evil-status@protected-dev",
  };
  policy.activation.producer = policy.expectedProducers.activation;
  policy.liveProof.receipt.producer = policy.expectedProducers.proof;
  policy.liveProof.status.producer = policy.expectedProducers.status;
  assert.deepEqual(deriveEpicMergeAvailability(policy), {
    reason: "protected_policy_invalid",
    state: "disabled",
  });
});

test("probe-only rejects operations outside issue 55 frozen manifest", async () => {
  const policy = activePolicy();
  policy.probeManifest = probeManifest(policy);
  const calls = [];
  const result = await runGuardedEpicMerge(request(), {
    loadAuthorization: async () => calls.push("authorization"),
    loadProtectedPolicy: async () => policy,
    mergePullRequest: async () => calls.push("merge"),
  });
  assert.equal(result.reason, "probe_manifest_mismatch");
  assert.deepEqual(calls, []);
});

test("probe-only permits only an activation-bound exact operation", async () => {
  const exact = await runGuardedEpicMerge(
    request(),
    successfulPorts([], { policy: probeOnlyPolicy() }),
  );
  assert.equal(exact.result, "merged");
  const stalePolicy = probeOnlyPolicy();
  stalePolicy.probeManifest.activationCommit = sha("f");
  const events = [];
  const stale = await runGuardedEpicMerge(
    request(),
    successfulPorts(events, { policy: stalePolicy }),
  );
  assert.equal(stale.result, "denied");
  assert.equal(
    events.some(([name]) => name === "merge"),
    false,
  );
});

test("v2 plan derives provider-parent targets and preserves actual refs", () => {
  const plan = buildEpicMergeProbePlan({
    parents: {
      primary: { number: 5500, providerAssigned: true },
      stale: { number: 5600, providerAssigned: true },
    },
    refs: {
      dev: { exists: true, name: "dev", tip: sha("6") },
      feature: {
        exists: true,
        name: "codex/probe-feature",
        tip: sha("7"),
      },
      main: { exists: false, name: "main", tip: null },
      release: {
        exists: true,
        name: "release/probe-denial",
        tip: sha("8"),
      },
      wrongEpic: {
        exists: true,
        name: "epic/999-wrong",
        tip: sha("9"),
      },
    },
    repository,
    schema: 2,
    targetSlug: "guard-proof",
  });
  assert.equal(plan.primary.target, "epic/5500-guard-proof");
  assert.equal(plan.stale.target, "epic/5600-guard-proof-stale");
  assert.equal(plan.concurrency.attempts.length, 2);
  assert.equal(plan.concurrency.attempts[0].target, plan.primary.target);
  assert.equal(plan.concurrency.attempts[1].target, plan.primary.target);
  assert.notEqual(
    plan.concurrency.attempts[0].requestId,
    plan.concurrency.attempts[1].requestId,
  );
  assert.deepEqual(plan.denials.main.before, { exists: false, tip: null });
  assert.equal(plan.denials.main.createAllowed, false);
  for (const name of ["dev", "feature", "release", "wrongEpic"])
    assert.equal(plan.denials[name].before.tip, plan.refs[name].tip);
});
