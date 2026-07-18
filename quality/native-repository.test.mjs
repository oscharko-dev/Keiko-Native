import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createExactHeadGuard,
  worktreeStateFailures,
} from "./native-repository.mjs";
import {
  createNativePackageGate,
  nativePackageTestSupport,
} from "./native-package.mjs";

test("exact-head state rejects declared drift and permits governed outputs", () => {
  assert.deepEqual(
    worktreeStateFailures(
      [
        "!! native/target/",
        "!! native/frontend/coverage/",
        "!! native/frontend/dist/",
        "!! native/apps/keiko-desktop/gen/",
      ].join("\0"),
    ),
    [],
  );
  for (const status of [
    " M native/Cargo.toml\0",
    "?? native/frontend/src/injected.ts\0",
    "!! .env\0",
    "120 native/frontend/src/injected.ts\0",
  ]) {
    assert.ok(worktreeStateFailures(status).length > 0);
  }
});

test("exact-head guard detects a mid-run revision change without mutating git", () => {
  const head = "a".repeat(40);
  const changed = "b".repeat(40);
  const revisions = [head, head, changed];
  const readGit = (args) =>
    args[0] === "rev-parse" ? revisions.shift() : "!! native/target/\0";
  const guard = createExactHeadGuard(readGit);
  assert.equal(guard.expectedHead, head);
  guard.assertUnchanged("before-build");
  assert.throws(
    () => guard.assertUnchanged("after-build"),
    /Exact-head repository rejected head-changed at after-build/u,
  );
});

test("package build receives one captured revision and checks both boundaries", async () => {
  const head = "c".repeat(40);
  const events = [];
  const { packageNative } = createNativePackageGate({
    build: async (revision) => events.push(`build:${revision}`),
    captureRepositoryState: () => ({
      assertUnchanged: (stage) => events.push(`assert:${stage}`),
      expectedHead: head,
    }),
    onMacOs: () => false,
    packageRoot: "/tmp/package",
  });
  assert.equal(await packageNative(), head);
  assert.deepEqual(events, [
    "assert:before-build",
    `build:${head}`,
    "assert:after-build",
  ]);
});

test("macOS release build receives the captured revision without a second lookup", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "keiko-package-revision-"));
  const captured = "d".repeat(40);
  const later = "e".repeat(40);
  const rustRevisions = [];
  try {
    const { packageNative } = createNativePackageGate({
      build: async (revision) => assert.equal(revision, captured),
      captureRepositoryState: () => ({
        assertUnchanged() {},
        expectedHead: captured,
      }),
      frontendRoot: "/snapshot/native/frontend",
      nativeRoot: "/snapshot/native",
      onMacOs: () => true,
      packageRoot,
      run(_command, _args, options) {
        assert.equal(later, "e".repeat(40));
        assert.equal(options.env.KEIKO_NATIVE_SOURCE_REVISION, captured);
        throw new Error("release-build-observed");
      },
      rustBuildEnv(revision) {
        rustRevisions.push(revision);
        return { KEIKO_NATIVE_SOURCE_REVISION: revision };
      },
      targetRoot: "/snapshot/native/target",
    });
    await assert.rejects(packageNative(), /release-build-observed/u);
    assert.deepEqual(rustRevisions, [captured]);
  } finally {
    await rm(packageRoot, { force: true, recursive: true });
  }
});

test("acceptance tests the exact revision before packaging into the shared target", async () => {
  const revision = "f".repeat(40);
  const events = [];
  const repositoryState = {
    expectedHead: revision,
    assertUnchanged(stage) {
      events.push(`assert:${stage}`);
    },
  };
  assert.equal(
    await nativePackageTestSupport.prepareAcceptancePackage({
      packageNative(state) {
        assert.equal(state, repositoryState);
        events.push("package");
        return revision;
      },
      repositoryState,
      testNative(value) {
        events.push(`test:${value}`);
      },
    }),
    revision,
  );
  assert.deepEqual(events, [
    `test:${revision}`,
    "assert:after-test",
    "package",
  ]);
});
