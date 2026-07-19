import assert from "node:assert/strict";
import test from "node:test";

import { validateContractChain } from "./repository-contract-chain.mjs";

const digestA = "a".repeat(64);

function contract(path, digest, supersedes = null, recoveries = []) {
  return { digest, path, recoveries, state: "authoritative", supersedes };
}

function quarantine(path, digest) {
  return { digest, path, state: "quarantined" };
}

function reference(item) {
  return { digest: item.digest, path: item.path };
}

function rejectionCode(contracts, quarantined = []) {
  return validateContractChain({ contracts, quarantined }).rejection?.code;
}

test("selects the sole terminal across semantic and recovered revisions", () => {
  const first = contract("docs/contracts/task-35-v1-r1.md", "1".repeat(64));
  const failed = quarantine("docs/contracts/task-35-v2-r1.md", "2".repeat(64));
  const recovered = contract(
    "docs/contracts/task-35-v2-r2.md",
    "3".repeat(64),
    reference(first),
    [reference(failed)],
  );
  const terminal = contract(
    "docs/contracts/task-35-v2-r3.md",
    "4".repeat(64),
    reference(recovered),
  );
  assert.deepEqual(
    validateContractChain({
      contracts: [terminal, first, recovered],
      quarantined: [failed],
    }),
    { ok: true, terminal },
  );
});

test("keeps semantic type reclassification in the issue-wide chain", () => {
  const first = contract("docs/contracts/task-35-v1-r1.md", "1".repeat(64));
  const terminal = contract(
    "docs/contracts/defect-35-v2-r1.md",
    "2".repeat(64),
    reference(first),
  );
  assert.deepEqual(
    validateContractChain({ contracts: [first, terminal], quarantined: [] }),
    { ok: true, terminal },
  );
  const invalid = contract(
    "docs/contracts/defect-35-v1-r2.md",
    "3".repeat(64),
    reference(first),
  );
  assert.equal(
    rejectionCode([first, invalid]),
    "type_change_requires_semantic_version",
  );
});

test("binds quarantine attempts to their semantic version type", () => {
  const first = contract("docs/contracts/task-35-v1-r1.md", "1".repeat(64));
  const wrongRecovery = quarantine(
    "docs/contracts/task-35-v2-r1.md",
    "2".repeat(64),
  );
  const retry = contract(
    "docs/contracts/defect-35-v2-r2.md",
    "3".repeat(64),
    reference(first),
    [reference(wrongRecovery)],
  );
  assert.equal(
    rejectionCode([first, retry], [wrongRecovery]),
    "unexplained_revision_gap",
  );
  const wrongPending = quarantine(
    "docs/contracts/defect-35-v1-r2.md",
    "4".repeat(64),
  );
  assert.equal(rejectionCode([first], [wrongPending]), "orphan_quarantine");
  const nextFirst = quarantine(
    "docs/contracts/defect-35-v2-r1.md",
    "5".repeat(64),
  );
  const nextWrong = quarantine(
    "docs/contracts/task-35-v2-r2.md",
    "6".repeat(64),
  );
  assert.equal(
    rejectionCode([first], [nextFirst, nextWrong]),
    "orphan_quarantine",
  );
  const nextValid = quarantine(
    "docs/contracts/defect-35-v2-r2.md",
    "7".repeat(64),
  );
  assert.equal(
    validateContractChain({
      contracts: [first],
      quarantined: [nextValid, nextFirst],
    }).ok,
    true,
  );
});

test("rejects forks, duplicate predecessors, cycles, and replayed contracts", () => {
  const first = contract("docs/contracts/task-35-v1-r1.md", "1".repeat(64));
  const second = contract(
    "docs/contracts/task-35-v2-r1.md",
    "2".repeat(64),
    reference(first),
  );
  const competingRoot = contract(
    "docs/contracts/task-35-v3-r1.md",
    "3".repeat(64),
  );
  assert.equal(rejectionCode([first, second, competingRoot]), "forked_chain");

  const competingSuccessor = contract(
    "docs/contracts/task-35-v2-r2.md",
    "4".repeat(64),
    reference(first),
  );
  assert.equal(
    rejectionCode([first, second, competingSuccessor]),
    "duplicate_predecessor",
  );

  first.supersedes = reference(second);
  assert.equal(rejectionCode([first, second]), "cyclic_chain");
  assert.equal(rejectionCode([second, second]), "replayed_contract");
});

