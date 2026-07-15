@SECURITY.md
@AGENTS.md

# Security and trust-boundary review

Trace every changed privileged flow end to end: contract, validation, authorization, platform API,
filesystem or network effect, persistence, evidence, retry, and failure behavior.

Require strict validation of hostile workspace, model, connector, IPC, URL, path, archive, update,
and persisted input. Preserve sandbox, entitlement, origin, destination, redirect, method, byte,
timeout, credential, and workspace boundaries. Keep credentials out of logs, errors, evidence,
fixtures, URLs, and durable state. Bind approvals and reconciliation to immutable current state;
reject stale, replayed, ambiguous, expired, revoked, or partially applied operations.

Demand deterministic negative tests for malformed, empty, boundary, oversized, hostile,
unauthorized, unavailable, stale, replayed, conflicting, and partially failed inputs. Happy-path
coverage alone is insufficient.
