import assert from "node:assert/strict";
import test from "node:test";

import { validateRepositoryControls } from "./repository-controls.mjs";
import {
  repositoryControlsEvidence as evidence,
  repositoryControlsNow as now,
  repositoryControlsPolicy as policy,
} from "./repository-controls.test-fixtures.mjs";

const validate = (value) => validateRepositoryControls(value, policy(), now);
const rejection = (value, scenario) =>
  value.probes.brokerRejections.find((row) => row.scenario === scenario);
const denial = (value, effect) =>
  value.probes.denials.find((row) => row.effect === effect);

test("requires the complete per-principal denial and caller off-scope matrix", () => {
  const expected = [
    "broker_broader_target",
    "broker_environments",
    "broker_maintainer_impersonation",
    "broker_secrets",
    "caller_broader_target",
    "caller_environments",
    "caller_maintainer_impersonation",
    "caller_secrets",
    "caller_wrong_branch",
    "caller_wrong_issue",
    "caller_wrong_lifecycle_request",
    "caller_wrong_pull_request",
  ];
  const value = evidence();
  const effects = value.probes.denials.map(({ effect }) => effect);
  for (const effect of expected) assert.ok(effects.includes(effect), effect);
  value.probes.denials = value.probes.denials.filter(
    ({ effect }) => effect !== "caller_wrong_issue",
  );
  assert.ok(validate(value).includes("denial_probes_invalid"));
});

test("binds every caller off-scope denial to the accepted coordinates", () => {
  for (const effect of [
    "caller_wrong_branch",
    "caller_wrong_issue",
    "caller_wrong_lifecycle_request",
    "caller_wrong_pull_request",
  ]) {
    const value = evidence();
    denial(value, effect).attemptedArtifact = "issues/5050";
    assert.ok(validate(value).includes("denial_probes_invalid"), effect);
  }
});

test("does not accept relabelled broker rejection or denial scenarios", () => {
  const value = evidence();
  const concurrent = rejection(value, "concurrent_request");
  const drift = rejection(value, "permission_drift");
  [concurrent.scenario, drift.scenario] = [drift.scenario, concurrent.scenario];
  assert.ok(validate(value).includes("broker_rejection_probes_invalid"));

  const denied = evidence();
  const secrets = denial(denied, "broker_secrets");
  const environments = denial(denied, "broker_environments");
  [secrets.effect, environments.effect] = [environments.effect, secrets.effect];
  assert.ok(validate(denied).includes("denial_probes_invalid"));
});

test("requires scenario-specific closed broker rejection evidence", () => {
  const cases = [
    [
      "concurrent_request",
      (row) => (row.details.competingTargetFence = row.targetFence),
    ],
    [
      "permission_drift",
      (row) => (row.details.observedPermissionsDigest = "f".repeat(64)),
    ],
    ["provider_failure", (row) => (row.details.submitted = true)],
    ["replay", (row) => (row.details.noRetry = false)],
    [
      "stale_base",
      (row) => (row.details.observedBase = row.details.expectedBase),
    ],
    [
      "stale_head",
      (row) => (row.details.observedHead = row.details.expectedHead),
    ],
    ["wrong_target", (row) => (row.details.attemptedTarget = "epic/**")],
    ["broader_target", (row) => (row.details.attemptedTarget = "dev")],
  ];
  for (const [scenario, mutate] of cases) {
    const value = evidence();
    mutate(rejection(value, scenario));
    assert.ok(
      validate(value).includes("broker_rejection_probes_invalid"),
      scenario,
    );
  }
});

test("requires globally unique request IDs without conflating replay linkage", () => {
  const value = evidence();
  const caller = value.probes.callerCapabilities[0];
  const broader = rejection(value, "broader_target");
  broader.requestId = caller.requestId;
  assert.ok(validate(value).includes("probe_request_ids_reused"));

  const valid = evidence();
  const replay = rejection(valid, "replay");
  assert.equal(
    replay.details.replayOfRequestId,
    valid.probes.broker.receipt.payload.requestId,
  );
  assert.notEqual(replay.requestId, replay.details.replayOfRequestId);
  assert.deepEqual(validate(valid), []);
});

test("includes the accepted broker receipt request in global uniqueness", () => {
  const value = evidence();
  value.probes.callerCapabilities[0].requestId =
    value.probes.broker.receipt.payload.requestId;
  assert.ok(validate(value).includes("probe_request_ids_reused"));
});
