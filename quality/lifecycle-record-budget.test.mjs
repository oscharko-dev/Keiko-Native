import assert from "node:assert/strict";
import test from "node:test";

import {
  LifecycleProviderError,
  callLifecycleProvider,
  classifyProviderFailure,
  createLifecycleProviderBudget,
  lifecycleSerializationContract,
} from "./lifecycle-record-budget.mjs";

test("enforces separate normal and recovery hard ceilings", () => {
  for (const [mode, limit] of [
    ["normal", 136],
    ["recovery", 150],
  ]) {
    const budget = createLifecycleProviderBudget(mode);
    budget.consume(limit);
    assert.equal(budget.used, limit);
    assert.equal(budget.remaining, 0);
    assert.throws(() => budget.consume(), {
      code: "provider-rate-limited",
    });
  }
});

test("rejects invalid budget inputs", () => {
  assert.throws(() => createLifecycleProviderBudget("other"), /unknown/iu);
  const budget = createLifecycleProviderBudget();
  for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => budget.consume(count), /positive safe integer/iu);
  }
});

test("classifies provider failures without preserving provider payloads", () => {
  assert.equal(
    classifyProviderFailure({ status: 429 }),
    "provider-rate-limited",
  );
  assert.equal(
    classifyProviderFailure({ rateLimited: true }),
    "provider-rate-limited",
  );
  assert.equal(
    classifyProviderFailure({ statusCode: 409 }),
    "provider-conflict",
  );
  for (const status of [403, 404, 422]) {
    assert.equal(classifyProviderFailure({ status }), "provider-rejected");
  }
  assert.equal(
    classifyProviderFailure({ name: "AbortError" }),
    "provider-timeout",
  );
  assert.equal(
    classifyProviderFailure({ code: "ETIMEDOUT" }),
    "provider-timeout",
  );
  assert.equal(
    classifyProviderFailure(new Error("secret")),
    "provider-unavailable",
  );
});

test("counts every provider call and returns only closed failures", async () => {
  const budget = createLifecycleProviderBudget();
  assert.equal(await callLifecycleProvider(budget, async () => 42), 42);
  await assert.rejects(
    callLifecycleProvider(budget, async () => {
      throw Object.assign(new Error("raw response"), { status: 429 });
    }),
    (error) =>
      error instanceof LifecycleProviderError &&
      error.message === "provider-rate-limited" &&
      !error.message.includes("raw response"),
  );
  assert.equal(budget.used, 2);
});

test("fixes per-issue then repository provider serialization", () => {
  assert.deepEqual(lifecycleSerializationContract(51), {
    acquisitionOrder: ["issue-lifecycle-51", "issue-lifecycle-provider-budget"],
    cancelInProgress: false,
    queue: "max",
  });
  assert.throws(() => lifecycleSerializationContract(0), /positive/iu);
});
