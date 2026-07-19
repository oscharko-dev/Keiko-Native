const contractPathPattern =
  /^docs\/contracts\/(epic|task|decision|defect)-([1-9]\d*)-v([1-9]\d*)-r([1-9]\d*)\.md$/u;

function reject(code, message) {
  return { ok: false, rejection: { code, message } };
}

export function parseContractPath(path) {
  const match =
    typeof path === "string" ? contractPathPattern.exec(path) : undefined;
  if (match === undefined || match === null) {
    return reject(
      "invalid_contract_path",
      "Contract path does not match the canonical repository grammar.",
    );
  }
  const [issue, version, revision] = match.slice(2).map(Number);
  if (![issue, version, revision].every(Number.isSafeInteger)) {
    return reject(
      "invalid_contract_path",
      "Contract path numeric identity is outside the supported range.",
    );
  }
  return {
    contract: {
      issue,
      path,
      revision,
      type: match[1],
      version,
    },
    ok: true,
  };
}

export function recoverySetFailure(recoveries) {
  const paths = new Map();
  for (const recovery of recoveries) {
    if (paths.get(recovery.path) === recovery.digest)
      return "duplicate_recovery";
    if (paths.has(recovery.path)) return "conflicting_recovery";
    paths.set(recovery.path, recovery.digest);
  }
  const sorted = recoveries.toSorted(compareByPath);
  return sorted.some((item, index) => item.path !== recoveries[index].path)
    ? "unsorted_recovery"
    : undefined;
}

function compareByPath(left, right) {
  return left.path < right.path ? -1 : 1;
}

function isDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isBinding(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    isDigest(value.digest) &&
    parseContractPath(value.path).ok
  );
}

function nodeFailure(node, state) {
  if (node === null || typeof node !== "object") return "invalid_chain_input";
  if (!parseContractPath(node.path).ok || !isDigest(node.digest)) {
    return "invalid_contract_identity";
  }
  if (node.state !== state) {
    return state === "authoritative"
      ? "non_authoritative_contract"
      : "unverified_quarantine";
  }
  if (state === "authoritative" && node.supersedes !== null) {
    if (!isBinding(node.supersedes)) return "invalid_predecessor";
  }
  return undefined;
}

function duplicateIdentity(nodes, replayCode) {
  const paths = new Set();
  const digests = new Set();
  for (const node of nodes) {
    if (paths.has(node.path) || digests.has(node.digest)) return replayCode;
    paths.add(node.path);
    digests.add(node.digest);
  }
  return undefined;
}

function chainCycle(nodesByPath) {
  for (const start of nodesByPath.values()) {
    const visited = new Set();
    let node = start;
    while (node !== undefined && node.supersedes !== null) {
      if (visited.has(node.path)) return true;
      visited.add(node.path);
      node = nodesByPath.get(node.supersedes.path);
    }
  }
  return false;
}

function recoveryFailure(recoveries) {
  if (
    !Array.isArray(recoveries) ||
    recoveries.some((item) => !isBinding(item))
  ) {
    return "invalid_recovery";
  }
  return recoverySetFailure(recoveries);
}

function sameIssue(left, right) {
  return left.issue === right.issue;
}

function semanticTransitionFailure(previous, current) {
  if (previous === undefined) {
    return current.version === 1 ? undefined : "unexplained_semantic_gap";
  }
  if (current.version < previous.version) return "stale_predecessor";
  if (current.version > previous.version + 1) {
    return "unexplained_semantic_gap";
  }
  if (current.version === previous.version && current.type !== previous.type) {
    return "type_change_requires_semantic_version";
  }
  return undefined;
}

function attemptInGap(identity, current, firstRevision) {
  return (
    identity.version === current.version &&
    identity.type === current.type &&
    identity.revision >= firstRevision &&
    identity.revision < current.revision
  );
}

function quarantineAttempts(current, firstRevision, quarantinedByPath) {
  return [...quarantinedByPath.values()]
    .map((attempt) => ({
      attempt,
      identity: parseContractPath(attempt.path).contract,
    }))
    .filter(({ identity }) => attemptInGap(identity, current, firstRevision))
    .toSorted(
      (left, right) => left.identity.revision - right.identity.revision,
    );
}

function expectedGap(previous, current, quarantinedByPath) {
  const transitionFailure = semanticTransitionFailure(previous, current);
  if (transitionFailure !== undefined) return { failure: transitionFailure };
  const firstRevision =
    previous?.version === current.version ? previous.revision + 1 : 1;
  const attempts = quarantineAttempts(
    current,
    firstRevision,
    quarantinedByPath,
  );
  if (attempts.length !== current.revision - firstRevision) {
    return { failure: "unexplained_revision_gap" };
  }
  const expected = attempts
    .map(({ attempt }) => ({ digest: attempt.digest, path: attempt.path }))
    .toSorted(compareByPath);
  return { expected };
}

function exactRecoveryFailure(actual, expected) {
  const shapeFailure = recoveryFailure(actual);
  if (shapeFailure !== undefined) return shapeFailure;
  if (actual.length < expected.length) return "incomplete_recovery";
  if (actual.length > expected.length) return "unexpected_recovery";
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index].path !== expected[index].path)
      return "unexpected_recovery";
    if (actual[index].digest !== expected[index].digest) {
      return "conflicting_recovery";
    }
  }
  return undefined;
}

