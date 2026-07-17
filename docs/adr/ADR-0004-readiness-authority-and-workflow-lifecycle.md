# ADR-0004: Readiness authority and workflow lifecycle

## Status

Proposed, 2026-07-17.

## Context

Keiko Native currently uses `status: ready` for two different purposes. Adding the label asks the
trusted issue workflow to validate a planning contract, and retaining the label is also required by
the pull-request validator. Consequently, a valid accepted issue cannot truthfully become
`status: in progress`, `status: pr open`, or `status: ready for human review` without making its
delivery check fail. The same coupling makes ADR-0003's pre-activation migration inventory omit
accepted work as soon as its lifecycle label changes.

The target-owned evidence establishes the conflict:

- `quality/issue-readiness-action.mjs` currently describes an accepted record as valid only while
  `status: ready` remains and treats any other `status:*` label as conflicting;
- `quality/pr-contract.mjs` requires the accepted issue to be open with exactly `status: ready` even
  though the repository already defines the full lifecycle label set; and
- ADR-0003 restricts its migration manifest to open `status: ready` issues rather than asking which
  open issues have current accepted readiness authority.

A paginated live label inventory on 2026-07-17 found nine configured `status:*` labels. Eight appear
in the existing activation runbook; the ninth is `status: triaged` ("Reviewed and ready for ordered
delivery"). Decision issue #23 v2 resolves the documentation drift by making all nine equal,
first-class canonical states. Triaged has distinct pre-readiness semantics and is not an alias for
ready.

The live observation is reproducible with repository-scoped metadata reads:

```text
gh label list --repo oscharko-dev/Keiko-Native --limit 200
```

GitHub provides distinct issue events for edits, assignments, labels, closure, and reopening, and
distinct pull-request events for opening, head synchronization, draft/review changes, closure, and
reopening. Its issue API also exposes the closure reason separately from open/closed state. These
are adequate transition inputs, but provider events and labels remain untrusted observations until
the protected-`dev` workflow validates them.

### Evaluation

Scores use the frozen five-point scale and weights from decision issue #23. A numerical score cannot
override a hard threshold. An option is selectable only if it accepts zero stale or forged
readiness, enforces exactly one lifecycle label for every governed open or completed issue, provides
deterministic idempotent transitions, never resumes paused or terminal work automatically, produces
exact equality across all nine configured and declared states, produces exact migration-set
equality, introduces no secret or dependency, and never mutates or bypasses protected `dev`.

| Criterion                                           |   Weight | Option A | Option B | Option C |
| --------------------------------------------------- | -------: | -------: | -------: | -------: |
| Readiness integrity and stale-evidence resistance   |      30% |        3 |        3 |        5 |
| Lifecycle truthfulness and deterministic uniqueness |      25% |        1 |        1 |        5 |
| Migration completeness and single authority         |      20% |        1 |        2 |        5 |
| Fail-closed event ordering and recovery             |      15% |        2 |        2 |        4 |
| Maintainability and operational burden              |      10% |        5 |        3 |        4 |
| **Weighted total**                                  | **100%** | **2.15** | **2.35** | **4.75** |
| **Hard thresholds**                                 |          | **Fail** | **Fail** | **Pass** |

Option A retains the current readiness checks, but fails lifecycle truthfulness and migration
completeness: progress must be hidden outside the supported labels, and migration loses accepted
work after any truthful state change. Option B preserves a visible `status: ready` authority marker
beside a second status label, but fails the exactly-one-label threshold and gives consumers an
ambiguous pair. Both failures are directly reproducible with the existing readiness and PR-contract
tests.

Option C separates a verifiable accepted-readiness identity from one reason-aware lifecycle label.
The separation follows the repository's owning-layer and evidence-binding standards, while GitHub's
documented issue and pull-request activities supply observable transition triggers. Its remaining
cost is a larger validator, workflow, test, documentation, and migration delta. It passes only with
the fail-closed rules below; lifecycle state can never substitute for readiness evidence.

The same evidence workload was applied to every option:

| Criterion                   | Attributable evidence and result                                                                                                                                                                                                                                                                                                | Limitation retained in the score                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Readiness integrity         | The current readiness parser already rejects non-Actions markers and compares version plus fingerprint; ADR-0003 defines the post-activation exact repository identity. A and B continue to use the ready label as an additional authority signal; C removes that signal and retains both evidence checks.                      | Provider availability is never assumed; every option must fail closed.                                                                |
| Lifecycle truthfulness      | The existing negative tests in `quality/issue-readiness-action.test.mjs` and `quality/pr-contract.test.mjs` reproduce rejection when another status accompanies or replaces ready. A cannot show progress and B necessarily has two labels. C's state table preserves one observable label.                                     | GitHub label replacement is not atomic, so C scores four rather than five on ordering/recovery and requires read-back reconciliation. |
| Migration completeness      | ADR-0003 currently selects open ready-labeled issues. Synthetic set analysis across ready, in-progress, PR-open, review, blocked, and waiting states omits five classes under A and makes label precedence ambiguous under B. C selects first by matching accepted-readiness identity and binds the sole lifecycle observation. | The terminal manifest freezes its inventory; an intended later transition requires the existing superseding-manifest procedure.       |
| Event ordering and recovery | GitHub documents the issue and PR activities used below, while its REST API exposes open/closed state and closure reason. Only C can recompute readiness and lifecycle separately after reordered or replayed events.                                                                                                           | Provider label writes remain multi-step and API failure can require an authorized retry.                                              |
| Operational burden          | A changes nothing and B makes a small validator change. C requires one owning module, workflows, the canonical QA contract, templates, tests, migration logic, and live probes.                                                                                                                                                 | This is the deliberate cost of removing dual meaning without adding a dependency or secret.                                           |

## Decision

Adopt Option C. Readiness authority and workflow lifecycle are independent inputs to every
authorization decision.

### Readiness authority

`current readiness` is a predicate over trusted evidence, never over a lifecycle label:

- Before Contract-as-Code activation, the latest trusted machine readiness record must have status
  accepted and name the issue's exact current planning-contract version and normalized title/body
  fingerprint. An older accepted record cannot survive a later rejection. The workflow verifies
  the GitHub Actions producer and exact comment identity. Type, delivery target, and other frozen
  contract fields must still validate.
- After activation, the issue must point to the sole authoritative terminal repository contract.
  Its exact path, SHA-256, type, issue number, version, and revision must satisfy ADR-0003. So must
  its publication receipt, signed commit, protected-`dev` ancestry, current-tree bytes, and
  supersession chain. Issue prose and comments cannot replace that authority.
- A missing, forged, stale, superseded, mismatched, replayed, malformed, unreachable, or unavailable
  authority result is not current. Unknown or partially loaded evidence fails closed.
- Closing or reopening an issue makes its earlier readiness non-executable. Reopening always starts
  at `status: new` and requires a fresh successful readiness decision; it never revives a previous
  record, repository pointer, claim, PR result, or audit.

`status: ready` is therefore a lifecycle state and the request gesture that starts readiness
validation. Once validation succeeds, removing it during an authorized transition does not revoke
the matching evidence. Conversely, adding any lifecycle label cannot create readiness.

### Canonical status taxonomy and drift control

The canonical lifecycle set is exactly:

`status: new`, `status: triaged`, `status: ready`, `status: in progress`, `status: pr open`,
`status: ready for human review`, `status: blocked`, `status: waiting for user`, and `status: done`.

New means planning intake has not yet been reviewed. Triaged means an authorized planning actor has
reviewed the item, confirmed its type and classification, and placed it in delivery order. That
transition produces sanitized operational evidence, but neither the label nor its evidence accepts
the planning contract. Triaged work is non-executable and has no current readiness. Ready is the
later state reached only when the exact planning contract independently passes readiness.

The configured GitHub `status:*` label names must exactly equal this nine-state canonical set. The
canonical `docs/qa/issue-lifecycle.md` list, this ADR's table, the lifecycle module enum, allowed
transition graph, workflow event coverage, repository activation/runbook inventory, and exhaustive
fixtures must also have exact set equality. A repository contract test fails on any added, removed,
or renamed status until documentation, state table, workflows, and fixtures are updated together
through a new accepted decision when semantics change. Live activation and drift probes fail on
provider-label disagreement; they never mutate labels without explicit authority.

Every trusted lifecycle, normal-PR, publication, and merge-group metadata run reloads the complete
provider label-name set and rejects a mismatch. The activation merge-group run must observe exact
equality immediately before the authority switch. API unavailability is a failed check, not
permission to reuse a prior inventory. This prevents repository-administration drift from
bypassing the static contract between periodic or manual observations.

The canonical statuses belong to issues, not pull requests. A pull request uses GitHub's native
draft/open/closed/merged state and exact-head checks; attaching any `status:*` label to it is drift
and grants no issue lifecycle state. The pre-activation rollout performs a complete paginated
association inventory before the terminal migration manifest is frozen. Under expressly revalidated
issue #21 authority, it then reconciles existing items deterministically:

- every open issue must satisfy one canonical table state and its readiness/topology preconditions;
- a closed completed issue with verified final delivery evidence receives only `status: done`;
- every closed non-completed issue has all lifecycle labels removed;
- every pull request has all lifecycle labels removed; and
- any conflicting, unknown, or unverifiable association stops automated migration for that item and
  requires an authorized explicit disposition.

The workflow reads back each mutation and repeats the complete inventory before publication. This
one-time reconciliation uses the same partial-failure and fail-closed rules as ordinary transitions;
it does not infer completion, readiness, or a canonical state from an old label alone.

### Lifecycle invariant and state table

Every governed open issue has exactly one label from the state table. A valid completed closed issue
has exactly `status: done`. Closed `not_planned`, `duplicate`, or otherwise non-completed issues are
outside the execution lifecycle, have no `status:*` label, and carry no completion claim. A request
may briefly create new plus triaged or triaged plus ready. That overlap is a controlled input, not
an accepted state. All consumers fail closed until the workflow reconciles it to one label.

| State                            | Meaning and readiness requirement                                                                                                                                                                                              | Permitted entry actor and event                                                                                                                                                                                          | PR eligibility                                                                                                                              | Exit, pause, closure, and recovery                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status: new`                    | Planning intake is unreviewed, changed, reopened, or invalidated. Current readiness must be absent.                                                                                                                            | Template creation; trusted invalidation after a title, body, type, authority, or other semantic contract change; trusted `issues.reopened`.                                                                              | None. Existing linked PR contexts are invalidated.                                                                                          | An authorized planning actor requests triage. Successful review, classification, and ordering enters triaged; rejection remains new. It may enter blocked or waiting without readiness when planning cannot proceed.                                                                                                                                                                                                                                             |
| `status: triaged`                | Planning is reviewed, correctly typed and classified, and placed in delivery order, but the exact contract is not accepted. Current readiness must be absent; the state is non-executable.                                     | Trusted lifecycle workflow after an authorized `issues.labeled` request from new validates the planning actor, issue type, classification, and repository-owned ordering evidence.                                       | None. A PR cannot be created or pass.                                                                                                       | An authorized planning actor requests ready. Successful contract validation enters ready; rejection remains triaged unless a semantic edit requires new. Pause enters blocked or waiting. Semantic edit enters new.                                                                                                                                                                                                                                              |
| `status: ready`                  | The exact contract has current readiness and is unclaimed.                                                                                                                                                                     | Trusted readiness workflow after an authorized `issues.labeled` request from triaged.                                                                                                                                    | A PR cannot pass.                                                                                                                           | A valid claim enters in progress. An authorized pause enters blocked or waiting while retaining evidence. Semantic edit enters new.                                                                                                                                                                                                                                                                                                                              |
| `status: in progress`            | An authorized implementer has claimed current-ready work and no delivery PR is presently active.                                                                                                                               | Trusted lifecycle workflow after an authorized claim or after an unmerged PR closes when work remains claimed.                                                                                                           | Creation of the contract-authorized PR is permitted; no open PR may pass while the issue remains in this state.                             | A valid linked `pull_request_target.opened` or `reopened` enters PR open. A released claim with no PR returns ready. Pause enters blocked or waiting. Semantic edit enters new.                                                                                                                                                                                                                                                                                  |
| `status: pr open`                | At least one contract-authorized delivery PR is open; sequential multi-PR delivery is allowed only when the accepted contract says so. Current readiness is required.                                                          | Trusted PR workflow after validating the linked PR, exact target, accepted source rules, issue citation, actor, and current head. A new commit or loss of review evidence also returns ready-for-human-review work here. | Linked PRs may run contract and technical checks. Unlinked, wrong-target, stale, or additional unauthorized PRs fail.                       | The protected handoff coordinator alone may enter human review after its two-phase exact-head handshake. After a trusted unmerged close, another valid open PR retains this state; otherwise current readiness plus a retained valid claim enters in progress, while current readiness plus no valid claim enters ready. Unknown claim evidence fails closed. Intermediate merge enters in progress. Pause invalidates PR eligibility; semantic edit enters new. |
| `status: ready for human review` | The open linked PR's exact current head has every required verification, audit, conversation, journey, platform, and evidence obligation complete. Current readiness is required. This is the automation stop state for `dev`. | Protected-`dev` handoff coordinator only, after label mutation, read-back, and a fresh exact-head re-evaluation. A label request, review submission, or green badge alone cannot enter it.                               | The exact linked head is technically eligible for the delivery boundary. Only an allowlisted human may deliberately initiate a `dev` merge. | Synchronization, draft conversion, review dismissal, reopened conversation/finding, missing evidence, changed head, or failed read-back/re-evaluation returns PR open and requires fresh evidence. Pause enters blocked or waiting. A verified intermediate merge returns in progress; only verified final completion plus completed closure enters done.                                                                                                        |
| `status: blocked`                | Progress is paused by a dependency, decision, or failing external condition. Matching readiness may be retained or absent, but grants no authority to continue.                                                                | Authorized implementer or maintainer request, or trusted automation after a validated blocking condition. Unauthorized/conflicting transition attempts fail safe here when current readiness still matches.              | None. Every linked open PR's contract status is invalidated.                                                                                | Resume is explicit. Without readiness, unchanged suspended triaged returns triaged and every other source returns new; otherwise topology permits ready, in progress, or PR open. It never restores human review. Semantic edit enters new.                                                                                                                                                                                                                      |
| `status: waiting for user`       | Progress is paused for an explicit human product, policy, risk, scope, or approval input. Matching readiness may be retained or absent, but grants no authority to continue.                                                   | Authorized implementer or maintainer request identifying the required input. A comment alone cannot resume work.                                                                                                         | None. Every linked open PR's contract status is invalidated.                                                                                | An authorized human explicitly resumes after settlement. Without readiness, unchanged suspended triaged returns triaged and every other source returns new; otherwise topology permits ready, in progress, or PR open. It never restores human review. Semantic edit enters new.                                                                                                                                                                                 |
| `status: done`                   | Final accepted delivery is complete and the issue is closed with reason `completed`. Earlier readiness is historical and non-executable.                                                                                       | Trusted reconciliation after a completed closure and exact completion evidence. The final linked PR was merged at its verified head through the accepted delivery boundary; a `dev` target remains human-only.           | None. No open delivery PR may remain.                                                                                                       | No open-state transition is permitted. Reopen removes done and every other status, applies new, and requires fresh readiness.                                                                                                                                                                                                                                                                                                                                    |

The PR-eligibility column governs implementation and normal-delivery PRs. ADR-0003's canonical
contract-publication PR is an inert authority-publication lane, not a linked delivery PR. It may
pass only the publication replacement checks. Ordinary initial publication may leave affected issues
`status: new` and unready. Terminal-manifest migration publication instead preserves every matching
pre-activation readiness record and its observed sole lifecycle among ready, in progress, PR open,
ready for human review, blocked, or waiting for user. Neither submode creates execution authority,
changes lifecycle, or turns its publication PR into normal delivery.

An issue with current readiness is executable only in `status: ready`, `status: in progress`,
`status: pr open`, or `status: ready for human review`, and only for the actions allowed by that
specific state. Blocked and waiting issues retain provenance, not permission. `status: done` is a
completion projection, not planning authority.

The complete allowed-edge graph is:

- creation or reopen enters new;
- new may enter triaged, blocked, or waiting;
- triaged may enter ready, blocked, waiting, or new;
- ready may enter in progress, blocked, waiting, or new;
- in progress may enter ready, PR open, blocked, waiting, or new;
- PR open may enter ready, in progress, ready for human review, blocked, waiting, or new. The direct
  ready edge requires a trusted unmerged PR close, current readiness, no other valid linked open PR,
  and no retained valid claim; the same event enters in progress when a valid claim remains;
- ready for human review may enter PR open, in progress, blocked, waiting, new, or done;
- blocked and waiting may change between one another or enter new, triaged, ready, in progress, or
  PR open after explicit resume and topology validation, but never ready for human review;
- done may enter only new, and only through reopen; and
- any open state may leave the graph through a non-completed closure, which removes all lifecycle
  labels and can return only to new through reopen.

A semantic edit from any open state overrides its ordinary edge and enters new. A valid final merge
cannot enter done directly from PR open because ready-for-human-review exact-head evidence is a
precondition. Every edge not listed above is invalid and fails closed. The canonical QA contract
must restate this graph mechanically, and tests must cover every allowed edge plus the complement
of rejected source/target pairs.

### Transition ownership and preconditions

One protected-`dev` lifecycle module owns readiness evaluation, lifecycle validation, label
reconciliation, linked-PR invalidation, and sanitized transition evidence. Workflows load that
module from protected `dev`; pull-request content is data and is never executed.

Issue #21 must publish the complete operational contract at `docs/qa/issue-lifecycle.md` and make
`AGENTS.md` and every affected issue template link to it. That repository-owned document is the
canonical human and automation reference for state meanings, transition requests, actors,
preconditions, recovery, and evidence. Trusted workflows and hermetic tests enforce the same
contract. Agent skills, prompts, external orchestration, project-board views, and comments are
consumers only: they cannot create, override, or silently reinterpret lifecycle policy.

Keiko Native must not read, clone, import, query, check, wait for, or make acceptance contingent on
the external Agent-Workflow-Setup repository, its skills, or its compatibility issue. Compatibility
work is independently owned outside Keiko Native and cannot block this ADR or issue #21. External
artifacts may at most be cited as non-authoritative evidence when a future accepted contract needs
it; they are never a runtime, test, workflow, planning, or delivery dependency.

An authorized triage request is validated from new only. The trusted transition evidence binds the
issue, source and target state, actor, issue type, selected change classification, explicit delivery
ordering attestation, policy version, and event identity. It contains no raw body and creates no
readiness. A project-board position may display the result but cannot supply the ordering authority.
Entering blocked or waiting similarly records the valid suspended source state. Resume revalidates
that evidence and current facts; missing, stale, or contradictory pause evidence falls back to new
instead of guessing whether pre-readiness work was triaged.

The issue workflow consumes the relevant `issues` activities, including edited, assigned,
unassigned, labeled, unlabeled, closed, and reopened. Assignment is a claim only when its actor,
assignee, and current Execution Authority validate; unassignment is a release only when no accepted
PR remains. No label gesture can claim work: validated assignment or the repository-owned claim
mechanism alone owns entry to in progress. The PR workflow consumes the relevant
`pull_request_target` activities, including opened, reopened, synchronize, converted-to-draft,
ready-for-review, and closed. Validated normal-delivery PR topology alone owns entry to PR open; a
canonical publication PR never changes lifecycle. The protected handoff coordinator alone owns
entry to ready for human review. It verifies the repository, issue
identity, event action and delivery identity, sender, current actor permission, accepted planning or
execution authority, issue state, exact lifecycle set, readiness identity, linked PR, target, source
rule, draft state, exact head, and completion or closure reason where applicable.

Label changes are requests, never authority. The complete permitted source/requested-target label
pair set is:

- new to triaged, requested by an authorized planning actor;
- triaged to ready, requested by an authorized planning actor;
- new, triaged, ready, in progress, PR open, ready for human review, or waiting for user to blocked,
  requested by an authorized implementer or maintainer with a specific validated blocking
  condition; and
- new, triaged, ready, in progress, PR open, ready for human review, or blocked to waiting for user,
  requested by an authorized implementer or maintainer identifying the missing human input.

Each request authenticates the sender and validates the exact source, requested target, current
issue identity, policy version, authority, lifecycle uniqueness, and readiness/topology conditions.
The complement of source/target pairs is rejected, including every direct gesture for new, in
progress, PR open, ready for human review, or done. Workflow-authored reconciliation mutations carry
trusted transition identity and are effects, not label requests. Direct removal of a lifecycle
label is not a transition request and is rejected unless it is that authenticated reconciliation
effect.

Resume is not a target-label gesture. Blocked resume requires an authorized implementer or
maintainer request plus validated resolution of the blocking condition. Waiting entry requires the
authorized implementer or maintainer request above; waiting resume requires a separate explicit
authorized-human settlement of the recorded missing input. The trusted workflow then derives the
permitted destination from current readiness, suspended state, claim, and PR topology. Arbitrary
comments do not resume either pause state. Any missing, unauthorized, stale, reordered, replayed,
contradictory, or unavailable precondition rejects the request.

### Exact-head lifecycle handoff

A least-privileged protected-`dev` coordinator owns the exact-head `Lifecycle handoff` context. For
normal delivery only, it also owns the PR-open to ready-for-human-review edge. It loads code only
from protected `dev`, reads PR content as untrusted data, and never checks out or executes the PR
head. It receives only the issue and pull-request read, review/conversation read,
Actions/check/status read, `contents: read`, issue-label write, and commit-status write permissions
required for this responsibility. Protected-`dev` checkout uses `persist-credentials: false`; the
coordinator receives no contents write and cannot load PR code.

`Lifecycle handoff` is a required exact-head context on every governed delivery target. Branch
rules require its expected trusted producer; another App or same-name status cannot satisfy it.

Before evaluating, the coordinator derives exactly one lane from complete trusted provider diff and
metadata rather than a PR-authored flag:

- **Normal delivery** must exactly match one accepted issue's linked PR, Execution Authority,
  delivery target, and permitted implementation scope, without publication-only or mixed scope. It
  is classified without consulting the mutable lifecycle label; lifecycle is an eligibility input
  to the protocol below, not part of lane identity.
- **Canonical contract publication** requires ADR-0003's protected publication replacement
  validation: the accepted `dev` target, complete add-only canonical contract paths, exactly one
  signed snapshot receipt, exact path/mode/bytes/digest and trailer equality, and every other
  ADR-0003 publication invariant. Receipt and manifest evidence derives exactly one publication
  submode without using mutable labels. Ordinary initial publication identity binds its affected
  issue set and predecessor/supersession references. Terminal-manifest migration identity binds the
  exact terminal manifest, complete recorded issue set, and every receipt/snapshot
  reference. Current issue readiness, lifecycle, and linked-PR observations are submode eligibility
  inputs, not publication lane identity. Its fresh `Issue contract current` result uses ADR-0003's
  non-circular publication meaning and makes no new readiness claim.

Unknown, ambiguous, truncated, mixed-scope, or contradictory classification fails handoff. A PR
body, label, actor request, path-like decoy, or same-named context cannot select publication mode or
exempt an ordinary delivery PR. The immutable lane identity binds repository, PR, head, trusted
diff, target/scope, and the accepted Execution Authority or publication receipt/manifest identity;
it excludes mutable lifecycle eligibility. Every handoff result binds that lane identity.

The coordinator re-evaluates on every relevant completion or invalidation signal:

- issue, readiness, claim, and lifecycle events, including edit, label, assignment, close, and
  reopen;
- PR and head events, including open, reopen, synchronize, draft/readiness change, close, and target
  or metadata edit;
- protected repository workflow, check-suite/check-run, and commit-status completion or change;
- review submission, change, dismissal, and review-request change;
- review-thread resolution/reopening and other conversation changes;
- trusted external-provider, manual, and authoritative-platform evidence settlement or withdrawal;
  and
- a protected scheduled reconciliation plus an authorized manual recovery dispatch, which recover
  dropped, unsupported, or reordered provider events without treating time as evidence.

Every signal is a wake-up only. The coordinator reloads all provider state and authenticates every
evidence producer. A review, comment, platform receipt, check name, or event payload cannot satisfy
an obligation by itself.

Under the lifecycle lock, the coordinator coalesces wake-ups into an input generation for an exact
repository, PR, head, and immutable lane identity. Its canonical input digest covers issue updated
identity and repository-owned observation revision, readiness record, lifecycle, target, reviews and
conversations, audit, journey, manual, external and platform evidence, every independent upstream
input identity, and the expected protected workflow/producer versions. A provider event cursor is
included only when a live probe proves its ordering semantics; otherwise complete stable reads
supply the observation revision. The digest excludes coordinator-started prerequisite results so
their completion cannot recursively change it. A generation identity combines that digest with a
repository-owned attempt sequence, allowing explicit recovery without pretending unchanged inputs
changed.

Generation identity uses domain-separated SHA-256. Replacing SHA-256 with another algorithm requires
a new accepted decision rather than runtime negotiation. The hashed message is the exact canonical
UTF-8 byte sequence defined by the repository-owned versioned generation schema. It starts with the
domain `keiko-native.lifecycle-input-generation`, schema version `1`, and algorithm identifier
`sha-256`, then binds repository identity, PR identity, exact head, immutable lane, publication
submode or explicit not-applicable value, attempt sequence, and every input named above.

Version 1 encodes each node as UTF-8 `tag#length:payload`, with no whitespace: `tag` is one fixed
ASCII type from `record`, `field`, `string`, `enum`, `uint`, `bool`, `null`, `list`, `set`, or `map`;
`length` is the payload's decimal byte count without a sign or leading zero, except zero is `0`; and
`payload` is the
canonical scalar or concatenated child-node bytes. A record uses fixed schema field order. Each
`field` payload contains one canonical field-name `string` node followed by exactly one typed value
node. This byte-counted grammar, rather than a delimiter alone, supplies every field boundary. The
implementation never hashes lossy JSON, display text, implicit defaults, or raw string
concatenation.

Strings use Unicode NFC and LF line endings; enums use exact canonical ASCII; integers use unsigned
base-10 without a sign or leading zeros; booleans use `true` or `false`; and commit/digest values use
validated lowercase hexadecimal strings. Map keys and set elements sort by their complete canonical
encoded bytes. Lists preserve order only where the schema declares order semantic; every other
collection is a set. Duplicate fields, duplicate raw or normalized keys/elements, unknown fields or
type tags, missing required fields, disallowed nulls, malformed UTF-8, invalid normal forms,
overflow, inconsistent lengths, and trailing bytes reject the generation. A schema-permitted
absence is an explicit `null` node, never an omitted field.

Every coordinator-started producer recomputes the canonical bytes and digest before publishing.
Every coordinator consumer, merge-group evaluator, and epic merge broker independently recomputes
them from its complete trusted inputs before using a generation. Digest comparison decodes and
validates the fixed-length value, then uses a constant-time byte comparison. A byte, digest, domain,
schema-version, algorithm, lane/submode, or input mismatch; an unknown version; or any malformed
encoding fails closed. No component trusts a caller-supplied digest without this recomputation.

The coordinator starts each required `Issue contract current`, `PR contract`, or `Contract
publication` run at most once for a generation. Every result carries the generation, expected
producer, workflow run, and result identity. Completion events attach to and wake that generation;
they never start replacement runs. An unchanged pending or successful generation is a no-op. A
failed or abandoned generation remains terminal until an authorized explicit recovery creates a new
attempt, or a validated input change creates a new digest and generation. Self-authored handoff and
prerequisite events are routed to their existing generation rather than discarded; an authenticated
upstream change still changes the digest and cannot be suppressed as self-noise.

The workflow dispatch/input and authenticated check output both carry the generation identifier. A
completion event is only a wake-up; the coordinator reloads the run and result before attaching it.
Missing or contradictory generation binding, unavailable stable reads, or provider metadata whose
identity or ordering cannot be proven fails closed. The coordinator never infers a binding from a
check name, event timing, or details URL alone.

After normal lane classification, lifecycle determines only protocol eligibility. PR open may begin
the handshake below. Ready for human review with the same current input digest, successful
generation, and exact-head handoff is a stable no-op. A changed head, review, conversation,
evidence, readiness, target, or failed/abandoned generation first publishes failure or pending. It
reconciles to PR open and starts a fresh handshake. Every other lifecycle state is ineligible and
fails handoff without changing lane identity.

Normal-delivery handoff is one serialized two-phase handshake for an exact issue, PR, and head:

1. While lifecycle remains PR open, acquire the same per-issue lifecycle lock used by every label
   transition. Reload current readiness, lifecycle, linked PR, target, draft state, exact head,
   required contexts and expected producers, audit and journey evidence, authoritative-platform
   evidence, reviews, and unresolved conversations. Evaluate every upstream obligation except the
   coordinator's own `Lifecycle handoff` context; excluding only that context avoids a circular
   prerequisite.
2. If phase one passes, replace PR open with ready for human review, read the issue back, and reload
   all phase-one facts. Require the same exact head. Compute and persist the final input generation
   over the new ready-for-human-review lifecycle. For that generation, start protected-`dev` runs for
   both `Issue contract current` and `PR contract` exactly once. Wait for completion, authenticate
   each expected producer, and require success on that exact head and generation. Bind each producer
   and its fresh run and result identity to the decision. Only after lifecycle read-back, those two
   fresh successes, and the checks below may the coordinator publish `Lifecycle handoff` success on
   that exact SHA, bound to the generation, ready for human review, and all evaluated evidence
   identities.

The repository contract classifies upstream evidence by input. Lifecycle-sensitive evidence always
reruns after phase-two mutation; it includes `Issue contract current`, `PR contract`, and any future
check that reads readiness or lifecycle. Exact-head content/build/test/security checks and signed
audit, journey, manual, external, or platform receipts may remain only when their declared inputs
exclude readiness and lifecycle and their head, producer, run/result, and evidence identities are
unchanged across both reads. Undeclared or ambiguous evidence is lifecycle-sensitive. The
coordinator re-authenticates and re-reads every retained result; a name or prior green conclusion is
not reusable evidence.

The coordinator routes its own producer/context status event to the matching generation. An
unchanged `Lifecycle handoff` event is a no-op, so publication cannot trigger a self-invalidating
loop. Any authenticated head, readiness, lifecycle, review, conversation, independent upstream
check, audit, journey, external, manual, or platform evidence change creates a new input digest. It
first publishes failure or pending for the affected exact head and reconciles normal delivery to PR
open when PR topology and readiness remain valid, then requires the complete handshake again.

Label mutation failure, read-back disagreement, lock loss, API unavailability, or either evaluation
failure, including failure to execute or publish either fresh lifecycle-sensitive contract result,
must not publish success. The coordinator publishes handoff failure or pending and reconciles to PR
open under the same lock; if that write or read-back also fails, the missing/failing handoff context
keeps the head noneligible until scheduled or manual recovery converges. A prior success, label,
review, or green upstream context cannot substitute for the fresh second-phase results.

Canonical publication handoff never adds, removes, or requests any lifecycle label, including
ready, PR open, or ready for human review, and never interprets a label as readiness. After lane
classification, ordinary initial publication requires every affected issue to be `status: new` with
no accepted readiness. Terminal-manifest migration publication instead requires exact manifest set
equality and revalidates every recorded issue's matching accepted readiness record and fingerprint,
observed sole lifecycle among ready, in progress, PR open, ready for human review, blocked, or
waiting for user, and linked PR/head where that lifecycle requires one. It does not require those
issues to be new or unready.

The coordinator computes the publication generation and starts protected-`dev`
`Contract publication`, `Issue contract current`, and `PR contract` exactly once for it. It
authenticates their expected producer/run/result and generation identities. All three must apply
ADR-0003's publication result matrix and succeed on the exact receipt, canonical contract path, blob
bytes, digest, target, signed snapshot, and applicable ordinary or migration submode evidence. Only
then may `Lifecycle handoff` succeed on that head, bound to publication lane, submode, generation,
and those exact identities. A stale receipt, manifest, readiness record, lifecycle observation,
linked PR/head, blob or digest; a wrong target or ordinary delivery scope; or an `Issue contract
current` interpretation that depends on new readiness fails the handoff.

The publication success establishes technical eligibility for an allowlisted human's protected-`dev`
merge only. It does not accept the issue contract, fabricate readiness, or authorize implementation.
Migration publication preserves recorded readiness and lifecycle as evidence but emits no new
readiness and mutates no label. Ordinary publication likewise makes no readiness claim.
After the exact protected-`dev` publication merge, ADR-0003's merge, receipt, parent/tree, and
repository-contract verifier runs before readiness may be requested or normal executable lifecycle
may begin for any affected issue. No pre-merge publication result can satisfy that post-merge
ordering.

### Merge-group human-review handoff

Protected `dev` requires `Lifecycle handoff` from its trusted producer on every
`merge_group: checks_requested` SHA. A protected-`dev` read-only policy evaluator with metadata read,
`contents: read`, and check/status write only loads the fixed module with
`persist-credentials: false`. It cannot mutate labels, queue entries, branches, or pull requests and
never checks out or executes constituent code.

For the exact group SHA, the evaluator obtains complete paginated provider data for the ordered
group membership, each constituent PR and head, the target and base tip, and the group tree. It
independently classifies every constituent into exactly one trusted lane. Normal delivery requires
current accepted readiness, the sole ready-for-human-review lifecycle, canonical linked PR and
accepted `dev` target, complete evidence, and fresh same-generation constituent-head `Lifecycle
handoff`, `Issue contract current`, and `PR contract` results from their expected producers.
Canonical publication instead requires the ADR-0003 replacement matrix and exactly one evidence
submode. Ordinary publication binds its issue set and exact signed receipt/contract
path/bytes/digest/snapshot and requires each affected issue to be `status: new` with no accepted
readiness. Migration publication binds its exact terminal
manifest, all six retained lifecycle classes and matching readiness records/fingerprints, applicable
linked PRs/heads, receipts, and snapshot. Each requires fresh same-generation constituent-head
results for all three publication contexts plus publication-mode `Lifecycle handoff`; neither emits
readiness or mutates lifecycle.

The evaluator applies ADR-0003's membership, ordering, constituent diff, combined-tree, base, head,
and producer checks across the cumulative group. A mixed normal/publication group is eligible only
when every constituent passes its own lane and the cumulative composition passes. Unknown,
ambiguous, mismatched, or multiply classified constituents fail the group. A PR-head result cannot
satisfy the group SHA.

The evaluator uses complete event-cursor reads and a stable double-read to create one immutable
group snapshot. It binds the repository, target, base tip, group SHA and tree; ordered PR/head
membership, derived lane/submode, and input generation; each applicable issue/readiness/lifecycle,
manifest, or publication-receipt identity; and every evidence context's producer, run, and result
identity. The second stable read is the group eligibility linearization boundary. An event completed
before that boundary must be visible; otherwise snapshot creation fails. A later
invalidation publishes failure on the old group SHA and causes protected queue removal.
Re-enrollment creates a new group and requires a new snapshot. An old snapshot cannot authorize
a different group membership, tree, base, or SHA.

Only after snapshot read-back and exact equality may the evaluator publish `Lifecycle handoff`
success on the group SHA, bound to the snapshot identifier and ordered constituent lane identities.
Missing, stale, truncated, ambiguously ordered, wrong-producer, wrong-member, wrong-lane/submode,
wrong-generation, or changed group evidence publishes failure or leaves the context missing, and the
protected queue removes the entry. If provider ordering cannot prove the snapshot boundary, group
handoff stays unavailable. No constituent success, manual status, or same-named context substitutes
for it.

For the normal-delivery lane, pull-request validation accepts lifecycle only in `status: pr open` or
`status: ready for human review`, and independently requires current readiness. `status: in
progress` authorizes creation of the delivery PR but cannot satisfy an already-open PR's contract.
Blocked, waiting, new, triaged, ready, done, and closed states cannot pass. Neither can a wrong
target or stale head. A successful PR-head result is bound to that exact SHA. Any head, target,
issue contract, readiness, lifecycle, evidence, or linked-PR change invalidates it; a later valid
state requires all applicable checks to run again. Canonical publication uses only the ADR-0003
replacement matrix above and cannot satisfy or weaken this normal-delivery rule.

### Automated epic-branch merge boundary

A green status is evidence, not merge-time authority. Every automated child-issue merge into its
accepted `epic/**` integration branch must pass through one trusted server-side merge-authority
broker. Agents and ordinary workflows cannot merge directly or enable provider auto-merge. The
broker retains the per-issue lifecycle lock shared with the transition and handoff coordinators. It
also acquires a repository-and-exact-target-branch serialization lock shared by every broker
operation that can update that branch. Lock acquisition follows one repository-owned order so two
children cannot deadlock by holding different boundaries. Both locks issue fencing generations so a
lost or superseded lease cannot authorize a later write. A trusted provider merge queue may
implement this target lock only when it provides the same dual-ref conditional acceptance described
below. The broker loads policy only from protected `dev`, treats PR content as data, and never checks
out or executes the PR head.

The broker identity has only the PR/contents write and metadata read permissions required to merge
an accepted child PR into `epic/**`. Repository rules deny it any update, merge, bypass, or
auto-merge authority for `dev`; human-only deliberate `dev` merge remains unchanged. The broker
cannot broaden a target from PR content or a caller parameter, and it receives no ruleset or
required-check bypass on an epic branch.

Inside both serialized boundaries, the broker uses complete pagination and authoritative event
cursors to read the repository and exact accepted target name and target/base tip SHA; issue updated
identity and event cursor; current contract fingerprint and readiness record; sole ready for human
review lifecycle; accepted issue version and delivery target; exact linked PR, source, and head SHA;
draft and mergeability state; fresh same-generation `Lifecycle handoff`, `Issue contract current`,
and `PR contract` results; every exact-composition check for that head against that base; and all
audit, journey, review, conversation, manual, external, and platform evidence with expected
producer/run/result identities. Truncation, ambiguous pagination, or a missing producer fails the
read.

The broker then repeats complete pagination and performs a stable double-read of the issue updated
identity and cursor, readiness and lifecycle, PR/head, target/base ref, input generation, collection
boundaries, and every evidence identity. Exact equality creates a durable immutable
merge-authorization snapshot. Its identity binds all facts above, both lock-fencing generations, and
the normalized complete observation. Snapshot creation is
the logical authorization boundary: a mutation proven complete before it must be visible in the
second read or creation fails. A concurrent mutation not ordered before that boundary is sequenced
after the in-flight at-most-once merge, cannot widen its snapshot, and invalidates every subsequent
action. Prior green contexts cannot replace any snapshot fact.

While retaining both locks, the broker immediately re-reads the PR head and target tip. Its sole
conditional request carries the snapshot identifier and complete binding, addresses only the bound
repository, target, and PR, and presents both expected SHAs. The provider acceptance boundary must
atomically reject unless both lock fences remain current and the repository, target, PR head, and
target tip equal the snapshot. The broker submits a snapshot at most once and never retries or
refreshes an old snapshot. Success is accepted only after verifying the exact merge commit, its
first-parent/base and merged-head parents, resulting target tip, PR, and snapshot identity.

A changed base or head, hidden pre-boundary mutation, lock loss, or confirmed rejection authorizes
no merge. The broker releases any lock held, invalidates the snapshot, and reruns every
exact-composition gate under fresh locks against the newly observed base and head before creating a
new snapshot. Same-target brokers cannot pass the target lock concurrently, so the first accepted
merge's new target tip necessarily invalidates the second broker's old composition.

Activation requires a sanitized live liveness and ordering probe to prove complete cursor reads,
stable snapshot ordering, both fences, dual-ref conditional rejection, and exact parent/outcome
evidence. If any required read, lock, probe, or conditional provider semantic is unavailable, weakly
consistent, or cannot be proven, automated epic-branch merge is disabled and delivery is human-only;
the broker does not approximate it with status contexts or auto-merge. An unavailable or ambiguous
submitted response likewise disables automation, causes no retry, and requires authorized human
reconciliation of the exact commit parents and outcome before a later successful probe may
re-enable it. An agent never falls back to a direct merge.

The final done transition requires both a valid completion closure and its exact delivery evidence.
For a PR-delivered issue, the trusted workflow verifies the canonical linked PR, accepted target,
final verified head, merge result, accepted completion/audit evidence, and human-only `dev` merge
boundary. On a verified final merge, the trusted workflow may close the linked issue with reason
`completed`; the merge and issue events converge idempotently to done in either order. Intermediate
PRs in an explicitly accepted multi-PR plan return the issue to in progress instead of claiming
completion. A closed event with `not_planned`, `duplicate`, or missing/invalid completion evidence
removes all execution labels, invalidates readiness for execution, and applies no done label. It
emits a sanitized failure for authorized recovery. Reopening any closure converges to new.

### Semantic edits and stale evidence

Before activation, every title or body edit recomputes the normalized fingerprint. A changed type,
scope, outcome, authority, acceptance criterion, quality obligation, interface, trust boundary,
target, verification, audit, or other semantic field invalidates current readiness from every open
state, requires the semantic contract version to increase, and reconciles lifecycle to new. A
wording-only edit may retain its semantic version but still changes the fingerprint and requires a
new accepted record. The workflow invalidates every linked open PR's exact-head contract statuses.

After activation, a mutable issue edit cannot change repository authority. A semantic change is a
new append-only repository contract publication under ADR-0003; until the new terminal contract is
verified and accepted, prior authority cannot be silently widened. A stale, mismatched, or malformed
issue pointer fails closed and reconciles the issue to new. Lifecycle-only transitions do not edit
the accepted contract and do not change its version or digest.

### Idempotency, ordering, and partial failure

GitHub label writes are not transactional. The lifecycle workflow serializes mutations per issue,
reloads trusted current state before every decision, derives the desired state again rather than
trusting an event snapshot, removes all undesired `status:*` labels, applies the sole desired label,
and reads the issue back before publishing success. Zero or multiple lifecycle labels, a changed
issue version or update identity, or any failed read/write is a failed transition and grants no
authority.

Replaying the same event is safe because reconciliation is set-to-desired-state, not a blind
add/remove sequence. If a retry observes newer valid evidence, it evaluates that evidence instead
of restoring the older target. A partial mutation may temporarily leave zero labels; every consumer
rejects that state. Bounded retry may converge only when the original transition remains valid.
Otherwise the workflow records a sanitized operational failure, invalidates linked PR statuses, and
requires authorized reconciliation. It never interprets 403, 404, 409, 422, 429, timeout, malformed
payload, or unavailable API state as success.

Unauthorized or ambiguous label mutation is reconciled to blocked when current readiness remains
valid, and to new otherwise. Restoration is an explicit transition with fresh precondition checks;
it cannot reuse a prior PR result. Diagnostics contain issue/PR numbers, state names, contract
identity, exact head, transition result, and provider status class only—never raw bodies, payloads,
credentials, endpoints, or private content.

### ADR-0003 migration amendment

This ADR supersedes only ADR-0003's pre-activation migration selection by `status: ready`. It does
not change ADR-0003's immutable contract format, publication lane, signed receipt, or exact-byte
digest. Its merge-group, human merge, activation, and forward-only authority rules also remain.

The terminal migration manifest is the exact set of every open issue whose pre-activation accepted
readiness record still matches its current contract, regardless of whether its sole lifecycle label
is ready, in progress, PR open, ready for human review, blocked, or waiting for user. A blocked or
waiting issue without matching readiness is not included. New issues, done issues, and every closed
non-completed issue are excluded. Triaged issues are also excluded because their contracts are not
accepted. Set membership is determined from readiness evidence first and lifecycle second; labels
never manufacture an entry.

Every manifest entry and publication snapshot receipt binds the issue number and type, planning
version, normalized title/body fingerprint, exact accepted-readiness record URL and producer,
observed sole lifecycle label, expected contract path/revision, and any linked PR number, target,
and exact head required by that lifecycle. Duplicate, omitted, extra, conflicting, zero-label,
multi-label, stale-readiness, stale-PR, or unavailable observations fail exact set equality.

The sole terminal manifest freezes this complete inventory as ADR-0003 specifies. An intended
readiness or lifecycle change before activation enrollment requires a superseding manifest and
fresh candidate receipts. After enrollment, an allowlisted human must first remove the activation
PR from the queue; the changed manifest and receipts must merge before re-enrollment. The activation
merge-group validates the frozen manifest and signed receipts rather than reconsulting mutable issue
state after the signed-snapshot boundary.

At activation, each included issue keeps its observed lifecycle label while authority changes once
from the exact accepted issue record to the verified repository contract. The activation verifier
then revalidates every pointer and open PR: only PR open and ready-for-human-review issues may have
eligible linked PRs, and paused issues remain ineligible. Failure before the switch leaves old issue
authority unchanged; after the switch, recovery is forward-only and never falls back to issue
authority. This preserves complete in-flight work without a dual-authority interval.

## Consequences

The issue board can show truthful work stages without weakening planning authority. Readiness and
PR consumers must perform two explicit checks—current readiness and permitted lifecycle—rather than
using one label as a proxy. Paused work remains auditable but cannot continue automatically, and
completion/reopen behavior becomes reason-aware.

The implementation burden increases: issue and PR workflows need a shared lifecycle owner, the
two-phase handoff coordinator, the merge-group evaluator, the epic merge-authority broker, immutable
lane/generation and snapshot records, additional signal coverage, serialized reconciliation,
negative and recovery tests, and sanitized capability/liveness probes. Issue #21 must add the
canonical `docs/qa/issue-lifecycle.md` operational contract, link it from `AGENTS.md` and affected templates,
and prove workflows and tests enforce it. Existing accepted readiness comments remain valid evidence
only while their exact contract still matches; their current sentence tying validity to retention of
`status: ready` must be superseded by the new verifier semantics, not reinterpreted by labels alone.

Issue #21 remains blocked until this ADR is accepted, its implementation contract is revised to
cite this decision, all nine canonical states, and the broadened ADR-0003 migration set, and its
current version receives a new accepted readiness record. This ADR changes no workflow, validator,
template, label, branch setting, or product code by itself.

## Verification obligations

Implementation must add hermetic state-table and transition tests for every state and edge,
including forged readiness, conflicting labels, claim/release, PR open/close/reopen, stale head,
new-to-triaged authorization, rejected triage, triaged readiness acceptance/rejection, triage
invalidation, draft conversion, exact-head review handoff, intermediate and final merge,
blocked/waiting resume, and unmerged-PR-close recovery both with a retained valid claim and with no
valid claim. They must also cover another linked PR remaining open, unknown claim evidence, semantic
and wording-only edits, completed/not-planned/duplicate closure, reopen, unauthorized actor, replay,
event reordering, concurrent transition, partial label mutation, pagination, and API
403/404/409/422/429/timeout/malformed responses.

The transition fixtures must enumerate the permitted source/requested-target label-pair set and its
complete complement. They must prove that assignment/validated claim alone enters in progress,
validated PR events alone enter PR open, and the protected coordinator alone enters ready for human
review. They must separately prove implementer/maintainer waiting entry, authorized-human waiting
settlement, blocked recovery, forged workflow mutations, and rejected direct active-state gestures.

Handoff tests must exercise every wake-up class, producer authentication, out-of-order and dropped
signals, scheduled/manual recovery, phase-one exclusion of only `Lifecycle handoff`, self-produced
status-loop suppression, serialization, label mutation/read-back, head and evidence changes between
phases, review dismissal, reopened conversation, platform-evidence withdrawal, and every failure
reconciliation. They must prove phase two starts new `Issue contract current` and `PR contract` runs,
authenticates and binds their producer/run/result identities, and downgrades to PR open when either
run or publication fails. Fixtures must distinguish declared lifecycle-independent evidence from
lifecycle-sensitive and ambiguous evidence, rejecting changed or incorrectly retained results. No
success may survive a phase-two mismatch or bind a different head or lifecycle. Workflow contract
tests must prove `contents: read`, `persist-credentials: false`, no contents write, and no PR checkout
or execution.

Normal lifecycle fixtures must prove lane identity is unchanged across PR open and ready for human
review. PR open starts the handshake; an unchanged successful ready-for-human-review generation is a
no-op; changed or failed head/review/conversation/evidence/readiness inputs downgrade to PR open and
start fresh; and every other lifecycle is ineligible without reclassification.

Generation tests must cover simultaneous and repeated wake-ups, prerequisite completion storms,
out-of-order results, coordinator self-events, and upstream changes racing completion for both
normal and publication lanes. They must prove one prerequisite run per generation. Completion must
attach without recursive replacement. Unchanged pending/success is a no-op, and stale or mismatched
generation results are rejected. Tests must cover failed/abandoned terminal behavior and explicit
recovery sequencing. Only a validated input change creates a new digest. Missing generation output,
unproven event ordering, or unavailable stable reads must fail closed. Genuine upstream changes must
not be suppressed as self-events.

Canonical-generation fixtures must publish exact version-1 byte and digest vectors for every lane
and publication submode. Adversarial structural-collision, boundary, type, and domain-ambiguity
vectors such as fields shaped like
`("ab", "c")` versus `("a", "bc")` must produce different bytes and digests. Tests must cover
map/set insertion-order invariance, semantic-list order sensitivity, normalized-scalar equivalence,
fixed record order, duplicate raw or normalized keys/elements, unknown/missing fields and type tags,
malformed UTF-8, inconsistent lengths, trailing bytes, unknown schema/algorithm versions, changed
domain/lane/submode/input, and recovery
attempt separation. Producer, coordinator, group, and broker fixtures must independently recompute
the bytes/digest and reject malformed, unequal-length, or mismatched values through the approved
constant-time comparator; direct string equality or acceptance of a supplied digest must fail the
contract test.

Lane fixtures must prove exact-one classification and explicit lane binding for a normal PR and a
valid ordinary publication whose affected issues are `status: new` and unready. Migration fixtures
must cover matching retained readiness in ready, in progress, PR open, ready for human review,
blocked, and waiting for user. They must reject an ordinary PR attempting a publication exemption,
mixed or ambiguous scope, wrong target, stale or mismatched terminal manifest, issue set, readiness
record/fingerprint, lifecycle, linked PR/head, receipt/path/bytes/digest/snapshot evidence, wrong
producer, and any publication check that claims new readiness. They must prove neither publication
submode changes lifecycle or readiness and that readiness/normal lifecycle can begin only after
ADR-0003 verifies the exact protected-`dev` merge. The replacement matrix must remain non-circular
when all three fresh same-generation contexts and `Lifecycle handoff` run.

Merge-group tests must exercise `checks_requested`, complete pagination, constituent ordering, group
base/tree composition under ADR-0003, exact group SHA, and every constituent's applicable lane,
target, evidence, and expected producers. Tests must cover all-normal, all-publication, and mixed
groups, including ordinary-only publication, migration-only publication, and ordinary/migration
publication combinations. A mixed group passes only when every normal member has current readiness,
sole ready-for-human-review lifecycle, and a fresh generation; every publication member passes its
ordinary or migration evidence without new readiness; and the cumulative tree passes. They must
reject missing, stale,
duplicated, reordered, wrong-producer, wrong-member, wrong-lane, wrong-head, changed-base/tree,
truncated, and unavailable observations; prove no PR-head result substitutes for a group result; and
prove later invalidation fails or removes the old group and cannot reuse its snapshot for a new
group. Cursor/double-read races before and after snapshot creation must fail closed. Provider
ordering failure must also fail closed without PR code execution.

Epic merge-broker tests must start with a stale green head and cover semantic issue edit, readiness
loss, lifecycle change, head replacement, base advance, wrong target, unresolved conversation,
evidence withdrawal, expected-head or expected-base mismatch, concurrent handoff/label mutation,
two child PRs concurrently targeting the same epic branch, issue-lock or target-lock loss, merge
ambiguity, and invalidation status 403, timeout, or partial failure. They must prove every
pre-submission failure makes no merge call, an ambiguous conditional response causes no retry or
auto-merge, and changed refs force complete exact-composition gates against the newly observed base.
Fixtures must include complete pagination and event cursors, stable and unstable double-reads,
pre-boundary hidden mutation, post-boundary mutation, weak consistency, unavailable ordering or
conditional support, fencing failure, and live-probe failure. They must prove snapshot identity
binds the repository, target/base, PR/head, issue update/cursor, contract fingerprint, readiness,
lifecycle, and all evidence producers/results. They must prove an old snapshot is never retried and
a later mutation blocks every subsequent action. They must also prove no PR code executes. A
confirmed rejection remains unmerged, and `dev` is always human-only. Target-branch mutations must
serialize across issues, exact commit parents/outcome must be confirmed, and at most one
snapshot-bound dual-ref-conditional server-side merge
request occurs. Unavailable, ambiguous, weak, or unproven provider semantics must disable automated
merge and select human-only recovery rather than an approximation.

The repository contract check must require `docs/qa/issue-lifecycle.md`, the applicable `AGENTS.md`
and template links, and consistency between that contract, the lifecycle module, workflow triggers,
and state fixtures. It must enumerate every repository-declared `status:*` name and prove exact
equality with all nine table states. A separate authenticated live drift probe enumerates the
configured GitHub labels and proves that same equality without making hermetic tests depend on the
network. The contract check must then prove every state's actor, event, preconditions, readiness
rule, PR eligibility, invalidation, pause/resume, closure/reopen, failure, and recovery paths have
fixtures. Adding, removing, or renaming a status must fail this contract until every projection is
updated together. No external orchestration artifact may be a required authority or substitute.

Migration tests must prove exact set equality across all six readiness-bearing active or paused
states, exclude new, triaged, and terminal/non-completed closures, bind lifecycle and linked-PR
observations, and fail on omissions, duplicates, stale records, conflicting labels, or unavailable
evidence. Live probes retain only sanitized issue, PR, actor, event, state, readiness identity,
exact head, result, and timestamp. No new dependency or secret is authorized.

## Residual risks and uncertainty

GitHub does not provide an atomic replace-one-label operation, so a failed transition can leave a
temporary zero-label or multi-label state. The design contains that risk by making both states
non-authorizing and requiring read-back reconciliation; it cannot guarantee uninterrupted board
display during provider failure.

Provider label configuration and issue state remain externally mutable after any observation. The
immutable group and merge-authorization snapshots are logical linearization boundaries under proven
provider cursor, ordering, fencing, and conditional-ref semantics; they do not claim that GitHub
offers a general cross-API atomic transaction. If the live probe cannot establish those narrower
semantics, group eligibility fails and automated epic merge remains disabled. Later drift removes an
affected group or blocks subsequent governance actions and requires forward reconciliation; it never
widens the in-flight snapshot or changes the accepted planning contract. Existing-item cleanup
depends on the explicit external-mutation authority in the revalidated issue #21 contract;
revalidation is a hard prerequisite rather than assumed permission.

A provider timeout after accepting a conditional epic merge request can make the response
ambiguous even though the expected-head and branch rules constrain the effect. The broker contains
that uncertainty by submitting once, disabling automated merge, never enabling auto-merge, and
requiring authorized human reconciliation of exact commit parents and outcome before a successful
capability probe may restore automation. It does not retry or approximate the uncertain operation.

## Reopen triggers

Reopen this decision if GitHub removes or materially changes the required issue, pull-request,
closure-reason, or label-inventory semantics; current readiness cannot be verified independently of
labels; exactly-one lifecycle reconciliation cannot fail closed; an accepted lifecycle needs
another state; the migration cannot preserve every current accepted issue without dual authority;
or human-only `dev` merge and exact-head evidence cannot be retained.

## References

| Source                               | Reference                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Issue and PR workflow events         | [GitHub Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) |
| Issue state and closure reason       | [GitHub REST issues](https://docs.github.com/en/rest/issues/issues)                                                       |
| Webhook payloads                     | [GitHub webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)                     |
| Existing planning-contract authority | [ADR-0003](ADR-0003-repository-backed-planning-contracts.md)                                                              |
| Repository quality rules             | [Code quality standard](../engineering/code-quality-standard.md)                                                          |
