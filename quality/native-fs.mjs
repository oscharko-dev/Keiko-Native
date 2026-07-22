import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";

export const NATIVE_FS_SOURCES = [
  "quality/native-fs-main.c",
  "quality/native-fs-helper.c",
  "quality/native-fs-tree.c",
  "quality/native-fs-bound.c",
  "quality/native-fs-path.c",
  "quality/native-fs-stage.c",
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
      .map(({ path, sha256 }) => [path, { sha256 }]),
  );
  if (
    expected.size !== NATIVE_FS_SOURCES.length ||
    NATIVE_FS_SOURCES.some((path) => !expected.has(path))
  ) {
    throw new Error("Native filesystem helper rejected source-set");
  }
  const buildRoot = mkdtempSync(join(dirname(outputPath), ".native-fs-build-"));
  const temporary = join(buildRoot, "helper");
  let compiled;
  let sources = [];
  try {
    sources = bindSources(snapshotRoot, expected);
    const byPath = new Map(sources.map((entry) => [entry.path, entry]));
    const result = spawnSync(
      compiler,
      [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        `-DKEIKO_NATIVE_FS_HELPER_HEADER="${descriptorPath(byPath.get("quality/native-fs-helper.h").childFd)}"`,
        `-DKEIKO_NATIVE_FS_INTERNAL_HEADER="${descriptorPath(byPath.get("quality/native-fs-internal.h").childFd)}"`,
        "-x",
        "c",
        ...sources
          .filter(({ path }) => path.endsWith(".c"))
          .map(({ childFd }) => descriptorPath(childFd)),
        "-o",
        temporary,
      ],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe", ...sources.map(({ fd }) => fd)],
      },
    );
    verifyBoundSources(sources);
    if (result.status !== 0 || result.error)
      throw new Error("Native filesystem helper rejected compiler");
    const named = lstatSync(temporary, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink())
      throw new Error("Native filesystem helper rejected compiler-output");
    compiled = openSync(
      temporary,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    if (!sameIdentity(named, fstatSync(compiled, { bigint: true })))
      throw new Error("Native filesystem helper rejected compiler-output");
    fchmodSync(compiled, 0o700);
    if (
      !sameIdentity(
        fstatSync(compiled, { bigint: true }),
        lstatSync(temporary, { bigint: true }),
      )
    )
      throw new Error("Native filesystem helper rejected compiler-output");
    renameSync(temporary, outputPath);
    const metadata = fstatSync(compiled, { bigint: true });
    if (!sameIdentity(metadata, lstatSync(outputPath, { bigint: true })))
      throw new Error("Native filesystem helper rejected compiler-output");
    return createNativeFs(outputPath, {
      metadata,
      sha256: sha256(readDescriptor(compiled, metadata.size)),
    });
  } finally {
    if (compiled !== undefined) closeSync(compiled);
    for (const { fd } of sources) closeSync(fd);
    rmSync(buildRoot, { force: true, recursive: true });
  }
}

