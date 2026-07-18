import { join, relative } from "node:path";

import {
  copySnapshotOutputTree,
  inExactSnapshot,
  listSnapshotOutput,
  mkdirSnapshotOutput,
  writeSnapshotOutput,
} from "./native-snapshot-runtime.mjs";

export function createNativePackageIo({
  fallbackFilesBelow,
  outputRoot,
  packageRoot,
}) {
  if (!inExactSnapshot()) return { filesBelow: fallbackFilesBelow };
  return {
    captureOutputTree(source, destinationRoot, destinationPath) {
      if (
        !copySnapshotOutputTree(source, ".", destinationRoot, destinationPath)
      )
        throw rejected("output-copy");
    },
    async filesBelow(root) {
      const inventory = listSnapshotOutput(root);
      if (!inventory) throw rejected("output-inventory");
      return inventory
        .filter(({ type }) => type === "F")
        .map(({ path }) => join(root, ...path.split("/")));
    },
    fileMode(path, root) {
      const inventory = listSnapshotOutput(root);
      const entry = inventory?.find(
        (item) => item.path === relative(root, path).split("\\").join("/"),
      );
      if (entry?.type !== "F") throw rejected("output-mode");
      return entry.mode;
    },
    preparePackageRoot() {
      if (
        !outputRoot ||
        !mkdirSnapshotOutput(outputRoot, "keiko-native-package")
      )
        throw rejected("package-root");
    },
    writeOutputFile(path, bytes, mode) {
      if (
        !writeSnapshotOutput(
          packageRoot,
          relative(packageRoot, path).split("\\").join("/"),
          bytes,
          mode,
        )
      )
        throw rejected("output-write");
    },
  };
}

function rejected(category) {
  return new Error(`Immutable snapshot rejected ${category}`);
}
