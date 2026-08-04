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
step to match its exact protected-writer name and provider-visible number with conclusion stably
`skipped`, binds
zero or one exact un-attested anchor, and quarantines only that orphan without treating it as a
record. An attempted or unknown attestation step is ambiguous regardless of current inventory
absence. The parent is an exact phase/fence record v2 carrying
`recovery_settlement_schema_version=2`; version-first dispatch never guesses between legacy and
forward settlement bytes. A historical settlement-bearing phase/fence v1 selects only the
read-only legacy settlement v1 schema. The phase/fence v2 settlement and its immediate
recovery-owned `abandoned` checkpoint authenticate their frozen generation, request, predecessor,
and orphan through the exact authorized recovery target, while the settlement encodes the final of
two equal stable current source observations. Later current-fact drift cannot stale either
authenticated null-effect historical record. Every mismatch remains blocked and effect-disabled.

Authenticated suffix-overflow recovery is a distinct effect-disabled path. Normal operation keeps
the hard limit of at most 15 non-checkpoint records. An allowlisted maintainer may post ADR-0012's
exact direct plain-issue overflow recovery command for a target binding exactly 16 contiguous,
fully authenticated records from the unique genesis root with no prior checkpoint. A prior
checkpoint plus 16 is denied. Within a hard 200-provider-request counter, the protected coordinator
may append only ADR-0011's version-2 form of the existing transition/read-back checkpoint with null
effect; a 108-request first recovery pass, 60-request second pass, six authorization requests, and
26 publication requests define the closed worst-case ceiling; successful coordinator records omit
inapplicable numeric job reads rather than padding the count. Every archive download counts its
authenticated artifact request plus the redirect response. Pass one downloads and bounds all
canonical bytes; pass two reuses only those immutable cached bytes while independently rereading
all comments,
artifact identities/metadata, attestation subjects, complete jobs/steps, and current facts. Each
exact attestation-subject response carries its bundles and no fictitious bulk or separate bundle
call is assumed. Publication downloads and verifies the locator before comment creation and the
anchor before success; its arithmetic is exactly `3 + 3 + 6 + 2 + 3 + 3 + 6 = 26`.
For this effect-disabled exact-target path only, verified GitHub-native attestation claims replace
independent workflow-run and referenced-workflow-inventory requests for historical records; an
exact job read binds each encoded job and full step projection to the attested run. Successful
coordinator records carry no job ID and instead require their unique artifact-anchor attestation to
bind the exact comment, record, caller, reusable writer, run, attempt, and protected SHA; no job ID
is inferred. Ordinary record authentication retains both provider run and inventory reads.
The same four record types remain authoritative. Overflow recovery is a human-only manual delivery
to `dev`.
A 17th record, request 201, replay, edit, unavailable fact, or any chain, anchor, attestation,
run/job/ref/SHA mismatch produces no record or lifecycle effect. Authenticated evidence is never
edited, deleted, skipped, or reclassified. If v2 publication is interrupted before authentication,
a fresh explicit maintainer command may retry the unconsumed target; the successful v2 checkpoint
binds and quarantines incomplete publications only after enforcing a hard cap of four historical
interrupted candidate comment copies present before the current attempt. Every byte-identical copy
is authenticated before grouping and consumes one request-budget slot; a fifth historical copy
fails closed with no record or effect. The current attempt's single prospective checkpoint comment
is excluded from the historical cap only while it is the current publication and uses the separate
26-request publication budget. It becomes the authenticated record on success; if authentication is
interrupted, it becomes a historical candidate on the next recovery, where a resulting fifth
historical copy denies another attempt. Each historical copy's distinct comment-bound anchor and
attestation tuple must be fully authenticated before any later copy becomes irrelevant. Each
candidate must carry
its exact pre-comment locator artifact and valid locator attestation binding the protected writer
run, terminal job, and locator-free candidate-record projection; its optional post-comment anchor
must have no attestation, and the fixed anchor-attestation publication step must be proven
by its exact mapped name and provider-visible number with conclusion `skipped`. An attempted or
unknown step permits no retry because late visibility could create two
authenticated checkpoints. A non-null anchor digest is SHA-256 of the downloaded sole canonical
artifact-anchor file and equals its recomputed auxiliary identity, never a provider archive digest.
Authenticated members precede quarantined candidates, which sort by ascending comment ID and reject
duplicates. An ambiguous candidate fails closed and produces no record or effect, and
no retry is automatic.

The overflow target is supported only when all 16 base record comments are present in the same
stable two-page first-pass window. A base record outside or missing from that window is unsupported
and fails closed with no recovery, record, or effect; anchors do not widen the window or authorize
exact-ID fetches.

The sole standing post-success replay shadows rule lets the stable two-page normal loader buffer at
most four lifecycle-marked comments with a higher numeric `comment_id` than one fully authenticated
overflow transition/read-back v2 checkpoint only when they are byte-identical to that checkpoint,
come from the exact never-edited Actions Bot/App comment shape, and form one body group. After the
lower-ID checkpoint authenticates, normal reconstruction reproducibly classifies them irrelevant
with no additional provider requests. They are not records, predecessors, recovery candidates,
target consumption, or authority. A fifth shadow, any body, actor, edit, or numeric-order mismatch,
or multiple groups fails closed.

