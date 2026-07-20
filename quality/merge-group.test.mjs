import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
// prettier-ignore
import { bindMergeGroupSnapshot, classifyMergeGroupConstituent, evaluateMergeGroup, verifyCombinedGroupTree, verifyGroupCommitTree } from "./merge-group.mjs";
// prettier-ignore
import { classifyLifecycleHandoffLane, coalesceLifecycleInputGeneration } from "./lifecycle-handoff.mjs";
// prettier-ignore
import { issueSchemaForLabels, semanticIssueFingerprint } from "./issue-contract.mjs";
import { verifyPublicationCandidate } from "./publication-candidate.mjs";
import { contractSha256 } from "./repository-contract.mjs";

const sha = (value) => value.repeat(40);
// prettier-ignore
function gitObject(bytes, algorithm = "sha1") { const header = Buffer.from(`commit ${bytes.byteLength}\0`); return { bytes, sha: createHash(algorithm).update(header).update(bytes).digest("hex") }; }
// prettier-ignore
function gitCommit(tree, parents = [], algorithm = "sha1") { return gitObject(new TextEncoder().encode(`tree ${tree}\n${parents.map((parent) => `parent ${parent}\n`).join("")}\nmerge group\n`), algorithm); }
const repository = "oscharko-dev/Keiko-Native";
const target = "dev";
const [base, head, fingerprint] = [sha("1"), sha("2"), "c".repeat(64)];
const completeSection =
  "- Contract version: `v2`\n- Applicability: Required\n- Actor: Developer\n- [x] Scope and verification are complete.\n\n```text\nnode --test quality/merge-group.test.mjs\n```";
