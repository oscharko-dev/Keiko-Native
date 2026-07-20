const descriptorBytes = 2048;
const descriptorStart = 16;
const volumeDateOffsets = [813, 830];

export function normalizeIsoTimestamps(bytes, sourceEpoch) {
  if (!(bytes instanceof Uint8Array) || !validSourceEpoch(sourceEpoch))
    throw new Error("release-image-descriptor-rejected");
  const image = Buffer.from(bytes);
  const timestamp = volumeTimestamp(sourceEpoch);
  let primary = 0;
  let joliet = 0;
  let terminated = false;
  const roots = [];
  for (
    let sector = descriptorStart;
    (sector + 1) * descriptorBytes <= image.length;
    sector += 1
  ) {
    const offset = sector * descriptorBytes;
    if (!validDescriptor(image, offset))
      throw new Error("release-image-descriptor-rejected");
    const type = image[offset];
    if (type === 255) {
      terminated = true;
      break;
    }
    if (type === 1) primary += 1;
    else if (type === 2 && validJoliet(image, offset)) joliet += 1;
    else throw new Error("release-image-descriptor-rejected");
    if (!validRecordedDates(image, offset) || !emptyVolumeDates(image, offset))
      throw new Error("release-image-descriptor-rejected");
    for (const field of volumeDateOffsets) {
      image.set(timestamp, offset + field);
      image[offset + field + 16] = 0;
    }
    roots.push(offset + 156);
  }
  if (!terminated || primary !== 1 || joliet !== 1)
    throw new Error("release-image-descriptor-rejected");
  const shortTimestamp = shortVolumeTimestamp(sourceEpoch);
  for (const root of roots) normalizeDirectoryTree(image, root, shortTimestamp);
  return image;
}

function validDescriptor(image, offset) {
  return (
    image.subarray(offset + 1, offset + 6).toString("ascii") === "CD001" &&
    image[offset + 6] === 1
  );
}

function validJoliet(image, offset) {
  return ["%/@", "%/C", "%/E"].includes(
    image.subarray(offset + 88, offset + 91).toString("ascii"),
  );
}

function emptyVolumeDates(image, offset) {
  return [847, 864].every((field) =>
    image.subarray(offset + field, offset + field + 17).every((byte) => !byte),
  );
}

function validRecordedDates(image, offset) {
  return volumeDateOffsets.every((field) => {
    const date = image.subarray(offset + field, offset + field + 17);
    const zone = date[16] > 127 ? date[16] - 256 : date[16];
    return (
      /^\d{16}$/u.test(date.subarray(0, 16).toString("ascii")) &&
      zone >= -48 &&
      zone <= 52
    );
  });
}

function normalizeDirectoryTree(image, rootOffset, timestamp) {
  const root = directoryRecord(image, rootOffset, image.length);
  if (!root.directory || !root.dot)
    throw new Error("release-image-directory-rejected");
  const pending = [root];
  const visited = new Set();
  while (pending.length) {
    const directory = pending.pop();
    const key = `${String(directory.extent)}:${String(directory.size)}`;
    if (visited.has(key)) throw new Error("release-image-directory-rejected");
    visited.add(key);
    normalizeRecord(image, directory, timestamp);
    for (const record of directoryRecords(image, directory)) {
      normalizeRecord(image, record, timestamp);
      if (record.directory && !record.dot) pending.push(record);
    }
  }
}

function directoryRecords(image, directory) {
  const records = [];
  let offset = directory.extent * descriptorBytes;
  const end = offset + directory.size;
  while (offset < end) {
    if (image[offset] === 0) {
      offset = Math.min(
        end,
        (Math.floor(offset / descriptorBytes) + 1) * descriptorBytes,
      );
      continue;
    }
    const record = directoryRecord(image, offset, end);
    records.push(record);
    offset += record.length;
  }
  return records;
}

