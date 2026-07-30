import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateLifecycleRecoveryComment,
  boundedScheduledLocators,
  lifecycleRecoveryTargetAvailable,
  lifecycleWakeLocatorBytes,
  parseLifecycleRecoveryCommand,
  parseLifecycleWakeLocator,
  selectLifecycleRecoveryFallback,
  validateLifecycleWakeSource,
} from "./lifecycle-wake.mjs";

const repository = "oscharko-dev/Keiko-Native";
const commit = "a".repeat(40);
const target = "b".repeat(64);
const body = `/keiko-native lifecycle-recovery v1 target=sha256:${target}`;

function comment(overrides = {}) {
  return {
    id: 101,
    issueNumber: 51,
    body,
    createdAt: "2026-07-29T10:00:00Z",
    updatedAt: "2026-07-29T10:00:00Z",
    lastEditedAt: null,
    editor: null,
    includesCreatedEdit: false,
    author: { id: 159039192, login: "Niko4417", type: "User" },
    ...overrides,
  };
}

test("round-trips the exact bounded source locator and authenticates its closed source", () => {
  const locator = {
    repository,
    issue_number: 51,
    pull_request_number: null,
    source_workflow_path: ".github/workflows/issue-readiness.yml",
    source_run_id: 30444766777,
    source_run_attempt: 1,
    source_protected_dev_sha: commit,
  };
  const bytes = lifecycleWakeLocatorBytes(locator);
  assert.ok(bytes.length <= 512);
  assert.deepEqual(parseLifecycleWakeLocator(bytes), locator);
  assert.equal(
    validateLifecycleWakeSource(
      {
        id: locator.source_run_id,
        attempt: 1,
        repository,
        workflowPath: locator.source_workflow_path,
        name: "Issue readiness",
        event: "issues",
        headSha: commit,
        status: "completed",
        ref: "refs/heads/dev",
      },
      locator,
    ),
    "governance",
  );
});

test("treats pull-request source ref as correlation while authenticating protected workflow SHA", () => {
  const locator = {
    repository,
    issue_number: 51,
    pull_request_number: 17,
    source_workflow_path: ".github/workflows/pr-contract.yml",
    source_run_id: 30444766778,
    source_run_attempt: 1,
    source_protected_dev_sha: commit,
  };
  const run = {
    id: locator.source_run_id,
    attempt: locator.source_run_attempt,
    repository,
    workflowPath: locator.source_workflow_path,
    name: "Pull request contract",
    event: "pull_request_target",
    status: "completed",
    ref: "codex/51-protected-lifecycle",
    pullRequests: [
      {
        base: {
          ref: "dev",
          repository: "https://api.github.com/repos/oscharko-dev/Keiko-Native",
          sha: commit,
        },
        number: 17,
      },
    ],
  };
  assert.equal(validateLifecycleWakeSource(run, locator), "governance");
  for (const pullRequests of [
    [...run.pullRequests, ...run.pullRequests],
    [{ ...run.pullRequests[0], number: 18 }],
    [
      {
        ...run.pullRequests[0],
        base: { ...run.pullRequests[0].base, ref: "main" },
      },
    ],
    [
      {
        ...run.pullRequests[0],
        base: {
          ...run.pullRequests[0].base,
          repository: "https://api.github.com/repos/attacker/repo",
        },
      },
    ],
    [
      {
        ...run.pullRequests[0],
        base: { ...run.pullRequests[0].base, sha: "b".repeat(40) },
      },
    ],
  ])
    assert.throws(
      () => validateLifecycleWakeSource({ ...run, pullRequests }, locator),
      { code: "governance-source-unprotected" },
    );

  for (const pullRequestNumber of [null, 0, -1, "17"])
    assert.throws(
      () =>
        validateLifecycleWakeSource(
          { ...run, pullRequests: [] },
          { ...locator, pull_request_number: pullRequestNumber },
          commit,
        ),
      { code: "governance-source-unprotected" },
    );

  assert.equal(
    validateLifecycleWakeSource({ ...run, pullRequests: [] }, locator, commit),
    "governance",
  );
  for (const protectedCallerSha of [undefined, "b".repeat(40), "invalid"])
    assert.throws(
      () =>
        validateLifecycleWakeSource(
          { ...run, pullRequests: [] },
          locator,
          protectedCallerSha,
        ),
      { code: "governance-source-unprotected" },
    );
});

