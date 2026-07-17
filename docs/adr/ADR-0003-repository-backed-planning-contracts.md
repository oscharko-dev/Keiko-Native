# ADR-0003: Repository-backed planning contracts

## Status

Accepted, 2026-07-17.

## Context

The accepted planning contract is currently normalized from mutable issue-provider state. Keiko
needs an immutable, reviewable contract with a digest that can be independently recomputed, while
preserving the existing planning authority and avoiding a readiness-validation cycle.

The alternatives were A, retain and harden issue fingerprints; B, bind a contract to its literal
Git blob object ID; and C, repository-backed Contract-as-Code with a separate SHA-256 digest.
The matrix records raw one-to-five scores; totals are weighted averages.

| Criterion                                               |   Weight |        A |        B |        C |
| ------------------------------------------------------- | -------: | -------: | -------: | -------: |
| Integrity strength and substitution resistance          |      30% |        4 |        2 |        5 |
| Identity/immutability/protected-dev reachability        |      20% |        2 |        4 |        4 |
| Reproducibility/independent verification                |      15% |        4 |        5 |        5 |
| Automatic fail-closed enforcement/no lifecycle deadlock |      20% |        3 |        3 |        4 |
| Migration/review burden/maintainability                 |      15% |        5 |        3 |        3 |
| **Weighted total**                                      | **100%** | **3.55** | **3.20** | **4.30** |

Option B hard-fails regardless of its numerical score. A Git SHA-1 repository cannot make a
literal blob ID meet a SHA-256 planning-contract requirement. Git's hash-function transition does
not change that fact for the repository's current object format.

## Decision

Adopt Option C. An accepted contract is an immutable, add-only Markdown file at:

`docs/contracts/<type>-<issue>-v<version>-r<revision>.md`

Every publication pull request also adds exactly one immutable canonical snapshot receipt at:

`docs/contracts/publications/pr-<pull-request-number>.md`

The receipt uses a deterministic repository-owned schema and records the target, canonical pull
request number, affected issue number/type/version/revision, normalized title/body fingerprint,
open/closed state, observed lifecycle labels, exact accepted-readiness record identity or explicit
`none`, candidate path/digest/mode set, authoritative predecessor, complete quarantine-recovery set,
and terminal-manifest path/digest or explicit `none`. It contains no raw issue body. The publication
validator requires the live observations to equal the receipt before queue acceptance. Because the
receipt is committed before enrollment, it is the durable semantic snapshot; mutable check output
is not.

Its contract identifier is SHA-256 of the exact committed blob bytes, with no normalization,
rendering, line-ending conversion, or API representation substituted for those bytes. The
publishing commit is signed and its signed commit payload contains exactly one trailer for every
contract published by that commit plus exactly one snapshot-receipt trailer:

`Keiko-Contract-SHA256: <digest> <path>`

`Keiko-Publication-Snapshot-SHA256: <digest> <path>`

Trailers are sorted lexicographically by path. Verification recomputes SHA-256 from the exact blob
bytes at the contract path in the publishing commit tree, matches that digest and path to exactly
one signed trailer, rejects missing, duplicate, or conflicting trailers for a path or digest, and
requires exact set equality between normalized signed contract trailers and the receipt-attributed
regular contract blobs introduced by the canonical publication pull request. It separately matches
the snapshot trailer to that pull request's sole receipt. It fails closed on every API, parsing,
object, signature, ancestry, attribution, or tree-validation error. It must require all of the
following:

- `.commit.verification.verified === true` and `.commit.verification.reason === "valid"` in the
  GitHub REST commit payload;
- the signed payload contains exactly one matching required trailer per contract and no missing,
  duplicate, or conflicting trailer for its path or digest;
- the normalized contract-trailer set equals the candidate path/digest/mode set in the canonical
  publication pull request's snapshot receipt, rejecting every unexpected trailer, every attributed
  contract without a trailer, and every claimed path not newly added by that constituent;
- the normalized snapshot trailer equals the exact receipt path and SHA-256, and the receipt's
  observations, candidate set, predecessor, recovery set, and manifest binding are internally
  consistent and matched the trusted provider evidence at queue acceptance;
- in the publishing commit tree, the contract path resolves to the exact blob bytes whose SHA-256
  equals the matching trailer digest, and in the current `dev` tree that path resolves to a regular
  blob with identical exact bytes, SHA-256, and mode where mode is applicable; and
- the publishing commit is an ancestor of protected `dev`.

