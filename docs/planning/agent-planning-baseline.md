# Keiko Native Agent Planning Baseline

## Status and purpose

Accepted repository planning baseline, revision 1, 2026-07-16.

This document is the repository-owned functional and quality baseline for agents and humans who
create Keiko Native epics, decision evaluations, implementation issues, acceptance journeys, and
Quality Envelopes. It is a deliberately compact projection of the governed private product source,
filtered through the accepted Decision Addendum and the Native greenfield-rewrite boundary.

Planning and implementation do not require access to the private source. The source identity in
`docs/product/source-baseline.md` remains provenance for this projection, not an operational
dependency. This baseline preserves durable product requirements while excluding source-document
history, duplicated rationale, superseded directions, time-sensitive vendor detail, and proposed
technology choices that still require a Native decision.

This document is not a pre-written roadmap or a license to implement every capability at once. The
Parity Ledger controls capability inclusion and disposition. An accepted epic selects the smallest
useful outcome and turns the relevant parts of this baseline into a complete, executable Planning
Contract.

## Authority and planning use

Apply the following authority model:

1. Human-approved product amendments and the Decision Addendum govern product direction, scope,
   replacement strategy, and sequencing.
2. This Agent Planning Baseline governs repository-visible functional and cross-cutting quality
   requirements.
3. Accepted Native ADRs govern technical realization within those product requirements. An ADR
   cannot silently remove or weaken a product requirement.
4. `CONTEXT.md` supplies canonical language and the current projection of accepted decisions.
5. The Parity Ledger governs whether a capability is preserved, transformed, retired, or deferred.
6. An accepted epic and its child issues narrow these authorities into an executable delivery
   contract; they do not override them.

When records conflict, stop planning. Resolve the product conflict through a human-approved
amendment and the technical conflict through an ADR before an issue becomes Implementation Ready.

An epic author must:

1. identify the relevant Parity Ledger row or approved net-new capability;
2. read the global requirements and only the affected capability packets in this document;
3. bind the outcome to one or more acceptance journeys;
4. identify unresolved decision gates before selecting a technology or architecture;
5. inspect Existing Keiko only as versioned behavior, UX, risk, and reuse evidence;
6. record every proposed adoption in a Reuse Assessment;
7. define observable acceptance criteria, failure and recovery behavior, platforms, and evidence;
   and
8. decompose the outcome into small vertical child slices with stable interface contracts.

## Product intent

Keiko Native is an independently implemented, local-first desktop workspace for regulated coding
and knowledge work in German banking and insurance environments. It combines controlled local
knowledge, AI-assisted work, and governed coding agents in one coherent product experience.

The product must help people move from source material or a bounded engineering task to a useful,
reviewable, and verifiable result without losing control of data, authority, provenance, or
delivery. AI and agents are central product capabilities, but they remain inside Keiko-owned policy,
evidence, recovery, and human-control boundaries.

### Primary personas and outcomes

| Persona                         | Primary outcome                                                                 | Critical expectation                                                            |
| ------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Knowledge professional          | Turn confidential local material into attributable knowledge                    | Local control, source clarity, lifecycle visibility, and useful retrieval       |
| Software engineer               | Complete a bounded task across context, agent, editor, tools, and verification  | Fast interaction, stable context, recoverable runs, and no governance dead ends |
| Tech lead or architect          | Understand effects, constraints, and relationships before accepting change      | Explainability, reviewable changesets, and reproducible evidence                |
| Security or compliance reviewer | Verify authority, data flow, audit, and supply-chain controls                   | Least privilege, fail-closed behavior, body-free evidence, and no hidden egress |
| Release or platform engineer    | Build, sign, distribute, update, diagnose, and roll back the product            | Reproducibility, platform evidence, compatibility, and operational recovery     |
| Administrator                   | Govern providers, authentication, network, credentials, and deployment ceilings | Explicit policy, safe defaults, understandable degradation, and revocation      |
| QA or performance engineer      | Qualify user journeys on representative platforms and workloads                 | Deterministic commands, retained measurements, and no unsupported quality claim |
| Knowledge steward               | Govern sources, sensitivity, retention, drift, and reindex decisions            | Correct lifecycle state, visible compatibility, and bounded remediation         |
| Support or operations engineer  | Diagnose failure without collecting customer content                            | Correlated reason codes and redacted, content-free support evidence             |

Across personas, product states, approval reasons, degradation, cancellation, and recovery must be
visible and understandable. A visible result must never depend on an invisible expansion of
authority.

## Product goals and boundaries

### Required outcomes

- Deliver a polished, performant, enterprise-grade native desktop experience on macOS and Windows.
- Preserve or improve every included Existing Keiko user outcome through an independent Native
  implementation.
- Make Agentic Coding a first-class workflow from accepted task through governed delivery.
- Integrate the Codex App Server as the first production coding runtime behind a replaceable,
  Keiko-owned adapter.
- Keep model source and coding runtime source separate so API-backed, BYOK, subscription, and later
  customer-hosted local models fit the same product governance.
- Keep Knowledge owned by Keiko and expose only bounded, attributable context to coding runtimes.
- Join task, agent activity, editor, language intelligence, controlled commands, verification, Git,
  and delivery into a coherent experience.
- Make security, privacy, accessibility, reliability, supportability, and evidence part of feature
  design rather than release-only audits.
- Introduce native or accelerated technology only after a measured capability or performance gap.
- Preserve recognizable Keiko identity while independently implementing a native design system.

### Product transition

Existing Keiko remains a separate application while Native is developed. It is evidence, not a
shared runtime or mandatory source dependency. After Native is operational and approved replacement
criteria are satisfied, Existing Keiko enters maintenance mode followed by a code and feature
freeze under human product control.

### Explicit non-goals for the initial product

- Refactoring, wrapping, or incrementally migrating the Existing Keiko codebase.
- A shared core, shared runtime, or mandatory build-time dependency on Existing Keiko.
- OpenCode support, compatibility, fallback, or migration work.
- Linux as a first-class initial platform.
- Customer-hosted local inference in the first implementation scope.
- A direct embedding of a human-oriented Codex terminal UI or parsing its display output.
- A renderer that talks directly to a coding runtime or a generic native system API.
- A second Knowledge, authority, evidence, editor-mutation, credential, or delivery subsystem.
- A fully native UI or custom editor before a measured and accepted need exists.
- GPU, SIMD, native compute, or local-model dependencies without a deterministic CPU fallback and
  a measured benefit.
