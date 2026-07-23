import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { githubRequestFor } from "./github-api.mjs";

const originalFetch = globalThis.fetch;
const originalToken = process.env.GITHUB_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
});

function requestHarness(response = Response.json({ accepted: true })) {
  const calls = [];
  process.env.GITHUB_TOKEN = "test-token";
  globalThis.fetch = async (...arguments_) => {
    calls.push(arguments_);
    if (response instanceof Error) throw response;
    return response;
  };
  return {
    calls,
    request: githubRequestFor("keiko-native-test"),
  };
}

const sha = "0123456789abcdef0123456789abcdef01234567";
const repository = "oscharko-dev/Keiko-Native";
const validRoutes = [
  [
    "GET issue comments page",
    `/repos/${repository}/issues/12/comments?per_page=100&page=3`,
    "GET",
  ],
  [
    "GET open pull requests page",
    `/repos/${repository}/pulls?state=open&per_page=100&page=3`,
    "GET",
  ],
  [
    "GET closed pull requests page",
    `/repos/${repository}/pulls?state=closed&per_page=100&page=3`,
    "GET",
  ],
  ["POST commit status", `/repos/${repository}/statuses/${sha}`, "POST"],
  [
    "GET combined commit status",
    `/repos/${repository}/commits/${sha}/status`,
    "GET",
  ],
  [
    "GET collaborator permission",
    `/repos/${repository}/collaborators/github-actions%5Bbot%5D/permission`,
    "GET",
  ],
  ["GET issue", `/repos/${repository}/issues/12`, "GET"],
  ["PATCH issue", `/repos/${repository}/issues/12`, "PATCH"],
  ["POST issue labels", `/repos/${repository}/issues/12/labels`, "POST"],
  [
    "DELETE encoded issue label",
    `/repos/${repository}/issues/12/labels/status%3A%20ready`,
    "DELETE",
  ],
  ["POST issue comment", `/repos/${repository}/issues/12/comments`, "POST"],
  [
    "GET repository labels page",
    `/repos/${repository}/labels?per_page=100&page=3`,
    "GET",
  ],
  ["GET pull detail", `/repos/${repository}/pulls/12`, "GET"],
];

