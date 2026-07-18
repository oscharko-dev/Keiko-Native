import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIFECYCLE_GENERATION_DOMAIN,
  compareLifecycleGenerationDigestV1,
  decodeCanonicalValueV1,
  decodeLifecycleGenerationV1,
  digestLifecycleGenerationV1,
  encodeCanonicalValueV1,
  encodeLifecycleGenerationV1,
} from "./lifecycle-generation.mjs";
const string = (value) => ({ type: "string", value });
const enumeration = (value) => ({ type: "enum", value });
function generation(overrides = {}) {
  return {
    domain: LIFECYCLE_GENERATION_DOMAIN,
    schema: 1,
    algorithm: "sha-256",
    repository: "oscharko-dev/Keiko-Native",
    pullRequest: 42,
    head: "0123456789abcdef0123456789abcdef01234567",
    lane: "normal",
    submode: null,
    attemptSequence: 0,
    inputs: {
      type: "record",
      fields: [{ name: "updated", value: string("cafe\u0301\r\nline") }],
    },
    ...overrides,
  };
}
const encodeGeneration = (overrides = {}) =>
  encodeLifecycleGenerationV1(generation(overrides));
const pinnedBytes = Buffer.from(
  "record#509:field#64:string#6:domainstring#39:keiko-native.lifecycle-input-generation" +
    "field#23:string#6:schemauint#1:1" +
    "field#32:string#9:algorithmenum#7:sha-256" +
    "field#55:string#10:repositorystring#25:oscharko-dev/Keiko-Native" +
    "field#30:string#11:pullRequestuint#2:42" +
    "field#63:string#4:headstring#40:0123456789abcdef0123456789abcdef01234567" +
    "field#26:string#4:laneenum#6:normal" +
    "field#23:string#7:submodenull#0:" +
    "field#33:string#15:attemptSequenceuint#1:0" +
    "field#70:string#6:inputsrecord#45:field#36:string#7:updatedstring#10:café\nline",
  "utf8",
);

