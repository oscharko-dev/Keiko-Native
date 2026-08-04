# Repository activation checklist

## Status

Manual owner runbook. Repository automation must not activate, weaken, or bypass its own
administrative controls.

## 1. Merge the governance baseline

- Deliver this baseline through a human-reviewed pull request to `dev` under the currently active
  rules.
- Do not require the new `PR contract` or `Issue contract current` contexts until their workflows
  exist on protected `dev` and a live pull request has emitted them.
- Keep `dev` as the default integration branch. Do not push the baseline directly.

## 2. Install the label contract

Copy the Existing Keiko label taxonomy without renaming its existing labels. Add these Native
template labels, which do not exist in the current source taxonomy:

| Label            | Purpose                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `type: decision` | Evidence-backed architecture, product, security, or platform decision |
| `type: defect`   | Reproducible defect or user finding that restores accepted behavior   |

Confirm that these copied labels retain their exact names: `type: epic`, `type: task`,
`status: new`, `status: triaged`, `status: ready`, `status: in progress`,
`status: pr open`, `status: ready for human review`, `status: blocked`,
`status: waiting for user`, and `status: done`. The legacy `bug`, `User Findings`, area,
dependency, and contributor labels may coexist; they do not replace the single supported `type:*`
label required by the Native issue contract.

Create one disposable issue from every template and confirm that its declared labels are applied.
Delete the disposable issues after the readiness probes below.

## 3. Protect `dev`

Configure a ruleset or branch protection that:

- requires pull requests, strict current-branch checks, signed commits, linear history, and resolved
  conversations;
- blocks force pushes and branch deletion and applies to administrators;
- restricts updates and merges to the explicit authorized-maintainer allowlist;
- requires the repository-owned agent/tool-policy guard, which denies every agent request for `dev`
  before any provider call; and
- requires each exact-head context and expected App ID listed in `quality-gates.md`, but only after
  its producer has passed the live negative and positive probes.

Repository-wide provider auto-merge is not the Keiko Native epic-delivery mechanism. Because the
guarded operation uses the existing authenticated maintainer credential, GitHub cannot distinguish
agent and human actions and cannot apply a separate automation-identity deny rule. Preserve the
human allowlist, whose current membership is Niko and Oscharko, and all protections as defense in
depth. Prove the repository-owned guard denies every agent merge, update, auto-merge, enqueue,
administration, or bypass request for `dev`.

## 4. Protect `epic/**`

Configure an epic-branch ruleset that requires pull requests, strict up-to-date current-branch
checks, signed commits, linear history, resolved conversations, `PR contract`,
`Issue contract current`, and every deterministic or provider check observed for that target
during the live probes.

The repository-owned guard may use the existing authenticated maintainer credential for one fully
eligible child-issue pull request only when its base is the issue's exact accepted `epic/**` target.
Epic and standalone pull requests remain human-only deliveries to `dev`. Require immediate
revalidation of issue authority, `status: ready for human review`, source and target refs, current
head and base, applicable checks, audit evidence, findings, review conversations, stable reads,
replay state, exact-head provider acceptance, and exact post-effect commit, parent, and tree
evidence. The guard persists a durable single-flight compare-and-set claim for target/base
serialization before any provider submission. The target/base serialization uniqueness key
consists only of repository, exact accepted target, and observed current base. The immutable
per-operation record binds issue, contract, readiness, pull request, exact head, and request
identity. Distinct request identities cannot create another serialization claim. Two distinct
child-issue pull requests for the same exact accepted target and observed base contend on that one
key; only one may reach provider submission. Any mismatch, ambiguity, unavailable evidence, or
non-exact target fails closed. The operation passes the exact revalidated head SHA as the provider
request's `sha` parameter, explicitly sends `merge_method: squash`, never uses provider auto-merge,
and submits at most once. It verifies that the exact target tip is the reported squash commit,
whose sole parent is the observed base and whose tree equals the observed head tree. An ambiguous
claim remains blocked with no retry until explicit human reconciliation using exact refs, the
squash commit, its parent, and the observed trees. A new request identity is permitted only after
explicit terminal settlement or human reconciliation and fresh revalidation. Retain only the
sanitized request identity, issue, pull request, exact refs, result class, squash commit, parent and
tree identifiers, and read-back as the automation record; never retain the credential or raw
provider bodies. The guard must deny every agent merge, auto-merge, enqueue, push, or update request
for `dev`, `main`, and `release/**`.

