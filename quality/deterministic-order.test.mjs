import assert from "node:assert/strict";
import test from "node:test";

import { compareCodeUnits } from "./deterministic-order.mjs";

test("orders text by stable ECMAScript code units", () => {
  const values = ["z", "ä", "a", "Z", "a", "😀", "é"];
  assert.deepEqual(values.toSorted(compareCodeUnits), [
    "Z",
    "a",
    "a",
    "z",
    "ä",
    "é",
    "😀",
  ]);
});

test("returns the exact comparator boundary values", () => {
  assert.equal(compareCodeUnits("same", "same"), 0);
  assert.equal(compareCodeUnits("a", "b"), -1);
  assert.equal(compareCodeUnits("b", "a"), 1);
});
