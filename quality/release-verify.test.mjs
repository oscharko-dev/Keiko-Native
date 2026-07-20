import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  dependenciesFromPolicy,
  main,
  parseReleaseArguments,
  runCancellableCommand,
  runReleaseCli,
} from "./release-verify.mjs";

const validWorkflow = await readFile(
  new URL("../.github/workflows/internal-release.yml", import.meta.url),
);
const inputEvidence = Object.freeze({
  cargoLockSha256: "a".repeat(64),
  frontendLockSha256: "b".repeat(64),
  policySha256: "c".repeat(64),
  rootLockSha256: "d".repeat(64),
});

test("production child execution is interrupted by an abort signal", async () => {
  const controller = new AbortController();
  const child = runCancellableCommand(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { cwd: process.cwd(), signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(child, /release-cancelled/u);
});

test("ordinary child completion succeeds when its process group is empty", async () => {
  await runCancellableCommand(process.execPath, ["-e", "process.exit(0)"], {
    cwd: process.cwd(),
  });
});

test("release command boundary ignores replacements and hardens nested env", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-release-replace-"));
  const git = (args, options = {}) =>
    runCancellableCommand("git", args, { cwd: root, ...options });
  try {
    await git(["init"]);
    await git(["config", "user.email", "fixture@invalid"]);
    await git(["config", "user.name", "Fixture"]);
    await writeFile(join(root, "input"), "authorized");
    await git(["add", "input"]);
    await git(["commit", "-m", "authorized"]);
    const authorized = await git(["rev-parse", "HEAD"], { capture: true });
    await writeFile(join(root, "input"), "substituted");
    await git(["commit", "-am", "substituted"]);
    const substituted = await git(["rev-parse", "HEAD"], { capture: true });
    await git(["replace", authorized, substituted]);

    assert.equal(
      await git(["show", `${authorized}:input`], { capture: true }),
      "authorized",
    );
    assert.equal(
      await runCancellableCommand(
        process.execPath,
        [
          "-e",
          "process.stdout.write(process.env.GIT_NO_REPLACE_OBJECTS ?? '')",
        ],
        { capture: true, cwd: root },
      ),
      "1",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test(
  "hostile child and descendant are reaped before cancellation returns",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "keiko-release-cancel-"));
    const pidsPath = join(root, "pids.json");
    const readyPath = join(root, "descendant-ready");
    const childMarker = join(root, "descendant-marker");
    const descendantCode = `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {
      setTimeout(() => fs.writeFileSync(${JSON.stringify(childMarker)}, "bad"), 200);
    });
    fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
    setInterval(() => {}, 1000);
  `;
    const parentCode = `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { stdio: "ignore" });
    process.on("SIGTERM", () => process.exit(0));
    const readiness = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(readyPath)})) {
        clearInterval(readiness);
        fs.writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, descendant.pid]));
      }
    }, 5);
  `;
    const controller = new AbortController();
    let command;
    let commandSettled = false;
    try {
      command = runCancellableCommand(process.execPath, ["-e", parentCode], {
        cwd: root,
        signal: controller.signal,
        terminationGraceMs: 50,
      });
      const pids = await readProcessIds(pidsPath);
      assert.equal(pids?.length, 2);
      controller.abort();
      await assert.rejects(command, /release-cancelled/u);
      commandSettled = true;
      assertProcessesDead(pids);
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      await assert.rejects(access(childMarker));
    } finally {
      controller.abort();
      if (command && !commandSettled) await command.catch(() => {});
      await killTestProcesses(pidsPath);
      await rm(root, { force: true, recursive: true });
    }
  },
);

test(
  "output overflow reaps a prompt leader and resistant descendant",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "keiko-release-overflow-"));
    const pidsPath = join(root, "pids.json");
    const readyPath = join(root, "descendant-ready");
    const markerPath = join(root, "descendant-marker");
    const descendantCode = `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {
      setTimeout(() => fs.writeFileSync(${JSON.stringify(markerPath)}, "bad"), 200);
    });
    fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
    setInterval(() => {}, 1000);
  `;
    const parentCode = `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { stdio: "ignore" });
    process.on("SIGTERM", () => process.exit(0));
    const readiness = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(readyPath)})) {
        clearInterval(readiness);
        fs.writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, descendant.pid]));
        process.stdout.write(Buffer.alloc(31 * 1024 * 1024));
      }
    }, 5);
  `;
    let command;
    let commandSettled = false;
    try {
      command = runCancellableCommand(process.execPath, ["-e", parentCode], {
        capture: true,
        cwd: root,
        terminationGraceMs: 50,
      });
      const rejected = assert.rejects(command, /failed/u);
      const pids = await readProcessIds(pidsPath);
      await rejected;
      commandSettled = true;
      assertProcessesDead(pids);
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      await assert.rejects(access(markerPath));
    } finally {
      if (command && !commandSettled) await command.catch(() => {});
      await killTestProcesses(pidsPath);
      await rm(root, { force: true, recursive: true });
    }
  },
);

