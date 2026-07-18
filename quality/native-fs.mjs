import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export const NATIVE_FS_SOURCES = [
  "quality/native-fs-main.c",
  "quality/native-fs-helper.c",
  "quality/native-fs-tree.c",
  "quality/native-fs-helper.h",
  "quality/native-fs-internal.h",
];

export function compileNativeFsHelper({
  compiler = "/usr/bin/cc",
  expectedSources,
  outputPath,
  snapshotRoot,
  tree,
}) {
  assertBoundRoot(snapshotRoot);
  assertBoundRoot(dirname(outputPath));
  if (!/^[0-9a-f]{40}$/u.test(tree ?? ""))
    throw new Error("Native filesystem helper rejected snapshot-tree");
  const expected = new Map(
    (expectedSources ?? [])
      .filter((entry) => entry && typeof entry.path === "string")
      .map(({ blob, path, sha256 }) => [path, { blob, sha256 }]),
  );
  if (
    expected.size !== NATIVE_FS_SOURCES.length ||
    NATIVE_FS_SOURCES.some((path) => !expected.has(path))
  ) {
    throw new Error("Native filesystem helper rejected source-set");
  }
  assertSourceIntegrity(snapshotRoot, expected);
  const temporary = join(
    dirname(outputPath),
    `.${basename(outputPath)}-${process.pid}.building`,
  );
  rmSync(temporary, { force: true });
  try {
    const result = spawnSync(
      compiler,
      [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        ...NATIVE_FS_SOURCES.filter((path) => path.endsWith(".c")).map((path) =>
          join(snapshotRoot, path),
        ),
        "-o",
        temporary,
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024, stdio: "pipe" },
    );
    if (result.status !== 0 || result.error)
      throw new Error("Native filesystem helper rejected compiler");
    assertSourceIntegrity(snapshotRoot, expected);
    const metadata = lstatSync(temporary);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("Native filesystem helper rejected compiler-output");
    chmodSync(temporary, 0o700);
    renameSync(temporary, outputPath);
    return createNativeFs(outputPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function createNativeFs(helperPath) {
  assertBoundRoot(dirname(helperPath));
  const helperMetadata = lstatSync(helperPath, { bigint: true });
  if (!helperMetadata.isFile() || helperMetadata.isSymbolicLink())
    throw new Error("Native filesystem helper rejected executable");
  function invoke(
    operation,
    root,
    relativePath,
    { encoding, input, rest = [] } = {},
  ) {
    const before = lstatSync(helperPath, { bigint: true });
    if (!sameIdentity(helperMetadata, before))
      throw new Error("Native filesystem helper rejected executable-changed");
    const result = spawnSync(
      helperPath,
      [operation, assertBoundRoot(root), relativePath, ...rest],
      {
        encoding,
        input,
        maxBuffer: 64 * 1024 * 1024,
        stdio: "pipe",
      },
    );
    if (result.status !== 0 || result.error) {
      const category = /native-fs-helper:([a-z-]+)/u.exec(
        String(result.stderr ?? ""),
      )?.[1];
      throw new Error(
        `Native filesystem helper rejected ${category ?? "execution"}`,
      );
    }
    if (!sameIdentity(helperMetadata, lstatSync(helperPath, { bigint: true })))
      throw new Error("Native filesystem helper rejected executable-changed");
    return result.stdout;
  }
  return {
    copyTree(
      sourceRoot,
      sourcePath,
      destinationRoot,
      destinationPath,
      exclude,
    ) {
      invoke("copy-tree", sourceRoot, sourcePath, {
        rest: [
          assertBoundRoot(destinationRoot),
          destinationPath,
          ...(exclude ? [exclude] : []),
        ],
      });
    },
    list(root, path = ".", exclude) {
      return String(
        invoke("list", root, path, {
          encoding: "utf8",
          rest: exclude ? [exclude] : [],
        }),
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const match = /^(D|F)\t(0[0-7]{3})\t(.+)$/u.exec(line);
          if (!match)
            throw new Error("Native filesystem helper rejected inventory");
          return { mode: match[2], path: match[3], type: match[1] };
        })
        .toSorted((left, right) => left.path.localeCompare(right.path));
    },
    mkdir(root, path) {
      invoke("mkdir", root, path);
    },
    publish(sourceRoot, sourcePath, destinationRoot, destinationPath) {
      invoke("publish", sourceRoot, sourcePath, {
        rest: [assertBoundRoot(destinationRoot), destinationPath],
      });
    },
    read(root, path, encoding) {
      const value = invoke("read", root, path);
      return encoding ? value.toString(encoding) : value;
    },
    symlink(root, path, target) {
      invoke("symlink", root, path, { rest: [target] });
    },
    write(root, path, bytes, mode = 0o600) {
      invoke("write", root, path, {
        input: bytes,
        rest: [mode.toString(8)],
      });
    },
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlob(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function assertSourceIntegrity(snapshotRoot, expected) {
  for (const path of NATIVE_FS_SOURCES) {
    const bytes = readFileSync(join(snapshotRoot, path));
    const record = expected.get(path);
    if (
      sha256(bytes) !== record.sha256 ||
      gitBlob(bytes) !== record.blob ||
      !lstatSync(join(snapshotRoot, path)).isFile()
    ) {
      throw new Error("Native filesystem helper rejected source-integrity");
    }
  }
}

function assertBoundRoot(root) {
  if (!isAbsolute(root))
    throw new Error("Native filesystem helper rejected root-not-absolute");
  let current = "/";
  for (const component of root.split("/").filter(Boolean)) {
    if (component === "." || component === "..")
      throw new Error("Native filesystem helper rejected root-component");
    current = join(current, component);
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("Native filesystem helper rejected root-symlink");
  }
  return root;
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export const nativeFsTestSupport = { gitBlob, sha256 };
