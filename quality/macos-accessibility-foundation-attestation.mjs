import { createHash } from "node:crypto";

import { compareCodeUnits } from "./deterministic-order.mjs";

const sha256Pattern = /^[0-9a-f]{64}$/u;
const headPattern = /^[0-9a-f]{40}$/u;
const foundationReadinessFingerprint =
  "da2459bd3becc6cbf651a24ef1b64d1b11a8ed642bfddc92923f0d6ed6dc8e5e";
const expectedOutcomes = Object.freeze([
  "packaged-health-acknowledged",
  "normal-shutdown",
  "zero-owned-descendants",
  "package-policy",
]);
const expectedReasonCodes = Object.freeze([
  "invalid-request",
  "unauthorized",
  "cancelled",
  "timed-out",
  "host-unavailable",
  "shutting-down",
]);
const expectedPackagePaths = Object.freeze([
  "Contents/Info.plist",
  "Contents/MacOS/keiko-native-desktop",
  "Contents/Resources/THIRD-PARTY-NOTICES.json",
]);
const expectedPackageModes = Object.freeze({
  "Contents/Info.plist": "0644",
  "Contents/MacOS/keiko-native-desktop": "0755",
  "Contents/Resources/THIRD-PARTY-NOTICES.json": "0644",
});
const requiredProhibitedMarkers = Object.freeze([
  "remote-debugging",
  "test-listener",
  "evaluate:macos-accessibility-driver",
  "dev.oscharko.keiko-native.evaluation.accessibility",
  "KeikoAccessibilityEvaluation",
]);
const requiredProhibitedPathFragments = Object.freeze([
  "driver",
  "experiment",
  "fixture",
  "listener",
]);
const authenticatedPackages = new WeakSet();

function sha256(raw) {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).toSorted(compareCodeUnits).join("\0") ===
      expected.toSorted(compareCodeUnits).join("\0")
  );
}

