# Migration inventory dry run

This read-only control proves the repository can enumerate and classify the complete mutable
GitHub planning surface before Contract-as-Code activation. It does not reconcile a label, publish
a manifest, create or update a pull request, freeze work, enqueue a merge, or switch authority.

## Exact snapshot

The provider performs two complete reads of labels, issues, comments, pull requests, exact heads,
combined statuses, commit signatures, assignments, associations, and repository contract paths.
Every paginated connection carries its provider total, cursor chain, and terminal page. An omitted,
duplicated, malformed, unavailable, or changed observation fails closed. Only the exact built-in
Actions bot identity `github-actions[bot]@41898282` can authenticate a readiness record.

The inventory first evaluates the current accepted-readiness fingerprint and only then evaluates
the issue's sole lifecycle label. Every current-ready open issue is retained, including paused and
in-flight work. PR-open or ready-for-human-review entries additionally bind exactly one pull
request, its accepted target, and its exact head. Closed completed issues require a signed merge
proof from an allowlisted maintainer. Other closures and pull requests receive no desired status
label. Unverifiable observations enter a sanitized disposition queue and produce no publishable
manifest. Every open pull request without an exact accepted-issue locator is dispositioned because
it would also make ADR-0012's complete hourly lifecycle reconciliation fail closed. Unassociated
closed historical pull requests remain non-blocking inventory facts.

## Deterministic outputs

An exact, disposition-free snapshot produces canonical terminal-manifest bytes, a SHA-256 digest,
candidate identities, and receipt inputs without titles, bodies, comment bodies, endpoints, or
credentials. An independent rebuild must equal the complete output. The workflow report contains
only numeric identities, lifecycle and reconciliation metadata, digests, paths, counts, timestamps,
and typed disposition codes.

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

Run the production-composition dry run through the protected `Migration inventory dry run`
workflow. Its token permissions are read-only and the provider interface exposes only `snapshot`.
