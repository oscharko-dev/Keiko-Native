# Keiko Native Code Quality Standard

## Status

Approved language-neutral engineering baseline, 2026-07-16. Stack-specific profiles become
mandatory after the Native host and implementation technologies are selected.

## Purpose

This standard defines how production-ready Keiko Native code is designed and implemented before
automated gates and independent audits evaluate it. Quality gates provide evidence of compliance;
they are not the first place where an engineer or coding agent discovers the applicable rules.

The standard applies to humans and coding agents. An issue may narrow its applicable quality areas
only with an explicit rationale. It may never weaken a product invariant, accepted ADR, trust
boundary, repository gate, or this standard to make delivery easier.

## Quality Planning Lifecycle

### Change Classification

Every epic, issue, and pull request must use one change classification:

- `parity-replacement`: replaces an approved Existing Keiko capability;
- `mandatory-delta`: incorporates an approved security, regulatory, compatibility, or
  critical-correctness change after the parity cut-off;
- `net-new`: adds an approved Keiko Native capability that is not part of replacement parity;
- `hardening`: improves quality, security, accessibility, performance, reliability, or operations
  without changing the approved product outcome;
- `architecture/governance`: creates or changes an enabling architecture or governance contract;
  or
- `defect`: restores accepted behavior or quality after a confirmed deviation.

The classification determines which planning sources and reuse evidence apply; it does not weaken
the Quality Envelope, issue Quality Plan, verification, audit, or Definition of Done. A parity
reference and Existing Keiko Reuse Assessment are mandatory only when Existing Keiko behavior or
material informs the change. A non-applicable field must state why rather than forcing fictional
parity or reuse evidence.

### Epic Creation and Quality Envelope

Every implementation epic must contain a Quality Envelope that identifies:

- affected product capabilities and explicit non-goals;
- the primary user journey and the planning baseline against which it will be accepted;
- owning domains, architecture boundaries, and dependency direction;
- affected trust boundaries, data classes, and privileged effects;
- the Windows and macOS targets in scope and any platform-specific acceptance differences;
- affected UI surfaces and their loading, empty, error, conflict, cancellation, permission, and
  recovery states where applicable;
- applicable accessibility, reliability, performance, resource, security, and recovery
  expectations;
- required quality and evidence classes across its child issues; and
- the integrated release-acceptance path that will qualify the epic on its final head; and
- architecture decisions that are prerequisites or deliberate epic outcomes.

An epic must not present an unresolved decision as an implementation instruction. A decision epic
must define the evidence and decision criteria that will resolve it.

The Quality Envelope scales to the epic's actual surface. It must not require irrelevant UI or
platform evidence, but every implementation epic retains two core obligations:

1. verify the actually wired production composition rather than relying only on mocks, fixtures, or
   isolated components; and
2. produce reproducible machine-evaluated evidence for every automatable release claim rather than
   accepting manual-only, screenshot-only, fixture-only, or self-reported completion.

For a small epic, integrated acceptance may remain an explicit section of the epic. A substantial
epic may assign it to a dedicated final child issue. In either form, the acceptance owner, commands,
platforms, and expected evidence must be known before child implementation begins. An implementation
epic without a complete Quality Envelope fails the Definition of Ready and must not produce
implementation-ready child issues.

### Issue Creation

Every implementation issue must include a Quality Plan containing:

- applicable sections of this standard;
- acceptance criteria for observable behavior and quality attributes;
- affected modules, contracts, trust boundaries, and target platforms;
- expected positive, negative, boundary, failure, and recovery tests;
- deterministic local verification commands;
- required manual, platform, security, accessibility, performance, or visual evidence; and
- explicit exclusions with rationale.

It must also include an Execution Authority naming the authorized repository, exact delivery target,
allowed write scope, additional prohibited paths or actions, authorized external mutations,
credential requirements, merge boundary, and additional stop conditions. Repository-wide defaults
remain in `AGENTS.md`; the issue records only the concrete boundary and deviations.