for (const leaderStatus of [0, 7]) {
  test(
    `leader status ${String(leaderStatus)} fails closed and reaps a resistant descendant`,
    { skip: process.platform === "win32" },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "keiko-release-orphan-"));
      const pidsPath = join(root, "pids.json");
      const readyPath = join(root, "descendant-ready");
      const markerPath = join(root, "descendant-marker");
      const descendantCode = `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {
      setTimeout(() => fs.writeFileSync(${JSON.stringify(markerPath)}, "bad"), 200);
    });
    fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
    setInterval(() => {}, 1000);
  `;
      const parentCode = `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { stdio: "ignore" });
    const readiness = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(readyPath)})) {
        clearInterval(readiness);
        fs.writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, descendant.pid]));
        process.exit(${String(leaderStatus)});
      }
    }, 5);
  `;
      let command;
      let commandSettled = false;
      try {
        command = runCancellableCommand(process.execPath, ["-e", parentCode], {
          cwd: root,
          terminationGraceMs: 50,
        });
        const rejected = assert.rejects(
          command,
          /release-process-group-remained/u,
        );
        const pids = await readProcessIds(pidsPath);
        await rejected;
        commandSettled = true;
        assertProcessesDead(pids);
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
        await assert.rejects(access(markerPath));
      } finally {
        if (command && !commandSettled) await command.catch(() => {});
        await killTestProcesses(pidsPath);
        await rm(root, { force: true, recursive: true });
      }
    },
  );
}

async function readProcessIds(path) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  throw new Error("test-processes-not-ready");
}

function assertProcessesDead(pids) {
  for (const pid of pids)
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error?.code === "ESRCH",
    );
}

