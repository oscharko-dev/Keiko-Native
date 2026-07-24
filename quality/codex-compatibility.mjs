import { createHash } from "node:crypto";

const SCHEMA_VERSION = "keiko-native-codex-compatibility-evaluation/v1";
const EXACT_CANDIDATE = "@openai/codex@0.145.0";
const EVIDENCE_SHA256 =
  "dad2c2ef07ebee7ece6a0bb9ddc2dea2c28e88a94c5dbbc2c00bf31bff36d36b";
const REPORT_SHA256 =
  "3eb6306621cc68fe5501c79ad0b2169bcd410707ae82f0da79116155a2d669fa";

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
