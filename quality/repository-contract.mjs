import { createHash } from "node:crypto";

import {
  parseContractPath,
  recoverySetFailure,
} from "./repository-contract-chain.mjs";

export {
  parseContractPath,
  validateContractChain,
} from "./repository-contract-chain.mjs";

const declarationPattern =
  /^(Supersedes|Recovers-Publication): ([0-9a-f]{64}) (docs\/contracts\/[A-Za-z0-9./-]+\.md)$/u;

function reject(code, message) {
  return { ok: false, rejection: { code, message } };
}

export function contractSha256(blobBytes) {
  if (!(blobBytes instanceof Uint8Array)) {
    return reject(
      "invalid_blob_bytes",
      "Contract identity requires an exact byte sequence.",
    );
  }
  return {
    digest: createHash("sha256").update(blobBytes).digest("hex"),
    ok: true,
  };
}

function contractBodyLines(body) {
  return typeof body === "string" ? body.split(/\r?\n/u) : undefined;
}

function parseDeclarationLine(line, expectedName) {
  const match = declarationPattern.exec(line);
  if (match === null || match[1] !== expectedName) return undefined;
  const parsedPath = parseContractPath(match[3]);
  if (!parsedPath.ok) return undefined;
  return { digest: match[2], path: match[3] };
}

export function parseSupersessionDeclaration(body) {
  const lines = contractBodyLines(body);
  if (lines === undefined) {
    return reject("invalid_contract_body", "Contract body must be text.");
  }
  const declarations = lines.filter((line) => line.startsWith("Supersedes:"));
  if (declarations.length === 0) return { ok: true, supersedes: null };
  if (declarations.length !== 1) {
    return reject(
      "duplicate_supersession",
      "Contract must declare at most one authoritative predecessor.",
    );
  }
  const supersedes = parseDeclarationLine(declarations[0], "Supersedes");
  return supersedes === undefined
    ? reject(
        "malformed_supersession",
        "Supersession declaration does not match the canonical grammar.",
      )
    : { ok: true, supersedes };
}

export function parseQuarantineRecoveryDeclarations(body) {
  const lines = contractBodyLines(body);
  if (lines === undefined) {
    return reject("invalid_contract_body", "Contract body must be text.");
  }
  const declarations = lines.filter((line) =>
    line.startsWith("Recovers-Publication:"),
  );
  const recoveries = declarations.map((line) =>
    parseDeclarationLine(line, "Recovers-Publication"),
  );
  if (recoveries.includes(undefined)) {
    return reject(
      "malformed_recovery",
      "Recovery declaration does not match the canonical grammar.",
    );
  }
  const failure = recoverySetFailure(recoveries);
  return failure === undefined
    ? { ok: true, recoveries }
    : reject(failure, "Recovery declarations are not a canonical set.");
}

const verificationOrigins = new Set(
  "api comment protected-bytes protected-commit protected-tree stable-provider-identity workflow".split(
    " ",
  ),
);
const verificationStatuses = new Set(
  "contradiction inconsistent malformed permission-denied rate-limited transient unavailable valid".split(
    " ",
  ),
);
const immutableContradictionOrigins = new Set(
  "protected-bytes protected-commit protected-tree stable-provider-identity".split(
    " ",
  ),
);
const requiredAuthorityOrigins = new Set(
  "protected-bytes protected-commit protected-tree stable-provider-identity".split(
    " ",
  ),
);

function verificationResult(state, reason) {
  return {
    consumesRevision: state === "quarantined",
    ok: true,
    reason,
    retry: state === "indeterminate" ? "same_revision" : "none",
    state,
  };
}

function validCheck(check) {
  return (
    check !== null &&
    typeof check === "object" &&
    verificationOrigins.has(check.origin) &&
    verificationStatuses.has(check.status)
  );
}

function reproducibleImmutableContradiction(check) {
  return (
    check.status === "contradiction" &&
    check.reproducible === true &&
    immutableContradictionOrigins.has(check.origin)
  );
}

function completeAuthorityEvidence(checks) {
  const counts = new Map(
    [...requiredAuthorityOrigins].map((origin) => [origin, 0]),
  );
  for (const check of checks) {
    if (counts.has(check.origin)) {
      counts.set(check.origin, counts.get(check.origin) + 1);
    }
  }
  return [...counts.values()].every((count) => count === 1);
}

export function classifyContractVerification(evidence) {
  const checks = evidence?.checks;
  if (
    !Array.isArray(checks) ||
    checks.length === 0 ||
    checks.some((check) => !validCheck(check))
  ) {
    return verificationResult("indeterminate", "evidence_not_conclusive");
  }
  if (checks.some(reproducibleImmutableContradiction)) {
    return verificationResult(
      "quarantined",
      "reproducible_immutable_contradiction",
    );
  }
  return completeAuthorityEvidence(checks) &&
    checks.every((check) => check.status === "valid")
    ? verificationResult("authoritative", "all_required_facts_valid")
    : verificationResult("indeterminate", "evidence_not_conclusive");
}
