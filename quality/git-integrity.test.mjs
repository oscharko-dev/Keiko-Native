import assert from "node:assert/strict";
import test from "node:test";

import {
  hardenedGitArguments,
  noReplaceGitEnvironment,
} from "./git-integrity.mjs";

test("Git reads explicitly disable replacement objects", () => {
  assert.deepEqual(hardenedGitArguments(["show", "HEAD:input"]), [
    "--no-replace-objects",
    "show",
    "HEAD:input",
  ]);
  assert.deepEqual(
    hardenedGitArguments(["--no-replace-objects", "rev-parse", "HEAD"]),
    ["--no-replace-objects", "rev-parse", "HEAD"],
  );
  assert.throws(() => hardenedGitArguments(undefined), /git-integrity/u);
});

test("nested release and packaging commands inherit replacement-object denial", () => {
  const original = { GIT_NO_REPLACE_OBJECTS: "0", OWNED: "value" };
  const hardened = noReplaceGitEnvironment(original);
  assert.deepEqual(hardened, {
    GIT_NO_REPLACE_OBJECTS: "1",
    OWNED: "value",
  });
  assert.deepEqual(original, {
    GIT_NO_REPLACE_OBJECTS: "0",
    OWNED: "value",
  });
});
