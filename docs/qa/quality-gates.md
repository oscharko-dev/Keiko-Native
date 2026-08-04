# Keiko Native quality gates

## Standard and enforcement

`docs/engineering/code-quality-standard.md` defines the engineering properties that must be planned
at epic and issue creation and understood before implementation. The gates in this document provide
deterministic and independent compliance evidence. Passing a gate does not excuse a missing issue
Quality Plan, an untested changed behavior, or a violated architecture or trust boundary.
Manual label, ruleset, identity, provider, and live-probe sequencing follows
[`repository-activation.md`](repository-activation.md).
The guarded child-to-epic implementation, durable settlement rules, and reconciliation procedure
are specified in [`guarded-epic-merge.md`](guarded-epic-merge.md).

## Required exact-head checks

`dev` protection is activated only after a live pull request proves that every context below is
emitted by its expected producer on the exact current head:

1. `PR contract` — GitHub Actions (App ID `15368`)
2. `Issue contract current` — GitHub Actions (App ID `15368`)
3. `ci` — GitHub Actions (App ID `15368`)
4. `actionlint` — GitHub Actions (App ID `15368`)
5. `Verify pinned action SHAs` — GitHub Actions (App ID `15368`)
6. `zizmor` — GitHub Actions (App ID `15368`)
7. `Analyze (actions)` — GitHub Actions (App ID `15368`)
8. `Analyze (javascript-typescript)` — GitHub Actions (App ID `15368`)
9. `Build, scan, SBOM, smoke` — GitHub Actions (App ID `15368`)
10. `Review dependency diff (dev/main)` — GitHub Actions (App ID `15368`)
11. `native` — GitHub Actions (App ID `15368`)
12. `Scan dependency lockfiles` — GitHub Actions (App ID `15368`)
13. `SonarCloud Code Analysis` — SonarQube Cloud (App ID `12526`)
14. `Socket Security: Project Report` — Socket Security (App ID `156372`)
15. `Socket Security: Pull Request Alerts` — Socket Security (App ID `156372`)

Protection uses strict current-branch checks, administrator enforcement, signed commits, linear
history, resolved conversations, no force pushes, and no branch deletion. A same-named check from a
different App ID does not satisfy the policy.

Pull-request workflows emit their applicable checks for both `dev` and `epic/**` targets. The full
set above applies to `dev`. CI-based SonarQube Cloud analysis and its provider context are selected
only for pull requests targeting `dev`, pushes to `dev`, and manual dispatches bound exactly to
`dev`. Repository coverage remains unconditional. Epic pull requests and pushes retain all
applicable deterministic, security, dependency, contract, native, and platform checks without
requesting unavailable non-main Sonar branch data. The final epic pull request into `dev` remains
subject to the complete required exact-head set above, including integrated Sonar and epic
acceptance.

For user-facing changes, required status includes the machine-executable Acceptance Journey rows
declared by the issue. A draft pull request may be used to obtain remote and authoritative-platform
evidence. Missing journey automation, required manual observations, or platform evidence blocks
`Ready for Human Review` and merge even when unrelated checks are green.

The privileged metadata workflow loads its validator only from protected `dev`; it never checks out,
installs, imports, or executes pull-request or epic-branch content. It checks the current issue
label, planning-contract version and fingerprint, automated readiness record, source and target
branches, acceptance and journey evidence, quality settlement, and delivery attestations. It then
publishes `PR contract` and `Issue contract current` directly on the exact pull-request head. Draft
pull requests may remain red while remote evidence is collected; both contexts must pass before
handoff or merge. Closing or semantically changing the accepted issue, changing its type, or
removing readiness changes `Issue contract current` to failure on every linked open pull-request
head. Restoring issue readiness does not restore those pull requests; their updated contract and
evidence must pass again. Readiness records are accepted only from the canonical GitHub Actions bot
identity; copied or user-authored marker comments have no authority.

ADR-0011 applies the same protected producer model to lifecycle handoff records. Authentication
requires the exact built-in bot user, GitHub Actions App ID `15368`, expected protected workflow
path, `refs/heads/dev`, workflow commit, run, attempt, job, result, canonical generation, current
fence, predecessor chain, and a cryptographically verified post-publication GitHub-native
attestation over an immutable anchor binding the provider comment ID, exact body digest, record
digest, and protected writer run. An exact-name per-issue anchor detects an unreferenced suffix
deletion. Attested transition/read-back checkpoints bound the effect-capable live suffix to 15
records, and effect-disabled cursor recovery handles deeper comment history through exact
domain-separated accumulator root and resumed-step identities. A login, marker, author
association, context name, details URL, or event timing alone is never sufficient.

