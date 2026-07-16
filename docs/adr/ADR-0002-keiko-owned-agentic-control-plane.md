# ADR-0002: Keiko-owned agentic control plane

## Status

Accepted, 2026-07-16.

## Context

Agentic Coding is a hard Keiko Native requirement, and the Codex App Server is the first required
production coding runtime. Keiko Native must nevertheless remain model- and runtime-agnostic so
that API-backed, customer-provided, or locally hosted runtimes can be added without rebuilding
product governance.

Allowing a provider runtime to own Keiko's task lifecycle, authority decisions, approval records,
evidence semantics, or delivery state would couple regulated product behavior to that provider. It
would also make runtime replacement, deterministic recovery, independent audit, and consistent
human control materially harder.

## Decision

Keiko Native owns the Agentic Coding product and governance lifecycle. Its agentic control plane is
the normative authority for:

- workspace identity and containment;
- task and run identity, lifecycle, and recovery;
- Authority Envelopes, budgets, permissions, and tool policy;
- human approvals, denials, interruptions, and escalation;
- proposed effects, changesets, and delivery state;
- evidence, provenance, redaction, and retention semantics; and
- verification requirements and acceptance results.

Coding runtimes are integrated behind a governed, replaceable runtime adapter. The first adapter
uses the Codex App Server protocol; human-oriented CLI output is not a product protocol and must not
be scraped.

Provider-native threads, identifiers, events, messages, and status may be persisted as technical
correlation and diagnostic data. They do not become Keiko domain identity or override Keiko-owned
policy and lifecycle state. Runtime requests and events are validated, authorized, translated,
redacted, and recorded at the Keiko boundary before they affect product state.

The renderer communicates with the Keiko control plane rather than directly with a coding runtime.
Adding another runtime must not require a second authority, approval, evidence, verification, or
delivery subsystem.

## Consequences

Keiko Native can provide consistent regulated controls across Codex, future API runtimes, and local
models. Product state remains recoverable and auditable even when a runtime is unavailable,
restarted, upgraded, or replaced.

The architecture requires explicit Keiko lifecycle models, runtime capability negotiation, event
translation, idempotency, reconciliation, cancellation, timeout, and partial-failure handling. Some
provider-native behavior cannot be exposed until it has an approved Keiko contract. The adapter
adds implementation work but prevents provider-specific policy from spreading through the product.
