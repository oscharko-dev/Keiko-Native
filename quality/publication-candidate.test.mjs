import assert from "node:assert/strict";
import test from "node:test";
import { verifyPublicationCandidate } from "./publication-candidate.mjs";
import {
  classifyPublicationLane,
  publicationResultMatrix,
} from "./publication-contract.mjs";
import { contractSha256 } from "./repository-contract.mjs";

const repository = "oscharko-dev/Keiko-Native";
const base = "1".repeat(40);
const head = "2".repeat(40);
const contractPath = "docs/contracts/task-30-v3-r1.md";
const receiptPath = "docs/contracts/publications/pr-77.md";
const fingerprint = "f".repeat(64);

function ordinaryCandidate() {
  const contractBytes = Buffer.from("accepted issue contract\n");
  const candidate = {
    digest: contractSha256(contractBytes).digest,
    mode: "100644",
    path: contractPath,
  };
  const observation = {
    candidatePath: contractPath,
    fingerprint,
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
    version: 3,
  };
  const receiptValue = {
    candidates: [candidate],
    observations: [observation],
    pullRequest: 77,
    target: "dev",
    terminalManifest: null,
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receiptValue)}\n`);
  const receiptDigest = contractSha256(receiptBytes).digest;
  const files = [
    { mode: "100644", path: contractPath, status: "added" },
    { mode: "100644", path: receiptPath, status: "added" },
  ];
  const entries = [
    { bytes: receiptBytes, mode: "100644", path: receiptPath },
    { bytes: contractBytes, mode: "100644", path: contractPath },
  ];
  return {
    diff: {
      base,
      complete: true,
      files,
      head,
      normalValidated: false,
      pullRequest: 77,
      repository,
      truncated: false,
    },
    issueObservations: [observation],
    newlyAdded: { base, entries, head, pullRequest: 77, repository },
    pullRequest: {
      base,
      baseRef: "dev",
      head,
      merged: false,
      number: 77,
      state: "open",
    },
    receipt: { bytes: receiptBytes, digest: receiptDigest, path: receiptPath },
    repository,
    target: "dev",
    terminalManifest: null,
  };
}

function rewriteReceipt(input, mutate) {
  const value = JSON.parse(Buffer.from(input.receipt.bytes).toString("utf8"));
  mutate(value);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  input.receipt = {
    bytes,
    digest: contractSha256(bytes).digest,
    path: receiptPath,
  };
  input.newlyAdded.entries.find((entry) => entry.path === receiptPath).bytes =
    bytes;
  input.issueObservations = structuredClone(value.observations);
  return value;
}

function migrationCandidate(lifecycle) {
  const input = ordinaryCandidate();
  const readiness =
    "https://github.com/oscharko-dev/Keiko-Native/issues/30#issuecomment-123";
  rewriteReceipt(input, (receipt) => {
    const observation = receipt.observations[0];
    observation.lifecycleLabels = [lifecycle];
    observation.linkedPullRequest = [
      "status: pr open",
      "status: ready for human review",
    ].includes(lifecycle)
      ? { head: "3".repeat(40), number: 88, target: "epic/29-contracts" }
      : null;
    observation.readiness = readiness;
    observation.readinessProducer = "issue-readiness.yml@protected-dev";
  });
  const entries = structuredClone(input.issueObservations);
  const bytes = Buffer.from("# Terminal migration manifest\n");
  const binding = {
    digest: contractSha256(bytes).digest,
    path: "docs/qa/repository-migration-manifest-v1.md",
  };
  rewriteReceipt(input, (receipt) => (receipt.terminalManifest = binding));
  input.terminalManifest = {
    base,
    bytes,
    digest: binding.digest,
    entries,
    mode: "100644",
    path: binding.path,
    repository,
  };
  return input;
}

test("accepts an exact ordinary pre-merge publication candidate", () => {
  const result = verifyPublicationCandidate(ordinaryCandidate());
  assert.equal(result.ok, true);
  assert.equal(result.binding.submode, "ordinary");
  assert.equal(result.binding.receipt.path, receiptPath);
  assert.deepEqual(result.binding.observations[0].linkedPullRequest, null);
});

test("binds an exact predecessor and quarantine-recovery identity", () => {
  const input = ordinaryCandidate();
  const path = "docs/contracts/task-30-v3-r3.md";
  rewriteReceipt(input, (receipt) => {
    receipt.candidates[0].path = path;
    Object.assign(receipt.observations[0], {
      candidatePath: path,
      predecessor: {
        digest: "a".repeat(64),
        path: "docs/contracts/task-30-v3-r1.md",
      },
      recoveries: [
        { digest: "b".repeat(64), path: "docs/contracts/task-30-v3-r2.md" },
      ],
      revision: 3,
    });
  });
  input.diff.files[0].path = path;
  input.newlyAdded.entries[1].path = path;
  const result = verifyPublicationCandidate(input);
  assert.equal(result.ok, true);
  assert.equal(result.binding.observations[0].recoveries.length, 1);
});

test("accepts the six exact retained migration lifecycle candidates", () => {
  for (const lifecycle of [
    "status: ready",
    "status: in progress",
    "status: pr open",
    "status: ready for human review",
    "status: blocked",
    "status: waiting for user",
  ]) {
    const result = verifyPublicationCandidate(migrationCandidate(lifecycle));
    assert.equal(result.ok, true, lifecycle);
    assert.equal(result.binding.submode, "migration");
    assert.equal(result.binding.observations[0].lifecycleLabels[0], lifecycle);
  }
});

test("requires exact live, receipt, manifest, readiness, and linked-PR evidence", () => {
  const changed = (
    mutate,
    create = () => migrationCandidate("status: pr open"),
  ) => {
    const input = create();
    mutate(input);
    return input;
  };
  const rewrite = (mutate) => changed((input) => rewriteReceipt(input, mutate));
  const invalid = [
    changed(
      (input) => (input.issueObservations[0].fingerprint = "a".repeat(64)),
    ),
    changed(
      (input) =>
        (input.terminalManifest.entries[0].fingerprint = "a".repeat(64)),
    ),
    changed((input) => (input.terminalManifest.path = "docs/qa/stale-v1.md")),
    changed((input) => (input.terminalManifest.digest = "a".repeat(64))),
    changed((input) => (input.terminalManifest.base = head)),
    changed((input) => (input.terminalManifest.mode = "120000")),
    changed((input) => (input.terminalManifest.repository = "other/repo")),
    changed((input) => (input.terminalManifest.bytes = Buffer.from("stale"))),
    rewrite(
      (receipt) =>
        (receipt.observations[0].readinessProducer = "untrusted-producer"),
    ),
    changed((input) => {
      rewriteReceipt(input, (receipt) => {
        receipt.observations[0].readinessProducer = "attacker";
      });
      input.terminalManifest.entries = structuredClone(input.issueObservations);
    }),
    changed((input) => {
      rewriteReceipt(input, (receipt) => {
        receipt.observations[0].readiness =
          "https://github.com/attacker/repo/issues/30#issuecomment-123";
      });
      input.terminalManifest.entries = structuredClone(input.issueObservations);
    }),
    changed((input) => {
      rewriteReceipt(input, (receipt) => {
        receipt.observations[0].readiness =
          "https://github.com/oscharko-dev/Keiko-Native/issues/31#issuecomment-123";
      });
      input.terminalManifest.entries = structuredClone(input.issueObservations);
    }),
    rewrite((receipt) => (receipt.observations[0].readiness = null)),
    rewrite(
      (receipt) => (receipt.observations[0].lifecycleLabels = ["status: new"]),
    ),
    changed(
      (input) =>
        (input.issueObservations[0].linkedPullRequest.head = "4".repeat(40)),
    ),
    rewrite((receipt) => (receipt.observations[0].linkedPullRequest = null)),
    changed((input) =>
      input.terminalManifest.entries.push(input.issueObservations[0]),
    ),
    changed((input) => (input.terminalManifest = null)),
    changed((input) => {
      const forged = {
        digest: "d".repeat(64),
        path: "docs/qa/nonexistent-v1.md",
      };
      rewriteReceipt(input, (receipt) => (receipt.terminalManifest = forged));
      input.terminalManifest = {
        digest: forged.digest,
        entries: structuredClone(input.issueObservations),
        path: forged.path,
      };
    }),
  ];
  for (const [index, input] of invalid.entries()) {
    assert.equal(verifyPublicationCandidate(input).ok, false, `${index}`);
  }
});

test("rejects ordinary readiness, linked-PR, closed-state, and authority smuggling", () => {
  const altered = (mutate) => {
    const input = ordinaryCandidate();
    mutate(input);
    return input;
  };
  const rewritten = (mutate) =>
    altered((input) => rewriteReceipt(input, mutate));
  for (const input of [
    rewritten((receipt) => {
      receipt.observations[0].readiness =
        "https://github.com/oscharko-dev/Keiko-Native/issues/30#issuecomment-123";
      receipt.observations[0].readinessProducer =
        "issue-readiness.yml@protected-dev";
    }),
    rewritten(
      (receipt) =>
        (receipt.observations[0].linkedPullRequest = {
          head: "3".repeat(40),
          number: 88,
          target: "epic/29-contracts",
        }),
    ),
    rewritten((receipt) => (receipt.observations[0].state = "closed")),
    altered((input) => (input.target = "main")),
    altered((input) => (input.pullRequest.state = "closed")),
    altered((input) => (input.pullRequest.merged = true)),
    altered((input) => (input.pullRequest = {})),
    altered(
      (input) =>
        (input.terminalManifest = {
          digest: "c".repeat(64),
          entries: [],
          path: "docs/qa/repository-migration-manifest-v1.md",
        }),
    ),
    { ...ordinaryCandidate(), unexpected: true },
  ]) {
    assert.equal(verifyPublicationCandidate(input).ok, false);
  }
});

test("binds exact diff, added paths, modes, bytes, digests, and head", () => {
  const changed = (mutate) => {
    const input = ordinaryCandidate();
    mutate(input);
    return input;
  };
  const invalid = [
    changed((input) => (input.diff = {})),
    changed((input) => (input.diff.truncated = true)),
    changed((input) => (input.diff.head = "4".repeat(40))),
    changed((input) => (input.receipt.digest = "a".repeat(64))),
    changed(
      (input) => (input.receipt.path = "docs/contracts/publications/pr-78.md"),
    ),
    changed((input) => (input.receipt.bytes = Buffer.from("changed\n"))),
    changed((input) => (input.receipt = {})),
    changed((input) =>
      rewriteReceipt(input, (receipt) => (receipt.pullRequest = 999)),
    ),
    changed((input) => (input.newlyAdded.entries[0].mode = "120000")),
    changed((input) =>
      input.newlyAdded.entries[1].bytes.fill("x".charCodeAt(0)),
    ),
    changed((input) => input.newlyAdded.entries.reverse()),
    changed((input) => input.newlyAdded.entries.pop()),
    changed((input) =>
      input.diff.files.push({
        mode: "100644",
        path: "README.md",
        status: "added",
      }),
    ),
  ];
  for (const [index, input] of invalid.entries()) {
    assert.equal(verifyPublicationCandidate(input).ok, false, `${index}`);
  }
});

test("feeds the complete binding to the non-circular result matrix", () => {
  const input = ordinaryCandidate();
  const accepted = verifyPublicationCandidate(input);
  const classification = classifyPublicationLane(input.diff);
  const matrix = publicationResultMatrix({
    classification,
    publication: accepted,
  });
  assert.deepEqual(matrix.contexts, {
    "Contract publication": "success",
    "Issue contract current": "success",
    "PR contract": "success",
  });
  assert.equal(matrix.readinessClaim, false);
  const stale = structuredClone(accepted);
  stale.binding.head = "a".repeat(40);
  assert.equal(
    publicationResultMatrix({ classification, publication: stale }).contexts[
      "Contract publication"
    ],
    "failure",
  );
});

test("fails the result matrix closed on hostile bindings", () => {
  const input = ordinaryCandidate();
  const accepted = verifyPublicationCandidate(input);
  const classification = classifyPublicationLane(input.diff);
  const hostile = new Proxy({}, { get: () => assert.fail("SECRET") });
  for (const input of [
    {
      classification,
      publication: { binding: hostile, ok: true },
    },
    { classification: hostile, publication: accepted },
    {
      classification: { binding: hostile, lane: "publication", ok: true },
      publication: accepted,
    },
  ]) {
    const result = publicationResultMatrix(input);
    assert.equal(result.contexts["Contract publication"], "failure");
  }
});

test("fails closed and deterministically recovers when complete evidence returns", () => {
  const input = ordinaryCandidate();
  const unavailable = {
    ...input,
    newlyAdded: { ...input.newlyAdded, entries: null },
  };
  assert.equal(verifyPublicationCandidate(unavailable).ok, false);
  const first = verifyPublicationCandidate(input);
  const second = verifyPublicationCandidate(input);
  assert.deepEqual(first, second);
  const hostile = new Proxy({}, { ownKeys: () => assert.fail("SECRET") });
  const result = verifyPublicationCandidate(hostile);
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.rejection.message, /SECRET/iu);
});
