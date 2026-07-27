# ADR-0010: Stage guarded epic-merge proof at lifecycle activation

## Status

Proposed, 2026-07-27. Decision issue #118 selected this outcome. The record becomes accepted only
when an authorized maintainer manually merges its pull request to `dev`.

This record amends only ADR-0009's rollout and proof allocation. Accepted ADR-0009 remains
immutable and continues to govern the existing-maintainer credential, exact accepted `epic/**`
target, guarded authorization, durable serialization claim, at-most-once provider submission,
squash topology, read-back, redaction, ambiguity, recovery, and sacred-`dev` boundaries.

## Context

ADR-0009 assigned both implementation and live proof of the guarded child-to-epic merge operation
to Issue #50. Exact-head audit showed that allocation is structurally impossible before the
Contract-as-Code activation.

The guard loads policy from protected `dev`. Before the lifecycle work reaches `dev`, candidate
policy and status-producing code cannot authorize the protected workflow that executes the guard.
The expanded lifecycle is also intentionally inert before activation, so
`status: ready for human review` cannot truthfully exist as merge authority before the signed
Contract-as-Code activation. Treating legacy `status: ready` as compatible merge authority would
create a second lifecycle meaning and weaken ADR-0003, ADR-0004, and ADR-0009.

The guarded operation is therefore unavailable before activation and makes no provider merge
request. A pre-activation positive live proof would either fabricate evidence, activate authority
early, or weaken the required lifecycle state. None is acceptable.

## Decision

The lifecycle rollout is staged without changing ADR-0009's authority model:

1. Issue #50 installs the inert repository-owned guard, protected policy and status producer,
   hermetic guard tests, and corrected v2 live-probe harness. It proves the complete policy and
   harness behavior without a live provider mutation.
2. Issues #51 through #54 install the remaining inactive lifecycle, migration, manifest, and
   publication machinery through their accepted human-reviewed deliveries.
3. Issue #55 owns the single human-gated Contract-as-Code activation through `dev`. That signed
   activation moves the repository-policy-derived guard availability from `disabled` to
   `probe-only`. Issue #55 then owns the first post-activation exact-target positive probe and the
   complete live denial, race, ambiguity, redaction, and reconciliation matrix.
4. General guarded child-to-epic automation remains unavailable until protected Contract-as-Code
   derives `enabled` from the complete settled Issue #55 proof. A failed, unavailable, stale,
   wrong-producer, or ambiguous capability remains `probe-only` or returns `disabled`, selects
   human-only child integration, and never widens authority.

The activation remains one deliberate human-only merge into `dev`. The post-activation probe does
not authorize any agent merge, auto-merge, enqueue, push, update, administration, or bypass effect
on `dev`, `main`, `release/**`, feature branches, or a non-exact epic target. Provider auto-merge
remains prohibited.

### Three-state availability policy

Protected `dev` is the sole policy source and derives exactly one current guard-availability state
from these three mutually exclusive states:

- `disabled` — before the signed Contract-as-Code activation, the guard makes no provider merge
  request;
- `probe-only` — immediately after activation, effects are limited to Issue #55's frozen
  disposable-probe manifest and the exact issue, pull request, target, head, base, request, and
  operation identities committed by that manifest; every other child delivery remains denied; and
- `enabled` — only after protected Contract-as-Code consumes an expected-producer, exact-head live
  proof receipt and status bound to the signed activation commit, the frozen disposable-probe
  manifest, and the complete successfully settled matrix.

The proof receipt and status are validated inputs to the protected policy; they are not independent
authority and cannot select or widen a target. The guard recomputes availability from protected
policy and current exact evidence on every invocation. Missing, stale, failed, skipped,
wrong-producer, mismatched-activation, incomplete, or ambiguous proof leaves the state `probe-only`
or `disabled`. No caller parameter, issue prose, status name, repository variable, or unvalidated
receipt can promote availability. Promotion never authorizes `dev`, `main`, `release/**`, feature,
wrong-epic, or caller-selected effects.

### Corrected v2 live-probe topology

The v2 harness creates each disposable provider-assigned parent issue first and derives its
`epic/**` target from that actual parent number. It does not hard-code a fictional parent. The
stale-base concurrency probe uses a separate disposable parent and its own derived epic target so
parent authority and target naming remain consistent.

Every prohibited-target denial reads that prohibited target's actual tip immediately before the
attempt and proves the same tip remains afterward. An absent `main` ref is itself denial evidence:
`main` must not be created for a probe. Existing `dev`, disposable feature, disposable release, and
wrong-epic targets use their actual observed tips; an absent target is recorded as absent rather
than represented by another branch's tip.

The concurrency case races two distinct child-issue pull requests against the same exact accepted
target and observed base with distinct request identities. It proves the target/base serialization
key cannot be partitioned and only one provider submission is possible. The stale-base case
advances its separate disposable target after evidence, then proves the old evidence cannot reach
the provider.

### Post-activation live matrix

Issue #55 must retain redacted, exact-head evidence for:

- one fully eligible child-issue pull request merged into its exact accepted `epic/**` target;
- denial of actual `dev`, absent `main`, disposable `release/**`, feature, wrong-epic, and
  caller-selected targets without changing their observed state;
- changed source head or base, stale readiness or lifecycle, missing or wrong-producer checks,
  incomplete evidence, unresolved findings or conversations, replay, and malformed or unavailable
  provider data;
- two distinct child pull requests contending on one target/base serialization key, plus the
  separate stale-base race;
- provider rejection, rate limiting, timeout, and ambiguous or partially observed outcomes;
- zero retry after ambiguity until explicit human reconciliation; and
- exact successful read-back of the target tip, reported squash commit, sole observed-base parent,
  and observed-head tree, with credential and raw-provider-body redaction.

The accepted ADR-0009 provider request remains at most one `Merge a pull request` call carrying the
exact revalidated head SHA in the `sha` parameter and `merge_method: squash`. This record neither
redefines that request nor authorizes it before activation.

## Failure and recovery

Before the human activation merge, any missing prerequisite cancels activation with no provider
merge request. After activation, recovery moves forward under Issue #55: a settled denial may be
corrected only with fresh evidence and revalidation; an ambiguous claim remains blocked and is
never retried until explicit human reconciliation under ADR-0009.

If the live matrix cannot establish the accepted behavior, guard availability remains `probe-only`
or `disabled` and child integration is human-only. The lifecycle itself remains active; a failed
proof does not justify rewriting history, weakening the state model, recreating legacy
compatibility, promoting availability, or automating `dev`.

## Governance projections

`AGENTS.md`, the Agent Planning Baseline, quality-gate and activation documentation, issue
templates, and the pull-request template must state that the guard is inert before activation and
unavailable for general child delivery until the protected three-state policy consumes Issue #55's
complete exact proof. Contract tests must pin accepted ADR-0009's bytes, require this staged
allocation and evidence-bound promotion, and reject a pre-activation provider request, a bypass of
the post-Issue-#55 gate, invalid-evidence promotion, or a synthetic `main` branch.

Epic #49 and every semantically affected child must name ADR-0010, increment its planning-contract
version, return to `status: new`, and receive fresh readiness only after ADR-0010 is accepted on
`dev`. Existing Issue #50 work may be salvaged only when it fits its refreshed accepted scope and
passes refreshed verification and audit.

## Consequences

The final outcome remains the complete nine-state lifecycle and ADR-0009 guarded child-to-epic
delivery. Proof occurs against the actual active policy and lifecycle instead of a candidate
approximation. No account, bot, App, hosted broker, second credential, feature-branch automation,
or product behavior is added.

Issue #55 carries a larger integrated activation burden and must recover forward if a live probe
fails after the human merge. That cost is explicit and preferable to fabricated pre-activation
evidence or a weakened authority state.

ADR-0009's shared-identity limitation remains unchanged: GitHub cannot distinguish agent and human
actions performed with the same maintainer identity. This staging decision adds no provider-level
identity separation and does not widen agent authority.

## Verification obligations

Issue #50 must prove hermetically that the guard is effect-free before activation and that the v2
harness constructs correct provider-assigned targets, observes exact tips, keeps `main` absent, and
models the full live matrix. It must not perform the matrix's live mutations.

Issue #55 must execute the full post-activation matrix on disposable artifacts and bind every
claim to the active protected policy, canonical lifecycle, exact issue and readiness, current
source and target refs, current checks and evidence, request identity, durable claims, provider
result, and exact read-back. It retains only sanitized bounded evidence and closes disposable
artifacts after capture. Its expected-producer exact-head receipt and status must bind the signed
activation commit, frozen disposable-probe manifest, exact operations, and complete settled matrix
before protected Contract-as-Code may derive `enabled`.

## Reopen triggers

Reopen this decision if the canonical merge-authorizing lifecycle state can be truthfully produced
before activation without dual semantics; activation can no longer remain fail-closed; the v2
harness cannot derive disposable targets from provider-assigned parents; the live matrix requires
creating `main`; or Issue #55 cannot recover forward while guarded automation remains unavailable.

Changes to the credential model, exact-target authority, at-most-once effect, ambiguity recovery,
or sacred-`dev` boundary reopen ADR-0009 or require another later ADR; they are outside ADR-0010.

## References

| Source                          | Reference                                                             |
| ------------------------------- | --------------------------------------------------------------------- |
| Decision contract               | [Issue #118](https://github.com/oscharko-dev/Keiko-Native/issues/118) |
| Amended rollout                 | [ADR-0009](ADR-0009-agent-scoped-maintainer-credential-epic-merge.md) |
| Lifecycle authority             | [ADR-0004](ADR-0004-readiness-authority-and-workflow-lifecycle.md)    |
| Canonical lifecycle projection  | [Issue lifecycle](../qa/issue-lifecycle.md)                           |
| Human activation and live proof | [Repository activation checklist](../qa/repository-activation.md)     |