Sequence-one bootstrap proves the exact compacted-prefix domain, schema, null prior-checkpoint
identity, and complete ordered genesis member list. Forward orphan settlement requires a
request-bound recovery-target digest, version-first recovery-settlement parsing, an independently
verified failed protected writer run, stable zero-or-one-anchor/zero-attestation reads with a
mapped exact-name and provider-visible-number attestation step whose conclusion is `skipped`, and a
version-2 settlement claim authenticated through the closed historical recovery projection and
chained from the last authenticated predecessor.
The phase/fence parent encodes the settlement identity first and then settlement schema version 2
immediately after it; version 1 remains read-only zero-anchor compatibility and is selected only by
a legacy settlement-bearing phase/fence v1 parent. The
orphan never becomes a record or authority source.

Generation-request, producer-result, ordinary phase/fence-claim, and ordinary transition/read-back
records use strict version-1 canonical bytes and domain-separated SHA-256 digests. The loader
performs full-body parsing, bounded complete pagination, and stable double-reads. Deletion, edits,
forks, cycles, gaps, conflicts, truncation, wrong producer/generation/fence, or unavailable evidence
fail closed.
Protected producers independently recompute the generation and evaluate only their owned predicate;
they cannot choose lifecycle lane, target, activation, transition, or merge authority.

At the record-type level, there are exactly four schema-version exceptions: the exact
recovery-settlement phase/fence uses version 2 of its existing type, the overflow checkpoint uses
version 2 of its existing type, the historical incomplete cursor phase/fence claim uses read-only
version 3 of its existing type, and the exact complete cursor-recovery phase/fence claim uses
version 4 of its existing type. None creates a fifth record type. The auxiliary
recovery-settlement identity separately retains its accepted version-1 zero-anchor schema and uses
an exact version-2 schema for every new settlement; parser dispatch is version-first and never
reinterprets legacy bytes. The deterministic gate must prove the exact
direct plain-issue command and authorization identity, exact target over 16 authenticated records,
normal rejection at record 16, overflow rejection at record 17, rejection of checkpoint plus 16,
the exact 108 + 60 + 6 + 26 request-200 success arithmetic, request-201 denial, stable double-read,
replay no-op, append-only evidence, null effect, and exact checkpoint read-back through the actual
provider's subject-qualified attestation requests. Each returned response carries its bundles; no
invented bulk or bundle-download endpoint is permitted. Every archive must count both the
authenticated artifact request and redirect response. The 108-request first pass downloads at most
24 archives into bounded canonical-byte buffers; the 60-request second pass reuses only those
immutable bytes while independently rereading every comment, artifact identity/metadata,
attestation, full job/step projection, and current fact. It must
prove that this effect-disabled exact-target profile replaces independent workflow-run and
referenced-workflow-inventory requests only with verified protected caller/writer attestation
claims plus an exact bound job and complete step projection only where the record encodes a job.
Successful coordinator records instead require a unique artifact-anchor attestation binding the
exact caller, reusable writer, record, run, attempt, and SHA. Ordinary authentication retains the
provider run and inventory reads. It must
prove a hard cap of four historical interrupted candidate comment copies present before the current
attempt. Every byte-identical copy is authenticated before grouping and consumes one request-budget
slot; a fifth historical copy fails closed with no record or effect. The current attempt's single
prospective checkpoint comment is excluded from the historical cap only while it is the current
publication and uses the separate 26-request publication budget. It becomes the authenticated record
on success; if authentication is interrupted, it becomes a historical candidate on the next
recovery, where a resulting fifth historical copy denies another attempt. Each historical copy's
distinct comment-bound anchor and attestation tuple must be verified before it may become
irrelevant, and the
target remains unconsumed until full authentication. It must also prove every interrupted candidate
has one valid pre-comment locator attestation for the protected writer
run and terminal job, an exact locator-free candidate-record projection, deterministic member
ordering, and no duplicate canonical identity while its optional post-comment anchor has no
attestation and the fixed anchor-attestation publication step has its exact mapped name,
provider-visible number, and conclusion `skipped`. An attempted, unknown,
or ambiguously completed attestation step must deny retry even when both inventories are empty. The
gate must prove the overflow target is supported only when all 16 base record comments are present
in the same stable two-page first-pass window. A base record outside or missing from that window is
unsupported and must fail closed with no recovery, record, or effect; anchors must not widen the
window or authorize exact-ID fetches.