test("allows every current route only with its bound method", async () => {
  for (const [name, path, method] of validRoutes) {
    const { calls, request } = requestHarness();
    const payload =
      method === "GET" || method === "DELETE" ? undefined : { value: name };
    const result = await request(path, { method, payload });
    assert.deepEqual(result, { accepted: true }, name);
    assert.equal(calls.length, 1, name);
    assert.equal(calls[0][0], `https://api.github.com${path}`, name);
    assert.equal(calls[0][1].method, method, name);
    assert.equal(
      calls[0][1].body,
      payload === undefined ? undefined : JSON.stringify(payload),
      name,
    );
    assert.deepEqual(
      calls[0][1].headers,
      {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
        "User-Agent": "keiko-native-test",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      name,
    );
  }
});

const hostileTargets = [
  undefined,
  "",
  "repos/owner/repo/issues/1",
  "https://attacker.invalid/repos/owner/repo/issues/1",
  "user:secret@attacker.invalid/repos/owner/repo/issues/1",
  "//attacker.invalid/repos/owner/repo/issues/1",
  "///attacker.invalid/repos/owner/repo/issues/1",
  "/repos/owner/repo/issues/1 ",
  "/repos/owner/repo/issues/\t1",
  "/repos/owner/repo/issues/\u00001",
  "/repos/owner/repo\\issues\\1",
  "/repos/user:secret@host/repo/issues/1",
  "/repos/owner/repo/issues/1#fragment",
  "/repos/owner/repo/issues/../1",
  "/repos/owner/repo/issues/%2E%2E",
  "/repos/owner/repo/issues/%2e%2e",
  "/repos/owner/repo/issues/%",
  "/repos/owner/repo/issues/%2",
  "/repos/owner/repo/issues/%GG",
  "/repos/owner/repo/issues/%2F1",
  "/repos/owner/repo/issues/%5C1",
  "/repos/owner/repo/issues/%3Fadmin",
  "/repos/owner/repo/issues/%23admin",
  "/repos/owner/repo/issues/%00",
  "/repos/owner/repo/issues/1?admin=true",
  "/repos/owner/repo/issues/1/comments?page=1&per_page=100",
  "/repos/owner/repo/issues/1/comments?per_page=99&page=1",
  "/repos/owner/repo/pulls?state=all&per_page=100&page=1",
];

test("rejects hostile and ambiguous targets before fetch", async () => {
  for (const target of hostileTargets) {
    const { calls, request } = requestHarness();
    await assert.rejects(request(target), /request target is invalid/u);
    assert.equal(calls.length, 0, String(target));
  }
});

const invalidTypedTargets = [
  "/repos/owner/extra/repo/issues/1",
  "/repos/./repo/issues/1",
  "/repos/owner/../issues/1",
  "/repos/owner%2Frepo/name/issues/1",
  "/repos/owner name/repo/issues/1",
  "/repos/owner/repo/issues/0",
  "/repos/owner/repo/issues/01",
  "/repos/owner/repo/issues/-1",
  "/repos/owner/repo/issues/9007199254740992",
  "/repos/owner/repo/issues/1/comments?per_page=100&page=0",
  `/repos/owner/repo/statuses/${sha.toUpperCase()}`,
  `/repos/owner/repo/statuses/${sha.slice(1)}`,
  `/repos/owner/repo/statuses/${sha.slice(0, -1)}g`,
  "/repos/owner/repo/collaborators/%61lice/permission",
  "/repos/owner/repo/collaborators/alice%2Fadmin/permission",
  "/repos/owner/repo/collaborators/alice%3aadmin/permission",
  "/repos/owner/repo/issues/1/labels/status:ready",
  "/repos/owner/repo/issues/1/labels/status%3a%20ready",
  "/repos/owner/repo/issues/1/labels/%2E%2E",
];

test("rejects invalid repository and dynamic segments before fetch", async () => {
  for (const target of invalidTypedTargets) {
    const { calls, request } = requestHarness();
    await assert.rejects(request(target), /request target is invalid/u);
    assert.equal(calls.length, 0, target);
  }
});

test("rejects unsupported routes and wrong methods before fetch", async () => {
  for (const [path, method] of [
    ["/user", "GET"],
    ["/repos/owner/repo/issues", "GET"],
    ["/repos/owner/repo/issues/1", "POST"],
    ["/repos/owner/repo/statuses/" + sha, "GET"],
    ["/repos/owner/repo/issues/1/labels/status%3A%20ready", "PATCH"],
    ["/repos/owner/repo/pulls/1", "DELETE"],
    ["/repos/owner/repo/issues/1", "get"],
  ]) {
    const { calls, request } = requestHarness();
    await assert.rejects(
      request(path, { method }),
      /request target is invalid/u,
    );
    assert.equal(calls.length, 0, `${method} ${path}`);
  }
});

test("validates target and method before token, payload getters, or fetch", async () => {
  const { calls, request } = requestHarness();
  const originalEnvironment = process.env;
  const payload = {
    toJSON() {
      throw new Error("payload sentinel");
    },
  };
  const options = {};
  Object.defineProperty(options, "payload", {
    get() {
      throw new Error("payload getter sentinel");
    },
  });
  Object.defineProperty(process, "env", {
    configurable: true,
    value: new Proxy(originalEnvironment, {
      get(target, property, receiver) {
        if (property === "GITHUB_TOKEN") throw new Error("token sentinel");
        return Reflect.get(target, property, receiver);
      },
    }),
  });
  try {
    await assert.rejects(
      request("https://attacker.invalid", options),
      /request target is invalid/u,
    );
    await assert.rejects(
      request("/repos/owner/repo/issues/1", {
        method: "POST",
        payload,
      }),
      /request target is invalid/u,
    );
    assert.equal(calls.length, 0);
  } finally {
    Object.defineProperty(process, "env", {
      configurable: true,
      value: originalEnvironment,
    });
  }
});

test("redacts target and response body from HTTP errors", async () => {
  const bodySentinel = "secret-response-body-sentinel";
  const targetSentinel = "target-sentinel";
  const path = `/repos/owner/repo/issues/1/labels/${targetSentinel}`;
  const { request } = requestHarness(
    new Response(bodySentinel, { status: 404 }),
  );
  await assert.rejects(request(path, { method: "DELETE" }), (error) => {
    assert.match(error.message, /GitHub API DELETE failed with 404/u);
    assert.doesNotMatch(error.message, new RegExp(bodySentinel, "u"));
    assert.doesNotMatch(error.message, new RegExp(targetSentinel, "u"));
    return true;
  });
});

test("preserves JSON, 204, and network-unavailable behavior", async () => {
  const json = requestHarness(Response.json({ value: 42 }));
  assert.deepEqual(await json.request("/repos/owner/repo/issues/1"), {
    value: 42,
  });

  const empty = requestHarness(new Response(null, { status: 204 }));
  assert.equal(
    await empty.request("/repos/owner/repo/issues/1/labels/status%3A%20ready", {
      method: "DELETE",
    }),
    undefined,
  );

  const unavailable = new Error("network unavailable");
  const failing = requestHarness(unavailable);
  await assert.rejects(
    failing.request("/repos/owner/repo/issues/1"),
    (error) => error === unavailable,
  );
});
