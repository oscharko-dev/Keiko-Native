import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateRepositoryControls } from "./repository-controls.mjs";
import {
  repositoryControlsEvidence as evidence,
  repositoryControlsNow as now,
  repositoryControlsPolicy as policy,
} from "./repository-controls.test-fixtures.mjs";

test("accepts separated caller and broker identities with exact protected controls", () => {
  const value = policy();
  assert.deepEqual(validateRepositoryControls(evidence(value), value, now), []);
});

test("durable evidence contains no raw broker input or provider comment bodies", () => {
  const serialized = JSON.stringify(evidence());
  for (const rawField of [
    "brokerDecisionInput",
    "<!-- keiko-native-readiness -->",
    "handoff-result",
    "comments",
    "body",
  ])
    assert.doesNotMatch(serialized, new RegExp(rawField, "u"));
});

test("checked-in policy is staged fail-closed until human identity and ruleset read-back", async () => {
  const value = JSON.parse(
    await readFile(
      new URL("./repository-controls-policy.json", import.meta.url),
      "utf8",
    ),
  );
  const failures = validateRepositoryControls({}, value, now);
  assert.ok(failures.includes("policy_caller_identity_pending"));
  assert.ok(failures.includes("policy_broker_identity_pending"));
  assert.ok(failures.includes("policy_epic_ruleset_pending"));
  assert.ok(failures.includes("policy_pending_checks_block_activation"));
  assert.equal(
    failures.includes("policy_broker_receipt_verification_invalid"),
    false,
  );
});

test("promotes activation checks only on their applicable branch class", () => {
  const value = policy();
  const devContexts = value.requiredChecks.map(({ context }) => context);
  const epicContexts = value.epic.requiredChecks.map(({ context }) => context);
  assert.ok(devContexts.includes("Contract publication"));
  assert.ok(devContexts.includes("Lifecycle handoff"));
  assert.equal(epicContexts.includes("Contract publication"), false);
  assert.ok(epicContexts.includes("Lifecycle handoff"));
});

test("freezes self-consistent authority coordinates and producer matrices", () => {
  const cases = [
    (value, item) => {
      value.repository = "owner/other";
      item.repository = "owner/other";
      item.broker.repository = "owner/other";
      item.broker.app.repositories = ["owner/other"];
      item.caller.app.repositories = ["owner/other"];
      item.probes.broker.repository = "owner/other";
    },
    (value, item) => {
      value.identities.broker.installationAccount = "other";
      value.identities.caller.installationAccount = "other";
      item.broker.app.account = "other";
      item.caller.app.account = "other";
    },
    (value, item) => {
      value.epic.probeTarget = "epic/other";
      item.probes.broker.target = "epic/other";
    },
    (value, item) => {
      value.requiredChecks[0].appId = 1;
      item.devProtection.requiredChecks[0].appId = 1;
    },
  ];
  for (const mutate of cases) {
    const value = policy();
    const item = evidence(value);
    mutate(value, item);
    assert.notDeepEqual(validateRepositoryControls(item, value, now), []);
  }
});

test("rejects arbitrary broker proof strings and substituted artifacts", () => {
  for (const mutate of [
    (value) => {
      value.probes.broker.receipt.payload.authorizationSnapshot.id = "d".repeat(
        64,
      );
    },
    (value) => {
      value.probes.broker.receipt.payload.authorizationSnapshot.preSubmit.issueFence =
        "arbitrary-issue-fence";
    },
    (value) => {
      value.probes.broker.receipt.payload.authorizationSnapshot.preSubmit.targetFence =
        "arbitrary-target-fence";
    },
    (value) =>
      (value.probes.callerCapabilities[0].artifact = "refs/heads/codex/other"),
    (value) => (value.probes.callerCapabilities[0].actorAppId = 4242),
    (value) => (value.probes.brokerRejections[0].actorAppId = 5252),
    (value) =>
      (value.probes.denials[0].attemptedTarget = "epic/50-controls-probe"),
    (value) => (value.probes.denials[0].actorAppId = 5252),
  ]) {
    const item = evidence();
    mutate(item);
    assert.notDeepEqual(validateRepositoryControls(item, policy(), now), []);
  }
});

