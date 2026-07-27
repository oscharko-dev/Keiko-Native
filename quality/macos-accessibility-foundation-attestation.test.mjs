import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  authenticateFoundationPackage,
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
      evaluationHead: "8f09eed3b0726207bc27132556c3174bba1abe60",
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
      "19a8fc126777f219717dc68832e94db72f53afb1957268ee77399d64ed28bc88",
    packagePolicySha256:
      "58ecd89c8b869b20a80bb87efc8dc15ef5d5aa916889b6a2b65dd63a8cce2307",
    reasonCode: null,
    sourceRevision: "8f09eed3b0726207bc27132556c3174bba1abe60",
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
