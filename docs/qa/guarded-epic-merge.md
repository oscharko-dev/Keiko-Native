# Guarded epic merge operation

## Status

Repository-owned implementation and operator runbook. The operation is inert before the signed
Contract-as-Code activation. Issue #55 owns activation, the first live mutation, and the complete
live proof matrix.

## Protected policy and status

[`quality/epic-merge-policy.json`](../../quality/epic-merge-policy.json) is the policy projection
loaded only from protected `dev`. Its checked-in activation state is `inactive`; its manifest and
live proof are `null`. The read-only
[`Epic merge guard status`](../../.github/workflows/epic-merge-guard-status.yml) workflow checks out
the immutable `dev` event SHA without persistent credentials and invokes:

```text
node quality/epic-merge-policy.mjs status
```

The producer verifies `GITHUB_REF=refs/heads/dev` and that the checkout equals `GITHUB_SHA`, then
obtains the exact revision directly from Git. It never resolves a moving branch name. A caller
cannot supply the policy revision, availability state, target, activation, manifest, or proof.

Protected policy derives exactly:

- `disabled`: no provider merge request;
- `probe-only`: only an exact Issue #55 frozen-manifest operation may proceed; and
- `enabled`: eligible general child delivery only after the distinct expected proof-receipt and
  status producers both bind the signed activation, exact protected-policy revision, manifest
  digest, and complete settled non-ambiguous matrix.

One central exact schema validator is used by status, guard, adapter, and repository contract.
Unknown fields, empty or duplicate active requirements, a missing or non-Issue-#55 manifest,
malformed operations, and invalid bindings fail closed.

## Guarded request

The public request contains repository, issue, canonical pull request, caller operation/request
identities, and mode `agent-credentialed`. It has no target field. Caller identities are
immediately replaced by domain-separated SHA-256 `op_…` and `req_…` values; originals never enter
persistence, settlement, reconciliation, or receipts. The guard performs two equal stable reads:

- open issue identity, exact current accepted readiness record, and
  `status: ready for human review`;
- exact accepted `epic/**` target and canonical open non-draft mergeable pull request;
- exact source head, observed base, head tree, and current pagination;
- exactly one completed successful result for every required context/producer on the exact
  head/base; duplicate, conflicting, stale, or incomplete results deny;
- current acceptance and audit evidence; and
- zero blocking findings and zero unresolved conversations.

`dev`, `main`, `release/**`, feature, non-epic, caller-selected, and pull-request target
substitution deny before persistence or provider submission. The guard reads exact refs and
complete target protection twice before claiming. Protection must prove active pull-request,
signature, status-check, deletion, and force-push controls, maintainer merge permission, and no
bypass actor or bypass authority. The current live repository has no accepted epic-target
protection, so it correctly denies until activation work installs and proves it.

Check Runs are queried with `filter=latest`, bound to the exact queried head and canonical pull
request base, and reject missing or conflicting non-empty pull-request associations. Commit
statuses are separately paginated because `PR contract` and `Issue contract current` are status
contexts. Their exact producer is `github-actions[bot]@41898282`; a newer failure cannot be masked
by an older success. Malformed ordering and duplicate or conflicting results across either source
fail closed. Review threads use a bounded GraphQL cursor query with the canonical repository owner,
name, and pull request number; malformed page information, cursor cycles, or truncation deny.

The guard uses no synthetic GitHub App, bot account, or additional repository credential. Acceptance
evidence is the latest exact-head successful `PR contract` commit status from the existing
`github-actions[bot]@41898282` producer. Audit evidence is exactly one fully paginated, immutable
pull-request issue comment authored by existing allowlisted maintainer `niko4417` or `oscharko`. The
comment uses workflow `adr-0009-maintainer-audit-v1`, records zero findings, and binds the exact head
and a SHA-256 digest over that head, workflow, and finding count. Its normalized producer is
`maintainer-audit@adr-0009`. An edited or duplicate marker, wrong actor, workflow, head or digest,
incomplete pagination, or newer failed contract status denies.

Code-scanning alerts are accepted only in exact `open`, `fixed`, or structurally valid `dismissed`
states and must bind the pull request merge ref. Unknown or malformed alerts deny. Every
authoritative provider read requires HTTP 200 and its endpoint-specific response shape; a
body-shaped 403 or 404 remains a denial rather than evidence.

