import assert from "node:assert/strict";
import test from "node:test";
import {
  publicationIdentityFailure,
  validateSnapshotReceipt,
} from "./publication-contract-schema.mjs";
import { publicationResultMatrix } from "./publication-contract.mjs";
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const pathA = "docs/contracts/task-30-v2-r1.md";
const repository = "oscharko-dev/Keiko-Native";
export function ordinaryReceipt() {
  return {
    candidates: [{ digest: digestA, mode: "100644", path: pathA }],
    observations: [
      {
        candidatePath: pathA,
        fingerprint: digestB,
        lifecycleLabels: ["status: new"],
        linkedPullRequest: null,
        number: 30,
        predecessor: null,
        readiness: null,
        readinessProducer: null,
        recoveries: [],
        revision: 1,
        state: "open",
        type: "task",
        version: 2,
      },
    ],
    pullRequest: 77,
    target: "dev",
    terminalManifest: null,
  };
}
function identityFixture() {
  const base = "1".repeat(40);
  const head = "2".repeat(40);
  const mergeSha = "3".repeat(40);
  const payload = "verified signed payload";
  return {
    allowlistedMergers: ["Niko"],
    commit: {
      parents: [{ sha: base, tree: "4".repeat(40) }],
      sha: mergeSha,
      signedPayload: payload,
      tree: "5".repeat(40),
      verification: {
        payload,
        reason: "valid",
        signer: "github-web-flow",
        verified: true,
      },
    },
    pullRequest: {
      base,
      baseRef: "dev",
      head,
      merged: true,
      mergedBy: "Niko",
      mergeSha,
      number: 30,
      state: "closed",
    },
    repository: "oscharko-dev/Keiko-Native",
    validatedGroup: {
      base,
      head,
      prefixTree: "4".repeat(40),
      resultTree: "5".repeat(40),
    },
  };
}
test("requires canonical merged PR facts and the exact verified payload", () => {
  assert.equal(publicationIdentityFailure(identityFixture()), undefined);
  const actor = (value) => (input) => {
    input.pullRequest.mergedBy = value;
    input.allowlistedMergers = [value];
  };
  const mutations = [
    (x) => delete x.pullRequest.state,
    (x) => (x.pullRequest.state = "open"),
    (x) => delete x.pullRequest.merged,
    (x) => (x.pullRequest.merged = false),
    (x) => delete x.pullRequest.baseRef,
    (x) => (x.pullRequest.baseRef = "main"),
    (x) => delete x.commit.verification.payload,
    (x) => (x.commit.verification.payload = null),
    (x) => (x.commit.verification.payload = "forged payload"),
    (x) => (x.commit.signedPayload = "forged payload"),
    (x) => delete x.commit.verification.signer,
    (x) => (x.commit.verification.signer = "Mallory"),
    actor(undefined),
    actor(""),
    actor(7),
  ];
  for (const mutate of mutations) {
    const input = identityFixture();
    mutate(input);
    assert.notEqual(publicationIdentityFailure(input), undefined);
  }
});
function matrixIdentity(lane) {
  return {
    base: digestA,
    head: digestB,
    lane,
    pullRequest: 77,
    repository: "oscharko-dev/Keiko-Native",
  };
}
function matrixSuccess(lane) {
  return { binding: matrixIdentity(lane), ok: true };
}
test("binds every result context to the classified head identity", () => {
  const classification = (lane) => ({
    binding: matrixIdentity(lane),
    lane,
    ok: true,
  });
  const normal = publicationResultMatrix({
    classification: classification("normal"),
    normal: {
      issueContractCurrent: matrixSuccess("normal"),
      prContract: matrixSuccess("normal"),
    },
  });
  assert.equal(normal.contexts["Contract publication"], "not_applicable");
  const publication = publicationResultMatrix({
    classification: classification("publication"),
    publication: matrixSuccess("publication"),
  });
  assert.equal(publication.contexts["Contract publication"], "success");
  assert.equal(publication.readinessClaim, false);
  const context = (result) =>
    publicationResultMatrix({
      classification: classification("publication"),
      publication: result,
    }).contexts["Contract publication"];
  for (const key of ["repository", "pullRequest", "base", "head", "lane"]) {
    const missing = matrixSuccess("publication");
    delete missing.binding[key];
    assert.equal(context(missing), "failure");
    const stale = matrixSuccess("publication");
    stale.binding[key] = null;
    assert.equal(context(stale), "failure");
  }
  for (const input of [
    {
      classification: { lane: "publication", ok: true },
      publication: { ok: true },
    },
    {
      classification: classification("normal"),
      normal: { issueContractCurrent: { ok: true }, prContract: { ok: true } },
    },
  ]) {
    assert.equal(
      publicationResultMatrix(input).contexts["Contract publication"],
      "failure",
    );
  }
});
test("normalizes a closed ordinary snapshot receipt schema", () => {
  const receipt = ordinaryReceipt();
  const result = validateSnapshotReceipt(receipt);
  assert.equal(result.binding.submode, "ordinary");
});
test("derives migration only from readiness, lifecycle, and manifest evidence", () => {
  const receipt = ordinaryReceipt();
  receipt.observations[0].lifecycleLabels = ["status: ready"];
  receipt.observations[0].readiness =
    "https://github.com/oscharko-dev/Keiko-Native/issues/30#issuecomment-123";
  receipt.observations[0].readinessProducer =
    "issue-readiness.yml@protected-dev";
  receipt.terminalManifest = {
    digest: "c".repeat(64),
    path: "docs/qa/repository-migration-manifest-v1.md",
  };
  assert.equal(
    validateSnapshotReceipt(receipt, repository).binding.submode,
    "migration",
  );
  for (const changed of [
    { ...receipt, terminalManifest: null },
    {
      ...receipt,
      observations: [{ ...receipt.observations[0], readiness: null }],
    },
    {
      ...receipt,
      observations: [
        { ...receipt.observations[0], lifecycleLabels: ["status: new"] },
      ],
    },
  ]) {
    assert.equal(validateSnapshotReceipt(changed, repository).ok, false);
  }
});
test("supports multiple sorted issues and exact candidate path identities", () => {
  const receipt = ordinaryReceipt();
  const secondPath = "docs/contracts/task-31-v1-r1.md";
  receipt.observations.push({
    ...receipt.observations[0],
    candidatePath: secondPath,
    fingerprint: "d".repeat(64),
    number: 31,
    predecessor: null,
    version: 1,
  });
  receipt.candidates.push({
    digest: "e".repeat(64),
    mode: "100644",
    path: secondPath,
  });
  assert.equal(validateSnapshotReceipt(receipt).ok, true);
  receipt.candidates[1].digest = digestA;
  assert.equal(validateSnapshotReceipt(receipt).ok, false);
  receipt.candidates[1].digest = "e".repeat(64);
  receipt.candidates[1].path = "docs/contracts/task-32-v1-r1.md";
  assert.equal(
    validateSnapshotReceipt(receipt).rejection.code,
    "candidate_identity_mismatch",
  );
});
test("rejects unknown, missing, raw, malformed, and unauthorized receipt data", () => {
  const receipt = ordinaryReceipt();
  const changedObservation = (change) => ({
    ...receipt,
    observations: [{ ...receipt.observations[0], ...change }],
  });
  const explosive = ordinaryReceipt();
  Object.defineProperty(explosive, "candidates", {
    get() {
      throw new Error("SECRET");
    },
  });
  const invalid = [
    null,
    { ...receipt, body: "raw customer content" },
    { ...receipt, target: "main" },
    { ...receipt, pullRequest: 0 },
    { ...receipt, candidates: [] },
    { ...receipt, observations: [] },
    { ...receipt, terminalManifest: "bad" },
    {
      ...receipt,
      observations: [{ ...receipt.observations[0], fingerprint: "SECRET" }],
    },
    {
      ...receipt,
      observations: [{ ...receipt.observations[0], lifecycleLabels: [] }],
    },
    {
      ...receipt,
      observations: [{ ...receipt.observations[0], readiness: "SECRET" }],
    },
    {
      ...receipt,
      observations: [{ ...receipt.observations[0], recoveries: null }],
    },
    {
      ...receipt,
      observations: [
        {
          ...receipt.observations[0],
          predecessor: { digest: "bad", path: pathA },
        },
      ],
    },
    { ...receipt, candidates: [{ ...receipt.candidates[0], mode: "120000" }] },
    changedObservation({ extra: true }),
    changedObservation({ candidatePath: "bad" }),
    changedObservation({ number: 31 }),
    changedObservation({ readiness: 7 }),
    explosive,
  ];
  for (const value of invalid) {
    const result = validateSnapshotReceipt(value);
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.rejection.message, /SECRET|customer/iu);
  }
});
test("rejects replayed, unsorted, conflicting, and inconsistent sets", () => {
  const receipt = ordinaryReceipt();
  const observation = receipt.observations[0];
  const candidate = receipt.candidates[0];
  const predecessor = ordinaryReceipt();
  predecessor.observations[0].predecessor = {
    digest: digestB,
    path: "docs/contracts/task-30-v1-r1.md",
  };
  assert.equal(validateSnapshotReceipt(predecessor).ok, true);
  for (const changed of [
    { ...receipt, observations: [observation, observation] },
    { ...receipt, candidates: [candidate, { ...candidate, digest: digestB }] },
    {
      ...receipt,
      candidates: [
        candidate,
        {
          digest: digestB,
          mode: "100644",
          path: "docs/contracts/task-31-v1-r1.md",
        },
      ],
    },
    {
      ...receipt,
      observations: [
        { ...observation, lifecycleLabels: ["status: ready", "status: new"] },
      ],
    },
    {
      ...receipt,
      observations: [
        {
          ...observation,
          predecessor: { digest: digestA, path: pathA },
        },
      ],
    },
    {
      ...receipt,
      observations: [
        {
          ...observation,
          recoveries: [
            { digest: digestA, path: "docs/contracts/task-30-v2-r3.md" },
            { digest: digestB, path: "docs/contracts/task-30-v2-r2.md" },
          ],
        },
      ],
    },
  ]) {
    assert.equal(validateSnapshotReceipt(changed).ok, false);
  }
});
function historyPath(type, version, revision, issue = 30) {
  return `docs/contracts/${type}-${issue}-v${version}-r${revision}.md`;
}
function historyBinding(type, version, revision, digest, issue = 30) {
  return { digest, path: historyPath(type, version, revision, issue) };
}
function historyReceipt(type, version, revision, predecessor, recoveries = []) {
  const receipt = ordinaryReceipt();
  const candidatePath = historyPath(type, version, revision);
  Object.assign(receipt.observations[0], {
    candidatePath,
    predecessor,
    recoveries,
    revision,
    type,
    version,
  });
  receipt.candidates[0].path = candidatePath;
  return receipt;
}
test("rejects contradictory predecessor and recovery histories", () => {
  const b = historyBinding,
    h = historyReceipt;
  const [c, d] = ["c", "d"].map((value) => value.repeat(64));
  for (const value of [
    h("task", 9, 3, null, [b("task", 9, 1, c), b("task", 9, 2, d)]),
    h("task", 2, 3, b("task", 2, 1, digestB), [b("task", 2, 2, c)]),
    h("epic", 2, 2, b("task", 1, 3, digestB), [b("epic", 2, 1, c)]),
  ])
    assert.equal(validateSnapshotReceipt(value).ok, true);
  for (const value of [
    h("task", 9, 7, null),
    h("task", 2, 3, b("epic", 2, 1, digestB), [b("task", 2, 2, c)]),
    h("task", 2, 3, b("task", 2, 1, digestB, 99), [b("task", 2, 2, c)]),
    h("task", 2, 3, b("task", 2, 1, digestB), [b("task", 2, 2, c, 99)]),
    h("task", 2, 3, b("task", 2, 1, digestB), [b("epic", 2, 2, c)]),
    h("task", 2, 3, b("task", 2, 1, digestB), [b("task", 2, 3, c)]),
    h("task", 2, 3, b("task", 2, 1, digestB), [b("task", 2, 1, c)]),
    h("task", 2, 4, b("task", 2, 1, digestB), [b("task", 2, 3, c)]),
    h("task", 2, 3, b("task", 2, 1, digestB), [
      b("task", 2, 2, c),
      b("task", 2, 4, d),
    ]),
    h("task", 2, 4, b("task", 2, 1, digestB), [
      b("task", 2, 2, c),
      b("task", 2, 3, c),
    ]),
    h("task", 3, 2, b("task", 1, 1, digestB), [b("task", 3, 1, c)]),
    h("task", 2, 2, b("task", 2, 1, digestA)),
    h("task", 2, 3, b("task", 2, 1, digestB), [b("task", 2, 2, digestA)]),
    h("task", 2, 3, b("task", 2, 1, digestB), [b("task", 2, 2, digestB)]),
  ])
    assert.equal(validateSnapshotReceipt(value).ok, false);
});
