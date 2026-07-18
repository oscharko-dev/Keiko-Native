import assert from "node:assert/strict";
import test from "node:test";

import {
  inheritedWorkflowControlFailures,
  protectedStepControlFailures,
} from "./workflow-structure.mjs";

test("protected steps accept only literal allowlisted environment maps", () => {
  const allowed = [
    [
      "      - run: npm run acceptance:macos",
      "        env:",
      '          KEIKO_NATIVE_REQUIRE_MACOS: "1"',
    ].join("\n"),
    [
      '      - env: { KEIKO_NATIVE_REQUIRE_MACOS: "1" }',
      "        run: npm run acceptance:macos",
    ].join("\n"),
  ];
  for (const step of allowed) {
    assert.deepEqual(protectedStepControlFailures(step), []);
  }

  const rejected = [
    "      - env: *shared\n        run: npm run acceptance:macos",
    "      - env: &shared\n        run: npm run acceptance:macos",
    "      - env: !shared\n        run: npm run acceptance:macos",
    "      - env: { UNAPPROVED: value }\n        run: npm run acceptance:macos",
    [
      "      - run: npm run acceptance:macos",
      "        env:",
      "          KEIKO_NATIVE_REQUIRE_MACOS:",
      "            nested: value",
    ].join("\n"),
  ];
  for (const step of rejected) {
    assert.ok(protectedStepControlFailures(step).includes("environment"));
  }
});

test("workflow and job environment declarations are always inherited controls", () => {
  assert.deepEqual(
    inheritedWorkflowControlFailures(
      "env: *shared\njobs:\n  test:\n    steps: []",
    ),
    ["workflow-environment"],
  );
  assert.deepEqual(
    inheritedWorkflowControlFailures(
      "jobs:\n  test:\n    env: *shared\n    steps: []",
    ),
    ["workflow-job-environment"],
  );
});
