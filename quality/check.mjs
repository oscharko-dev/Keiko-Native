import { validateRepository } from "./contract.mjs";

const result = await validateRepository(process.cwd());

if (result.failureCount > 0) {
  for (const failure of result.failures)
    process.stderr.write(`quality-contract: ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `quality-contract: passed files=${String(result.fileCount)} phase=${result.phase} productiveSources=${String(result.productiveSourceCount)}\n`,
  );
}
