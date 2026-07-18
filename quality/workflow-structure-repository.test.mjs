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
const portableQualityStep = "      - run: npm run quality:control";

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

test("clean repository rejects noncanonical npm steps and inherited keys", async () => {
  const npmStep = portableQualityStep;
  const auditStep = "      - run: npm audit --audit-level=high";
  const mutations = [
    (workflow) => workflow.replace(`${npmStep}\n`, ""),
    (workflow) =>
      workflow.replace(`${npmStep}\n${auditStep}`, `${auditStep}\n${npmStep}`),
    (workflow) => workflow.replace(npmStep, `${npmStep}\n${npmStep}`),
    (workflow) =>
      workflow.replace(
        npmStep,
        "      - { run: npm run quality, shell: /usr/bin/true {0} }",
      ),
    (workflow) =>
      workflow.replace(
        npmStep,
        `${npmStep}\n        "shell": /usr/bin/true {0}`,
      ),
    (workflow) =>
      workflow.replace(
        "permissions: {}",
        '"env":\n  BASH_ENV: owned\n\npermissions: {}',
      ),
    (workflow) =>
      workflow.replace(
        "permissions: {}",
        '"defaults":\n  run:\n    shell: /usr/bin/true {0}\n\npermissions: {}',
      ),
    (workflow) =>
      workflow.replace(
        "permissions: {}",
        "!!str env:\n  BASH_ENV: owned\n\npermissions: {}",
      ),
    (workflow) =>
      workflow.replace(
        "  core-quality:\n",
        '  core-quality:\n    "env":\n      BASH_ENV: owned\n',
      ),
    (workflow) =>
      workflow.replace(
        "  core-quality:\n",
        '  core-quality:\n    "defaults":\n      run:\n        shell: /usr/bin/true {0}\n',
      ),
    (workflow) =>
      workflow.replace(
        "  core-quality:\n",
        '  core-quality:\n    "continue-on-error": true\n',
      ),
    (workflow) =>
      workflow.replace(
        "      - run: npm ci --ignore-scripts",
        [
          "      - name: Mutate later execution context",
          "        run: echo 'BASH_ENV=/tmp/owned' >> \"$GITHUB_ENV\"",
          "      - run: npm ci --ignore-scripts",
        ].join("\n"),
      ),
    (workflow) =>
      workflow.replace(
        "      - run: npm ci --ignore-scripts",
        "      - run: true\n      - run: npm ci --ignore-scripts",
      ),
    (workflow) =>
      workflow.replace(
        "  core-quality:\n",
        "  core-quality:\n    container: alpine:3.23\n",
      ),
    (workflow) =>
      workflow.replace(
        "  core-quality:\n",
        [
          "  core-quality:",
          "    services:",
          "      helper:",
          "        image: alpine:3.23",
          "",
        ].join("\n"),
      ),
    (workflow) =>
      workflow.replace(
        "  core-quality:\n",
        "  core-quality:\n    x-observation: true\n",
      ),
  ];
  await rejectCleanArchiveMutations(mutations, /workflow-/u);
});

test("Linux core quality cannot invoke macOS-authoritative native gates", async () => {
  await rejectCleanArchiveMutations(
    [
      (workflow) =>
        workflow.replace(portableQualityStep, "      - run: npm run quality"),
      (workflow) =>
        workflow.replace(
          portableQualityStep,
          [
            "      - name: Install partial Rust toolchain",
            "        run: rustup toolchain install 1.92.0 --profile minimal --component rustfmt",
            portableQualityStep,
          ].join("\n"),
        ),
      (workflow) =>
        workflow.replace(
          portableQualityStep,
          `${portableQualityStep}\n      - run: npm run native:package`,
        ),
    ],
    /workflow-job-contract-core-quality/u,
  );
});

test("clean repository exact-binds fail-closed and security jobs", async () => {
  const cases = [
    ["ci.yml", "      - name: Aggregate required CI results fail closed"],
    ["ci.yml", "      - name: Aggregate native matrix results fail closed"],
    ["ci.yml", "      - name: Download and verify actionlint"],
    [
      "ci.yml",
      "      - uses: zizmorcore/zizmor-action@192e21d79ab29983730a13d1382995c2307fbcaa # v0.5.7",
    ],
    [
      "dependency-review.yml",
      "      - uses: actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5.0.0",
    ],
    [
      "mutation-security.yml",
      "      - name: Run productive Rust mutation suite",
    ],
  ];
  const misses = [];
  for (const [workflowName, marker] of cases) {
    for (const [kind, mutate] of [
      [
        "control",
        (workflow) =>
          workflow.replace(
            marker,
            `${marker}\n        continue-on-error: true`,
          ),
      ],
      [
        "extra-step",
        (workflow) => workflow.replace(marker, `      - run: true\n${marker}`),
      ],
    ]) {
      const root = await cleanArchive();
      try {
        const path = join(root, ".github/workflows", workflowName);
        const source = await readFile(path, "utf8");
        const mutation = mutate(source);
        if (mutation === source) {
          misses.push(`${workflowName}:${marker}:${kind}:mutation`);
          continue;
        }
        await writeFile(path, mutation);
        const failures = (await validateRepository(root)).failures.join("\n");
        if (!/workflow-job-contract-/u.test(failures))
          misses.push(`${workflowName}:${marker}:${kind}:validation`);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  }
  assert.deepEqual(misses, []);
});

async function rejectCleanArchiveMutations(mutations, expected) {
  const misses = [];
  for (const [index, mutate] of mutations.entries()) {
    const root = await cleanArchive();
    try {
      const path = join(root, ".github/workflows/ci.yml");
      await writeFile(path, mutate(await readFile(path, "utf8")));
      const result = await validateRepository(root);
      if (!expected.test(result.failures.join("\n"))) misses.push(index);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
  assert.deepEqual(misses, []);
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
