#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { evaluateMacosAccessibilityDriver } from "./macos-accessibility-driver-evaluation.mjs";
import {
  authenticateCurrentEvaluationCheckout,
  physicalEvaluationSourceDigest,
} from "./macos-accessibility-driver-source.mjs";
import { authenticateFoundationPackage } from "./macos-accessibility-foundation-attestation.mjs";

const evidenceUrl = new URL(
  "../docs/evaluation/macos-accessibility-driver-evidence.json",
  import.meta.url,
);
const foundationAcceptanceUrl = new URL(
  "../docs/evaluation/macos-accessibility-driver-foundation-acceptance.json",
  import.meta.url,
);
const foundationManifestUrl = new URL(
  "../docs/evaluation/macos-accessibility-driver-foundation-package-manifest.json",
  import.meta.url,
);
const packagePolicyUrl = new URL(
  "../native/package-policy.json",
  import.meta.url,
);
const retainedArtifactUrls = {
  allowed: new URL(
    "../docs/evaluation/macos-accessibility-driver-capture-allowed.json",
    import.meta.url,
  ),
  denied: new URL(
    "../docs/evaluation/macos-accessibility-driver-capture-denied.json",
    import.meta.url,
  ),
  prepared: new URL(
    "../docs/evaluation/macos-accessibility-driver-prepared.json",
    import.meta.url,
  ),
  recovered: new URL(
    "../docs/evaluation/macos-accessibility-driver-capture-recovered.json",
    import.meta.url,
  ),
  revoked: new URL(
    "../docs/evaluation/macos-accessibility-driver-capture-revoked.json",
    import.meta.url,
  ),
};
function closedInvalid(reasonCode) {
  return {
    exitCode: 2,
    output: {
      schemaVersion: "keiko-native-macos-accessibility-driver-evaluation/v1",
      status: "invalid",
      decision: "pending",
      reasonCode,
    },
  };
}

async function run() {
  const evidence = JSON.parse(await readFile(evidenceUrl, "utf8"));
  const currentSourceDigest = await physicalEvaluationSourceDigest();
  const checkout = authenticateCurrentEvaluationCheckout(
    evidence.bindings?.evaluationHead,
    {
      sourceDigestAuthenticated:
        currentSourceDigest === evidence.bindings?.evaluationSourceSha256,
    },
  );
  if (!checkout.authenticated) return closedInvalid(checkout.reasonCode);
  const [acceptanceEvidenceRaw, packageManifestRaw, packagePolicyRaw] =
    await Promise.all([
      readFile(foundationAcceptanceUrl, "utf8"),
      readFile(foundationManifestUrl, "utf8"),
      readFile(packagePolicyUrl, "utf8"),
    ]);
  const foundationPackageAttestation = authenticateFoundationPackage({
    acceptanceEvidenceRaw,
    bindings: {
      evaluationHead: evidence.bindings?.evaluationHead,
      foundationEvidenceSha256: evidence.bindings?.foundationEvidenceSha256,
      foundationPackageSha256: evidence.bindings?.foundationPackageSha256,
    },
    packageManifestRaw,
    packagePolicyRaw,
  });
  if (!foundationPackageAttestation.authenticated)
    return closedInvalid(foundationPackageAttestation.reasonCode);

  const retainedArtifacts = Object.fromEntries(
    await Promise.all(
      Object.entries(retainedArtifactUrls).map(async ([id, url]) => [
        id,
        await readFile(url, "utf8"),
      ]),
    ),
  );
  return evaluateMacosAccessibilityDriver({
    args: process.argv.slice(2),
    currentSourceDigest,
    evidence,
    foundationPackageAttestation,
    retainedArtifacts,
  });
}

let result;
try {
  result = await run();
} catch {
  result = closedInvalid("evaluation-evidence-unavailable");
}

process.stdout.write(`${JSON.stringify(result.output)}\n`);
process.exitCode = result.exitCode;