The publication identity is a canonical publication pull request, its signed snapshot receipt, its
isolated exact merge commit, and a GitHub commit signature satisfying the verification rule above.
The pull request's `merged_by` actor must be an authorized maintainer in the current AGENTS.md
allowlist. The GitHub web-flow signer is the identity represented by the commit signature; the human
merge actor is `merged_by`; they are separate facts and both are required. Missing, unavailable, or
contradictory pull-request, receipt, actor, merge-commit, or signature evidence fails closed.

Revisions and publication attempts are append-only. A semantic change increments `v` and normally
starts at `r1`; a wording-only correction or a retry after a quarantined publication attempt keeps
the semantic version and increments `r`. Every successfully published contract except the first has
exactly one immediate authoritative predecessor, and its `Supersedes` declaration binds that
predecessor's exact path and SHA-256 digest. Successfully published contracts form one unique,
acyclic, linear issue-wide chain with no forks, duplicate predecessors, or cycles. Revision gaps are
valid only when every consumed revision is a verified quarantined publication attempt.

Post-merge verification has exactly three states:

- **authoritative** — every required publication fact is available and valid;
- **indeterminate** — evidence is unavailable, transient, malformed, permission-denied,
  rate-limited, or inconsistent; the issue remains non-ready and verification retries the same
  immutable path and revision; and
- **quarantined** — a reproducible contradiction in immutable publication evidence is established.

Only the third state consumes a revision permanently. The verifier must derive quarantine
deterministically from the protected-`dev` commit, tree, and bytes or from a stable contradictory
identity field returned by successful repeatable API reads. Workflow failure, API unavailability,
and issue comments can never select quarantine. A quarantined candidate is never an authoritative
contract, predecessor, terminal candidate, or valid issue pointer. A retry uses a higher revision
and contains sorted `Recovers-Publication` declarations that bind the exact path and SHA-256 of every
quarantined attempt for that semantic version since the last authoritative contract. Missing,
unexpected, duplicate, or conflicting recovery declarations reject the retry. Repeated quarantines
accumulate in that complete recovery set. The retry still supersedes the last successfully published
authoritative contract, if one exists. This preserves a single authoritative chain while making
deterministic post-merge failure forward-recoverable without mutation or deletion. The sole highest
terminal node of the successfully published chain is authoritative. The issue pointer only echoes
that node and must equal it; it never selects authority.

The issue body and comments do not become a second authority. The issue holds a pointer to the
authoritative repository contract and operational evidence only.

Contract publication uses a narrow, dedicated pull-request lane: it may change only add-only
contract entries and exactly one matching snapshot receipt under `docs/contracts/`. Its validator is
loaded from protected `dev`, never executes content from the publication PR, and its signed merge is
human-only. Publication-lane selection is not a pull-request-authored flag. The trusted validator
selects it only when complete GitHub API diff metadata for the exact head reports one or more newly
added regular contract files plus the sole receipt and no other path or change type. A modification,
deletion, rename, copy, symlink, submodule, mixed path, duplicate receipt, truncated diff, or
unavailable API response fails closed instead of selecting the lane.

Before activation, add `Contract publication` to the protected-`dev` required exact-head contexts,
with the same trusted GitHub Actions App producer as `PR contract` and `Issue contract current`.
The protected-`dev` metadata workflow always emits all three contexts and applies this mutually
exclusive result matrix:

| Pull-request class                 | `PR contract`                                         | `Issue contract current`                                                          | `Contract publication`                      |
| ---------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------- |
| Normal delivery                    | Existing ready-issue and pull-request validation      | Existing current-readiness validation                                             | Success: publication not applicable         |
| Canonical contract publication     | Success only when the publication validation succeeds | Success only when the publication validation succeeds; no readiness claim is made | Validate every candidate and affected issue |
| Invalid, ambiguous, or mixed scope | Failure                                               | Failure                                                                           | Failure                                     |

Repository administrators must also require the protected-`dev` merge queue and configure every
required workflow for `merge_group` checks. GitHub may build a later queue entry with pull requests
ahead of it, so build-group settings are not an isolation control. Administrators configure the
queue's maximum pull requests merged into the base at one; this isolates final `dev` commits but does
not reduce the cumulative build groups that still require full validation. Only an allowlisted
maintainer may deliberately select **Merge when ready**; agents never enqueue a `dev` pull request or
enable auto-merge. The three metadata contexts and every other required context run again on the
merge-group SHA.

