import { TextDecoder } from "node:util";

import { SCHEMAS, validateSchema } from "./lifecycle-record-schema.mjs";

const MAX_STRING = 4096;
const MAX_COLLECTION = 256;
const MAX_FIELDS = 128;
const TAGS = new Set([
  "record",
  "field",
  "string",
  "enum",
  "uint",
  "bool",
  "null",
  "list",
  "set",
  "map",
]);
const decoder = new TextDecoder("utf-8", { fatal: true });
const SHA = /^[0-9a-f]{64}$/u;
const OID = /^[0-9a-f]{40}$/u;
const REPO = /^(?![./])(?!.*\/[./]?$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TIME =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/u;

export class ProtocolValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}
const fail = (message) => {
  throw new ProtocolValidationError(message);
};
const bytes = (value, label = "bytes") => {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  fail(`${label} must be a string or byte sequence`);
};
const wrap = (tag, payload) => {
  if (!TAGS.has(tag)) fail("unknown tag");
  return Buffer.concat([
    Buffer.from(`${tag}#${payload.length}:`, "ascii"),
    payload,
  ]);
};
const scalar = (tag, value) => wrap(tag, Buffer.from(value, "utf8"));

function stringValue(value, type) {
  if (typeof value !== "string") fail("expected string");
  const encoded = Buffer.from(value);
  if (encoded.length > MAX_STRING) fail("string exceeds 4 KiB");
  if (value.includes("\r") || value !== value.normalize("NFC"))
    fail("non-canonical string");
  if (type.format === "sha256" && !SHA.test(value)) fail("invalid sha256");
  if (type.format === "object-id" && !OID.test(value))
    fail("invalid object id");
  if (type.format === "repository" && !REPO.test(value))
    fail("invalid repository");
  if (type.format === "timestamp") {
    const parsed = Date.parse(value);
    if (
      !TIME.test(value) ||
      !Number.isFinite(parsed) ||
      new Date(parsed).toISOString().replace(".000Z", "Z") !== value
    )
      fail("invalid timestamp");
  }
  return value;
}

function encodeValue(type, value) {
  if (type.kind === "nullable")
    return value === null
      ? wrap("null", Buffer.alloc(0))
      : encodeValue(type.inner, value);
  if (type.kind === "string") return scalar("string", stringValue(value, type));
  if (type.kind === "enum") {
    if (
      typeof value !== "string" ||
      !type.values.includes(value) ||
      !/^[\x20-\x7e]+$/u.test(value)
    )
      fail("invalid enum");
    return scalar("enum", value);
  }
  if (type.kind === "uint") {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (type.positive && value === 0)
    )
      fail("invalid uint");
    return scalar("uint", String(value));
  }
  if (type.kind === "bool") {
    if (typeof value !== "boolean") fail("invalid bool");
    return scalar("bool", value ? "true" : "false");
  }
  if (type.kind === "record") return encodeRecord(type.name, value);
  if (type.kind === "list" || type.kind === "set")
    return encodeCollection(type, value);
  fail("unsupported schema type");
}

function recordObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail("expected plain record");
}
function encodeRecord(name, value) {
  const schema = SCHEMAS[name];
  if (!schema) fail(`unknown schema: ${name}`);
  recordObject(value);
  if (schema.length > MAX_FIELDS) fail("too many fields");
  const expected = schema.map((item) => item.name);
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  )
    fail("missing or unknown fields");
  const fields = schema.map((item) => {
    if (!Object.hasOwn(value, item.name) || value[item.name] === undefined)
      fail(`missing ${item.name}`);
    if (item.fixed !== undefined && value[item.name] !== item.fixed)
      fail(`fixed ${item.name}`);
    return wrap(
      "field",
      Buffer.concat([
        scalar("string", item.name),
        encodeValue(item.type, value[item.name]),
      ]),
    );
  });
  validateSchema(name, value, fail);
  return wrap("record", Buffer.concat(fields));
}
function sortKey(type, member, encoded) {
  if (!type.sortBy) return encoded;
  const nested = SCHEMAS[type.inner.name].find(
    (item) => item.name === type.sortBy,
  );
  return encodeValue(nested.type, member[type.sortBy]);
}
function encodeCollection(type, value) {
  if (!Array.isArray(value) || value.length > MAX_COLLECTION)
    fail("invalid collection");
  const members = value.map((member) => {
    const encoded = encodeValue(type.inner, member);
    return { member, encoded, key: sortKey(type, member, encoded) };
  });
  if (type.kind === "set") {
    members.sort((left, right) => Buffer.compare(left.key, right.key));
    for (let index = 1; index < members.length; index += 1)
      if (Buffer.compare(members[index - 1].key, members[index].key) === 0)
        fail("duplicate set member");
  }
  for (const field of type.uniqueBy ?? []) {
    const seen = new Set();
    for (const item of members) {
      const key = String(item.member[field]);
      if (seen.has(key)) fail(`duplicate list ${field}`);
      seen.add(key);
    }
  }
  return wrap(type.kind, Buffer.concat(members.map((item) => item.encoded)));
}