Missing acceptance criteria or a missing verification command fails the Definition of Ready. If
the issue cannot identify the owning layer or depends on an unresolved decision, stop and triage it
before implementation.

### Acceptance Journeys

Every user-facing epic defines one primary end-to-end Acceptance Journey. A user-facing child issue
references that journey and defines only the observable vertical slice it owns. Each journey records
the actor and goal, preconditions and sanitized data, starting state, user actions or intent,
observable checkpoints, failure and recovery paths, platform differences, and expected automated
and manual evidence. A non-user-facing issue records a reasoned exclusion.

Journeys describe product behavior rather than selectors, DOM structure, function names, or other
implementation details. The issue specifies expected evidence; the pull request records the actual
test, command, artifact, platform observation, and result. The Quality Plan selects the appropriate
component, integration, production-composition, end-to-end, native-platform, accessibility, visual,
or manual method instead of prescribing Playwright for every surface.

Journey enforcement occurs at four boundaries:

1. issue readiness requires a complete journey contract or reasoned exclusion;
2. every locally executable journey check passes before the first push;
3. a draft pull request may collect remote or authoritative-platform evidence; and
4. `Ready for Human Review` and merge require complete automated, manual, platform, and exact-head
   evidence.

### Desktop test automation ownership

The repository owns the supported test harnesses, platform adapters, evidence formats, and
canonical verification commands. An epic or issue selects the applicable test levels and journeys
from that governed toolchain. The implementing agent owns the concrete cases, fixtures, failure
coverage, and smallest useful commands; it does not independently choose a competing foundational
test architecture.

A new foundational test framework, desktop driver, embedded automation service, or release-facing
test capability requires a `Decision & Evaluation` issue and an accepted ADR or equivalent
architecture record. The decision must identify the existing mechanism it replaces or complements,
dependency and supply-chain cost, macOS and Windows support, CI ownership, accessibility exposure,
failure diagnostics, flake controls, migration, and removal.

The host and renderer evaluation must execute the same representative Acceptance Journey for every
candidate and prove renderer interaction, native surface and dialog coverage, process lifecycle,
failure and recovery, and authoritative macOS and Windows evidence. An automatable claim requires a
machine-executable harness. Computer Use, screenshots, and human observation provide complementary
manual, visual, usability, and platform evidence; they are not the sole merge evidence for an
automatable claim.

Automation hooks, embedded drivers, remote-debugging listeners, relaxed security policy, and test
credentials are test-build capabilities only. The production release artifact contains no
test-only automation capability, and release verification must prove that absence before a signed
artifact is accepted. A small black-box journey against the actual release artifact supplements the
instrumented test build.

### Planning Contract Change Control

Every epic and implementation issue has a versioned planning contract. Any contributor may create a
draft. A planning agent working under an explicit planning or grilling task may request readiness
directly after unresolved decisions have been settled; a separate GitHub approval or human comment
is not required. The repository readiness workflow assigns `Implementation Ready` only after
validating the contract and recording its version and semantic fingerprint.

That readiness record freezes the semantic outcome, classification, planning authority, scope,
non-goals, acceptance criteria, Quality Envelope or Quality Plan, interfaces, architecture and trust
boundaries, target platforms, verification and audit obligations, delivery target, and
implementation authority.

After acceptance, a wording-only correction may retain the same version when meaning is unchanged,
but it still requires a new successful readiness validation and fingerprint. Record actual
implementation, verification, or audit evidence in pull requests or issue comments rather than the
frozen issue body. Any semantic change returns the work to planning: increment the contract version,
restore `status: new`, and obtain a new successful readiness validation before implementation starts
or resumes. The implementation and audit must cite the validated version and readiness record so
review can detect contract drift.

The exact delivery target is frozen planning scope because it determines merge authority. The
executing runner chooses a dedicated source branch with its own prefix; the source branch must be
unique to the issue, include its issue number, and be recorded as execution evidence. Changing only
that runner-managed source-branch name does not require a new planning-contract version.

### Implementation Preflight

