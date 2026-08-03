# Migration inventory dry run

This read-only control proves the repository can enumerate and classify the complete mutable
GitHub planning surface before Contract-as-Code activation. It does not reconcile a label, publish
a manifest, create or update a pull request, freeze work, enqueue a merge, or switch authority.

## Exact snapshot

The provider performs two complete reads of labels, issues, timestamped comments, body-edit and
reopen invalidations, assignment history, pull requests, draft and mergeability state, exact heads,
combined statuses, commit signatures, associations, repository contract paths, and the existing
immutable migration-manifest chain from the exact protected `dev` tree.
Every paginated connection carries its provider total, cursor chain, and terminal page. An omitted,
duplicated, malformed, unavailable, or changed observation fails closed. Only the exact built-in
Actions bot identity `github-actions[bot]@41898282` can authenticate a readiness record or required
commit status. An accepted readiness record must be newer than the latest body edit and reopen.

The repository must expose exactly the nine canonical lifecycle labels. The inventory first
evaluates current accepted readiness and only then evaluates the issue's sole lifecycle label.
Valid `new`, `triaged`, `blocked`, and `waiting for user` work without current readiness is excluded;
a matching readiness record hidden behind `new` or `triaged` is a conflicting observation. Every
current-ready retained issue is included, including paused work with zero or one ineligible open
pull request. A paused PR remains an inventory topology fact but is never an eligible manifest
binding. `in progress` additionally requires a current, authorized assignment claim. `pr open`
requires the trusted Issue and PR contract statuses but permits the expected failed or pending
Lifecycle handoff; `ready for human review` also requires a non-draft, mergeable PR, the trusted
Lifecycle handoff, and the complete exact-head rollup to pass. Closed completed issues select one
uniquely validated final delivery from any sequential merged history and require the pre-activation
terminal PR contract, exact-head gates, acceptance and audit evidence, signed head and merge
commits, the accepted target, and an allowlisted human merger. Other closures and pull requests
receive no desired status label. Closed-unmerged attempts and non-completed closures remain
non-blocking historical facts. Unverifiable observations enter a sanitized disposition queue and
produce no publishable manifest. Every open pull request without an exact accepted-issue locator is
dispositioned because it would also make ADR-0012's complete hourly lifecycle reconciliation fail
closed. Unassociated closed historical pull requests remain non-blocking inventory facts.

## Deterministic outputs

An exact, disposition-free snapshot—including a repository with zero migration members—produces
canonical terminal-manifest bytes, a SHA-256 digest, candidate identities, and receipt inputs
without titles, bodies, comment bodies, endpoints, or credentials. The first manifest records an
explicit null predecessor. Every later version uses the next numeric path and binds the immediate
protected-`dev` predecessor path and digest; gaps, forks, stale predecessors, malformed bytes, and
non-regular files fail closed. An independent rebuild must equal the complete output. The workflow
report contains only numeric identities, lifecycle and reconciliation metadata, digests, paths,
counts, timestamps, and typed disposition codes.

## Freeze and recovery plan

The dry run records a prospective generation but has no freeze or mutation authority. A publishable
snapshot can create a dry-run attempt whose expiry is exactly 60 minutes after its injected start
time. Drift, cancellation, or expiry terminates that generation and requires a fresh complete
inventory. A pre-switch failure preserves legacy issue authority. Once a later human-gated issue
performs the signed activation switch, recovery is forward-only through repository authority; the
system never rolls back to issue authority or permits a dual-authority interval.

Run the hermetic contracts locally with:

```text
node --test quality/migration-dry-run.test.mjs quality/migration-github-provider.test.mjs quality/migration-inventory.test.mjs quality/migration-orchestrator.test.mjs
```

Pull-request runs execute only the hermetic migration contracts with no repository token exposed to
candidate-controlled code. Run the live production-composition inventory by manually dispatching
the protected `Migration inventory dry run` workflow from `dev`. Only that protected-dev job
receives a read-only token, loads its executable code, contract blobs, and manifest chain from the
exact protected revision, passes that checked-out SHA as an expected provider invariant, and exposes
only the provider's `snapshot` interface. If `dev` advances between dispatch and observation, the
run fails closed and must be dispatched again from the new protected head.
