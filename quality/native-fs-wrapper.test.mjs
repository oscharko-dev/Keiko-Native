import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createNativeFs } from "./native-fs.mjs";

const supported = process.platform === "darwin" || process.platform === "linux";

test(
  "native helper wrapper rejects malformed output and executable replacement",
  {
    skip: !supported,
  },
  async () => {
    const createdRoot = await mkdtemp(
      join(tmpdir(), "keiko-native-fs-wrapper-"),
    );
    const root = await realpath(createdRoot);
    try {
      const malformed = join(root, "malformed");
      await writeFile(malformed, "#!/bin/sh\nprintf 'invalid-inventory\\n'\n", {
        mode: 0o700,
      });
      assert.throws(() => createNativeFs(malformed).list(root), /inventory/u);
      const failing = join(root, "failing");
      await writeFile(failing, "#!/bin/sh\nprintf 'other' >&2\nexit 1\n", {
        mode: 0o700,
      });
      assert.throws(
        () => createNativeFs(failing).read(root, "value"),
        /execution/u,
      );
      const replacing = join(root, "replacing");
      await writeFile(
        replacing,
        `#!/bin/sh\nmv '${replacing}.next' '${replacing}'\nprintf ''\n`,
        { mode: 0o700 },
      );
      await writeFile(`${replacing}.next`, "#!/bin/sh\nprintf ''\n", {
        mode: 0o700,
      });
      assert.throws(
        () => createNativeFs(replacing).list(root),
        /executable-changed/u,
      );
      await symlink(malformed, join(root, "helper-link"));
      assert.throws(
        () => createNativeFs(join(root, "helper-link")),
        /executable/u,
      );
      assert.throws(
        () => createNativeFs(malformed).read("relative", "value"),
        /root-not-absolute/u,
      );
    } finally {
      await rm(createdRoot, { force: true, recursive: true });
    }
  },
);
