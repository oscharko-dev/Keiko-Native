import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  exactToolchainFailures,
  workflowToolchainFailures,
} from "./toolchain.mjs";

const exactPackage = {
  devEngines: {
    packageManager: { name: "npm", onFail: "error", version: "11.16.0" },
    runtime: { name: "node", onFail: "error", version: "24.18.0" },
  },
  engines: { node: "24.18.0", npm: "11.16.0" },
  packageManager: "npm@11.16.0",
  scripts: {
    "native:dependencies":
      "node quality/check-toolchain.mjs && npm --prefix native/frontend ci",
    quality: "node quality/check-toolchain.mjs && npm test",
  },
};

test("exact toolchain contract accepts only Node 24.18.0 and npm 11.16.0", () => {
  assert.deepEqual(
    exactToolchainFailures({
      nodeVersion: "24.18.0",
      npmVersion: "11.16.0",
      packageContract: exactPackage,
    }),
    [],
  );
  for (const mutation of [
    { nodeVersion: "24.18.1" },
    { npmVersion: "11.16.1" },
    { npmConfig: "engine-strict=false\n" },
    {
      packageContract: {
        ...exactPackage,
        engines: { ...exactPackage.engines, npm: ">=11" },
      },
    },
    { packageContract: { ...exactPackage, packageManager: "npm@11.15.0" } },
    { packageContract: { ...exactPackage, devEngines: undefined } },
    { packageContract: { ...exactPackage, scripts: {} } },
  ]) {
    assert.ok(
      exactToolchainFailures({
        nodeVersion: "24.18.0",
        npmVersion: "11.16.0",
        packageContract: exactPackage,
        ...mutation,
      }).length > 0,
    );
  }
});

