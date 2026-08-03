# Issue Lifecycle

This is the canonical operational contract for Keiko Native issue lifecycle state. It projects
ADR-0004 into the repository-owned words and machine checks used by agents, humans, templates, and
quality gates.

Readiness and lifecycle are separate. Current readiness is a trusted evidence predicate over the
latest accepted contract version and fingerprint. A lifecycle label never creates readiness, and a
readiness record never bypasses the action limits of the current lifecycle state.

## Canonical States

Every governed open issue has exactly one of these labels. A completed closed issue has exactly
`status: done`. Closed non-completed issues carry no `status:*` label.

- `status: new`
- `status: triaged`
- `status: ready`
- `status: in progress`
- `status: pr open`
- `status: ready for human review`
- `status: blocked`
- `status: waiting for user`
- `status: done`

## State Meanings

### `status: new`

Planning intake is unreviewed, changed, reopened, or invalidated. Current readiness must be absent.
Template creation, semantic contract edits, type or authority changes, and trusted reopen recovery
enter this state. No pull request can pass from this state.

### `status: triaged`

Planning is reviewed, correctly typed and classified, and ordered for delivery, but the exact
contract is not accepted. Current readiness must be absent. Only an authorized planning actor can
request ready from here.

### `status: ready`

The exact contract has current readiness and is unclaimed. This state authorizes a valid claim or
an authorized pause. A linked delivery pull request cannot pass while the issue remains ready.

### `status: in progress`

An authorized implementer has claimed current-ready work and no delivery pull request is active.
Opening or reopening a contract-authorized pull request can enter PR open.

### `status: pr open`

At least one contract-authorized delivery pull request is open. Current readiness is required. The
linked PR must match the accepted issue, target, source rule, and exact head evidence.

### `status: ready for human review`

The open linked PR's exact current head has complete verification, audit, conversation, journey,
platform, and evidence obligations. Current readiness is required. This is the automation stop
state for a `dev` target; only an allowlisted human may initiate a `dev` merge.

### `status: blocked`

Progress is paused by a dependency, decision, or failing external condition. Matching readiness may
be retained, but it grants no authority to continue. Linked PR contract evidence is invalidated.

### `status: waiting for user`

Progress is paused for explicit human product, policy, risk, scope, or approval input. Matching
readiness may be retained, but it grants no authority to continue. A comment alone does not resume
work.

### `status: done`

Final accepted delivery is complete and the issue is closed with reason `completed`. Earlier
readiness is historical and non-executable. Reopen removes done and returns to new.

## Allowed Edge Graph

Every unlisted edge is invalid and fails closed.

- Creation or reopen enters `status: new`.
- `status: new` may enter `status: triaged`, `status: blocked`, or
  `status: waiting for user`.
- `status: triaged` may enter `status: ready`, `status: blocked`,
  `status: waiting for user`, or `status: new`.
- `status: ready` may enter `status: in progress`, `status: blocked`,
  `status: waiting for user`, or `status: new`.
- `status: in progress` may enter `status: ready`, `status: pr open`,
  `status: blocked`, `status: waiting for user`, or `status: new`.
- `status: pr open` may enter `status: ready`, `status: in progress`,
  `status: ready for human review`, `status: blocked`, `status: waiting for user`,
  or `status: new`.
- `status: ready for human review` may enter `status: pr open`,
  `status: in progress`, `status: blocked`, `status: waiting for user`,
  `status: new`, or `status: done`.
- `status: blocked` may enter `status: waiting for user`, `status: new`,
  `status: triaged`, `status: ready`, `status: in progress`, or `status: pr open`.
- `status: waiting for user` may enter `status: blocked`, `status: new`,
  `status: triaged`, `status: ready`, `status: in progress`, or `status: pr open`.
- `status: done` may enter only `status: new`, and only through reopen.

Semantic edits from any open state override the ordinary edge and enter new. A valid final merge
cannot enter done directly from PR open because ready-for-human-review exact-head evidence is a
precondition.

