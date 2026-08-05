import assert from "node:assert/strict";
import test from "node:test";

import { issueSchemaForLabels } from "./issue-contract.mjs";
import { validPullRequestBody } from "./pr-contract-test-fixture.mjs";
import {
  buildMigrationInventory,
  verifyMigrationInventory,
} from "./migration-inventory.mjs";

const repository = "oscharko-dev/Keiko-Native";
const dev = "d".repeat(40);
const head = "a".repeat(40);
const readiness = (issue, fingerprint, version = 1) => ({
  body: [
    "<!-- keiko-native-readiness -->",
    "### Issue readiness accepted",
    "",
    "- Status: `accepted`",
    `- Contract version: \`v${version}\``,
    `- Fingerprint: \`${fingerprint}\``,
  ].join("\n"),
  id: 10_000 + issue,
  createdAt: "2026-08-01T11:00:00.000Z",
  user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
});

function page(nodes, totalCount = nodes.length) {
  return {
    pages: [
      {
        cursor: null,
        endCursor: nodes.length === 0 ? null : "end-1",
        hasNextPage: false,
        nodes,
        totalCount,
      },
    ],
  };
}

function issue(number, lifecycle, overrides = {}) {
  const type = overrides.type ?? "task";
  const version = overrides.version ?? 1;
  const title = overrides.title ?? `Governed migration issue ${number}`;
  const body = issueSchemaForLabels([`type: ${type}`])
    .requiredHeadings.map((heading) => {
      if (heading === "Planning contract")
        return `## ${heading}\n\n- Contract version: \`v${version}\``;
      if (heading === "Execution Authority")
        return `## ${heading}\n\n- Exact delivery target: \`${overrides.target ?? "dev"}\``;
      if (heading === "Acceptance journey")
        return `## ${heading}\n\n- Applicability: Not applicable — migration fixture.\n- Actor: Maintainer`;
      if (heading === "Acceptance criteria")
        return `## ${heading}\n\n- [ ] AC1 — Inventory is exact.`;
      if (heading === "Verification commands")
        return `## ${heading}\n\n\`\`\`text\nnode --test quality/migration-inventory.test.mjs\n\`\`\``;
      if (heading === "Definition of Ready")
        return `## ${heading}\n\n- [x] Scope and verification are complete.`;
      return `## ${heading}\n\nComplete governed content for ${heading}.`;
    })
    .join("\n\n");
  return {
    assignees: overrides.assignees ?? ["Niko4417"],
    body,
    labels: [lifecycle, `type: ${type}`],
    number,
    state: overrides.state ?? "open",
    stateReason: overrides.stateReason ?? null,
    claim: overrides.claim ?? null,
    lastEditedAt: overrides.lastEditedAt ?? null,
    reopenedAt: overrides.reopenedAt ?? null,
    title,
    type,
    updatedAt: overrides.updatedAt ?? "2026-08-01T12:00:00.000Z",
    version,
    ...overrides,
  };
}

function pullRequest(number, issueNumber, overrides = {}) {
  return {
    base: { ref: overrides.target ?? "dev", sha: dev },
    body: `## Scope\n\n- Accepted issue: #${issueNumber}`,
    checks: {
      allPassing: true,
      complete: true,
      head,
      required: [
        {
          conclusion: "SUCCESS",
          name: "PR contract",
          producer: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
        },
        {
          conclusion: "SUCCESS",
          name: "Issue contract current",
          producer: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
        },
      ],
    },
    head: {
      ref: `codex/${issueNumber}-work`,
      repository,
      sha: head,
    },
    headCommit: { reason: "valid", verified: true },
    commitsVerified: true,
    isDraft: false,
    labels: ["status: pr open"],
    mergeCommit: null,
    mergeable: "MERGEABLE",
    merged: false,
    mergedBy: null,
    number,
    state: "open",
    title: `Deliver governed issue ${issueNumber}`,
    ...overrides,
  };
}

