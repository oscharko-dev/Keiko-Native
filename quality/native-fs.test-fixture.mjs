import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileNativeFsHelper,
  nativeFsTestSupport,
  NATIVE_FS_SOURCES,
} from "./native-fs.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export async function nativeFsFixture(callback) {
  const createdRoot = await mkdtemp(join(tmpdir(), "keiko-native-fs-"));
  const root = await realpath(createdRoot);
  try {
    const records = await copyNativeFsSources(root);
    const helper = join(root, "native-fs-helper");
    const fs = compileNativeFsHelper({
      expectedSources: records,
      outputPath: helper,
      snapshotRoot: root,
      tree: "a".repeat(40),
    });
    await callback({ fs, helper, root });
  } finally {
    await rm(createdRoot, { force: true, recursive: true });
  }
}

export function startNativeFsBarrier(helper, args, input) {
  const child = spawn(helper, args, {
    env: { ...process.env, KEIKO_FS_HELPER_TEST_BARRIER: "1" },
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  const ready = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdio[3].once("data", resolve);
  });
  return {
    ready,
    async release() {
      child.stdio[4].end("C");
      return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (status) => resolve({ status }));
      });
    },
  };
}

export async function copyNativeFsSources(root) {
  const records = [];
  for (const path of NATIVE_FS_SOURCES) {
    const bytes = await copySource(root, path);
    records.push({
      blob: nativeFsTestSupport.gitBlob(bytes),
      path,
      sha256: nativeFsTestSupport.sha256(bytes),
    });
  }
  return records;
}

async function copySource(root, path) {
  const source = join(repositoryRoot, path);
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
  return readFile(destination);
}
