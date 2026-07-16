# Private product source baseline

## Governed identity

- Document: `Keiko-Native-Fachkonzept.md`
- Version: `0.6`
- Date: `2026-07-15`
- SHA-256: `d77a78fb79fc1de882487195d3f2295936f24a34e6bc0579106ad06104737a98`
- Repository access: private external source; the document itself must not be committed

The digest identifies the exact source reviewed for this planning baseline. A different digest is a
different source version and requires explicit human review before it can inform implementation.

## Access and authority

Only a human-authorized planner may access the private source. Never copy the source document,
private source excerpts, confidential metadata, or an access location into this repository, an
issue, a pull request, a log, or generated evidence.

The source Fachkonzept is planning input, not a direct implementation contract. Apply this
authority order:

1. The [Decision Addendum](../planning/decision-addendum.md) supersedes approved product, scope,
   replacement, and sequencing directions.
2. Accepted [Native ADRs](../adr/README.md) govern technical decisions within that product boundary.
3. [`CONTEXT.md`](../../CONTEXT.md) provides the current canonical vocabulary and decision
   projection.
4. The accepted epic and issue provide the complete implementation-specific requirements and
   evidence contract.

## Planning handoff rule

Before an epic can become `Implementation Ready`, its Planning Contract must restate every relevant
functional requirement, quality attribute, constraint, non-goal, platform expectation, failure and
recovery behavior, trust boundary, and acceptance obligation needed for that epic. Child issues
must contain their complete executable slice of that contract.

An implementation agent must be able to perform the work from the accepted epic and issue links,
the repository context, and accepted ADRs without access to the private Fachkonzept. A missing or
ambiguous requirement stops readiness; the planner must resolve it from the authorized source or
with the product owner before implementation begins.