The trusted validator reloads from protected `dev`, obtains the ordered group membership and each
constituent pull request from trusted provider data, independently derives each constituent's exact
base-to-head diff and lane, and verifies that the combined base-to-group tree is the deterministic
composition of those members. It applies the result matrix above to every constituent and succeeds
for the group only when every member passes its applicable validation. Missing, ambiguous,
duplicated, reordered, or unattributable membership; an unexplained group-tree change; or an
unavailable or truncated API response fails every metadata context. A membership, base, or head
change creates a different group SHA and requires a complete new run. A successful PR-head status
cannot satisfy the merge-group SHA.

For every publication constituent, the group run recomputes the sole receipt's exact bytes and
SHA-256 and requires its recorded semantic observations to equal the trusted issue, manifest,
candidate, predecessor, and recovery evidence. Mutable issue events after that accepted observation
do not rewrite the signed receipt or retroactively change the check result. An allowlisted human who
wants such a change to cancel publication must remove the pull request from the queue, commit a new
receipt when any recorded input changes, and re-enqueue it so a new group SHA is validated. This is
an explicit signed-snapshot boundary, not a claim that external issue state can be checked
atomically with a later merge.

After checks pass, the one-PR base-merge limit yields an isolated signed publication commit. The
verifier proves its parent tree is the validated group-prefix tree and its commit tree is the
accepted group result. The parent-to-commit diff therefore belongs to that one publication pull
request, and the signed receipt—not the cumulative build-group diff—attributes every contract path
and trailer. If the provider's actual merge behavior or available commit/tree/parent evidence cannot
prove that correspondence, the live activation probe fails and this model does not activate.

If any API or workflow is unavailable, its merge-group check remains missing or fails, the
configured timeout removes the entry without merging, and no stale success is reused. Activation
probes must demonstrate that the queue preserves the allowlisted human as the pull request's
`merged_by` actor and produces the required valid signed commit; otherwise this model cannot
activate.

Publication validation replaces readiness validation only for that exact pull request. It verifies
the add-only scope, regular-file modes, contract schema, issue/type/version/revision identity,
complete planning content, authoritative predecessor and quarantine-recovery sets, exact candidate
bytes, SHA-256 and expected signed trailer set, human-only `dev` target, and absence of conflicting
publication or authoritative contract state.

Ordinary publication requires every affected issue to be open with exactly `status: new`, no other
lifecycle label, no current accepted readiness record for its candidate state, and the expected
next semantic version and revision. Pre-activation migration is the sole exception: an affected
issue may retain `status: ready` only when its current title/body fingerprint and latest accepted
readiness record exactly match one entry in the sole terminal migration manifest on protected
`dev`. Migration manifests are immutable, versioned files under `docs/qa/`; each successor binds its
immediate predecessor's exact path and SHA-256 digest, and the complete manifest set must form one
linear, acyclic chain with one terminal node. The terminal manifest must contain exact set equality
with all current open `status: ready` issues when that manifest is published. Its entries are unique,
and each candidate must match its issue, type, version, revision, fingerprint, readiness-record URL,
and expected contract path. Once merged, the terminal path and digest freeze the migration
inventory; later issue edits cannot mutate it. A planning actor must publish a superseding manifest
before activation enrollment to incorporate or remove an issue. After enrollment, cancellation
requires the allowlisted human to remove the activation pull request from the queue and re-enqueue
it after the superseding manifest merges. Migration validation neither removes old readiness nor
treats the repository candidate as ready. Any competing terminal, fork, stale manifest binding,
lifecycle state at receipt validation, or entry mismatch fails publication.

Before queue-receipt acceptance, the issue workflow reacts to every affected issue edit, close,
reopen, label, and unlabel event. As defense in depth, it enumerates open pull requests, derives
publication membership only from each complete trusted diff, and invalidates all three PR-head
contexts when a candidate becomes invalid. It never claims that an unavailable enumeration, diff,
or status-write API changed remote status. Merge-time freshness comes from the required merge-group
run above: it independently validates every constituent and the combined tree on a new SHA, matches
each publication to its committed signed receipt, and cannot reuse PR-head success. Restoring issue
state never restores a prior result; removal, receipt refresh when recorded inputs change, and
re-enrollment require complete validation and fresh mutually consistent results.

