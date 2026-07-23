## Scope

- Accepted issue:
- Accepted planning-contract version:
- Automated readiness record:
- Actual source branch:
- Accepted target branch:
- Parent epic and Quality Envelope rows:
- Change classification: `parity-replacement | mandatory-delta | net-new | hardening |
architecture/governance | defect`
- Product decision, finding, or incident:
- In scope:
- Out of scope:
- Native targets, contracts, or trust boundaries affected:

## Product and architecture alignment

- [ ] The implemented contract version and fingerprint match the automated readiness record; no
      semantic planning change was absorbed during implementation.
- [ ] The change follows the Decision Addendum, `CONTEXT.md`, accepted ADRs, and the issue Quality
      Plan.
- [ ] Existing Keiko material was used only after a recorded Reuse Assessment, or the issue records
      why Existing Keiko evidence is not applicable.
- [ ] This greenfield change creates no mandatory build-time or runtime dependency on Existing
      Keiko.
- [ ] Product authority, policy, evidence, and privileged effects remain in their owning Native
      layer.
- [ ] Any durable architecture change is recorded in an ADR.

## Acceptance criteria and evidence

Evidence must identify the exact file, test, command, artifact, or platform result. Do not mark a
row complete from intention or a processing badge.

| Acceptance criterion | Evidence | Exact head or artifact | Result |
| -------------------- | -------- | ---------------------- | ------ |
| AC1                  |          |                        |        |

## Acceptance journey evidence

Complete for user-facing work. Otherwise state `Not applicable` with the issue rationale and remove
the placeholder data row. Evidence records what ran; the issue remains the source for expected
behavior.

- Applicability: `Required | Not applicable — rationale`

| Journey and checkpoint | Automated evidence and command | Manual or platform evidence | Result |
| ---------------------- | ------------------------------ | --------------------------- | ------ |
| J1.1                   |                                |                             |        |

- [ ] Automated checks exercise user-visible outcomes rather than incidental implementation
      details.
- [ ] Required failure, recovery, accessibility, visual, and platform observations are settled.

## Quality Plan settlement

- [ ] Applicable positive, negative, boundary, failure, cancellation, and recovery behavior is
      covered.
- [ ] The actually wired production composition was tested where this change crosses layers.
- [ ] Applicable security, accessibility, performance, resource, visual, and platform evidence is
      attached or linked.
- [ ] Excluded quality areas retain the rationale accepted in the issue.
- [ ] Secrets, credentials, raw customer content, private endpoints, and PII are absent from source,
      tests, logs, evidence, artifacts, issues, and this pull request.

## Verification

- [ ] `npm ci --ignore-scripts`
- [ ] `npm run quality`
- [ ] `npm audit --audit-level=high`
- [ ] Every declared native target-specific gate passed on its authoritative platform.
- [ ] I reviewed the complete diff against requirements, contracts, trust boundaries, and failure
      modes.

Additional affected checks and concise results:

```text

```

## Independent audit and findings

- Audit scope and dimensions:
- Audited commit:

| Confirmed finding | Evidence | Disposition | Settlement evidence or follow-up |
| ----------------- | -------- | ----------- | -------------------------------- |
| None              |          |             |                                  |

- [ ] Findings are evidence-cited; speculative observations are advisory rather than blockers.
- [ ] Every confirmed finding is resolved, explicitly accepted by an authorized human, or linked to
      a scoped follow-up that does not invalidate current acceptance.
- [ ] Verification and audit were repeated after the latest implementation or audit fix.

## Integrated epic acceptance

Complete when this PR delivers or changes an epic's integrated acceptance surface; otherwise state
`Not applicable` with rationale.

- Applicability: `Required | Not applicable — rationale`
- Production-composition result:
- Machine-enforced acceptance result:
- macOS evidence:
- Windows evidence:
- Manual usability, accessibility, visual, signing, or packaging evidence:

## Delivery

- Target path: `child issue -> epic branch | epic/standalone -> dev`
- [ ] The target branch matches the delivery path accepted in the issue; no direct push, force
      push, gate bypass, finding dismissal, or authority widening occurred.
- [ ] Commits are signed and every required check is bound to the exact current head and expected
      producer.
- [ ] Advisory tools are not treated as required merge authority under the current quality-gate
      policy.
- [ ] Documentation, ADRs, contracts, known limitations, and follow-ups are current.
- [ ] A draft pull request was not promoted to `Ready for Human Review` before every required
      Acceptance Journey result and exact-head gate was complete.

For a child-issue pull request targeting its designated epic branch:

- [ ] The accepted issue authorizes this epic-branch target.
- [ ] Acceptance and audit evidence is complete, every applicable exact-head gate is green, and no
      blocking finding or review conversation remains.

An agent may submit a bounded request only to the trusted server-side merge-authority broker
authenticated as the dedicated non-human GitHub App. The broker alone may merge into the exact
accepted epic target. No automated principal may merge or enable auto-merge for `dev`; broker
unavailability selects human-only child integration.

For an epic or standalone pull request targeting `dev`, complete only by Niko or Oscharko. Agents
must leave this subsection untouched, stop at `Ready for Human Review`, and must not enable
auto-merge.

- Authorized maintainer:
- Reviewed head commit:
- [ ] I reviewed the linked issue and pull request, including scope, acceptance criteria, Quality
      Plan, evidence, checks, findings, conversations, and residual risks on the commit above.
- [ ] I am manually initiating the merge into `dev`; no automated actor is performing it.

## Residual risks and follow-ups

- None.