Before productive code is written, the implementer must confirm that the issue Quality Plan is
complete, consistent with current ADRs and contracts, and executable in the available environment.
Any scope or trust-boundary expansion returns the issue to planning instead of being absorbed into
the implementation.

### Development Loop

Use the fastest deterministic loop that proves the affected behavior:

1. format and static analysis;
2. type checking or compilation;
3. affected unit, contract, architecture, and integration tests; and
4. the smallest applicable security, accessibility, or performance check.

Run the complete repository and target-specific quality suite at meaningful integration milestones
and before the first push. Fast affected checks complement the full suite; they do not replace it.

### Handoff and Independent Audit

Before handoff, review the complete diff against the issue, Quality Plan, relevant ADRs, trust
boundaries, failure modes, and evidence obligations. The independent audit verifies compliance and
finds unanticipated gaps; it must not be used as a substitute for quality planning or the local
development loop.

### Independent Audit Contract

An implementation is audit-ready only when the accepted issue, Quality Plan, implementation diff,
and current-head verification evidence are available. The audit must:

- use the issue acceptance criteria and Quality Plan as its primary checklist;
- inspect the changed runtime paths before proposing fixes;
- evaluate architecture, correctness, regression, security, accessibility, performance, and product
  fidelity according to the affected surface and risk;
- classify only confirmed, evidence-cited findings as blockers and keep speculative observations
  advisory;
- record each confirmed finding as resolved, explicitly accepted by an authorized human, or linked
  to a scoped follow-up that does not invalidate current acceptance; and
- invalidate earlier audit and verification evidence after a fix, then re-run the applicable checks
  against the new exact head.

Agent role selection, orchestration waves, local receipts, and model routing may support this
contract but do not define or replace it.

## Engineering Standard

### Architecture and Ownership

- Give every policy, state transition, privileged effect, and persisted record one owning layer.
- Keep dependencies directed toward stable domain contracts; platform and provider details remain
  behind adapters.
- Prefer the smallest design that satisfies current acceptance criteria and known failure modes.
- Do not create speculative abstractions, parallel governance paths, or duplicated policy.
- Record a new or changed durable architecture boundary in an ADR before relying on it.

### Correctness and Contracts

- Make boundary contracts typed, versioned where compatibility matters, schema-validated, and
  explicit about limits and unknown fields.
- Validate untrusted input before it reaches domain behavior or privileged operations.
- Keep authentication, authorization, validation, and execution as distinguishable decisions.
- Bind mutations to current identity, scope, version, and preconditions; reject stale or replayed
  requests.
- Do not rely on undefined, implicit, locale-dependent, or wall-clock-sensitive behavior.

### Failure and Lifecycle Semantics

- Model cancellation, timeout, unavailability, restart, partial failure, conflict, and recovery as
  product states where applicable.
- Make retries bounded, classified, and safe under idempotency or explicit deduplication rules.
- Preserve the original owning-layer error while returning actionable, redacted diagnostics.
- Do not swallow failures, continue after invalid authority, or turn an unknown state into success.
- Clean up process trees, files, locks, handles, subscriptions, and other owned resources on every
  terminal path.

### Security and Privacy

- Apply least privilege and fail closed at every filesystem, process, IPC, network, credential,
  model, connector, and persistence boundary.
- Treat workspace, model, tool, terminal, repository, and knowledge content as untrusted data, never
  authority.
- Keep secrets, credentials, raw customer content, private endpoints, and PII out of source, tests,
  logs, evidence, artifacts, issues, and pull requests.
- Redact at the producing boundary and persist only the minimum evidence required by the approved
  contract.
- Cover denied, hostile, malformed, oversized, stale, replayed, and partially authorized inputs
  with negative tests where the boundary applies.

### Tests and Verification

- Test observable behavior and contracts rather than implementation trivia.
- Prove bug fixes with a failure-first regression test and fix the whole defect class at its owning
  layer.
- Keep tests hermetic: no real network, shared mutable global state, wall-clock sleeps, or free-port
  assumptions.
