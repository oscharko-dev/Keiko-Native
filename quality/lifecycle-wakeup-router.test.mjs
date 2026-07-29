import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveLifecycleWakeup } from "./lifecycle-wakeup-router.mjs";

const repository = "oscharko-dev/Keiko-Native";
const head = "a".repeat(40);

function environment(eventName = "pull_request_target") {
  return {
    GITHUB_EVENT_NAME: eventName,
    GITHUB_REPOSITORY: repository,
  };
}

function event(overrides = {}) {
  return {
    pull_request: { number: 17 },
    repository: { full_name: repository },
    ...overrides,
  };
}

function provider(overrides = {}) {
  const calls = [];
  const response = {
    base: { ref: "dev" },
    body: "## Scope\n\n- Accepted issue: #51\n",
    head: { sha: head },
    number: 17,
    state: "open",
    updated_at: "2026-07-28T20:00:00Z",
    ...overrides,
  };
  return {
    calls,
    request: async (path) => {
      calls.push(path);
      return structuredClone(response);
    },
  };
}

test("routes a stable provider-derived PR wake-up without policy fields", async () => {
  const api = provider();
  const result = await resolveLifecycleWakeup({
    environment: environment(),
    event: event(),
    providerRequest: api.request,
  });
  assert.deepEqual(result, {
    exactHeadSha: head,
    issueNumber: 51,
    ok: true,
    pullRequestNumber: 17,
    wakeEvent: "pull_request_target",
  });
  assert.equal(api.calls.length, 2);
  assert.deepEqual(Object.keys(result).toSorted(), [
    "exactHeadSha",
    "issueNumber",
    "ok",
    "pullRequestNumber",
    "wakeEvent",
  ]);
});

test("fails closed before or during unstable provider routing", async () => {
  const unused = new Proxy(
    {},
    {
      get() {
        throw new Error("provider must not be called");
      },
    },
  );
  assert.equal(
    (
      await resolveLifecycleWakeup({
        environment: environment("push"),
        event: event(),
        providerRequest: unused,
      })
    ).reason,
    "unsupported_event",
  );
  assert.equal(
    (
      await resolveLifecycleWakeup({
        environment: environment(),
        event: event({ repository: { full_name: "attacker/repo" } }),
        providerRequest: unused,
      })
    ).reason,
    "repository_mismatch",
  );

  let reads = 0;
  const unstable = provider();
  unstable.request = async () => {
    reads += 1;
    const response = await provider({
      updated_at: `2026-07-28T20:00:0${reads}Z`,
    }).request("/ignored");
    return response;
  };
  assert.equal(
    (
      await resolveLifecycleWakeup({
        environment: environment(),
        event: event(),
        providerRequest: unstable.request,
      })
    ).reason,
    "pull_request_unstable",
  );
});

test("router workflow is read-only transport into the sole coordinator", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/lifecycle-wakeup.yml", import.meta.url),
    "utf8",
  );
  for (const marker of [
    "name: Lifecycle wake-up router",
    "pull_request_target:",
    "pull_request_review:",
    "pull_request_review_comment:",
    "issue_comment:",
    "check_run:",
    "workflow_run:",
    "workflow_dispatch:",
    "contents: read",
    "issues: read",
    "pull-requests: read",
    "node quality/lifecycle-wakeup-router.mjs",
    "uses: ./.github/workflows/issue-lifecycle.yml",
  ])
    assert.match(workflow, new RegExp(marker, "u"));
  for (const forbidden of [
    "issues: write",
    "statuses: write",
    "attestations: write",
    "id-token: write",
    "KEIKO_ISSUE_LIFECYCLE_ACTIVATION",
    "requested_target",
    "expected_source",
    "lifecycle-record-writer",
    "keiko-native-lifecycle-generation-request",
  ])
    assert.doesNotMatch(workflow, new RegExp(forbidden, "u"));
});