test("pins the version-one generation bytes and lowercase SHA-256", () => {
  assert.deepEqual(encodeLifecycleGenerationV1(generation()), pinnedBytes);
  assert.equal(
    digestLifecycleGenerationV1(generation()),
    "9adc366cb6c949f03d4a3a09d886f01e487e209029e7e719bac67706c9ed6828",
  );
  assert.deepEqual(decodeLifecycleGenerationV1(pinnedBytes), {
    ...generation(),
    inputs: {
      type: "record",
      fields: [{ name: "updated", value: string("café\nline") }],
    },
  });
});
test("byte counts prevent structural field collisions", () => {
  const first = {
    type: "record",
    fields: [
      { name: "ab", value: string("c") },
      { name: "a", value: string("bc") },
    ],
  };
  const second = {
    type: "record",
    fields: [
      { name: "a", value: string("b") },
      { name: "c", value: string("abc") },
    ],
  };
  assert.notDeepEqual(
    encodeCanonicalValueV1(first),
    encodeCanonicalValueV1(second),
  );
  assert.notEqual(
    digestLifecycleGenerationV1(generation({ inputs: first })),
    digestLifecycleGenerationV1(generation({ inputs: second })),
  );
});
test("maps and sets sort canonically while lists preserve semantic order", () => {
  const map = (entries) => ({ type: "map", entries });
  const set = (items) => ({ type: "set", items });
  const list = (items) => ({ type: "list", items });
  const a = string("a");
  const b = string("b");
  const entries = [
    { key: b, value: enumeration("second") },
    { key: a, value: enumeration("first") },
  ];
  assert.deepEqual(
    encodeCanonicalValueV1(map(entries)),
    encodeCanonicalValueV1(map(entries.toReversed())),
  );
  assert.deepEqual(
    encodeCanonicalValueV1(set([b, a])),
    encodeCanonicalValueV1(set([a, b])),
  );
  assert.notDeepEqual(
    encodeCanonicalValueV1(list([a, b])),
    encodeCanonicalValueV1(list([b, a])),
  );
});
test("normalizes strings to NFC and LF and fixes generation record order", () => {
  assert.deepEqual(
    encodeCanonicalValueV1(string("cafe\u0301\rline\r\n")),
    encodeCanonicalValueV1(string("café\nline\n")),
  );
  const reordered = Object.fromEntries(
    Object.entries(generation()).toReversed(),
  );
  assert.deepEqual(encodeLifecycleGenerationV1(reordered), pinnedBytes);
});
test("rejects duplicate raw and normalized fields, keys, and set elements", () => {
  const duplicate = (value) =>
    assert.throws(() => encodeCanonicalValueV1(value), /duplicate/iu);
  duplicate({
    type: "record",
    fields: [
      { name: "same", value: string("a") },
      { name: "same", value: string("b") },
    ],
  });
  duplicate({
    type: "record",
    fields: [
      { name: "e\u0301", value: string("a") },
      { name: "é", value: string("b") },
    ],
  });
  duplicate({
    type: "map",
    entries: [
      { key: string("e\u0301"), value: string("a") },
      { key: string("é"), value: string("b") },
    ],
  });
  duplicate({ type: "set", items: [string("same"), string("same")] });
});
test("rejects unknown or missing generation and typed-node fields", () => {
  assert.throws(
    () => encodeLifecycleGenerationV1({ ...generation(), extra: true }),
    /unknown/iu,
  );
  const missing = generation();
  delete missing.head;
  assert.throws(() => encodeLifecycleGenerationV1(missing), /missing/iu);
  assert.throws(
    () => encodeCanonicalValueV1({ type: "mystery", value: "x" }),
    /type/iu,
  );
  assert.throws(() => encodeCanonicalValueV1({ type: "string" }), /missing/iu);
  assert.throws(
    () => encodeCanonicalValueV1({ type: "bool", value: true, extra: false }),
    /unknown/iu,
  );
});
test("rejects non-canonical and malformed encoded bytes", () => {
  const reject = (value, pattern) =>
    assert.throws(() => decodeCanonicalValueV1(value), pattern);
  reject(
    Buffer.from([115, 116, 114, 105, 110, 103, 35, 49, 58, 0xff]),
    /UTF-8/iu,
  );
  reject(Buffer.from("string#2:a"), /length/iu);
  reject(Buffer.from("string#1:ab"), /trailing/iu);
  reject(Buffer.from("string#01:a"), /length/iu);
  reject(Buffer.from("string#3:e\u0301"), /normal/iu);
  reject(Buffer.from("enum#3:A B"), /enum/iu);
  reject(Buffer.from("uint#2:01"), /uint/iu);
  reject(Buffer.from("bool#1:1"), /bool/iu);
  reject(Buffer.from("null#1:x"), /null/iu);
  reject(Buffer.from("field#0:"), /field/iu);
});
test("rejects unknown domain, schema, algorithm, invalid scalars, and envelope order", () => {
  assert.throws(
    () => encodeLifecycleGenerationV1(generation({ domain: "changed" })),
    /domain/iu,
  );
  assert.throws(
    () => encodeLifecycleGenerationV1(generation({ schema: 2 })),
    /schema/iu,
  );
  assert.throws(
    () => encodeLifecycleGenerationV1(generation({ algorithm: "sha-512" })),
    /algorithm/iu,
  );
  assert.throws(
    () => encodeLifecycleGenerationV1(generation({ head: "ABC" })),
    /head/iu,
  );
  assert.throws(
    () => encodeLifecycleGenerationV1(generation({ pullRequest: -1 })),
    /uint/iu,
  );
  assert.throws(
    () =>
      encodeLifecycleGenerationV1(
        generation({ attemptSequence: Number.MAX_SAFE_INTEGER + 1 }),
      ),
    /uint/iu,
  );
  const decoded = decodeCanonicalValueV1(pinnedBytes);
  const swapped = {
    ...decoded,
    fields: decoded.fields.toSpliced(
      0,
      2,
      decoded.fields[1],
      decoded.fields[0],
    ),
  };
  assert.throws(
    () => decodeLifecycleGenerationV1(encodeCanonicalValueV1(swapped)),
    /field order/iu,
  );
});
test("changes to every binding and recovery attempt separate generations", () => {
  const base = generation();
  const digest = digestLifecycleGenerationV1(base);
  for (const changed of [
    generation({ lane: "publication", submode: "ordinary" }),
    generation({ lane: "publication", submode: "migration" }),
    generation({ inputs: string("changed") }),
    generation({ attemptSequence: 1 }),
  ]) {
    assert.notEqual(digestLifecycleGenerationV1(changed), digest);
    assert.equal(compareLifecycleGenerationDigestV1(changed, digest), false);
  }
});
test("comparator recomputes and constant-time compares a decoded 32-byte digest", () => {
  const input = generation();
  const digest = digestLifecycleGenerationV1(input);
  assert.equal(compareLifecycleGenerationDigestV1(input, digest), true);
  assert.equal(
    compareLifecycleGenerationDigestV1(input, digest.replace(/^../u, "00")),
    false,
  );
  assert.equal(compareLifecycleGenerationDigestV1(input, "00"), false);
  assert.equal(
    compareLifecycleGenerationDigestV1(input, "g".repeat(64)),
    false,
  );
  assert.equal(
    compareLifecycleGenerationDigestV1(input, Buffer.alloc(32)),
    false,
  );
  assert.equal(compareLifecycleGenerationDigestV1(input, null), false);
});
test("round-trips every version-one type and rejects noncanonical collection order", () => {
  const value = {
    type: "record",
    fields: [
      { name: "bool", value: { type: "bool", value: false } },
      { name: "uint", value: { type: "uint", value: 7 } },
      { name: "none", value: { type: "null" } },
      { name: "list", value: { type: "list", items: [string("x")] } },
      {
        name: "set",
        value: { type: "set", items: [string("a"), string("b")] },
      },
      {
        name: "map",
        value: {
          type: "map",
          entries: [{ key: string("a"), value: enumeration("one") }],
        },
      },
    ],
  };
  assert.deepEqual(
    decodeCanonicalValueV1(encodeCanonicalValueV1(value)),
    value,
  );
  assert.throws(
    () => decodeCanonicalValueV1(Buffer.from("set#20:string#1:bstring#1:a")),
    /order/iu,
  );
  assert.throws(
    () => decodeCanonicalValueV1(Buffer.from("map#10:string#1:a")),
    /map/iu,
  );
});
test("fails closed across malformed node objects and scalar boundaries", () => {
  const reject = (value, pattern) =>
    assert.throws(() => encodeCanonicalValueV1(value), pattern);
  reject(null, /object/iu);
  reject([], /object/iu);
  reject({ type: "string", value: "\ud800" }, /Unicode/iu);
  reject({ type: "enum", value: "Not-Canonical" }, /enum/iu);
  reject({ type: "uint", value: 1.5 }, /uint/iu);
  reject({ type: "bool", value: "false" }, /bool/iu);
  reject({ type: "record", fields: "no" }, /array/iu);
  reject({ type: "record", fields: [{ name: "x" }] }, /missing/iu);
  reject({ type: "list", items: "no" }, /array/iu);
  reject({ type: "map", entries: "no" }, /array/iu);
  reject({ type: "map", entries: [{ key: string("x") }] }, /missing/iu);
});
test("fails closed across malformed headers and structural field placement", () => {
  const reject = (text, pattern) =>
    assert.throws(
      () => decodeCanonicalValueV1(Buffer.from(text, "utf8")),
      pattern,
    );
  reject("string", /type tag/iu);
  reject("string#1", /payload length/iu);
  reject("mystery#0:", /unknown type/iu);
  reject("stríng#0:", /ASCII/iu);
  reject("string#é:", /ASCII/iu);
  reject(`string#${"9".repeat(400)}:`, /length/iu);
  reject("record#10:string#1:a", /record/iu);
  reject(
    "record#52:field#17:string#1:anull#0:field#17:string#1:anull#0:",
    /duplicate/iu,
  );
  reject("field#17:string#1:anull#0:", /top-level/iu);
  reject("list#26:field#17:string#1:anull#0:", /structural/iu);
  reject("set#20:string#1:astring#1:a", /duplicate/iu);
  reject("map#40:string#1:astring#1:xstring#1:astring#1:y", /duplicate/iu);
  reject("map#40:string#1:bstring#1:xstring#1:astring#1:y", /order/iu);
});
test("rejects malformed byte containers and generation scalar types", () => {
  assert.throws(() => decodeCanonicalValueV1("string#1:a"), /bytes/iu);
  assert.deepEqual(
    decodeCanonicalValueV1(new Uint8Array(Buffer.from("string#1:a"))),
    string("a"),
  );
  assert.throws(
    () => encodeLifecycleGenerationV1(generation({ repository: null })),
    /string/iu,
  );
  for (const overrides of [
    { lane: "unknown" },
    { lane: "normal", submode: "ordinary" },
    { lane: "publication", submode: null },
    { lane: "publication", submode: "unknown" },
    { lane: ["normal"] },
    { lane: "publication", submode: ["ordinary"] },
  ]) {
    assert.throws(() => encodeGeneration(overrides), /enum|lane|submode/iu);
  }
  assert.throws(() => encodeGeneration({ lane: "constructor" }), {
    message: "unknown lane or invalid publication submode",
  });
  assert.doesNotThrow(encodeGeneration);
  assert.doesNotThrow(() =>
    encodeGeneration({ lane: "publication", submode: "migration" }),
  );
  assert.throws(
    () => encodeLifecycleGenerationV1(generation({ inputs: [] })),
    /object/iu,
  );
});
test("decoder independently rejects unknown generation metadata and field types", () => {
  const node = decodeCanonicalValueV1(pinnedBytes);
  const changed = (name, value) => ({
    ...node,
    fields: node.fields.map((field) =>
      field.name === name ? { name, value } : field,
    ),
  });
  assert.throws(
    () =>
      decodeLifecycleGenerationV1(
        encodeCanonicalValueV1(changed("domain", string("wrong"))),
      ),
    /domain/iu,
  );
  assert.throws(
    () =>
      decodeLifecycleGenerationV1(
        encodeCanonicalValueV1(changed("schema", { type: "uint", value: 2 })),
      ),
    /schema/iu,
  );
  assert.throws(
    () =>
      decodeLifecycleGenerationV1(
        encodeCanonicalValueV1(changed("algorithm", enumeration("sha-512"))),
      ),
    /algorithm/iu,
  );
  assert.throws(
    () =>
      decodeLifecycleGenerationV1(
        encodeCanonicalValueV1(changed("head", enumeration("bad"))),
      ),
    /type/iu,
  );
  assert.throws(
    () => decodeLifecycleGenerationV1(Buffer.from("string#1:x")),
    /record/iu,
  );
});