The gate must also prove the sole post-success replay shadows rule: the stable two-page normal
loader buffers at most four exact Actions Bot/App, never-edited comments with a higher numeric `comment_id`
than one fully authenticated overflow transition/read-back v2 checkpoint and byte-identical full
bodies. After that lower-ID checkpoint authenticates, normal reconstruction reproducibly marks the
shadows irrelevant with no additional provider requests; they are not records, predecessors,
recovery candidates, target consumption, or authority. A fifth shadow, a body, actor, edit, or
numeric-order mismatch or multiple groups fails closed. If the two normal pages prove that older
relevant history continues, the loader must carry the same at-most-four buffered shadows into
ordinary effect-disabled cursor recovery as `irrelevant` recovery-suffix members. Both the
initial/normal pages and every cursor-resumed page may discover replay shadows. One body group and
four total apply across the
entire accumulator. Their classification is provisional and grants no independent standing. Every
resumed step must validate the cumulative group and count before adding its page. A single
serialized recovery invocation must keep the authenticated cumulative summary and every full
`recovery-suffix-member` preimage, including ordinary irrelevant comments, in memory across its
twice-stable pages. The gate must distinguish three root branches. An
overflow-v2-checkpoint-rooted invocation authenticates the lower-ID v2 checkpoint and greater
shadow-ID relationship. An ordinary-v1-checkpoint-rooted invocation authenticates the v1
checkpoint, requires a null shadow digest and empty shadow-ID list, and accepts no provisional
shadow. A unique-genesis-rooted invocation requires the same empty-shadow facts and authenticates
the complete genesis suffix directly. Both cursor-interruption settlements must repeat the same
root-specific proof. Only then may one phase/fence claim v4 persist its non-null
`cursor_recovery_authorization_comment_id`, `cursor_recovery_authorization_identity`, and
`cursor_recovery_target_identity`, complete at-most-15 live record members, shadow summary, and
exact shadow comment IDs. The gate must prove the comment ID is the bounded locator for the
command-specific authenticated maintainer request, the first identity is its canonical identity,
and the second is its exact incomplete-scan target, none inferred from the inherited generation
request. The gate must prove
the target from the stable historical prefix ending strictly before the exact command comment ID;
the command and later comments are excluded, and the existing stable direct-ingress reads reproduce
the original boundary without another provider request. It must
publish no intermediate cursor or progress claim. The final claim and immediate checkpoint require
two through 10 live records including the unique-genesis request, one through 9 after an ordinary-v1
root, or one through 8 after an overflow-v2 root, forming one internally valid open generation that
begins with its authenticated
generation request and contains no terminal claim or checkpoint. The direct
recovery-owned `abandoned` checkpoint carries exactly the authenticated same-generation producer
subset present before v4, including empty, retains every included result's original producer-owning
fence, and permits no producer after v4. A unique-genesis root alone or a checkpoint root with zero
later live records authenticates the root and replay-shadow relation but is a no-op with no v4
claim, checkpoint, record, or effect. Any larger, reserved, or differently shaped open suffix uses
its exact existing recovery path or fails closed.
The gate must prove that v4 alone does not consume the cursor target. Only the fully authenticated
direct checkpoint or settlement-following recovery checkpoint consumes it. An interruption permits
a fresh command for the still-unconsumed target; its settlement binds that fresh request while
treating the v4 authorization comment ID only as a locator, repeating six-request exact-comment
authentication of the original command, and requiring the recomputed identity to equal v4 before
the orphan/predecessor proof retains the original authorization and target. The gate must prove the
settlement target comes only from the authenticated original v4 claim, never from the fresh command
cutoff; that cutoff is only the fresh command's ingress-authentication boundary.

The gate must enforce a hard cap of 3 accumulator pages, three closed root-authentication branches,
and two budget profiles. At most 6
comment-page requests cover two stable reads of each page in the one invocation. A unique-genesis
or ordinary-v1 root permits at most twelve record/root/orphan tuples. Its 64 base authentication
calls plus two independently reserved stable exact cursor-orphan writer-job/skipped-step reads and
six original-command reauthentication calls, 26 current-provider calls, and 28 publication calls
form a 126-call core and 146 total calls with pages and the fixed 14 ingress calls. An overflow-v2
root admits at most eight post-root live records and eleven tuples. Its base authentication uses one
artifact list, 22 artifact-download redirect-chain calls, 11 subject-qualified attestation
inventories, 22 workflow-run and referenced-workflow-inventory calls, and at most three exact
producer-job calls; the root's six locator-verification calls, two stable cursor-orphan writer-job
reads, and six original-command reauthentication calls make 73 authentication calls. With the same
26 current-provider and 28 publication calls, that is a 127-call core and 147 total calls. The fresh
ingress authorization bytes are reused, but the original command is independently reauthenticated
from the v4 locator. Both profiles remain within the hard 150-request
ceiling. A fifth shadow, any mismatch or discontinuity, cursor exhaustion, page 4, or missing
authenticated root must produce no complete accumulator, checkpoint, or effect. The classification
adds no request outside that closed allocation, initiates no cursor recovery, and changes no
15-record bound, target consumption, or authority.

