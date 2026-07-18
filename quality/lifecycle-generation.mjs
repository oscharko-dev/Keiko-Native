import { createHash, timingSafeEqual } from "node:crypto";
export const LIFECYCLE_GENERATION_DOMAIN =
  "keiko-native.lifecycle-input-generation";
export const LIFECYCLE_GENERATION_SCHEMA = 1;
export const LIFECYCLE_GENERATION_ALGORITHM = "sha-256";
// prettier-ignore
const TAGS = new Set("record field string enum uint bool null list set map".split(" "));
// prettier-ignore
const GENERATION_FIELDS = Object.freeze(
  "domain schema algorithm repository pullRequest head lane submode attemptSequence inputs".split(" "),
);
const SUBMODES = new Map();
SUBMODES.set("normal", [null]);
SUBMODES.set("publication", ["ordinary", "migration"]);
const textDecoder = new TextDecoder("utf-8", { fatal: true });
function object(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
  return value;
}
function exactKeys(value, expected, name) {
  object(value, name);
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const unknown = actual.filter((key) => !expected.includes(key));
  if (missing.length > 0)
    throw new TypeError(`${name} has missing fields: ${missing.join(", ")}`);
  if (unknown.length > 0)
    throw new TypeError(`${name} has unknown fields: ${unknown.join(", ")}`);
}
function normalizedString(value) {
  if (typeof value !== "string" || !value.isWellFormed())
    throw new TypeError("string must contain valid Unicode scalar values");
  return value.replace(/\r\n?/gu, "\n").normalize("NFC");
}
function enumValue(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*$/u.test(value))
    throw new TypeError("enum must be canonical lowercase ASCII");
  return value;
}
function uintValue(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("uint must be an unsigned safe integer");
  }
  return String(value);
}
function frame(tag, payload) {
  const prefix = Buffer.from(`${tag}#${payload.length}:`, "ascii");
  return Buffer.concat([prefix, payload]);
}
function scalarNode(node) {
  if (node.type === "string") {
    exactKeys(node, ["type", "value"], "string node");
    return frame("string", Buffer.from(normalizedString(node.value), "utf8"));
  }
  if (node.type === "enum") {
    exactKeys(node, ["type", "value"], "enum node");
    return frame("enum", Buffer.from(enumValue(node.value), "ascii"));
  }
  if (node.type === "uint") {
    exactKeys(node, ["type", "value"], "uint node");
    return frame("uint", Buffer.from(uintValue(node.value), "ascii"));
  }
  if (node.type === "bool") {
    exactKeys(node, ["type", "value"], "bool node");
    if (typeof node.value !== "boolean")
      throw new TypeError("bool value must be boolean");
    return frame("bool", Buffer.from(String(node.value), "ascii"));
  }
  exactKeys(node, ["type"], "null node");
  return frame("null", Buffer.alloc(0));
}
function encodedField(field) {
  exactKeys(field, ["name", "value"], "record field");
  const name = encodeNode({ type: "string", value: field.name });
  return frame("field", Buffer.concat([name, encodeNode(field.value)]));
}
function encodedRecord(node) {
  exactKeys(node, ["type", "fields"], "record node");
  if (!Array.isArray(node.fields))
    throw new TypeError("record fields must be an array");
  const names = new Set();
  const fields = node.fields.map((field) => {
    const name = normalizedString(object(field, "record field").name);
    if (names.has(name)) throw new TypeError("record has a duplicate field");
    names.add(name);
    return encodedField(field);
  });
  return frame("record", Buffer.concat(fields));
}
function sortedUnique(buffers, name) {
  const sorted = buffers.toSorted(Buffer.compare);
  for (let index = 1; index < sorted.length; index += 1) {
    if (Buffer.compare(sorted[index - 1], sorted[index]) === 0) {
      throw new TypeError(`${name} has a duplicate canonical element`);
    }
  }
  return sorted;
}
function encodedCollection(node) {
  exactKeys(node, ["type", "items"], `${node.type} node`);
  if (!Array.isArray(node.items))
    throw new TypeError(`${node.type} items must be an array`);
  const children = node.items.map(encodeNode);
  const ordered =
    node.type === "set" ? sortedUnique(children, "set") : children;
  return frame(node.type, Buffer.concat(ordered));
}
function encodedMap(node) {
  exactKeys(node, ["type", "entries"], "map node");
  if (!Array.isArray(node.entries))
    throw new TypeError("map entries must be an array");
  const entries = node.entries.map((entry) => {
    exactKeys(entry, ["key", "value"], "map entry");
    return { key: encodeNode(entry.key), value: encodeNode(entry.value) };
  });
  entries.sort((left, right) => Buffer.compare(left.key, right.key));
  for (let index = 1; index < entries.length; index += 1) {
    if (Buffer.compare(entries[index - 1].key, entries[index].key) === 0) {
      throw new TypeError("map has a duplicate canonical key");
    }
  }
  const payload = Buffer.concat(
    entries.flatMap(({ key, value }) => [key, value]),
  );
  return frame("map", payload);
}
function encodeNode(value) {
  const node = object(value, "typed node");
  if (!TAGS.has(node.type) || node.type === "field")
    throw new TypeError("unknown typed-node type");
  if (["string", "enum", "uint", "bool", "null"].includes(node.type))
    return scalarNode(node);
  if (node.type === "record") return encodedRecord(node);
  if (node.type === "map") return encodedMap(node);
  return encodedCollection(node);
}
function ascii(bytes, start, end, name) {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] > 0x7f) throw new TypeError(`${name} must be ASCII`);
  }
  return bytes.toString("ascii", start, end);
}
function header(bytes, state, boundary) {
  const start = state.offset;
  const hash = bytes.indexOf(0x23, start);
  if (hash < start || hash >= boundary)
    throw new TypeError("malformed type tag");
  const colon = bytes.indexOf(0x3a, hash + 1);
  if (colon < 0 || colon >= boundary)
    throw new TypeError("malformed payload length");
  const tag = ascii(bytes, start, hash, "type tag");
  const lengthText = ascii(bytes, hash + 1, colon, "payload length");
  if (!TAGS.has(tag)) throw new TypeError("unknown type tag");
  if (!/^(?:0|[1-9][0-9]*)$/u.test(lengthText))
    throw new TypeError("invalid payload length");
  const length = Number(lengthText);
  if (!Number.isSafeInteger(length) || colon + 1 + length > boundary) {
    throw new TypeError("inconsistent payload length");
  }
  state.offset = colon + 1;
  return { end: state.offset + length, start, tag };
}
function decodedText(bytes, start, end, type) {
  let value;
  try {
    value = textDecoder.decode(bytes.subarray(start, end));
  } catch {
    throw new TypeError("malformed UTF-8 payload");
  }
  if (type === "string") {
    if (value !== value.normalize("NFC") || value.includes("\r")) {
      throw new TypeError("string is not in canonical normal form");
    }
    return value;
  }
  return enumValue(value);
}
function decodedScalar(tag, bytes, start, end) {
  if (tag === "string" || tag === "enum") {
    return { type: tag, value: decodedText(bytes, start, end, tag) };
  }
  const payload = ascii(bytes, start, end, tag);
  if (tag === "uint") {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(payload))
      throw new TypeError("invalid canonical uint");
    const value = Number(payload);
    if (!Number.isSafeInteger(value)) throw new TypeError("uint overflow");
    return { type: tag, value };
  }
  if (tag === "bool") {
    if (payload !== "true" && payload !== "false")
      throw new TypeError("invalid canonical bool");
    return { type: tag, value: payload === "true" };
  }
  if (payload.length !== 0) throw new TypeError("invalid canonical null");
  return { type: "null" };
}
function parseChildren(bytes, state, end) {
  const children = [];
  while (state.offset < end) children.push(parseNode(bytes, state, end));
  if (state.offset !== end)
    throw new TypeError("inconsistent child payload length");
  return children;
}
function decodedField(bytes, state, end) {
  const children = parseChildren(bytes, state, end);
  if (
    children.length !== 2 ||
    children[0].node.type !== "string" ||
    children[1].node.type === "field"
  ) {
    throw new TypeError("field must contain a string name and one value");
  }
  return {
    type: "field",
    name: children[0].node.value,
    value: children[1].node,
  };
}
function decodedRecord(children) {
  const fields = [];
  const names = new Set();
  for (const child of children) {
    if (child.node.type !== "field")
      throw new TypeError("record payload must contain fields");
    if (names.has(child.node.name))
      throw new TypeError("record has a duplicate field");
    names.add(child.node.name);
    fields.push({ name: child.node.name, value: child.node.value });
  }
  return { type: "record", fields };
}
function requireCanonicalOrder(children, step, name) {
  for (let index = step; index < children.length; index += step) {
    const previous = children[index - step].encoded;
    const order = Buffer.compare(previous, children[index].encoded);
    if (order === 0)
      throw new TypeError(`${name} has a duplicate canonical element`);
    if (order > 0) throw new TypeError(`${name} is not in canonical order`);
  }
}
function decodedCollection(tag, children) {
  if (children.some(({ node }) => node.type === "field")) {
    throw new TypeError(`${tag} cannot contain structural fields`);
  }
  if (tag === "list")
    return { type: tag, items: children.map(({ node }) => node) };
  if (tag === "set") {
    requireCanonicalOrder(children, 1, "set");
    return { type: tag, items: children.map(({ node }) => node) };
  }
  if (children.length % 2 !== 0)
    throw new TypeError("map must contain key/value pairs");
  requireCanonicalOrder(
    children.filter((_, index) => index % 2 === 0),
    1,
    "map",
  );
  const entries = [];
  for (let index = 0; index < children.length; index += 2) {
    entries.push({
      key: children[index].node,
      value: children[index + 1].node,
    });
  }
  return { type: "map", entries };
}
function parseNode(bytes, state, boundary) {
  const { end, start, tag } = header(bytes, state, boundary);
  let node;
  if (["string", "enum", "uint", "bool", "null"].includes(tag)) {
    node = decodedScalar(tag, bytes, state.offset, end);
    state.offset = end;
  } else if (tag === "field") {
    node = decodedField(bytes, state, end);
  } else {
    const children = parseChildren(bytes, state, end);
    node =
      tag === "record"
        ? decodedRecord(children)
        : decodedCollection(tag, children);
  }
  return { encoded: bytes.subarray(start, end), node };
}
export function encodeCanonicalValueV1(value) {
  return encodeNode(value);
}
export function decodeCanonicalValueV1(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError("canonical value must be bytes");
  }
  const bytes = Buffer.from(value);
  const state = { offset: 0 };
  const result = parseNode(bytes, state, bytes.length);
  if (state.offset !== bytes.length)
    throw new TypeError("trailing bytes after canonical value");
  if (result.node.type === "field")
    throw new TypeError("field is not a top-level typed value");
  return result.node;
}
function validateGeneration(value) {
  exactKeys(value, GENERATION_FIELDS, "generation");
  if (value.domain !== LIFECYCLE_GENERATION_DOMAIN)
    throw new TypeError("unknown generation domain");
  if (value.schema !== LIFECYCLE_GENERATION_SCHEMA)
    throw new TypeError("unknown generation schema");
  if (value.algorithm !== LIFECYCLE_GENERATION_ALGORITHM)
    throw new TypeError("unknown generation algorithm");
  normalizedString(value.repository);
  uintValue(value.pullRequest);
  if (
    typeof value.head !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.head)
  )
    throw new TypeError("head must be a lowercase hexadecimal commit identity");
  enumValue(value.lane);
  if (value.submode !== null) enumValue(value.submode);
  if (!SUBMODES.get(value.lane)?.includes(value.submode))
    throw new TypeError("unknown lane or invalid publication submode");
  uintValue(value.attemptSequence);
  object(value.inputs, "generation inputs");
}
function generationNode(value) {
  validateGeneration(value);
  const scalar = (type, scalarValue) => ({ type, value: scalarValue });
  const values = [
    scalar("string", value.domain),
    scalar("uint", value.schema),
    scalar("enum", value.algorithm),
    scalar("string", value.repository),
    scalar("uint", value.pullRequest),
    scalar("string", value.head),
    scalar("enum", value.lane),
    value.submode === null ? { type: "null" } : scalar("enum", value.submode),
    scalar("uint", value.attemptSequence),
    value.inputs,
  ];
  const fields = GENERATION_FIELDS.map((name, index) => ({
    name,
    value: values[index],
  }));
  return { type: "record", fields };
}
function generationFromNode(node) {
  if (node.type !== "record")
    throw new TypeError("generation must be a record");
  const names = node.fields.map(({ name }) => name);
  if (names.some((name, index) => name !== GENERATION_FIELDS[index])) {
    throw new TypeError("generation has invalid field order");
  }
  const values = Object.fromEntries(
    node.fields.map(({ name, value }) => [name, value]),
  );
  const requireType = (name, type) => {
    if (values[name]?.type !== type)
      throw new TypeError(`generation ${name} has invalid type`);
    return values[name].value;
  };
  const result = {
    domain: requireType("domain", "string"),
    schema: requireType("schema", "uint"),
    algorithm: requireType("algorithm", "enum"),
    repository: requireType("repository", "string"),
    pullRequest: requireType("pullRequest", "uint"),
    head: requireType("head", "string"),
    lane: requireType("lane", "enum"),
    submode:
      values.submode?.type === "null" ? null : requireType("submode", "enum"),
    attemptSequence: requireType("attemptSequence", "uint"),
    inputs: values.inputs,
  };
  validateGeneration(result);
  return result;
}
export function encodeLifecycleGenerationV1(value) {
  return encodeNode(generationNode(value));
}
export function decodeLifecycleGenerationV1(value) {
  return generationFromNode(decodeCanonicalValueV1(value));
}
export function digestLifecycleGenerationV1(value) {
  return createHash(LIFECYCLE_GENERATION_ALGORITHM)
    .update(encodeLifecycleGenerationV1(value))
    .digest("hex");
}
export function compareLifecycleGenerationDigestV1(value, suppliedDigest) {
  if (
    typeof suppliedDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(suppliedDigest)
  )
    return false;
  const supplied = Buffer.from(suppliedDigest, "hex");
  const expected = createHash(LIFECYCLE_GENERATION_ALGORITHM)
    .update(encodeLifecycleGenerationV1(value))
    .digest();
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
