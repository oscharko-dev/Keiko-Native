# Keiko Native Parity Baseline

## Status

Approved replacement-evidence baseline, 2026-07-16. Capability inclusion decisions and delivery
status are governed by the parity ledger.

## Purpose

This document freezes the evidence sources used to define replacement readiness for the Keiko
Native greenfield rewrite. It prevents the Existing Keiko development stream from becoming an
unbounded moving target while preserving mandatory security, regulatory, compatibility, and
critical-correctness changes.

## Baseline Sources

### Released Baseline

- Repository: `oscharko-dev/Keiko`
- Release: `v0.2.15`
- Commit: `9f3fb998d052f6d8873a24c1bd35de938ab4357e`
- Release date: 2026-07-10
- Role: immutable mandatory inventory of released, user-relevant product capabilities

### Development Delta Snapshot

- Repository: `oscharko-dev/Keiko`
- Branch: `dev`
- Commit: `c79f1cda7a806d8d48fe22ba51b560a7a9c4ddff`
- Snapshot date: 2026-07-16
- Distance from released baseline: 58 commits
- Role: review source for post-release capabilities and mandatory deltas; not automatic scope

### Native Starting Point

- Repository: `oscharko-dev/Keiko-Native`
- Branch: `dev`
- Commit: `57efd614c2173ecd82d195bf96761aa258a15943`
- State: quality and governance bootstrap with no productive source roots or native targets

## Scope Rules

1. Released, user-relevant capabilities enter the parity ledger by default.
2. A released capability may be retired only by an explicit product decision with rationale and
   migration or user-impact treatment.
3. Development-delta features require an explicit include or exclude decision.
4. Security, regulatory, compatibility, and critical-correctness changes after the cut-off are
   evaluated as mandatory deltas.
5. Ordinary new features after the cut-off do not expand Native scope without change approval.
6. Parity concerns user outcomes and quality attributes, not source, layout, framework, or internal
   architecture equivalence.
7. Each Native implementation is independently designed; Existing Keiko provides evidence, not an
   implementation mandate.

## Progressive Decomposition Rule

Replacement scope is governed at two levels:

1. Before the first implementation epic, every top-level capability family is inventoried against
   the immutable baseline and classified as `released-mandatory`, `delta-review`, `mandatory-delta`,
   `transform`, `retire`, or `not-present`.
2. Before an implementation epic for a capability family becomes Ready, that family is decomposed
   into the user paths, sub-capabilities, contracts, failure states, platforms, and acceptance
   evidence required by that epic's Quality Envelope.

The second level may be completed just in time for the owning epic, but it must not silently change
the top-level inclusion decision. A newly discovered capability or mandatory delta updates the
ledger through explicit review rather than becoming incidental implementation scope.

## Hard Replacement Requirements

### Agentic Coding

Agentic Coding is mandatory even where its Native implementation intentionally replaces the
Existing Keiko runtime path rather than reproducing it. Replacement readiness requires a
state-of-the-art, governed coding-agent experience with human control, bounded authority,
reviewable effects, deterministic verification, recovery, and traceable evidence.

The first production Agentic Coding runtime must integrate the Codex App Server through a governed
Keiko Native boundary. Human-oriented Codex CLI output must not be scraped or treated as a product
protocol.

OpenCode is retired and is not a runtime, fallback, migration dependency, or compatibility target
for Keiko Native.

## Ledger Status Vocabulary

The ledger records three independent axes so source status, product disposition, and implementation
progress cannot be confused:

### Baseline status

- `released-mandatory`: present in the released baseline and required for replacement
- `delta-review`: present only after the released baseline or not proven as a released user outcome
- `mandatory-delta`: required security, regulatory, compatibility, or critical-correctness change
- `not-present`: absent from Existing Keiko and therefore a new Native capability

### Native disposition

- `preserve-outcome`: retain the accepted user outcome without prescribing implementation identity
- `transform`: retain the required outcome through an intentionally different Native realization
- `retire`: explicitly exclude the capability with rationale and user-impact treatment
- `defer`: keep an approved capability outside the current implementation horizon without treating it
  as replacement-complete

### Delivery status

- `planned`: approved scope without Native implementation evidence
- `in-progress`: implementation has started but replacement acceptance is incomplete
- `verified`: Native acceptance evidence satisfies the approved parity contract

## Next Evidence Work

The level-one inventory is recorded in `docs/planning/parity-ledger.md`. Detailed decomposition
starts from the repository-owned `docs/planning/agent-planning-baseline.md` and continues through
product surfaces, release-impact records, runtime routes, accepted ADRs, and executable
verification. A source file or ADR alone does not prove a released user capability, and no private
source access is required.
