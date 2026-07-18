import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateRepository } from "./contract.mjs";

const repositoryRoot = join(import.meta.dirname, "..");
const commandStep = "      - run: npm run native:architecture";
const nextCommandStep = "      - run: npm run native:build";
const acceptanceStep = [
  "      - run: npm run acceptance:macos",
  "        env:",
  '          KEIKO_NATIVE_REQUIRE_MACOS: "1"',
].join("\n");

test("clean repository requires exact native command step identity and order", async () => {
  const mutations = [
    (workflow) =>
      workflow.replace(
        commandStep,
        "      - uses: npm run native:architecture",
      ),
    (workflow) =>
      workflow.replace(
        commandStep,
        "      - name: npm run native:architecture",
      ),
    (workflow) =>
      workflow.replace(commandStep, `${commandStep}\n${commandStep}`),
    (workflow) =>
      workflow.replace(
        `${commandStep}\n${nextCommandStep}`,
        `${nextCommandStep}\n${commandStep}`,
      ),
    (workflow) =>
      workflow.replace(
        commandStep,
        "      - { run: npm run native:architecture, shell: /usr/bin/true {0} }",
      ),
    (workflow) =>
      workflow.replace(
        commandStep,
        "      - { run: npm run native:architecture, if: false }",
      ),
    (workflow) =>
      workflow.replace(commandStep, `${commandStep}\n        if: false`),
    (workflow) =>
      workflow.replace(
        commandStep,
        `${commandStep}\n        shell: /usr/bin/true {0}`,
      ),
  ];
  await rejectCleanArchiveMutations(mutations, /Native CI command step/u);
});

test("clean repository rejects inherited and protected env aliases", async () => {
  const mutations = [
    (workflow) =>
      workflow.replace(
        "permissions: {}",
        "env: &owned\n  SAFE: value\n\npermissions: {}",
      ),
    (workflow) =>
      workflow.replace(
        "  native-matrix:\n",
        "  native-matrix:\n    env: *owned\n",
      ),
    (workflow) =>
      workflow.replace(
        acceptanceStep,
        acceptanceStep.replace("env:", "env: &accepted"),
      ),
    (workflow) =>
      workflow.replace(
        acceptanceStep,
        acceptanceStep.replace("env:", "env: !accepted"),
      ),
    (workflow) =>
      workflow.replace(
        acceptanceStep,
        [
          "      - run: npm run acceptance:macos",
          "        env: *accepted",
        ].join("\n"),
      ),
    (workflow) =>
      workflow.replace(
        acceptanceStep,
        acceptanceStep.replace(
          '          KEIKO_NATIVE_REQUIRE_MACOS: "1"',
          "          KEIKO_NATIVE_REQUIRE_MACOS:\n            nested: value",
        ),
      ),
  ];
  await rejectCleanArchiveMutations(
    mutations,
    /environment|Native CI command step/u,
  );
});

async function rejectCleanArchiveMutations(mutations, expected) {
  for (const [index, mutate] of mutations.entries()) {
    const root = await cleanArchive();
    try {
      const path = join(root, ".github/workflows/ci.yml");
      await writeFile(path, mutate(await readFile(path, "utf8")));
      const result = await validateRepository(root);
      assert.match(result.failures.join("\n"), expected, String(index));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
}

test("clean repository accepts the canonical workflow contract", async () => {
  const root = await cleanArchive();
  try {
    assert.deepEqual((await validateRepository(root)).failures, []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

async function cleanArchive() {
  const root = await mkdtemp(join(tmpdir(), "keiko-workflow-archive-"));
  const archive = spawnSync("git", ["archive", "--format=tar", "HEAD"], {
    cwd: repositoryRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(archive.status, 0, String(archive.stderr));
  const extract = spawnSync("tar", ["-xf", "-", "-C", root], {
    input: archive.stdout,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(extract.status, 0, String(extract.stderr));
  return root;
}
