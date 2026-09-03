import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  authenticateFoundationPackage,
  foundationPackagePolicyIsolated,
  isAuthenticatedFoundationPackage,
} from "./macos-accessibility-foundation-attestation.mjs";

const acceptanceEvidenceRaw = await readFile(
  new URL(
    "./fixtures/macos-accessibility-foundation-acceptance.json",
    import.meta.url,
  ),
  "utf8",
);
const packageManifestRaw = await readFile(
  new URL(
    "./fixtures/macos-accessibility-foundation-package-manifest.json",
    import.meta.url,
  ),
  "utf8",
);
const packagePolicyRaw = await readFile(
  new URL("../native/package-policy.json", import.meta.url),
  "utf8",
);

function sha256(raw) {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function input() {
  return {
    acceptanceEvidenceRaw,
    bindings: {
      evaluationHead: "8d5894350abd2a2e8453449420661608407d0128",
      foundationEvidenceSha256: sha256(acceptanceEvidenceRaw),
      foundationPackageSha256: sha256(packageManifestRaw),
    },
    packageManifestRaw,
    packagePolicyRaw,
  };
}

function changedJson(raw, mutate) {
  const parsed = JSON.parse(raw);
  mutate(parsed);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

test("authenticates the retained closed Foundation package evidence", () => {
  const authenticated = authenticateFoundationPackage(input());
  assert.deepEqual(authenticated, {
    authenticated: true,
    packageManifestSha256:
      "0e672112e252b2e72ee63233b18f3e86af389eff6f6f4518fbc5286323926795",
    packagePolicySha256:
      "0dce0d48b1d133257e79d8df1e8551baf60dc75cb99c12a535b4fdbd2df9cba6",
    reasonCode: null,
    sourceRevision: "8d5894350abd2a2e8453449420661608407d0128",
  });
  assert.equal(isAuthenticatedFoundationPackage(authenticated), true);
  assert.equal(
    isAuthenticatedFoundationPackage({
      ...authenticated,
      authenticated: true,
    }),
    false,
  );
});

test("fails closed when retained bytes do not match their bindings", () => {
  for (const mutation of [
    { acceptanceEvidenceRaw: `${acceptanceEvidenceRaw} ` },
    { packageManifestRaw: `${packageManifestRaw} ` },
  ]) {
    const result = authenticateFoundationPackage({ ...input(), ...mutation });
    assert.equal(result.authenticated, false);
    assert.equal(result.reasonCode, "foundation-package-digest-mismatch");
  }
});

test("fails closed when a retained input is unavailable", () => {
  for (const field of [
    "acceptanceEvidenceRaw",
    "packageManifestRaw",
    "packagePolicyRaw",
  ]) {
    const testInput = input();
    testInput[field] = undefined;
    assert.deepEqual(authenticateFoundationPackage(testInput), {
      authenticated: false,
      reasonCode: "foundation-package-evidence-unavailable",
    });
  }
});

test("fails closed when mutually bound package identity changes", () => {
  const changedAcceptance = changedJson(acceptanceEvidenceRaw, (evidence) => {
    evidence.packageManifestSha256 = "f".repeat(64);
  });
  const changedSource = changedJson(packageManifestRaw, (manifest) => {
    manifest.sourceRevision = "f".repeat(40);
  });
  for (const mutation of [
    {
      acceptanceEvidenceRaw: changedAcceptance,
      bindings: {
        ...input().bindings,
        foundationEvidenceSha256: sha256(changedAcceptance),
      },
    },
    {
      packageManifestRaw: changedSource,
      bindings: {
        ...input().bindings,
        foundationPackageSha256: sha256(changedSource),
      },
    },
  ]) {
    const result = authenticateFoundationPackage({ ...input(), ...mutation });
    assert.equal(result.authenticated, false);
    assert.equal(result.reasonCode, "foundation-package-identity-mismatch");
  }
});

test("fails closed on missing package policy, redaction, or cleanup outcomes", () => {
  const mutations = [
    (evidence) => {
      evidence.outcomes = evidence.outcomes.filter(
        (outcome) => outcome !== "package-policy",
      );
    },
    (evidence) => {
      evidence.redaction = "open";
    },
    (evidence) => {
      evidence.cleanupOwnedDescendants = 1;
    },
    (evidence) => {
      evidence.readinessFingerprint = "f".repeat(64);
    },
    (evidence) => {
      evidence.foundationReadinessFingerprint = "f".repeat(64);
    },
    (evidence) => {
      evidence.workspaceAcknowledgementMs = evidence.acknowledgementMs + 1;
    },
  ];
  for (const mutate of mutations) {
    const changed = changedJson(acceptanceEvidenceRaw, mutate);
    const testInput = input();
    testInput.acceptanceEvidenceRaw = changed;
    testInput.bindings.foundationEvidenceSha256 = sha256(changed);
    const result = authenticateFoundationPackage(testInput);
    assert.equal(result.authenticated, false);
    assert.equal(result.reasonCode, "foundation-package-schema-invalid");
  }
});

test("fails closed when the current package policy no longer authenticates the manifest", () => {
  const changed = changedJson(packagePolicyRaw, (policy) => {
    policy.security.prohibitedPathFragments =
      policy.security.prohibitedPathFragments.filter(
        (fragment) => fragment !== "driver",
      );
  });
  const result = authenticateFoundationPackage({
    ...input(),
    packagePolicyRaw: changed,
  });
  assert.equal(result.authenticated, false);
  assert.equal(result.reasonCode, "foundation-package-policy-invalid");
});

test("requires distinctive accessibility evaluation markers in package policy", () => {
  const policy = JSON.parse(packagePolicyRaw);
  assert.equal(foundationPackagePolicyIsolated(policy), true);
  for (const marker of [
    "evaluate:macos-accessibility-driver",
    "dev.oscharko.keiko-native.evaluation.accessibility",
    "KeikoAccessibilityEvaluation",
  ]) {
    const changed = structuredClone(policy);
    changed.security.prohibitedMarkers =
      changed.security.prohibitedMarkers.filter(
        (candidate) => candidate !== marker,
      );
    assert.equal(foundationPackagePolicyIsolated(changed), false);
  }
});