- Cloud dependence, hidden telemetry, or uncontrolled customer-data egress.
- Accessibility claims based only on automated scanning.
- Architecture decisions hidden inside feature acceptance criteria.

## Product-wide invariants

### Human control and downhill authority

A local human selects or accepts the task, autonomy mode, Authority Envelope, and deployment
ceiling. Every runtime, subagent, tool, window, and native capability receives the intersection of
the parent authority and its narrower assigned scope. Delegation can only reduce authority.

### Keiko owns product truth

Keiko owns workspace identity, tasks, runs, policy, budgets, approvals, changesets, evidence,
verification, recovery, and delivery. Provider threads, messages, events, and identifiers are
correlation data, not Keiko domain identity.

### One effect, one owning path

Each privileged effect has one owning layer. Editor changes use the governed changeset path;
commands use the command and sandbox boundary; credentials use the secret boundary; Knowledge uses
the Knowledge boundary; delivery uses the repository delivery boundary. A second mutation or policy
path is an architecture defect.

### Strictest effective policy wins

Keiko policy, runtime restrictions, operating-system controls, Knowledge or connector scope,
sensitivity, budgets, and deployment policy are intersected. An inner runtime approval or tool
label cannot widen the outer Keiko decision.

### Content is data, never authority

Repository content, documents, web content, issue text, tool output, model output, terminal output,
and runtime events are untrusted data. They may contribute context but cannot create permissions,
policy, approvals, credentials, or delivery authority.

### Typed, versioned, bounded boundaries

IPC, runtime protocols, MCP tools, editor contracts, persistence, and evidence use generated or
explicit schemas, closed variants at trust boundaries, payload and depth limits, timeouts,
cancellation, compatibility rules, and negative tests. Unknown critical variants fail closed.

### Body-free governance evidence

Governance evidence records identifiers or digests, counts, closed statuses, reason codes,
durations, versions, and policy outcomes. It does not retain prompts, responses, code, patches,
documents, queries, terminal output, credentials, private endpoints, or customer media.

### Recovery is normal product behavior

Crash, reconnect, cancellation, stale state, protocol drift, partial failure, incompatible
checkpoints, update failure, and rollback are explicit states with deterministic user-visible
outcomes. A restart never implies blind retry.

### Measure before specialization

Host choice, native code, Rust, GPU, NPU, WebGPU, SIMD, a custom editor, or a new storage engine
requires a reproducible baseline, representative workload, declared benefit, semantic-equivalence
rule, resource evidence, and fallback.

### Accessibility and international input are architecture requirements

Keyboard, focus, screen readers, High Contrast, zoom, Reduced Motion, scaling, bidirectional text,
and input-method composition must influence host, renderer, editor, and component decisions. Manual
platform testing supplements automation.

### Simplicity is a governed budget

New components, processes, boundaries, options, and configuration must identify the capability gap
they close, why a smaller design is insufficient, what they replace or retire, and how their
security, test, release, and support cost is contained.

## Global acceptance journeys

These journeys are reusable planning anchors. An epic may narrow one journey or combine necessary
parts of several, but it must not silently omit the listed failure and evidence expectations.

### APB-J1 — Local source to attributable knowledge

1. A user selects an allowed local source and assigns it to a governed knowledge space with
   sensitivity and external-use policy.
2. Keiko validates canonical path, type, size, deny rules, and resource budget.
3. Bounded ingestion extracts, normalizes, chunks, fingerprints, indexes, and verifies the source.
4. Partial coverage, missing OCR, unsupported content, and pipeline failure remain distinct visible
   states.
5. Retrieval combines allowed lanes, applies deterministic fusion, and reranks only when policy and
   budget permit it.
6. The product returns bounded passages with stable citation anchors and provenance.
7. Governance evidence contains only safe metadata, not source or result content.

Failure and recovery must preserve the last valid index generation, expose the reason, and offer a
bounded retry, repair, reindex, or retirement path.

### APB-J2 — Governed task to verified changeset

1. A human accepts a task, workspace, mode, Authority Envelope, and deployment ceiling.
2. Keiko validates the envelope and starts a verified coding runtime through its adapter.
3. The runtime lifecycle is mapped to Keiko run, turn, item, and activity state.
4. The runtime receives only task-scoped repository and Knowledge context.
5. Proposed changes pass action classification, whole-action validation, review policy, and
   precondition revalidation before atomic application.
6. Commands and verification execute inside declared policy, sandbox, network, time, and resource
   limits.
7. Git and pull-request delivery use only the repository-owned delivery path and exact-head gates.
8. The user receives a reviewable outcome and body-free evidence.

Completion of a turn or run does not mean that a change is accepted, delivered, or merged.

### APB-J3 — Resume, fork, steer, interrupt, and cancel

An interrupted run may resume only after runtime, schema, authority, credential, and workspace
preflight. A fork creates a new solution line without rewriting completed history. Steering adds
bounded input to an active turn. Interrupt and cancellation propagate through subagents, tools,
commands, indexing, and verification, then confirm process and handle cleanup. Reconnect and replay
must not duplicate approvals, patches, budgets, delivery effects, or evidence.

### APB-J4 — Hostile or manipulative content

Retrieved documents, repository files, issues, tool output, or web content may request secret
access, policy bypass, command execution, or delivery. Keiko labels and bounds that content,
separates it from system and user authority, prevents it from granting tools, and re-evaluates every
resulting effect at the owning boundary. A blocked attempt produces a closed reason code without
retaining the hostile body.

### APB-J5 — Runtime or component crash and controlled recovery

The supervisor detects the failed process and its process tree, blocks new effects, cleans remaining
children, and marks the affected run or capability recoverable, degraded, quarantined, or terminal.
Resume requires a new preflight. Unconfirmed changes or approvals are never applied after recovery.
The user sees a correlated safe diagnosis and an explicit recovery option.

### APB-J6 — Signed desktop release, update, and rollback

Release Engineering produces platform-specific artifacts with digest, signing or notarization,
SBOM, provenance evidence where available, compatibility metadata, and clean-machine verification.
Updates move through download, verification, staging, activation, health check, and rollback as
separate states. Customer content and runtime state are not product artifacts. A failed update
cannot damage the last known-good installation or silently downgrade policy or state.