The gate must require every legacy phase/fence claim v1 cursor record, whether incomplete or
complete, to have phase `recovery` and `claim_outcome` exactly `claimed`; every other v1 cursor
outcome is malformed. It must treat those accepted records and legacy incomplete v3 cursor records
as read-only compatibility and prohibit resume or migration.
Every new cursor completion must use v4. The gate must prove the frozen pre-activation
inventory is not limited to Issue #55's disposable-probe manifest. The frozen maximum issue number
comes from two stable repository observations, and the inventory classifies every canonical issue
number from 1 through that maximum as an issue, pull request, or missing resource. It scans every
issue's complete bounded 3-page history and retains the other classifications as negative evidence.
Page 4, instability, or an unclassified number makes the inventory incomplete. Zero v1
recovery-scan claims with a non-null recovery-scan identity, whether incomplete or complete, and
zero v3 cursor claims across that complete inventory is an exact activation precondition. Any
discovery must fail closed, block activation, retain all evidence, and require a separately governed
exact-target human reconciliation issue before any settlement; no boundary, summary, or cursor may
be inferred.

Before activation, the gate must prove every pre-amendment protected writer run loaded from an
older `dev` SHA is terminal. The Issue #55 activation operation must then acquire and hold the
existing repository-wide `issue-lifecycle-provider-budget` serialization group, perform one final
complete-inventory revalidation while holding that group, and retain it until the authenticated
activation receipt is durable. A queued or in-progress pre-amendment writer, inventory drift, or
unavailable read must block activation. Every writer admitted after the receipt must load the
accepted activation commit and be unable to emit a v1 or v3 cursor scan claim; every new cursor
completion must use v4.

The gate must pin the overflow-v2 issue-lifecycle topology: locator read/prepare, upload,
attestation, and download/verification at YAML ordinals 3 through 6, comment publication and anchor
upload at 7 and 8, and anchor attestation at ordinal 9/provider-visible step 10 for every lane. It
must
separately retain the historical topology's ordinal-5/provider-step-6 mapping and select exactly one
closed mapping from the record-bound protected commit and loaded ordered writer topology, never from
record schema alone or by probing. The 26-request publication matrix must download and reproduce the
locator before comment creation and download and reproduce the final anchor before success. The
locator-attestation digest must be the
canonical auxiliary identity over normalized verified claims, never a hash of provider bundle
serialization. A non-null optional-anchor digest
must hash the downloaded sole canonical artifact-anchor file, equal its auxiliary identity, and
never hash the provider archive. Every ordinary superseded fence authenticates its frozen
generation, the exact partial producer subset already present, and its first superseding witness.
For the reserved-fence exception, the final stable encoded read-back source observation is the sole
durable superseding witness under that same fence. Its ordinary v1 checkpoint fixes owner `invalidation`, outcome
`superseded`, reason `superseded`, and null effect. The normal writer's three-record terminalization
reserve rejects a nonterminal append at 12, places the terminal fence at record 13, permits its
immediate checkpoint or the exact version-2 skipped-attestation checkpoint-orphan settlement at
record 14, and after that settlement permits only the recovery-owned null-effect checkpoint at
record 15. If fence publication is interrupted, the exact version-2 fence-orphan settlement is
record 13 and only its recovery-owned checkpoint may follow at record 14. The exact complete
cursor-recovery v4 claim defines `n` as the authenticated live non-checkpoint suffix cardinality
from two through 10 including the unique-genesis generation request, from one through 9 after an
ordinary-v1 root, or from one through 8 after an overflow-v2 root, for one internally valid open
generation that begins with its authenticated
generation request and contains no terminal claim or checkpoint. It is record `n + 1` and must be
followed immediately by its checkpoint at record `n + 2`. That direct recovery-owned `abandoned`
checkpoint carries exactly the authenticated same-generation producer subset present before v4,
including empty, and retains each result's original producer-owning fence; no producer may publish
after v4. A unique-genesis root alone (`n = 1`) or checkpoint root with no later live record
(`n = 0`) is a no-op with no v4 claim, checkpoint, record, or effect.
An interrupted unanchored v4 instead uses its exact version-2 cursor-claim
settlement at record `n + 1`, followed only by the recovery-owned checkpoint at record `n + 2`.
After an
authenticated cursor-recovery v4 at record `n + 1`, an interrupted unanchored cursor-recovery
checkpoint uses its exact version-2 cursor-checkpoint settlement at record `n + 2`, followed only by
the recovery-owned checkpoint at record `n + 3`. At the maxima, a unique-genesis path uses at most
records 11 through 13, an ordinary-v1 path records 10 through 12, and an overflow-v2 path records 9
through 11. Counting the unique genesis request in `n` is mandatory. Neither widens the loader. The
gate must prove that
each resulting recovery-owned `abandoned` checkpoint carries exactly the authenticated pre-fence
producer subset, including empty, while every other abandoned checkpoint requires the complete
expected set; that the parent phase/fence record's encoded version selects settlement v2; and that
the settlement and immediate checkpoint bind the frozen generation and authorized recovery target,
encode one twice-stable current source observation, remain authenticated across later current-fact
drift, and never rebind to a new current generation. It must also prove that post-fence fact drift
uses the same reserved fence and superseded checkpoint projection, all ordinary and cursor
interrupted publication shapes have a forward path, ambiguous attestation submission never retries,
and checkpoint plus 16
is unreachable. A later fact change cannot stale an exactly attested
null-effect checkpoint, which then terminalizes as a checkpoint before a successor generation.
Hostile wrong-actor, edited-command,
wrong-target, missing/changed record, anchor, attestation, run, job, ref, SHA, predecessor,
checkpoint, and provider-unavailable fixtures produce no record or effect. Overflow recovery remains
inert before Issue #55, adds no principal or credential, and remains a human-only manual merge to
`dev`.

