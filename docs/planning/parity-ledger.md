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

The repository-owned [`Agent Planning Baseline`](agent-planning-baseline.md) supplies the complete
functional, journey, quality, decision-gate, and risk input for that decomposition. Planning agents
do not need the private source.

## Classification Model

Each row records:

- **baseline status**: why the capability is or is not part of the Existing Keiko baseline;
- **Native disposition**: whether the outcome is preserved, transformed, retired, or deferred; and
- **delivery status**: whether Native has verified replacement evidence.

Every implementation remains greenfield. `preserve-outcome` never means source, framework, layout,
or runtime reuse. Any reuse candidate still requires a Reuse Assessment.

## Agent Planning Baseline Map

| Capability family                                                               | Repository planning packet                                                                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Desktop product lifecycle, installation, update, repair, and removal            | [Desktop lifecycle](agent-planning-baseline.md#desktop-lifecycle-installation-update-repair-and-removal)            |
| Workspace shell, projects, window state, navigation, and recovery               | [Workspace shell](agent-planning-baseline.md#workspace-shell-projects-window-state-navigation-and-recovery)         |
| Model configuration, provider discovery, BYOK, and governed egress              | [Model configuration](agent-planning-baseline.md#model-configuration-provider-discovery-byok-and-governed-egress)   |
| Conversations, chat history, streaming, context inspection, and grounding       | [Conversations](agent-planning-baseline.md#conversations-chat-history-streaming-context-and-grounding)              |
| Knowledge ingestion, document lifecycle, Local Knowledge, and source management | [Knowledge ingestion](agent-planning-baseline.md#knowledge-ingestion-document-lifecycle-and-source-management)      |
| Hybrid retrieval, ranking, citations, and retrieval quality                     | [Hybrid retrieval](agent-planning-baseline.md#hybrid-retrieval-ranking-citations-and-retrieval-quality)             |
| MemoriaViva governed memory                                                     | [MemoriaViva](agent-planning-baseline.md#memoriaviva-governed-memory)                                               |
| Knowledge relationships and graph-backed context                                | [Knowledge relationships](agent-planning-baseline.md#knowledge-relationships-and-graph-backed-context)              |
| Quality Intelligence                                                            | [Quality Intelligence](agent-planning-baseline.md#quality-intelligence)                                             |
| Prompt Enhancer                                                                 | [Prompt Enhancer](agent-planning-baseline.md#prompt-enhancer)                                                       |
| Figma snapshot and design-source integration                                    | [Figma integration](agent-planning-baseline.md#figma-snapshot-and-design-source-integration)                        |
| GitHub, Jira, and governed external coding-context intake                       | [External coding context](agent-planning-baseline.md#github-jira-and-governed-external-coding-context-intake)       |
| Agentic Coding and coding-run lifecycle                                         | [Agentic Coding](agent-planning-baseline.md#agentic-coding-and-coding-run-lifecycle)                                |
| Editor, files, terminal, browser, language intelligence, and debugging          | [Editor and tools](agent-planning-baseline.md#editor-files-terminal-browser-language-intelligence-and-debugging)    |
| Governed changesets, Git, pull-request, and merge delivery                      | [Governed delivery](agent-planning-baseline.md#governed-changesets-git-pull-requests-and-merge-delivery)            |
| Verification, evidence, audit, redaction, and effect receipts                   | [Verification and evidence](agent-planning-baseline.md#verification-evidence-audit-redaction-and-effect-receipts)   |
| Voice input and interaction lane                                                | [Voice](agent-planning-baseline.md#voice-input-and-interaction-lane)                                                |
| Settings, credentials, security policy, sandboxing, and approvals               | [Security and approvals](agent-planning-baseline.md#settings-credentials-security-policy-sandboxing-and-approvals)  |
| Diagnostics, health, support evidence, and operational recovery                 | [Diagnostics and recovery](agent-planning-baseline.md#diagnostics-health-support-evidence-and-operational-recovery) |

## Level-One Capability Inventory

| Capability family                                                               | Baseline status      | Native disposition | Delivery  | Evidence and boundary                                                                                                                                                          |
| ------------------------------------------------------------------------------- | -------------------- | ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop product lifecycle, installation, update, repair, and removal            | `released-mandatory` | `transform`        | `planned` | Existing Keiko `v0.2.15` README lifecycle and governed-update sections; portable delivery release-impact records. Native owns Windows and macOS packaging and lifecycle anew.  |
| Workspace shell, projects, window state, navigation, and recovery               | `released-mandatory` | `transform`        | `planned` | Released desktop workspace surfaces and ADR chain; Native host and UI state are independently implemented.                                                                     |
| Model configuration, provider discovery, BYOK, and governed egress              | `released-mandatory` | `preserve-outcome` | `planned` | Existing Keiko first-run gateway and credential flows; the Agent Planning Baseline preserves provider-neutral boundaries and later local-model extensibility.                  |
| Conversations, chat history, streaming, context inspection, and grounding       | `released-mandatory` | `transform`        | `planned` | Existing Keiko Conversation Center and grounding behavior; Agent Planning Baseline journeys APB-J2, APB-J3, and APB-J7.                                                        |
| Knowledge ingestion, document lifecycle, Local Knowledge, and source management | `released-mandatory` | `transform`        | `planned` | Existing Keiko folders, Capsules, Capsule Sets, PDF/DOCX parsing, retention, and drift behavior; Agent Planning Baseline journey APB-J1.                                       |
| Hybrid retrieval, ranking, citations, and retrieval quality                     | `released-mandatory` | `transform`        | `planned` | Existing Keiko lexical and semantic retrieval, fusion, reranking, and citations; the Agent Planning Baseline defines the repository-owned quality contract.                    |
| MemoriaViva governed memory                                                     | `released-mandatory` | `transform`        | `planned` | Existing Keiko encrypted capture, scope, recall, decay, forgetting, diagnostics, and body-free audit behavior.                                                                 |
| Knowledge relationships and graph-backed context                                | `released-mandatory` | `transform`        | `planned` | Released relationship workspace and ADR evidence; the Agent Planning Baseline defines relationship provenance, confidence, sensitivity, and drift obligations.                 |
| Quality Intelligence                                                            | `released-mandatory` | `transform`        | `planned` | Existing Keiko requirement-to-test generation, traceability, gap, drift, editing, and export workflows.                                                                        |
| Prompt Enhancer                                                                 | `released-mandatory` | `transform`        | `planned` | Released governed prompt-enhancement workspace and ADR evidence. Detailed user-path proof remains an epic preflight obligation.                                                |
| Figma snapshot and design-source integration                                    | `released-mandatory` | `transform`        | `planned` | Existing Keiko read-only Figma snapshot, accessibility, design-to-test, and design-to-code evidence path.                                                                      |
| GitHub, Jira, and governed external coding-context intake                       | `released-mandatory` | `transform`        | `planned` | Existing Keiko `v0.2.15` Coding Workbench release record. Write authority is not implied by context intake.                                                                    |
| Agentic Coding and coding-run lifecycle                                         | `released-mandatory` | `transform`        | `planned` | Hard replacement requirement. Codex App Server is the first required runtime behind a Keiko-owned adapter and control plane.                                                   |
| Editor, files, terminal, browser, language intelligence, and debugging tools    | `released-mandatory` | `transform`        | `planned` | Released workspace tool surfaces and editor ADRs. Native implementation and host choice remain separate decisions.                                                             |
| Governed changesets, Git, pull-request, and merge delivery                      | `released-mandatory` | `transform`        | `planned` | Existing Keiko governed Git delivery surfaces; the Agent Planning Baseline preserves the single mutation path, human `dev` merge, and exact-head evidence.                     |
| Verification, evidence, audit, redaction, and effect receipts                   | `released-mandatory` | `transform`        | `planned` | Existing Keiko verification and evidence manifests; the Agent Planning Baseline makes these product capabilities as well as delivery controls.                                 |
| Voice input and interaction lane                                                | `released-mandatory` | `transform`        | `planned` | Existing Keiko release evidence and running voice surfaces; the Agent Planning Baseline retains Voice as an input lane rather than an authority domain.                        |
| Settings, credentials, security policy, sandboxing, and approvals               | `released-mandatory` | `transform`        | `planned` | Existing Keiko settings and governed execution boundaries; the Agent Planning Baseline keeps these within Keiko-owned authority.                                               |
| Diagnostics, health, support evidence, and operational recovery                 | `released-mandatory` | `transform`        | `planned` | Existing Keiko doctor, status, repair, diagnostics, and content-free support behavior; the Agent Planning Baseline defines repository-owned support and recovery requirements. |

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

1. bind its detailed inventory to this ledger, the Agent Planning Baseline, and the released and
   development snapshot commits;
2. separate released behavior, mandatory deltas, and net-new Native design;
3. record every Existing Keiko adoption candidate in a Reuse Assessment;
4. identify explicit non-goals and deferred sub-capabilities;
5. map every included user path to the Epic Quality Envelope; and
6. leave the top-level classification unchanged unless a product owner approves a ledger amendment.