### APB-J7 — Governed first run

The first-run experience guides a user through workspace selection, authentication or model-source
configuration, initial Knowledge setup when applicable, authority explanation, and the first bounded
run. It never bypasses consent, credential, network, or Authority Envelope gates to appear simpler.
Offline, unavailable, and policy-denied states remain explicit and recoverable.

## Logical ownership and dependency direction

| Layer                                 | Owns                                                                             | Must not own or bypass                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Native UI and editor views            | Presentation, user input, view state, accessible interaction                     | Runtime process control, generic OS access, secrets, policy, or delivery |
| Application and agentic control plane | Tasks, runs, policy, budgets, approvals, orchestration, recovery                 | Unvalidated privileged effects                                           |
| Coding runtime port and adapters      | Runtime lifecycle, capability translation, event projection                      | Product identity, authority widening, UI-specific contracts              |
| Editor control plane                  | Versioned changesets, preconditions, atomic apply, reconciliation                | Ungoverned direct runtime writes                                         |
| Knowledge engine                      | Ingestion, stores, retrieval, graph, lifecycle, citations                        | Agent or delivery authority                                              |
| Knowledge capability boundary         | Task-scoped tools, claims, bounded content, provenance                           | Global enumeration, mutation, implicit scope widening                    |
| Native host                           | Windows, processes, sandbox, credential handles, file picking, windowing, update | Domain policy, model routing, Knowledge semantics, delivery decisions    |
| Verification and evidence             | Deterministic checks, redacted outcomes, effect receipts                         | Customer-content archives or a second approval system                    |
| Repository delivery                   | Branch, pull request, exact-head checks, merge boundary                          | Direct `dev` mutation or agent merge into `dev`                          |

The renderer communicates with Keiko application ports, not directly with the Codex App Server or
native host. Native APIs are narrowly named product capabilities rather than generic `execute`,
`read`, or `invoke` methods.

## Codex integration contract

The Codex App Server is the required first production Agentic Coding runtime because it exposes a
structured rich-client protocol. A human-oriented terminal UI, its display stream, or terminal
emulation is not a product protocol.

The Keiko adapter must:

- resolve and verify an exact platform-compatible runtime artifact before process start;
- start it without a shell, with a Keiko-owned state root, an allowlisted environment, bounded
  stdin, stdout, and stderr handling, and contained working and executable paths;
- perform the supported initialization handshake exactly once per connection before other protocol
  work;
- map runtime threads to Keiko runs while keeping both identities distinct;
- support the accepted start, resume, fork, turn, steer, interrupt, approval, authentication,
  streaming, completion, and stop lifecycle exposed by the pinned runtime version;
- generate or vendor the exact protocol schemas for the shipped runtime and classify additive,
  breaking, unknown, malformed, duplicate, out-of-order, and oversized messages;
- correlate requests, responses, notifications, items, and deltas without persisting raw
  protocol content as product truth;
- enforce backpressure, queue and payload limits, timeouts, cancellation, idempotency, and bounded
  recovery;
- translate approvals into Keiko action, scope, risk, policy, and one-use approval semantics;
- route every file change, command, Knowledge request, verification request, and delivery action to
  its Keiko-owned boundary; and
- terminate the complete process tree and confirm cleanup after normal stop, timeout, crash, or
  forced escalation.

Runtime capabilities are negotiated. A method existing in an upstream schema is not enough: Keiko
exposes it only when the exact version is supported, conformance-tested, policy-allowed, and
budgeted. Experimental or newly added methods require explicit compatibility, security, fallback,
and product review. Current upstream details are reverified from primary vendor documentation and
the pinned binary during the relevant decision or implementation issue rather than frozen here.

## Knowledge-to-coding capability boundary

Coding runtimes access Knowledge through a thin local capability boundary over the Keiko Knowledge
engine. The boundary does not own retrieval, policy, synthesis, or product governance and never
grants direct store access.

The initial contract may provide bounded operations equivalent to search, passage retrieval,
citation resolution, related-artifact traversal, policy-context lookup, and symbol-context lookup.
Names and schemas are decided in the owning contract issue. Extractive, citation-bearing passages
are the default; synthesis remains in the calling product flow.

Every call is server-side bound to non-overridable claims for run and Authority Envelope identity,
task, workspace, allowed Knowledge spaces and sources, sensitivity ceiling, external-use policy,
allowed operations, result and byte or token budgets, deadline, expiry, cancellation, and runtime or
subagent identity. A request outside those claims is denied rather than returned as an ambiguous
empty result.

Responses separate transient untrusted content, UI provenance and citations, body-free governance
evidence, and closed omission or degradation reasons. They have hard item, byte, depth, time, and
tool-call limits. The Knowledge boundary exposes no command, editor mutation, credential, or
delivery capability. Its local transport should require no listening network port unless an
accepted decision proves a need and supplies equivalent authentication and isolation.

## Data and evidence contract

| Data class             | Examples                                                | Allowed handling                                                                                   |
| ---------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Secret                 | Tokens, keys, passwords, private credentials            | OS credential store or approved secret provider; never renderer state, logs, or evidence           |
| Sensitive content      | Documents, repositories, prompts, answers, diffs        | Bounded transient handling or encrypted domain storage with retention and erasure                  |
| Operational content    | Runtime messages, command output, temporary diagnostics | Bounded transient use; separately governed encrypted diagnostics only when justified               |
| Provenance             | Source, chunk, run, thread, artifact identifiers        | Keiko domain state with access control and safe projection                                         |
| Evidence-safe metadata | Digests, counts, statuses, reason codes, durations      | Versioned evidence and audit stores                                                                |
| Public product data    | Versions, schemas, licences, release metadata           | Signed release manifests and product documentation                                                 |
| Captured media         | Camera, microphone, screen, image attachments           | Transient and on-device by default; encrypted only under a separate content policy; never evidence |

Every mutating, externally observable, or irreversible effect requires an Effect Receipt that binds
the action, resource and precondition digest, authority and approval outcome, expiry, idempotency
key, execution outcome, postcondition digest, verification status, reason code, and correlation ID.

## Capability planning packets

Each packet defines durable planning inputs. It does not authorize one large epic; authors must
select a small vertical outcome and explicitly defer the rest.

### Desktop lifecycle, installation, update, repair, and removal

