import { mkdirSync, mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { hardenedGitArguments } from "./git-integrity.mjs";

import {
  compileNativeFsHelper,
  nativeFsTestSupport,
  NATIVE_FS_SOURCES,
} from "./native-fs.mjs";

export async function createReleaseNativeFilesystem(
  repositoryRoot,
  runCommand,
  { revision, temporaryBase = tmpdir() } = {},
) {
  if (!/^[0-9a-f]{40}$/u.test(revision))
    throw new Error("release-filesystem-revision");
  const canonicalTemporaryBase = realpathSync(temporaryBase);
  const temporaryRoot = mkdtempSync(
    join(canonicalTemporaryBase, "keiko-release-fs-"),
  );
  let filesystem;
  try {
    const tree = await runCommand(
      "git",
      hardenedGitArguments(["rev-parse", `${revision}^{tree}`]),
      { capture: true },
    );
    const expectedSources = await Promise.all(
      NATIVE_FS_SOURCES.map(async (path) => {
        const record = await runCommand(
          "git",
          hardenedGitArguments(["ls-tree", revision, "--", path]),
          {
            capture: true,
          },
        );
        const match = /^(?:100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(
          record,
        );
        const bytes = await runCommand(
          "git",
          hardenedGitArguments(["show", `${revision}:${path}`]),
          {
            binary: true,
            capture: true,
          },
        );
        if (match?.[2] !== path) throw new Error("release-filesystem-source");
        return {
          blob: match[1],
          path,
          sha256: nativeFsTestSupport.sha256(bytes),
        };
      }),
    );
    filesystem = compileNativeFsHelper({
      expectedSources,
      outputPath: join(temporaryRoot, "native-fs-helper"),
      snapshotRoot: repositoryRoot,
      tree,
    });
    const workspaceRoot = join(temporaryRoot, "workspace");
    mkdirSync(workspaceRoot, { mode: 0o700 });
    return {
      close() {
        filesystem.destroy(canonicalTemporaryBase, basename(temporaryRoot));
      },
      filesystem,
      workspaceRoot,
    };
  } catch (error) {
    if (filesystem)
      filesystem.destroy(canonicalTemporaryBase, basename(temporaryRoot));
    else {
      try {
        rmdirSync(temporaryRoot);
      } catch {
        // A failed compiler cleanup is retained rather than traversed by path.
      }
    }
    throw error;
  }
}
