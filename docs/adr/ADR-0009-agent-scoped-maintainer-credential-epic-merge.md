# ADR-0009: Agent-scoped maintainer credential for epic delivery

## Status

Proposed, 2026-07-24. Decision issue #113 selected this outcome. The record becomes accepted only
when an authorized maintainer manually merges its pull request to `dev`.

Supersedes ADR-0008 in full. It amends ADR-0004 only in its automated epic-branch merge boundary
and related broker-specific verification obligations. It restores ADR-0005's authenticated
maintainer-credential model with the stronger guard, exact-target, exact-head, at-most-once,
read-back, redaction, and recovery requirements below. ADR-0005's Sonar event decision, historical
PR #15 disposition, and all other consequences remain accepted and unchanged.

## Context

Keiko Native needs two delivery boundaries. A fully eligible child-issue pull request should
integrate autonomously into its exact accepted `epic/**` branch so an ordered epic can advance
without a manual merge at every slice. Every epic and standalone pull request targeting protected
`dev` must stop for deliberate human review and manual merge by Niko or Oscharko.

ADR-0008 selected a dedicated GitHub App and hosted server-side merge-authority broker to separate
automation from human authority. That design made provider attribution distinguishable and could
deny the automation identity access to `dev`, but it also required a new repository identity,
installation, credential lifecycle, hosted privileged service, provisioning, and incident
operations. The repository owner has rejected that operational footprint for the current lifecycle
activation.

Decision issue #113 re-evaluated the same delivery journey under an explicit constraint: add no
GitHub account, bot, App, hosted broker, or second repository identity. It compared a guarded
existing maintainer credential, ADR-0008's dedicated broker, and human-only child integration.
The guarded credential wins under that changed risk acceptance because it retains autonomous
child-to-epic delivery without new infrastructure. The stronger identity-isolated design remains
available as the deferred, non-blocking Issue #114.

This changes the enforcement model, not the sacred-`dev` outcome. GitHub records both deliberate
human actions and agent operations performed with the same maintainer identity as the same actor.
GitHub therefore cannot distinguish an agent action from a human action, and no server-side
identity boundary prevents broader use if that credential or its controlling environment is
compromised. This residual attribution and privilege risk is accepted explicitly and must never be
described as provider-enforced identity separation.

## Evaluation correction and dissenting evidence

The frozen weights and option scores in issue #113 remain the decision inputs, but the displayed
weighted totals contain arithmetic errors. Recalculating each score as
`sum(weight × score) / 100` produces:

| Option                                     | Frozen weighted contributions             | Corrected total |
| ------------------------------------------ | ----------------------------------------- | --------------: |
| A — Guarded existing maintainer credential | `1.25 + 1.00 + 0.80 + 0.60 + 0.10 + 0.50` |        **4.25** |
| B — Dedicated App and broker               | `0.25 + 1.00 + 1.00 + 0.75 + 0.50 + 0.20` |        **3.70** |
| C — Human-only child integration           | `1.25 + 0.20 + 1.00 + 0.60 + 0.50 + 0.40` |        **3.95** |

Option A still wins, now by 0.30 over Option C, so the recommendation and outcome are unchanged.
The dissenting evidence remains material: Option A scores last on attribution and credential
isolation; Option B provides the strongest identity separation and race controls; and Option C
avoids automated credential use entirely. The operator's no-new-identity constraint and retained
autonomous child-delivery requirement still select Option A. This is a reproducible evidence
correction recorded in the ADR; it does not edit or reinterpret the accepted issue contract or its
readiness fingerprint.

## Decision

An agent may invoke one guarded operation using an existing authenticated maintainer credential to
merge a fully eligible child-issue pull request only into its exact accepted `epic/**` target. Epic
and standalone pull requests remain human-only deliveries to `dev`. The credential comes from the
operator's already authenticated environment. The agent must not inspect, print, copy, persist,
export, log, or include it in evidence. Provider auto-merge, merge-queue enrollment, direct ref
updates, force pushes, bypass, and target selection from caller input are not the delivery
mechanism.

The operation is unavailable for `dev`, `main`, `release/**`, feature branches, and every target
not named exactly by the accepted issue. An agent must never merge, enable auto-merge, enqueue,
push, or update `dev`, including through the existing authenticated maintainer credential. Every
pull request targeting `dev` stops at `Ready for Human Review`; only Niko or Oscharko may
deliberately initiate its manual merge after reviewing the exact current head and evidence.