- Support first-class macOS and Windows installation, launch, update, rollback, repair, and clean
  removal with platform-authoritative evidence.
- Keep product payload, user configuration, credentials, Knowledge state, content history, and
  evidence as separate lifecycle and backup classes.
- Bind every shipped host, web asset, runtime, native module, model, and update manifest to its
  version, digest, compatibility, licence, SBOM, and strongest available publisher or provenance
  evidence.
- Never perform an unverified first-run or post-install download of executable code or model
  artifacts.
- Preserve the last known-good version when update verification, activation, or startup fails.
- Require clean-machine install, update, rollback, and uninstall evidence before release.

### Workspace shell, projects, window state, navigation, and recovery

- Treat a canonical workspace root as an immutable authority identity; validate real paths before
  reads and immediately before effects.
- Provide a coherent desktop shell for projects, navigation, state, editor and tool surfaces,
  activity, approvals, and recovery without exposing provider-native UI as the product.
- Persist only defined recoverable view and application state; do not infer that renderer state is
  authoritative after a crash.
- Keep window, workspace, run, and credential ownership in one Keiko control plane. A second window
  or process cannot borrow another context's authority.
- Design loading, empty, unavailable, conflict, cancellation, permission, and recovery states for
  every shell surface.
- Multi-window and concurrent-workspace behavior require the relevant decision gate and explicit
  resource, isolation, approval-routing, and crash-recovery evidence.

### Model configuration, provider discovery, BYOK, and governed egress

- Keep coding runtime source and model source distinct in contracts, UI, policy, and evidence.
- Support approved API-backed providers, bring-your-own-key configuration, and the required Codex
  subscription or authentication profiles without treating one as a generic substitute for
  another.
- Use secure input and opaque credential handles; never place secrets in command lines, URLs,
  clipboard history, renderer state, logs, evidence, or support bundles.
- Make provider, account or workspace binding, external-use policy, network or custom-CA state,
  quota, and degradation visible without exposing secret values.
- Local model inference on customer-controlled hardware is a planned later capability behind the
  same model-neutral boundary. Initial epics preserve the seam but do not implement local inference.
- Never fall back to a different provider or authentication method without user or deployment
  policy.

### Conversations, chat history, streaming, context, and grounding

- Present coherent conversations with bounded streaming, visible source and model provenance,
  context inspection, cancellation, retry, and degraded states.
- Distinguish chat or retained content from governance evidence. Retained content requires a
  separate encrypted store, access policy, retention, deletion, backup, and user-visible control.
- Ground claims in the exact selected context and citations; do not claim sources that were not in
  the context pack.
- Keep completed turns immutable. Direction changes use a new turn or fork rather than rewriting
  accepted history.
- Bound event buffers and update frequency so streaming does not make the UI inaccessible or
  unresponsive.

### Knowledge ingestion, document lifecycle, and source management

- Model governed Knowledge spaces, sources, documents, parsed units, chunks, index generations,
  embedding identities, citations, relationships, and retrieval runs explicitly.
- Use a bounded pipeline: discover, preflight, fingerprint, quarantine, parse, normalize, chunk,
  build lexical and semantic lanes, relate, verify, and atomically publish.
- Keep the last verified generation active until a replacement generation passes verification.
- Represent at least discovered, quarantined, indexing, partial, active, stale, reindexing,
  cancelled, failed, retired, and purged lifecycle behavior.
- Process large documents incrementally with checkpoints, bounded queues, byte and time budgets,
  cancellation, compatibility fingerprints, and safe resume.
- Distinguish unsupported or missing OCR, partial extraction, and a failed ingestion pipeline.
- Support targeted refresh and repair, re-embedding, and full rebuild as distinct operator actions.
- Retire sources from new retrieval before purge; purge covers content, indexes, vectors, graph
  edges, checkpoints, temporary files, backups under policy, and memory or accelerator buffers.
- Disclose and test any residual unencrypted projection; never claim complete at-rest encryption
  when an index remains reconstructive or plaintext.

### Hybrid retrieval, ranking, citations, and retrieval quality

- Provide lexical and semantic candidate lanes with shared scope, sensitivity, result, token, byte,
  time, and compute budgets.
- Fuse heterogeneous lanes deterministically; do not compare incompatible raw scores or embedding
  spaces as though they were equivalent.
- Keep exact and stable tie-breaking identities. Configuration changes that affect ranking are
  versioned and evaluated for drift.
- Reranking is optional, works only on already allowed candidates, and cannot reintroduce a filtered
  source, reduce sensitivity, or change citation provenance.
- Timeout or unavailable reranking degrades to the deterministic fused order with a visible reason.
- Citations bind stable source, document, chunk or span identity, safe display label, position,
  digest, parser or index generation, provenance, and access decision.
- Evaluate relevance, fusion diversity and stability, citation precision and completeness,
  faithfulness, unsupported claims, hostile-query containment, lifecycle correctness, latency, and
  sensitivity leakage on a versioned synthetic corpus.
- Treat contextual enrichment, query decomposition, approximate indexes, quantization, and local
  rerankers as measured, versioned options rather than automatic architecture.

### MemoriaViva governed memory

- Preserve long-term governed memory as a domain separate from document-oriented Knowledge spaces.
- Retain capture policy, scope, encryption, consolidation, recall, decay, forgetting, diagnostics,
  deletion, and body-free audit outcomes.
- Share only stable contracts such as model, embedding, redaction, or evidence semantics where that
  avoids duplication; do not merge the stores or create a second memory implementation.
- An epic must distinguish user-authored or approved memory from inferred or automatically captured
  material and make correction and forgetting observable.

### Knowledge relationships and graph-backed context

- Treat relationships as an additive retrieval and explanation capability, not a second source
  store.
- Bind every relationship to endpoints, type, provenance or extraction method, confidence,
  generation, sensitivity inheritance, and deletion or drift behavior.
- Keep deterministic relationships distinguishable from model-inferred relationships.
- Never present an inferred edge as verified fact without attributable evidence.

### Quality Intelligence

- Preserve the workflow from requirements and evidence to candidate tests, traceability, coverage
  or gap analysis, drift detection, human editing, review, and governed export.
- Keep generated tests and findings attributable to source requirements and model or rule versions.
- Make uncertainty, unsupported claims, exclusions, and human changes visible.
- Export only through explicit formats and authority; ingestion or analysis never implies write
  access to an external quality system.