function snapshot() {
  const open = issue(30, "status: pr open", { target: "epic/9-migration" });
  const closed = issue(31, "status: ready", {
    state: "closed",
    stateReason: "completed",
  });
  const abandoned = issue(32, "status: blocked", {
    state: "closed",
    stateReason: "not_planned",
  });
  const pr = pullRequest(70, 30, { target: "epic/9-migration" });
  const merged = pullRequest(71, 31, {
    body: validPullRequestBody("dev")
      .replaceAll("#42", "#31")
      .replaceAll("issues/42#issuecomment-99", "issues/31#issuecomment-10031")
      .replaceAll("keiko/Keiko-Native", repository)
      .replaceAll("codex/42-governed-workspace", "codex/31-work")
      .replaceAll("c".repeat(40), head),
    checks: {
      allPassing: true,
      complete: true,
      head,
      required: [
        "Issue contract current",
        "PR contract",
        "Lifecycle handoff",
      ].map((name) => ({
        conclusion: "SUCCESS",
        name,
        producer: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
      })),
    },
    labels: ["status: ready for human review"],
    mergeCommit: {
      parents: [dev],
      reason: "valid",
      sha: "b".repeat(40),
      verified: true,
    },
    merged: true,
    mergedBy: "Niko4417",
    state: "closed",
  });
  const fingerprints = new Map(
    [open, closed, abandoned].map((item) => [
      item.number,
      // The production builder independently recomputes this value. Tests use
      // its exported preparation hook to avoid duplicating fingerprint rules.
      null,
    ]),
  );
  return {
    allowlistedMergers: ["Niko4417", "oscharko"],
    comments: new Map(),
    contracts: page([]),
    contractsProtectedDev: dev,
    issues: page([open, closed, abandoned]),
    labels: page([
      "status: new",
      "status: triaged",
      "status: ready",
      "status: in progress",
      "status: pr open",
      "status: ready for human review",
      "status: blocked",
      "status: waiting for user",
      "status: done",
      "type: task",
    ]),
    observedAt: "2026-08-01T12:00:00.000Z",
    protectedDev: dev,
    manifests: page([]),
    manifestsProtectedDev: dev,
    pullRequests: page([pr, merged]),
    repository,
    _fingerprints: fingerprints,
  };
}

async function acceptedSnapshot() {
  const input = snapshot();
  const prepared = buildMigrationInventory.prepare(input);
  assert.equal(prepared.ok, true);
  for (const item of prepared.issueFacts) {
    input._fingerprints.set(item.number, item.fingerprint);
    input.comments.set(
      item.number,
      page([readiness(item.number, item.fingerprint, item.version)]),
    );
  }
  return input;
}

test("builds the exact current-readiness-first inventory and reconciliation plan", async () => {
  const input = await acceptedSnapshot();
  const result = buildMigrationInventory(input);
  assert.equal(result.ok, true);
  assert.equal(result.publishable, true);
  assert.deepEqual(
    result.inventory.issues.map(({ classification, number }) => ({
      classification,
      number,
    })),
    [
      { classification: "migration-member", number: 30 },
      { classification: "completed", number: 31 },
      { classification: "closed-without-completion", number: 32 },
    ],
  );
  assert.deepEqual(result.reconciliation, [
    {
      current: ["status: pr open"],
      desired: ["status: pr open"],
      kind: "issue",
      number: 30,
    },
    {
      current: ["status: ready"],
      desired: ["status: done"],
      kind: "issue",
      number: 31,
    },
    { current: ["status: blocked"], desired: [], kind: "issue", number: 32 },
    {
      current: ["status: pr open"],
      desired: [],
      kind: "pull-request",
      number: 70,
    },
    {
      current: ["status: ready for human review"],
      desired: [],
      kind: "pull-request",
      number: 71,
    },
  ]);
  assert.equal(
    result.manifest.path,
    "docs/qa/repository-migration-manifest-v1.md",
  );
  assert.equal(result.manifest.digest.length, 64);
  assert.equal(result.manifest.entries.length, 1);
  assert.equal(result.manifest.entries[0].number, 30);
  assert.equal(result.manifest.entries[0].linkedPullRequest.number, 70);
  assert.equal(result.candidateInputs.length, 1);
  assert.equal(result.receiptInput.observations.length, 1);
  assert.doesNotMatch(
    JSON.stringify(result),
    /Governed migration issue|Execution Authority/u,
  );
  assert.equal(verifyMigrationInventory(input, result).ok, true);
});

test("dispositions open pull requests without an accepted issue locator", async () => {
  const input = await acceptedSnapshot();
  const open = pullRequest(72, 30, {
    body: "Automated dependency update without planning authority.",
    labels: [],
  });
  const closed = pullRequest(73, 30, {
    body: "Closed historical pull request without planning authority.",
    labels: [],
    state: "closed",
  });
  input.pullRequests.pages[0].nodes.push(open, closed);
  input.pullRequests.pages[0].totalCount += 2;

  const result = buildMigrationInventory(input);

  assert.equal(result.ok, true);
  assert.equal(result.publishable, false);
  assert.deepEqual(
    result.dispositions.filter(
      ({ code }) => code === "pull-request-association-missing",
    ),
    [
      {
        code: "pull-request-association-missing",
        kind: "pull-request",
        number: 72,
      },
    ],
  );
});