The merge endpoint's `sha` precondition binds only the pull-request head and does not atomically
bind the base. Strict current-branch protection and immediate revalidation must therefore make a
base advance invalidate eligibility and reject the merge before the guarded effect. This is
defense in depth, not an atomic base compare-and-swap.

## 5. Verify workflow permissions and providers

- Keep the repository Actions default token read-only. Retain only the job-level permissions
  declared in the checked-in workflows.
- Confirm that SonarQube Cloud, Socket, CodeQL, Dependency Review, OSV, Gitar, and Keiko for Quality
  are installed or configured for Keiko Native with the documented producer identities.
- Keep Gitar and Keiko for Quality advisory until their documented liveness and negative probes
  succeed.
- After any organization or repository rename, update remotes and provider bindings manually, then
  change checked-in repository coordinates in a separate governed pull request. Do not disable a
  failing binding check as a shortcut.

## 6. Run the activation probes

Use the exact protected policy, request, durable-claim, provider, read-back, and
human-reconciliation procedure in
[`guarded-epic-merge.md`](guarded-epic-merge.md). Before Issue #55 freezes its manifest, confirm
that the checked-in policy status is `disabled` and bound to the exact protected `dev` revision.

ADR-0011's lifecycle handoff records must also remain inert until Issue #55. Protected workflows
use only the built-in `github-actions[bot]` and short-lived `GITHUB_TOKEN`; no account, installed
App, PAT, broker, database, hosted service, application/runtime dependency, or second credential is
provisioned. Any GitHub-maintained attestation transport is full-SHA pinned under the refreshed #51
contract. Before activation, an ordinary generation may emit only sanitized non-applied
observations and must not change a lifecycle label, commit status, branch, pull request, queue, or
merge. The sole additional content effect is the separately accepted defect's exact null-effect
overflow-v2 checkpoint for issue #52 described below.

