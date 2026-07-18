import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runPullRequestContractAction,
  runPullRequestContractActionWithOutput,
  writePullRequestIssueOutput,
} from "./pr-contract-action.mjs";
import { validPullRequestFixture } from "./pr-contract-test-fixture.mjs";

test.beforeEach((t) => {
  t.mock.method(process.stdout, "write", () => true);
  t.mock.method(process.stderr, "write", () => true);
});

function installGitHubFetchMock(t, fixture, { apiFailure = false } = {}) {
  const originalFetch = globalThis.fetch;
  const originalRepository = process.env.GITHUB_REPOSITORY;
  const calls = [];
  process.env.GITHUB_REPOSITORY = fixture.repository;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ method: options.method ?? "GET", url: String(url) });
    if (apiFailure) return new Response("unavailable", { status: 503 });
    if (String(url).includes("/comments?"))
      return Response.json(fixture.comments);
    if (options.method === "POST") return Response.json({}, { status: 201 });
    return Response.json(fixture.issue);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
  });
  return calls;
}

test("loads the linked issue and passes a complete pull-request contract", async (t) => {
  const fixture = validPullRequestFixture();
  const calls = installGitHubFetchMock(t, fixture);
  const result = await runPullRequestContractAction({
    event: { pull_request: fixture.pullRequest },
  });
  assert.deepEqual(result, { failures: [] });
  assert.equal(calls.length, 4);
  assert.equal(
    calls.filter(
      (call) =>
        call.method === "POST" &&
        call.url.endsWith(`/statuses/${"c".repeat(40)}`),
    ).length,
    2,
  );
});

test("writes the linked issue number for the serialized lifecycle job", async (t) => {
  const fixture = validPullRequestFixture();
  const directory = await mkdtemp(join(tmpdir(), "keiko-pr-output-"));
  const outputPath = join(directory, "github-output");
  t.after(() => rm(directory, { force: true, recursive: true }));

  await writePullRequestIssueOutput({
    event: { pull_request: fixture.pullRequest },
    outputPath,
  });

  assert.equal(await readFile(outputPath, "utf8"), "issue-number=42\n");
});

test("writes the lifecycle issue output before contract validation fails", async (t) => {
  const fixture = validPullRequestFixture();
  installGitHubFetchMock(t, fixture);
  const directory = await mkdtemp(join(tmpdir(), "keiko-pr-output-"));
  const outputPath = join(directory, "github-output");
  t.after(() => rm(directory, { force: true, recursive: true }));

  await assert.rejects(
    runPullRequestContractActionWithOutput({
      event: {
        pull_request: {
          ...fixture.pullRequest,
          body: "## Scope\n\n- Accepted issue: #42",
        },
      },
      outputPath,
    }),
    /PR contract failed/u,
  );

  assert.equal(await readFile(outputPath, "utf8"), "issue-number=42\n");
});

test("fails a structurally incomplete pull-request contract", async (t) => {
  const fixture = validPullRequestFixture();
  const calls = installGitHubFetchMock(t, fixture);
  await assert.rejects(
    runPullRequestContractAction({
      event: { pull_request: { ...fixture.pullRequest, body: "" } },
    }),
    /PR contract failed/u,
  );
  assert.ok(
    calls.some(
      (call) =>
        call.method === "POST" &&
        call.url.endsWith(`/statuses/${"c".repeat(40)}`),
    ),
  );
});

test("fails closed when GitHub issue evidence is unavailable", async (t) => {
  const fixture = validPullRequestFixture();
  installGitHubFetchMock(t, fixture, { apiFailure: true });
  await assert.rejects(
    runPullRequestContractAction({
      event: { pull_request: fixture.pullRequest },
    }),
    /GitHub API GET.*503/u,
  );
});

test("rejects missing repository and pull-request event context", async (t) => {
  const fixture = validPullRequestFixture();
  installGitHubFetchMock(t, fixture);
  delete process.env.GITHUB_REPOSITORY;
  await assert.rejects(
    runPullRequestContractAction({
      event: { pull_request: fixture.pullRequest },
    }),
    /GITHUB_REPOSITORY/u,
  );
  process.env.GITHUB_REPOSITORY = fixture.repository;
  await assert.rejects(
    runPullRequestContractAction({ event: {} }),
    /does not contain a pull request/u,
  );
});