### Prompt Enhancer

- Preserve a governed workflow that makes the original input, proposed enhancement, relevant
  context, policy effects, and user choice understandable.
- Enhancement output is untrusted content, not a permission or hidden system-policy change.
- The user can inspect, edit, accept, reject, or revert the proposal before it affects a task.
- Provider access, context selection, retention, and evidence follow the same model and data
  boundaries as other AI-assisted flows.

### Figma snapshot and design-source integration

- Treat design-source intake as a read-only, versioned snapshot with provenance, bounded assets,
  accessibility information, and explicit freshness or drift state.
- Preserve design-to-test and design-to-code evidence without allowing a design source to create
  implementation authority or silently modify product code.
- Revalidate licences, assets, tokens, accessibility, and platform behavior before Native adoption.
- Record every adopted or adapted design artifact in the Design Adoption Ledger and generate new
  Native visual and accessibility evidence.

### GitHub, Jira, and governed external coding-context intake

- Import only the repositories, issues, requirements, metadata, and attachments allowed by
  connector scope and purpose.
- Preserve source identity, version or update time, provenance, sensitivity, and omission reasons.
- Treat imported text and attachments as untrusted content.
- Read access never implies comment, status, branch, pull-request, or merge authority; each external
  mutation requires a separately named capability and approval or delivery contract.
- Connector failure, partial access, revocation, rate limits, and stale context must be visible and
  recoverable.

### Agentic Coding and coding-run lifecycle

- Model task, workspace, Authority Envelope, Keiko run, runtime thread, turn, item, changeset,
  verification run, and delivery attempt as separate identities and lifecycles.
- Support create, start, stream, approve or deny, apply, verify, resume, fork, steer, interrupt,
  recover, stop, and terminal outcomes without equating completion with delivery.
- Integrate the Codex App Server through generated or version-pinned protocol contracts and a
  replaceable Keiko runtime port. Do not scrape terminal presentation output.
- Start only an allowed runtime artifact in a Keiko-owned state root with an allowlisted
  environment, bounded pipes, no shell interpolation, payload limits, timeouts, and process-tree
  cleanup.
- Map runtime events to canonical, redacted Keiko state before persistence or UI use.
- Bind subagents to explicit roles, tasks, parent identity, budgets, and authority no broader than
  the parent. Reclassify all resulting effects at the parent boundary.
- Show understandable agent and subagent activity, scope, progress, outcome, and failures without
  requesting or displaying hidden reasoning.
- Keep the renderer, runtime, editor-mutation, command, Knowledge, and delivery boundaries separate.

### Editor, files, terminal, browser, language intelligence, and debugging

- Provide local files, editor and diff views, diagnostics, completion, navigation, rename, code
  actions, formatting, repository search, and other language services through governed ports.
- Keep editor view state separate from filesystem authority, patch application, verification,
  evidence, Git, and delivery.
- Route every agent-originated edit through version and digest preconditions, whole-action
  validation, optional human review, revalidation, atomic apply or rollback, and UI reconciliation.
- Load editor assets locally with no CDN fallback and no direct model, Knowledge, telemetry, or
  runtime egress from the renderer.
- Treat Monaco as a strong evidence-backed hypothesis, not an automatic source reuse decision. The
  Native editor and host choice must be ratified with performance, accessibility, IME, large-file,
  packaging, and support evidence.
- Keep bounded, non-interactive command execution as the safe baseline until a supervised PTY is
  accepted through its decision gate. A PTY must preserve containment, action classification,
  cancellation, output limits, process-tree cleanup, and evidence rules.
- Keep human-governed debugging separate from agent authority unless a later accepted decision
  explicitly maps and tests agent-driven debugging.
- Embedded browsing is a separate untrusted-content capability, never a privileged product
  renderer or an implicit agent tool.

### Governed changesets, Git, pull requests, and merge delivery

- Represent changes as bounded, reviewable, conflict-aware changesets with complete file-level
  preconditions and atomic outcomes.
- Separate local change acceptance, verification, commit, push, pull request, review settlement,
  and merge as distinct states.
- Require deterministic local verification and exact-current-head repository checks before a pull
  request can be accepted.
- Agents may use the existing authenticated maintainer credential only through the repository-owned
  guarded operation for a green child pull request whose exact accepted `epic/**` target matches
  its pull-request base. The guard revalidates current issue authority,
  `status: ready for human review`, exact current head and base, evidence, findings, and
  conversations; submits at most once; verifies the target tip and ordered parents; and never uses
  provider auto-merge. Missing or changed authority fails closed. An ambiguous result causes no
  retry and requires human reconciliation. Shared GitHub attribution cannot distinguish agent and
  human actions and is an accepted residual risk, not a wider grant.
- Agents must never merge, enable auto-merge, enqueue, push, or update `dev`, `main`, or
  `release/**`, including through the existing authenticated maintainer credential.
- Every merge into `dev`, from an epic or standalone issue, is initiated manually by Niko or
  Oscharko after human review and green CI. No automated principal may merge, enable auto-merge,
  enqueue, or directly push to `dev`.
- Deny force push, gate bypass, finding dismissal for green status, branch-scope expansion, and
  credentials that permit a runtime to bypass the Keiko delivery path.

### Verification, evidence, audit, redaction, and effect receipts

- Verify behavior at the owning layer with unit, contract, architecture, integration, end-to-end,
  security, accessibility, performance, resilience, and release evidence proportional to risk.
- Preserve the first deterministic failing reproduction of a defect before its fix.
- Separate transient product content, retained user content, diagnostics, and governance evidence
  by type, storage, retention, access, and export policy.
- Validate and redact at ingestion into the evidence boundary; later log scrubbing is insufficient.
- Correlate UI, runtime, host, Knowledge, verification, and delivery events with non-secret,
  run-bound identifiers.
- Require an Effect Receipt for mutating, external, or irreversible actions and test replay,
  TOCTOU, idempotency, and postcondition binding.
- An audit must test the declared acceptance criteria and Quality Plan, resolve confirmed findings,
  and refresh evidence after the last fix.

### Voice input and interaction lane

- Treat voice as an input and interaction lane that uses existing task, model, policy, evidence, and
  human-control boundaries rather than creating a separate authority domain.
- Make recording state, consent, active capture, cancellation, transcription status, correction,
  and failure visible and accessible.