Overflow recovery must be implemented and proven before Issue #55 can activate the protocol. While
activation is disabled, its exact allowlisted direct plain-issue command may only append one
null-effect version-2 transition/read-back checkpoint over the exact authenticated 16-record genesis
suffix. The probe must preserve the ordinary 15-record bound; reject a 17th record, checkpoint plus
16, and request 201; prove the exact 108 + 60 + 6 + 26 request budget; preserve every existing
comment, anchor, and attestation; count both calls in every artifact-download redirect chain; cache
bounded canonical archive bytes only between the two passes while independently rereading all
provider identities, metadata, attestations, complete job/step projections, and current facts;
consume bundles from each subject-qualified response; and download/reproduce the new locator before
comment creation and the final anchor before success. It must prove replay is a no-op;
prove that verified protected caller/writer attestation claims plus exact bound job/step reads only
for records that encode a job replace workflow-run and referenced-workflow-inventory requests inside
this effect-disabled exact-target path, while successful coordinator records require their unique
artifact-anchor attestation correlation and ordinary authentication retains the provider reads;
recover incomplete publications only under a hard cap of four historical interrupted candidate
comment copies present before the current attempt. Every byte-identical copy is authenticated
before grouping and consumes one request-budget slot; a fifth historical copy fails closed with no
record or effect. The current attempt's single prospective checkpoint comment is excluded from the
historical cap only while it is the current publication and uses the separate 26-request publication
budget. It becomes the authenticated record on success; if authentication is interrupted, it
becomes a historical candidate on the next recovery, where a resulting fifth historical copy denies
another attempt. Each historical copy's distinct comment-bound anchor and attestation tuple must be
verified before it becomes irrelevant. The activation matrix must prove the overflow target is
supported only when all 16 base record comments are present in the same stable
two-page first-pass window. A base record outside or missing from that window is unsupported and
must fail closed with no recovery, record, or effect; anchors must not widen the window or authorize
exact-ID fetches. The activation matrix must prove the sole post-success
replay shadows rule: the stable two-page normal loader buffers at most four exact Actions Bot/App,
never-edited comments with a higher numeric `comment_id` than one fully authenticated overflow
transition/read-back v2 checkpoint and byte-identical full bodies. After that lower-ID checkpoint
authenticates, normal reconstruction reproducibly marks the shadows irrelevant with no additional
provider requests; they are not records, predecessors, recovery candidates, target consumption, or
authority. A fifth shadow, a body, actor, edit, or numeric-order mismatch or multiple groups fails
closed. If the two normal pages prove that older relevant history continues, the loader must carry
the same at-most-four buffered shadows into ordinary effect-disabled cursor recovery as `irrelevant`
recovery-suffix members. Both the initial/normal pages and every cursor-resumed page may discover
replay shadows. One body group and four total apply across the entire accumulator. Their
classification is provisional and grants no independent standing. Every resumed step must validate
the cumulative group and count before adding its page. A single serialized recovery invocation
must keep the authenticated cumulative summary and every full `recovery-suffix-member` preimage,
including ordinary irrelevant comments, in memory across its twice-stable pages. The probe must
exercise three root branches. An overflow-v2-checkpoint-rooted invocation authenticates the
lower-ID v2 checkpoint and greater shadow-ID relationship. An ordinary-v1-checkpoint-rooted
invocation authenticates the v1 checkpoint, requires a null shadow digest and empty shadow-ID list,
and accepts no provisional shadow. A unique-genesis-rooted invocation requires the same
empty-shadow facts and authenticates the complete genesis suffix directly. Both
cursor-interruption settlements repeat the same root-specific proof. Only then may one phase/fence
claim v4 persist its non-null `cursor_recovery_authorization_comment_id`,
`cursor_recovery_authorization_identity`, and `cursor_recovery_target_identity`, complete at-most-15
live record members, shadow summary, and exact shadow comment IDs. The probe must bind the comment
ID as the bounded locator for the command-specific authenticated maintainer request, the first
identity to its canonical preimage, and the second to its exact incomplete-scan target,
independently of the inherited generation request. The probe must reconstruct that target from the
stable historical prefix ending strictly before the exact command comment ID. The command and later
comments are excluded, and the existing stable direct-ingress reads must reproduce the original
boundary without another provider request. It must publish no
intermediate cursor or progress claim. The
final claim and immediate checkpoint require two through 10 live records including the
unique-genesis request, one through 9 after an ordinary-v1 root, or one through 8 after an
overflow-v2 root, forming one internally valid open
generation that begins with its authenticated generation request and contains no terminal claim or
checkpoint. The direct recovery-owned `abandoned` checkpoint carries exactly the
authenticated same-generation producer subset present before v4, including empty, retains every
included result's original producer-owning fence, and permits no producer after v4. A
unique-genesis root alone or a checkpoint root with zero later live records authenticates the root
and replay-shadow relation but is a no-op with no v4 claim, checkpoint, record, or effect. Any
larger, reserved, or differently shaped open suffix uses
its exact existing recovery path or fails closed.
The probe must prove that an authenticated v4 claim does not consume the cursor target. Only its
fully authenticated direct checkpoint or the settlement-following recovery checkpoint consumes
the target. An interruption admits a fresh command for the still-unconsumed target; the settlement
binds that request while treating the v4 authorization comment ID only as a locator, repeating
six-request exact-comment authentication of the original command, and requiring its recomputed
identity to equal v4 before the orphan/predecessor proof retains the original authorization and
target. The probe must prove the settlement target comes only from the authenticated original v4
claim, never from the fresh command cutoff; that cutoff is only the fresh command's
ingress-authentication boundary.

