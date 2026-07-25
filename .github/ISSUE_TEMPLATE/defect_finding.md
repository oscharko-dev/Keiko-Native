---
name: Defect / User Finding
about: Restore accepted Keiko Native behavior from reproducible evidence
title: "Defect: "
labels: ["type: defect", "status: new"]
assignees: ""
---

Lifecycle contract: [docs/qa/issue-lifecycle.md](../../docs/qa/issue-lifecycle.md).

Canonical lifecycle states: `status: new`, `status: triaged`, `status: ready`,
`status: in progress`, `status: pr open`, `status: ready for human review`, `status: blocked`,
`status: waiting for user`, and `status: done`.

Parent Epic: `None | #<epic_number>`

## Planning contract

- Contract version: `v1`

`Implementation Ready` freezes the accepted behavior, reproduction boundary, impact, scope,
acceptance criteria, Quality Plan, and delivery target. A wording-only correction may retain the
version but still requires a new readiness validation and fingerprint. A semantic change increments
the version, returns the issue to `status: new`, and requires a new successful readiness validation.
Record actual implementation, verification, and audit evidence in pull requests or issue comments.

## Finding and accepted behavior

- Finding source: `user | support | test | audit | security review | production evidence`
- Finding or incident reference:
- Affected version, commit, build, or artifact:
- Affected platforms and environments:
- Observable behavior:
- Accepted or expected behavior and authority:
- User, enterprise, security, or operational impact:
- Severity and rationale:
- Affected acceptance journey and checkpoint: `J... | Not applicable`

Do not include customer data, credentials, private endpoints, raw logs, prompts, or sensitive
screenshots. Link only to evidence that satisfies repository redaction and retention policy.

## Reproduction contract

- Preconditions and sanitized fixture:
- Minimal deterministic steps:
- Reproduction command:
- Actual result:
- Expected result:
- Reproduction stability: `always | intermittent with measured frequency | not yet reproducible`
- Smallest known affected boundary:
- Known unaffected boundary:
- User-visible failure and recovery path: `Not applicable | ...`

If the finding is not reproducible, scope this issue to evidence-driven diagnosis. Do not assert a
root cause or authorize a production fix without evidence.

## Scope

- In scope:
- Out of scope:
- Suspected owning module or domain:
- Trust boundaries, data classes, or privileged effects involved:
- Regression and compatibility boundary:

## Execution Authority

The repository-wide defaults in `AGENTS.md` apply and are not repeated here.

- Authorized repository:
- Exact delivery target: `epic/<epic-number>-<short-slug> | dev (standalone)`
- Allowed write scope:
- Additional prohibited paths or actions: `None | ...`
- Authorized external mutations: `None | ...`
- Required credentials or secrets: `None | ...`
- Delivery authority: `guarded agent merge to exact accepted epic/** branch | human-only manual merge to dev`
- Additional stop or escalation conditions: `None | ...`

This authority exists only for a fully eligible child-issue pull request targeting its exact
accepted `epic/**` branch. Epic and standalone pull requests remain human-only deliveries to `dev`.
For that child-issue delivery, an agent may use the existing authenticated maintainer credential
only through the repository-owned guarded operation after complete current evidence and
`status: ready for human review` are revalidated. The guard persists a durable single-flight
compare-and-set claim for target/base serialization before any provider submission. The target/base
serialization uniqueness key consists only of repository, exact accepted target, and observed
current base. The immutable per-operation record binds issue, contract, readiness, pull request,
exact head, and request identity. Distinct request identities cannot create another serialization
claim. Two distinct child-issue pull requests for the same exact accepted target and observed base
contend on that one key; only one may reach provider submission. It submits at most once, explicitly
passes the exact revalidated head SHA as the provider request's `sha` parameter, and explicitly
sends `merge_method: squash`. It never uses provider auto-merge and verifies that the exact target
tip is the reported squash commit, whose sole parent is the observed base and whose tree equals the
observed head tree. An ambiguous claim remains blocked with no retry until explicit human
reconciliation using exact refs, the squash commit, its parent, and the observed trees. A new
request identity is permitted only after explicit terminal settlement or human reconciliation and
fresh revalidation. GitHub cannot distinguish shared-identity agent and human actions. An agent
must never merge, enable auto-merge, enqueue, push, or update `dev`, `main`, or `release/**`; guard
unavailability selects human-only child integration.

The executing agent chooses a dedicated source branch using its own runner prefix. It must include
the issue number, remain unique to this issue, and be recorded in the pull request.

## Quality Plan

- Applicable Code Quality Standard sections:
- Failure-first regression evidence required:
- Positive, negative, boundary, hostile, unauthorized, unavailable, cancellation, partial-failure,
  and recovery paths to cover:
- Required unit, contract, architecture, integration, production-composition, and end-to-end tests:
- Required security, accessibility, performance, resource, visual, platform, or manual evidence:
- Explicit exclusions with rationale:

## Acceptance criteria

- [ ] AC1 — The accepted behavior is restored with observable evidence.
- [ ] AC2 — A failure-first test proves the finding and passes after the owning-layer fix.
- [ ] AC3 — The whole confirmed defect class is fixed without weakening a gate or trust boundary.
- [ ] AC4 — Affected failure, recovery, compatibility, and platform paths remain verified.

## Verification commands

```text
npm run quality
```

Add the smallest deterministic reproduction and affected verification commands.

## Audit plan

- Required independent audit dimensions:
- Owning runtime paths and neighboring defect-class paths to inspect:
- Evidence required to settle confirmed findings:

## Definition of Ready

- [ ] Accepted and observed behavior, impact, authority, affected boundary, and non-goals are clear.
- [ ] The finding is reproducible, or the issue is explicitly limited to diagnosis.
- [ ] Acceptance criteria, Quality Plan, Execution Authority, and deterministic commands are
      complete.
- [ ] No unsupported root-cause or fix claim is presented as fact.

## Completion and review settlement

- [ ] Failure-first evidence and the owning-layer cause are recorded.
- [ ] Acceptance criteria and Quality Plan pass on the exact current head.
- [ ] The affected defect class and meaningful neighboring paths were audited.
- [ ] Confirmed findings are resolved, human-accepted, or linked to a scoped non-blocking follow-up.
- [ ] Documentation, known limitations, and residual risks match the corrected behavior.

## Stop conditions

- Stop when the current contract version does not match its automated readiness record.
- Stop when reproduction evidence contradicts the accepted behavior or expands the affected scope.
- Stop when the suspected cause is unconfirmed or the owning layer cannot be identified.
- Stop when a fix would weaken a gate, trust boundary, compatibility guarantee, or unrelated
  behavior.
- Stop when diagnosis requires customer data, an undeclared secret, or an unauthorized external
  mutation.
