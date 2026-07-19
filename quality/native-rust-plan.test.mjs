import assert from "node:assert/strict";
import test from "node:test";

import { productiveRustEnv, rustTestPlan } from "./native-process.mjs";

test("Rust tests use a distinct revision-bound governed target", () => {
  const revision = "e".repeat(40);
  const environment = productiveRustEnv("/workspace", revision);
  const plan = rustTestPlan(
    revision,
    environment,
    "/governed/output/cargo-test-target",
  );
  assert.equal(plan.options.env.KEIKO_NATIVE_SOURCE_REVISION, revision);
  assert.equal(
    plan.options.env.CARGO_ENCODED_RUSTFLAGS,
    environment.CARGO_ENCODED_RUSTFLAGS,
  );
  assert.equal(
    plan.options.env.CARGO_TARGET_DIR,
    "/governed/output/cargo-test-target",
  );
});