The activation probe must enforce a hard cap of 3 accumulator pages, three closed
root-authentication branches, and two budget profiles. At
most 6 comment-page requests cover two stable reads of each page in the one invocation. A
unique-genesis or ordinary-v1 root permits at most twelve record/root/orphan tuples. Its 64 base
authentication calls plus two independently reserved stable exact cursor-orphan
writer-job/skipped-step reads and six original-command reauthentication calls, 26 current-provider
calls, and 28 publication calls form a 126-call core and 146 total calls with pages and the fixed 14
ingress calls. An overflow-v2 root admits at most eight post-root live records and eleven tuples.
Its base authentication uses one artifact list, 22 artifact-download redirect-chain calls, 11
subject-qualified attestation inventories, 22 workflow-run and referenced-workflow-inventory calls,
and at most three exact producer-job calls; the root's six locator-verification calls, two stable
cursor-orphan writer-job reads, and six original-command reauthentication calls make 73
authentication calls. With the same 26 current-provider and 28 publication calls, that is a
127-call core and 147 total calls. The fresh ingress authorization bytes are reused, but the
original command is independently reauthenticated from the v4 locator. Both profiles remain within
the hard 150-request ceiling. A fifth shadow, any mismatch or discontinuity, cursor exhaustion,
page 4, or missing
authenticated root must produce no complete accumulator, checkpoint, or
effect. The classification adds no request outside that closed allocation, initiates no cursor
recovery, and changes no 15-record bound, target consumption, or authority.

The activation probe must require every legacy phase/fence claim v1 cursor record, whether
incomplete or complete, to have phase `recovery` and `claim_outcome` exactly `claimed`; every other
v1 cursor outcome is malformed. It must treat those accepted records and legacy incomplete v3
cursor records as read-only compatibility and prohibit resume or migration. Every new cursor
completion must use v4. The frozen pre-activation inventory is
not limited to Issue #55's disposable-probe manifest. The frozen maximum issue number comes from two
stable repository observations, and the inventory classifies every canonical issue number from 1
through that maximum as an issue, pull request, or missing resource. It scans every issue's complete
bounded 3-page history and retains the other classifications as negative evidence. Page 4,
instability, or an unclassified number makes the inventory incomplete. Zero v1 recovery-scan claims
with a non-null recovery-scan identity, whether incomplete or complete, and zero v3 cursor claims
across that complete inventory is an exact activation precondition. Any discovery must fail closed,
block activation, retain all evidence, and require a separately governed exact-target human
reconciliation issue before any settlement; no boundary, summary, or cursor may be inferred.

Before activation, every pre-amendment protected writer run loaded from an older `dev` SHA must be
terminal. The Issue #55 activation operation must then acquire and hold the existing repository-wide
`issue-lifecycle-provider-budget` serialization group, perform one final complete-inventory
revalidation while holding that group, and retain it until the authenticated activation receipt is
durable. Any queued or in-progress pre-amendment writer, inventory drift, or unavailable read must
block activation.
Every writer admitted after the receipt must load the accepted activation commit and be unable to
emit a v1 or v3 cursor scan claim; every new cursor completion must use v4.