test("is deterministic under provider node ordering", async () => {
  const input = await acceptedSnapshot();
  const first = buildMigrationInventory(input);
  input.issues.pages[0].nodes.reverse();
  input.pullRequests.pages[0].nodes.reverse();
  input.labels.pages[0].nodes.reverse();
  const second = buildMigrationInventory(input);
  assert.equal(second.ok, true);
  assert.equal(second.manifest.digest, first.manifest.digest);
  assert.deepEqual(second, first);
});

test("fails closed on incomplete, duplicate, reordered, or drifting pagination", async () => {
  const cases = [
    (x) => (x.issues.pages[0].hasNextPage = true),
    (x) => x.issues.pages[0].nodes.push(x.issues.pages[0].nodes[0]),
    (x) => (x.issues.pages[0].totalCount += 1),
    (x) =>
      x.issues.pages.push({
        cursor: "wrong",
        endCursor: null,
        hasNextPage: false,
        nodes: [],
        totalCount: x.issues.pages[0].totalCount,
      }),
  ];
  for (const mutate of cases) {
    const input = await acceptedSnapshot();
    mutate(input);
    const result = buildMigrationInventory(input);
    assert.equal(result.ok, false);
    assert.equal(result.publishable, false);
    assert.equal(result.kind, "indeterminate");
  }
});

test("produces no publishable output for stale readiness and linked-PR drift", async () => {
  const stale = await acceptedSnapshot();
  stale.comments.get(30).pages[0].nodes[0].body = stale.comments
    .get(30)
    .pages[0].nodes[0].body.replace(/v1/u, "v2");
  const staleResult = buildMigrationInventory(stale);
  assert.equal(staleResult.ok, true);
  assert.equal(staleResult.publishable, false);
  assert.equal(staleResult.manifest, null);
  assert.ok(
    staleResult.dispositions.some((item) => item.code === "stale-readiness"),
  );

  const drift = await acceptedSnapshot();
  drift.pullRequests.pages[0].nodes[0].head.sha = "c".repeat(40);
  const driftResult = buildMigrationInventory(drift);
  assert.equal(driftResult.publishable, false);
  assert.ok(
    driftResult.dispositions.some(
      (item) => item.code === "pr-check-head-mismatch",
    ),
  );
});

test("rejects unknown lifecycle labels, bad signatures, and failed required checks", async () => {
  const mutations = [
    (x) => x.labels.pages[0].nodes.push("status: mystery"),
    (x) => (x.pullRequests.pages[0].nodes[0].headCommit.verified = false),
    (x) =>
      (x.pullRequests.pages[0].nodes[0].checks.required[0].conclusion =
        "FAILURE"),
  ];
  for (const mutate of mutations) {
    const input = await acceptedSnapshot();
    mutate(input);
    const result = buildMigrationInventory(input);
    assert.equal(result.publishable, false);
    assert.equal(result.manifest, null);
  }
});

test("rejects an invalid earlier pull-request commit signature", async () => {
  const input = await acceptedSnapshot();
  input.pullRequests.pages[0].nodes[0].commitsVerified = false;
  const result = buildMigrationInventory(input);
  assert.equal(result.publishable, false);
  assert.ok(
    result.dispositions.some(
      ({ code, number }) =>
        code === "pr-commit-signature-invalid" && number === 70,
    ),
  );
});

test("retains closed deleted-fork history without making it eligible", async () => {
  const input = await acceptedSnapshot();
  input.pullRequests.pages[0].nodes.push(
    pullRequest(72, 999, {
      body: "Closed historical pull request without planning authority.",
      head: { ref: "deleted-fork", repository: null, sha: head },
      mergeable: "UNKNOWN",
      state: "closed",
    }),
  );
  input.pullRequests.pages[0].totalCount += 1;
  const result = buildMigrationInventory(input);
  assert.equal(result.publishable, true);
  assert.equal(
    result.dispositions.some(({ number }) => number === 72),
    false,
  );
});

test("rejects pull requests from an unauthorized head repository", async () => {
  const input = await acceptedSnapshot();
  input.pullRequests.pages[0].nodes[0].head.repository = "attacker/fork";
  const result = buildMigrationInventory(input);
  assert.equal(result.publishable, false);
  assert.ok(
    result.dispositions.some(
      ({ code, number }) =>
        code === "pr-head-repository-mismatch" && number === 70,
    ),
  );
});