test("rejects stale links, unexplained gaps, and invalid node states", () => {
  const first = contract("docs/contracts/task-35-v1-r1.md", "1".repeat(64));
  const gap = contract(
    "docs/contracts/task-35-v2-r2.md",
    "3".repeat(64),
    reference(first),
  );
  assert.equal(rejectionCode([first, gap]), "unexplained_revision_gap");

  gap.supersedes = { digest: "9".repeat(64), path: first.path };
  assert.equal(rejectionCode([first, gap]), "stale_predecessor");
  first.state = "quarantined";
  assert.equal(rejectionCode([first]), "non_authoritative_contract");

  const invalidQuarantine = { ...first, state: "authoritative" };
  first.state = "authoritative";
  assert.equal(
    rejectionCode([first], [invalidQuarantine]),
    "unverified_quarantine",
  );
});

test("requires the exact complete quarantine recovery set", () => {
  const first = contract("docs/contracts/task-35-v1-r1.md", "1".repeat(64));
  const q1 = quarantine("docs/contracts/task-35-v2-r1.md", "2".repeat(64));
  const q2 = quarantine("docs/contracts/task-35-v2-r2.md", "3".repeat(64));
  const retry = contract(
    "docs/contracts/task-35-v2-r3.md",
    "4".repeat(64),
    reference(first),
    [reference(q1), reference(q2)],
  );
  const chain = (recoveries, quarantined = [q1, q2]) =>
    rejectionCode([first, { ...retry, recoveries }], quarantined);

  assert.equal(chain([reference(q1)]), "incomplete_recovery");
  assert.equal(
    chain([...retry.recoveries, reference(q2)]),
    "duplicate_recovery",
  );
  assert.equal(
    chain([reference(q1), { ...reference(q2), digest: digestA }]),
    "conflicting_recovery",
  );
  assert.equal(
    chain([
      ...retry.recoveries,
      { digest: digestA, path: "docs/contracts/task-35-v9-r1.md" },
    ]),
    "unexpected_recovery",
  );
  assert.equal(chain([reference(q2), reference(q1)]), "unsorted_recovery");
  assert.equal(
    chain([
      reference(q1),
      { digest: q2.digest, path: "docs/contracts/task-35-v2-r9.md" },
    ]),
    "unexpected_recovery",
  );
  assert.equal(chain(retry.recoveries, [q1]), "unexplained_revision_gap");
  assert.equal(chain(undefined), "invalid_recovery");
  assert.equal(chain([reference(q1), null]), "invalid_recovery");
});

test("fails closed on malformed, empty, mixed, and replayed chains", () => {
  const first = contract("docs/contracts/task-35-v1-r1.md", "1".repeat(64));
  assert.equal(validateContractChain().rejection.code, "invalid_chain_input");
  assert.equal(rejectionCode([]), "empty_chain");
  assert.equal(rejectionCode([null]), "invalid_chain_input");
  assert.equal(
    rejectionCode([{ ...first, path: "SECRET" }]),
    "invalid_contract_identity",
  );
  assert.equal(
    rejectionCode([{ ...first, digest: "SECRET" }]),
    "invalid_contract_identity",
  );
  assert.equal(
    rejectionCode([{ ...first, supersedes: { digest: digestA, path: "bad" } }]),
    "invalid_predecessor",
  );
  assert.equal(
    rejectionCode([{ ...first, supersedes: "SECRET" }]),
    "invalid_predecessor",
  );
  const otherIssue = quarantine(
    "docs/contracts/task-36-v1-r1.md",
    "2".repeat(64),
  );
  assert.equal(rejectionCode([first], [otherIssue]), "mixed_issue_chain");
  const q1 = quarantine("docs/contracts/task-35-v2-r1.md", "7".repeat(64));
  assert.equal(rejectionCode([first], [q1, q1]), "replayed_quarantine");
  assert.equal(
    rejectionCode([first], [quarantine(first.path, "8".repeat(64))]),
    "conflicting_contract_state",
  );
  assert.equal(
    rejectionCode(
      [first],
      [quarantine("docs/contracts/task-35-v2-r1.md", first.digest)],
    ),
    "conflicting_contract_state",
  );
  const digestReplay = contract(
    "docs/contracts/task-35-v2-r1.md",
    first.digest,
  );
  assert.equal(rejectionCode([first, digestReplay]), "replayed_contract");
});