// prettier-ignore
const contractBody = issueSchemaForLabels(["type: task"]).requiredHeadings.map((heading) => `## ${heading}\n\n${heading === "Acceptance criteria" ? "- [ ] AC1 — Candidate is accepted." : completeSection}`).join("\n\n");
// prettier-ignore
const producers = { "Contract publication": "contract-policy.yml@protected-dev", "Issue contract current": "contract-policy.yml@protected-dev", "Lifecycle handoff": "lifecycle-handoff.yml@protected-dev", "PR contract": "contract-policy.yml@protected-dev" };
// prettier-ignore
const normalProducers = Object.fromEntries(Object.entries(producers).filter(([key]) => key !== "Contract publication"));
// prettier-ignore
const observed = (revision, lifecycle, observedTarget = target) => ({
  fields: [["issueRevision", revision], ["readiness", `10:v2:${fingerprint}`], ["lifecycle", lifecycle], ["target", observedTarget], ["reviews", "reviews-1"], ["conversations", "conversations-1"], ["audit", "audit-1"], ["journey", "journey-1"], ["manual", "manual-1"], ["external", "external-1"], ["platform", "platform-1"], ["upstream", "upstream-1"]].map(([name, value]) => ({ name, value: { type: "string", value } })),
  type: "record",
});
// prettier-ignore
function normalMember(pullRequest = 32, memberHead = sha("3"), identity = {}) {
  const issueIdentity = `issue-${pullRequest}`;
  const memberTarget = identity.target ?? target;
  const b4Producers = { ...normalProducers, ...identity.b4Producers };
  const laneInput = {
    authority: { evidence: "normal-observation-1", head: memberHead, id: `${issueIdentity}-v2`, issueIdentity, lane: "normal", pullRequest, repository, scope: "quality/merge-group*", target: memberTarget },
    diff: { base, complete: true, files: [], head: memberHead, normalValidated: true, pullRequest, repository, truncated: false },
    target: memberTarget,
  };
  const classification = classifyLifecycleHandoffLane(laneInput);
  const binding = (identity.forge?.(classification.binding), classification.binding);
  const generationRequest = { attemptSequence: 0, classification, expectedProducers: b4Producers, inputs: observed("observation-2", "status: ready for human review", memberTarget) };
  let state = coalesceLifecycleInputGeneration(generationRequest);
  for (const context of ["Issue contract current", "PR contract"]) {
    state = coalesceLifecycleInputGeneration({
      ...generationRequest,
      completion: { conclusion: "success", context, generation: state.generation.digest, head: memberHead, output: { binding, ok: true }, producer: b4Producers[context], result: `${context}-result${identity.resultSuffix ?? ""}`, workflowRun: `${context}-run${identity.resultSuffix ?? ""}` },
      prior: state.generation,
    });
  }
  const eventIdentity = identity.eventIdentity ?? `handoff-${pullRequest}`;
  const transition = { actorRole: "implementer", applied: true, authority: binding.authority, eventIdentity, head: binding.head, issueIdentity: binding.issueIdentity, lockFence: "issue-fence-1", producer: b4Producers["Lifecycle handoff"], pullRequest: binding.pullRequest, repository: binding.repository, result: "handoff-result", resultRevision: "observation-2", source: "status: pr open", sourceRevision: "observation-1", target: "status: ready for human review", targetRef: binding.target, workflowRun: "handoff-run" };
  return {
    handoffInput: {
      classification, generation: state.generation, generationRequest,
      phaseOne: { conversationsCurrent: true, evidenceCurrent: true, excludedContexts: ["Lifecycle handoff"], head: memberHead, inputs: observed("observation-1", "status: pr open", memberTarget), lockFence: "issue-fence-1", ok: true, reviewsCurrent: true, sourceState: "status: pr open", target: memberTarget },
      readiness: {
        comments: [{ body: `<!-- keiko-native-readiness -->\n- Status: \`accepted\`\n- Contract version: \`v2\`\n- Fingerprint: \`${fingerprint}\``, id: 10, user: { id: 41898282, login: "github-actions[bot]", type: "Bot" } }],
        currentFingerprint: fingerprint, currentVersion: "v2", expectedCommentId: 10,
      },
      readback: { actualIssueIdentity: binding.issueIdentity, expectedIssueIdentity: binding.issueIdentity, head: binding.head, issueRevision: "observation-2", labels: ["status: ready for human review"], transitionIdentity: eventIdentity },
      transition,
    },
    head: memberHead, laneInput, pullRequest,
  };
}
// prettier-ignore
function publicationCandidate(lifecycle = null, pullRequest = 33, memberHead = head) {
  const contractBytes = Buffer.from(contractBody);
  const issueTitle = `Publication candidate ${pullRequest}`;
  const contract = { digest: contractSha256(contractBytes).digest, mode: "100644", path: `docs/contracts/task-${pullRequest}-v2-r1.md` };
  const migration = lifecycle !== null;
  const observation = {
    candidatePath: contract.path, fingerprint: semanticIssueFingerprint(contractBody, issueTitle), lifecycleLabels: [lifecycle ?? "status: new"], linkedPullRequest: null, number: pullRequest, predecessor: null,
    readiness: migration ? `https://github.com/oscharko-dev/Keiko-Native/issues/${pullRequest}#issuecomment-1` : null,
    readinessProducer: migration ? "issue-readiness.yml@protected-dev" : null,
    recoveries: [], revision: 1, state: "open", type: "task", version: 2,
  };
  const receiptPath = `docs/contracts/publications/pr-${pullRequest}.md`;
  const manifestBytes = Buffer.from(`${JSON.stringify({ entries: [observation] })}\n`);
  const manifest = migration ? { digest: contractSha256(manifestBytes).digest, path: "docs/qa/repository-migration-manifest-v1.md" } : null;
  const receiptValue = { candidates: [contract], observations: [observation], pullRequest, target: "dev", terminalManifest: manifest };
  const receiptBytes = Buffer.from(`${JSON.stringify(receiptValue)}\n`);
  return {
    diff: {
      base, complete: true, files: [{ mode: "100644", path: contract.path, status: "added" }, { mode: "100644", path: receiptPath, status: "added" }],
      head: memberHead, normalValidated: false, pullRequest, repository, truncated: false },
    issueObservations: [observation], issueTitles: [{ number: pullRequest, title: issueTitle }],
    newlyAdded: { base, entries: [{ bytes: receiptBytes, mode: "100644", path: receiptPath }, { bytes: contractBytes, mode: "100644", path: contract.path }], head: memberHead, pullRequest, repository },
    pullRequest: { base, baseRef: "dev", head: memberHead, merged: false, number: pullRequest, state: "open" },
    receipt: { bytes: receiptBytes, digest: contractSha256(receiptBytes).digest, path: receiptPath },
    repository, target: "dev",
    terminalManifest: migration ? { base, bytes: manifestBytes, digest: manifest.digest, mode: "100644", path: manifest.path, repository } : null,
  };
}
// prettier-ignore
function publicationMember(lifecycle = null, pullRequest = 33, memberHead = head, identity = {}) {
  const b4Producers = { ...producers, ...identity.b4Producers };
  const candidate = publicationCandidate(lifecycle, pullRequest, memberHead);
  const accepted = verifyPublicationCandidate(candidate);
  assert.equal(accepted.ok, true, accepted.code);
  const laneInput = {
    authority: {
      evidence: "publication-observation-1", head: memberHead, id: `publication-pr-${pullRequest}`, issueIdentity: `issue-${pullRequest}`, lane: "publication",
      manifest: accepted.binding.terminalManifest, pullRequest, receipt: accepted.binding.receipt, repository, scope: null, submode: accepted.binding.submode, target: "dev",
    },
    candidate, diff: candidate.diff, target: "dev",
  };
  const classification = classifyLifecycleHandoffLane(laneInput);
  const generationRequest = { attemptSequence: 0, classification, expectedProducers: b4Producers, inputs: observed("publication-1", `publication:${accepted.binding.submode}`) };
  generationRequest.inputs.fields[3].value.value = "dev";
  let state = coalesceLifecycleInputGeneration(generationRequest);
  for (const context of ["Contract publication", "Issue contract current", "PR contract"]) {
    state = coalesceLifecycleInputGeneration({
      ...generationRequest,
      completion: { conclusion: "success", context, generation: state.generation.digest, head: memberHead, output: structuredClone(accepted), producer: b4Producers[context], result: `${context}-result`, workflowRun: `${context}-run` },
      prior: state.generation,
    });
  }
  return {
    handoffInput: { candidate, classification, generation: state.generation, generationRequest },
    head: memberHead, laneInput, pullRequest,
  };
}
function groupRead(members = [normalMember()], groupTarget = target) {
  // prettier-ignore
  const composed = members.map((member, order) => ({ ...member, inputTree: sha(String.fromCharCode(97 + order)), order, outputTree: sha(String.fromCharCode(98 + order)) }));
  const groupTree = composed.at(-1).outputTree;
  // prettier-ignore
  const groupCommit = gitCommit(groupTree, [base, ...composed.map(({ head }) => head)]);
  return {
    baseTip: base,
    baseTree: sha("a"),
    cursor: "group-cursor-1",
    groupCommit: groupCommit.bytes,
    groupSha: groupCommit.sha,
    groupTree,
    members: composed,
    ordering: "proven",
    pagination: {
      complete: true,
      pages: [
        {
          end: "page-end-1",
          index: 0,
          members: composed.map(({ pullRequest }) => pullRequest),
          start: "group-cursor-1",
        },
      ],
      truncated: false,
    },
    repository,
    target: groupTarget,
  };
}
function groupInput(read, expectedProducers = producers, overrides = {}) {
  return {
    event: "checks_requested",
    expectedProducers,
    firstRead: read,
    secondRead: read,
    ...overrides,
  };
}
const bindGroup = (read, expectedProducers, overrides) =>
  bindMergeGroupSnapshot(groupInput(read, expectedProducers, overrides));
