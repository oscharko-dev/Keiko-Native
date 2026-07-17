import { audit, benchmark, sanitizedFailure, verify } from "./harness.mjs";

const command = process.argv[2];
const quick = process.argv.slice(3).includes("--quick");

try {
  if (command === "verify") {
    const result = await verify(process.cwd());
    process.stdout.write(
      `foundation-evaluation: verified candidates=${Object.keys(result.candidates).length}\n`,
    );
  } else if (command === "benchmark" || command === "diagnostic") {
    const { result } = await benchmark(process.cwd(), {
      diagnostic: command === "diagnostic",
      onProgress: ({ completedPairs, totalPairs }) =>
        process.stdout.write(
          `foundation-evaluation: progress pairs=${String(completedPairs)}/${String(totalPairs)}\n`,
        ),
      quick: command === "diagnostic" || quick,
    });
    process.stdout.write(
      `foundation-evaluation: benchmarked samples=${result.samples.length} authority=${result.environment.authority}\n`,
    );
  } else if (command === "audit") {
    const { result } = await audit(process.cwd());
    process.stdout.write(
      `foundation-evaluation: audited benchmark=${result.benchmarkId}\n`,
    );
  } else {
    throw new Error(
      "usage: cli.mjs verify|benchmark|diagnostic|audit [--quick]",
    );
  }
} catch (error) {
  process.stderr.write(
    `foundation-evaluation: failed ${JSON.stringify(sanitizedFailure(error))}\n`,
  );
  process.exitCode = 1;
}