## Durable at-most-once boundary

The serialization key is the digest of repository, exact accepted target, and observed current
base only. Issue, pull request, head, readiness, operation, and request identities cannot partition
it. A durable SQLite transaction atomically creates the claim and immutable operation or returns
contended/replayed; a successful claim can never exist without its recoverable operation. The
guard reads the complete preparation back exactly, then immediately re-reads refs and target
protection. Any change cancels the unsubmitted operation and releases serialization.

Immediately before the provider request, the guard performs the final protected-policy read and then
reloads the canonical pull request. Any source, head, base, target, eligibility, or contract
change—including a retarget to `dev`—cancels before submission. This canonical pull-request reload
is the last provider metadata read before the marker and effect.

The guard then durably marks the operation submitted and reads that marker back exactly. The
submitted boundary is crossed conservatively before invoking the marker port, so marker-call or
read-back uncertainty is treated as possibly submitted and cannot release serialization. This
distinguishes a proved never-submitted prepared operation from any possibly-submitted operation
across crashes and ambiguous responses.

Only then may the provider adapter receive one request:

```text
repository: oscharko-dev/Keiko-Native
pullRequest: <canonical pull request>
sha: <exact revalidated head>
merge_method: squash
```

There is no provider auto-merge, merge queue, update-branch, direct-ref, administration, bypass, or
protected-branch alternative. The adapter receives ambient authentication from the operator
environment; the guard has no credential input and never inspects or emits authentication
material.

Confirmed rejection terminally releases the claim. Verified success releases it only after
read-back proves the canonical pull request is merged; the provider-reported actual source, source
head, base, and target equal the persisted topology; target tip equals the reported squash commit;
and that commit has the observed base as its sole parent and the observed head tree. Caller-supplied
target metadata never substitutes for provider read-back. The inert adapter classifies
403/404/409/422 as confirmed rejection, 429 and timeouts as
ambiguous, and malformed responses as ambiguous without retaining provider bodies. Ambiguity or
read-back mismatch is `indeterminate`; the operation remains durably blocked without release.
Its redacted receipt classifies the attempted indeterminate settlement as `recorded`, `unproven`,
or `unavailable` without exposing the underlying provider or persistence error.

## Human reconciliation

An allowlisted maintainer reconciles an indeterminate operation. The maintainer must:

1. identify the immutable operation, durable submitted marker, and serialization claim;
2. read the canonical pull request, exact source head, exact target tip, reported or observed
   squash commit, its complete parent list, and its tree;
3. compare those values to the persisted head, base, and head tree;
4. settle a submitted operation merged only when pull request, exact source head, target tip, sole
   parent, and tree all match;
5. settle a never-submitted prepared or pre-submit-indeterminate operation cancelled only when the
   canonical pull request remains unmerged, its source/head/base/target are unchanged, and the
   target tip still equals the persisted base;
6. otherwise leave the claim blocked and investigate without retrying or creating a replacement
   request identity.

The reconciliation interface independently verifies the maintainer role and exact topology. It
uses a distinct append-only compare-and-set transition from the current prepared, submitted, or
indeterminate state; replay and a second terminal transition deny. A no-effect path can never
cancel an operation carrying the submitted marker. A later fresh operation is permitted only
after explicit terminal settlement or reconciliation and a full new authorization read.

## Corrected v2 probe harness

`buildEpicMergeProbePlan` accepts only already provider-assigned primary and stale-case parent issue
numbers. It derives their distinct `epic/**` targets, binds two concurrency attempts to one primary
target/base serialization key, and places the stale-base case on the separate parent target.

The plan preserves the actual observed tips for `dev`, disposable feature, disposable release, and
wrong-epic refs. `main` must be observed absent with a null tip and `createAllowed: false`; the
harness never fabricates a tip or creates that ref. Every denial requires a post-attempt read of
the same actual ref.

Issue #50 proves this plan and the guard hermetically and may produce only non-mutating live status
and topology evidence. It must not call the merge provider. Issue #55 freezes the disposable
manifest, performs the live matrix after activation, and supplies the expected-producer receipt
and status consumed by protected policy.