## Permitted Label Requests

Label changes are requests, not authority. The trusted workflow reloads state and validates the
request before reconciliation. These are the only permitted source and requested-target pairs:

- `status: new` -> `status: triaged`: planner or maintainer.
- `status: triaged` -> `status: ready`: planner or maintainer.
- `status: new` -> `status: blocked`: implementer or maintainer with a blocking condition.
- `status: triaged` -> `status: blocked`: implementer or maintainer with a blocking condition.
- `status: ready` -> `status: blocked`: implementer or maintainer with a blocking condition.
- `status: in progress` -> `status: blocked`: implementer or maintainer with a blocking condition.
- `status: pr open` -> `status: blocked`: implementer or maintainer with a blocking condition.
- `status: ready for human review` -> `status: blocked`: implementer or maintainer with a
  blocking condition.
- `status: waiting for user` -> `status: blocked`: implementer or maintainer with a blocking
  condition.
- `status: new` -> `status: waiting for user`: implementer or maintainer with the missing input.
- `status: triaged` -> `status: waiting for user`: implementer or maintainer with the missing
  input.
- `status: ready` -> `status: waiting for user`: implementer or maintainer with the missing input.
- `status: in progress` -> `status: waiting for user`: implementer or maintainer with the missing
  input.
- `status: pr open` -> `status: waiting for user`: implementer or maintainer with the missing
  input.
- `status: ready for human review` -> `status: waiting for user`: implementer or maintainer with
  the missing input.
- `status: blocked` -> `status: waiting for user`: implementer or maintainer with the missing
  input.

Direct label gestures for new, in progress, PR open, ready for human review, or done are never
authority. Workflow-authored reconciliation mutations are effects carrying trusted transition
identity, not user requests.

## Protected Request Ingress

The protected `Lifecycle wake-up` workflow is the sole top-level request surface. It accepts only
ADR-0012's closed issue, pull-request, comment, check, workflow-completion, and hourly schedule
sources. Split read-only resolvers reduce those events to the required issue number and optional
recovery-comment locator. A caller-held `issue-lifecycle-{issue}` group then invokes the reusable
`Issue lifecycle` coordinator with only `issue_number:number` and
`recovery_comment_id:string`. There is no lifecycle `workflow_dispatch`, repository dispatch,
caller-selected ref, actor role, lane, target, activation, transition, producer, or outcome.

The stable result is the authenticated ADR-0011 transition/read-back record and its artifact-anchor
identity. It contains only canonical digests, provider event identity, actor login, source,
requested and desired state, activation class, closed outcome, and timestamp. The protected writer
records the bounded canonical envelope for duplicate, replay, and conflicting-identity detection;
it never records the request reason, issue body, provider response, endpoint, or credential
material. Missing, stale, malformed, unauthorized, replayed, or conflicting requests fail closed.

Until Issue #55's signed activation, the coordinator keeps
`KEIKO_ISSUE_LIFECYCLE_ACTIVATION=disabled`. Each wake advances at most one authenticated record
obligation: generation request, phase fence, one closed nested producer result, or terminal planned
transition/read-back. `pr-contract.yml` and `contract-publication.yml` are the only nested producer
paths and receive the exact ordered 18-string wire. The guarded-off composition does not add,
remove, or replace a lifecycle label, close an issue, publish a lifecycle status, or perform any
branch effect. External skills and agents may trigger accepted provider events or observe the
stable record interface but never copy or override its policy.

## Preconditions And Recovery

The lifecycle owner reloads the issue, comments, provider label inventory, current readiness, PR
topology where applicable, and exact issue identity before deciding. Zero lifecycle labels, multiple
lifecycle labels, unknown labels, stale readiness, replayed readiness, mismatched issue identity,
unauthorized actor role, unavailable provider data, or malformed provider data fail closed.

Pause entry requires blocked or waiting evidence. Resume is explicit and never restores ready for
human review. Without current readiness, unchanged suspended triaged returns to triaged and every
other suspended source returns to new. With current readiness, topology may return ready, in
progress, or PR open.

