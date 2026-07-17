import assert from "node:assert/strict";
import test from "node:test";

import {
  pullRequestIssueNumber,
  validatePullRequestContract,
} from "./pr-contract.mjs";
import {
  validPullRequestBody,
  validPullRequestFixture,
} from "./pr-contract-test-fixture.mjs";

test("accepts a current lifecycle-eligible issue and complete PR evidence", () => {
  assert.deepEqual(validatePullRequestContract(validPullRequestFixture()), {
    failures: [],
  });
  const reviewFixture = validPullRequestFixture();
  reviewFixture.issue.labels = [
    { name: "type: task" },
    { name: "status: ready for human review" },
  ];
  assert.deepEqual(validatePullRequestContract(reviewFixture), {
    failures: [],
  });
});

test("parses short and exact issue references", () => {
  assert.equal(pullRequestIssueNumber(validPullRequestBody()), 42);
  assert.equal(
    pullRequestIssueNumber(
      validPullRequestBody().replace(
        "#42",
        "https://github.com/keiko/Keiko-Native/issues/42",
      ),
    ),
    42,
  );
  assert.equal(
    pullRequestIssueNumber("## Scope\n- Accepted issue: later"),
    undefined,
  );
});

test("rejects stale readiness, wrong delivery, and unready issue state", () => {
  const fixture = validPullRequestFixture();
  fixture.issue.state = "closed";
  fixture.issue.labels = [{ name: "type: task" }];
  fixture.pullRequest.base.ref = "epic/42-shell";
  fixture.comments[0].body = fixture.comments[0].body.replace(
    /[0-9a-f]{64}/u,
    "b".repeat(64),
  );
  fixture.pullRequest.body = fixture.pullRequest.body.replace(
    "c".repeat(40),
    "d".repeat(40),
  );
  const failures = validatePullRequestContract(fixture).failures.join("\n");
  assert.match(failures, /Accepted target branch does not match/u);
  assert.match(failures, /must cite the pull-request head SHA/u);
  assert.match(failures, /must remain open/u);
  assert.match(failures, /exactly one lifecycle status label/u);
  assert.match(failures, /current matching accepted readiness/u);
  assert.match(failures, /delivery target/u);
});

test("rejects every lifecycle state that is not PR eligible", () => {
  for (const label of [
    "status: new",
    "status: triaged",
    "status: ready",
    "status: in progress",
    "status: blocked",
    "status: waiting for user",
    "status: done",
  ]) {
    const fixture = validPullRequestFixture();
    fixture.issue.labels = [{ name: "type: task" }, { name: label }];
    assert.match(
      validatePullRequestContract(fixture).failures.join("\n"),
      /not pull-request eligible/u,
      label,
    );
  }
});

test("rejects zero-label and multi-label lifecycle reloads", () => {
  const zero = validPullRequestFixture();
  zero.issue.labels = [{ name: "type: task" }];
  assert.match(
    validatePullRequestContract(zero).failures.join("\n"),
    /exactly one lifecycle status label/u,
  );

  const multi = validPullRequestFixture();
  multi.issue.labels.push({ name: "status: ready" });
  assert.match(
    validatePullRequestContract(multi).failures.join("\n"),
    /exactly one lifecycle status label/u,
  );
});

test("rejects incomplete PR evidence and unresolved template choices", () => {
  const fixture = validPullRequestFixture();
  fixture.pullRequest.title = "short";
  fixture.pullRequest.body = fixture.pullRequest.body
    .replace(
      `| AC1 | quality/pr-contract.test.mjs | ${"c".repeat(40)} | Pass |`,
      "| AC1 | | | |",
    )
    .replace(
      "- Applicability: Required",
      "- Applicability: `Required | Not applicable`",
    )
    .replace("- [x] `npm run quality`", "- [ ] `npm run quality`")
    .replace("npm run quality — passed", "");
  const failures = validatePullRequestContract(fixture).failures.join("\n");
  assert.match(failures, /title is missing/u);
  assert.match(failures, /unresolved inline option/u);
  assert.match(failures, /evidence has no complete/u);
  assert.match(failures, /applicability/u);
  assert.match(failures, /npm run quality/u);
  assert.match(failures, /evidence block is empty/u);
});

test("rejects wrapped empty PR fields and multiline choices", () => {
  const fixture = validPullRequestFixture();
  fixture.pullRequest.body +=
    "\n\n- Required platform and partial\n  failure evidence:\n\n- Choice: `one |\n  two`";
  const failures = validatePullRequestContract(fixture).failures.join("\n");
  assert.match(failures, /required pull-request field is empty/u);
  assert.match(failures, /unresolved inline option list/u);
});

test("requires the additional child-delivery attestations for epic targets", () => {
  const fixture = validPullRequestFixture("epic/42-shell");
  assert.deepEqual(validatePullRequestContract(fixture).failures, []);
  fixture.pullRequest.body = fixture.pullRequest.body.replace(
    "- [x] The accepted issue authorizes this epic-branch target.",
    "- [ ] The accepted issue authorizes this epic-branch target.",
  );
  assert.match(
    validatePullRequestContract(fixture).failures.join("\n"),
    /epic-branch attestation/u,
  );
});

test("fails closed when no accepted issue can be loaded", () => {
  const fixture = validPullRequestFixture();
  fixture.issue = undefined;
  assert.match(
    validatePullRequestContract(fixture).failures.join("\n"),
    /could not be loaded/u,
  );
});