async function killTestProcesses(path) {
  try {
    for (const pid of JSON.parse(await readFile(path, "utf8"))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const releaseInputs = Object.freeze({
  evidence: inputEvidence,
  policy: {
    cargoInventory: [
      { license: "Apache-2.0", name: "owned", version: "0.1.0" },
    ],
    npmInventory: [],
  },
});

test("release CLI accepts only the closed build and verify modes", () => {
  assert.deepEqual(parseReleaseArguments([]), { mode: "build" });
  assert.deepEqual(
    parseReleaseArguments([
      "--verify-only",
      "artifact",
      "--expected-head",
      "a".repeat(40),
    ]),
    {
      directory: "artifact",
      expectedHead: "a".repeat(40),
      mode: "verify",
    },
  );
  for (const args of [
    ["--verify-only"],
    ["--verify-only", "artifact"],
    ["--verify-only", "artifact", "--expected-head", "bad"],
    ["--unknown"],
  ]) {
    assert.throws(() => parseReleaseArguments(args), /release-arguments/u);
  }
});

test("SPDX dependency projection is stable and rejects malformed policy", () => {
  const policy = {
    cargoInventory: [
      { license: "Apache-2.0", name: "owned", version: "0.1.0" },
    ],
    npmInventory: [
      { dev: true, license: "MIT", name: "test", version: "1.0.0" },
      { dev: false, license: "MIT", name: "runtime", version: "2.0.0" },
    ],
  };
  assert.deepEqual(dependenciesFromPolicy(policy), [
    { license: "Apache-2.0", name: "owned", version: "0.1.0" },
    { license: "MIT", name: "runtime", version: "2.0.0" },
  ]);
  assert.throws(
    () => dependenciesFromPolicy({ cargoInventory: [], npmInventory: null }),
    /release-dependencies/u,
  );
});

test("release CLI orchestrates exact-source build and closed verification", async () => {
  assert.equal(main.length, 2);
  const events = [];
  const runtime = {
    architecture: "arm64",
    filesystem: {},
    workspaceRoot: "/workspace",
    platform: "darwin",
    repositoryRoot: "/repository",
    readWorkflow: async () => validWorkflow,
    loadInputs: async () => releaseInputs,
    runCommand(command, args, options) {
      events.push({ args, command });
      if (command === "git" && args[1] === "rev-parse") return "a".repeat(40);
      if (command === "git" && args[1] === "show") return "1700000000";
      assert.equal(options, undefined);
      return undefined;
    },
    runDiskImage: async () => {},
    async build(options) {
      events.push({ build: options });
      await options.buildPackage();
      await options.buildPackage();
    },
    async verify(options) {
      events.push({ verify: options });
    },
  };

  await main([], runtime);
  assert.deepEqual(events.slice(0, 2), [
    {
      command: "git",
      args: ["--no-replace-objects", "rev-parse", "HEAD"],
    },
    {
      command: "git",
      args: [
        "--no-replace-objects",
        "show",
        "-s",
        "--format=%ct",
        "a".repeat(40),
      ],
    },
  ]);
  assert.equal(events[2].build.revision, "a".repeat(40));
  assert.equal(events[2].build.sourceEpoch, 1_700_000_000);
  assert.equal(events[2].build.repositoryRoot, "/repository");
  assert.deepEqual(events.slice(3, 5), [
    { command: "npm", args: ["run", "native:package"] },
    { command: "npm", args: ["run", "native:package"] },
  ]);
  assert.equal(events[5].verify.expectedRevision, "a".repeat(40));

  events.length = 0;
  await main(
    [
      "--verify-only",
      "native/target/keiko-native-internal-release",
      "--expected-head",
      "b".repeat(40),
    ],
    runtime,
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    command: "git",
    args: [
      "--no-replace-objects",
      "show",
      "-s",
      "--format=%ct",
      "b".repeat(40),
    ],
  });
  assert.equal(events[1].verify.expectedRevision, "b".repeat(40));
  assert.equal(events[1].verify.expectedSourceEpoch, 1_700_000_000);
});

test("release CLI rejects unsupported platforms and malformed source identity", async () => {
  await assert.rejects(
    main([], { architecture: "arm64", platform: "linux" }),
    /release-platform-rejected/u,
  );
  await assert.rejects(
    main([], {
      architecture: "arm64",
      filesystem: {},
      workspaceRoot: "/workspace",
      loadInputs: async () => releaseInputs,
      platform: "darwin",
      readWorkflow: async () => validWorkflow,
      runCommand(command) {
        if (command === "git") return "malformed";
      },
    }),
    /release-source-identity-rejected/u,
  );
});

test("release CLI validates its owning workflow before build or verification", async () => {
  const runtime = {
    architecture: "arm64",
    filesystem: {},
    workspaceRoot: "/workspace",
    platform: "darwin",
    repositoryRoot: "/repository",
    runCommand: async () => "a".repeat(40),
    readWorkflow: async () =>
      Buffer.from("permissions: write-all # permissions: {}"),
  };
  await assert.rejects(main([], runtime), /release-workflow-rejected/u);
  await assert.rejects(
    main(
      [
        "--verify-only",
        "native/target/keiko-native-internal-release",
        "--expected-head",
        "a".repeat(40),
      ],
      runtime,
    ),
    /release-workflow-rejected/u,
  );
});

for (const terminationSignal of ["SIGINT", "SIGTERM"]) {
  test(`release CLI handles ${terminationSignal} and awaits transaction cleanup`, async () => {
    const processApi = new EventEmitter();
    const events = [];
    const runtime = {
      architecture: "arm64",
      filesystem: {},
      workspaceRoot: "/workspace",
      platform: "darwin",
      repositoryRoot: "/repository",
      readWorkflow: async () => validWorkflow,
      loadInputs: async () => ({
        evidence: inputEvidence,
        policy: {
          cargoInventory: [
            { license: "MIT", name: "dependency", version: "1.0.0" },
          ],
          npmInventory: [],
        },
      }),
      runCommand(command, args) {
        if (command === "git" && args[1] === "rev-parse") return "a".repeat(40);
        if (command === "git" && args[1] === "show") return "1700000000";
      },
      async build({ signal }) {
        events.push("build");
        try {
          processApi.emit(terminationSignal);
          assert.equal(signal.aborted, true);
          throw new Error("release-cancelled");
        } finally {
          await Promise.resolve();
          events.push("cleanup");
        }
      },
    };
    await assert.rejects(
      runReleaseCli({ args: [], processApi, runtime }),
      /release-cancelled/u,
    );
    assert.deepEqual(events, ["build", "cleanup"]);
    assert.equal(processApi.listenerCount("SIGINT"), 0);
    assert.equal(processApi.listenerCount("SIGTERM"), 0);
  });
}