- Treat audio and transcripts as sensitive content; do not place them in governance evidence.
- Any external transcription or model egress requires explicit provider, sensitivity, and
  external-use policy.

### Settings, credentials, security policy, sandboxing, and approvals

- Keep one central policy model for user, deployment, workspace, runtime, tool, network, connector,
  sensitivity, budget, and delivery constraints.
- Support modes equivalent to ask for approval, approve within bounded policy, and full access only
  inside the accepted Authority Envelope; delivery remains separately governed in every mode.
- Enforce an outer Keiko and host boundary in addition to any inner runtime sandbox or approval
  policy.
- Bind approvals to one exact action, resource, digest, scope, user, expiry, and use. Revalidate
  immediately before effect and require a new decision when any binding input changes.
- Deny invalid or expired authority, workspace escape, sensitive-path access, secret probing or
  exfiltration, unsupported action or protocol variants, exhausted budgets, unverified artifacts,
  unauthenticated non-local listeners, policy-invalid native capture, and direct delivery.
- Use OS credential stores or approved secret providers with opaque handles and explicit
  unavailable or headless behavior. Never silently downgrade to weak storage.
- Start runtime and verification processes in platform-enforced, workspace-bounded isolation to the
  extent claimed by the product, with deny-by-default network egress and negative escape tests.

### Diagnostics, health, support evidence, and operational recovery

- Use the same closed health and reason-code language across UI, diagnostics, support bundles,
  evidence, and runbooks.
- Support bounded local health checks, repair guidance, and component-level degraded, unavailable,
  quarantined, retryable, and terminal states.
- Support bundles may include versions, digests, platform metadata, safe counts, time ranges, and
  reason codes, but never customer documents, code, prompts, responses, diffs, command output,
  credentials, or private endpoints.
- Separate backup and restore treatment for product payload, configuration, credentials, Knowledge,
  retained content, and evidence. Restore verifies schema, key availability, and manifest integrity.
- Maintain runbooks for runtime or authentication failure, process leak or sandbox escape, store
  corruption or wrong key, protocol incompatibility, update or signing failure, credential exposure,
  retrieval leak, editor conflict, delivery incident, and any enabled high-sensitivity native
  capability.

## Native capability contract

Every native capability uses one common contract:

1. typed request and response schemas;
2. action class, resource scope, timeout, cancellation, and budget mapping;
3. platform permission and human-consent behavior;
4. data minimization, purpose binding, retention, and erasure;
5. body-free audit projection; and
6. deny-by-default egress rules.

Standard candidates include file or folder picking, controlled drag and drop, validated external
URL handoff, notifications, clipboard operations, and deep links. High-sensitivity candidates such
as camera, microphone, screen capture, embedded browsing with credentials, and credential-vault
access require explicit product need, their own threat model, visible and revocable consent, active
state indication, negative tests, and a separate decision gate.

The system picker or consent prompt binds only the exact selected resource or session. Dropped,
captured, downloaded, clipboard, deep-link, and web content remains untrusted. No native capability
may expose a generic privileged bridge.

## Multi-window, concurrency, and resource isolation

- A window is a renderer view and scoped IPC endpoint, not a policy, state, or credential owner.
- Every effect validates authenticated sender, window identity, origin, workspace binding, and the
  effective Authority Envelope.
- Windows do not communicate directly or share another window's capability, approval, browser
  session, or credential state.
- Runs remain core-owned. Observing a run does not authorize steering or approval.
- Rebinding a window to another workspace is an explicit human action that invalidates stale
  approvals and capability state.
- Parallel agent runs against one repository require separately contained workspace identities and
  a governed reconciliation path; they are not implied by multi-window support.
- Window count, renderer and browser processes, editors, runs, RSS, GPU memory, handles, and cleanup
  require per-window and aggregate budgets with a memory-return gate.

Multi-window and parallel-worktree behavior remain decision-gated. Initial architecture must avoid
choices that make isolation impossible but must not implement the full capability speculatively.

## Local models and adaptive acceleration

Customer-hosted local models are a later product capability. They must use the same model source,
policy, budget, egress, evidence, and runtime-adapter boundaries as API-backed models. The product
must be able to connect to an approved local endpoint or supervised local runtime without granting
that model product authority.

When local inference is introduced:

- model and tokenizer artifacts are treated like executable supply-chain inputs and are pinned,
  verified, bounded during parsing, and never downloaded implicitly;
- the model runs within declared filesystem, credential, network, memory, compute, and retention
  limits;
- output remains untrusted data and cannot override sensitivity, provenance, policy, or tool scope;
- the CPU path remains the deterministic correctness and availability baseline;
- SIMD, GPU, or NPU paths are additive and require measured benefit, semantic tolerances, resource
  return, device-loss recovery, and deterministic fallback;
- runtime, model, quantization, execution provider, and embedding identity are versioned so
  incompatible results are never mixed silently; and
- local operation does not justify a weaker supply-chain, privacy, accessibility, or audit bar.

The initial implementation must preserve these seams but exclude local-model delivery, hardware
tiering, and accelerator-specific code from its scope.

## Cross-cutting quality contract

### Security and privacy

- Least privilege, fail-closed behavior, workspace containment, deny-by-default egress, explicit
  external use, and no hidden telemetry are mandatory.
- Threat models cover renderer compromise, IPC confused deputy, malicious workspaces, path and
  symlink races, prompt injection, secret exfiltration, binary substitution, protocol drift,
  approval replay, TOCTOU, process escape, local daemon access, update attacks, evidence leakage,
  and multi-agent privilege aggregation.
- Local-first does not mean offline-only; every external provider or connector crossing remains
  visible, scoped, consented where required, and policy-controlled.
- Erasure covers source content, indexes, vectors, graph data, caches, temporary files, retained
  content, and memory or accelerator buffers according to data class.

### Accessibility and international input

- Target WCAG 2.2 AA for web-rendered UI and map applicable EN 301 549 desktop, documentation, and
  support requirements before release.
- Test complete keyboard use, visible and unobscured focus, focus order and recovery, semantics,
  live regions, High Contrast, color independence, zoom, scaling, Reduced Motion, target size,
  corrective errors, and accessible authentication and approval flows.
- Streaming and activity surfaces provide meaningful summaries without screen-reader delta spam.
- Test NVDA and JAWS on supported Windows paths and VoiceOver on supported macOS paths; automation
  supplements but never replaces manual assistive-technology evidence.
