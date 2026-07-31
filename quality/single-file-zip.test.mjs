import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { readSingleFileZip } from "./single-file-zip.mjs";

function singleFileZip({
  centralName = "artifact-anchor.bin",
  centralDirectoryDisk = 0,
  contents = Buffer.from("canonical anchor"),
  declaredCentralSize,
  declaredCompressedSize,
  diskNumber = 0,
  endComment = Buffer.alloc(0),
  entryCount = 1,
  localName = centralName,
  localSignature = 0x04034b50,
  method = 0,
  trailing = Buffer.alloc(0),
} = {}) {
  const compressed = method === 8 ? deflateRawSync(contents) : contents;
  const compressedSize = declaredCompressedSize ?? compressed.length;
  const localFilename = Buffer.from(localName, "utf8");
  const local = Buffer.alloc(30 + localFilename.length + compressed.length);
  local.writeUInt32LE(localSignature, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(compressedSize, 18);
  local.writeUInt16LE(contents.length, 22);
  local.writeUInt16LE(localFilename.length, 26);
  localFilename.copy(local, 30);
  compressed.copy(local, 30 + localFilename.length);

  const centralFilename = Buffer.from(centralName, "utf8");
  const central = Buffer.alloc(46 + centralFilename.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(compressedSize, 20);
  central.writeUInt16LE(contents.length, 24);
  central.writeUInt16LE(centralFilename.length, 28);
  centralFilename.copy(central, 46);

  const end = Buffer.alloc(22 + endComment.length);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(diskNumber, 4);
  end.writeUInt16LE(centralDirectoryDisk, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(declaredCentralSize ?? central.length, 12);
  end.writeUInt32LE(local.length, 16);
  end.writeUInt16LE(endComment.length, 20);
  endComment.copy(end, 22);
  return Buffer.concat([local, central, end, trailing]);
}

function multipleEndZip() {
  const base = singleFileZip();
  const outerEnd = base.length - 22;
  const centralOffset = base.readUInt32LE(outerEnd + 16);
  const central = base.subarray(centralOffset, outerEnd);
  const archive = singleFileZip({
    endComment: Buffer.alloc(central.length + 22),
  });
  const commentStart = outerEnd + 22;
  central.copy(archive, commentStart);
  const innerEnd = commentStart + central.length;
  archive.writeUInt32LE(0x06054b50, innerEnd);
  archive.writeUInt16LE(1, innerEnd + 8);
  archive.writeUInt16LE(1, innerEnd + 10);
  archive.writeUInt32LE(central.length, innerEnd + 12);
  archive.writeUInt32LE(commentStart, innerEnd + 16);
  return archive;
}

test("reads exact stored and deflated single-file archives", () => {
  const contents = Buffer.from("canonical anchor");
  for (const method of [0, 8])
    assert.deepEqual(
      readSingleFileZip(singleFileZip({ contents, method }), {
        expectedName: "artifact-anchor.bin",
      }),
      contents,
    );
  assert.deepEqual(
    readSingleFileZip(
      singleFileZip({ contents, endComment: Buffer.from("declared") }),
      { expectedName: "artifact-anchor.bin" },
    ),
    contents,
  );
});

test("ignores EOCD signature lookalikes inside a bounded declared comment", () => {
  const contents = Buffer.from("canonical anchor");
  const endComment = Buffer.alloc(40, 0x61);
  endComment.writeUInt32LE(0x06054b50, 0);
  assert.deepEqual(
    readSingleFileZip(singleFileZip({ contents, endComment }), {
      expectedName: "artifact-anchor.bin",
    }),
    contents,
  );
});

test("ignores terminal-looking comment records with invalid disk or central-directory fields", () => {
  const contents = Buffer.from("canonical anchor");
  for (const invalidFake of [{ diskNumber: 1 }, { declaredCentralSize: 0 }]) {
    const endComment = Buffer.alloc(44);
    endComment.writeUInt32LE(0x06054b50, 0);
    endComment.writeUInt16LE(invalidFake.diskNumber ?? 0, 4);
    endComment.writeUInt16LE(0, 6);
    endComment.writeUInt16LE(1, 8);
    endComment.writeUInt16LE(1, 10);
    endComment.writeUInt32LE(invalidFake.declaredCentralSize ?? 1, 12);
    endComment.writeUInt16LE(endComment.length - 22, 20);
    assert.deepEqual(
      readSingleFileZip(singleFileZip({ contents, endComment }), {
        expectedName: "artifact-anchor.bin",
      }),
      contents,
    );
  }
});

test("rejects zero structurally valid EOCD candidates", () => {
  const withoutEnd = singleFileZip();
  withoutEnd.writeUInt32LE(0, withoutEnd.length - 22);
  assert.throws(
    () =>
      readSingleFileZip(withoutEnd, {
        expectedName: "artifact-anchor.bin",
      }),
    /zip-archive-cardinality/u,
  );
});

test("rejects real multi-disk and wrong-size EOCD records", () => {
  for (const options of [
    { diskNumber: 1 },
    { centralDirectoryDisk: 1 },
    { declaredCentralSize: 1 },
  ])
    assert.throws(
      () =>
        readSingleFileZip(singleFileZip(options), {
          expectedName: "artifact-anchor.bin",
        }),
      /zip-archive-cardinality/u,
    );
});

test("rejects multiple structurally valid EOCD candidates", () => {
  assert.throws(
    () =>
      readSingleFileZip(multipleEndZip(), {
        expectedName: "artifact-anchor.bin",
      }),
    /zip-archive-cardinality/u,
  );
});

test("rejects a local-header filename that disagrees with the central filename", () => {
  const archive = singleFileZip({ localName: "untrusted-anchor.bin" });
  assert.throws(
    () =>
      readSingleFileZip(archive, {
        expectedName: "artifact-anchor.bin",
      }),
    /zip-entry-invalid/u,
  );
});

test("rejects trailing bytes after a zero-comment end-of-central-directory record", () => {
  const archive = singleFileZip({
    trailing: Buffer.from("untrusted trailing bytes"),
  });
  assert.throws(
    () =>
      readSingleFileZip(archive, {
        expectedName: "artifact-anchor.bin",
      }),
    /zip-archive-invalid/u,
  );
});

test("preserves archive, file, and cardinality bounds", () => {
  const archive = singleFileZip();
  assert.throws(
    () =>
      readSingleFileZip("not bytes", {
        expectedName: "artifact-anchor.bin",
      }),
    /zip-archive-invalid/u,
  );
  assert.throws(
    () =>
      readSingleFileZip(archive, {
        expectedName: "artifact-anchor.bin",
        maximumArchiveBytes: archive.length - 1,
      }),
    /zip-archive-invalid/u,
  );
  assert.throws(
    () =>
      readSingleFileZip(archive, {
        expectedName: "artifact-anchor.bin",
        maximumFileBytes: 1,
      }),
    /zip-entry-invalid/u,
  );
  assert.throws(
    () =>
      readSingleFileZip(singleFileZip({ contents: Buffer.alloc(0) }), {
        expectedName: "artifact-anchor.bin",
      }),
    /zip-entry-invalid/u,
  );
  assert.throws(
    () =>
      readSingleFileZip(singleFileZip({ entryCount: 2 }), {
        expectedName: "artifact-anchor.bin",
      }),
    /zip-archive-cardinality/u,
  );
});

test("preserves wrong-name, unsupported-compression, malformed, and truncated failures", () => {
  assert.throws(
    () =>
      readSingleFileZip(singleFileZip(), {
        expectedName: "wrong.bin",
      }),
    /zip-entry-invalid/u,
  );
  assert.throws(
    () =>
      readSingleFileZip(singleFileZip({ method: 12 }), {
        expectedName: "artifact-anchor.bin",
      }),
    /zip-compression-unsupported/u,
  );
  assert.throws(
    () =>
      readSingleFileZip(singleFileZip({ localSignature: 0 }), {
        expectedName: "artifact-anchor.bin",
      }),
    /zip-entry-invalid/u,
  );
  assert.throws(
    () =>
      readSingleFileZip(singleFileZip({ declaredCompressedSize: 65_535 }), {
        expectedName: "artifact-anchor.bin",
      }),
    /zip-entry-truncated/u,
  );
});