// prettier-ignore
const paginationMutations = [(read) => (read.pagination.complete = false), (read) => (read.pagination.truncated = true), (read) => (read.pagination.Injected = true), (read) => (read.Injected = true), (read) => (read.pagination.pages = null), (read) => (read.pagination.pages[0] = null), (read) => (read.pagination.pages[0].index = 1), (read) => (read.pagination.pages[0].members = null), (read) => (read.pagination.pages[0].members[0] = "33"), (read) => (read.pagination.pages[0].start = ""), (read) => (read.pagination.pages[0].Injected = true), (read) => (read.pagination.pages[0].members[0] = 99)];
function changedGroup(valid, mutate) {
  const read = structuredClone(valid);
  mutate(read);
  return bindGroup(read);
}
function groupEvaluation(input, snapshot, overrides = {}) {
  return evaluateMergeGroup({
    ...input,
    invalidatedSnapshots: [],
    snapshotReadback: snapshot,
    ...overrides,
  });
}
test("binds a stable group snapshot and publishes only after exact readback", () => {
  const read = groupRead();
  const input = groupInput(read, producers, {
    secondRead: structuredClone(read),
  });
  const bound = bindMergeGroupSnapshot(input);
  assert.equal(bound.ok, true);
  const result = groupEvaluation(input, bound.snapshot);
  assert.equal(result.ok, true);
  assert.equal(result.action, "publish");
  assert.equal(result.head, read.groupSha);
  assert.notEqual(result.head, read.members[0].head);
  const changed = groupRead();
  changed.pagination.pages[0].end = "page-end-2";
  const rebound = bindGroup(changed);
  assert.notEqual(rebound.snapshot.id, bound.snapshot.id);
});
test("accepts all-normal, all-publication, and mixed ordered groups", () => {
  const migration = publicationMember("status: blocked", 34, sha("4"));
  const migrated = classifyMergeGroupConstituent(migration);
  assert.equal(migrated.binding.submode, "migration");
  for (const members of [
    [normalMember()],
    [publicationMember()],
    [migration],
    [normalMember(), publicationMember()],
    [publicationMember(), migration],
  ]) {
    const read = groupRead(members);
    const result = bindGroup(read);
    assert.equal(result.ok, true, result.code);
  }
});
test("binds every constituent result and transition identity", () => {
  const bind = (member) => bindGroup(groupRead([member]));
  const original = bind(normalMember());
  const changedResult = bind(
    normalMember(32, sha("3"), { resultSuffix: "-2" }),
  );
  const changedTransition = bind(
    normalMember(32, sha("3"), { eventIdentity: "handoff-32-2" }),
  );
  assert.equal(original.ok, true);
  assert.equal(changedResult.ok, true);
  assert.equal(changedTransition.ok, true);
  assert.notEqual(changedResult.snapshot.id, original.snapshot.id);
  assert.notEqual(changedTransition.snapshot.id, original.snapshot.id);
});
test("rejects incomplete, truncated, malformed, and unstable pagination", () => {
  const valid = groupRead([normalMember(), publicationMember()]);
  const changed = (mutate) => changedGroup(valid, mutate);
  for (const result of [
    ...paginationMutations.map(changed),
    bindGroup(valid, producers, { event: "other" }),
    bindGroup(valid, producers, { secondRead: { ...valid, cursor: "later" } }),
  ])
    assert.equal(result.ok, false);
});
test("rejects reordered, duplicated, stale, and invalidated members", () => {
  const valid = groupRead([normalMember(), publicationMember()]);
  const changed = (mutate) => changedGroup(valid, mutate);
  for (const result of [
    changed((read) => read.members.reverse()),
    changed((read) => (read.members = [])),
    changed(
      (read) => (read.members[1].pullRequest = read.members[0].pullRequest),
    ),
    changed((read) => (read.members[1].head = read.members[0].head)),
    changed((read) => (read.members[1].order = 0)),
    changed((read) => (read.members[0].Injected = true)),
    changed((read) => (read.groupSha = read.members[0].head)),
    changed((read) => (read.members[1].inputTree = sha("f"))),
    changed((read) => (read.ordering = "weak")),
    changed((read) => (read.repository = "")),
    changed((read) => (read.repository = "other/repository")),
    changed((read) => (read.target = "epic/other")),
    changed((read) => (read.baseTip = "bad")),
  ])
    assert.equal(result.ok, false);
  const input = groupInput(valid);
  const bound = bindMergeGroupSnapshot(input);
  for (const result of [
    evaluateMergeGroup({ ...input, snapshotReadback: bound.snapshot }),
    groupEvaluation(input, bound.snapshot, { invalidatedSnapshots: ["bad"] }),
    groupEvaluation(input, { ...bound.snapshot, groupSha: head }),
    groupEvaluation(input, bound.snapshot, {
      invalidatedSnapshots: [bound.snapshot.id],
    }),
  ])
    assert.equal(result.ok, false);
});
test("rejects discontinuous, duplicated, and cursor-detached group pages", () => {
  const valid = groupRead([normalMember(), publicationMember()]);
  valid.pagination.pages = [
    { end: "boundary-1", index: 0, members: [32], start: valid.cursor },
    { end: "boundary-2", index: 1, members: [33], start: "boundary-1" },
  ];
  for (const mutate of [
    (read) => (read.pagination.pages[0].start = "detached"),
    (read) => (read.pagination.pages[1].start = "gap"),
    (read) => (read.pagination.pages[1].end = "boundary-1"),
    (read) => (read.pagination.pages[1].end = read.cursor),
  ])
    assert.equal(changedGroup(valid, mutate).ok, false);
});

