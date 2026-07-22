# ADR-0008: Restricted broker authority for automated epic delivery

## Status

Accepted, 2026-07-22.

Supersedes ADR-0005 only where that record authorizes an agent to use an authenticated maintainer
account for child-to-epic merges and describes that shared identity as the automation audit model.
ADR-0005's Sonar event decision, historical PR #15 disposition, and all other consequences remain
accepted and unchanged.

## Context

Keiko Native needs two deliberately different delivery boundaries. Eligible child pull requests
should integrate autonomously into their exact accepted epic branch so an ordered epic can advance
without a human merge at every slice. Every epic and standalone pull request targeting protected
`dev` must stop for deliberate human review and manual merge by Niko or Oscharko.

ADR-0004 already assigns every automated child-to-epic merge to one trusted server-side
merge-authority broker. It requires target serialization, issue and pull-request revalidation,
stable double reads, a durable authorization snapshot, dual-ref conditional provider acceptance,
at-most-once submission, exact-parent read-back, and human reconciliation after ambiguous outcomes.
It also denies agents and ordinary workflows direct merge and provider auto-merge authority.

ADR-0005 was accepted later to address public Sonar branch limits and an unprovisioned automation
identity. Its Sonar decision is sound, but its delivery exception permits an authenticated agent to
use a maintainer account for eligible child merges. That exception conflicts with ADR-0004's single
effect owner and allows automation to possess or replay a human identity capable of affecting
`dev`. Provider attribution then cannot distinguish deliberate human action from automation.

Decision issue #96 evaluated three models against the same threat and operational workload:

- a dedicated repository-scoped GitHub App and server-side merge-authority broker;
- the ADR-0005 authenticated-maintainer-account path; and
- human-only child integration.

The hard thresholds were zero automated effect on `dev`, zero agent-readable merge credentials,
one automated effect owner, exact accepted epic target and exact source/base binding, complete
current evidence, deterministic serialization and replay denial, exact effect read-back, and no
mutation when authority or provider state is unknown. Autonomous eligible child delivery is also
an explicit operator requirement.

| Criterion                                 | Weight | Broker | Maintainer account | Human only |
| ----------------------------------------- | -----: | -----: | -----------------: | ---------: |
| Separation from human and `dev` authority |    30% |      5 |                  1 |          5 |
| Exact-target, exact-head, and race safety |    25% |      5 |                  2 |          4 |
| Audit attribution and replay resistance   |    15% |      5 |                  1 |          5 |
| Autonomous child-to-epic delivery         |    15% |      5 |                  4 |          1 |
| Operability and recovery                  |    10% |      3 |                  3 |          4 |
| Implementation and maintenance cost       |     5% |      2 |                  5 |          5 |
| **Weighted total**                        |   100% |   4.65 |               2.10 |       4.05 |
| **Hard thresholds**                       |        |   Pass |               Fail |       Fail |

The maintainer-account option fails identity separation and single-owner authority. Human-only
integration satisfies the security boundary but fails the required autonomous child path. The
broker is costlier to provision and operate, yet it is the only option that satisfies every hard
threshold.

## Decision

Adopt the dedicated GitHub App and trusted server-side merge-authority broker defined by ADR-0004
as the sole automated child-to-epic effect owner.

### Authority topology

An agent or ordinary repository workflow may submit one bounded merge request and observe a
sanitized receipt. Submission is not authorization. The caller cannot merge, update the target
ref, enable provider auto-merge, enqueue a merge group, select a broader target, hold the broker
credential, or impersonate Niko or Oscharko.

The broker authenticates as a dedicated non-human GitHub App installation restricted to
`oscharko-dev/Keiko-Native`. It uses short-lived installation tokens with `contents: write` only
for the conditional merge effect, plus `pull requests: read`, `issues: read`, `checks: read`,
`commit statuses: read`, `administration: read`, and `metadata: read` for its independent evidence,
protected-branch-policy, and exact-effect reads. It receives no other repository write permission.
Agents, ordinary workflows, logs, caches, artifacts, and pull-request content cannot read, receive,
mint, or replay that credential.

