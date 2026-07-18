import assert from "node:assert/strict";
import test from "node:test";

import { createNativePackageIo } from "./native-package-io.mjs";
import { nativeSnapshotRuntimeTestSupport } from "./native-snapshot-runtime.mjs";

test("package I/O uses the ordinary inventory outside an exact snapshot", () => {
  const previousManifest = process.env.KEIKO_NATIVE_SNAPSHOT_MANIFEST;
  try {
    delete process.env.KEIKO_NATIVE_SNAPSHOT_MANIFEST;
    const filesBelow = () => [];
    assert.deepEqual(
      createNativePackageIo({ fallbackFilesBelow: filesBelow }),
      { filesBelow },
    );
  } finally {
    restore("KEIKO_NATIVE_SNAPSHOT_MANIFEST", previousManifest);
  }
});

test("package I/O fails closed when snapshot helper operations are unavailable", async () => {
  const previousHelper = process.env.KEIKO_NATIVE_FS_HELPER;
  const previousManifest = process.env.KEIKO_NATIVE_SNAPSHOT_MANIFEST;
  try {
    delete process.env.KEIKO_NATIVE_FS_HELPER;
    process.env.KEIKO_NATIVE_SNAPSHOT_MANIFEST = "fixture";
    nativeSnapshotRuntimeTestSupport.reset();
    let io = createNativePackageIo({
      fallbackFilesBelow: () => [],
      packageRoot: "/private/tmp/package",
    });
    assert.throws(
      () => io.captureOutputTree("source", "destination", "delivery"),
      /output-copy/u,
    );
    await assert.rejects(io.filesBelow("source"), /output-inventory/u);
    assert.throws(() => io.preparePackageRoot(), /package-root/u);
    assert.throws(
      () => io.writeOutputFile("manifest.json", "value"),
      /output-write/u,
    );
    io = createNativePackageIo({
      fallbackFilesBelow: () => [],
      outputRoot: "/private/tmp",
      packageRoot: "/private/tmp/package",
    });
    assert.throws(() => io.preparePackageRoot(), /package-root/u);
  } finally {
    restore("KEIKO_NATIVE_FS_HELPER", previousHelper);
    restore("KEIKO_NATIVE_SNAPSHOT_MANIFEST", previousManifest);
    nativeSnapshotRuntimeTestSupport.reset();
  }
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