Missing candidates, unexpected candidates, duplicate issue revisions, stale predecessors, invalid
issue state, incomplete quarantine recovery, producer mismatch, or disagreement among the three
results fail all three contexts. A pull-request body cannot request, forge, or widen publication or
migration mode, and no actor receives a branch-protection bypass. Successful validation does not
create an accepted readiness record.

Readiness is requested only after the publication commit has merged to `dev`. The readiness
validator then verifies the canonical pull request, signed receipt and snapshot trailer, isolated
exact merge commit, validated group-prefix parent and result tree, signature, authorized `merged_by`
actor, protected-`dev` ancestry, committed bytes and mode, receipt-attributed contract trailer
equality, and authoritative supersession chain before accepting the issue. Until that succeeds, the
issue remains non-ready and the merged candidate grants no implementation authority.
Publication-check success therefore establishes technical eligibility only for the human merge of
inert contract and receipt bytes; it never asserts readiness or validates a contract whose
publication itself depended on readiness. An indeterminate post-merge result records sanitized retry
evidence and leaves the issue non-ready at the same revision. A deterministic contradiction records
sanitized quarantine evidence and leaves the issue non-ready; only the add-only recovery procedure
above can produce a later authoritative contract.

Before activation, repair and probe live drift: required contexts `PR contract` and `Issue contract
current` are absent, and the new `Contract publication` context is not installed. Restore or add all
three with their expected producer and prove the normal, publication, mixed-scope, missing-context,
and wrong-producer cases before activation. Cutover is staged: first deploy inert tooling while
issue authority remains unchanged; then merge the add-only migration-manifest chain under `docs/qa/`
through the normal old-authority lane. The sole terminal manifest lists exactly every open
`status: ready` issue, its current type, version, normalized title/body fingerprint, latest accepted
readiness-record URL, and expected initial repository path and revision, without raw issue content.
Publication PRs then stage the terminal-manifest-bound add-only candidate contracts and pointer
evidence while old issue authority remains unchanged. Before activation enrollment, revalidate
exact set equality for every manifest entry, contract, pointer, and existing open PR; any intended
change requires a superseding manifest. The activation merge-group run validates every constituent
and the combined tree against that immutable terminal manifest and the signed publication receipts.
The single, separate, human-initiated signed activation merge contains
`Keiko-Migration-Manifest-SHA256: <digest> <path>` in its signed payload, and that path and digest must
equal the sole terminal manifest verified in its tree; every migrated contract must equal its signed
receipt. Activation does not reconsult mutable issue state after the signed-receipt boundary.
Activation disables migration mode
irreversibly before invalidating all old readiness evidence and failing closed until repository
revalidation succeeds. There is no authority gap, dual-authority interval, or later stale-manifest
exception.

Any partial provider or repository API failure before activation aborts the cutover and leaves old
issue authority unchanged. After activation, authority never rolls back to old issue state or dual
authority: repair is forward-only, and repository contracts remain authoritative. API unavailability
during publication, readiness, verification, or activation fails closed.

## Consequences

This decision provides protected-branch reachability, signed provenance, exact-byte SHA-256
verification, and reviewable contract history without treating a provider issue as immutable
authority. It requires new publication and verification tooling, protected-branch probes, a
required publication-specific replacement check, merge-group support in every required workflow, a
human-enqueued protected-`dev` merge queue, a staged migration and single activation switch, and
separately authorized implementation phases before any workflow is changed.
This ADR does not claim that those controls are implemented.

## Reopen triggers

Reopen this decision if the repository object format changes, GitHub changes REST signature or
protected-branch semantics, required verification cannot be performed without executing untrusted
PR content, the merge queue cannot preserve the allowlisted human `merged_by` identity or valid
signature, independent third-party attestation becomes mandatory, or a safe staged cutover cannot
be completed without an authority gap.

## References

| Source                       | Reference                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Git object identity          | [Git hash-object](https://git-scm.com/docs/git-hash-object)                                                                                                              |
| Git object-format transition | [Git hash-function transition](https://git-scm.com/docs/hash-function-transition/)                                                                                       |
| Commit verification          | [REST commit verification](https://docs.github.com/rest/commits/commits)                                                                                                 |
| Protected branches           | [GitHub protected branches](https://docs.github.com/en/rest/branches/branch-protection)                                                                                  |
| Merge-time checks            | [GitHub merge queues](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) |
| Merge-group workflow event   | [GitHub Actions `merge_group` event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)                       |
| Workflow privilege           | [Workflow permissions](https://docs.github.com/actions/using-jobs/assigning-permissions-to-jobs)                                                                         |