export function createNativeFs(helperPath, expected) {
  assertPrivateExecutableRoot(dirname(helperPath));
  const helperMetadata = lstatSync(helperPath, { bigint: true });
  if (!helperMetadata.isFile() || helperMetadata.isSymbolicLink())
    throw new Error("Native filesystem helper rejected executable");
  const initial = openSync(
    helperPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let helperDigest;
  try {
    if (!sameIdentity(helperMetadata, fstatSync(initial, { bigint: true })))
      throw new Error("Native filesystem helper rejected executable-changed");
    helperDigest = sha256(readDescriptor(initial, helperMetadata.size));
  } finally {
    closeSync(initial);
  }
  if (
    expected &&
    (!sameIdentity(expected.metadata, helperMetadata) ||
      expected.sha256 !== helperDigest)
  )
    throw new Error("Native filesystem helper rejected executable-changed");
  function invoke(
    operation,
    root,
    relativePath,
    { encoding, fds = [], input, rest = [], terminal = false } = {},
  ) {
    assertPrivateExecutableRoot(dirname(helperPath));
    const executable = openSync(
      helperPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = fstatSync(executable, { bigint: true });
      if (
        !sameIdentity(helperMetadata, before) ||
        !sameIdentity(before, lstatSync(helperPath, { bigint: true })) ||
        sha256(readDescriptor(executable, before.size)) !== helperDigest
      )
        throw new Error("Native filesystem helper rejected executable-changed");
      const result = spawnSync(
        helperPath,
        [operation, assertBoundRoot(root), relativePath, ...rest],
        {
          encoding,
          input,
          maxBuffer: 64 * 1024 * 1024,
          stdio: fds.length > 0 ? ["ignore", "pipe", "pipe", ...fds] : "pipe",
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
      if (
        (!terminal &&
          !sameIdentity(before, fstatSync(executable, { bigint: true }))) ||
        (!terminal &&
          (!sameIdentity(before, lstatSync(helperPath, { bigint: true })) ||
            sha256(readDescriptor(executable, before.size)) !== helperDigest))
      )
        throw new Error("Native filesystem helper rejected executable-changed");
      return result.stdout;
    } finally {
      closeSync(executable);
    }
  }
  return {
    chmod(root, path, mode) {
      invoke("chmod", root, path, { rest: [mode.toString(8)] });
    },
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
    publishBound(destinationRoot, destinationPath, entries) {
      const rest = [String(entries.length)];
      for (const entry of entries) {
        rest.push(
          entry.type,
          entry.mode,
          entry.path,
          [
            entry.metadata.dev,
            entry.metadata.ino,
            entry.metadata.mode,
            entry.metadata.size,
            entry.metadata.mtimeNs,
            entry.metadata.ctimeNs,
          ].join(":"),
        );
      }
      invoke("publish-bound", destinationRoot, destinationPath, {
        fds: entries.map(({ fd }) => fd),
        rest,
      });
    },
    remove(root, path) {
      invoke("remove", root, path);
    },
    destroy(root, path) {
      invoke("remove", root, path, { terminal: true });
    },
    read(root, path, encoding) {
      const value = invoke("read", root, path);
      return encoding ? value.toString(encoding) : value;
    },
    symlink(root, path, target) {
      invoke("symlink", root, path, { rest: [target] });
    },
    touch(root, path, sourceEpoch) {
      invoke("touch", root, path, { rest: [String(sourceEpoch)] });
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

function bindSources(snapshotRoot, expected) {
  const sources = [];
  try {
    for (const [index, path] of NATIVE_FS_SOURCES.entries()) {
      const absolute = join(snapshotRoot, path);
      const named = lstatSync(absolute, { bigint: true });
      const fd = openSync(
        absolute,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = fstatSync(fd, { bigint: true });
      sources.push({ absolute, before: opened, childFd: index + 3, fd, path });
      const bytes = readDescriptor(fd, opened.size);
      const record = expected.get(path);
      if (
        !named.isFile() ||
        named.isSymbolicLink() ||
        !sameIdentity(named, opened) ||
        sha256(bytes) !== record.sha256
      )
        throw new Error("Native filesystem helper rejected source-integrity");
    }
    return sources;
  } catch (error) {
    for (const { fd } of sources) closeSync(fd);
    throw error;
  }
}

function verifyBoundSources(sources) {
  for (const { absolute, before, fd } of sources)
    if (
      !sameIdentity(before, fstatSync(fd, { bigint: true })) ||
      !sameIdentity(before, lstatSync(absolute, { bigint: true }))
    )
      throw new Error("Native filesystem helper rejected source-integrity");
}

function readDescriptor(fd, size) {
  if (size < 0n || size > 1024n * 1024n)
    throw new Error("Native filesystem helper rejected source-integrity");
  const bytes = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0)
      throw new Error("Native filesystem helper rejected source-integrity");
    offset += count;
  }
  return bytes;
}

function descriptorPath(fd) {
  return `${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${fd}`;
}

const nativePath = { isAbsolute, join, parse, relative, sep };

function boundRootPaths(root, path = nativePath) {
  if (typeof root !== "string" || !path.isAbsolute(root))
    throw new Error("Native filesystem helper rejected root-not-absolute");
  const anchor = path.parse(root).root;
  let current = anchor;
  const paths = [anchor];
  for (const component of path
    .relative(anchor, root)
    .split(path.sep)
    .filter(Boolean)) {
    if (component === "." || component === "..")
      throw new Error("Native filesystem helper rejected root-component");
    current = path.join(current, component);
    paths.push(current);
  }
  return paths;
}

function assertBoundRoot(root) {
  for (const current of boundRootPaths(root)) {
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("Native filesystem helper rejected root-symlink");
  }
  return root;
}

function assertPrivateExecutableRoot(root) {
  assertBoundRoot(root);
  const metadata = lstatSync(root, { bigint: true });
  if (
    (metadata.mode & 0o777n) !== 0o700n ||
    (process.getuid && metadata.uid !== BigInt(process.getuid()))
  )
    throw new Error("Native filesystem helper rejected executable-root");
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

export const nativeFsTestSupport = { boundRootPaths, sha256 };
