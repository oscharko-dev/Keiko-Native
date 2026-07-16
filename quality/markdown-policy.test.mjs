import assert from "node:assert/strict";
import test from "node:test";

import { markdownFailures } from "./markdown-policy.mjs";

const config = { allowedHtmlElements: ["div"], lineLength: 20 };

test("accepts governed Markdown and ignores code and table widths", () => {
  const content = [
    "# Title",
    "",
    "<div>safe</div>",
    "",
    "| a very long table cell |",
    "",
    "```text",
    "a very long code line that is intentionally exempt",
    "```",
  ].join("\n");
  assert.deepEqual(markdownFailures(content, config), []);
});

test("ignores inline code spans for HTML and line-length policy", () => {
  assert.deepEqual(
    markdownFailures("Use `<script>` and `List<String>`.", config),
    [],
  );
  assert.deepEqual(
    markdownFailures("Use ``code with ` tick`` safely.", config),
    [],
  );
});

test("rejects structural and formatting drift", () => {
  const content = [
    "# Title ",
    "### Skipped",
    "text\twith tab",
    "a line that is definitely too long",
    "<script>alert(1)</script>",
    "```text",
  ].join("\n");
  assert.deepEqual(markdownFailures(content, config), [
    "1: trailing whitespace",
    "2: heading level skipped",
    "3: tab character",
    "4: line exceeds 20 characters",
    "5: line exceeds 20 characters",
    "5: disallowed HTML element script",
    "unclosed fenced code block",
  ]);
});