Repository rules grant that App no update, merge, auto-merge, merge-queue enqueue, force-push,
administration, or bypass effect on `dev`. No automated principal can affect `dev`. Every pull
request targeting `dev` stops at `Ready for Human Review`; only Niko or Oscharko may deliberately
initiate its manual merge after reviewing the exact current head and required evidence.

### Broker authorization and effect

For each request, the broker implements ADR-0004's complete protocol. While holding the issue and
exact-target serialization locks with current fencing generations, it independently loads policy
from protected `dev` and proves all of the following:

- the open issue has current accepted readiness and authorizes the exact accepted epic branch;
- the canonical linked pull request, source branch, head SHA, target branch, and target tip match;
- lifecycle is `status: ready for human review` and the pull request is open, non-draft, and
  mergeable;
- every applicable exact-composition and exact-head check comes from its expected producer and is
  successful for the observed head and base;
- acceptance, journey, audit, manual, platform, finding, review, and conversation obligations are
  complete with no blocking or unresolved item; and
- pagination, event cursors, request identity, lock generations, and replay state are complete and
  unambiguous.

The broker performs the stable double read, creates the durable merge-authorization snapshot,
re-reads both refs, submits one dual-ref conditional provider request at most once, and verifies the
exact merge commit, both parents, resulting target tip, pull request, and snapshot identity. A
caller assertion, status name, cached observation, green badge, provider auto-merge setting, or
maintainer credential cannot substitute for any broker-side proof.

### Failure and recovery

Missing, stale, changed, conflicting, malformed, replayed, truncated, unauthorized, rate-limited,
or unavailable authority fails closed. A changed source or base, lost fence, failed check,
unresolved finding, closed issue, wrong target, or `dev` target produces no effect.

The broker never retries or refreshes an already submitted snapshot. An ambiguous response,
partial effect, permission drift, App outage, missing provider semantic, or read-back mismatch
disables automated epic delivery and requires authorized human reconciliation against exact commit
parents and refs. Automation may resume only after the capability and denial probes pass again.

While the broker is unavailable or unproven, the safe fallback is human-only child integration
under the accepted issue and complete evidence. An agent never falls back to direct merge,
maintainer-credential automation, provider auto-merge, a merge queue with weaker semantics, or a
weakened gate.

### Activation evidence

Issue #50 must implement and prove the boundary before activation. Sanitized evidence must include:

- the dedicated App installation identity, exact repository scope, short-lived token path, and
  least-privileged permissions;
- repository rules that allow only the required epic effect and prove every prohibited `dev`
  effect is denied to the App and every automated principal;
- complete policy, pagination, locking, fencing, double-read, snapshot, replay, conditional
  mutation, exact-parent, and reconciliation contract tests;
- live positive exact accepted epic delivery and negative wrong-target, stale-ref, replay,
  concurrency, permission-drift, provider-failure, and `dev` denial probes against disposable
  governed fixtures; and
- rotation, revocation, uninstall, outage, incident, audit-retention, and human-recovery procedures.

Activation is a separate accepted human-controlled repository-administration change. Until all
evidence is current and the exact protected configuration is read back, automated epic merge stays
disabled.

## Consequences

Keiko Native keeps autonomous child-to-epic delivery without allowing an agent to borrow human
authority. A dedicated principal and request-to-snapshot-to-effect receipt make automation
attribution distinguishable from deliberate maintainer action.

The broker and repository rules add implementation, hosting, credential-rotation, liveness,
incident-response, and recovery cost. Broker outage deliberately reduces availability: child
integration becomes human-only rather than silently using a broader credential or weaker provider
feature.

ADR-0005 remains the authority for its Sonar event matrix and historical PR #15 disposition. Its
authenticated-maintainer-account automation path is historical context only and grants no current
execution authority. ADR-0004 and this record jointly govern automated epic delivery.

Epic #49 and child #50 changed semantically when this decision replaced their assumed delivery
identity and fallback. They must increment their planning-contract versions, return to
`status: new`, and receive fresh successful readiness records before implementation resumes.