It must also prove superseded
generations authenticate their frozen generation and closed partial producer set. An ordinary
superseded fence binds its first witness; the reserved-fence exception uses the final encoded
read-back source observation as its sole durable witness and refreshes that projection under the
same fence before terminalizing ahead of a successor with owner `invalidation`, null effect, outcome `superseded`, and
reason `superseded`; a post-anchor fact change cannot stale that exactly attested null-effect
checkpoint. The writer must use a three-record terminalization reserve: reject a nonterminal append
at 12, place the terminal fence at record 13, permit its immediate checkpoint or exact version-2
skipped-attestation checkpoint-orphan settlement at record 14, and then permit only the
recovery-owned null-effect checkpoint at record 15. An interrupted fence instead uses its exact
version-2 settlement at record 13 and checkpoint at record 14. The exact complete cursor-recovery v4
claim defines `n` as the authenticated live non-checkpoint suffix cardinality from two through 10
including the unique-genesis generation request, from one through 9 after an ordinary-v1 root, or
from one through 8 after an overflow-v2 root, for one internally valid open generation that begins
with its authenticated generation request and
contains no terminal claim or checkpoint. It is record `n + 1` and must be followed immediately by
its checkpoint at record `n + 2`. That direct recovery-owned `abandoned` checkpoint carries exactly
the authenticated same-generation producer subset present before v4, including empty, and retains
each result's original producer-owning fence; no producer may publish after v4. A unique-genesis
root alone (`n = 1`) or checkpoint root with no later live record (`n = 0`) is a no-op with no v4
claim, checkpoint, record, or effect. An interrupted unanchored
v4 instead uses its exact version-2 cursor-claim settlement at record
`n + 1`, followed only by the recovery-owned checkpoint at record `n + 2`. After an authenticated
cursor-recovery v4 at record `n + 1`, an interrupted unanchored cursor-recovery checkpoint uses its
exact version-2 cursor-checkpoint settlement at record `n + 2`, followed only by the recovery-owned
checkpoint at record `n + 3`. At the maxima, a unique-genesis path uses at most records 11 through
13, an ordinary-v1 path records 10 through 12, and an overflow-v2 path records 9 through 11.
Counting the unique genesis request in `n` is mandatory.

Neither widens the loader. Version 1 remains read-only zero-anchor compatibility; the parent
phase/fence record encodes the settlement identity first and settlement schema version 2
immediately after it, while a legacy settlement-bearing phase/fence v1 selects only settlement v1.
Each recovery-owned `abandoned` checkpoint must carry the exact authenticated
pre-fence producer subset, including empty, and no other abandoned checkpoint may omit an expected
producer. Post-fence fact drift must use the same fence and a superseded checkpoint
projection; all ordinary and cursor interrupted publication shapes must retain a forward path, and
an ambiguous attestation submission must never retry. Every interrupted candidate must
prove its exact pre-comment locator attestation, terminal writer job, locator-free record
projection, deterministic ordering, and
duplicate rejection; its fixed anchor-attestation publication step must have its mapped exact name,
provider-visible number, and conclusion `skipped`. An optional
post-comment anchor must remain unattested and its digest must hash the sole canonical
artifact-anchor file rather than the provider archive. Any attempted or unknown attestation step or
other mismatch produces no record or effect. The implementation must freeze the overflow-v2 writer
topology with locator read/prepare, upload, attestation, and download/verification at YAML ordinals
3 through 6, comment publication and anchor upload at 7 and 8, and anchor attestation at ordinal
9/provider-visible step 10 for every lane. It must retain the historical no-locator topology's
ordinal-5/provider-step-6 mapping and select exactly one from the record-bound protected commit and
loaded ordered writer topology, never from record schema alone. The interrupted-publication
settlement and its immediate recovery checkpoint must authenticate their frozen generation and
authorized recovery target against the historical predecessor/orphan, bind the settlement's
twice-stable current source observation, and remain valid after later current-fact drift without
granting an effect.
Immediately before direct v4 publication, two equal current source observations must still match
the frozen open generation and the claim must encode the final identity plus its command-specific
cursor recovery authorization and target identities. The v4 claim and immediate checkpoint must
retain that frozen generation, both cursor identities through the v4 predecessor, exact
observation, and immutable predecessor/member bindings under ADR-0011's direct-cursor
authentication projection.
Later current-fact drift, including drift before checkpoint publication, cannot stale either
null-effect record; an immutable mismatch or unavailable final read remains blocked.
The overflow path adds no account, App, PAT, broker,
database, hosted service, dependency, second credential, lifecycle authority, or merge authority.
Issue #55 remains
the sole signed activation owner and must keep policy status `disabled` until the complete positive
and hostile complement is green on protected `dev`.

Before that activation, the separate accepted defect issue required by decision #170 is expressly
authorized to append only issue #52's exact null-effect version-2 checkpoint after its complete
effect-disabled implementation and hostile complement are green. It owns no other issue content or
lifecycle effect, and its pull request to `dev` remains human-only.

