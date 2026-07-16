import assert from "node:assert/strict";
import test from "node:test";

import {
  fieldValue,
  hasAnglePlaceholder,
  hasInlineOptionList,
  logicalListItems,
  markdownHeading,
  markdownLines,
  splitFencedMarkdown,
} from "./markdown-contract.mjs";

test("normalizes contract lines, headings, fields, and wrapped list items", () => {
  assert.deepEqual(markdownLines("one\r\ntwo"), ["one", "two"]);
  assert.deepEqual(markdownLines(undefined), []);
  assert.equal(markdownHeading("##  Scope  "), "Scope");
  assert.equal(markdownHeading("##Scope"), undefined);
  assert.equal(fieldValue("- Scope:\n- Owner: Team", "Scope"), undefined);
  assert.equal(fieldValue("- Owner: Team", "Owner"), "Team");
  assert.deepEqual(
    logicalListItems("- Owner: Team\n  and reviewer\n- [x] Done\nprose"),
    ["Owner: Team and reviewer"],
  );
});

test("separates closed fences but preserves an unclosed fence as prose", () => {
  assert.deepEqual(
    splitFencedMarkdown("before\n```text\ncommand\n```\nafter"),
    {
      blocks: ["command"],
      prose: "before\nafter",
    },
  );
  assert.deepEqual(splitFencedMarkdown("before\n```text\n<placeholder>"), {
    blocks: [],
    prose: "before\n```text\n<placeholder>",
  });
  assert.deepEqual(splitFencedMarkdown("before\n```json\n{}\n```\nafter"), {
    blocks: [],
    prose: "before\nafter",
  });
});

test("detects placeholders only in complete inline constructs", () => {
  assert.equal(hasAnglePlaceholder("Use <value> here"), true);
  assert.equal(hasAnglePlaceholder("Use <value\non another line>"), false);
  assert.equal(hasInlineOptionList("Choose `one | two`"), true);
  assert.equal(hasInlineOptionList("An unmatched `one | two"), false);
});
