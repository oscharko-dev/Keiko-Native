import assert from "node:assert/strict";
import test from "node:test";

import { parseReleaseJson } from "./release-io.mjs";
import { diskImageCommand } from "./release-system.mjs";

test("disk image command selects deterministic ISO and Joliet inputs", () => {
  assert.deepEqual(diskImageCommand("source", "candidate"), [
    "makehybrid",
    "-quiet",
    "-iso",
    "-joliet",
    "-iso-volume-name",
    "KEIKO_INTERNAL",
    "-joliet-volume-name",
    "Keiko Native Internal",
    "-o",
    "candidate",
    "source",
  ]);
});

test("release JSON is bounded, fatal UTF-8, and duplicate-closed at every depth", () => {
  assert.deepEqual(parseReleaseJson(Buffer.from('{"nested":{"value":1}}')), {
    nested: { value: 1 },
  });
  for (const [bytes, expected] of [
    [
      Buffer.from('{"nested":{"value":1,"value":2}}'),
      /release-json-duplicate/u,
    ],
    [Buffer.from([0xc3, 0x28]), /release-json-encoding/u],
    [Buffer.alloc(4 * 1024 * 1024 + 1), /release-json-size/u],
    [
      Buffer.from(`${'{"value":'.repeat(5_000)}0${"}".repeat(5_000)}`),
      /release-json-depth-rejected/u,
    ],
  ])
    assert.throws(() => parseReleaseJson(bytes), expected);
});