The activation probe authenticates the exact bot user, GitHub Actions App ID `15368`, protected
workflow path/ref/commit, run, attempt, job, result, and a post-publication GitHub-native
attestation over an immutable anchor binding provider comment ID, exact body digest, record digest,
and run. It proves exact per-issue anchors, checkpoint rollover, normal two-page loading,
effect-disabled cursor recovery with exact accumulator root, resume, page-order, count, and cursor
discontinuity fixtures, empty-history bootstrap, every pre-checkpoint crash outcome, missing-suffix
detection, strict full-body parsing, exact predecessor chains, one shared per-issue `queue: max`
domain and fence, the repository-wide provider-budget group, the ordinary-v1-root 112-request pass
including up to three exact producer-job reads, the overflow-v2-root's exact six
locator-authentication calls that make each pass 118 requests, the mandatory two stable passes 236
requests, the existing 14 write/read-back calls, and the resulting hard 250-request ceiling, plus
the separate overflow request-200 ceiling, stable
double-reads, same-generation producer results, explicit crash recovery, and no retry after
ambiguity. Deleted, edited, duplicated, conflicting, truncated, stale, wrong-generation,
wrong-producer, rate-limited, or unavailable record evidence must fail closed.

Bootstrap fixtures prove the exact sequence-one null-root compacted-prefix preimage and ordered
genesis members. Crash fixtures prove the request-bound forward orphan settlement accepts only an
unchanged canonical comment from an independently verified failed protected writer run with stable
zero-or-one anchor and zero attestation counts plus a `skipped` publication step, authenticates its
own version-2 settlement record, and quarantines the orphan without trusting it. Version 1 remains
read-only zero-anchor compatibility. Wrong authorization, changed or missing facts, a successful
run, multiple anchors, any attestation, multiple orphans, and settlement-publication failure must
remain effect-disabled.

Publication proof loads the exact candidate commit, requires a complete recursive Git tree with
`truncated === false`, and verifies exact regular-file path, mode, blob object, byte count, and
SHA-256 equality through a stable reread. The pull-request files API is not complete tree authority,
so pull-request file metadata alone cannot satisfy this proof.

ADR-0010 assigns Issue #50 only the inert guard, protected policy/status producer, hermetic proof,
and corrected v2 live-probe harness. The canonical `status: ready for human review` state cannot
truthfully exist as merge authority before the signed Contract-as-Code activation. The guarded
operation is therefore unavailable before activation and makes no provider merge request. Issue #55
owns this human-gated activation and, after the lifecycle and protected policy are active, the
first exact-target success plus the complete live denial, race, ambiguity, redaction, and
reconciliation matrix.

Protected `dev` is the sole policy source and derives exactly three availability states. `disabled`
before activation makes no provider merge request. `probe-only` immediately after activation
permits effects solely for Issue #55's frozen disposable-probe manifest and exact issue, pull
request, target, head, base, request, and operation identities. `enabled` requires protected
Contract-as-Code to consume an expected-producer exact-head live-proof receipt and status bound to
the signed activation commit, frozen manifest, and complete successfully settled matrix. That
evidence is consumed input, not independent authority. Missing, stale, failed, wrong-producer,
mismatched, incomplete, or ambiguous evidence remains `probe-only` or `disabled`; no caller input
or repository variable promotes it.

Record the issue, pull request, exact head, actor, result, and timestamp for each probe:

Before activation, create an accepted event on a disposable issue and let the protected
`lifecycle-wakeup.yml` caller advance the closed coordinator and producer chain over successive
wakes or scheduled reconciliations. Require GitHub-Actions-authored, anchored, and attested
generation, fence, producer, and `planned` transition/read-back records bound to the exact source,
target, request digest, protected run, and timestamp, and prove the issue's lifecycle label is
unchanged. Replay a wake, change authenticated provider facts, use a stale or excluded source, post
a malformed or unauthorized recovery command, and attempt to inject producer policy through the
caller; each case must fail closed without a lifecycle or branch effect. A copied, human-authored,
malformed, unanchored, unattested, or raw-content observation has no replay or transition
authority. The retained record contains no request reason, issue body, provider body, endpoint, or
credential-shaped value.

