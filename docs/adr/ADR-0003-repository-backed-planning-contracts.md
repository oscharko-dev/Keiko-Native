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

Its contract identifier is SHA-256 of the exact committed blob bytes, with no normalization,
rendering, line-ending conversion, or API representation substituted for those bytes. The
publishing commit is signed and its signed commit payload contains exactly one trailer for every
contract published by that commit:

`Keiko-Contract-SHA256: <digest> <path>`

Trailers are sorted lexicographically by path. Verification recomputes SHA-256 from the exact blob
bytes at the contract path in the publishing commit tree, matches that digest and path to exactly
one signed trailer, rejects missing, duplicate, or conflicting trailers for a path or digest, and
requires exact set equality between normalized signed trailers and the regular, add-only
`docs/contracts/` blobs introduced by the canonical publication PR's exact merge-commit diff. It
fails closed on every API, parsing, object, signature, ancestry, or tree-validation error. It must
require all of the following:

- `.commit.verification.verified === true` and `.commit.verification.reason === "valid"` in the
  GitHub REST commit payload;
- the signed payload contains exactly one matching required trailer per contract and no missing,
  duplicate, or conflicting trailer for its path or digest;
- the normalized trailer set equals the regular `docs/contracts/` blobs newly added by the canonical
  publication PR's exact merge-commit diff, rejecting every unexpected trailer, every added
  contract without a trailer, and every claimed path not newly added by that publication;
- in the publishing commit tree, the contract path resolves to the exact blob bytes whose SHA-256
  equals the matching trailer digest, and in the current `dev` tree that path resolves to a regular
  blob with identical exact bytes, SHA-256, and mode where mode is applicable; and
- the publishing commit is an ancestor of protected `dev`.

The publication identity is a canonical publication pull request, its exact merge commit, and a
GitHub commit signature satisfying the verification rule above. The pull request's `merged_by` actor
must be an authorized maintainer in the current AGENTS.md allowlist. The GitHub web-flow signer is
the identity represented by the commit signature; the human merge actor is `merged_by`; they are
separate facts and both are required. Missing, unavailable, or contradictory pull-request, actor,
merge-commit, or signature evidence fails closed.

Revisions are append-only. A wording-only correction keeps its version and increments `r` by one;
a semantic change increments `v` by one and starts at `r1`. Each contract has exactly one immediate
predecessor, except the first, and its `Supersedes` declaration binds that predecessor's exact path
and SHA-256 digest. The contracts for an issue, across all versions and revisions, form one unique,
acyclic, linear chain: no forks, skips, duplicate predecessors, or cycles are valid. Its sole
highest terminal node is authoritative. The issue pointer only echoes that node and must equal it;
it never selects authority.

The issue body and comments do not become a second authority. The issue holds a pointer to the
authoritative repository contract and operational evidence only.

Contract publication uses a narrow, dedicated pull-request lane: it may change only add-only
`docs/contracts/` entries. Its validator is loaded from protected `dev`, never executes content
from the publication PR, and its signed merge is human-only. Readiness is requested only after the
publication commit has merged to `dev`; therefore readiness never validates a contract whose
publication itself depended on readiness.

Before activation, repair and probe live drift: required contexts `PR contract` and `Issue contract
current` are absent. They must be restored and demonstrably enforced before activation. Cutover is
staged: first deploy inert tooling while issue authority remains unchanged; then, under that old
authority, stage add-only candidate contracts plus a migration manifest and pointers for every open
`status: ready` issue and existing open PR, and verify completeness. A single, separate,
human-signed protected-`dev` activation commit switches authority. At that switch all old readiness
evidence invalidates and fails closed until revalidated against repository contracts. There is no
authority gap or dual-authority interval.

Any partial provider or repository API failure before activation aborts the cutover and leaves old
issue authority unchanged. After activation, authority never rolls back to old issue state or dual
authority: repair is forward-only, and repository contracts remain authoritative. API unavailability
during publication, readiness, verification, or activation fails closed.

## Consequences

This decision provides protected-branch reachability, signed provenance, exact-byte SHA-256
verification, and reviewable contract history without treating a provider issue as immutable
authority. It requires new publication and verification tooling, protected-branch probes, a
staged migration and single activation switch, and a follow-up implementation issue before any
workflow is changed.
This ADR does not claim that those controls are implemented.

## Reopen triggers

Reopen this decision if the repository object format changes, GitHub changes REST signature or
protected-branch semantics, required verification cannot be performed without executing untrusted
PR content, independent third-party attestation becomes mandatory, or a safe staged cutover cannot
be completed without an authority gap.

## References

- [Git hash-object](https://git-scm.com/docs/git-hash-object)
- [Git hash-function transition](https://git-scm.com/docs/hash-function-transition/)
- [REST commit verification](https://docs.github.com/rest/commits/commits)
- [GitHub protected branches](https://docs.github.com/en/rest/branches/branch-protection)
- [Workflow permissions](https://docs.github.com/actions/using-jobs/assigning-permissions-to-jobs)
