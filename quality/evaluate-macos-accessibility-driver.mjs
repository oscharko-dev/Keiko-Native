#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";

import { evaluateMacosAccessibilityDriver } from "./macos-accessibility-driver-evaluation.mjs";
import {
  capturePhysicalMatrixPhase,
  evaluationArtifactRoot,
  preparePhysicalMatrix,
  runPhysicalCandidate,
} from "./macos-accessibility-driver-harness.mjs";
import { physicalEvaluationSourceDigest } from "./macos-accessibility-driver-source.mjs";

const evidenceUrl = new URL(
  "../docs/evaluation/macos-accessibility-driver-evidence.json",
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
const operation = process.env.KEIKO_MACOS_ACCESSIBILITY_OPERATION ?? "evaluate";

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

function exactHead() {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "rev-parse",
      "HEAD",
    ],
    { encoding: "utf8", shell: false },
  );
  const head = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/u.test(head))
    throw new Error("evaluation-head-unavailable");
  return head;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function runOperatorOperation() {
  if (process.argv.slice(2).length !== 0)
    return closedInvalid("invalid-command");
  if (operation === "prepare") {
    await rm(evaluationArtifactRoot, { force: true, recursive: true });
    await mkdir(evaluationArtifactRoot, { recursive: true });
    const prepared = await preparePhysicalMatrix(evaluationArtifactRoot, {
      sourceDigest: await physicalEvaluationSourceDigest(),
      sourceHead: exactHead(),
    });
    return { exitCode: 0, output: prepared };
  }
  if (["allowed", "denied", "revoked", "recovered"].includes(operation)) {
    const prepared = await readJson(
      `${evaluationArtifactRoot}/prepared-evidence.json`,
    );
    const priorPhase = {
      allowed: null,
      denied: "allowed",
      revoked: "allowed",
      recovered: "revoked",
    }[operation];
    const priorCapture =
      priorPhase === null
        ? null
        : await readJson(
            `${evaluationArtifactRoot}/capture-${priorPhase}.json`,
          );
    const capture = await capturePhysicalMatrixPhase(evaluationArtifactRoot, {
      phase: operation,
      prepared,
      priorCapture,
      runCandidate: runPhysicalCandidate,
    });
    const failed = Object.values(capture.options).some(
      ({ unexplainedFailures }) => unexplainedFailures !== 0,
    );
    return { exitCode: failed ? 3 : 0, output: capture };
  }
  if (operation !== "evaluate") return closedInvalid("invalid-operation");
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
    currentSourceDigest: await physicalEvaluationSourceDigest(),
    evidence: await readJson(evidenceUrl),
    retainedArtifacts,
  });
}

let result;
try {
  result = await runOperatorOperation();
} catch {
  result = closedInvalid("evaluation-evidence-unavailable");
}

process.stdout.write(`${JSON.stringify(result.output)}\n`);
process.exitCode = result.exitCode;