function lengthAt(input, start, limit) {
  let cursor = start;
  while (cursor < limit && input[cursor] >= 48 && input[cursor] <= 57)
    cursor += 1;
  if (cursor === start || cursor >= limit || input[cursor] !== 58)
    fail("invalid length");
  const digits = input.subarray(start, cursor).toString("ascii");
  if (
    (digits.length > 1 && digits[0] === "0") ||
    !Number.isSafeInteger(Number(digits))
  )
    fail("invalid length");
  return { length: Number(digits), cursor: cursor + 1 };
}
function parseNode(input, start = 0, limit = input.length, depth = 0) {
  if (depth > 16) fail("nesting limit");
  let cursor = start;
  while (
    cursor < limit &&
    ((input[cursor] >= 97 && input[cursor] <= 122) || input[cursor] === 45)
  )
    cursor += 1;
  if (cursor === start || cursor >= limit || input[cursor] !== 35)
    fail("invalid tag");
  const tag = input.subarray(start, cursor).toString("ascii");
  if (!TAGS.has(tag)) fail("unknown tag");
  const sized = lengthAt(input, cursor + 1, limit);
  const end = sized.cursor + sized.length;
  if (end > limit) fail("truncated node");
  const node = {
    tag,
    raw: input.subarray(start, end),
    payload: input.subarray(sized.cursor, end),
    end,
  };
  if (["record", "field", "list", "set", "map"].includes(tag)) {
    node.children = [];
    cursor = sized.cursor;
    while (cursor < end) {
      const child = parseNode(input, cursor, end, depth + 1);
      node.children.push(child);
      cursor = child.end;
    }
    if (cursor !== end || (tag === "field" && node.children.length !== 2))
      fail("child boundary");
    if (tag === "record" && node.children.length > MAX_FIELDS)
      fail("too many fields");
    if (
      ["list", "set", "map"].includes(tag) &&
      node.children.length > MAX_COLLECTION
    )
      fail("too many members");
  }
  return node;
}
function text(node, tag) {
  if (node.tag !== tag) fail("type mismatch");
  try {
    return decoder.decode(node.payload);
  } catch {
    fail("malformed UTF-8");
  }
}
function decodeValue(node, type) {
  if (type.kind === "nullable") {
    if (node.tag === "null") {
      if (node.payload.length !== 0) fail("invalid null");
      return null;
    }
    return decodeValue(node, type.inner);
  }
  if (type.kind === "string") return stringValue(text(node, "string"), type);
  if (type.kind === "enum") {
    const value = text(node, "enum");
    if (
      !/^[\x20-\x7e]+$/u.test(value) ||
      !type.values.includes(value) ||
      !Buffer.from(value, "ascii").equals(node.payload)
    )
      fail("invalid enum");
    return value;
  }
  if (type.kind === "uint") {
    const value = text(node, "uint");
    if (
      !/^(?:0|[1-9][0-9]*)$/u.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      (type.positive && value === "0")
    )
      fail("invalid uint");
    return Number(value);
  }
  if (type.kind === "bool") {
    const value = text(node, "bool");
    if (value !== "true" && value !== "false") fail("invalid bool");
    return value === "true";
  }
  if (type.kind === "record") return decodeRecordNode(node, type.name);
  if (type.kind === "list" || type.kind === "set")
    return decodeCollection(node, type);
  fail("unsupported schema type");
}
function decodeRecordNode(node, name) {
  const schema = SCHEMAS[name];
  if (
    node.tag !== "record" ||
    !schema ||
    node.children.length !== schema.length
  )
    fail("record shape");
  const value = {};
  for (let index = 0; index < schema.length; index += 1) {
    const child = node.children[index];
    if (child.tag !== "field" || child.children.length !== 2)
      fail("field shape");
    const actual = text(child.children[0], "string");
    const expected = schema[index];
    if (actual !== expected.name || Object.hasOwn(value, actual))
      fail("field order");
    value[actual] = decodeValue(child.children[1], expected.type);
    if (expected.fixed !== undefined && value[actual] !== expected.fixed)
      fail(`fixed ${actual}`);
  }
  validateSchema(name, value, fail);
  return value;
}
function decodeCollection(node, type) {
  if (node.tag !== type.kind) fail("collection type");
  const values = node.children.map((child) => decodeValue(child, type.inner));
  if (type.kind === "set") {
    let previous;
    for (let index = 0; index < values.length; index += 1) {
      const key = sortKey(type, values[index], node.children[index].raw);
      if (previous && Buffer.compare(previous, key) >= 0) fail("set order");
      previous = key;
    }
  }
  for (const field of type.uniqueBy ?? []) {
    const seen = new Set();
    for (const value of values) {
      const key = String(value[field]);
      if (seen.has(key)) fail(`duplicate list ${field}`);
      seen.add(key);
    }
  }
  return values;
}
function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export const encodeCanonical = (name, value) =>
  Buffer.from(encodeRecord(name, value));
export function decodeCanonical(name, input) {
  const data = bytes(input);
  const node = parseNode(data);
  if (node.end !== data.length) fail("trailing bytes");
  return deepFreeze(decodeRecordNode(node, name));
}
export const toBytes = bytes;