The gate must separately prove the direct-cursor projection. Immediately before v4 publication,
two equal current source observations still match the frozen open generation and the claim encodes
the final identity. The exact v4 claim encodes the command-specific cursor recovery authorization
and target identities independently of the inherited generation request; it and the immediate
checkpoint retain that frozen generation, observation, predecessor/member bindings, and
same-generation producer subset. Later current-fact drift, including drift before checkpoint
publication, cannot stale either null-effect record; an immutable mismatch, producer publication
after v4, or unavailable final read remains blocked.

Publication evidence uses the exact candidate commit's complete, non-truncated recursive Git tree
and exact regular-file blob bytes, modes, object IDs, sizes, and SHA-256 digests. The pull-request
files API is not complete tree authority. Candidate-set drift, non-regular entries, malformed blobs,
changed rereads, or unavailable provider evidence fail closed.

Lifecycle requests enter only through ADR-0012's protected top-level wake workflow. Its closed
direct-event, protected-source completion, and hourly schedule resolvers emit only a canonical
issue number and optional exact recovery-comment locator. The caller holds the per-issue lock while
the reusable coordinator reloads current authority and advances one ADR-0011 record obligation.
Only `pr-contract.yml` and `contract-publication.yml` may be called as nested producers, using the
fixed ordered 18-string wire and the same protected `dev` SHA. Neither caller nor callee has
`actions: write`. Before signed Issue #55 activation, only non-applied records are permitted;
lifecycle/status writes, closure, branch, pull-request, queue, and merge effects remain prohibited.

Zizmor's `dangerous-triggers` finding is dispositioned only for the protected PR metadata workflow
and line 3's exact trigger mapping in the protected lifecycle wake caller. The repository contract
enforces their protected-`dev` checkout, fixed scripts, pinned actions, least-privilege permissions,
absence of PR checkout or build commands, exact branch filters, closed event sets, and guarded data
flow. No other workflow or dangerous trigger inherits either exception.

## Merge authority and automation boundary

Green gates establish technical eligibility; they do not authorize an automated actor to merge
into `dev`. Every pull request targeting `dev` stops at `Ready for Human Review` and may be merged
only by a deliberate manual action from an authorized maintainer. The current human allowlist is
limited to Niko and Oscharko. This two-maintainer project does not require approval from a second
person: either maintainer may merge their own pull request after reviewing the linked issue and
pull request on the exact current head.

That final review covers scope, acceptance criteria, the issue Quality Plan, verification and audit
evidence, required and advisory findings, review conversations, and residual risks. Agents must not
merge into `dev`, enable auto-merge, enqueue a merge group, update its ref, or use a human
merge-capable credential for any `dev` effect.

For a fully eligible child-issue pull request, an agent may use the existing authenticated
maintainer credential only through the ADR-0009 guarded operation and only for its exact accepted
`epic/**` target. Epic and standalone pull requests remain human-only deliveries to `dev`.
Immediately before the effect, the guard independently revalidates current issue authority and
`status: ready for human review`, exact source and target refs, applicable exact-head checks,
acceptance and audit evidence, findings, review conversations, stable reads, and replay state. It
persists a durable single-flight compare-and-set claim for target/base serialization before any
provider submission. The target/base serialization
uniqueness key consists only of repository, exact accepted target, and observed current base. The
immutable per-operation record binds issue, contract, readiness, pull request, exact head, and
request identity. Distinct request identities cannot create another serialization claim. Two
distinct child-issue pull requests for the same exact accepted target and observed base contend on
that one key; only one may reach provider submission. It submits at most once with the exact
expected head by passing the exact revalidated head SHA as the provider request's `sha` parameter
and explicitly sends `merge_method: squash`. It never uses provider auto-merge and verifies that
the exact target tip is the reported squash commit, whose sole parent is the observed base and whose
tree equals the observed head tree. Any mismatch, stale or unavailable evidence, failed or skipped
required check, unresolved item, closed issue, changed ref, ambiguous response, or non-exact target
fails closed. An ambiguous claim remains blocked with no retry until explicit human reconciliation
using exact refs, the squash commit, its parent, and the observed trees. A new request identity is
permitted only after explicit terminal settlement or human reconciliation and fresh revalidation.