test("rejects non-monotonic semantic versions and stale predecessors", () => {
  const first = contract("docs/contracts/task-35-v1-r1.md", "1".repeat(64));
  const skippedRoot = contract(
    "docs/contracts/task-35-v2-r1.md",
    "3".repeat(64),
  );
  assert.equal(rejectionCode([skippedRoot]), "unexplained_semantic_gap");
  const skippedVersion = contract(
    "docs/contracts/task-35-v3-r1.md",
    "4".repeat(64),
    reference(first),
  );
  assert.equal(
    rejectionCode([first, skippedVersion]),
    "unexplained_semantic_gap",
  );
  const second = contract(
    "docs/contracts/task-35-v2-r1.md",
    "5".repeat(64),
    reference(first),
  );
  const missingPredecessor = contract(
    "docs/contracts/task-35-v2-r1.md",
    "8".repeat(64),
    {
      digest: first.digest,
      path: "docs/contracts/task-35-v1-r9.md",
    },
  );
  assert.equal(rejectionCode([first, missingPredecessor]), "stale_predecessor");
  const stale = contract(
    "docs/contracts/task-35-v1-r2.md",
    "6".repeat(64),
    reference(second),
  );
  assert.equal(rejectionCode([first, second, stale]), "stale_predecessor");
});

test("rejects an enormous safe-integer revision gap without iterating it", () => {
  const first = contract("docs/contracts/task-35-v1-r1.md", "1".repeat(64));
  const distant = contract(
    "docs/contracts/task-35-v2-r9007199254740991.md",
    "2".repeat(64),
    reference(first),
  );
  assert.equal(rejectionCode([first, distant]), "unexplained_revision_gap");
});

test("accepts only a contiguous pending quarantine suffix after the terminal", () => {
  const terminal = contract("docs/contracts/task-35-v1-r1.md", "1".repeat(64));
  const pending = quarantine("docs/contracts/task-35-v1-r2.md", "2".repeat(64));
  assert.equal(
    validateContractChain({ contracts: [terminal], quarantined: [pending] }).ok,
    true,
  );
  const pendingNext = quarantine(
    "docs/contracts/task-35-v1-r3.md",
    "3".repeat(64),
  );
  assert.equal(
    validateContractChain({
      contracts: [terminal],
      quarantined: [pendingNext, pending],
    }).ok,
    true,
  );
  const orphan = quarantine("docs/contracts/task-35-v1-r3.md", "7".repeat(64));
  assert.equal(rejectionCode([terminal], [orphan]), "orphan_quarantine");
  const stale = quarantine("docs/contracts/task-35-v1-r2.md", "4".repeat(64));
  const nextVersion = contract(
    "docs/contracts/task-35-v2-r1.md",
    "5".repeat(64),
    reference(terminal),
  );
  assert.equal(
    rejectionCode([terminal, nextVersion], [stale]),
    "orphan_quarantine",
  );
  const future = quarantine("docs/contracts/task-35-v3-r1.md", "6".repeat(64));
  assert.equal(rejectionCode([terminal], [future]), "orphan_quarantine");
  const nextSemantic = quarantine(
    "docs/contracts/task-35-v2-r1.md",
    "8".repeat(64),
  );
  assert.equal(
    validateContractChain({
      contracts: [terminal],
      quarantined: [nextSemantic],
    }).ok,
    true,
  );
  assert.equal(
    rejectionCode([terminal], [nextSemantic, pending]),
    "orphan_quarantine",
  );
});

test("matches complete recovery declarations in lexical path order", () => {
  const first = contract("docs/contracts/task-35-v1-r1.md", "1".repeat(64));
  const quarantined = Array.from({ length: 10 }, (_, index) =>
    quarantine(
      `docs/contracts/task-35-v2-r${index + 1}.md`,
      String(index + 2).padStart(64, "0"),
    ),
  );
  const recoveries = quarantined
    .map(reference)
    .toSorted((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  const retry = contract(
    "docs/contracts/task-35-v2-r11.md",
    "f".repeat(64),
    reference(first),
    recoveries,
  );
  assert.equal(
    validateContractChain({ contracts: [first, retry], quarantined }).ok,
    true,
  );
});