test("rejects a self-consistent non-dev normal group", () => {
  const epic = "epic/29-repository-backed-contracts";
  const read = groupRead([normalMember(32, sha("3"), { target: epic })], epic);
  assert.equal(bindGroup(read).ok, false);
});

test("authenticates normal and publication handoff producer policies", () => {
  const forged = { "Issue contract current": "forged" };
  for (const member of [
    normalMember(32, sha("3"), { b4Producers: forged }),
    normalMember(32, sha("3"), { b4Producers: { surplus: "forged" } }),
    publicationMember(null, 33, head, { b4Producers: forged }),
  ]) {
    const read = groupRead([member]);
    assert.equal(bindGroup(read).ok, false);
  }
  const original = bindGroup(groupRead([normalMember()]));
  // prettier-ignore
  const alternate = Object.fromEntries(Object.keys(producers).map((key) => [key, `alternate-${key}.yml@protected-dev`]));
  // prettier-ignore
  const normalAlternate = Object.fromEntries(Object.entries(alternate).filter(([key]) => key !== "Contract publication"));
  const member = normalMember(32, sha("3"), { b4Producers: normalAlternate });
  const read = groupRead([member], target);
  const bound = bindGroup(read, alternate);
  assert.equal(bound.ok, true);
  assert.notEqual(bound.snapshot.id, original.snapshot.id);
});