- Test CJK, Korean, Indic, Arabic and Hebrew bidirectional input, dead keys, emoji and grapheme
  navigation, composition-aware completion, undo, copy and paste, and UTF offset mapping.

### Reliability and recovery

- Give each long-lived process, pipeline, and effect an explicit state machine, timeout,
  idempotency boundary, cancellation contract, cleanup contract, and terminal outcome.
- Isolate renderer, host, runtime, subagent, command, language service, Knowledge, database,
  credential, provider, update, and optional native-capability failures where safe.
- Keep last valid state active when a replacement generation or update fails.
- Use bounded restart with backoff, jitter, attempt limits, quarantine, and visible reason codes.
- Confirm process-tree and handle cleanup; sending an interrupt is not proof of termination.
- Never auto-apply an unconfirmed runtime item after a crash or replay an approval against changed
  state.

### Performance and resource budgets

The following are initial planning targets, not immutable SLOs. They must be calibrated on declared
macOS and Windows reference hardware with versioned workloads and raw data. Calibration cannot hide
a poor implementation; a changed target requires evidence and a recorded decision.

| Metric                                           | Initial target                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Cold start to stable visible shell               | p50 at most 1.5 s; p95 at most 3 s                                                  |
| Warm start                                       | p95 at most 1 s                                                                     |
| Editor key-to-paint                              | p75 at most 33 ms; p95 at most 50 ms                                                |
| Repeating main-thread work while typing          | no recurring task above 50 ms                                                       |
| Runtime event to committed UI update             | p95 at most 100 ms                                                                  |
| Local lexical retrieval                          | p95 at most 150 ms on the reference corpus                                          |
| Local hybrid retrieval without an external model | p95 at most 500 ms on the reference corpus                                          |
| Approval request to usable UI                    | p95 at most 250 ms                                                                  |
| Keiko overhead to first visible agent activity   | p95 at most 2 s, provider time reported separately                                  |
| Normal runtime shutdown                          | at most 5 s before controlled escalation                                            |
| Indexing and long-running work                   | no blocking product UI                                                              |
| Resource return                                  | bounded return after closing windows, editors, runs, processes, and compute buffers |

Measure distributions rather than anecdotes; separate cold, warm, first-run, and steady state;
record hardware, OS, display, scaling, power and thermal conditions; and do not treat virtualized CI
as the sole desktop-performance authority.

### Desktop acceptance automation

- The repository owns the supported harnesses, platform adapters, evidence formats, and canonical
  commands. Epics and issues choose applicable journeys and test levels; agents implement within
  that governed toolchain.
- A new foundational runner, driver, embedded automation service, or release-facing test capability
  requires an evidence-backed decision and accepted architecture record rather than an incidental
  feature dependency.
- Host candidates must run the same representative journey across renderer, application port,
  host, native surface, process lifecycle, and recovery boundaries on macOS and Windows.
- Automatable outcomes require machine-executable evidence. Computer Use and human observation
  supplement visual, usability, accessibility, native-dialog, and installed-product evidence but
  do not replace an available deterministic check.
- Test-only drivers, remote-debugging listeners, relaxed policies, credentials, and instrumentation
  must be absent from the production release artifact. Release acceptance proves that absence and
  executes a bounded black-box journey against the actual artifact.

### Verification and release evidence

An affected epic Quality Envelope selects from:

- unit tests for policy, state, parsing, mapping, and limits;
- contract and compatibility tests for every typed boundary;
- property or fuzz tests for paths, framing, Unicode, patches, artifacts, and untrusted formats;
- integration tests with controlled fakes and representative real local components;
- end-to-end journeys from Knowledge to citation and task to verified changeset;
- security tests for scope bypass, injection, secrets, symlinks, IPC identity, sandboxing, consent,
  egress, replay, and cleanup;
- automated and manual accessibility, visual, IME, and platform tests;
- performance, resource-return, energy, and bounded-capacity tests;
- resilience tests for crash, timeout, cancellation, reconnect, disk pressure, unavailable
  providers, incompatible state, and deterministic fallback; and
- release tests for package surface, licences, SBOM, signing, update, rollback, and clean-machine
  operation.

Existing Keiko evidence can identify expected outcomes and known risks. It cannot satisfy Native
implementation, security, accessibility, performance, platform, or release acceptance.

## Decision gates

An epic must not encode an unresolved decision as fact. Use a `Decision & Evaluation` issue and an
accepted ADR or product record when the selected outcome depends on one of these gates.

| ID     | Decision gate                                                     | Current boundary                                                                              | Required evidence before acceptance                                                                                        |
| ------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| APD-01 | Native host and renderer technology                               | Tauri, Electron, or a narrowly scoped custom host remain candidates                           | Equal workload for security, startup, RSS, editor, A11y, IME, test automation, update, signing, recovery, and support cost |
| APD-02 | Application-to-host boundary                                      | Typed host IPC, protected loopback application APIs, or a minimal hybrid                      | Threat model, origin and sender tests, payload limits, ownership, latency, and failure isolation                           |
| APD-03 | Codex App Server transport                                        | Local stdio is the safe default; a local socket requires demonstrated need                    | Protocol conformance, listener authentication, lifecycle, multi-window need, and negative network tests                    |
| APD-04 | Codex authentication and credential backends                      | Subscription, API key, access-token, and supported browser or device flows remain distinct    | Customer and admin needs, OS-store behavior, revocation, headless failure, and secret-leak tests                           |
| APD-05 | Platform sandbox enforcement                                      | macOS and Windows require platform-specific outer containment in addition to runtime controls | Threat model, reuse assessment, escape, network, cleanup, host-compatibility, update, and uninstall tests                  |
| APD-06 | Runtime artifact acquisition, verification, and update            | No PATH trust or unverified download; evidence differs by platform                            | Digest, signing or notarization, available provenance, compatibility, substitution, downgrade, and rollback tests          |
| APD-07 | Terminal strategy                                                 | Bounded command execution is baseline; supervised PTY is optional                             | User need, containment, shell and environment policy, output bounds, cancellation, process tree, and A11y                  |
| APD-08 | Editor and design-system technology                               | Preserve outcomes and Keiko identity; do not copy the web implementation automatically        | Native design adoption record, large-file, performance, A11y, IME, packaging, and maintenance evidence                     |
| APD-09 | Retained conversation and run content                             | Governance evidence remains body-free                                                         | User need, encrypted store, access, retention, deletion, backup, support, and privacy assessment                           |
| APD-10 | Knowledge capability protocol and contracts                       | A thin local tool boundary over Keiko Knowledge; no duplicate engine                          | Versioned schemas, scope claims, injection tests, citation roundtrip, payload limits, cancellation, and drift plan         |
| APD-11 | Reference hardware, corpus, and calibrated budgets                | Both first-class platforms require representative authority                                   | Reproducible workload, raw distributions, power and thermal conditions, and approved target changes                        |
| APD-12 | Signing, distribution, and enterprise rollout                     | Direct download, store, and managed enterprise distribution may differ                        | Customer channels, certificates, MDM needs, clean-machine evidence, SBOM, provenance, update, and rollback                 |
| APD-13 | Native capability and consent scope                               | Standard capabilities precede high-sensitivity capture or browsing                            | Product need, consent, OS granularity, active indication, egress, redaction, negative tests, and support plan              |
| APD-14 | Multi-window and parallel workspace policy                        | Isolation must remain possible; full support is not an initial assumption                     | Single-owner state, window identity, authority isolation, approval routing, resource budgets, and crash tests              |
| APD-15 | Customer-hosted local models and adaptive hardware                | Deferred; initial architecture preserves only the model-neutral seam                          | Model/runtime profile, artifact trust, accuracy, resources, privacy, fallback, semantic drift, and support cost            |
| APD-16 | Optional inline AI, workspace checkpoints, and parallel worktrees | Deferred until the integrated workspace proves a user need                                    | No second mutation path, human acceptance, restore preconditions, containment, reconciliation, and UX evidence             |

