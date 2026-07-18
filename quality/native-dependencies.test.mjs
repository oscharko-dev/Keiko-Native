import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { captureDependencySnapshot } from "./native-dependencies.mjs";

test("captures a deterministic exact npm-ci dependency inventory", async () => {
  const fixture = await dependencyFixture();
  try {
    const first = await capture(fixture.frontend, join(fixture.root, "first"));
    const second = await capture(
      fixture.frontend,
      join(fixture.root, "second"),
    );
    assert.equal(first.treeSha256, second.treeSha256);
    assert.equal(first.files.length, 3);
    assert.match(first.lockSha256, /^[0-9a-f]{64}$/u);
    assert.match(first.markerSha256, /^[0-9a-f]{64}$/u);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects dependency symlinks and special files", async () => {
  for (const category of ["symlink", "special"]) {
    const fixture = await dependencyFixture();
    try {
      const hostile = join(fixture.modules, "fixture/hostile");
      if (category === "symlink") await symlink("package.json", hostile);
      else {
        const result = spawnSync("mkfifo", [hostile]);
        assert.equal(result.status, 0);
      }
      await assert.rejects(
        capture(fixture.frontend, join(fixture.root, "snapshot")),
        new RegExp(
          category === "symlink" ? "symbolic-link" : "special-entry",
          "u",
        ),
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }
});

test("rejects lock, marker, identity, inventory, and top-level drift", async () => {
  const mutations = [
    async ({ frontend, lock }) => {
      lock.packages["node_modules/fixture"].version = "2.0.0";
      await writeJson(join(frontend, "package-lock.json"), lock);
    },
    async ({ marker, modules }) => {
      marker.packages["node_modules/fixture"].integrity = "sha512-hostile";
      await writeJson(join(modules, ".package-lock.json"), marker);
    },
    async ({ modules }) => {
      await writeJson(join(modules, "fixture/package.json"), {
        name: "hostile",
        version: "1.0.0",
      });
    },
    async ({ modules }) => {
      await writeFile(join(modules, "fixture/unowned.txt"), "still-owned");
      await mkdir(join(modules, "extra"));
      await writeJson(join(modules, "extra/package.json"), {
        name: "extra",
        version: "1.0.0",
      });
    },
    async ({ modules }) => writeFile(join(modules, "unexpected"), "hostile"),
  ];
  for (const mutate of mutations) {
    const fixture = await dependencyFixture();
    try {
      await mutate(fixture);
      await assert.rejects(
        capture(fixture.frontend, join(fixture.root, "snapshot")),
        /Immutable snapshot rejected|Native traversal rejected/u,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }
});

test("requires a valid npm-ci marker and launcher directory", async () => {
  for (const mutation of [
    async ({ modules }) => rm(join(modules, ".package-lock.json")),
    async ({ modules }) => writeFile(join(modules, ".package-lock.json"), "{"),
    async ({ modules }) => {
      await rm(join(modules, ".bin"), { recursive: true });
      await writeFile(join(modules, ".bin"), "hostile");
    },
  ]) {
    const fixture = await dependencyFixture();
    try {
      await mutation(fixture);
      await assert.rejects(
        capture(fixture.frontend, join(fixture.root, "snapshot")),
        /rejected/u,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }
});

async function dependencyFixture() {
  const root = await mkdtemp(join(tmpdir(), "keiko-dependencies-"));
  const frontend = join(root, "frontend");
  const modules = join(frontend, "node_modules");
  await mkdir(join(modules, ".bin"), { recursive: true });
  await mkdir(join(modules, "fixture"));
  const entry = {
    version: "1.0.0",
    resolved: "https://registry.invalid/fixture.tgz",
    integrity: "sha512-fixture",
  };
  const lock = {
    lockfileVersion: 3,
    packages: { "": { name: "frontend" }, "node_modules/fixture": entry },
  };
  const marker = {
    lockfileVersion: 3,
    packages: { "node_modules/fixture": entry },
  };
  await writeJson(join(frontend, "package-lock.json"), lock);
  await writeJson(join(modules, ".package-lock.json"), marker);
  await writeJson(join(modules, "fixture/package.json"), {
    name: "fixture",
    version: "1.0.0",
  });
  await writeFile(join(modules, "fixture/index.js"), "export default 1;\n");
  return { frontend, lock, marker, modules, root };
}

async function capture(frontendRoot, snapshotRoot) {
  await mkdir(snapshotRoot);
  return captureDependencySnapshot({
    frontendRoot,
    snapshotRoot,
    async writeFile(path, bytes) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
  });
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