ADR-0010 stages this boundary behind lifecycle activation. Issue #50 installs only the inert guard,
protected policy/status producer, hermetic proof, and v2 live-probe harness; it performs no live
merge. The canonical `status: ready for human review` state cannot truthfully exist as merge
authority before the signed Contract-as-Code activation. The guarded operation is therefore
unavailable before activation and makes no provider merge request. Issue #55 owns the human-gated
activation and then the first exact-target success plus the complete live denial, race, ambiguity,
redaction, and reconciliation matrix.

Protected `dev` is the sole policy source and derives exactly three availability states. `disabled`
before activation makes no provider merge request. `probe-only` immediately after activation
permits effects solely for Issue #55's frozen disposable-probe manifest and exact issue, pull
request, target, head, base, request, and operation identities. `enabled` requires protected
Contract-as-Code to consume an expected-producer exact-head live-proof receipt and status bound to
the signed activation commit, frozen manifest, and complete successfully settled matrix. That
evidence is consumed input, not independent authority. Missing, stale, failed, wrong-producer,
mismatched, incomplete, or ambiguous evidence remains `probe-only` or `disabled`; no caller input
or repository variable promotes it. The live harness derives each disposable `epic/**` target from
its provider-assigned parent issue, uses a separate parent for stale-base concurrency, reads every
prohibited target's actual tip, and records an absent `main` ref as denial without creating it.

ADR-0011's record protocol is also inert before activation. It adds no account, installed App, PAT,
broker, service, database, application/runtime dependency, or second credential. Its
GitHub-maintained attestation transport is provider composition and must be full-SHA pinned under
the refreshed #51 contract. Before Issue #55, it cannot produce an applied lifecycle, status,
branch, pull-request, queue, or merge result. Issue #55 alone owns activation and disposable live
proof; missing, stale, ambiguous, or wrong-producer record evidence cannot promote availability.
The per-issue and repository-wide provider-budget groups use `queue: max`; a hard local request
counter and fail-closed provider responses, not a racy remaining-quota read, protect the shared
repository token boundary. Normal loading counts two calls for each archive redirect and up to
three exact producer-job reads. An ordinary-v1-root stable pass is 112 requests; an overflow-v2
root adds exactly six locator authentication calls per pass, so the maximum pass is 118 requests,
two passes are 236, and the existing 14 write/read-back calls close the hard ceiling at 250.
Overflow recovery retains its
separate hard-200 ceiling. Until the pinned actionlint release understands GitHub's newer
`concurrency.queue` key, the actionlint job ignores only that exact unknown-key diagnostic; the
repository contract independently requires `queue: max`, rejects `cancel-in-progress`, and keeps
all other actionlint diagnostics active.

This shared identity means GitHub attribution cannot distinguish an agent operation from a
deliberate human action, and repository identity rules cannot technically constrain the credential
to only the guarded effect. The agent policy and guard categorically deny `dev`, `main`,
`release/**`, feature, wrong-epic, direct-ref, provider auto-merge, queue, administration, and
bypass operations. Repository protections remain defense in depth, not a claim of separate
identity. Credential or guard unavailability selects human-only child integration. The accepted
issue, request identity, exact refs, actor, closed provider result, squash commit, parent and tree
identifiers, and post-effect read-back form the sanitized audit trail; credentials and raw provider
bodies never enter evidence. An agent must never merge, enable auto-merge, enqueue, push, or update
`dev`, `main`, or `release/**`, including through the existing authenticated maintainer credential.

## Bootstrap and productive phases

The `native` check validates the versioned project contract. During bootstrap it proves that the
quality control plane is operational and that no undeclared productive source exists. It does not
claim that a native application has already been built.

Before productive code lands, the project manifest and CI must add language- and platform-specific
compilation, unit/integration tests, architecture checks, 85% coverage with reserve, artifact
inventory, SBOM, sandbox/egress tests, package verification, and signing/notarization evidence.
Missing target evidence fails closed.

