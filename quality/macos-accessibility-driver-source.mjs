import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const physicalEvaluationSourceNames = Object.freeze([
  "evaluate-macos-accessibility-driver.mjs",
  "macos-accessibility-driver-evaluation.mjs",
  "macos-accessibility-driver-harness.mjs",
  "macos-accessibility-driver-source.mjs",
  "macos-accessibility-foundation-attestation.mjs",
  "run-macos-accessibility-driver-evaluation.mjs",
]);

export function digestFramedSources(entries) {
  const digest = createHash("sha256");
  for (const { bytes, name } of entries) {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      !Buffer.isBuffer(bytes)
    )
      throw new TypeError("evaluation-source-entry-invalid");
    const nameBytes = Buffer.from(name, "utf8");
    digest.update(Buffer.from(`${nameBytes.length}:`, "ascii"));
    digest.update(nameBytes);
    digest.update(Buffer.from(`:${bytes.length}:`, "ascii"));
    digest.update(bytes);
  }
  return digest.digest("hex");
}

export async function physicalEvaluationSourceDigest() {
  return digestFramedSources(
    await Promise.all(
      physicalEvaluationSourceNames.map(async (name) => ({
        bytes: await readFile(new URL(`./${name}`, import.meta.url)),
        name,
      })),
    ),
  );
}