function validateOrderedChain(
  root,
  successors,
  metadata,
  quarantinedByPath,
  consumed,
) {
  let current = root;
  let previous;
  while (current !== undefined) {
    const currentMetadata = metadata.get(current.path);
    const gap = expectedGap(previous, currentMetadata, quarantinedByPath);
    if (gap.failure !== undefined) return gap.failure;
    const recovery = exactRecoveryFailure(current.recoveries, gap.expected);
    if (recovery !== undefined) return recovery;
    for (const item of gap.expected) consumed.add(item.path);
    previous = currentMetadata;
    current = successors.get(current.path);
  }
  return undefined;
}

function validatedNodes(nodes, state) {
  if (!Array.isArray(nodes)) return { failure: "invalid_chain_input" };
  for (const node of nodes) {
    const failure = nodeFailure(node, state);
    if (failure !== undefined) return { failure };
  }
  return { nodes };
}

function prepareChain(input) {
  const authoritative = validatedNodes(input?.contracts, "authoritative");
  const quarantined = validatedNodes(input?.quarantined, "quarantined");
  if (authoritative.failure !== undefined) return authoritative;
  if (quarantined.failure !== undefined) return quarantined;
  if (authoritative.nodes.length === 0) return { failure: "empty_chain" };
  const replay = duplicateIdentity(authoritative.nodes, "replayed_contract");
  const quarantineReplay = duplicateIdentity(
    quarantined.nodes,
    "replayed_quarantine",
  );
  if (replay !== undefined || quarantineReplay !== undefined) {
    return { failure: replay ?? quarantineReplay };
  }
  const authoritativePaths = new Set(
    authoritative.nodes.map((node) => node.path),
  );
  const authoritativeDigests = new Set(
    authoritative.nodes.map((node) => node.digest),
  );
  if (
    quarantined.nodes.some(
      (node) =>
        authoritativePaths.has(node.path) ||
        authoritativeDigests.has(node.digest),
    )
  ) {
    return { failure: "conflicting_contract_state" };
  }
  const nodesByPath = new Map(
    authoritative.nodes.map((node) => [node.path, node]),
  );
  const metadata = new Map(
    authoritative.nodes.map((node) => [
      node.path,
      parseContractPath(node.path).contract,
    ]),
  );
  return { authoritative, metadata, nodesByPath, quarantined };
}

function issueIdentityFailure(context) {
  const identity = context.metadata.values().next().value;
  const quarantineMetadata = context.quarantined.nodes.map(
    (node) => parseContractPath(node.path).contract,
  );
  if (
    [...context.metadata.values(), ...quarantineMetadata].some(
      (item) => !sameIssue(identity, item),
    )
  )
    return "mixed_issue_chain";
  return undefined;
}

function predecessorFailure(context) {
  for (const node of context.authoritative.nodes) {
    if (node.supersedes === null) continue;
    const predecessor = context.nodesByPath.get(node.supersedes.path);
    if (
      predecessor === undefined ||
      predecessor.digest !== node.supersedes.digest
    )
      return "stale_predecessor";
  }
  return chainCycle(context.nodesByPath) ? "cyclic_chain" : undefined;
}

function chainTopology(nodes) {
  const roots = nodes.filter((node) => node.supersedes === null);
  if (roots.length !== 1) return { failure: "forked_chain" };
  const successors = new Map();
  for (const node of nodes) {
    if (node.supersedes === null) continue;
    if (successors.has(node.supersedes.path)) {
      return { failure: "duplicate_predecessor" };
    }
    successors.set(node.supersedes.path, node);
  }
  return {
    root: roots[0],
    successors,
    terminal: nodes.find((node) => !successors.has(node.path)),
  };
}

function pendingQuarantineFailure(context, topology, consumed) {
  const pending = context.quarantined.nodes
    .filter((node) => !consumed.has(node.path))
    .map((node) => ({ node, ...parseContractPath(node.path).contract }))
    .toSorted(
      (left, right) =>
        left.version - right.version || left.revision - right.revision,
    );
  if (pending.length === 0) return undefined;
  const terminal = context.metadata.get(topology.terminal.path);
  const first = pending[0];
  const sameVersion = first.version === terminal.version;
  if (!sameVersion && first.version !== terminal.version + 1) {
    return "orphan_quarantine";
  }
  if (sameVersion && first.type !== terminal.type) {
    return "orphan_quarantine";
  }
  const firstRevision = sameVersion ? terminal.revision + 1 : 1;
  return pending.every(
    (item, index) =>
      item.version === first.version &&
      item.type === first.type &&
      item.revision === firstRevision + index,
  )
    ? undefined
    : "orphan_quarantine";
}

function orderedChainFailure(context, topology) {
  const quarantinedByPath = new Map(
    context.quarantined.nodes.map((node) => [node.path, node]),
  );
  const consumed = new Set();
  const failure = validateOrderedChain(
    topology.root,
    topology.successors,
    context.metadata,
    quarantinedByPath,
    consumed,
  );
  return failure ?? pendingQuarantineFailure(context, topology, consumed);
}

function rejectChain(code) {
  return reject(code, "Repository contract chain failed closed.");
}

export function validateContractChain(input) {
  const context = prepareChain(input);
  if (context.failure !== undefined) return rejectChain(context.failure);
  const structuralFailure =
    issueIdentityFailure(context) ?? predecessorFailure(context);
  if (structuralFailure !== undefined) return rejectChain(structuralFailure);
  const topology = chainTopology(context.authoritative.nodes);
  if (topology.failure !== undefined) return rejectChain(topology.failure);
  const orderedFailure = orderedChainFailure(context, topology);
  return orderedFailure === undefined
    ? { ok: true, terminal: topology.terminal }
    : rejectChain(orderedFailure);
}
