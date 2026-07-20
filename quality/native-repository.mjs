const GENERATED_ROOTS = [
  "coverage/",
  "native/apps/keiko-desktop/gen/",
  "native/frontend/coverage/",
  "native/frontend/dist/",
  "native/frontend/node_modules/",
  "native/target/",
  "node_modules/",
];

export function worktreeStateFailures(encoded) {
  const failures = [];
  for (const record of encoded.split("\0").filter(Boolean)) {
    if (record.length < 4 || record[2] !== " ") {
      failures.push("worktree-status-malformed");
      continue;
    }
    const status = record.slice(0, 2);
    const path = record.slice(3).replaceAll("\\", "/");
    const governedOutput = GENERATED_ROOTS.some(
      (root) => path === root.slice(0, -1) || path.startsWith(root),
    );
    if (status !== "!!" || !governedOutput)
      failures.push(`worktree-drift:${status.trim() || "tracked"}`);
  }
  return failures;
}

export function createExactHeadGuard(readGit) {
  const expectedHead = readGit(["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/u.test(expectedHead))
    throw new Error("Exact-head repository rejected invalid-head");
  return {
    expectedHead,
    assertUnchanged(stage) {
      const currentHead = readGit(["rev-parse", "HEAD"]).trim();
      if (currentHead !== expectedHead)
        throw new Error(
          `Exact-head repository rejected head-changed at ${stage}`,
        );
      const failures = worktreeStateFailures(
        readGit([
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignored=matching",
        ]),
      );
      if (failures.length > 0)
        throw new Error(
          `Exact-head repository rejected ${[...new Set(failures)].slice(0, 8).join(",")} at ${stage}`,
        );
    },
  };
}