test("rejects invalid lane, generation, publication, handoff, and member identity", () => {
  const changed = (create, mutate) => {
    const member = create();
    mutate(member);
    return classifyMergeGroupConstituent(member);
  };
  // prettier-ignore
  const forgeries = [(binding) => (binding.authority = "forged-authority"), (binding) => (binding.issueIdentity = "issue-forged"), (binding) => (binding.evidence = "forged-evidence"), (binding) => (binding.scope = "forged-scope"), (binding) => binding.diff.push({ mode: "100644", path: "forged", previous: null, status: "added" })];
  for (const result of [
    ...forgeries.map((forge) =>
      classifyMergeGroupConstituent(normalMember(32, sha("3"), { forge })),
    ),
    changed(normalMember, (member) => (member.laneInput.diff.complete = false)),
    changed(
      normalMember,
      (member) => (member.handoffInput.classification = { ok: false }),
    ),
    changed(
      normalMember,
      (member) => (member.handoffInput.generation.digest = "f".repeat(64)),
    ),
    changed(publicationMember, (member) => {
      member.handoffInput.candidate = structuredClone(
        member.handoffInput.candidate,
      );
      member.handoffInput.candidate.receipt.digest = "f".repeat(64);
    }),
    changed(
      normalMember,
      (member) =>
        (member.handoffInput.generation.results["PR contract"].producer =
          "forged"),
    ),
    changed(normalMember, (member) => (member.head = sha("8"))),
    changed(normalMember, (member) => (member.pullRequest = 99)),
  ])
    assert.equal(result.ok, false);
});