If the two normal pages prove that older relevant history continues, the loader carries the same
at-most-four buffered shadows into ordinary effect-disabled cursor recovery as `irrelevant`
recovery-suffix members. Both the initial/normal pages and every cursor-resumed page may discover
replay shadows. One body group and four total apply across the entire accumulator. Their
classification is provisional and grants no independent standing. Every resumed step validates the
cumulative group and count before adding its page. A single serialized recovery invocation keeps
the authenticated cumulative summary and every full `recovery-suffix-member` preimage, including
ordinary irrelevant comments, in memory across its twice-stable pages. It first fully authenticates
the lower-ID overflow v2 checkpoint and the greater shadow-ID relationship. Only then may one
phase/fence claim v3 persist the complete at-most-15 live record members, one shadow body digest,
and exact shadow comment IDs. It publishes no intermediate cursor or progress claim. The final claim and immediate
checkpoint require at most 12 live records before publication; any larger or reserved open suffix
uses its exact existing recovery path or fails closed.

The hard cap is 5 accumulator pages. At most 10 comment-page requests cover two stable reads of
each page in the one invocation; 126 record-chain, target, provider, publication,
and read-back requests plus the fixed 14 ingress requests preserve the 150-request ceiling. The
126-call core is exactly 72 authentication and target calls, 26 current-provider calls, and 28
calls for two complete record publication and read-back sequences. The 72 calls are one artifact
list, 28 artifact-download redirect-chain calls, 14 subject-qualified attestation inventories, 28
run/job calls, and one exact target-or-orphan read. A fifth shadow, any mismatch or discontinuity,
cursor exhaustion, page 6, or missing checkpoint produces no
complete accumulator, checkpoint, or effect. The classification adds no request outside that closed
allocation, initiates no cursor recovery, and changes no 15-record bound, target consumption, or
authority.

Incomplete phase/fence claim v1 and v3 cursor records remain read-only compatibility and cannot be
resumed or migrated. The frozen pre-activation inventory is not limited to Issue #55's disposable
probe manifest. The frozen maximum issue number comes from two stable repository observations, and
the inventory classifies every canonical issue number from 1 through that maximum as an issue, pull
request, or missing resource. It scans every issue's complete bounded 5-page history and retains the
other classifications as negative evidence. Page 6, instability, or an unclassified number makes
the inventory incomplete. Zero incomplete v1 and v3 cursor claims across that complete inventory is
an exact activation precondition. Any discovery fails closed, blocks activation, retains all
evidence, and requires a separately governed exact-target human reconciliation issue before any
settlement; no boundary, summary, or cursor is inferred.

For overflow v2, the protected writer's final topology places locator read/prepare, upload,
attestation, and download/verification at YAML ordinals 3 through 6, comment publication and anchor
upload at 7 and 8, and `Attest exact lifecycle anchor identity` at ordinal 9/provider-visible step
10 for every lane. A historical topology without the four locator slots retains ordinal 5/step 6.
The bound protected commit and exact ordered writer topology, not record schema alone, select one
closed mapping; a verifier cannot confuse the overflow locator attestation at step 6 with anchor
non-submission.

Every superseded phase/fence claim must be followed by its terminal transition/read-back checkpoint
before a successor generation request. That checkpoint carries only the authenticated producer
subset already present before the superseded fence and fixes `transition_owner` to `invalidation`,
null effect, `outcome` to `superseded`, and `reason_code` to `superseded`. A later fact change
refreshes the terminal non-equality observation under the same frozen generation and fence rather
than appending another claim. At the reserved boundary the existing terminal fence itself becomes
that closed supersession predecessor; no second fence is appended, and the final encoded read-back
source observation is its sole durable superseding witness. Once its exact anchor attests
that null-effect checkpoint, a later fact change cannot stale the historical terminalization. The
ordinary writer uses a three-record terminalization reserve: it rejects a nonterminal append at 12
and places the terminal or superseded fence at record 13. The exact complete cursor-recovery v3
claim is the sole other claim permitted at record 13 and must be followed immediately by its
checkpoint at record 14. An interrupted unanchored v3 instead uses its exact version-2 cursor-claim
settlement at record 13 followed only by the recovery-owned checkpoint at record 14. A terminal
fence permits either its immediate checkpoint
or an exact version-2 interrupted-checkpoint settlement at record 14 followed only by the
recovery-owned null-effect checkpoint at record 15. If the reserved fence publication itself is
interrupted, its version-2 settlement occupies record 13 after the 12 authenticated records and
only the recovery-owned checkpoint may follow at record 14. An authenticated cursor-recovery v3 at
record 13 likewise permits an exact version-2 cursor-checkpoint settlement for its interrupted
unanchored checkpoint at record 14 followed only by the recovery-owned checkpoint at record 15.
Each settlement is allowed only when
the writer's anchor-attestation step's mapped name and provider-visible number were stably observed
with conclusion `skipped`; attempted or unknown submission remains ambiguous. Each recovery-owned
`abandoned` checkpoint carries the exact authenticated pre-fence producer subset, including empty;
no other abandoned checkpoint may omit an expected producer. Both the settlement and immediate
checkpoint retain the frozen generation and exact authorized recovery binding, use the
settlement's stable current source observation, and remain valid across later current-fact drift.
This makes a
prior-checkpoint-plus-16 suffix unreachable and prevents event churn or one
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