- Use deterministic clocks, identifiers, randomness, filesystem roots, process fixtures, and model
  responses.
- Cover positive, empty, boundary, malformed, unauthorized, unavailable, cancellation, and partial
  failure paths in proportion to risk.
- Repository coverage floors are minimum portfolio evidence; they do not excuse uncovered changed
  behavior or critical branches.

### Performance and Resource Use

- Assign measurable budgets before optimizing or introducing a native, concurrent, cached, GPU, or
  background path.
- Benchmark representative workloads on declared reference hardware and record the environment.
- Bound queues, payloads, concurrency, retries, caches, logs, and retained history.
- Demonstrate cancellation and resource return after completion, failure, and restart.
- Reject an optimization that weakens correctness, determinism, security, accessibility, or the
  required fallback.

### User Experience and Accessibility

- Treat loading, empty, unavailable, error, conflict, cancellation, recovery, and permission states
  as designed behavior rather than exceptional leftovers.
- Support keyboard operation, visible focus, semantic state communication, scaling, reduced motion,
  High Contrast, screen readers, and international input where the affected surface applies.
- Do not communicate security, synchronization, or validation state by color alone.
- Generate Native visual, interaction, and accessibility evidence on the affected target platform;
  Existing Keiko evidence cannot close Native acceptance criteria.

### Observability and Evidence

- Make diagnostics actionable, bounded, correlated, and redacted.
- Separate transient content required for operation from durable body-free governance evidence.
- Bind evidence to the producing version, policy, operation, target, and exact result where needed.
- Do not claim success from a processing badge, missing check, stale head, or unrelated producer.

### Dependencies and Supply Chain

- Minimize dependencies and privileged build or runtime surface.
- Pin external automation to immutable revisions and keep lockfiles authoritative.
- Review licenses, advisories, provenance, artifact identity, update behavior, and transitive impact
  before adoption.
- Verify external executables and generated artifacts according to their approved artifact profile.
- Do not weaken a dependency, signing, scanning, or provenance gate to unblock delivery.

### Maintainability and Documentation

- Use professional English for code, identifiers, comments, configuration, documentation, issues,
  pull requests, and evidence.
- Keep functions, modules, interfaces, and state machines cohesive and named in the product
  language.
- Document non-obvious invariants, compatibility behavior, failure semantics, and public contracts.
- Delete dead code and obsolete paths; do not hide required behavior behind TODO or FIXME markers.
- Update affected ADRs, contracts, runbooks, and user-facing documentation in the same change.

## Stack-Specific Profiles

The selected Native stack must add deterministic profiles for formatter, compiler, linter, static
analysis, dependency policy, unsafe or native interop, unit and integration testing, architecture
checks, coverage, packaging, signing, and platform verification. A stack profile may strengthen but
not weaken this baseline.

The first productive-source pull request must declare these commands and targets in
`quality/project.json` and wire the same contract locally and in CI.

## Definition of Ready

Productive implementation must not begin until:

- the readiness workflow marked the current planning-contract version `Implementation Ready` and
  recorded its fingerprint;
- the parent implementation epic has a complete Quality Envelope;
- acceptance criteria and a deterministic verification command exist;
- the issue Quality Plan identifies applicable quality areas and evidence;
- the issue Execution Authority identifies the exact delivery and mutation boundary;
- every user-facing journey is complete and mapped to acceptance criteria and expected evidence;
- owning modules and affected trust boundaries are understood;
- required ADRs are accepted or explicitly produced by a decision issue; and
- the planned scope fits the available platform and test environment.

## Definition of Done

Work is not complete until:

- acceptance criteria and the Quality Plan are satisfied with current-head evidence;
- the parent epic's integrated release-acceptance path is satisfied when the work completes an epic;
- affected and full required quality suites pass;
- security, accessibility, performance, platform, and manual evidence exists where applicable;
- documentation and architecture records match the delivered behavior; and
- independent review findings are resolved or explicitly dispositioned by an authorized human.
