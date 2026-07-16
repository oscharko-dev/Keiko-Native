# Keiko Native Parity Ledger

## Status

Approved level-one inventory method with evidence-backed initial classifications, 2026-07-16.
Entries marked `decision-required` remain outside implementation-ready scope until a product owner
settles the stated question.

## Purpose

This ledger freezes the top-level replacement scope without pretending that every capability is
already decomposed into implementation issues. It uses the immutable sources in
`docs/planning/parity-baseline.md`. Before an owning epic becomes Ready, its entry must be expanded
into user paths, sub-capabilities, contracts, platforms, failure states, and acceptance evidence in
that epic's Quality Envelope.

## Classification Model

Each row records:

- **baseline status**: why the capability is or is not part of the Existing Keiko baseline;
- **Native disposition**: whether the outcome is preserved, transformed, retired, or deferred; and
- **delivery status**: whether Native has verified replacement evidence.

Every implementation remains greenfield. `preserve-outcome` never means source, framework, layout,
or runtime reuse. Any reuse candidate still requires a Reuse Assessment.

## Level-One Capability Inventory

| Capability family                                                               | Baseline status      | Native disposition | Delivery  | Evidence and boundary                                                                                                                                                         |
| ------------------------------------------------------------------------------- | -------------------- | ------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop product lifecycle, installation, update, repair, and removal            | `released-mandatory` | `transform`        | `planned` | Existing Keiko `v0.2.15` README lifecycle and governed-update sections; portable delivery release-impact records. Native owns Windows and macOS packaging and lifecycle anew. |
| Workspace shell, projects, window state, navigation, and recovery               | `released-mandatory` | `transform`        | `planned` | Released desktop workspace surfaces and ADR chain; Native host and UI state are independently implemented.                                                                    |
| Model configuration, provider discovery, BYOK, and governed egress              | `released-mandatory` | `preserve-outcome` | `planned` | Existing Keiko first-run gateway and credential flows; Fachkonzept sections 31 and 32. Provider-neutral boundaries remain mandatory.                                          |
| Conversations, chat history, streaming, context inspection, and grounding       | `released-mandatory` | `transform`        | `planned` | Existing Keiko Conversation Center and grounding behavior; Fachkonzept end-to-end knowledge scenarios.                                                                        |
| Knowledge ingestion, document lifecycle, Local Knowledge, and source management | `released-mandatory` | `transform`        | `planned` | Existing Keiko folders, Capsules, Capsule Sets, PDF/DOCX parsing, retention, and drift behavior; Fachkonzept sections 15 and 16.                                              |
| Hybrid retrieval, ranking, citations, and retrieval quality                     | `released-mandatory` | `transform`        | `planned` | Existing Keiko lexical/semantic retrieval, reciprocal-rank fusion, reranking, and citations; Fachkonzept section 17.                                                          |
| MemoriaViva governed memory                                                     | `released-mandatory` | `transform`        | `planned` | Existing Keiko encrypted capture, scope, recall, decay, forgetting, diagnostics, and body-free audit behavior.                                                                |
| Knowledge relationships and graph-backed context                                | `released-mandatory` | `transform`        | `planned` | Released relationship workspace and ADR evidence; Fachkonzept sections 15.3 and 15.4.                                                                                         |
| Quality Intelligence                                                            | `released-mandatory` | `transform`        | `planned` | Existing Keiko requirement-to-test generation, traceability, gap, drift, editing, and export workflows.                                                                       |
| Prompt Enhancer                                                                 | `released-mandatory` | `transform`        | `planned` | Released governed prompt-enhancement workspace and ADR evidence. Detailed user-path proof remains an epic preflight obligation.                                               |
| Figma snapshot and design-source integration                                    | `released-mandatory` | `transform`        | `planned` | Existing Keiko read-only Figma snapshot, accessibility, design-to-test, and design-to-code evidence path.                                                                     |
| GitHub, Jira, and governed external coding-context intake                       | `released-mandatory` | `transform`        | `planned` | Existing Keiko `v0.2.15` Coding Workbench release record. Write authority is not implied by context intake.                                                                   |
| Agentic Coding and coding-run lifecycle                                         | `released-mandatory` | `transform`        | `planned` | Hard replacement requirement. Codex App Server is the first required runtime behind a Keiko-owned adapter and control plane.                                                  |
| Editor, files, terminal, browser, language intelligence, and debugging tools    | `released-mandatory` | `transform`        | `planned` | Released workspace tool surfaces and editor ADRs. Native implementation and host choice remain separate decisions.                                                            |
| Governed changesets, Git, pull-request, and merge delivery                      | `released-mandatory` | `transform`        | `planned` | Existing Keiko governed Git delivery surfaces and Fachkonzept delivery flow. Human authority and exact-head evidence remain mandatory.                                        |
| Verification, evidence, audit, redaction, and effect receipts                   | `released-mandatory` | `transform`        | `planned` | Existing Keiko verification and evidence manifests; Fachkonzept sections 33 and 39. These are product capabilities as well as delivery controls.                              |
| Voice input and interaction lane                                                | `released-mandatory` | `transform`        | `planned` | Existing Keiko release evidence and running voice surfaces; Fachkonzept preserves Voice as an adjacent input and interaction lane rather than a separate authority domain.    |
| Settings, credentials, security policy, sandboxing, and approvals               | `released-mandatory` | `transform`        | `planned` | Existing Keiko settings and governed execution boundaries; Fachkonzept sections 23, 31, and 32. These remain Keiko-owned authority.                                           |
| Diagnostics, health, support evidence, and operational recovery                 | `released-mandatory` | `transform`        | `planned` | Existing Keiko doctor, status, repair, diagnostics, and content-free support behavior; Fachkonzept section 40.                                                                |

