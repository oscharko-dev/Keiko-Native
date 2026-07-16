---
name: Feature / Task
about: Define an implementation-ready Keiko Native vertical slice
title: ""
labels: ["type: task", "status: new"]
assignees: ""
---

Parent Epic: #<epic_number>

## Planning contract

- Contract version: `v1`

`Implementation Ready` freezes the purpose, classification, planning authority, scope, Quality
Plan, acceptance criteria, interfaces, architecture and trust boundaries, target platforms,
verification, audit obligations, and delivery target for this version. A wording-only correction
may retain this version but still requires a new readiness validation and fingerprint. Record actual
evidence in pull requests or issue comments rather than editing this contract. Any semantic change
increments the version and returns the issue to `status: new` until readiness validation succeeds
again. A planning agent may request validation directly after an evidence-first grilling session
has resolved the product decisions; no separate GitHub approval or human comment is required.

## Purpose and observable outcome

Describe the small user, product, platform, or governance result delivered by this issue.

- Outcome:

## Acceptance journey

Required when this issue changes user-visible behavior. Otherwise state `Not applicable` with the
rationale and remove the remaining journey fields and placeholder data row. Reference the parent
journey and describe only this issue's vertical slice.

- Applicability: `Required | Not applicable — rationale`
- Parent journey: `J... | Not applicable`
- Issue journey: `J...`
- Actor and user goal:
- Preconditions and sanitized test data:
- Starting state:

| Step | User action or intent | Observable product outcome | Related AC |
| ---- | --------------------- | -------------------------- | ---------- |
| 1    |                       |                            |            |

- Failure and recovery path:
- Platform differences:
- Expected automated evidence and command:
- Required manual, accessibility, visual, or platform evidence:

## Change classification and planning authority

- Classification: `parity-replacement | mandatory-delta | net-new | hardening |
architecture/governance | defect`
- Product decision, finding, or incident:
- Agent Planning Baseline and parity reference, when applicable:
- Existing Keiko evidence or Reuse Assessment, when applicable:
- Not-applicable rationale for omitted parity or reuse evidence:

## Scope

- In scope:
- Out of scope:

## Execution Authority

The repository-wide defaults in `AGENTS.md` apply and are not repeated here.

- Authorized repository:
- Exact delivery target: `epic/<epic-number>-<short-slug> | dev (standalone)`
- Allowed write scope:
- Additional prohibited paths or actions: `None | ...`
- Authorized external mutations: `None | ...`
- Required credentials or secrets: `None | ...`
- Delivery authority: `agent auto-merge to epic branch | human-only manual merge to dev`
- Additional stop or escalation conditions: `None | ...`

The executing agent chooses a dedicated source branch using its own runner prefix. The branch must
be unique to this issue, include the issue number, and never be reused across issues. Record its
actual name in the pull request rather than changing this contract.

## Planning and architecture alignment

- Parent Quality Envelope rows owned by this issue:
- Owning modules or domains:
- Contracts and dependency direction:
- Trust boundaries, data classes, and privileged effects:
- Relevant accepted ADRs:
- Required Reuse Assessments:

## Interface contracts

For every dependency, define inputs, outputs, types or schemas, lifecycle, limits, and error, empty,
cancellation, and recovery behavior. Use `None` only when the slice has no cross-issue dependency.

- Dependency and interface contract:

## Quality Plan

- Applicable Code Quality Standard sections:
- Target platforms and authoritative environments:
- Positive, empty, boundary, malformed, hostile, unauthorized, unavailable, cancellation, partial
  failure, and recovery paths to cover:
- Required unit, contract, architecture, integration, production-composition, and end-to-end tests:
- Required security, accessibility, performance, resource, visual, or manual evidence:
- Measurable budgets or thresholds:
- Explicit exclusions with rationale:

## Acceptance criteria

Every criterion must describe observable behavior and its expected evidence.

- [ ] AC1 — Evidence:
- [ ] AC2 — Evidence:

## Verification commands

List deterministic commands that an implementer and reviewer can run. Include the complete required
repository suite and the smallest affected checks.

```text
npm run quality
```

## Audit plan

- Required independent audit dimensions:
- Runtime paths the audit must inspect:
- Evidence required to settle confirmed findings:

## Definition of Ready

- [ ] Parent epic and owned Quality Envelope rows are identified.
- [ ] The parent epic and this issue contain the complete executable requirement slice; no private
      source access or omitted inference from the Agent Planning Baseline is required.
- [ ] Change classification and applicable planning authority are recorded.
- [ ] Acceptance criteria and deterministic verification commands are complete.
- [ ] The Acceptance Journey is complete for user-facing work, or its exclusion is justified.
- [ ] Owning layer, interfaces, trust boundaries, platforms, and evidence obligations are
      understood.
- [ ] Execution Authority identifies the exact repository, delivery target, write scope, external
      effects, credentials, and merge boundary.
- [ ] Required ADRs are accepted or explicitly produced by a decision issue.
- [ ] The planned verification is executable in the available environment.
- [ ] No unresolved product, scope, policy, or architecture decision is disguised as implementation.

## Completion and review settlement

- [ ] Acceptance criteria and Quality Plan are satisfied with exact-current-head evidence.
- [ ] Affected and complete required quality suites pass.
- [ ] The independent audit used the acceptance criteria and Quality Plan as its checklist.
- [ ] Confirmed findings are resolved, human-accepted, or linked to a scoped non-blocking follow-up.
- [ ] Verification and audit evidence was refreshed after the latest fix.
- [ ] Documentation, contracts, ADRs, and residual risks match the implementation.

## Stop conditions

- Stop when the current contract version does not match its automated readiness record.
- Stop when scope, trust boundaries, platforms, or privileged effects expand beyond this issue.
- Stop when acceptance criteria, verification, ownership, or a prerequisite decision is missing.
- Stop when implementation would weaken a gate, introduce parallel product authority, require a
  secret, or expose customer data.
