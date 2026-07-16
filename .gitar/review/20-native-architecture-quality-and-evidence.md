@docs/adr/ADR-0001-keiko-parity-quality-gate-baseline.md
@docs/qa/quality-gates.md

# Native architecture, quality, and evidence review

Keep the governed Keiko core authoritative and native adapters narrow. Reject duplicated policy,
authority, evidence, memory, connector, workflow, or security subsystems when the shared core can be
extended. Cross-language and IPC contracts need explicit versioning, validation, compatibility,
ownership, and failure semantics.

Productive changes must declare their source roots and targets and provide deterministic build,
test, architecture, coverage, SBOM, sandbox, package, signing, and authoritative-platform evidence.
Coverage must exceed the 85% floor with real reserve. Tests must be hermetic and cover both sides of
every guard. Evidence is body-free, exact-head, producer-bound, and cannot be reused after a commit.

Review entitlements, update channels, notarization/signing, native dependencies, FFI memory safety,
filesystem containment, network egress, local-data protection, accessibility, and platform failure
modes where applicable. Name the concrete failure mode and the smallest owning-layer repair for
every finding.
