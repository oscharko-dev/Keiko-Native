import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { compareCodeUnits } from "./deterministic-order.mjs";

export const physicalEvaluationSourceNames = Object.freeze([
  "evaluate-macos-accessibility-driver.mjs",
  "macos-accessibility-driver-evaluation.mjs",
  "macos-accessibility-driver-harness.mjs",
  "macos-accessibility-driver-source.mjs",
  "macos-accessibility-foundation-attestation.mjs",
  "run-macos-accessibility-driver-evaluation.mjs",
]);

const headPattern = /^[0-9a-f]{40}$/u;
export const evaluationRepositoryRoot = fileURLToPath(
  new URL("../", import.meta.url),
);
export const postEvaluationPathPolicy = Object.freeze({
  schemaVersion: 1,
  paths: Object.freeze([
    "docs/adr/ADR-0013-bounded-macos-accessibility-journey-driver.md",
    "docs/adr/README.md",
    "docs/evaluation/macos-accessibility-driver-capture-allowed.json",
    "docs/evaluation/macos-accessibility-driver-capture-denied.json",
    "docs/evaluation/macos-accessibility-driver-capture-recovered.json",
    "docs/evaluation/macos-accessibility-driver-capture-revoked.json",
    "docs/evaluation/macos-accessibility-driver-evidence.json",
    "docs/evaluation/macos-accessibility-driver-foundation-acceptance.json",
    "docs/evaluation/macos-accessibility-driver-foundation-package-manifest.json",
    "docs/evaluation/macos-accessibility-driver-prepared.json",
  ]),
});
export const evaluationRuntimeInputPaths = Object.freeze([
  ...physicalEvaluationSourceNames.map((name) => `quality/${name}`),
  "docs/evaluation/macos-accessibility-driver-capture-allowed.json",
  "docs/evaluation/macos-accessibility-driver-capture-denied.json",
  "docs/evaluation/macos-accessibility-driver-capture-recovered.json",
  "docs/evaluation/macos-accessibility-driver-capture-revoked.json",
  "docs/evaluation/macos-accessibility-driver-evidence.json",
  "docs/evaluation/macos-accessibility-driver-foundation-acceptance.json",
  "docs/evaluation/macos-accessibility-driver-foundation-package-manifest.json",
  "docs/evaluation/macos-accessibility-driver-prepared.json",
  "native/package-policy.json",
]);

function checkoutInvalid(reasonCode) {
  return Object.freeze({ authenticated: false, reasonCode });
}

function gitCommandFailed(result) {
  return (
    result.exitCode !== 0 ||
    result.signal !== null ||
    !result.stderrEmpty ||
    result.timedOut
  );
}

export function authenticateEvaluationCheckout({
  ancestor,
  changes,
  currentHead,
  evaluationHead,
  workingTreeClean,
}) {
  if (
    !headPattern.test(evaluationHead ?? "") ||
    !headPattern.test(currentHead ?? "") ||
    typeof ancestor !== "boolean" ||
    !Array.isArray(changes) ||
    typeof workingTreeClean !== "boolean"
  )
    return checkoutInvalid("evaluation-checkout-input-invalid");
  if (!workingTreeClean)
    return checkoutInvalid("evaluation-working-tree-dirty");
  if (!ancestor) return checkoutInvalid("evaluation-head-not-ancestor");
  if (currentHead === evaluationHead)
    return changes.length === 0
      ? Object.freeze({ authenticated: true, reasonCode: null })
      : checkoutInvalid("evaluation-checkout-diff-invalid");
  const allowed = new Set(postEvaluationPathPolicy.paths);
  for (const change of changes) {
    if (
      change === null ||
      typeof change !== "object" ||
      !allowed.has(change.path) ||
      change.blobType !== "blob" ||
      !new Set(["A", "M"]).has(change.status) ||
      change.newMode !== "100644" ||
      (change.status === "A" && change.oldMode !== "000000") ||
      (change.status === "M" && change.oldMode !== "100644")
    )
      return checkoutInvalid("evaluation-checkout-diff-invalid");
  }
  return Object.freeze({ authenticated: true, reasonCode: null });
}

