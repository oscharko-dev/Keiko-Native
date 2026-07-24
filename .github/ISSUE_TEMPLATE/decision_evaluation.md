---
name: Decision & Evaluation
about: Resolve an open Keiko Native decision with explicit criteria and evidence
title: "Decision: "
labels: ["type: decision", "status: new"]
assignees: ""
---

Lifecycle contract: [docs/qa/issue-lifecycle.md](../../docs/qa/issue-lifecycle.md).

Canonical lifecycle states: `status: new`, `status: triaged`, `status: ready`,
`status: in progress`, `status: pr open`, `status: ready for human review`, `status: blocked`,
`status: waiting for user`, and `status: done`.

Parent Epic: `None | #<epic_number>`

## Planning contract

- Contract version: `v1`

`Implementation Ready` freezes the decision question, authority, constraints, options, evaluation
method, acceptance criteria, evidence requirements, and delivery target for this version. A semantic
change increments the version and returns the issue to `status: new` until readiness validation
succeeds again. A planning agent may request validation directly after an evidence-first grilling
session has resolved the product inputs; no separate GitHub approval or human comment is required.

## Decision question and authority

- Decision to resolve:
- Why it must be decided now:
- Decision owner:
- Agent Planning Baseline, Decision Addendum, parity, risk, or incident reference:
- Relevant accepted ADRs and repository evidence:
- Required resulting record: `ADR | product decision | security decision | documented deferral`

## Constraints and non-negotiables

- Product and user constraints:
- Architecture and dependency constraints:
- Security, privacy, regulatory, and operational constraints:
- Supported platforms and reference environments:
- Explicit non-goals:

## Evaluation journey

Required when product, UX, accessibility, host, or platform behavior is part of the decision.
Otherwise state `Not applicable` with the rationale.

- Applicability: `Required | Not applicable — rationale`
- Actor and user goal:
- Representative starting state and sanitized test data:
- Observable path and failure or recovery states:
- Platform variants:
- Evidence produced consistently for every affected option:

## Options

Include the current baseline or `do nothing` where it is a legitimate option.

| Option | Description | Expected benefit | Cost or risk | Rejection condition |
| ------ | ----------- | ---------------- | ------------ | ------------------- |
|        |             |                  |              |                     |

## Evaluation plan

- Method: `research | throwaway prototype | benchmark | threat-model evaluation | compatibility
test | operational evaluation`
- Time or scope box:
- Workloads, scenarios, or attack paths:
- Metrics, thresholds, and measurement method:
- Reference hardware, operating systems, versions, and dependencies:
- Required primary sources and repository evidence:
- Reproduction commands and retained artifacts:
- Testability, automation harness, CI ownership, and production-artifact isolation:
- Bias, uncertainty, and evidence limitations:

Experimental code is evidence only. State where it will live, how it remains isolated from
productive source, and whether it will be deleted or retained as a governed test fixture. It must
not become production architecture without a separately accepted implementation issue.

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
sends `merge_method: merge`, never uses provider auto-merge, and verifies exact refs and ordered
parents. An ambiguous claim remains blocked with no retry until explicit human reconciliation using
exact refs and ordered parents. A new request identity is permitted only after explicit terminal
settlement or human reconciliation and fresh revalidation. GitHub cannot distinguish
shared-identity agent and human actions. An agent must never merge or enable auto-merge for `dev`,
`main`, or `release/**`; guard unavailability selects human-only child integration.

The executing agent chooses a dedicated source branch using its own runner prefix. It must include
the issue number, remain unique to this issue, and be recorded in the pull request.

## Decision matrix

Define weighting before collecting results. Do not change criteria or weights after seeing results
without recording the change and returning the issue to planning.

| Criterion | Weight | Option A | Option B | Option C | Evidence |
| --------- | ------ | -------- | -------- | -------- | -------- |
|           |        |          |          |          |          |

## Acceptance criteria

- [ ] AC1 — Every viable option is evaluated against the same declared criteria and evidence bar.
- [ ] AC2 — The recommendation follows reproducibly from the recorded evidence and trade-offs.
- [ ] AC3 — The required ADR, decision record, or reasoned deferral is produced and linked.
- [ ] AC4 — Experimental artifacts are deleted or retained only under an explicit governed purpose.

## Verification commands

```text
npm run quality
```

Add the smallest commands that reproduce measurements, compatibility results, or threat-model
claims without secrets, private endpoints, or customer data.

## Definition of Ready

- [ ] The decision question, owner, urgency, constraints, options, and non-goals are explicit.
- [ ] Evaluation methods, equal-workload criteria, thresholds, environments, and evidence sources
      are defined before results are collected.
- [ ] Execution Authority and experimental-code disposal are explicit.
- [ ] The planned evaluation is executable in the available environment.

## Definition of Done

- [ ] Every criterion has attributable, reproducible evidence and recorded limitations.
- [ ] The recommendation, dissenting evidence, risks, and residual uncertainty are explicit.
- [ ] The resulting decision record is accepted through its normal governance path.
- [ ] No throwaway code, secret, private evidence, or undeclared productive dependency remains.
- [ ] Documentation and follow-up implementation issues reflect the decision without expanding it.

## Stop conditions

- Stop when the current contract version does not match its automated readiness record.
- Stop when any option, criterion, threshold, platform, boundary, or authority changes.
- Stop when representative evidence cannot be produced in the declared environment.
- Stop when evaluation would require customer data, an undeclared secret, or an unauthorized
  external mutation.
- Stop before turning experimental evidence into productive architecture or feature delivery.