ADR-0007 closes the Foundation v0.1 internal macOS milestone with unsigned-package evidence, not
public Apple trust. `native:signing` proves that the internal package contract is active and that
Apple credentials are absent. `release:verify` adds exact-head deterministic image, inventory,
SHA-256, SPDX 2.3, mounted copy-out, cleanup, and closed-redaction evidence. Developer ID signing,
notarization, stapling, public delivery, production update signing, and physical Gatekeeper evidence
remain mandatory for a later public release under issue #59; the internal lane does not waive them.

## Epic release acceptance

Before an implementation epic can be handed to `dev`, its final integrated head must satisfy the
Quality Envelope defined by `docs/engineering/code-quality-standard.md`. Green child issues do not
substitute for verification of the assembled capability.

The release-acceptance evidence must:

- cover every in-scope top-level user path and declared Windows or macOS target;
- exercise the actually wired production composition rather than only mocks or fixtures;
- include the applicable failure, recovery, security, accessibility, performance, and resource
  rows declared by the epic;
- be bound to the exact integrated head and expected producer; and
- fail when an automatable claim is backed only by manual notes, screenshots, fixtures, or
  self-reporting.

Manual usability, assistive-technology, visual, signing, notarization, and platform observations may
supplement machine evidence where automation cannot establish the complete claim. They must identify
the tested build, platform, operator, procedure, and result and may not replace an available
deterministic gate.

For the internal macOS lane, `.github/workflows/internal-release.yml` is the authoritative remote
artifact check. It builds on `macos-14`, verifies on `macos-26`, attests only after local
verification, re-verifies attestation after download, and retains the exact-revision artifact for
14 days. It has no tag, release, public upload, environment, Apple secret, or product updater
authority. The complete artifact and failure contract is in
[`internal-macos-release.md`](internal-macos-release.md).

## Advisory independent review

Gitar and `Keiko for Quality` are installed and produce independent evidence but remain outside
branch protection while availability, plan pacing, or self-deadlock can omit a bounded result. A
finding from either product is still actionable. An absent advisory check is an integration
incident, not a product-quality pass or failure.

Promotion to a required gate needs a live negative/positive probe proving exact-head emission,
stable producer identity, bounded settlement, machine-readable evidence, and a repair path that does
not depend on the gate succeeding.

The Claude GitHub App has organization-wide repository access. `CLAUDE.md` delegates to the same
machine-checked `AGENTS.md` contract used by all coding agents, so Claude does not operate under a
parallel or weaker repository policy. Claude is not a required status context because Keiko does
not define a separate Claude CI workflow.

## Local-first rule

Run `npm run quality` and `npm audit --audit-level=high` before the first push. Reproduce remote
findings locally, add a prevention test or contract check, rerun the affected gate, and then rerun
the complete local suite before another push. GitHub is remote-only validation, not the test loop.

The quality control plane uses exactly Node.js 24.18.0 and npm 11.16.0. Root `engines`, npm
`devEngines`, `packageManager`, and the sole `.npmrc` setting (`engine-strict=true`) fail closed on
toolchain drift before installation or scripts. The direct `quality` and `native:dependencies`
entry points also run the dependency-free exact-toolchain checker. Every workflow job that consumes
npm first installs the exact Node distribution through the pinned setup action and verifies its
bundled npm 11.16.0 before any npm command. Workflows do not replace the bundled executable with
Corepack shims. Contract tests reject missing, conditional, reordered, or version-drifted
verification.

Packaged-shell acceptance uses a 30,000 ms functional-liveness watchdog while waiting for the
two-request acknowledgement. This operational bound allows cold macOS/WebKit startup without
turning the harness into a startup-performance assertion; performance-distribution evidence remains
excluded. Once acknowledgement arrives, the independently accepted 5,000 ms normal-shutdown budget
still applies exactly, and each application IPC request remains bounded to 1,000 ms.

Cargo's committed lock is intentionally cross-target, while the declared native deliverable is
only `aarch64-apple-darwin`. Vulnerability workflows therefore derive a transient inventory from
the exact locked Cargo resolve graph filtered to that target, then scan it with the checksum-pinned
OSV 2.3.8 binary together with both npm locks. A closed result validator enforces the repository's
moderate threshold. Missing or unknown severity fails closed unless RustSec classifies every
affected record only as `informational: unmaintained`, supplies no CVSS score or patched range, and
matches the expected schema and source. Mixed, malformed, patched-informational, low, moderate,
high, and critical records remain distinguishable; moderate and above block. GitHub Dependency
Review retains its exact diff, scope, license, and OpenSSF checks; only its platform-blind
vulnerability decision is disabled in favor of the target-aware OSV step in the same read-only job.
No advisory exception, ignore list, warning mode, universal-Cargo-lock scan, or lowered threshold is
permitted.

