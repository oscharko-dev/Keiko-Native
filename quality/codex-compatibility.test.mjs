import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluateCompatibility,
  PROMPT_BYTES,
  PROMPT_SHA256,
} from "./codex-compatibility.mjs";

const exactCandidate = "@openai/codex@0.145.0";
const exactPrompt = Buffer.from(
  "In two short sentences, explain why a cancellable operation must reach exactly one terminal state. Do not use tools, inspect files, access a repository, or perform any local action.\n",
  "utf8",
);
const evidenceText = readFileSync(
  new URL("../docs/evaluation/codex-0.145.0-rejection.json", import.meta.url),
  "utf8",
);
const reportText = readFileSync(
  new URL("../docs/evaluation/codex-0.145.0-rejection.md", import.meta.url),
  "utf8",
);

test("rejects the exact candidate at the no-effect authority gate", () => {
  const result = evaluateCompatibility({
    args: ["--candidate", exactCandidate],
    evidenceText,
    promptBytes: exactPrompt,
    reportText,
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.output, {
    schemaVersion: "keiko-native-codex-compatibility-evaluation/v1",
    candidate: exactCandidate,
    decision: "reject",
    failedGate: "no-effect-authority",
    reasonCode: "local-tool-cannot-be-preexecution-denied",
  });
});

test("rejects missing, different, and additional inputs without echoing them", () => {
  const cases = [
    [],
    ["--candidate"],
    ["--candidate", "@openai/codex@0.144.0"],
    ["--candidate", exactCandidate, "--endpoint", "private-value"],
  ];

  for (const args of cases) {
    const result = evaluateCompatibility({
      args,
      evidenceText,
      promptBytes: exactPrompt,
      reportText,
    });

    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.output, {
      schemaVersion: "keiko-native-codex-compatibility-evaluation/v1",
      decision: "reject",
      reasonCode: "invalid-command",
    });
    assert.doesNotMatch(
      JSON.stringify(result.output),
      /private-value|0\.144\.0/u,
    );
  }
});

test("fails closed when an evidence, report, or prompt binding changes", () => {
  const malformedEvidence = evaluateCompatibility({
    args: ["--candidate", exactCandidate],
    evidenceText: `${evidenceText} `,
    promptBytes: exactPrompt,
    reportText,
  });
  const changedReport = evaluateCompatibility({
    args: ["--candidate", exactCandidate],
    evidenceText,
    promptBytes: exactPrompt,
    reportText: `${reportText} `,
  });
  const missingReport = evaluateCompatibility({
    args: ["--candidate", exactCandidate],
    evidenceText,
    promptBytes: exactPrompt,
    reportText: undefined,
  });
  const changedPrompt = evaluateCompatibility({
    args: ["--candidate", exactCandidate],
    evidenceText,
    promptBytes: Buffer.from("changed\n", "utf8"),
    reportText,
  });

  assert.equal(malformedEvidence.exitCode, 2);
  assert.equal(malformedEvidence.output.reasonCode, "evidence-binding-failed");
  assert.equal(changedReport.exitCode, 2);
  assert.equal(changedReport.output.reasonCode, "evidence-binding-failed");
  assert.equal(missingReport.exitCode, 2);
  assert.equal(missingReport.output.reasonCode, "evidence-binding-failed");
  assert.equal(changedPrompt.exitCode, 2);
  assert.equal(changedPrompt.output.reasonCode, "evidence-binding-failed");
});

test("binds the frozen prompt to the accepted bytes and digest", () => {
  assert.equal(exactPrompt.byteLength, PROMPT_BYTES);
  assert.equal(
    PROMPT_SHA256,
    "e1a92579b1ca673135331829beb97792c1289a6bccdfe0303302256c546960f6",
  );
});

test("binds generated JSON schemas with a path-bound canonical digest", () => {
  const evidence = JSON.parse(evidenceText);

  assert.deepEqual(evidence.generatedSchemas.method.jsonDigest, {
    algorithm: "path-bound-canonical-json-v1",
    canonicalizer: "jq -S .",
    canonicalizerVersion: "jq-1.7.1-apple",
    fileOrder: "LC_ALL=C sorted NUL-delimited relative paths",
    recordFormat:
      "<relative-path-without-leading-dot-slash> NUL <canonical-content-sha256> NUL",
    aggregate: "SHA-256 of concatenated records",
  });
  assert.match(
    evidence.generatedSchemas.method.jsonDigestCommand,
    /jq -S \. "\$schema_file"/u,
  );
  assert.match(
    evidence.generatedSchemas.method.jsonDigestCommand,
    /printf '%s\\0%s\\0' "\$\{schema_file#\.\/\}" "\$canonical_sha"/u,
  );
  assert.doesNotMatch(
    evidence.generatedSchemas.method.jsonDigestCommand,
    /xargs -0 shasum/u,
  );
  assert.equal(
    evidence.generatedSchemas.method.typeScriptDigestCommand,
    "(find . -type f -print0 | sort -z | xargs -0 shasum -a 256) | shasum -a 256",
  );
  assert.deepEqual(evidence.generatedSchemas.stableJson, {
    fileCount: 273,
    sha256: "27fc5257cdd29b97b2abb064caadec32a72b7567d6df26a7f82c5f452c8bdfb9",
  });
  assert.deepEqual(evidence.generatedSchemas.experimentalJson, {
    fileCount: 347,
    sha256: "46c4414f08cdbb20e66ce4153ee1edcb865ed5fda67e59511a78939ddb7a82d1",
  });
  assert.equal(
    evidence.generatedSchemas.stableTypeScript.sha256,
    "bfe516c4dab610ddecc10ae40763cec197d8673853705f2cf39bb07f74bdd0ca",
  );
  assert.equal(
    evidence.generatedSchemas.experimentalTypeScript.sha256,
    "9f2716686ccc10c0fedcea92363f8ac0ad8eafcc081855e284a28c358c6ec82d",
  );
});

function runNpmEvaluator(additionalArgs = []) {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "run",
      "--silent",
      "evaluate:codex-compatibility:macos",
      "--",
      "--candidate",
      exactCandidate,
      ...additionalArgs,
    ],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    },
  );
  return result;
}

test("the exact npm command emits one closed rejection JSON line", () => {
  const result = runNpmEvaluator();

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: "keiko-native-codex-compatibility-evaluation/v1",
    candidate: exactCandidate,
    decision: "reject",
    failedGate: "no-effect-authority",
    reasonCode: "local-tool-cannot-be-preexecution-denied",
  });
  assert.equal(result.stdout.split("\n").filter(Boolean).length, 1);
});

test("the silent npm boundary rejects hostile extras without echoing them", () => {
  const hostileValue = "private-endpoint-value";
  const result = runNpmEvaluator(["--endpoint", hostileValue]);

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: "keiko-native-codex-compatibility-evaluation/v1",
    decision: "reject",
    reasonCode: "invalid-command",
  });
  assert.equal(result.stdout.split("\n").filter(Boolean).length, 1);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private-endpoint/u);
});
