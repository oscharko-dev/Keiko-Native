import { createHash } from "node:crypto";

const SCHEMA_VERSION = "keiko-native-codex-compatibility-evaluation/v1";
const EXACT_CANDIDATE = "@openai/codex@0.145.0";
const EVIDENCE_SHA256 =
  "6a5b45d2ae4e30bb16967fe179da3ee6a9c8ca834aa052c77a246200832ef8b5";
const REPORT_SHA256 =
  "e56ded04511ee010fe374dc7d5894d5bd27f0850948fc097138c349ecee5c7c0";

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

export function evaluateCompatibility({
  args,
  evidenceText,
  promptBytes,
  reportText,
}) {
  if (
    args.length !== 2 ||
    args[0] !== "--candidate" ||
    args[1] !== EXACT_CANDIDATE
  ) {
    return closedFailure("invalid-command");
  }

  if (
    typeof evidenceText !== "string" ||
    typeof reportText !== "string" ||
    !Buffer.isBuffer(promptBytes) ||
    sha256(evidenceText) !== EVIDENCE_SHA256 ||
    sha256(reportText) !== REPORT_SHA256 ||
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