test("npm ci and guarded entry points fail on wrong Node or npm versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-toolchain-"));
  try {
    for (const devEngines of [
      {
        packageManager: { name: "npm", onFail: "error", version: "0.0.0" },
        runtime: exactPackage.devEngines.runtime,
      },
      {
        packageManager: exactPackage.devEngines.packageManager,
        runtime: { name: "node", onFail: "error", version: "0.0.0" },
      },
    ]) {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          devEngines,
          name: "fixture",
          scripts: {
            "native:dependencies": "echo should-not-run",
            quality: "echo should-not-run",
          },
          version: "1.0.0",
        }),
      );
      await writeFile(
        join(root, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          name: "fixture",
          packages: { "": { name: "fixture", version: "1.0.0" } },
          requires: true,
          version: "1.0.0",
        }),
      );
      for (const args of [
        ["ci", "--ignore-scripts"],
        ["run", "native:dependencies"],
        ["run", "quality"],
      ]) {
        const result = spawnSync("npm", args, {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        });
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}${result.stderr}`, /EBADDEVENGINES/u);
        assert.doesNotMatch(String(result.stdout), /should-not-run/u);
      }
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("every npm workflow consumer activates and verifies the exact toolchain first", async () => {
  const activationCommands = [
    "corepack enable npm",
    "corepack install --global npm@11.16.0",
    "node quality/check-toolchain.mjs",
  ];
  for (const name of ["ci.yml", "mutation-security.yml"]) {
    const workflow = await readFile(
      join(import.meta.dirname, "../.github/workflows", name),
      "utf8",
    );
    assert.deepEqual(workflowToolchainFailures(workflow), []);
    const mutations = [
      workflow.replace("corepack enable npm", "corepack enable pnpm"),
      workflow.replace(
        "corepack install --global npm@11.16.0",
        "corepack install --global npm@11",
      ),
      workflow.replace("node quality/check-toolchain.mjs", "node --version"),
      workflow.replace(
        "      - name: Activate exact npm 11.16.0\n",
        "      - name: Activate exact npm 11.16.0\n        if: false\n",
      ),
      workflow.replace(
        [
          "          corepack enable npm",
          "          corepack install --global npm@11.16.0",
          "          node quality/check-toolchain.mjs",
        ].join("\n"),
        [
          "          corepack enable npm",
          "          node quality/check-toolchain.mjs",
          "          corepack install --global npm@11.16.0",
        ].join("\n"),
      ),
      workflow.replace(
        "          corepack enable npm",
        "          npm ci --ignore-scripts\n          corepack enable npm",
      ),
      workflow.replace(
        "          corepack enable npm",
        "          true || corepack enable npm",
      ),
      workflow.replace(
        "          corepack install --global npm@11.16.0",
        "          true || corepack install --global npm@11.16.0",
      ),
      workflow.replace(
        "          node quality/check-toolchain.mjs",
        "          true || node quality/check-toolchain.mjs",
      ),
      workflow.replace(
        "      - name: Activate exact npm 11.16.0\n",
        [
          "      - name: Activate exact npm 11.16.0",
          "        continue-on-error: true",
          "",
        ].join("\n"),
      ),
      ...activationCommands.flatMap((command) =>
        ["/usr/bin/true", "echo"].map((prefix) =>
          workflow.replace(
            `          ${command}`,
            `          ${prefix} ${command}`,
          ),
        ),
      ),
      workflow.replace(
        "        run: |\n          corepack enable npm",
        [
          "        env:",
          "          OWNED: unsafe",
          "        run: |",
          "          corepack enable npm",
        ].join("\n"),
      ),
      workflow.replace(
        "        run: |\n          corepack enable npm",
        "        shell: bash\n        run: |\n          corepack enable npm",
      ),
      ...addInheritedWorkflowControls(workflow),
      ...addInheritedJobControls(workflow),
      ...addNpmStepControls(workflow),
      addJobContinueOnError(workflow),
      moveFirstActivationAfterNpm(workflow),
    ];
    for (const [index, mutated] of mutations.entries()) {
      assert.ok(
        workflowToolchainFailures(mutated).length > 0,
        `${name} mutation ${String(index)}`,
      );
    }
    assert.deepEqual(
      workflowToolchainFailures(addLegitimateStepEnvironment(workflow)),
      [],
      name,
    );
  }
});

test("workflow detection covers every npm and npx lexical token", () => {
  for (const run of [
    "run: npm install --ignore-scripts",
    "run: npx package-tool",
    "run: FOO=owned npm.cmd exec fixture",
    "run: command npx.cmd --yes fixture",
    "run: cd workspace && npm audit --audit-level=high",
    [
      "run: |",
      "  echo preparing",
      "  npm exec fixture",
      "  echo complete",
    ].join("\n"),
    ["run: >", "  sudo env OWNED=1", "  npx.cmd fixture"].join("\n"),
    "run: bash -c 'npm ci --ignore-scripts'",
    'run: sh -c "npx fixture"',
    "run: pwsh -Command 'npm.cmd install'",
    "run: cmd /c npx.cmd fixture",
    "run: env -i npm ci",
    "run: sudo -u root npm install",
    "run: command -- npm audit",
    "run: eval 'npm ci'",
    "run: xargs npm",
    'run: echo "npm install is documentation"',
    "run: printf '%s' 'npx exec is documentation'",
    'run: echo "$(npm --version)"',
    "run: echo `npx --version`",
    'run: bash -c "$OWNED_SCRIPT"',
  ]) {
    assert.ok(
      workflowToolchainFailures(workflowFixture(run)).includes(
        "workflow-npm-activation",
      ),
      run,
    );
  }
  for (const run of ["run: echo safe # npm install is a comment"]) {
    assert.deepEqual(workflowToolchainFailures(workflowFixture(run)), [], run);
  }
  assert.deepEqual(
    workflowToolchainFailures(
      [
        "# npm install is a YAML comment",
        "name: npm install is workflow metadata",
        "jobs:",
        "  fixture:",
        "    name: npx is job metadata",
        "    steps:",
        "      - name: npm is step metadata",
        "        run: echo safe",
      ].join("\n"),
    ),
    [],
  );
});

test("workflow activation cannot leak across uppercase or underscored jobs", () => {
  const workflow = [
    "jobs:",
    "  Activated_Job:",
    "    steps:",
    "      - uses: actions/setup-node@0123456789012345678901234567890123456789",
    "        with:",
    '          node-version: "24.18.0"',
    "      - name: Activate exact npm 11.16.0",
    "        run: |",
    "          corepack enable npm",
    "          corepack install --global npm@11.16.0",
    "          node quality/check-toolchain.mjs",
    "  Consumer_JOB:",
    "    steps:",
    "      - run: npm install",
  ].join("\n");
  assert.ok(
    workflowToolchainFailures(workflow).includes("workflow-npm-activation"),
  );
});

function moveFirstActivationAfterNpm(workflow) {
  const block = [
    "      - name: Activate exact npm 11.16.0",
    "        run: |",
    "          corepack enable npm",
    "          corepack install --global npm@11.16.0",
    "          node quality/check-toolchain.mjs",
    "",
  ].join("\n");
  return workflow
    .replace(block, "")
    .replace(
      "      - run: npm ci --ignore-scripts",
      `      - run: npm ci --ignore-scripts\n${block.trimEnd()}`,
    );
}

function addJobContinueOnError(workflow) {
  return workflow.replace(
    /^(  (?:core-quality|native-mutation-security):\n)/mu,
    "$1    continue-on-error: true\n",
  );
}

function addInheritedWorkflowControls(workflow) {
  return [
    workflow.replace(
      "permissions: {}",
      "defaults:\n  run:\n    shell: /usr/bin/true {0}\n\npermissions: {}",
    ),
    ...["BASH_ENV", "ENV", "NODE_OPTIONS", "PATH"].map((name) =>
      workflow.replace(
        "permissions: {}",
        `env:\n  ${name}: owned\n\npermissions: {}`,
      ),
    ),
  ];
}

function addInheritedJobControls(workflow) {
  const insert = (value) =>
    workflow.replace(
      /^(  (?:core-quality|native-mutation-security):\n)/mu,
      `$1${value}`,
    );
  return [
    insert("    defaults:\n      run:\n        shell: /usr/bin/true {0}\n"),
    ...["BASH_ENV", "ENV", "NODE_OPTIONS", "PATH"].map((name) =>
      insert(`    env:\n      ${name}: owned\n`),
    ),
  ];
}

function addNpmStepControls(workflow) {
  return [
    ...[
      "if: false",
      "continue-on-error: true",
      "shell: /usr/bin/true {0}",
      "working-directory: /tmp",
    ].map((control) =>
      workflow.replace(
        "      - run: npm ci --ignore-scripts",
        `      - ${control}\n        run: npm ci --ignore-scripts`,
      ),
    ),
    ...["BASH_ENV", "ENV", "NODE_OPTIONS", "PATH"].flatMap((name) =>
      [
        `      - env:\n          ${name}: owned`,
        `      - env: { ${name}: owned }`,
      ].map((environment) =>
        workflow.replace(
          "      - run: npm ci --ignore-scripts",
          `${environment}\n        run: npm ci --ignore-scripts`,
        ),
      ),
    ),
  ];
}

function addLegitimateStepEnvironment(workflow) {
  return workflow.replace(
    "      - run: npm ci --ignore-scripts",
    [
      "      - run: npm ci --ignore-scripts",
      "        env:",
      '          KEIKO_NATIVE_REQUIRE_MACOS: "1"',
    ].join("\n"),
  );
}

function workflowFixture(run) {
  return [
    "jobs:",
    "  fixture:",
    "    steps:",
    "      - uses: actions/setup-node@0123456789012345678901234567890123456789",
    "        with:",
    '          node-version: "24.18.0"',
    ...run
      .split("\n")
      .map((line, index) => `${index === 0 ? "      - " : "        "}${line}`),
  ].join("\n");
}
