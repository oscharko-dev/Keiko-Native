import { createHash } from "node:crypto";
import { join } from "node:path";

import { parseReleaseJson, readBoundRegularFile } from "./release-io.mjs";

const inputPaths = Object.freeze({
  cargoLockSha256: "native/Cargo.lock",
  frontendLockSha256: "native/frontend/package-lock.json",
  policySha256: "native/package-policy.json",
  rootLockSha256: "package-lock.json",
});

export async function loadReleaseInputs(repositoryRoot, filesystem) {
  return loadInputs(async (path) =>
    filesystem
      ? filesystem.read(repositoryRoot, path)
      : (
          await readBoundRegularFile(
            join(repositoryRoot, path),
            4 * 1024 * 1024,
          )
        ).bytes,
  );
}

export async function loadReleaseInputsFromRevision(revision, readRevision) {
  if (!/^[0-9a-f]{40}$/u.test(revision) || typeof readRevision !== "function")
    throw new Error("release-inputs-rejected");
  return loadInputs((path) => readRevision(revision, path));
}

async function loadInputs(readInput) {
  const records = Object.fromEntries(
    await Promise.all(
      Object.entries(inputPaths).map(async ([name, path]) => {
        const bytes = await readInput(path);
        if (!(bytes instanceof Uint8Array) || bytes.length > 4 * 1024 * 1024)
          throw new Error("release-inputs-rejected");
        return [name, { bytes, sha256: digest(bytes) }];
      }),
    ),
  );
  const policy = parseReleaseJson(records.policySha256.bytes);
  if (
    policy?.schema !== "keiko-native-package-policy/v1" ||
    policy?.expectedLocks?.cargoSha256 !== records.cargoLockSha256.sha256 ||
    policy?.expectedLocks?.npmSha256 !== records.frontendLockSha256.sha256
  )
    throw new Error("release-inputs-rejected");
  return {
    evidence: Object.fromEntries(
      Object.keys(inputPaths).map((name) => [name, records[name].sha256]),
    ),
    policy,
  };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
