import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isoFixture } from "./iso-normalization.test-fixture.mjs";
import {
  inventoryTree,
  mountedInventoryFailures,
  publishReleaseDirectory,
} from "./release-io.mjs";
import {
  buildReleaseBundle,
  verifyPublishedRelease,
  withMountedDiskImage,
} from "./release-system.mjs";
import { testFilesystem } from "./release-system.test-fixture.mjs";

const revision = "a".repeat(40);
const inputEvidence = {
  cargoLockSha256: "1".repeat(64),
  frontendLockSha256: "2".repeat(64),
  policySha256: "f".repeat(64),
  rootLockSha256: "4".repeat(64),
};
test("release inventory is sorted, digest-bound and rejects symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-release-inventory-"));
  try {
    await mkdir(join(root, "Contents/MacOS"), { recursive: true });
    await writeFile(join(root, "Contents/z.txt"), "z");
    await writeFile(join(root, "Contents/MacOS/app"), "binary", {
      mode: 0o755,
    });
    const inventory = await inventoryTree(root);
    const summarized = inventory.map(({ mode, path, size }) => ({
      mode,
      path,
      size,
    }));
    if (process.platform === "win32")
      assert.deepEqual(
        summarized.map(({ path, size }) => ({ path, size })),
        [
          { path: "Contents/MacOS/app", size: 6 },
          { path: "Contents/z.txt", size: 1 },
        ],
      );
    else
      assert.deepEqual(summarized, [
        { mode: "0755", path: "Contents/MacOS/app", size: 6 },
        { mode: "0644", path: "Contents/z.txt", size: 1 },
      ]);
    await symlink("z.txt", join(root, "Contents/link"));
    await assert.rejects(inventoryTree(root), /release-symlink-rejected/u);
    await rm(join(root, "Contents/link"));
    const external = join(root, "external");
    const raced = join(root, "Contents/z.txt");
    await writeFile(external, "external-secret");
    await assert.rejects(
      inventoryTree(join(root, "Contents"), {
        async beforeFinalIdentity(path) {
          if (path === raced) {
            await rm(path);
            await symlink(external, path);
          }
        },
      }),
      /release-file-drift/u,
    );
    await rm(raced);
    await writeFile(raced, "z");
    await assert.rejects(
      inventoryTree(join(root, "Contents"), {
        async beforeFinalIdentity(path) {
          if (path === raced) await rm(path);
        },
      }),
      /release-file-drift/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("mounted ISO projection retains exact content and required executable capability", () => {
  const expected = [
    {
      mode: "0644",
      path: "Contents/Info.plist",
      sha256: "a".repeat(64),
      size: 10,
    },
    {
      mode: "0755",
      path: "Contents/MacOS/keiko-native-desktop",
      sha256: "b".repeat(64),
      size: 20,
    },
  ];
  const projected = expected.map((entry) => ({ ...entry, mode: "0755" }));
  assert.deepEqual(mountedInventoryFailures(projected, expected), []);
  for (const mutation of [
    projected.slice(1),
    [{ ...projected[0], sha256: "c".repeat(64) }, projected[1]],
    [projected[0], { ...projected[1], mode: "0644" }],
    [{ ...projected[0], mode: "4755" }, projected[1]],
  ]) {
    assert.ok(mountedInventoryFailures(mutation, expected).length > 0);
  }
});

test("release publication restores the prior accepted bundle on rename failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-release-publish-"));
  const output = join(root, "keiko-native-internal-release");
  const staging = `${output}.staging`;
  try {
    await mkdir(output);
    await mkdir(staging);
    await writeFile(join(output, "accepted"), "prior");
    await writeFile(join(staging, "candidate"), "new");
    await assert.rejects(
      publishReleaseDirectory({
        outputRoot: output,
        staging,
        async renameEntry(source, destination) {
          if (source === staging) {
            const error = new Error("injected publish failure");
            error.code = "EIO";
            throw error;
          }
          await rename(source, destination);
        },
      }),
      /release-publish-failed/u,
    );
    assert.equal(await readFile(join(output, "accepted"), "utf8"), "prior");
    assert.equal((await lstat(output)).isDirectory(), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("release output is fixed beneath a non-symlinked repository native target", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-release-owned-"));
  const outside = await mkdtemp(join(tmpdir(), "keiko-release-outside-"));
  try {
    await mkdir(join(root, "native"));
    await symlink(outside, join(root, "native/target"));
    await assert.rejects(
      buildReleaseBundle({
        buildPackage: async () => assert.fail("package build reached"),
        dependencies: [],
        filesystem: testFilesystem,
        packageRoot: outside,
        repositoryRoot: root,
        revision,
        run: async () => assert.fail("host command reached"),
        sourceEpoch: 1_700_000_000,
      }),
      /release-owned-path-rejected/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("release build creates a missing owned target through its bound filesystem", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-release-clean-checkout-"));
  const workspaceRoot = join(root, "workspace");
  const mkdirCalls = [];
  const filesystem = {
    ...testFilesystem,
    mkdir(filesystemRoot, path) {
      mkdirCalls.push([filesystemRoot, path]);
      testFilesystem.mkdir(filesystemRoot, path);
    },
  };
  try {
    await mkdir(join(root, "native"));
    await mkdir(workspaceRoot);
    await assert.rejects(
      buildReleaseBundle({
        buildPackage: async () => {
          throw new Error("package-build-reached");
        },
        dependencies: [],
        filesystem,
        packageRoot: join(root, "package"),
        repositoryRoot: root,
        revision,
        run: async () => assert.fail("host command reached"),
        sourceEpoch: 1_700_000_000,
        workspaceRoot,
      }),
      /package-build-reached/u,
    );
    assert.deepEqual(
      mkdirCalls.filter(([filesystemRoot]) => filesystemRoot === root),
      [[root, "native/target"]],
    );
    assert.equal(
      (await lstat(join(root, "native/target"))).isDirectory(),
      true,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("mounted image is always detached and attachment failures are bounded", async () => {
  const events = [];
  const run = async (_command, args) => {
    events.push(args[0]);
  };
  const result = await withMountedDiskImage({
    action: async () => "verified",
    image: "image.dmg",
    mountPoint: "mount",
    run,
  });
  assert.equal(result, "verified");
  assert.deepEqual(events, ["attach", "detach"]);
  const detachAttempts = [];
  await assert.rejects(
    withMountedDiskImage({
      action: async () => {
        throw new Error("inspection-failed");
      },
      image: "image.dmg",
      mountPoint: "mount",
      run,
    }),
    /inspection-failed/u,
  );
  assert.deepEqual(events, ["attach", "detach", "attach", "detach"]);
  let simulatedMounted = false;
  let simulatedMountRemoved = false;
  await assert.rejects(
    withMountedDiskImage({
      action: async () => assert.fail("action ran after attach failure"),
      cleanupMountPoint: async () => {
        assert.equal(simulatedMounted, false);
        simulatedMountRemoved = true;
        events.push("remove-mount");
      },
      cleanupRun: async (_command, args) => {
        events.push(args[0]);
        simulatedMounted = false;
      },
      image: "image.dmg",
      mountPoint: "mount",
      run: async () => {
        simulatedMounted = true;
        throw new Error("attach-unavailable");
      },
    }),
    /attach-unavailable/u,
  );
  assert.deepEqual(events.slice(-2), ["detach", "remove-mount"]);
  assert.equal(simulatedMounted, false);
  assert.equal(simulatedMountRemoved, true);
  await assert.rejects(
    withMountedDiskImage({
      action: async () => {
        throw new Error("inspection-failed");
      },
      image: "image.dmg",
      mountPoint: "mount",
      run: async (_command, args) => {
        if (args[0] === "detach") {
          detachAttempts.push(args);
          throw new Error("detach-failed");
        }
      },
    }),
    /release-inspection-cleanup-failed/u,
  );
  assert.deepEqual(detachAttempts, [
    ["detach", "-quiet", "mount"],
    ["detach", "-quiet", "-force", "mount"],
  ]);
  const cancellationCleanup = [];
  await assert.rejects(
    withMountedDiskImage({
      action: async () => {
        throw new Error("release-cancelled");
      },
      cleanupRun: async (_command, args) => cancellationCleanup.push(args[0]),
      image: "image.dmg",
      mountPoint: "mount",
      run: async (_command, args) => {
        if (args[0] !== "attach") throw new Error("cancelled-run-reused");
      },
    }),
    /release-cancelled/u,
  );
  assert.deepEqual(cancellationCleanup, ["detach"]);
});

test("published verification removes scratch after a rejected bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-release-rejected-"));
  const outputRoot = join(root, "native/target/keiko-native-internal-release");
  const workspaceRoot = join(root, "workspace");
  const scratch = join(workspaceRoot, "scratch");
  try {
    await mkdir(join(root, "native/target"), { recursive: true });
    await mkdir(outputRoot, { recursive: true });
    await mkdir(workspaceRoot);
    await writeFile(join(outputRoot, "unexpected"), "rejected");
    await mkdir(scratch, { recursive: true });
    await assert.rejects(
      verifyPublishedRelease({
        directory: outputRoot,
        expectedRevision: revision,
        expectedSourceEpoch: 1_700_000_000,
        filesystem: testFilesystem,
        repositoryRoot: root,
        run: async () => {},
        workspaceRoot,
      }),
      /release-bundle-files-rejected/u,
    );
    await assert.rejects(readFile(scratch), /ENOENT/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test(
  "release build publishes a complete verified bundle atomically",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "keiko-release-build-"));
    const packageRoot = join(root, "package");
    const appRoot = join(packageRoot, "Keiko Native.app");
    const outputRoot = join(
      root,
      "native/target/keiko-native-internal-release",
    );
    const workspaceRoot = join(root, "workspace");
    const executable = Buffer.from("binary");
    const info = Buffer.from("plist");
    const strictFilesystem = {
      ...testFilesystem,
      remove(filesystemRoot, path) {
        if (path === "scratch/mount")
          assert.equal(existsSync(join(filesystemRoot, "scratch")), true);
        testFilesystem.remove(filesystemRoot, path);
      },
    };
    try {
      await mkdir(join(root, "native/target"), { recursive: true });
      await mkdir(workspaceRoot);
      await mkdir(join(appRoot, "Contents/MacOS"), { recursive: true });
      await writeFile(
        join(appRoot, "Contents/MacOS/keiko-native-desktop"),
        executable,
        { mode: 0o755 },
      );
      await writeFile(join(appRoot, "Contents/Info.plist"), info, {
        mode: 0o644,
      });
      await writeFile(
        join(packageRoot, "package-manifest.json"),
        `${JSON.stringify({
          schema: "keiko-native-package-manifest/v1",
          sourceRevision: revision,
          target: "keiko-native-desktop",
          platform: "macos-arm64",
          policySha256: "f".repeat(64),
          redaction: "closed",
          inventory: [
            {
              mode: "0644",
              path: "Contents/Info.plist",
              sha256: createHash("sha256").update(info).digest("hex"),
            },
            {
              mode: "0755",
              path: "Contents/MacOS/keiko-native-desktop",
              sha256: createHash("sha256").update(executable).digest("hex"),
            },
          ],
        })}\n`,
      );
      const run = async (_command, args) => {
        if (args[0] === "makehybrid") {
          const output = args[args.indexOf("-o") + 1];
          await writeFile(`${output}.iso`, isoFixture("2026071911252600"));
        } else if (args[0] === "attach") {
          const mount = args[args.indexOf("-mountpoint") + 1];
          await cp(appRoot, join(mount, "Keiko Native.app"), {
            recursive: true,
          });
          await chmod(
            join(mount, "Keiko Native.app/Contents/Info.plist"),
            0o555,
          );
          await chmod(
            join(mount, "Keiko Native.app/Contents/MacOS/keiko-native-desktop"),
            0o555,
          );
        }
      };
      let packageBuilds = 0;
      assert.equal(
        await buildReleaseBundle({
          buildPackage: async () => {
            packageBuilds += 1;
          },
          dependencies: [
            {
              license: "Apache-2.0",
              name: "keiko-application",
              version: "0.1.0",
            },
          ],
          inputEvidence,
          filesystem: strictFilesystem,
          packageRoot,
          repositoryRoot: root,
          revision,
          run,
          sourceEpoch: 1_700_000_000,
          workspaceRoot,
        }),
        outputRoot,
      );
      assert.equal(packageBuilds, 2);
      const receipt = JSON.parse(
        await readFile(join(outputRoot, "release-verification.json"), "utf8"),
      );
      assert.equal(receipt.redaction, "closed");
      assert.equal(receipt.sourceRevision, revision);
      await verifyPublishedRelease({
        directory: outputRoot,
        expectedRevision: revision,
        expectedSourceEpoch: 1_700_000_000,
        expectedDependencies: [
          {
            license: "Apache-2.0",
            name: "keiko-application",
            version: "0.1.0",
          },
        ],
        expectedInputEvidence: inputEvidence,
        filesystem: strictFilesystem,
        repositoryRoot: root,
        run,
        workspaceRoot,
      });
      const packageManifestPath = join(outputRoot, "package-manifest.json");
      const packageManifest = JSON.parse(
        await readFile(packageManifestPath, "utf8"),
      );
      await writeFile(
        packageManifestPath,
        JSON.stringify({ ...packageManifest, future: true }),
      );
      await assert.rejects(
        verifyPublishedRelease({
          directory: outputRoot,
          expectedRevision: revision,
          expectedSourceEpoch: 1_700_000_000,
          expectedDependencies: [
            {
              license: "Apache-2.0",
              name: "keiko-application",
              version: "0.1.0",
            },
          ],
          expectedInputEvidence: inputEvidence,
          filesystem: strictFilesystem,
          repositoryRoot: root,
          run,
          workspaceRoot,
        }),
        /release-package-manifest/u,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);
