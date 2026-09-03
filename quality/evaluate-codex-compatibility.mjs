#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { evaluateCompatibility } from "./codex-compatibility.mjs";

let result;
try {
  result = evaluateCompatibility({
    args: process.argv.slice(2),
    evidenceText: readFileSync(
      new URL(
        "../docs/evaluation/codex-0.145.0-rejection.json",
        import.meta.url,
      ),
      "utf8",
    ),
    reportText: readFileSync(
      new URL("../docs/evaluation/codex-0.145.0-rejection.md", import.meta.url),
      "utf8",
    ),
    promptBytes: readFileSync(
      new URL("./fixtures/codex-tracer/no-effect-prompt.txt", import.meta.url),
    ),
  });
} catch {
  result = {
    exitCode: 2,
    output: {
      schemaVersion: "keiko-native-codex-compatibility-evaluation/v1",
      decision: "reject",
      reasonCode: "evidence-unavailable",
    },
  };
}

process.stdout.write(`${JSON.stringify(result.output)}\n`);
process.exitCode = result.exitCode;
