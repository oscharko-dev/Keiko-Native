import assert from "node:assert/strict";
import test from "node:test";
import { issueSchemaForLabels } from "./issue-contract.mjs";
import { semanticIssueFingerprint } from "./issue-contract.mjs";
import { verifyPublicationCandidate } from "./publication-candidate.mjs";
// prettier-ignore
import { classifyPublicationLane, publicationResultMatrix } from "./publication-contract.mjs";
import { contractSha256 } from "./repository-contract.mjs";
const repository = "oscharko-dev/Keiko-Native";
const base = "1".repeat(40),
  head = "2".repeat(40);
const contractPath = "docs/contracts/task-30-v3-r1.md";
const historyPath = "docs/contracts/task-30-v3-r3.md";
const receiptPath = "docs/contracts/publications/pr-77.md";
const issueTitle = "Publication candidate contract";
// prettier-ignore
const predecessor = { digest: "a".repeat(64), path: "docs/contracts/task-30-v3-r1.md" };
// prettier-ignore
const recovery = { digest: "b".repeat(64), path: "docs/contracts/task-30-v3-r2.md" };
const taskHeadings = issueSchemaForLabels(["type: task"]).requiredHeadings;
const fingerprint = (body = contractBody()) =>
  semanticIssueFingerprint(body, issueTitle);