Dependency Review's license parser cannot represent the SPDX expression
`Apache-2.0 WITH LLVM-exception` even though that expression is already accepted by the
repository-owned dependency policy. The workflow therefore carries one exact package-URL exception,
`pkg:cargo/target-lexicon@0.12.16`, for that already-reviewed locked package. Contract checks reject
removal, version drift, or any additional package exception; the general license allowlist, scope,
OpenSSF, and target-aware vulnerability controls remain unchanged.

Tauri 2.11.5 reaches `urlpattern` 0.3.0 through `tauri-utils` 2.9.3 on macOS arm64. That frozen stack
currently retains five visible RustSec informational-unmaintained signals with no patched version:
`unic-char-property` (RUSTSEC-2025-0081), `unic-char-range` (RUSTSEC-2025-0075), `unic-common`
(RUSTSEC-2025-0080), `unic-ucd-ident` (RUSTSEC-2025-0100), and `unic-ucd-version`
(RUSTSEC-2025-0098). They remain in the uploaded exact-head OSV results and are not advisory
exceptions or claims of zero findings.

The Linux `core-quality` job runs `quality:control`, the portable Node and repository-contract suite
shared with root `quality`. The full root `quality` command then runs every native gate and is
authoritative only on Apple Silicon macOS; `native:package` fails closed on other hosts instead of
emitting or publishing package evidence. Both declared macOS runners execute the complete native
command set, including packaging, with stable Rust, rustfmt, clippy, and the pinned coverage-only
nightly installed by the native matrix. The matrix has a 45-minute job ceiling so the complete
fail-closed chain can finish on either runner; the packaged journey and shutdown operations retain
their independently enforced functional timeouts.

Root coverage runs exactly one test file at a time. Serial execution prevents native filesystem
helper compilers and race fixtures from intermittently contending for shared runner resources. The
custom reporter suppresses pass-event names and emits no arbitrary test identity or failure-message
text. A failure contains only fixed rerun guidance plus failure type and error code selected from
strict closed catalogs; every unknown metadata value becomes `unknown`. Stacks, causes, paths,
payloads, and raw error objects are never emitted. LCOV source paths remain independently validated
as repository-contained paths.

Productive native quality begins with the exact standalone frontend `npm ci` command owned by
`native:dependencies`; install scripts and npm workspace inference are disabled. Each native gate
captures the exact Git tree into a private mode-0700 snapshot and compiles the repository-owned
native filesystem quality helper from the eight expected Git blobs. The runner verifies the source
set, Git-blob IDs, SHA-256 digests, and tree identity before compilation and verifies the sources
again before publishing the private mode-0700 executable. Compiler inputs are inherited read-only
descriptors, including descriptor-bound local headers; mutable source pathnames are never compiler
inputs. Compiler failure, unexpected output, or detected source drift recursively cleans the private
random build root and fails closed.

Node and macOS do not expose descriptor-based process execution (`fexecve`) through the supported
spawn interface. Helper execution therefore trusts the fresh same-user mode-0700 snapshot root,
opens the expected helper without following links, binds its SHA-256 and full file identity, and
checks descriptor-to-name identity immediately before and after pathname spawn. A changed owner,
mode, name, byte digest, or identity fails closed. This boundary excludes a malicious process
already running as the same local account, which can modify another same-user private directory;
defending against that stronger host-compromise model would require a separately approved native
launcher or privilege boundary and is outside the repository quality helper's authority.

On macOS and Linux, that dependency-free POSIX C helper performs mutable dependency, generated
package, evidence, and delivery operations through descriptor-relative traversal. It rejects
symlinked components, non-regular files, replacements, concurrent changes, and root-identity drift.
Writes use exclusive no-follow creation. Existing delivery directories are atomically exchanged
with a fully staged tree (`renameatx_np` on macOS and `renameat2` on Linux); an unavailable atomic
exchange fails closed instead of degrading to a non-atomic replacement. The runner accepts only the
canonical `/var` to `/private/var` macOS system alias during private-root creation and does not
resolve a caller-supplied final root symlink.

The helper copies the installed frontend dependencies into the private snapshot before inventory.
The snapshot requires the npm-ci hidden lock marker, binds it to the committed lock and exact
installed package inventory (including empty or unexpected top-level entries), rejects unexpected
or non-regular inputs, and retains a deterministic digest of every copied dependency byte. It
becomes read-only before the native command starts, and the command never reads the original
`node_modules` after capture. This proves reproducibility of the installed tree used by the gate;
it does not independently reproduce npm registry tarball-integrity verification. That residual
trust remains with the preceding exact npm-ci operation and npm's verification of the committed
integrity records.

The bootstrap quality control plane deliberately keeps third-party execution surface minimal:
Prettier is the only npm development dependency. Markdown policy and LCOV generation are local,
tested Node.js gates, and coverage uses the Node.js 24 test runner with the same 85% floors.
