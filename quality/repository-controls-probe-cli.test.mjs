import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { main } from "./repository-controls-probe.mjs";

test("CLI input is bounded, fatal UTF-8, and duplicate-key closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-controls-evidence-"));
  try {
    for (const [name, bytes] of [
      ["invalid-utf8.json", Buffer.from([0xc3, 0x28])],
      ["duplicate.json", Buffer.from('{"schema":"one","schema":"two"}')],
      ["oversized.json", Buffer.alloc(1024 * 1024 + 1, 0x20)],
    ]) {
      const path = join(root, name);
      await writeFile(path, bytes);
      await assert.rejects(
        main([path], () => assert.fail("invalid evidence emitted output")),
      );
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