function contractBody({
  predecessor = null,
  recoveries = [],
  version = 3,
} = {}) {
  const sections = taskHeadings.map((heading) => {
    if (heading === "Planning contract")
      return `## ${heading}\n\n- Contract version: \`v${version}\``;
    if (heading === "Acceptance journey")
      return `## ${heading}\n\n- Applicability: Required\n- Actor: Developer`;
    if (heading === "Acceptance criteria")
      return `## ${heading}\n\n- [ ] AC1 — Candidate content is validated.`;
    if (heading === "Verification commands")
      return `## ${heading}\n\n\`\`\`text\nnode --test quality/publication-candidate.test.mjs\n\`\`\``;
    if (heading === "Definition of Ready")
      return `## ${heading}\n\n- [x] Scope and verification are complete.`;
    return `## ${heading}\n\nComplete governed content for ${heading}.`;
  });
  const declarations = [
    ...(predecessor === null
      ? []
      : [`Supersedes: ${predecessor.digest} ${predecessor.path}`]),
    ...recoveries.map(
      (recovery) => `Recovers-Publication: ${recovery.digest} ${recovery.path}`,
    ),
  ];
  return [...sections, ...declarations].join("\n\n");
}
function ordinaryCandidate() {
  const body = contractBody();
  const contractBytes = Buffer.from(body);
  // prettier-ignore
  const candidate = { digest: contractSha256(contractBytes).digest, mode: "100644", path: contractPath };
  // prettier-ignore
  const observation = { candidatePath: contractPath, fingerprint: fingerprint(body), lifecycleLabels: ["status: new"], linkedPullRequest: null, number: 30, predecessor: null, readiness: null, readinessProducer: null, recoveries: [], revision: 1, state: "open", type: "task", version: 3 };
  // prettier-ignore
  const receiptValue = { candidates: [candidate], observations: [observation], pullRequest: 77, target: "dev", terminalManifest: null };
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
    issueTitles: [{ number: 30, title: issueTitle }],
    newlyAdded: { base, entries, head, pullRequest: 77, repository },
    // prettier-ignore
    pullRequest: { base, baseRef: "dev", head, merged: false, number: 77, state: "open" },
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
function rewriteContract(
  input,
  { body, observation = {}, path = contractPath },
) {
  const bytes = body instanceof Uint8Array ? body : Buffer.from(body);
  const entry = input.newlyAdded.entries.find(
    (candidate) => candidate.path !== receiptPath,
  );
  entry.bytes = bytes;
  entry.path = path;
  input.diff.files.find((file) => file.path !== receiptPath).path = path;
  rewriteReceipt(input, (receipt) => {
    Object.assign(receipt.candidates[0], {
      digest: contractSha256(bytes).digest,
      path,
    });
    Object.assign(receipt.observations[0], {
      candidatePath: path,
      ...observation,
    });
  });
}
function mutated(mutate, create = ordinaryCandidate) {
  const input = create();
  mutate(input);
  return input;
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
  const bytes = Buffer.from(`${JSON.stringify({ entries })}\n`);
  // prettier-ignore
  const binding = { digest: contractSha256(bytes).digest, path: "docs/qa/repository-migration-manifest-v1.md" };
  rewriteReceipt(input, (receipt) => (receipt.terminalManifest = binding));
  input.terminalManifest = {
    base,
    bytes,
    digest: binding.digest,
    mode: "100644",
    path: binding.path,
    repository,
  };
  return input;
}
test("accepts an exact ordinary pre-merge publication candidate", () => {
  const input = ordinaryCandidate();
  const result = verifyPublicationCandidate(input);
  assert.equal(result.ok, true);
  assert.equal(result.binding.submode, "ordinary");
  assert.equal(result.binding.receipt.path, receiptPath);
  assert.deepEqual(result.binding.observations[0].linkedPullRequest, null);
  input.diff.files.reverse();
  assert.deepEqual(verifyPublicationCandidate(input), result);
  const permuted = Object.fromEntries(Object.entries(input).reverse());
  permuted.pullRequest = Object.fromEntries(
    Object.entries(input.pullRequest).reverse(),
  );
  assert.deepEqual(verifyPublicationCandidate(permuted), result);
});
test("binds an exact predecessor and quarantine-recovery identity", () => {
  const input = ordinaryCandidate();
  const recoveries = [recovery];
  rewriteContract(input, {
    body: contractBody({ predecessor, recoveries }),
    observation: {
      fingerprint: fingerprint(contractBody({ predecessor, recoveries })),
      predecessor,
      recoveries,
      revision: 3,
    },
    path: historyPath,
  });
  const result = verifyPublicationCandidate(input);
  assert.equal(result.ok, true);
  assert.equal(result.binding.observations[0].recoveries.length, 1);
});
test("rejects invalid body schemas, path versions, and history declarations", () => {
  const changed = (body, observation = {}, path = contractPath) => {
    const input = ordinaryCandidate();
    rewriteContract(input, { body, observation, path });
    return input;
  };
  // prettier-ignore
  const invalid = [
    [changed(contractBody().replace("## Scope", "## Missing scope")), "invalid_candidate_contract_schema"],
    [changed(contractBody({ version: 2 })), "candidate_contract_version_mismatch"],
    [changed(contractBody(), { predecessor, revision: 2 }, recovery.path), "candidate_contract_declaration_mismatch"],
    [changed(contractBody({ predecessor }).replace("a".repeat(64), "A".repeat(64))), "invalid_candidate_contract_declarations"],
    [changed(contractBody({ predecessor, recoveries: [recovery] }), { predecessor, recoveries: [{ ...recovery, digest: "c".repeat(64) }], revision: 3 }, historyPath), "candidate_contract_declaration_mismatch"],
    [changed(contractBody().replace("Complete governed content for Scope.", "Changed governed content for Scope.")), "candidate_contract_fingerprint_mismatch"],
    [changed(Buffer.from([0xc3, 0x28])), "invalid_candidate_contract_encoding"],
  ];
  for (const [input, code] of invalid) {
    const result = verifyPublicationCandidate(input);
    assert.equal(result.ok, false);
    assert.deepEqual(result.rejection, {
      code,
      message: "Publication candidate evidence failed closed.",
    });
  }
});
test("accepts the six exact retained migration lifecycle candidates", () => {
  // prettier-ignore
  for (const lifecycle of [
    "status: ready", "status: in progress", "status: pr open", "status: ready for human review", "status: blocked", "status: waiting for user",
  ]) {
    const result = verifyPublicationCandidate(migrationCandidate(lifecycle));
    assert.equal(result.ok, true, lifecycle);
    assert.equal(result.binding.submode, "migration");
    assert.equal(result.binding.observations[0].lifecycleLabels[0], lifecycle);
  }
});
test("requires exact live, receipt, manifest, readiness, and linked-PR evidence", () => {
  const changed = (mutate) =>
    mutated(mutate, () => migrationCandidate("status: pr open"));
  const rewrite = (mutate) => changed((input) => rewriteReceipt(input, mutate));
  // prettier-ignore
  const invalid = [
    changed((input) => (input.issueObservations[0].fingerprint = "a".repeat(64))),
    changed((input) => (input.terminalManifest.bytes = Buffer.from('{"entries":[]}\n'))),
    changed((input) => (input.terminalManifest.path = "docs/qa/stale-v1.md")),
    changed((input) => (input.terminalManifest.digest = "a".repeat(64))),
    changed((input) => (input.terminalManifest.base = head)),
    changed((input) => (input.terminalManifest.mode = "120000")),
    changed((input) => (input.terminalManifest.repository = "other/repo")),
    changed((input) => (input.terminalManifest.bytes = Buffer.from("stale"))),
    // prettier-ignore
    changed((input) => Object.defineProperty(input.terminalManifest, "bytes", { get() { throw new Error("SECRET"); } })),
    rewrite((receipt) => (receipt.observations[0].readinessProducer = "untrusted-producer")),
    changed((input) => {
      rewriteReceipt(input, (receipt) => (receipt.observations[0].readinessProducer = "attacker"));
    }),
    changed((input) => {
      rewriteReceipt(input, (receipt) => (receipt.observations[0].readiness = "https://github.com/attacker/repo/issues/30#issuecomment-123"));
    }),
    changed((input) => {
      rewriteReceipt(input, (receipt) => (receipt.observations[0].readiness = "https://github.com/oscharko-dev/Keiko-Native/issues/31#issuecomment-123"));
    }),
    rewrite((receipt) => (receipt.observations[0].readiness = null)),
    rewrite((receipt) => (receipt.observations[0].lifecycleLabels = ["status: new"])),
    changed((input) => (input.issueObservations[0].linkedPullRequest.head = "4".repeat(40))),
    rewrite((receipt) => (receipt.observations[0].linkedPullRequest = null)),
    changed((input) => (input.terminalManifest.bytes = Buffer.from("not json"))),
    changed((input) => (input.terminalManifest = null)),
    changed((input) => {
      const forged = { digest: "d".repeat(64), path: "docs/qa/nonexistent-v1.md" };
      rewriteReceipt(input, (receipt) => (receipt.terminalManifest = forged));
      input.terminalManifest = { digest: forged.digest, path: forged.path };
    }),
  ];
  for (const [index, input] of invalid.entries()) {
    assert.equal(verifyPublicationCandidate(input).ok, false, `${index}`);
  }
});
test("rejects ordinary readiness, linked-PR, closed-state, and authority smuggling", () => {
  const altered = (mutate) => mutated(mutate);
  const rewritten = (mutate) =>
    altered((input) => rewriteReceipt(input, mutate));
  // prettier-ignore
  for (const input of [
    rewritten((receipt) => {
      receipt.observations[0].readiness = "https://github.com/oscharko-dev/Keiko-Native/issues/30#issuecomment-123";
      receipt.observations[0].readinessProducer = "issue-readiness.yml@protected-dev";
    }),
    rewritten((receipt) => (receipt.observations[0].linkedPullRequest = { head: "3".repeat(40), number: 88, target: "epic/29-contracts" })),
    rewritten((receipt) => (receipt.observations[0].state = "closed")),
    altered((input) => (input.target = "main")),
    altered((input) => (input.pullRequest.state = "closed")),
    altered((input) => (input.pullRequest.merged = true)),
    altered((input) => (input.pullRequest = {})),
    altered((input) => (input.issueTitles = [])),
    altered((input) => (input.issueTitles[0].title = "Changed publication title")),
    altered((input) => input.issueTitles.push({ ...input.issueTitles[0] })),
    altered((input) => (input.terminalManifest = { digest: "c".repeat(64), entries: [], path: "docs/qa/repository-migration-manifest-v1.md" })),
    { ...ordinaryCandidate(), unexpected: true },
  ]) {
    assert.equal(verifyPublicationCandidate(input).ok, false);
  }
});
test("binds exact diff, added paths, modes, bytes, digests, and head", () => {
  const changed = (mutate) => mutated(mutate);
  // prettier-ignore
  const invalid = [
    changed((input) => (input.diff = {})),
    changed((input) => (input.diff.truncated = true)),
    changed((input) => (input.diff.head = "4".repeat(40))),
    changed((input) => (input.receipt.digest = "a".repeat(64))),
    changed((input) => (input.receipt.path = "docs/contracts/publications/pr-78.md")),
    changed((input) => (input.receipt.bytes = Buffer.from("changed\n"))),
    changed((input) => (input.receipt = {})),
    changed((input) => rewriteReceipt(input, (receipt) => (receipt.pullRequest = 999))),
    changed((input) => (input.newlyAdded.entries[0].mode = "120000")),
    changed((input) => input.newlyAdded.entries[1].bytes.fill("x".charCodeAt(0))),
    changed((input) => input.newlyAdded.entries.reverse()),
    changed((input) => input.newlyAdded.entries.pop()),
    changed((input) => input.diff.files.push({ mode: "100644", path: "README.md", status: "added" })),
  ];
  for (const [index, input] of invalid.entries()) {
    assert.equal(verifyPublicationCandidate(input).ok, false, `${index}`);
  }
});
function resultClassification(input, accepted) {
  const classification = classifyPublicationLane(input.diff);
  const candidate = accepted.binding;
  return {
    ...classification,
    binding: {
      ...classification.binding,
      candidate,
      contractPaths: candidate.candidates.map(({ path }) => path),
      manifest: candidate.terminalManifest,
      receipt: candidate.receipt,
      submode: candidate.submode,
      target: candidate.target,
    },
  };
}
test("feeds the complete binding to the non-circular result matrix", () => {
  const input = ordinaryCandidate();
  const accepted = verifyPublicationCandidate(input);
  const classification = resultClassification(input, accepted);
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
  const classification = resultClassification(input, accepted);
  const hostile = new Proxy({}, { get: () => assert.fail("SECRET") });
  // prettier-ignore
  const normal = { binding: { base, head, lane: "normal", pullRequest: 77, repository }, lane: "normal", ok: true };
  // prettier-ignore
  const failed = (lane) => ({ contexts: { "Contract publication": "failure", "Issue contract current": "failure", "PR contract": "failure" }, lane, ok: true, readinessClaim: false });
  for (const [value, lane] of [
    [hostile, "invalid"],
    [{ classification: hostile, publication: accepted }, "invalid"],
    [{ classification: normal, normal: hostile }, "invalid"],
    [{ classification, publication: hostile }, "publication"],
    // prettier-ignore
    [{ classification, publication: { binding: hostile, ok: true } }, "publication"],
    // prettier-ignore
    [{ classification: { binding: hostile, lane: "publication", ok: true }, publication: accepted }, "invalid"],
  ]) {
    const result = publicationResultMatrix(value);
    assert.deepEqual(result, failed(lane));
    assert.doesNotMatch(JSON.stringify(result), /SECRET/u);
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