export function gitReadEnvironment(inherited = process.env) {
  return {
    ...Object.fromEntries(
      Object.entries(inherited).filter(([name]) => !name.startsWith("GIT_")),
    ),
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function runGit(args, repositoryRoot) {
  const result = spawnSync(
    "/usr/bin/git",
    [
      "--no-replace-objects",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-C",
      repositoryRoot,
      ...args,
    ],
    {
      encoding: "buffer",
      env: gitReadEnvironment(),
      shell: false,
      timeout: 5_000,
    },
  );
  return {
    exitCode: result.status,
    signal: result.signal,
    stderrEmpty: result.stderr?.length === 0,
    stdout: result.stdout ?? Buffer.alloc(0),
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}

export function authenticateRuntimeInputState({
  indexFlags,
  inputs,
  requiredPaths = inputs?.map(({ path }) => path),
}) {
  if (
    !Array.isArray(indexFlags) ||
    !Array.isArray(inputs) ||
    !Array.isArray(requiredPaths) ||
    indexFlags.some((entry) => !/^H [^\0]+$/u.test(entry)) ||
    inputs.length !== requiredPaths.length
  )
    return checkoutInvalid("evaluation-runtime-input-invalid");
  const expectedPaths = [...requiredPaths].toSorted(compareCodeUnits);
  if (
    inputs
      .map(({ path }) => path)
      .toSorted(compareCodeUnits)
      .some((path, index) => path !== expectedPaths[index])
  )
    return checkoutInvalid("evaluation-runtime-input-invalid");
  for (const input of inputs) {
    if (
      input.headMode !== "100644" ||
      !headPattern.test(input.headObject) ||
      input.indexMode !== input.headMode ||
      input.indexObject !== input.headObject ||
      input.indexStage !== "0" ||
      input.worktreeType !== "file" ||
      input.worktreeMode !== input.headMode ||
      input.worktreeObject !== input.headObject
    )
      return checkoutInvalid("evaluation-runtime-input-invalid");
  }
  return Object.freeze({ authenticated: true, reasonCode: null });
}

export function inspectCurrentRuntimeInputs(
  run,
  repositoryRoot,
  inspectPath = lstatSync,
) {
  if (
    typeof run !== "function" ||
    repositoryRoot !== evaluationRepositoryRoot ||
    typeof inspectPath !== "function"
  )
    return checkoutInvalid("evaluation-checkout-input-invalid");
  const flags = run(["ls-files", "-v", "-z"], repositoryRoot);
  if (
    flags.exitCode !== 0 ||
    flags.signal !== null ||
    !flags.stderrEmpty ||
    flags.timedOut
  )
    return checkoutInvalid("evaluation-checkout-unavailable");
  const indexFlags = flags.stdout.toString("utf8").split("\0").filter(Boolean);
  const inputs = [];
  for (const path of evaluationRuntimeInputPaths) {
    const head = run(
      ["ls-tree", "-z", "--full-tree", "HEAD", "--", path],
      repositoryRoot,
    );
    const index = run(["ls-files", "-s", "-z", "--", path], repositoryRoot);
    const worktree = run(
      ["hash-object", "--no-filters", "--", path],
      repositoryRoot,
    );
    if (
      [head, index, worktree].some(
        (result) =>
          result.exitCode !== 0 ||
          result.signal !== null ||
          !result.stderrEmpty ||
          result.timedOut,
      )
    )
      return checkoutInvalid("evaluation-checkout-unavailable");
    const headMatch = head.stdout
      .toString("utf8")
      .match(/^(\d{6}) blob ([0-9a-f]{40})\t([^\0]+)\0$/u);
    const indexMatch = index.stdout
      .toString("utf8")
      .match(/^(\d{6}) ([0-9a-f]{40}) ([0-3])\t([^\0]+)\0$/u);
    const worktreeObject = worktree.stdout.toString("utf8").trim();
    let worktreeStat;
    try {
      worktreeStat = inspectPath(join(repositoryRoot, path));
    } catch {
      return checkoutInvalid("evaluation-runtime-input-invalid");
    }
    if (
      headMatch === null ||
      indexMatch === null ||
      headMatch[3] !== path ||
      indexMatch[4] !== path ||
      !headPattern.test(worktreeObject)
    )
      return checkoutInvalid("evaluation-runtime-input-invalid");
    inputs.push({
      headMode: headMatch[1],
      headObject: headMatch[2],
      indexMode: indexMatch[1],
      indexObject: indexMatch[2],
      indexStage: indexMatch[3],
      path,
      worktreeMode: (worktreeStat.mode & 0o111) === 0 ? "100644" : "100755",
      worktreeObject,
      worktreeType: worktreeStat.isFile() ? "file" : "special",
    });
  }
  return authenticateRuntimeInputState({
    indexFlags,
    inputs,
    requiredPaths: evaluationRuntimeInputPaths,
  });
}

export function authenticateCurrentEvaluationCheckout(
  evaluationHead,
  {
    inspectInputs = inspectCurrentRuntimeInputs,
    repositoryRoot = evaluationRepositoryRoot,
    run = runGit,
  } = {},
) {
  if (!headPattern.test(evaluationHead ?? ""))
    return checkoutInvalid("evaluation-checkout-input-invalid");
  if (
    repositoryRoot !== evaluationRepositoryRoot ||
    typeof run !== "function" ||
    typeof inspectInputs !== "function"
  )
    return checkoutInvalid("evaluation-checkout-input-invalid");
  const runtimeInputs = inspectInputs(run, repositoryRoot);
  if (!runtimeInputs.authenticated) return runtimeInputs;
  const status = run(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    repositoryRoot,
  );
  if (gitCommandFailed(status))
    return checkoutInvalid("evaluation-checkout-unavailable");
  if (status.stdout.length !== 0)
    return checkoutInvalid("evaluation-working-tree-dirty");
  const head = run(["rev-parse", "--verify", "HEAD"], repositoryRoot);
  if (gitCommandFailed(head))
    return checkoutInvalid("evaluation-checkout-unavailable");
  const currentHead = head.stdout.toString("utf8").trim();
  if (!headPattern.test(currentHead))
    return checkoutInvalid("evaluation-checkout-unavailable");
  const ancestor = run(
    ["merge-base", "--is-ancestor", evaluationHead, currentHead],
    repositoryRoot,
  );
  if (ancestor.exitCode !== 0)
    return checkoutInvalid(
      ancestor.exitCode === 1
        ? "evaluation-head-not-ancestor"
        : "evaluation-checkout-unavailable",
    );
  const diff = run(
    [
      "diff",
      "--raw",
      "-z",
      "--full-index",
      "--abbrev=40",
      "--no-ext-diff",
      "--no-renames",
      evaluationHead,
      currentHead,
    ],
    repositoryRoot,
  );
  if (gitCommandFailed(diff))
    return checkoutInvalid("evaluation-checkout-unavailable");
  const fields = diff.stdout.toString("utf8").split("\0");
  if (fields.at(-1) !== "")
    return checkoutInvalid("evaluation-checkout-diff-invalid");
  fields.pop();
  if (fields.length % 2 !== 0)
    return checkoutInvalid("evaluation-checkout-diff-invalid");
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index].match(
      /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/u,
    );
    const path = fields[index + 1];
    if (header === null || path.length === 0)
      return checkoutInvalid("evaluation-checkout-diff-invalid");
    const object = run(["cat-file", "-t", header[4]], repositoryRoot);
    if (gitCommandFailed(object))
      return checkoutInvalid("evaluation-checkout-diff-invalid");
    changes.push({
      blobType: object.stdout.toString("utf8").trim(),
      newMode: header[2],
      oldMode: header[1],
      path,
      status: header[5],
    });
  }
  return authenticateEvaluationCheckout({
    ancestor: true,
    changes,
    currentHead,
    evaluationHead,
    workingTreeClean: true,
  });
}

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
