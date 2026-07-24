import { createHash } from "node:crypto";

const SCHEMA_VERSION = "keiko-native-codex-compatibility-evaluation/v1";
const EXACT_CANDIDATE = "@openai/codex@0.145.0";
const EVIDENCE_SHA256 =
  "c1663d16c17d20b8af4cc128042cbbc10dbb6cea9e619170719bc016426b1a07";

export const PROMPT_BYTES = 182;
export const PROMPT_SHA256 =
  "e1a92579b1ca673135331829beb97792c1289a6bccdfe0303302256c546960f6";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function closedFailure(reasonCode) {
  return {
    exitCode: 2,
    output: {
      schemaVersion: SCHEMA_VERSION,
      decision: "reject",
      reasonCode,
    },
  };
}

export function evaluateCompatibility({ args, evidenceText, promptBytes }) {
  if (
    args.length !== 2 ||
    args[0] !== "--candidate" ||
    args[1] !== EXACT_CANDIDATE
  ) {
    return closedFailure("invalid-command");
  }

  if (
    sha256(evidenceText) !== EVIDENCE_SHA256 ||
    promptBytes.byteLength !== PROMPT_BYTES ||
    sha256(promptBytes) !== PROMPT_SHA256
  ) {
    return closedFailure("evidence-binding-failed");
  }

  return {
    exitCode: 1,
    output: {
      schemaVersion: SCHEMA_VERSION,
      candidate: EXACT_CANDIDATE,
      decision: "reject",
      failedGate: "no-effect-authority",
      reasonCode: "local-tool-cannot-be-preexecution-denied",
    },
  };
}