Resolved product directions must not be reopened inside these gates: macOS and Windows are the
initial platforms; Linux is deferred; Codex App Server is the first runtime behind a neutral Keiko
boundary; OpenCode is retired; the repository is a greenfield implementation; local inference is
later scope; and Existing Keiko remains separate until the Native replacement transition.

## Risk prompts for epic authors

Every epic considers the applicable risks and records a prevention or evidence response:

| Risk class                             | Required planning response                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Authority or scope widening            | Name the owning boundary, action class, resource identity, approval binding, revalidation, and hard denials                       |
| Renderer or IPC compromise             | Use a narrow bridge, authenticated sender and origin, local bundled content, default-deny navigation, and negative tests          |
| Workspace escape or stale apply        | Use canonical paths, symlink and junction tests, immutable root identity, digest or version preconditions, and atomic rollback    |
| Prompt or tool injection               | Label untrusted content, separate policy, minimize tools, deny authority creation, recheck effects, and use hostile fixtures      |
| Secret or sensitive-content leakage    | Define data classes, handles, egress, logs, evidence, retention, deletion, and support-bundle exclusions                          |
| Protocol or schema drift               | Pin compatibility units, generate schemas where possible, fail closed on critical unknowns, and maintain replay and upgrade tests |
| Runtime or artifact substitution       | Resolve contained paths, verify platform evidence and digest, deny writable artifacts, and test downgrade and replacement         |
| Process leak or crash loop             | Supervise the full tree, propagate cancellation, bound restart, quarantine repeated failure, and prove resource return            |
| Data or index corruption               | Use transactions, atomic generations, compatibility fingerprints, last-good state, repair, restore, and purge evidence            |
| Update or rollback failure             | Separate verification, staging, activation, health, and rollback; protect state and last-good product bytes                       |
| Accessibility or IME regression        | Declare platform and assistive-technology journeys, manual evidence, composition behavior, focus recovery, and release coverage   |
| Native consent or capture failure      | Require exact resource binding, visible consent and active state, deny-by-default egress, no hidden persistence, and revocation   |
| Cross-window or concurrent-run leakage | Bind identity and authority per sender and workspace, isolate state, serialize or contain mutation, and cap resources             |
| Performance or resource debt           | Declare representative workload, distribution targets, memory return, platform authority, fallback, and measurement artifacts     |
| Supply-chain or licence drift          | Pin dependencies and artifacts, record licences and SBOM, verify provenance where available, and define patch ownership           |

## Sequencing constraints

The following order prevents implementation from outrunning authority and evidence:

1. establish repository planning and quality contracts;
2. resolve only the decisions required for the smallest Native foundation slice;
3. prove a minimal desktop shell, typed boundary, lifecycle, platform verification, and recovery;
4. add one governed Codex lifecycle tracer from verified process start to streamed, cancellable
   no-effect completion;
5. add Knowledge capability access only after the Knowledge and injection boundaries are explicit;
6. integrate editor mutations, commands, verification, and delivery as separate vertical effects;
7. introduce additional native capabilities, multi-window, local models, or acceleration only after
   a measured user need and their decision gates; and
8. qualify signing, update, support, accessibility, security, and recovery before productive
   rollout.

Preparatory decisions and throwaway evaluations may overlap. No productive slice skips the exit
conditions of the boundaries it crosses.

## Epic-authoring contract

An epic derived from this baseline is complete only when it records:

- the smallest useful outcome, affected personas, and enterprise value;
- the Parity Ledger row or approved net-new authority and relevant baseline sections;
- one primary acceptance journey with failure and recovery behavior;
- explicit in-scope behavior, non-goals, deferred capability, and transition impact;
- the owning domain, dependency direction, interfaces, data classes, trust boundaries, and
  privileged effects;
- all prerequisite decision gates and accepted ADRs;
- macOS and Windows applicability or an explicit, approved platform exclusion;
- surface and lifecycle states including empty, unavailable, conflict, cancellation, permission,
  degraded, and recovery behavior where applicable;
- measurable security, privacy, accessibility, performance, reliability, resource, and release
  expectations;
- a Reuse Assessment for every Existing Keiko or third-party adoption candidate;
- observable acceptance criteria and the automated, manual, platform, and audit evidence that
  proves them;
- small child slices, stable interface contracts, dependency order, and integrated acceptance; and
- unresolved risks, stop conditions, and the owner of any follow-up decision.

The epic and its child issues must contain their complete executable slices. They may cite this
baseline for global invariants and product meaning, but must not force an implementer to infer
issue-specific behavior, scope, thresholds, interfaces, or acceptance evidence from it.