function exactValues(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function closedInvalid(reasonCode) {
  return Object.freeze({
    authenticated: false,
    reasonCode,
  });
}

function parseClosedJson(raw, maximumBytes) {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    Buffer.byteLength(raw, "utf8") > maximumBytes
  )
    return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function acceptanceEvidenceValid(evidence) {
  return (
    exactKeys(evidence, [
      "acknowledgementMs",
      "architecture",
      "boundedReasonCodes",
      "cargoLockSha256",
      "cleanupOwnedDescendants",
      "npmLockSha256",
      "outcomes",
      "packageManifestSha256",
      "readinessFingerprint",
      "redaction",
      "runner",
      "schema",
      "shutdownMs",
      "sourceRevision",
    ]) &&
    evidence.schema === "keiko-native-packaged-shell-evidence/v1" &&
    headPattern.test(evidence.sourceRevision) &&
    evidence.readinessFingerprint === foundationReadinessFingerprint &&
    sha256Pattern.test(evidence.packageManifestSha256) &&
    sha256Pattern.test(evidence.cargoLockSha256) &&
    sha256Pattern.test(evidence.npmLockSha256) &&
    evidence.architecture === "arm64" &&
    typeof evidence.runner === "string" &&
    /^[a-z0-9._-]{1,80}$/iu.test(evidence.runner) &&
    exactValues(evidence.outcomes, expectedOutcomes) &&
    exactValues(evidence.boundedReasonCodes, expectedReasonCodes) &&
    Number.isInteger(evidence.acknowledgementMs) &&
    evidence.acknowledgementMs >= 0 &&
    evidence.acknowledgementMs <= 30_000 &&
    Number.isInteger(evidence.shutdownMs) &&
    evidence.shutdownMs >= 0 &&
    evidence.shutdownMs <= 5_000 &&
    evidence.cleanupOwnedDescendants === 0 &&
    evidence.redaction === "closed"
  );
}

function packageManifestValid(manifest) {
  return (
    exactKeys(manifest, [
      "inventory",
      "platform",
      "policySha256",
      "redaction",
      "schema",
      "sourceRevision",
      "target",
    ]) &&
    manifest.schema === "keiko-native-package-manifest/v1" &&
    headPattern.test(manifest.sourceRevision) &&
    manifest.target === "keiko-native-desktop" &&
    manifest.platform === "macos-arm64" &&
    sha256Pattern.test(manifest.policySha256) &&
    manifest.redaction === "closed" &&
    Array.isArray(manifest.inventory) &&
    manifest.inventory.length === expectedPackagePaths.length &&
    manifest.inventory.every(
      (entry, index) =>
        exactKeys(entry, ["mode", "path", "sha256"]) &&
        entry.path === expectedPackagePaths[index] &&
        entry.mode === expectedPackageModes[entry.path] &&
        sha256Pattern.test(entry.sha256),
    )
  );
}

export function foundationPackagePolicyIsolated(policy) {
  return (
    Array.isArray(policy?.security?.prohibitedMarkers) &&
    requiredProhibitedMarkers.every((marker) =>
      policy.security.prohibitedMarkers.includes(marker),
    ) &&
    Array.isArray(policy?.security?.prohibitedPathFragments) &&
    requiredProhibitedPathFragments.every((fragment) =>
      policy.security.prohibitedPathFragments.includes(fragment),
    )
  );
}

function packagePolicyValid(policy, manifest, evidence) {
  return (
    policy?.schema === "keiko-native-package-policy/v1" &&
    policy.target === manifest.target &&
    exactValues(policy.allowedBundlePaths, expectedPackagePaths) &&
    exactKeys(policy.allowedFileModes, expectedPackagePaths) &&
    expectedPackagePaths.every(
      (path) => policy.allowedFileModes[path] === expectedPackageModes[path],
    ) &&
    exactKeys(policy.expectedLocks, ["cargoSha256", "npmSha256"]) &&
    policy.expectedLocks.cargoSha256 === evidence.cargoLockSha256 &&
    policy.expectedLocks.npmSha256 === evidence.npmLockSha256 &&
    foundationPackagePolicyIsolated(policy)
  );
}

export function authenticateFoundationPackage({
  acceptanceEvidenceRaw,
  bindings,
  packageManifestRaw,
  packagePolicyRaw,
}) {
  if (
    !exactKeys(bindings, [
      "evaluationHead",
      "foundationEvidenceSha256",
      "foundationPackageSha256",
    ]) ||
    !headPattern.test(bindings.evaluationHead) ||
    !sha256Pattern.test(bindings.foundationEvidenceSha256) ||
    !sha256Pattern.test(bindings.foundationPackageSha256)
  )
    return closedInvalid("foundation-package-bindings-invalid");
  if (
    typeof acceptanceEvidenceRaw !== "string" ||
    typeof packageManifestRaw !== "string" ||
    typeof packagePolicyRaw !== "string"
  )
    return closedInvalid("foundation-package-evidence-unavailable");
  if (
    sha256(acceptanceEvidenceRaw) !== bindings.foundationEvidenceSha256 ||
    sha256(packageManifestRaw) !== bindings.foundationPackageSha256
  )
    return closedInvalid("foundation-package-digest-mismatch");

  const evidence = parseClosedJson(acceptanceEvidenceRaw, 10_000);
  const manifest = parseClosedJson(packageManifestRaw, 100_000);
  const policy = parseClosedJson(packagePolicyRaw, 2_000_000);
  if (
    !acceptanceEvidenceValid(evidence) ||
    !packageManifestValid(manifest) ||
    policy === null
  )
    return closedInvalid("foundation-package-schema-invalid");
  if (
    evidence.sourceRevision !== bindings.evaluationHead ||
    manifest.sourceRevision !== bindings.evaluationHead ||
    evidence.packageManifestSha256 !== bindings.foundationPackageSha256
  )
    return closedInvalid("foundation-package-identity-mismatch");
  if (
    sha256(packagePolicyRaw) !== manifest.policySha256 ||
    !packagePolicyValid(policy, manifest, evidence)
  )
    return closedInvalid("foundation-package-policy-invalid");

  const authenticated = Object.freeze({
    authenticated: true,
    packageManifestSha256: bindings.foundationPackageSha256,
    packagePolicySha256: manifest.policySha256,
    reasonCode: null,
    sourceRevision: bindings.evaluationHead,
  });
  authenticatedPackages.add(authenticated);
  return authenticated;
}

export function isAuthenticatedFoundationPackage(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    authenticatedPackages.has(value)
  );
}
