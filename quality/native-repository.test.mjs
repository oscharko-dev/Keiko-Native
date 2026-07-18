import assert from "node:assert/strict";
import test from "node:test";

import {
  createExactHeadGuard,
  worktreeStateFailures,
} from "./native-repository.mjs";
import { createNativePackageGate } from "./native-package.mjs";

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