function directoryRecord(image, offset, bound) {
  const length = image[offset];
  if (
    length < 34 ||
    offset + length > bound ||
    offset + length > image.length ||
    (offset % descriptorBytes) + length > descriptorBytes ||
    image[offset + 1] !== 0
  )
    throw new Error("release-image-directory-rejected");
  const extent = dual32(image, offset + 2);
  const size = dual32(image, offset + 10);
  if (image.readUInt16LE(offset + 28) !== image.readUInt16BE(offset + 30))
    throw new Error("release-image-directory-rejected");
  const identifierLength = image[offset + 32];
  const identifierEnd = offset + 33 + identifierLength;
  const systemUse = identifierEnd + (identifierLength % 2 === 0 ? 1 : 0);
  const flags = image[offset + 25];
  if (
    identifierLength < 1 ||
    systemUse > offset + length ||
    !validShortDate(image.subarray(offset + 18, offset + 25)) ||
    ![0, 2].includes(flags) ||
    extent * descriptorBytes + size > image.length
  )
    throw new Error("release-image-directory-rejected");
  const identifier = image.subarray(offset + 33, identifierEnd);
  return {
    directory: flags === 2,
    dot: identifierLength === 1 && identifier[0] < 2,
    extent,
    length,
    offset,
    size,
    systemUse,
  };
}

function normalizeRecord(image, record, timestamp) {
  image.set(timestamp, record.offset + 18);
  let tf = 0;
  for (
    let offset = record.systemUse;
    offset < record.offset + record.length;
  ) {
    if (image[offset] === 0) {
      if (image.subarray(offset, record.offset + record.length).some(Boolean))
        throw new Error("release-image-directory-rejected");
      break;
    }
    if (offset + 4 > record.offset + record.length)
      throw new Error("release-image-directory-rejected");
    const length = image[offset + 2];
    const signature = image.subarray(offset, offset + 2).toString("ascii");
    if (length < 4 || offset + length > record.offset + record.length)
      throw new Error("release-image-directory-rejected");
    if (signature === "TF") {
      normalizeTf(image, offset, length, timestamp, tf);
      tf += 1;
    }
    offset += length;
  }
  if (tf !== (record.dot ? 0 : 1)) throw new Error("release-image-tf-rejected");
}

function normalizeTf(image, offset, length, timestamp, prior) {
  if (
    prior ||
    length !== 33 ||
    image[offset + 3] !== 1 ||
    image[offset + 4] !== 0x0f
  )
    throw new Error("release-image-tf-rejected");
  for (const field of [5, 12, 19, 26]) {
    if (!validShortDate(image.subarray(offset + field, offset + field + 7)))
      throw new Error("release-image-tf-rejected");
    image.set(timestamp, offset + field);
  }
}

function dual32(image, offset) {
  const value = image.readUInt32LE(offset);
  if (value !== image.readUInt32BE(offset + 4))
    throw new Error("release-image-directory-rejected");
  return value;
}

function validShortDate(date) {
  if (date.length !== 7) return false;
  const zone = date[6] > 127 ? date[6] - 256 : date[6];
  return (
    date[1] >= 1 &&
    date[1] <= 12 &&
    date[2] >= 1 &&
    date[2] <= 31 &&
    date[3] <= 23 &&
    date[4] <= 59 &&
    date[5] <= 59 &&
    zone >= -48 &&
    zone <= 52
  );
}

function validSourceEpoch(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function volumeTimestamp(sourceEpoch) {
  let iso;
  try {
    iso = new Date(sourceEpoch * 1000).toISOString();
  } catch {
    throw new Error("release-image-descriptor-rejected");
  }
  return Buffer.from(
    `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}00`,
    "ascii",
  );
}

function shortVolumeTimestamp(sourceEpoch) {
  const date = new Date(sourceEpoch * 1000);
  const year = date.getUTCFullYear();
  if (year < 1900 || year > 2155)
    throw new Error("release-image-descriptor-rejected");
  return Buffer.from([
    year - 1900,
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    0,
  ]);
}