test("rejects a token already expired at the evidence capture", () => {
  const item = evidence();
  item.caller.credential.expiresAt = "2026-07-23T11:59:59.000Z";
  assert.ok(
    validateRepositoryControls(
      item,
      policy(),
      Date.parse("2026-07-23T11:58:00.000Z"),
    ).includes("caller_token_expired_at_capture"),
  );
});

test("rejects a shared identity and any caller or broker permission drift", () => {
  const value = policy();
  value.identities.caller.appId = value.identities.broker.appId;
  assert.ok(
    validateRepositoryControls(evidence(), value, now).includes(
      "policy_identity_separation_invalid",
    ),
  );
  for (const mutate of [
    (item) => (item.caller.app.permissions.checks = "read"),
    (item) => (item.caller.credential.agentReadable = true),
    (item) => (item.caller.credential.ordinaryWorkflowReadable = true),
    (item) => (item.broker.app.permissions.pull_requests = "write"),
    (item) => (item.broker.app.permissions.administration = "write"),
  ]) {
    const item = evidence();
    mutate(item);
    assert.ok(
      validateRepositoryControls(item, policy(), now).some((failure) =>
        /credential|permissions/u.test(failure),
      ),
    );
  }
});

test("requires exact staged broker receipt public verification material", () => {
  for (const mutate of [
    (value) =>
      (value.identities.broker.receiptVerificationKeyFingerprint = "f".repeat(
        64,
      )),
    (value) =>
      (value.identities.broker.receiptVerificationKey = "not-a-public-key"),
    (value) => {
      value.identities.broker.receiptVerificationKey = null;
      value.identities.broker.receiptVerificationKeyFingerprint = null;
    },
  ]) {
    const value = policy();
    mutate(value);
    assert.ok(
      validateRepositoryControls(evidence(), value, now).includes(
        "policy_broker_receipt_verification_invalid",
      ),
    );
  }
});

test("rejects dev authority, producer, epic-target, queue, and bypass drift", () => {
  const cases = [
    [
      "dev_update_allowlist_mismatch",
      (value) =>
        value.devProtection.updateAllowlist.apps.push(
          "keiko-epic-merge-broker",
        ),
    ],
    [
      "dev_required_checks_mismatch",
      (value) => (value.devProtection.requiredChecks[0].appId = 1),
    ],
    [
      "epic_update_allowlist_mismatch",
      (value) =>
        value.epicProtection.updateAllowlist.apps.push(
          "keiko-restricted-caller",
        ),
    ],
    [
      "epic_update_allowlist_mismatch",
      (value) => (value.epicProtection.updateAllowlist.apps[0].appId = 9999),
    ],
    [
      "epic_required_checks_mismatch",
      (value) => value.epicProtection.requiredChecks.pop(),
    ],
    [
      "epic_bypass_actor_present",
      (value) => value.epicProtection.bypassActors.push("Integration:4242"),
    ],
    [
      "epic_ruleset_mismatch",
      (value) => value.epicProtection.exclude.push("refs/heads/epic/blocked"),
    ],
    [
      "epic_protection_mismatch",
      (value) => (value.epicProtection.strictChecks = false),
    ],
    [
      "epic_protection_mismatch",
      (value) => (value.epicProtection.forcePushAllowed = true),
    ],
    [
      "epic_protection_mismatch",
      (value) => (value.epicProtection.branchDeletionAllowed = true),
    ],
    [
      "merge_queue_mismatch",
      (value) => (value.mergeQueue.maxEntriesToMerge = 2),
    ],
  ];
  for (const [failure, mutate] of cases) {
    const value = evidence();
    mutate(value);
    assert.ok(
      validateRepositoryControls(value, policy(), now).includes(failure),
    );
  }
});