## Explicit Exceptions and Deferred Capabilities

| Capability or runtime                   | Baseline status      | Native disposition | Delivery   | Rationale                                                                                                                                        |
| --------------------------------------- | -------------------- | ------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenCode runtime and compatibility path | `released-mandatory` | `retire`           | `verified` | Explicitly superseded by the Decision Addendum. Historical behavior remains evidence only; retirement is already approved.                       |
| Customer-hosted local model inference   | `not-present`        | `defer`            | `planned`  | Approved later capability. Initial architecture preserves the provider-neutral boundary but first implementation scope excludes local inference. |
| Linux product support                   | `not-present`        | `defer`            | `planned`  | Platform decision rather than feature parity. Windows and macOS are first-class; Linux requires a later decision.                                |

## Decision-Required Candidates

| Candidate                                                                                      | Why evidence is insufficient                                                                                                                                                                                                                                  | Current treatment                                                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Keiko Twin as an independent capability family                                                 | The released README describes Keiko Twin primarily as long-term product direction while Existing Keiko also exposes a Twin panel backed by governed memory. The sources do not establish whether it owns a distinct accepted user outcome beyond MemoriaViva. | `decision-required`; do not create an independent implementation epic yet.           |
| Generic Plugins, Automations, Mobile, Inspector, Activity, Notifications, and Resources panels | Window-registry or UI presence alone does not prove a released, supported user capability. No independent replacement promise is inferred from placeholder or navigation surfaces.                                                                            | `delta-review`; require user-path, release, or executable evidence before inclusion. |

## Epic Decomposition Gate

Before an epic claims any capability family, it must:

1. bind its detailed inventory to the released and development snapshot commits;
2. separate released behavior, mandatory deltas, and net-new Native design;
3. record every Existing Keiko adoption candidate in a Reuse Assessment;
4. identify explicit non-goals and deferred sub-capabilities;
5. map every included user path to the Epic Quality Envelope; and
6. leave the top-level classification unchanged unless a product owner approves a ledger amendment.
