import { inflateRawSync } from "node:zlib";

export class SingleFileZipError extends Error {
  constructor(code) {
    super(code);
    this.name = "SingleFileZipError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new SingleFileZipError(code);
};

function inspectEndRecord(bytes, end) {
  if (
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 8) !== 1 ||
    bytes.readUInt16LE(end + 10) !== 1
  )
    return null;
  if (end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)
    return { unterminated: true };
  const centralSize = bytes.readUInt32LE(end + 12);
  const central = bytes.readUInt32LE(end + 16);
  if (
    centralSize < 46 ||
    central + centralSize !== end ||
    central + 46 > end ||
    bytes.readUInt32LE(central) !== 0x02014b50
  )
    return null;
  const centralEntrySize =
    46 +
    bytes.readUInt16LE(central + 28) +
    bytes.readUInt16LE(central + 30) +
    bytes.readUInt16LE(central + 32);
  return centralEntrySize === centralSize ? { central, end } : null;
}

export function readSingleFileZip(
  bytes,
  { expectedName, maximumArchiveBytes = 65_536, maximumFileBytes = 8_192 },
) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 22 ||
    bytes.length > maximumArchiveBytes
  )
    fail("zip-archive-invalid");
  const ends = [];
  let unterminated = false;
  for (
    let index = bytes.length - 22;
    index >= Math.max(0, bytes.length - 65_557);
    index -= 1
  ) {
    const candidate = inspectEndRecord(bytes, index);
    if (candidate?.unterminated === true) unterminated = true;
    else if (candidate !== null) ends.push(candidate);
  }
  if (ends.length === 0 && unterminated) fail("zip-archive-invalid");
  if (ends.length !== 1) fail("zip-archive-cardinality");
  const { central } = ends[0];
  const method = bytes.readUInt16LE(central + 10);
  const compressedSize = bytes.readUInt32LE(central + 20);
  const uncompressedSize = bytes.readUInt32LE(central + 24);
  const nameLength = bytes.readUInt16LE(central + 28);
  const extraLength = bytes.readUInt16LE(central + 30);
  const commentLength = bytes.readUInt16LE(central + 32);
  const local = bytes.readUInt32LE(central + 42);
  const nameEnd = central + 46 + nameLength;
  const centralName = bytes.subarray(central + 46, nameEnd);
  const name = centralName.toString("utf8");
  if (
    name !== expectedName ||
    extraLength > 4096 ||
    commentLength !== 0 ||
    uncompressedSize === 0 ||
    uncompressedSize > maximumFileBytes ||
    local + 30 > bytes.length ||
    bytes.readUInt32LE(local) !== 0x04034b50
  )
    fail("zip-entry-invalid");
  const localNameLength = bytes.readUInt16LE(local + 26);
  const localExtraLength = bytes.readUInt16LE(local + 28);
  const localNameEnd = local + 30 + localNameLength;
  const localName = bytes.subarray(local + 30, localNameEnd);
  if (localNameEnd > bytes.length || !localName.equals(centralName))
    fail("zip-entry-invalid");
  const dataStart = localNameEnd + localExtraLength;
  if (dataStart + compressedSize > bytes.length) fail("zip-entry-truncated");
  const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
  const output =
    method === 0
      ? Buffer.from(compressed)
      : method === 8
        ? inflateRawSync(compressed, {
            maxOutputLength: maximumFileBytes + 1,
          })
        : fail("zip-compression-unsupported");
  if (output.length !== uncompressedSize) fail("zip-entry-size-mismatch");
  return output;
}