Completed closure requires final delivery evidence and enters done. Non-completed closures remove
all lifecycle labels. Reopen always enters new and requires fresh readiness before execution.

The label mutation path uses set-to-desired reconciliation: remove undesired `status:*` labels,
apply the sole desired label, then read back and verify exact issue identity plus exactly one
matching lifecycle label.

## Protected Handoff Records

ADR-0011 defines the versioned protected handoff protocol. Protected workflows loaded from `dev`
use the built-in `github-actions[bot]` and short-lived `GITHUB_TOKEN` to append strict canonical
generation-request, producer-result, phase/fence-claim, and transition/read-back issue records.
Records are body-free operational evidence, not readiness, lifecycle, or merge authority.

Every writer and lifecycle effect shares the exact per-issue
`issue-lifecycle-${decimal issue number}` serialization domain with `queue: max` and no
`cancel-in-progress` key. The provider-intensive job also uses the repository-wide
`issue-lifecycle-provider-budget` group. Post-publication GitHub-native attestations bind each
provider comment ID, exact body digest, record digest, and protected writer run in an immutable
per-issue artifact anchor that detects an unreferenced suffix deletion. Transition/read-back
checkpoints bound the effect-capable suffix to 15 records; cursor recovery is effect-disabled and
advances through authenticated, domain-separated root and resumed accumulator steps when the normal
two-page comment load cannot reach a checkpoint. Complete bounded pagination, full-body parsing,
App/workflow/run/ref
authentication, exact predecessor chains, stable double-reads, and fencing reject deleted, edited,
duplicated, conflicting, stale, truncated, wrong-generation, wrong-producer, rate-limited, or
unavailable evidence. An ambiguous effect is never retried; explicit authorized recovery creates
the next attempt and binds the settled predecessor.

Normal mode counts both provider calls in each of its 16 artifact-download redirect chains: one
stable pass is 109 requests, two passes are 218, and the existing 14 write/read-back calls close the
hard ceiling at 232. Overflow recovery retains its distinct hard-200 counter and closed historical
authentication profile below.

Stable proof of zero relevant record comments and zero exact-name anchors selects empty-history
bootstrap, not truncated-history recovery. The first request uses null predecessors and checkpoint
numbering begins at one through the exact domain-separated null-root compacted-prefix schema. A
pre-checkpoint crash either remains empty, resumes a completely authenticated genesis suffix, or
uses a protected forward recovery settlement. New settlements use the version-2 identity while the
original version-1 zero-anchor identity remains read-only compatibility. A settlement requires an
explicit request binding the exact orphan and last authenticated predecessor, independently
verifies the failed protected run and fixed writer job, requires the anchor-attestation publication
step to be stably `skipped`, binds
zero or one exact un-attested anchor, and quarantines only that orphan without treating it as a
record. An attempted or unknown attestation step is ambiguous regardless of current inventory
absence. Every mismatch remains blocked and effect-disabled.

