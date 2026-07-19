import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPublicationLane,
  parsePublicationTrailers,
  validateSnapshotReceipt,
  verifyPublication,
} from "./publication-contract.mjs";
import { contractSha256 } from "./repository-contract.mjs";
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const contractPath = "docs/contracts/task-30-v2-r1.md";
const receiptPath = "docs/contracts/publications/pr-77.md";
const repository = "oscharko-dev/Keiko-Native";
const base = "1".repeat(40);
const head = "2".repeat(40);
const mergeSha = "3".repeat(40);
const prefixTree = "4".repeat(40);
const resultTree = "5".repeat(40);
const devTip = "6".repeat(40);
function laneIdentity(lane) {
  return { base, head, lane, pullRequest: 77, repository };
}
test("parses the sole snapshot and canonical ordered contract trailers", () => {
  const payload = [
    "signed commit content",
    "",
    `Keiko-Publication-Snapshot-SHA256: ${digestA} ${receiptPath}`,
    `Keiko-Contract-SHA256: ${digestB} ${contractPath}`,
  ].join("\n");
  assert.deepEqual(parsePublicationTrailers(payload), {
    contracts: [{ digest: digestB, path: contractPath }],
    ok: true,
    snapshot: { digest: digestA, path: receiptPath, pullRequest: 77 },
  });
  assert.equal(parsePublicationTrailers(`${payload}\n\n`).ok, true);
  assert.equal(validateSnapshotReceipt(snapshot(digestA)).ok, true);
});
test("rejects alternate object-key byte encodings", () => {
  const receipt = snapshot(digestA);
  const topLevel = {
    pullRequest: receipt.pullRequest,
    candidates: receipt.candidates,
    observations: receipt.observations,
    target: receipt.target,
    terminalManifest: receipt.terminalManifest,
  };
  const candidate = receipt.candidates[0];
  const nested = {
    ...receipt,
    candidates: [
      { path: candidate.path, digest: candidate.digest, mode: candidate.mode },
    ],
  };
  assert.equal(validateSnapshotReceipt(topLevel).ok, false);
  assert.equal(validateSnapshotReceipt(nested).ok, false);
});
test("classifies only a complete add-only canonical publication diff", () => {
  assert.deepEqual(
    classifyPublicationLane({
      complete: true,
      base,
      files: [
        { mode: "100644", path: contractPath, status: "added" },
        { mode: "100644", path: receiptPath, status: "added" },
      ],
      head,
      normalValidated: false,
      publication: false,
      pullRequest: 77,
      repository,
      truncated: false,
    }),
    {
      binding: laneIdentity("publication"),
      contractPaths: [contractPath],
      lane: "publication",
      ok: true,
      receiptPath,
    },
  );
});
test("parses only a terminal trailer block and rejects malformed trailer sets", () => {
  const line = `Keiko-Contract-SHA256: ${digestB} ${contractPath}`;
  const snapshot = `Keiko-Publication-Snapshot-SHA256: ${digestA} ${receiptPath}`;
  const code = (payload) => parsePublicationTrailers(payload).rejection?.code;
  assert.equal(
    parsePublicationTrailers(`prose ${line}\n${line}\n\n${snapshot}\n${line}`)
      .ok,
    true,
  );
  for (const payload of [
    null,
    `${snapshot}\n${line}`,
    `body\n\n${line}`,
    `body\n\n${snapshot}`,
    `body\n\n${snapshot}\n${line}\n${line}`,
    `body\n\n${snapshot}\nKeiko-Unknown: x\n${line}`,
    `body\n\n${snapshot}\n continuation\n${line}`,
    `body\n\n${snapshot.replace(digestA, "A".repeat(64))}\n${line}`,
    `body\n\n${snapshot}\n${line.replace(contractPath, "docs/contracts/bad.md")}`,
    `body\n\n${line}\n${snapshot}`,
    `body\n\n${snapshot}\n${line.replace(digestB, digestA)}`,
  ]) {
    assert.equal(parsePublicationTrailers(payload).ok, false);
  }
  assert.equal(code("raw private payload"), "incomplete_trailer_set");
  const secret = parsePublicationTrailers("SECRET");
  assert.doesNotMatch(secret.rejection.message, /SECRET/iu);
});
function diff(overrides = {}) {
  return {
    base,
    complete: true,
    files: [],
    head,
    normalValidated: true,
    pullRequest: 77,
    repository,
    truncated: false,
    ...overrides,
  };
}
test("fails closed on unavailable, ambiguous, mixed, and nonregular diffs", () => {
  assert.equal(classifyPublicationLane(diff()).lane, "normal");
  assert.equal(
    classifyPublicationLane(diff({ normalValidated: false })).ok,
    false,
  );
  const contract = { mode: "100644", path: contractPath, status: "added" };
  const receipt = { mode: "100644", path: receiptPath, status: "added" };
  for (const input of [
    undefined,
    diff({ complete: false }),
    diff({ truncated: true }),
    diff({ base: "bad" }),
    diff({ files: [contract] }),
    diff({ files: [receipt] }),
    diff({ files: [contract, receipt, { ...contract }] }),
    diff({
      files: [
        contract,
        receipt,
        { mode: "100644", path: "README.md", status: "added" },
      ],
    }),
    diff({ files: [{ ...contract, status: "modified" }, receipt] }),
    diff({ files: [{ ...contract, mode: "120000" }, receipt] }),
    ...["renamed", "copied"].flatMap((status) =>
      [contractPath, receiptPath, "docs/contracts/bad.md", null].map(
        (previous_filename) =>
          diff({
            files: [
              { ...contract, path: "README.md", previous_filename, status },
            ],
          }),
      ),
    ),
    diff({ files: [{ ...contract, path: "docs/contracts/bad.md" }, receipt] }),
    diff({
      files: [
        contract,
        { ...receipt, path: "docs/contracts/publications/pr-78.md" },
      ],
    }),
  ]) {
    assert.equal(classifyPublicationLane(input).ok, false);
  }
  assert.equal(
    classifyPublicationLane(
      diff({
        files: [{ mode: "100644", path: "README.md", status: "modified" }],
        publication: true,
      }),
    ).lane,
    "normal",
  );
});
function snapshot(candidateDigest) {
  return {
    candidates: [
      { digest: candidateDigest, mode: "100644", path: contractPath },
    ],
    observations: [
      {
        candidatePath: contractPath,
        fingerprint: digestB,
        lifecycleLabels: ["status: new"],
        number: 30,
        predecessor: null,
        readiness: null,
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
function publicationFixture(changeReceipt = () => {}) {
  const contractBytes = Buffer.from("canonical contract bytes\n");
  const candidateDigest = contractSha256(contractBytes).digest;
  const receiptValue = snapshot(candidateDigest);
  changeReceipt(receiptValue);
  const receiptBytes = Buffer.from(`${JSON.stringify(receiptValue)}\n`);
  const receiptDigest = contractSha256(receiptBytes).digest;
  const signedPayload = [
    "signed commit",
    "",
    `Keiko-Publication-Snapshot-SHA256: ${receiptDigest} ${receiptPath}`,
    `Keiko-Contract-SHA256: ${candidateDigest} ${contractPath}`,
  ].join("\n");
  const entries = [
    { bytes: receiptBytes, mode: "100644", path: receiptPath },
    { bytes: contractBytes, mode: "100644", path: contractPath },
  ];
  const copyEntries = () =>
    entries.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes) }));
  return {
    allowlistedMergers: ["Niko"],
    commit: {
      parents: [{ sha: base, tree: prefixTree }],
      sha: mergeSha,
      signedPayload,
      tree: resultTree,
      verification: {
        payload: signedPayload,
        reason: "valid",
        signer: "github-web-flow",
        verified: true,
      },
    },
    currentTree: { commit: devTip, entries: copyEntries(), repository },
    newlyAdded: {
      base,
      entries: copyEntries(),
      head,
      pullRequest: 77,
      repository,
    },
    protectedDev: {
      ancestor: mergeSha,
      reachable: true,
      repository,
      tip: devTip,
    },
    publishingTree: { commit: mergeSha, entries: copyEntries(), repository },
    pullRequest: {
      base,
      baseRef: "dev",
      head,
      merged: true,
      mergedBy: "Niko",
      mergeSha,
      number: 77,
      state: "closed",
    },
    receipt: {
      bytes: receiptBytes,
      path: receiptPath,
      pullRequest: 77,
      repository,
    },
    repository,
    terminalManifestEvidence: null,
    validatedGroup: { base, head, prefixTree, resultTree },
  };
}
function migrationFixture() {
  const readiness =
    "https://github.com/oscharko-dev/Keiko-Native/issues/30#issuecomment-123";
  const manifest = {
    digest: "c".repeat(64),
    path: "docs/qa/repository-migration-manifest-v1.md",
  };
  const fixture = publicationFixture((receipt) => {
    receipt.observations[0].lifecycleLabels = ["status: ready"];
    receipt.observations[0].readiness = readiness;
    receipt.terminalManifest = manifest;
  });
  fixture.terminalManifestEvidence = {
    ...manifest,
    entries: [
      {
        candidatePath: contractPath,
        fingerprint: digestB,
        number: 30,
        readiness,
        revision: 1,
        type: "task",
        version: 2,
      },
    ],
  };
  return fixture;
}
function decoyEntry() {
  return {
    bytes: Buffer.from("decoy"),
    mode: "100644",
    path: "docs/contracts/task-31-v1-r1.md",
  };
}
test("accepts a fully bound isolated publication and emits normalized identity", () => {
  const result = verifyPublication(publicationFixture());
  const binding = result.binding;
  assert.equal(result.ok, true);
  assert.deepEqual(binding.ancestry, { commit: mergeSha, tip: devTip });
  assert.deepEqual(binding.trees, { parent: prefixTree, result: resultTree });
  assert.equal(binding.candidates[0].path, contractPath);
  assert.equal(binding.repository, repository);
  assert.equal(binding.pullRequest, 77);
  assert.equal(binding.submode, "ordinary");
});
test("binds migration publication to exact terminal manifest evidence", () => {
  assert.equal(
    verifyPublication(migrationFixture()).binding.submode,
    "migration",
  );
  const mutations = [
    (x) => (x.terminalManifestEvidence = null),
    (x) => (x.terminalManifestEvidence.path = "docs/qa/stale-v1.md"),
    (x) => (x.terminalManifestEvidence.digest = digestA),
    (x) => x.terminalManifestEvidence.entries.push({ number: 31 }),
    (x) =>
      x.terminalManifestEvidence.entries.push(
        x.terminalManifestEvidence.entries[0],
      ),
    (x) => (x.terminalManifestEvidence.entries[0].fingerprint = digestA),
  ];
  for (const mutate of mutations) {
    const fixture = migrationFixture();
    mutate(fixture);
    assert.equal(verifyPublication(fixture).ok, false);
  }
});
test("rejects unavailable, unauthorized, replayed, stale, or contradictory acceptance evidence", () => {
  const invalid = [];
  const signed = (fixture, payload) => {
    fixture.commit.signedPayload = payload;
    fixture.commit.verification.payload = payload;
  };
  const changed = (mutate) => {
    const fixture = publicationFixture();
    mutate(fixture);
    invalid.push(fixture);
  };
  invalid.push(null, {});
  changed((x) => (x.commit.verification.verified = false));
  changed((x) => (x.commit.verification.reason = "unknown"));
  changed((x) => (x.commit.verification.signer = x.pullRequest.mergedBy));
  changed((x) => (x.pullRequest.mergedBy = "Mallory"));
  changed((x) => (x.pullRequest.mergeSha = head));
  changed((x) => (x.commit.parents = []));
  changed((x) => (x.commit.parents[0].tree = head));
  changed((x) => (x.commit.tree = head));
  changed((x) => (x.protectedDev.reachable = false));
  changed((x) => (x.protectedDev.ancestor = head));
  changed((x) => (x.receipt.path = null));
  changed((x) => (x.receipt.path = "docs/contracts/publications/pr-78.md"));
  changed((x) => (x.newlyAdded.entries = "unavailable"));
  changed((x) => x.newlyAdded.entries.pop());
  changed((x) => x.newlyAdded.entries.push({ ...x.newlyAdded.entries[0] }));
  changed((x) => x.newlyAdded.entries.push(decoyEntry()));
  changed((x) => x.publishingTree.entries.push(decoyEntry()));
  changed((x) => (x.newlyAdded.entries[1].bytes = Buffer.from("changed")));
  changed((x) => (x.publishingTree.entries[1].mode = "120000"));
  changed((x) => (x.currentTree.entries[1].bytes = Buffer.from("changed")));
  changed((x) => signed(x, `${x.commit.signedPayload}\nextra`));
  changed((x) =>
    signed(
      x,
      `${x.commit.signedPayload}\nKeiko-Contract-SHA256: ${digestA} docs/contracts/task-31-v1-r1.md`,
    ),
  );
  changed((x) => (x.terminalManifestEvidence = {}));
  changed((x) => (x.receipt.bytes = "not bytes"));
  changed((x) => (x.receipt.bytes = Buffer.from("{} \n")));
  changed((x) => (x.receipt.bytes = Buffer.from("not json")));
  changed((x) => (x.receipt.bytes = Buffer.from([0xff])));
  changed((x) =>
    Object.defineProperty(x.receipt, "bytes", {
      get() {
        throw new Error("SECRET");
      },
    }),
  );
  for (const [index, input] of invalid.entries()) {
    const result = verifyPublication(input);
    assert.equal(result.ok, false, `invalid fixture ${index}`);
    assert.doesNotMatch(result.rejection.message, /changed|not json|Mallory/iu);
  }
});