test("requires the exact canonical lifecycle label set", async () => {
  const input = await acceptedSnapshot();
  input.labels.pages[0].nodes = input.labels.pages[0].nodes.filter(
    (label) => label !== "status: triaged",
  );
  input.labels.pages[0].totalCount -= 1;
  assert.equal(
    buildMigrationInventory(input).code,
    "canonical-lifecycle-labels-missing",
  );
});

test("excludes planning states without readiness instead of dispositioning them", async () => {
  const input = await acceptedSnapshot();
  input.issues.pages[0].nodes.push(issue(33, "status: new", { assignees: [] }));
  input.issues.pages[0].totalCount += 1;
  input.comments.set(33, page([]));
  const result = buildMigrationInventory(input);
  assert.equal(result.publishable, true);
  assert.equal(
    result.inventory.issues.find(({ number }) => number === 33)?.classification,
    "planning-excluded",
  );
  assert.equal(
    result.dispositions.some(({ number }) => number === 33),
    false,
  );
});

test("fails closed on forged readiness in a planning state", async () => {
  const input = await acceptedSnapshot();
  const item = issue(33, "status: new", { assignees: [] });
  input.issues.pages[0].nodes.push(item);
  input.issues.pages[0].totalCount += 1;
  const prepared = buildMigrationInventory.prepare(input);
  const fingerprint = prepared.issueFacts.find(
    ({ number }) => number === 33,
  ).fingerprint;
  input.comments.set(
    33,
    page([
      readiness(33, fingerprint),
      {
        body: "<!-- keiko-native-readiness --> forged",
        createdAt: "2026-08-01T11:30:00.000Z",
        id: 20_033,
        user: { id: 7, login: "attacker", type: "User" },
      },
    ]),
  );
  const result = buildMigrationInventory(input);
  assert.equal(result.publishable, false);
  assert.ok(
    result.dispositions.some(
      ({ code, number }) => code === "readiness-forged" && number === 33,
    ),
  );
});

test("validates triaged classification before planning exclusion", async () => {
  const input = await acceptedSnapshot();
  input.issues.pages[0].nodes.push(
    issue(33, "status: triaged", { labels: ["status: triaged"] }),
  );
  input.issues.pages[0].totalCount += 1;
  input.comments.set(33, page([]));
  const result = buildMigrationInventory(input);
  assert.equal(result.publishable, false);
  assert.ok(
    result.dispositions.some(
      ({ code, number }) => code === "issue-type-ambiguous" && number === 33,
    ),
  );
});

test("rejects accepted readiness hidden behind a planning lifecycle label", async () => {
  for (const lifecycle of ["status: new", "status: triaged"]) {
    const input = await acceptedSnapshot();
    const item = issue(33, lifecycle, { assignees: [] });
    input.issues.pages[0].nodes.push(item);
    input.issues.pages[0].totalCount += 1;
    const prepared = buildMigrationInventory.prepare(input);
    const fingerprint = prepared.issueFacts.find(
      ({ number }) => number === 33,
    ).fingerprint;
    input.comments.set(33, page([readiness(33, fingerprint)]));
    const result = buildMigrationInventory(input);
    assert.equal(result.publishable, false);
    assert.ok(
      result.dispositions.some(
        ({ code, number }) =>
          code === "retained-lifecycle-invalid" && number === 33,
      ),
    );
  }
});

test("excludes paused work when no current readiness exists", async () => {
  for (const lifecycle of ["status: blocked", "status: waiting for user"]) {
    const input = await acceptedSnapshot();
    input.issues.pages[0].nodes.push(issue(33, lifecycle));
    input.issues.pages[0].totalCount += 1;
    input.comments.set(33, page([]));
    const result = buildMigrationInventory(input);
    assert.equal(result.publishable, true);
    assert.equal(
      result.inventory.issues.find(({ number }) => number === 33)
        ?.classification,
      "planning-excluded",
    );
  }
});

