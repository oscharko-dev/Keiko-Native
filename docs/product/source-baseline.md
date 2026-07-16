# Private source provenance

## Governed identity

- Document: `Keiko-Native-Fachkonzept.md`
- Version: `0.6`
- Date: `2026-07-15`
- SHA-256: `d77a78fb79fc1de882487195d3f2295936f24a34e6bc0579106ad06104737a98`
- Repository access: private external source; the document itself must not be committed

The digest identifies the exact private source from which the repository-owned
[`Agent Planning Baseline`](../planning/agent-planning-baseline.md) was derived. A different digest
is a different source version, but it changes no repository requirement until a human explicitly
approves a new projection or product amendment.

## Provenance-only boundary

The private source is provenance only. No epic, issue, implementation, audit, or review task may
require access to it. Never copy the source document, private excerpts, confidential metadata, or
an access location into this repository, an issue, a pull request, a log, or generated evidence.

Apply this authority order:

1. The [Decision Addendum](../planning/decision-addendum.md) governs approved product, scope,
   replacement, and sequencing amendments.
2. The [Agent Planning Baseline](../planning/agent-planning-baseline.md) is the complete
   repository-visible functional and quality baseline for planning.
3. Accepted [Native ADRs](../adr/README.md) govern technical decisions within that product boundary.
4. [`CONTEXT.md`](../../CONTEXT.md) provides the current canonical vocabulary and decision
   projection.
5. The accepted epic and issue provide the complete implementation-specific requirements and
   evidence contract.

## Repository-only planning rule

Before an epic can become `Implementation Ready`, its Planning Contract must select and restate the
complete issue-specific behavior, quality attributes, constraints, non-goals, platform expectations,
failure and recovery behavior, trust boundaries, and acceptance obligations derived from the Agent
Planning Baseline. Child issues must contain their complete executable slice of that contract.

Planning and implementation agents must be able to perform their work from repository records and
accepted GitHub contracts without access to the private source. A missing or ambiguous repository
requirement stops readiness and returns to the product owner for an explicit repository-visible
decision or baseline amendment.
