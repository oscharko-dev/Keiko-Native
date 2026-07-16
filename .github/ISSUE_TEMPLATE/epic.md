---
name: Epic
about: Plan a small, coordinated Keiko Native delivery outcome
title: "Epic: "
labels: ["type: epic", "status: new"]
assignees: ""
---

## Outcome

Describe the smallest useful product outcome, its user or enterprise value, and why it belongs in
Keiko Native now.

- Outcome and value:

## Change classification

Select exactly one:

- [ ] `parity-replacement`
- [ ] `mandatory-delta`
- [ ] `net-new`
- [ ] `hardening`
- [ ] `architecture/governance`
- [ ] `defect`

## Planning authority

- Product decision, finding, or incident:
- Fachkonzept capability or section, when applicable:
- Decision Addendum or parity entry, when applicable:
- Accepted ADRs:
- Repository branch or commit used as the planning baseline:

Restate all relevant requirements from the private source baseline in this contract. Do not quote
private text or require an implementation agent to access the Fachkonzept.

## Planning contract

- Contract version: `v1`
- Epic integration branch: `epic/<epic-number>-<short-slug>`
- Final delivery target: `dev`

`Implementation Ready` freezes the outcome, classification, authority, scope, non-goals, Quality
Envelope, journeys, platforms, architecture and trust boundaries, child contracts, acceptance path,
and target branches for this version. A wording-only correction may retain this version but still
requires a new readiness validation and fingerprint. Record actual evidence in pull requests or
issue comments rather than editing this contract. Any semantic change increments the version and
returns the issue to `status: new` until readiness validation succeeds again. A planning agent may
request validation directly after an evidence-first grilling session has resolved the product
decisions; no separate GitHub approval or human comment is required.

## In scope

-

## Non-goals

-

## Existing Keiko evidence and reuse

For `parity-replacement`, `mandatory-delta`, or any change informed by Existing Keiko, list the
behavior, contracts, UX, ADRs, or implementation candidates inspected as evidence. Classify every
proposed adoption as `adopt`, `adapt`, `retire`, or `revalidate`. Otherwise state `Not applicable`
with the reason. Native must not gain a mandatory build-time or runtime dependency on Existing
Keiko.

- Reuse Assessment:

## Architecture and ownership

- Owning domains or modules:
- Dependency direction:
- Trust boundaries and privileged effects:
- Data classes and persistence impact:
- Required or resulting ADRs:

## Primary acceptance journey

Required for a user-facing epic. Otherwise state `Not applicable` with the product rationale and
remove the remaining journey fields and placeholder data row. Describe observable behavior rather
than selectors or implementation details.

- Applicability: `Required | Not applicable — rationale`
- Journey ID: `J1`
- Actor and user goal:
- Preconditions and sanitized test data:
- Starting state:

| Step | User action or intent | Observable product outcome | Related AC or Quality row |
| ---- | --------------------- | -------------------------- | ------------------------- |
| 1    |                       |                            |                           |

- Failure and recovery path:
- Platform differences:
- Expected automated evidence:
- Required manual, accessibility, visual, or platform evidence:

## Platform matrix

- [ ] macOS is in scope, with target and acceptance differences identified.
- [ ] Windows is in scope, with target and acceptance differences identified.
- [ ] A platform is excluded with an explicit product rationale.
- [ ] Linux remains out of scope under the current Decision Addendum.

## Surface and state matrix

Delete non-applicable rows and add affected product-specific states.

| Surface or contract | Loading | Empty | Error | Conflict | Cancellation | Permission | Recovery |
| ------------------- | ------- | ----- | ----- | -------- | ------------ | ---------- | -------- |
|                     |         |       |       |          |              |            |          |

## Quality Envelope

Map every applicable row to an owner child issue or to the integrated epic acceptance section.

| Quality row                                | User path or risk covered | Platform | Expected evidence | Owner |
| ------------------------------------------ | ------------------------- | -------- | ----------------- | ----- |
| Contract and unit behavior                 |                           |          |                   |       |
| Failure and recovery envelope              |                           |          |                   |       |
| Production-composition verification (CORE) |                           |          |                   |       |
| Machine-enforced acceptance (CORE)         |                           |          |                   |       |
| Native UI or end-to-end behavior           |                           |          |                   |       |
| Security and privacy                       |                           |          |                   |       |
| Accessibility and design fidelity          |                           |          |                   |       |
| Performance and resource use               |                           |          |                   |       |

Integrated acceptance location: `this epic | final child #...`

## Integrated verification

List deterministic commands and authoritative platform evidence that qualify the assembled epic.

```text
npm run quality
```

## Child slices and interface contracts

Each child should be a small vertical result that is independently verifiable. For every dependency,
record the stable inputs, outputs, types, lifecycle, and error or empty states in both issues.

| Order | Child | Outcome | Depends on | Interface contract |
| ----- | ----- | ------- | ---------- | ------------------ |
| 1     |       |         |            |                    |

## Definition of Ready

- [ ] The Quality Envelope is complete and scaled to the actual surface.
- [ ] Exactly one change classification and its planning authority are recorded.
- [ ] The primary journey, platforms, surfaces, trust boundaries, and non-goals are explicit.
- [ ] Every relevant private-source requirement is restated completely without confidential text,
      and implementation requires no Fachkonzept access.
- [ ] Prerequisite decisions are accepted or assigned to a decision issue with criteria.
- [ ] Every implementation child can include acceptance criteria and deterministic verification.
- [ ] Cross-child interfaces and implementation order are stable enough to avoid parallel policy.
- [ ] Integrated release acceptance has an owner, commands, platforms, and expected evidence.

## Definition of Done

- [ ] Every child is complete with current-head evidence.
- [ ] The assembled capability passes the integrated Quality Envelope on its final head.
- [ ] Required macOS and Windows evidence exists on the authoritative platform.
- [ ] Confirmed review findings are resolved or explicitly dispositioned by an authorized human.
- [ ] Documentation, ADRs, contracts, and known follow-ups match the delivered behavior.

## Stop conditions

- Stop when the current contract version does not match its automated readiness record.
- Stop when scope, product policy, trust boundaries, or target platforms expand beyond this epic.
- Stop when an implementation instruction depends on an unresolved decision.
- Stop when a child would duplicate product authority or weaken a Native invariant or gate.
- Stop when the Quality Envelope cannot be verified in the declared environment.
