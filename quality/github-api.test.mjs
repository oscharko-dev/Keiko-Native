import assert from "node:assert/strict";
import test from "node:test";

import { githubRequestFor } from "./github-api.mjs";

function clientFor(sequence) {
  const attempts = [];
  const delays = [];
  const fetch = async (url, options) => {
    attempts.push({ options, url });
    const next = sequence.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const request = githubRequestFor("keiko-native-test", {
    fetch,
    sleep: async (delay) => delays.push(delay),
  });
  return { attempts, delays, request };
}

function unavailable(status = 503, retryAfter) {
  return new Response("provider response must remain private", {
    headers:
      retryAfter === undefined ? undefined : { "Retry-After": retryAfter },
    status,
  });
}

test("retries transient GET failures and returns the recovered response", async () => {
  const { attempts, delays, request } = clientFor([
    unavailable(),
    unavailable(),
    Response.json({ state: "recovered" }),
  ]);

  assert.deepEqual(await request("/repos/keiko/issues/18"), {
    state: "recovered",
  });
  assert.equal(attempts.length, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("retries only the explicit transient response statuses", async (t) => {
  for (const status of [429, 502, 503, 504]) {
    await t.test(String(status), async () => {
      const { attempts, request } = clientFor([
        unavailable(status),
        Response.json({ state: "recovered" }),
      ]);
      assert.deepEqual(await request("/transient"), { state: "recovered" });
      assert.equal(attempts.length, 2);
    });
  }
});

test("fails closed after three attempts without retaining provider content", async () => {
  const { attempts, delays, request } = clientFor([
    unavailable(),
    unavailable(),
    unavailable(),
  ]);

  await assert.rejects(
    request("/private"),
    (error) =>
      error.message ===
        "GitHub API GET /private failed with 503 after 3 attempts." &&
      !error.message.includes("provider response"),
  );
  assert.equal(attempts.length, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("honors only integer Retry-After seconds within the hard delay cap", async (t) => {
  const cases = [
    { expected: 0, value: "0" },
    { expected: 1_000, value: "1" },
    { expected: 1_000, value: "999999999999999999999999999999" },
    { expected: 100, value: undefined },
    { expected: 100, value: "-1" },
    { expected: 100, value: "0.5" },
    { expected: 100, value: "Wed, 17 Jul 2026 12:00:00 GMT" },
    { expected: 100, value: "1e3" },
    { expected: 1_000, value: " 1" },
    { expected: 100, value: "hostile" },
  ];
  for (const { expected, value } of cases) {
    await t.test(value ?? "absent", async () => {
      const { delays, request } = clientFor([
        unavailable(503, value),
        Response.json({ ok: true }),
      ]);
      await request("/retry-after");
      assert.deepEqual(delays, [expected]);
    });
  }
});

test("caps total provider-directed delay at two seconds", async () => {
  const { delays, request } = clientFor([
    unavailable(503, "999999"),
    unavailable(503, "999999"),
    Response.json({ ok: true }),
  ]);

  await request("/bounded");
  assert.deepEqual(delays, [1_000, 1_000]);
  assert.equal(
    delays.reduce((total, delay) => total + delay, 0),
    2_000,
  );
});

test("retries transport failures for GET without exposing their messages", async () => {
  const recovered = clientFor([
    new Error("token=must-not-leak"),
    Response.json({ ok: true }),
  ]);
  assert.deepEqual(await recovered.request("/transport"), { ok: true });
  assert.equal(recovered.attempts.length, 2);

  const exhausted = clientFor([
    new Error("secret-one"),
    new Error("secret-two"),
    new Error("secret-three"),
  ]);
  await assert.rejects(
    exhausted.request("/transport"),
    (error) =>
      error.message ===
      "GitHub API GET /transport failed after 3 attempts: transport error.",
  );
  assert.deepEqual(exhausted.delays, [100, 200]);
});

test("does not retry permanent responses", async () => {
  const { attempts, delays, request } = clientFor([
    new Response("token=must-not-leak", { status: 401 }),
    Response.json({ unexpected: true }),
  ]);
  await assert.rejects(
    request("/permanent"),
    /GitHub API GET \/permanent failed with 401 after 1 attempt\./u,
  );
  assert.equal(attempts.length, 1);
  assert.deepEqual(delays, []);
});

test("never retries mutation methods or changes their request contract", async (t) => {
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    await t.test(method, async () => {
      const { attempts, delays, request } = clientFor([
        unavailable(),
        Response.json({ unexpected: true }),
      ]);
      await assert.rejects(
        request("/mutation", { method, payload: { state: "ready" } }),
        new RegExp(`GitHub API ${method} /mutation failed with 503`, "u"),
      );
      assert.equal(attempts.length, 1);
      assert.deepEqual(delays, []);
      assert.equal(attempts[0].options.body, '{"state":"ready"}');
      assert.equal(attempts[0].options.method, method);
    });
  }
});

test("never retries mutation transport failures", async () => {
  const { attempts, delays, request } = clientFor([
    new Error("token=must-not-leak"),
    Response.json({ unexpected: true }),
  ]);
  await assert.rejects(
    request("/mutation", { method: "POST" }),
    /GitHub API POST \/mutation failed after 1 attempt: transport error\./u,
  );
  assert.equal(attempts.length, 1);
  assert.deepEqual(delays, []);
});

test("preserves immediate success, 204, and malformed JSON behavior", async () => {
  const success = clientFor([Response.json({ ok: true })]);
  assert.deepEqual(await success.request("/success"), { ok: true });
  assert.equal(success.attempts.length, 1);
  assert.deepEqual(success.delays, []);
  assert.equal(success.attempts[0].url, "https://api.github.com/success");
  assert.equal(
    success.attempts[0].options.headers["User-Agent"],
    "keiko-native-test",
  );

  const empty = clientFor([new Response(null, { status: 204 })]);
  assert.equal(await empty.request("/empty"), undefined);
  assert.equal(empty.attempts.length, 1);

  const malformed = clientFor([
    new Response("not-json", {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }),
    Response.json({ unexpected: true }),
  ]);
  await assert.rejects(malformed.request("/malformed"), SyntaxError);
  assert.equal(malformed.attempts.length, 1);
});