test("rejects stale, incomplete, wrong-target, replay, and recovery evidence", () => {
  const cases = [
    [
      "evidence_stale",
      (value) => (value.capturedAt = "2026-07-23T10:00:00.000Z"),
    ],
    [
      "source_probes_unavailable",
      (value) => (value.sources.probes = "unavailable"),
    ],
    [
      "broker_probe_invalid",
      (value) =>
        (value.probes.broker.receipt.payload.conditionalResponse.target =
          "dev"),
    ],
    [
      "broker_probe_invalid",
      (value) =>
        value.probes.broker.receipt.payload.conditionalResponse.parents.reverse(),
    ],
    [
      "broker_probe_invalid",
      (value) => (value.probes.broker.mergeCommitSigned = false),
    ],
    [
      "broker_probe_invalid",
      (value) =>
        (value.probes.broker.receipt.payload.authorizationSnapshot.preSubmit.head =
          "d".repeat(40)),
    ],
    [
      "caller_capability_probes_invalid",
      (value) => (value.probes.callerCapabilities[0].commitSigned = false),
    ],
    [
      "broker_rejection_probes_invalid",
      (value) => value.probes.brokerRejections.pop(),
    ],
    ["denial_probes_invalid", (value) => value.probes.denials.pop()],
    [
      "recovery_probes_invalid",
      (value) => (value.probes.recovery[0].noRetry = false),
    ],
    [
      "cleanup_probe_invalid",
      (value) => (value.probes.cleanup.artifactsRemaining = 1),
    ],
  ];
  for (const [failure, mutate] of cases) {
    const value = evidence();
    mutate(value);
    assert.ok(
      validateRepositoryControls(value, policy(), now).includes(failure),
    );
  }
});

test("rejects stale nested observations and detached broker identity", () => {
  const cases = [
    [
      "probe_observation_stale",
      (value) =>
        (value.probes.denials[0].observedAt = "2026-07-23T10:00:00.000Z"),
    ],
    [
      "broker_repository_mismatch",
      (value) => (value.broker.repository = "owner/other"),
    ],
    [
      "broker_capture_mismatch",
      (value) => (value.broker.capturedAt = "2026-07-23T12:01:00.000Z"),
    ],
    [
      "configuration_administration_unstable",
      (value) =>
        (value.configurationReads.administration[1].devHeadSha = "f".repeat(
          40,
        )),
    ],
    [
      "configuration_broker_detached",
      (value) => (value.broker.app.appId = 9999),
    ],
  ];
  for (const [failure, mutate] of cases) {
    const value = evidence();
    mutate(value);
    assert.ok(
      validateRepositoryControls(value, policy(), now).includes(failure),
    );
  }
});

test("closed evidence schema rejects secret-shaped and unknown fields", () => {
  const value = evidence();
  value.broker.credential.privateKey = "PRIVATE";
  const failures = validateRepositoryControls(value, policy(), now);
  assert.ok(failures.includes("evidence_secret_or_unbounded"));
  assert.doesNotMatch(failures.join(","), /PRIVATE/u);
  const embedded = evidence();
  embedded.probes.callerCapabilities[0].artifact =
    "ghp_abcdefghijklmnopqrstuvwxyz123456";
  assert.deepEqual(validateRepositoryControls(embedded, policy(), now), [
    "evidence_secret_or_unbounded",
  ]);
  const jwt = evidence();
  jwt.probes.callerCapabilities[0].artifact =
    "EYJhbGciOiJSUzI1NiJ9.EYJpc3MiOiIxMjM0NSJ9.ABCDEFGHIJKLMNOP";
  assert.deepEqual(validateRepositoryControls(jwt, policy(), now), [
    "evidence_secret_or_unbounded",
  ]);
});