### Guarded authorization

The repository-owned guard loads policy from protected `dev`; pull-request content and caller
parameters are untrusted data. Before any provider mutation it must prove:

- the repository is exactly `oscharko-dev/Keiko-Native`;
- the open source issue has current accepted readiness and names exactly one `epic/**` target;
- the canonical linked pull request belongs to that issue and has the same exact target;
- the pull request is open, non-draft, mergeable, and its issue is in
  `status: ready for human review`;
- its exact current head and exact current base match the evidence composition being evaluated;
- every applicable exact-head and exact-composition check comes from its expected producer and is
  successful;
- acceptance, journey, audit, platform, manual, finding, review, and conversation obligations are
  complete with no blocking or unresolved item; and
- complete pagination, stable reads, request identity, and prior-attempt state are current,
  consistent, and unambiguous.

The guard performs a stable double-read of every authorization input, then immediately re-reads the
exact current head and exact current base. Any missing, changed, stale, conflicting, malformed,
replayed, truncated, unauthorized, rate-limited, or unavailable value produces no provider merge
request. A status name, green badge, cached observation, caller assertion, or readiness label alone
cannot authorize the operation.

### At-most-once effect and read-back

The guard creates a sanitized immutable operation record and acquires a durable single-flight
compare-and-set claim keyed by at least the repository, pull request, exact accepted target, exact
current head, exact current base, readiness identity, and request identity. It persists the claim
before any provider submission. A claim already present for the same operation rejects concurrent
and replayed attempts; neither process-local memory nor an uncommitted observation satisfies this
boundary.

After the durable claim succeeds, the guard submits at most once through GitHub's
`Merge a pull request` endpoint with request field `sha` and `merge_method: merge`. GitHub defines
`sha` as the SHA the pull-request head must match to allow the merge and returns `409 Conflict` when
a supplied `sha` does not match. Explicit `merge_method: merge` is required so successful read-back
can require a merge commit whose ordered parents are the previously observed base and head. The
similarly named `expected_head_sha` belongs to the separate `Update a pull request branch` endpoint,
where a mismatch returns `422`; it is not the merge precondition and the guarded operation must not
call that endpoint. Strict current-branch protection remains required for the accepted epic target
so a base advance invalidates earlier checks rather than silently widening their composition.

A confirmed provider rejection remains unmerged. A successful response is accepted only after
read-back proves the pull request is merged, the target tip is the reported merge commit, and its
ordered parents are the previously observed base and head. The durable evidence records only
sanitized identifiers, exact refs, result classes, attempt count, merge commit and parents, and
timestamp. It never contains credentials, raw provider bodies, readiness comments, private
endpoints, or other unbounded input.

GitHub's ordinary pull-request merge interface does not provide the broker design's independent
dual-ref conditional boundary or separate effect owner. Strict checks and immediate read-back
reduce the race surface but do not create identity separation or a general atomic transaction.
That limitation is part of the accepted residual risk.

### Failure and recovery

An ambiguous or partially observed provider outcome causes no retry and no replacement attempt.
The ambiguous claim remains blocked until explicit human reconciliation using the exact source and
target refs, pull request, merge commit, and ordered parents. Only a later fresh operation with a
new request identity, a separately successful claim, and fully revalidated evidence may resume
after the prior outcome is settled.

Human reconciliation must compare the exact refs, merge commit, and ordered parents before any
later operation is considered.

Credential unavailability, guard failure, provider semantic drift, protection drift, or an
unproven exact-head precondition selects human-only child integration. Automation never responds by
using provider auto-merge, weakening a gate, broadening a target, or retrying an ambiguous effect.

## Governance projections

`AGENTS.md`, the Agent Planning Baseline, quality-gate and activation documentation, issue
templates, and the pull-request template must project this decision consistently. Contract tests
must fail if an active projection restores a broker/App requirement, omits the exact accepted
`epic/**` target or shared-identity limitation, permits provider auto-merge, omits the durable
single-flight claim or explicit `merge_method: merge`, permits an agent effect on `dev`, or allows
an ambiguous attempt to retry.

