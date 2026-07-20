import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { compareCodeUnits } from "./deterministic-order.mjs";
import { isDirectInvocation, sanitizeDiagnostic } from "./native-process.mjs";
import { parseReleaseJson, readBoundRegularFile } from "./release-io.mjs";

const predicateType = "https://oscharko.dev/keiko-native/internal-release/v1";
const bundleFiles = [
  "SHA256SUMS",
  "Keiko-Native-0.1.0-internal-arm64.dmg",
  "package-manifest.json",
  "release-manifest.json",
  "release-verification.json",
  "sbom.spdx.json",
];

export function customAttestationFailures(
  results,
  expectedRevision,
  expectedSubjects,
) {
  if (!Array.isArray(results) || results.length === 0)
    return ["release-attestation-result"];
  if (!/^[0-9a-f]{40}$/u.test(expectedRevision ?? ""))
    return ["release-attestation-revision"];
  const matching = results.filter(({ verificationResult }) => {
    const statement = verificationResult?.statement;
    return (
      statement?.predicateType === predicateType &&
      statement?.predicate?.schema === "keiko-native-internal-release/v1" &&
      statement?.predicate?.sourceRevision === expectedRevision &&
      sameSubjects(statement?.subject, expectedSubjects)
    );
  });
  return matching.length > 0 ? [] : ["release-attestation-head-binding"];
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 3) throw new Error("release-attestation-arguments");
  const results = parseReleaseJson(await readFile(args[0]));
  const failures = customAttestationFailures(
    results,
    args[1],
    await bundleSubjects(args[2]),
  );
  if (failures.length > 0) throw new Error(failures.join(","));
}

export const releasePredicateType = predicateType;

async function bundleSubjects(directory) {
  const names = (await readdir(directory)).toSorted(compareCodeUnits);
  if (
    JSON.stringify(names) !==
    JSON.stringify([...bundleFiles].toSorted(compareCodeUnits))
  )
    throw new Error("release-attestation-bundle-files");
  return Promise.all(
    names.map(async (name) => {
      const bytes = (
        await readBoundRegularFile(join(directory, name), 1024 * 1024 * 1024)
      ).bytes;
      return {
        name: `${directory.replace(/\/$/u, "")}/${name}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
}

function sameSubjects(subjects, expected) {
  if (!Array.isArray(subjects) || !Array.isArray(expected)) return false;
  const normalized = subjects.map((subject) => {
    if (
      Object.keys(subject ?? {})
        .toSorted(compareCodeUnits)
        .join(",") !== "digest,name" ||
      Object.keys(subject?.digest ?? {}).join(",") !== "sha256"
    )
      return undefined;
    return { name: subject.name, sha256: subject.digest.sha256 };
  });
  return (
    !normalized.includes(undefined) &&
    JSON.stringify(normalized.toSorted(byName)) ===
      JSON.stringify([...expected].toSorted(byName))
  );
}

function byName(left, right) {
  return left.name.localeCompare(right.name);
}

if (isDirectInvocation(process.argv[1], fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(sanitizeDiagnostic(error?.message ?? String(error)));
    process.exitCode = 1;
  });
}
