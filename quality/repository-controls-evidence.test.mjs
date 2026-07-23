import assert from "node:assert/strict";
import test from "node:test";

import { BROKER_APP_PERMISSIONS } from "./epic-merge-broker-capability.mjs";
import { acceptedEpicMergeEffectFromReceipt } from "./epic-merge-broker-receipt.mjs";
import { sanitizedRepositoryControlEvidence } from "./repository-controls-evidence.mjs";
import {
  cleanRawProviderEvidence,
  rawProviderEvidence,
  repositoryControlMetadata,
} from "./repository-controls-probe.test-fixtures.mjs";
import {
  repositoryControlsEvidence,
  repositoryControlsPolicy,
} from "./repository-controls.test-fixtures.mjs";

test("rejects secret-shaped provider data before projection", () => {
  assert.throws(() =>
    sanitizedRepositoryControlEvidence(
      rawProviderEvidence(),
      repositoryControlMetadata(),
    ),
  );
});

test("projects provider data into a closed credential-free evidence shape", () => {
  const result = sanitizedRepositoryControlEvidence(
    cleanRawProviderEvidence(),
    repositoryControlMetadata(),
  );
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /PRIVATE|TOKEN|private_key|email/u);
  assert.deepEqual(result.broker.app.permissions, BROKER_APP_PERMISSIONS);
  assert.equal(result.epicProtection.rulesetId, 9191);
  assert.deepEqual(result.epicProtection.bypassActors, []);
  assert.deepEqual(result.epicProtection.requiredChecks, [
    { appId: 15368, context: "PR contract" },
  ]);
  assert.equal(result.epicProtection.strictChecks, true);
  assert.deepEqual(result.epicProtection.exclude, []);
  assert.equal(result.epicProtection.branchDeletionAllowed, false);
  assert.equal(result.epicProtection.forcePushAllowed, false);
  assert.deepEqual(result.epicProtection.updateAllowlist.apps, [
    { appId: 4242, appSlug: "keiko-epic-merge-broker" },
  ]);
  assert.equal(result.mergeQueue.maxEntriesToMerge, 1);
});

test("consumes only a signed broker receipt and rejects raw broker input", () => {
  const policy = repositoryControlsPolicy();
  const durable = repositoryControlsEvidence(policy);
  const metadata = repositoryControlMetadata();
  metadata.probes.broker = durable.probes.broker;
  const result = sanitizedRepositoryControlEvidence(
    cleanRawProviderEvidence(),
    metadata,
  );
  const serialized = JSON.stringify(result.probes.broker);
  assert.equal(
    acceptedEpicMergeEffectFromReceipt(
      result.probes.broker.receipt,
      policy.identities.broker.receiptVerificationKey,
      policy.identities.broker.receiptVerificationKeyFingerprint,
    )?.requestId,
    durable.probes.broker.receipt.payload.requestId,
  );
  for (const rawProviderText of [
    "brokerDecisionInput",
    "<!-- keiko-native-readiness -->",
    "handoff-result",
    "comments",
    "body",
  ])
    assert.doesNotMatch(serialized, new RegExp(rawProviderText, "u"));
  for (const forbidden of [
    { brokerDecisionInput: {} },
    { signingCapability: {} },
    { privateKey: "PRIVATE" },
  ]) {
    metadata.probes.broker = { ...durable.probes.broker, ...forbidden };
    assert.throws(() =>
      sanitizedRepositoryControlEvidence(cleanRawProviderEvidence(), metadata),
    );
  }
});