test("accepts paused retained work with at most one ineligible open pull request", async () => {
  const input = await acceptedSnapshot();
  const paused = issue(33, "status: blocked");
  input.issues.pages[0].nodes.push(paused);
  input.issues.pages[0].totalCount += 1;
  const prepared = buildMigrationInventory.prepare(input);
  const fingerprint = prepared.issueFacts.find(
    ({ number }) => number === 33,
  ).fingerprint;
  input.comments.set(33, page([readiness(33, fingerprint)]));
  input.pullRequests.pages[0].nodes.push(
    pullRequest(72, 33, {
      checks: {
        allPassing: false,
        complete: true,
        head,
        required: [],
      },
      headCommit: { reason: "invalid", verified: false },
      mergeable: "CONFLICTING",
    }),
  );
  input.pullRequests.pages[0].totalCount += 1;
  const result = buildMigrationInventory(input);
  assert.equal(result.publishable, true);
  assert.equal(
    result.manifest.entries.find(({ number }) => number === 33)
      .linkedPullRequest,
    null,
  );
});

test("accepts a failed handoff while the issue remains PR open", async () => {
  const input = await acceptedSnapshot();
  const pr = input.pullRequests.pages[0].nodes[0];
  pr.checks.allPassing = false;
  pr.checks.required.push({
    conclusion: "FAILURE",
    name: "Lifecycle handoff",
    producer: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
  });
  assert.equal(buildMigrationInventory(input).publishable, true);
});

test("rejects draft or unmergeable review-ready pull requests", async () => {
  for (const mutate of [
    (pr) => (pr.isDraft = true),
    (pr) => (pr.mergeable = "CONFLICTING"),
  ]) {
    const input = await acceptedSnapshot();
    input.issues.pages[0].nodes[0].labels = [
      "status: ready for human review",
      "type: task",
    ];
    const pr = input.pullRequests.pages[0].nodes[0];
    pr.checks.required.push({
      conclusion: "SUCCESS",
      name: "Lifecycle handoff",
      producer: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    });
    mutate(pr);
    assert.ok(
      buildMigrationInventory(input).dispositions.some(
        ({ code }) => code === "pr-review-state-ineligible",
      ),
    );
  }
});

test("requires a validated assignment claim for in-progress work", async () => {
  const input = await acceptedSnapshot();
  input.issues.pages[0].nodes[0].labels = ["status: in progress", "type: task"];
  input.pullRequests.pages[0].nodes = input.pullRequests.pages[0].nodes.filter(
    ({ number }) => number !== 70,
  );
  input.pullRequests.pages[0].totalCount -= 1;
  const result = buildMigrationInventory(input);
  assert.equal(result.publishable, false);
  assert.ok(
    result.dispositions.some(({ code }) => code === "assignment-claim-invalid"),
  );
});

test("invalidates readiness older than a body edit or reopen", async () => {
  for (const field of ["lastEditedAt", "reopenedAt"]) {
    const input = await acceptedSnapshot();
    input.issues.pages[0].nodes[0][field] = "2026-08-01T11:30:00.000Z";
    const result = buildMigrationInventory(input);
    assert.equal(result.publishable, false);
    assert.ok(
      result.dispositions.some(({ code }) => code === "stale-readiness"),
    );
  }
});

test("authenticates status producers and the review handoff", async () => {
  const input = await acceptedSnapshot();
  input.pullRequests.pages[0].nodes[0].checks.required[0].producer.login =
    "untrusted";
  assert.ok(
    buildMigrationInventory(input).dispositions.some(
      ({ code }) => code === "pr-required-check-producer-invalid",
    ),
  );

  const handoffMissing = await acceptedSnapshot();
  handoffMissing.issues.pages[0].nodes[0].labels = [
    "status: ready for human review",
    "type: task",
  ];
  assert.ok(
    buildMigrationInventory(handoffMissing).dispositions.some(
      ({ code }) => code === "pr-required-check-failed",
    ),
  );
});

test("requires canonical terminal delivery proof before classifying completion", async () => {
  const input = await acceptedSnapshot();
  input.pullRequests.pages[0].nodes[1].body =
    "## Scope\n\n- Accepted issue: #31";
  const result = buildMigrationInventory(input);
  assert.equal(
    result.inventory.issues.find(({ number }) => number === 31)?.classification,
    "closed-without-completion",
  );
  assert.ok(
    result.dispositions.some(({ code }) => code === "completion-unverifiable"),
  );

  const stale = await acceptedSnapshot();
  stale.issues.pages[0].nodes.find(({ number }) => number === 31).lastEditedAt =
    "2026-08-01T11:30:00.000Z";
  assert.equal(
    buildMigrationInventory(stale).inventory.issues.find(
      ({ number }) => number === 31,
    )?.classification,
    "closed-without-completion",
  );
});