1. An incomplete template cannot retain `status: ready`; a complete template can, and receives a
   GitHub-Actions-authored readiness record.
2. A copied or human-authored readiness marker has no authority.
3. An incomplete draft pull request receives failing `PR contract` evidence; a fully settled pull
   request receives both required contract statuses on its exact head.
4. Editing the accepted issue title or semantic body, closing it, changing its type, or removing
   readiness changes `Issue contract current` to failure on every linked open pull request.
5. Restoring issue readiness does not restore a pull request until its contract and evidence pass
   again.
6. A wrong source issue number, delivery target, readiness URL, contract version, or stale head
   fails closed.
7. After activation, a guarded-operation probe using the existing authenticated maintainer
   credential merges one fully green child-issue pull request to its exact accepted `epic/**`
   target, rejects `dev`, wrong, stale, replayed, and concurrent requests before mutation, and
   durably persists its compare-and-set claim before making at most one merge call that passes the
   exact revalidated head SHA as `sha` with `merge_method: squash`; verifies the exact target tip is
   the reported squash commit, its sole parent is the observed base, and its tree equals the
   observed head tree; and proves an ambiguous claim remains blocked with no retry or provider
   auto-merge until explicit human reconciliation. In the disposable live probe, race two distinct
   child-issue pull requests against the same exact accepted target and observed current base and
   prove only one reaches provider submission. Also prove that concurrent callers with distinct
   request identities cannot partition the serialization key. GitHub attribution cannot
   distinguish this agent operation from a human action; the evidence must state that limitation
   rather than claiming identity isolation. Advance the base after green evidence and prove that
   the base advance invalidates eligibility and rejects the merge before the guarded effect;
   eligibility requires fresh evidence against the new base. Create every disposable
   provider-assigned parent issue before deriving its `epic/**` target, use a separate parent and
   target for the stale-base case, and read every prohibited target's actual tip before and after
   denial. Treat an absent `main` ref as denial evidence and never create `main` for the probe.
8. Niko or Oscharko can manually merge a fully green `dev` pull request after reviewing the exact
   head; no separate non-author approval is required.

Activate a status context as required only after the same producer has demonstrated both a failing
negative case and a successful current-head case. Retain the probe links as the activation record.

## Pending contract-publication controls

Contract publication remains disabled. The inert workflow checks out only protected `dev` with
non-persistent credentials and requests read-only contents access. Its activation variable remains
unset, and its only permitted commands are syntax checks. It does not check out or execute
pull-request content. The `Contract publication` context is not enrolled as required.

Before a human activates publication, complete ADR-0003's negative and positive lane probes,
authenticate the expected producer, prove exact-head and merge-group emission, and verify the
signed receipt, isolated merge, actor, ancestry, tree, and exact-byte evidence. Activation must be
a separate accepted change; do not turn the inert job on or add its context from this baseline.

## Pending merge-queue and epic-merge controls

The merge queue remains disabled until its human liveness and ordering probe passes. The inert
merge-group workflow checks out only protected `dev` with non-persistent credentials, requests
read-only contents access, is gated by an unset activation variable, and permits only syntax-check
commands. It never executes constituent content.

Automated epic-branch merge remains disabled before the signed Contract-as-Code activation. After
activation, it remains `probe-only` and unavailable for general child delivery until protected
Contract-as-Code consumes Issue #55's expected-producer exact-head receipt and status proving
complete pagination, stable reads, exact-target denials, expected-head rejection, at-most-once
submission, redaction, and exact parent and outcome evidence live, all bound to the signed
activation commit and frozen disposable manifest. An unavailable, ambiguous, weak, stale,
wrong-producer, or failed capability remains `probe-only` or `disabled` and selects human-only child
integration; an ambiguous result causes no retry and must not enable provider auto-merge. Enrolling
merge-group contexts, configuring the queue, or enabling either inert job requires a separate
accepted human activation change.