Issue #50 owns implementation and live proof of the repository-owned guard. This ADR authorizes no
workflow, repository-administration, credential, or merge mutation by itself. Activation remains a
separate human-controlled change and automated epic delivery remains disabled until #50's accepted
positive, denial, ambiguity, redaction, and recovery evidence is complete.

## Reuse Assessment: superseded PR #108

PR #108 targeted the superseded #50 broker contract and was closed without merge. It is evidence,
not an implementation base. The assessment below covers every changed file. `Adapt` means the
general invariant or test shape was independently restated under this ADR; no source was
cherry-picked. `Reject` means the change depends on the App/broker architecture or is outside
decision #113.

| PR #108 file                                           | Disposition | Rationale                                                                                                                              |
| ------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/qa/quality-gates.md`                             | Adapt       | Retain exact-target/head, closed-result, redaction, no-retry, and exact-parent recovery wording without a broker or separate identity. |
| `docs/qa/repository-activation.md`                     | Adapt       | Retain positive/denial/ambiguity/recovery probe shapes, rewritten for the guarded existing credential.                                 |
| `package.json`                                         | Reject      | Its coverage expansion registers broker and repository-control implementation excluded from #113.                                      |
| `quality/contract.mjs`                                 | Reject      | Its changes only register excluded App, capability, receipt, probe, and repository-control modules.                                    |
| `quality/contract.test.mjs`                            | Adapt       | Retain the cross-projection drift-test pattern; replace broker/App assertions with ADR-0009 invariants.                                |
| `quality/coverage-reporter.mjs`                        | Reject      | Its changes exist only to cover excluded implementation modules.                                                                       |
| `quality/epic-merge-broker-capability.mjs`             | Reject      | Broker capability and App permissions are superseded.                                                                                  |
| `quality/epic-merge-broker-capability.test.mjs`        | Reject      | Tests the superseded broker capability.                                                                                                |
| `quality/epic-merge-broker-effect.mjs`                 | Reject      | Implements the superseded broker-only effect.                                                                                          |
| `quality/epic-merge-broker-effect.test.mjs`            | Reject      | Tests the superseded broker-only effect.                                                                                               |
| `quality/epic-merge-broker-receipt-crypto.mjs`         | Reject      | Receipt cryptography and separate signing identity are excluded.                                                                       |
| `quality/epic-merge-broker-receipt.mjs`                | Reject      | Broker receipt authority is excluded.                                                                                                  |
| `quality/epic-merge-broker-receipt.test.mjs`           | Reject      | Tests excluded receipt and crypto authority.                                                                                           |
| `quality/epic-merge-broker.mjs`                        | Reject      | PR #108's modifications retain the superseded broker effect owner.                                                                     |
| `quality/repository-controls-broker.test-fixtures.mjs` | Reject      | Broker/App fixtures do not model the accepted shared identity.                                                                         |
| `quality/repository-controls-evidence.mjs`             | Reject      | Implements #50 repository-control evidence beyond this decision's governance scope.                                                    |
| `quality/repository-controls-evidence.test.mjs`        | Reject      | Tests the excluded repository-control evidence implementation.                                                                         |
| `quality/repository-controls-policy.json`              | Reject      | Provisions caller/App identities and ruleset coordinates expressly excluded by #113.                                                   |
| `quality/repository-controls-policy.mjs`               | Reject      | Implements the superseded identity and provisioning policy.                                                                            |
| `quality/repository-controls-probe-cli.test.mjs`       | Reject      | Tests a superseded live-control implementation.                                                                                        |
| `quality/repository-controls-probe-denials.mjs`        | Reject      | Its App-identity denials cannot be reused as shared-identity enforcement.                                                              |
| `quality/repository-controls-probe-failure.test.mjs`   | Reject      | Tests the excluded probe implementation.                                                                                               |
| `quality/repository-controls-probe-identities.mjs`     | Reject      | Separate caller and broker identities are explicitly excluded.                                                                         |
| `quality/repository-controls-probe-scenarios.mjs`      | Reject      | Scenario implementation belongs to replanned #50 and embeds broker coordinates.                                                        |
| `quality/repository-controls-probe.mjs`                | Reject      | Live repository-control implementation is prohibited in #113.                                                                          |
| `quality/repository-controls-probe.test-fixtures.mjs`  | Reject      | Fixtures embed the superseded identity and capability model.                                                                           |
| `quality/repository-controls-probe.test.mjs`           | Reject      | Tests the excluded probe implementation.                                                                                               |
| `quality/repository-controls-probes.mjs`               | Reject      | Implements the superseded live App/broker probe matrix.                                                                                |
| `quality/repository-controls-readback.mjs`             | Reject      | Implementation belongs to #50 and depends on excluded controls.                                                                        |
| `quality/repository-controls-scenarios.test.mjs`       | Reject      | Tests broker/App scenarios rather than ADR-0009.                                                                                       |
| `quality/repository-controls.mjs`                      | Reject      | Implements the superseded repository identity and controls topology.                                                                   |
| `quality/repository-controls.test-fixtures.mjs`        | Reject      | Fixtures encode the superseded topology.                                                                                               |
| `quality/repository-controls.test.mjs`                 | Reject      | Tests the excluded repository-control implementation.                                                                                  |

No PR #108 implementation file is adopted. Issue #50 must implement the ADR-0009 guard from its
fresh accepted contract and may reuse only the independently assessed invariant and test shapes
marked `Adapt`.

## Consequences

Keiko Native retains ordered autonomous child integration without adding a repository identity or
hosted privileged service. The operating model is smaller, and the existing credential remains in
the operator-controlled authenticated environment rather than being copied into repository
configuration.

The trade-off is material: provider attribution cannot separate agent and human actions, and a
maintainer credential is technically broader than the single operation allowed by agent policy.
The repository-owned guard, exact target and evidence checks, at-most-once submission, strict
branch protection, and read-back are policy and defense-in-depth controls; they are not a
least-privileged provider identity. A later requirement for provider-enforced separation reopens
Issue #114 rather than silently extending this model.

ADR-0004 remains accepted for lifecycle authority, evidence composition, stable-read principles,
semantic invalidation, migration, and human-only `dev` delivery. Its broker locks, fencing,
broker-owned snapshot, dual-ref conditional request, dedicated effect identity, and broker
capability/liveness requirements no longer govern child-to-epic merge implementation.

## Verification obligations

Issue #50 must add hermetic guard tests and disposable live probes that cover eligible exact-target
success; `dev`, `main`, `release/**`, feature, wrong-epic, and caller-selected-target denial;
changed head or base; stale readiness or lifecycle; missing, skipped, failed, or wrong-producer
checks; incomplete evidence; unresolved findings or conversations; durable claim persistence;
replay; concurrent attempts; provider rejection; rate limit; timeout; ambiguous or partial outcome;
redaction; and human reconciliation.

Tests must prove all pre-submission failures make no merge call, one accepted operation makes at
most one provider call, the claim is persisted before submission, ambiguous claims remain blocked
with no retry until explicit human reconciliation, and success requires exact target-tip and
ordered-parent read-back after an explicit `merge_method: merge` request. They must also prove the
guard never prints or persists credential material and never invokes provider auto-merge, direct
ref update, queue enrollment, bypass, or any `dev` effect.

## Reopen triggers

Reopen this decision if autonomous child integration is no longer required; the operator requires
provider-enforced identity separation; GitHub removes or materially changes the expected-head
merge precondition, strict required-check semantics, actor attribution, or read-back data; the
guard cannot deny every non-exact target before mutation; or live probes cannot establish the
accepted at-most-once and recovery behavior.

## References

| Source                              | Reference                                                             |
| ----------------------------------- | --------------------------------------------------------------------- |
| Decision contract                   | [Issue #113](https://github.com/oscharko-dev/Keiko-Native/issues/113) |
| Deferred identity-isolated design   | [Issue #114](https://github.com/oscharko-dev/Keiko-Native/issues/114) |
| Lifecycle and prior broker boundary | [ADR-0004](ADR-0004-readiness-authority-and-workflow-lifecycle.md)    |
| Restored delivery and Sonar model   | [ADR-0005](ADR-0005-free-tier-sonar-and-epic-delivery.md)             |
| Superseded broker decision          | [ADR-0008](ADR-0008-restricted-broker-epic-auto-merge.md)             |
| GitHub pull-request merge semantics | [Merge a pull request][github-merge-pr]                               |
| Distinct update-branch semantics    | [Update a pull request branch][github-update-pr-branch]               |

[github-merge-pr]: https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request
[github-update-pr-branch]: https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch
