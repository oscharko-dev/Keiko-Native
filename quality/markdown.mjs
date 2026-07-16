import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { markdownFailures } from "./markdown-policy.mjs";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "coverage", "node_modules"]);

async function markdownFiles(directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
    else if (entry.isFile() && extname(path) === ".md")
      files.push(relative(root, path));
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

const config = JSON.parse(
  await readFile(join(root, ".markdown-quality.json"), "utf8"),
);
const files = await markdownFiles();
const failures = (
  await Promise.all(
    files.map(async (file) => ({
      failures: markdownFailures(
        await readFile(join(root, file), "utf8"),
        config,
      ),
      file,
    })),
  )
).flatMap(({ failures: fileFailures, file }) =>
  fileFailures.map((failure) => `${file}:${failure}`),
);

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `markdown-quality: passed files=${String(files.length)}\n`,
  );
}