test("selects one validated final delivery among sequential merged history", async () => {
  const input = await acceptedSnapshot();
  input.pullRequests.pages[0].nodes.push(
    pullRequest(69, 31, {
      body: "## Scope\n\n- Accepted issue: #31",
      checks: {
        allPassing: false,
        complete: false,
        head,
        required: [],
      },
      labels: [],
      mergeCommit: {
        parents: [dev],
        reason: "valid",
        sha: "c".repeat(40),
        verified: true,
      },
      merged: true,
      mergedBy: "Niko4417",
      state: "closed",
    }),
  );
  input.pullRequests.pages[0].totalCount += 1;
  const result = buildMigrationInventory(input);
  assert.equal(result.publishable, true);
  assert.equal(
    result.inventory.issues.find(({ number }) => number === 31)?.classification,
    "completed",
  );
});

test("rejects completion while an associated delivery remains open", async () => {
  const input = await acceptedSnapshot();
  input.pullRequests.pages[0].nodes.push(pullRequest(72, 31));
  input.pullRequests.pages[0].totalCount += 1;
  const result = buildMigrationInventory(input);
  assert.equal(result.publishable, false);
  assert.equal(
    result.inventory.issues.find(({ number }) => number === 31)?.classification,
    "closed-without-completion",
  );
  assert.ok(
    result.dispositions.some(
      ({ code, number }) => code === "completion-unverifiable" && number === 31,
    ),
  );
});

test("keeps closed-unmerged attempts as non-blocking history", async () => {
  const input = await acceptedSnapshot();
  input.pullRequests.pages[0].nodes.push(
    pullRequest(72, 30, {
      checks: {
        allPassing: false,
        complete: false,
        head,
        required: [],
      },
      headCommit: { reason: "invalid", verified: false },
      mergeable: "UNKNOWN",
      state: "closed",
    }),
  );
  input.pullRequests.pages[0].totalCount += 1;
  const result = buildMigrationInventory(input);
  assert.equal(result.publishable, true);
  assert.equal(
    result.dispositions.some(
      ({ kind, number }) => kind === "pull-request" && number === 72,
    ),
    false,
  );
});

test("ignores obsolete contracts on non-completed closures", async () => {
  const input = await acceptedSnapshot();
  const closed = input.issues.pages[0].nodes.find(
    ({ number }) => number === 32,
  );
  closed.labels = ["status: blocked"];
  const result = buildMigrationInventory(input);
  assert.equal(result.publishable, true);
  assert.equal(
    result.dispositions.some(
      ({ kind, number }) => kind === "issue" && number === 32,
    ),
    false,
  );
});

test("advances one linear immutable migration-manifest chain", async () => {
  const input = await acceptedSnapshot();
  const predecessor = {
    digest: "c".repeat(64),
    mode: "100644",
    path: "docs/qa/repository-migration-manifest-v1.md",
    predecessor: null,
  };
  input.manifests = page([predecessor]);
  const result = buildMigrationInventory(input);
  assert.equal(result.publishable, true);
  assert.equal(
    result.manifest.path,
    "docs/qa/repository-migration-manifest-v2.md",
  );
  assert.deepEqual(result.manifest.predecessor, {
    digest: predecessor.digest,
    path: predecessor.path,
  });
  assert.deepEqual(JSON.parse(result.manifest.bytes), {
    entries: result.manifest.entries,
    predecessor: result.manifest.predecessor,
  });

  const invalid = await acceptedSnapshot();
  invalid.manifests = page([
    predecessor,
    {
      digest: "e".repeat(64),
      mode: "100644",
      path: "docs/qa/repository-migration-manifest-v2.md",
      predecessor: { digest: "f".repeat(64), path: predecessor.path },
    },
  ]);
  assert.equal(
    buildMigrationInventory(invalid).code,
    "migration-manifest-chain-invalid",
  );
});

test("publishes an exact empty terminal manifest", () => {
  const input = snapshot();
  input.issues = page([]);
  input.pullRequests = page([]);
  input.comments = new Map();
  const result = buildMigrationInventory(input);
  assert.equal(result.publishable, true);
  assert.deepEqual(result.manifest.entries, []);
  assert.deepEqual(result.receiptInput.observations, []);
});

test("independent verification rejects changed immutable output", async () => {
  const input = await acceptedSnapshot();
  const result = buildMigrationInventory(input);
  result.manifest.entries[0].linkedPullRequest.head = "f".repeat(40);
  assert.deepEqual(verifyMigrationInventory(input, result), {
    code: "inventory-output-mismatch",
    ok: false,
  });
});