test("requires non-PR governance ref and head to bind the locator SHA", () => {
  const locator = {
    repository,
    issue_number: 51,
    pull_request_number: null,
    source_workflow_path: ".github/workflows/issue-readiness.yml",
    source_run_id: 30444766777,
    source_run_attempt: 1,
    source_protected_dev_sha: commit,
  };
  const run = {
    id: locator.source_run_id,
    attempt: locator.source_run_attempt,
    repository,
    workflowPath: locator.source_workflow_path,
    name: "Issue readiness",
    event: "issues",
    headSha: commit,
    status: "completed",
    ref: "refs/heads/dev",
  };
  for (const changed of [
    { ...run, ref: "refs/heads/main" },
    { ...run, headSha: "b".repeat(40) },
    { ...run, headSha: undefined },
  ])
    assert.throws(() => validateLifecycleWakeSource(changed, locator), {
      code: "governance-source-unprotected",
    });
});

test("authenticates only the exact never-edited recovery command and derives one identity", () => {
  assert.equal(parseLifecycleRecoveryCommand(body), target);
  for (const hostile of [` ${body}`, `${body}\n`, body.toUpperCase()])
    assert.equal(parseLifecycleRecoveryCommand(hostile), undefined);
  const first = comment();
  const result = authenticateLifecycleRecoveryComment({
    first,
    second: structuredClone(first),
    permissionFirst: "maintain",
    permissionSecond: "maintain",
    repositoryId: 123,
    issueNumber: 51,
  });
  assert.match(result.identity, /^[0-9a-f]{64}$/u);
  assert.equal(result.recoveryTargetIdentity, target);
  for (const changed of [
    comment({ updatedAt: "2026-07-29T10:00:01Z" }),
    comment({ lastEditedAt: "2026-07-29T10:00:01Z" }),
    comment({ editor: { id: 1 } }),
    comment({ includesCreatedEdit: true }),
    comment({ author: { id: 1, login: "Niko4417", type: "User" } }),
  ])
    assert.throws(() =>
      authenticateLifecycleRecoveryComment({
        first: changed,
        second: structuredClone(changed),
        permissionFirst: "maintain",
        permissionSecond: "maintain",
        repositoryId: 123,
        issueNumber: 51,
      }),
    );
});

test("prefilters actors and permissions before lowest-id fallback selection", () => {
  const comments = [
    comment({ id: 1, author: { id: 1, login: "attacker", type: "User" } }),
    comment({
      id: 2,
      author: { id: 59687448, login: "oscharko", type: "User" },
    }),
    comment({ id: 3 }),
  ];
  const selected = selectLifecycleRecoveryFallback(
    comments,
    new Map([
      [59687448, "read"],
      [159039192, "admin"],
    ]),
  );
  assert.equal(selected.id, 3);
});

test("enforces locator 200/201 and at-most-once recovery-target consumption", () => {
  assert.equal(boundedScheduledLocators([2, 1, 1], 8).length, 2);
  assert.throws(() =>
    boundedScheduledLocators(
      Array.from({ length: 201 }, (_, index) => index + 1),
      8,
    ),
  );
  assert.equal(lifecycleRecoveryTargetAvailable(target, []), true);
  assert.equal(
    lifecycleRecoveryTargetAvailable(target, [
      {
        authorized_request_identity: "c".repeat(64),
        recovery_target_identity: target,
      },
    ]),
    false,
  );
});