test("rejects malformed, empty, broken, and unexplained tree composition", () => {
  const valid = groupRead();
  for (const input of [
    null,
    { ...valid, baseTree: "bad" },
    { ...valid, members: [] },
    { ...valid, members: [null] },
    { ...valid, members: [{ ...valid.members[0], inputTree: "bad" }] },
    { ...valid, members: [{ ...valid.members[0], outputTree: "bad" }] },
    { ...valid, groupTree: sha("f") },
  ])
    assert.equal(verifyCombinedGroupTree(input).ok, false);
});
// prettier-ignore
test("rejects a composed tree that is not bound to the group commit", () => { const read = groupRead(); read.groupTree = sha("f"); read.members.at(-1).outputTree = read.groupTree; assert.equal(bindGroup(read).ok, false); });
// prettier-ignore
test("verifies SHA-1 and SHA-256 group commit objects and rejects bad evidence", () => { const [tree, root, member, wrong] = ["a", "b", "c", "d"].map((value) => value.repeat(64)); const make = (parents, overrides = {}) => { const object = gitCommit(tree, parents, "sha256"); return { baseTip: root, groupCommit: object.bytes, groupSha: object.sha, groupTree: tree, members: [{ head: member }], ...overrides }; }; assert.equal(verifyGroupCommitTree(make([root, member])).ok, true); const noLine = gitObject(new TextEncoder().encode("parent")); const noTree = gitObject(new TextEncoder().encode(`parent ${sha("1")}\n`)); for (const input of [null, {}, make([]), make([root]), make([member, root]), make([root, member, member]), make([root, root]), make([root, member], { baseTip: wrong }), make([root, member], { members: [{ head: wrong }] }), { ...make([root, member]), groupSha: "a".repeat(48), groupTree: "b".repeat(48) }, { ...make([root, member]), groupTree: wrong }, { baseTip: sha("1"), groupCommit: noLine.bytes, groupSha: noLine.sha, groupTree: sha("2"), members: [{ head: sha("3") }] }, { baseTip: sha("1"), groupCommit: noTree.bytes, groupSha: noTree.sha, groupTree: sha("2"), members: [{ head: sha("3") }] }]) assert.equal(verifyGroupCommitTree(input).ok, false); });

test("fails closed on hostile constituent, tree, snapshot, and readback evidence", () => {
  const hostile = new Proxy({}, { get: () => assert.fail("SECRET") });
  // prettier-ignore
  for (const decide of [classifyMergeGroupConstituent, verifyCombinedGroupTree, verifyGroupCommitTree, bindMergeGroupSnapshot])
    assert.equal(decide(hostile).ok, false);
  const read = groupRead();
  const input = {
    event: "checks_requested",
    expectedProducers: producers,
    firstRead: read,
    invalidatedSnapshots: [],
    secondRead: read,
  };
  const readback = new Proxy(
    { ...input },
    {
      get: (value, key) =>
        key === "snapshotReadback"
          ? assert.fail("SECRET")
          : Reflect.get(value, key),
    },
  );
  assert.equal(evaluateMergeGroup(readback).ok, false);
});
