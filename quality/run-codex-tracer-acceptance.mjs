#!/usr/bin/env node

import {
  runCodexTracerAcceptance,
  validateAcceptanceInvocation,
} from "./codex-tracer-acceptance.mjs";
import { createCodexTracerAcceptanceIo } from "./codex-tracer-acceptance-io.mjs";

const invalid = validateAcceptanceInvocation(process.argv.slice(2));
const result =
  invalid ??
  (await runCodexTracerAcceptance({
    args: [],
    io: createCodexTracerAcceptanceIo(),
  }));

process.stdout.write(`${JSON.stringify(result.output)}\n`);
process.exitCode = result.exitCode;