Authenticated suffix-overflow recovery is a distinct effect-disabled path. Normal operation keeps
the hard limit of at most 15 non-checkpoint records. An allowlisted maintainer may post ADR-0012's
exact direct plain-issue overflow recovery command for a target binding exactly 16 contiguous,
fully authenticated records from the unique genesis root with no prior checkpoint. A prior
checkpoint plus 16 is denied. Within a hard 200-provider-request counter, the protected coordinator
may append only ADR-0011's version-2 form of the existing transition/read-back checkpoint with null
effect; a 108-request first recovery pass, 60-request second pass, six authorization requests, and
26 publication requests exhaust the ceiling exactly. Every archive download counts its authenticated
artifact request plus the redirect response. Pass one downloads and bounds all canonical bytes;
pass two reuses only those immutable cached bytes while independently rereading all comments,
artifact identities/metadata, attestation subjects, complete jobs/steps, and current facts. Each
exact attestation-subject response carries its bundles and no fictitious bulk or separate bundle
call is assumed. Publication downloads and verifies the locator before comment creation and the
anchor before success; its arithmetic is exactly `3 + 3 + 6 + 2 + 3 + 3 + 6 = 26`.
For this effect-disabled exact-target path only, verified GitHub-native attestation claims replace
independent workflow-run and referenced-workflow-inventory requests for historical records; an
exact job read still binds each job and full step projection to the attested run. Ordinary record
authentication retains both provider run and inventory reads.
The same four record types remain authoritative. Overflow recovery is a human-only manual delivery
to `dev`.
A 17th record, request 201, replay, edit, unavailable fact, or any chain, anchor, attestation,
run/job/ref/SHA mismatch produces no record or lifecycle effect. Authenticated evidence is never
edited, deleted, skipped, or reclassified. If v2 publication is interrupted before authentication,
a fresh explicit maintainer command may retry the unconsumed target; the successful v2 checkpoint
binds and quarantines at most four fully proven incomplete publications. Each candidate must carry
its exact pre-comment locator artifact and valid locator attestation binding the protected writer
run, terminal job, and locator-free candidate-record projection; its optional post-comment anchor
must have no attestation, and the fixed anchor-attestation publication step must be proven
`skipped`. An attempted or unknown step permits no retry because late visibility could create two
authenticated checkpoints. A non-null anchor digest is SHA-256 of the downloaded sole canonical
artifact-anchor file and equals its recomputed auxiliary identity, never a provider archive digest.
Authenticated members precede quarantined candidates, which sort by ascending comment ID and reject
duplicates. A fifth or ambiguous candidate fails closed, and no retry is automatic.

Every superseded phase/fence claim must be followed by its terminal transition/read-back checkpoint
before a successor generation request. That checkpoint carries only the authenticated producer
subset already present before the superseded fence and fixes `transition_owner` to `invalidation`,
null effect, `outcome` to `superseded`, and `reason_code` to `superseded`. A later fact change
refreshes the terminal non-equality observation under the same frozen generation and fence rather
than appending another claim. At the reserved boundary the existing terminal fence itself becomes
that closed supersession predecessor; no second fence is appended, and the final encoded read-back
source observation is its sole durable superseding witness. Once its exact anchor attests
that null-effect checkpoint, a later fact change cannot stale the historical terminalization. The
ordinary writer uses a three-record terminalization reserve: it rejects a nonterminal append at 12,
places the terminal or superseded fence at record 13, and permits either its immediate checkpoint
or an exact version-2 interrupted-checkpoint settlement at record 14 followed only by the
recovery-owned null-effect checkpoint at record 15. If the reserved fence publication itself is
interrupted, its version-2 settlement occupies record 13 after the 12 authenticated records and
only the recovery-owned checkpoint may follow at record 14. Either settlement is allowed only when
the writer's anchor-attestation step was stably `skipped`; attempted or unknown submission remains
ambiguous. This makes a prior-checkpoint-plus-16 suffix unreachable and prevents event churn or one
interrupted reserved fence or checkpoint from starving terminalization.
Overflow recovery remains disabled for lifecycle effects before Issue #55, adds no principal or
credential, and changes no merge authority. Any implementing pull request to `dev` is a human-only
manual delivery. The separate accepted defect issue required by decision #170 may nevertheless
append only issue #52's exact null-effect v2 checkpoint after its effect-disabled implementation and
hostile complement are green; that comment is the sole pre-activation content effect it owns.

The record protocol preserves all nine states and the exact allowed edge graph above.
`no-lifecycle` is an outside-graph observation only for creation, reopen, and non-completed closure,
not a tenth label. A self-state observation is a no-op; every unlisted source/target pair is denied.
Producers never select lane, target, activation, transition, or merge authority. Before Issue #55's
signed activation, records may describe only non-applied outcomes and no lifecycle, status, branch,
pull-request, queue, or merge effect is permitted.
