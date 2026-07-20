export function isoFixture(date, types = [1, 2, 255]) {
  const bytes = Buffer.alloc(23 * 2048);
  for (const [index, type] of types.entries()) {
    const offset = (16 + index) * 2048;
    bytes[offset] = type;
    bytes.write("CD001", offset + 1, "ascii");
    bytes[offset + 6] = 1;
    if (type === 2) bytes.write("%/@", offset + 88, "ascii");
    if (type !== 255) {
      bytes.write(date, offset + 813, "ascii");
      bytes.write(date, offset + 830, "ascii");
      directoryRecord(bytes, offset + 156, {
        date,
        extent: type === 1 ? 20 : 21,
        flags: 2,
        identifier: 0,
        size: 2048,
      });
    }
  }
  for (const extent of [20, 21]) writeDirectory(bytes, extent, date);
  bytes[16 * 2048 + 100] = 0xa5;
  bytes[22 * 2048] = 0x5a;
  return bytes;
}

export function writeBoth32(bytes, offset, value) {
  bytes.writeUInt32LE(value, offset);
  bytes.writeUInt32BE(value, offset + 4);
}

export function isoTimestampOffsets() {
  const offsets = new Set();
  const add = (start, length) => {
    for (let index = start; index < start + length; index += 1)
      offsets.add(index);
  };
  for (const descriptor of [16, 17]) {
    const base = descriptor * 2048;
    for (const field of [813, 830]) add(base + field, 17);
    add(base + 156 + 18, 7);
  }
  for (const extent of [20, 21]) {
    const base = extent * 2048;
    for (const record of [0, 34, 68]) add(base + record + 18, 7);
    for (const field of [5, 12, 19, 26]) add(base + 68 + 34 + field, 7);
  }
  return offsets;
}

function writeDirectory(bytes, extent, date) {
  const offset = extent * 2048;
  for (const [recordOffset, identifier] of [
    [0, 0],
    [34, 1],
  ])
    directoryRecord(bytes, offset + recordOffset, {
      date,
      extent,
      flags: 2,
      identifier,
      size: 2048,
    });
  directoryRecord(bytes, offset + 68, {
    date,
    extent: 22,
    flags: 0,
    identifier: 65,
    size: 1,
    tf: true,
  });
}

function directoryRecord(
  bytes,
  offset,
  { date, extent, flags, identifier, size, tf = false },
) {
  bytes[offset] = tf ? 67 : 34;
  writeBoth32(bytes, offset + 2, extent);
  writeBoth32(bytes, offset + 10, size);
  shortDate(bytes, offset + 18, date);
  bytes[offset + 25] = flags;
  bytes.writeUInt16LE(1, offset + 28);
  bytes.writeUInt16BE(1, offset + 30);
  bytes[offset + 32] = 1;
  bytes[offset + 33] = identifier;
  if (!tf) return;
  const systemUse = offset + 34;
  bytes.write("TF", systemUse, "ascii");
  bytes[systemUse + 2] = 33;
  bytes[systemUse + 3] = 1;
  bytes[systemUse + 4] = 0x0f;
  for (const field of [5, 12, 19, 26])
    shortDate(bytes, systemUse + field, date);
}

function shortDate(bytes, offset, date) {
  bytes.set(
    [
      Number(date.slice(0, 4)) - 1900,
      Number(date.slice(4, 6)),
      Number(date.slice(6, 8)),
      Number(date.slice(8, 10)),
      Number(date.slice(10, 12)),
      Number(date.slice(12, 14)),
      0,
    ],
    offset,
  );
}
