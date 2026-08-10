#!/usr/bin/env node

import { runCodexTracerWorkspaceAcceptance } from "./codex-tracer-acceptance.mjs";
import { createCodexTracerAcceptanceIo } from "./codex-tracer-acceptance-io.mjs";

const result = await runCodexTracerWorkspaceAcceptance({
  args: process.argv.slice(2),
  io: createCodexTracerAcceptanceIo(),
});

process.stdout.write(`${JSON.stringify(result.output)}\n`);
process.exitCode = result.exitCode;
