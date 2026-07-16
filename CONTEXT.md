# Keiko Native Product Context

Keiko Native is the greenfield successor to the existing Keiko application. This context defines
the product language that prevents the rewrite from silently becoming a wrapper, shared-core
edition, or unreviewed source-code migration.

Human-approved product and scope changes are governed by `docs/planning/decision-addendum.md`. The
repository-owned functional and quality requirements live in
`docs/planning/agent-planning-baseline.md`. This file is a current language projection of those
records and accepted Native ADRs; it is not an independent decision authority.

## Language

**Keiko Native**:
The independently implemented native Keiko product for regulated coding and knowledge work.
_Avoid_: Native wrapper, thin host, shared-core edition

**Existing Keiko**:
The current Keiko application used as evidence for behavior, parity, UX, security, quality, data,
and known failure modes.
_Avoid_: Shared runtime, mandatory source dependency, implementation base

**Greenfield Rewrite**:
A new implementation with no mandatory build-time or runtime dependency on **Existing Keiko**.
_Avoid_: Refactor, host migration, evolutionary wrapper

**Reuse Assessment**:
An explicit, case-by-case decision on whether a learning, contract, algorithm, or source component
from **Existing Keiko** is suitable for **Keiko Native**.
_Avoid_: Automatic reuse, blanket port, copy-first migration

**Parity Baseline**:
An immutable, versioned inventory of the Existing Keiko capabilities against which replacement
readiness is measured.
_Avoid_: Moving target, informal feature list, implementation checklist

**Parity Ledger**:
The evidence-backed record of each baseline capability's inclusion decision and Keiko Native
replacement status.
_Avoid_: Roadmap, aspirational feature list, source-code mapping

**Agent Planning Baseline**:
The repository-owned functional, journey, quality, decision-gate, and risk baseline used to create
complete epics and issues without private-source access.
_Avoid_: Fachkonzept copy, roadmap, implementation issue, private planning dependency

**Mandatory Delta**:
A security, regulatory, compatibility, or critical-correctness change after the baseline cut-off
that must be evaluated for inclusion in replacement readiness.
_Avoid_: Automatic scope growth, feature creep

**Agentic Coding**:
The governed product capability for delegating bounded repository work to coding agents with human
control, reviewable effects, deterministic verification, and traceable evidence.
_Avoid_: Chat-only coding, unrestricted code generation, autonomous shell

**Codex App Server Integration**:
The required rich-client protocol integration used by Keiko Native to provide the first production
Agentic Coding runtime.
_Avoid_: Scraping Codex CLI terminal output, direct renderer-to-runtime coupling

**Keiko Agentic Control Plane**:
The Keiko Native-owned product authority for workspaces, tasks, runs, permissions, tool policy,
approvals, changesets, evidence, verification, recovery, and delivery.
_Avoid_: Runtime-owned product truth, provider-specific governance, renderer-owned authority

**Coding Runtime Adapter**:
The governed, replaceable boundary through which Keiko Native delegates bounded agent work to a
coding runtime and translates runtime events into Keiko-owned lifecycle state.
_Avoid_: Direct UI integration, provider identity as domain identity, ungoverned runtime access

**OpenCode**:
The retired coding-runtime path from Existing Keiko that is explicitly excluded from Native parity.
_Avoid_: Fallback runtime, compatibility target, migration dependency

**Native Design Baseline**:
The independently implemented design system for Keiko Native. It preserves recognizable Keiko
identity and proven semantic design contracts while allowing platform-aware improvements for
desktop usability, accessibility, clarity, and performance.
_Avoid_: Pixel-identical clone, copied web CSS, unconstrained visual redesign

**Design Adoption Ledger**:
The evidence-backed record that classifies an Existing Keiko design artifact or rule as `adopt`,
`adapt`, `retire`, or `revalidate` before it can become authoritative for Keiko Native.
_Avoid_: Wholesale style-guide copy, inherited acceptance evidence, undocumented visual drift

## Relationships

- **Keiko Native** is a **Greenfield Rewrite** of **Existing Keiko**.
- **Existing Keiko** informs the required behavior and quality of **Keiko Native** but does not own
  its implementation.
- Every reuse candidate requires an individual **Reuse Assessment** before adoption.
- Adopted source becomes fully owned, tested, secured, and maintained by **Keiko Native**.
- The **Parity Baseline** defines replacement scope but does not prescribe implementation or UI
  structure.
- The **Parity Ledger** requires equal or better behavior, security, governance, data integrity,
  evidence, accessibility, performance, and failure handling for every included capability.
- Every **Parity Ledger** capability links to its requirements in the **Agent Planning Baseline**.
- Planning agents create epics from repository records and never require the private source.
- A **Mandatory Delta** changes the baseline only through explicit review and recorded approval.
- **Agentic Coding** is a hard Keiko Native replacement requirement, independent of whether its
  implementation matches Existing Keiko.
- **Codex App Server Integration** is mandatory for the first production-ready Agentic Coding path.
- The **Codex App Server Integration** is implemented behind a **Coding Runtime Adapter**.
- The **Keiko Agentic Control Plane** owns normative lifecycle and governance state; Codex
  identifiers, threads, events, and status remain provider correlation data.
- **OpenCode** behavior may inform lessons learned but is not a runtime, compatibility, or parity
  target.
- The **Native Design Baseline** preserves Keiko brand identity, semantic states, accessibility
  modes, and the visual language for AI and agents without prescribing web implementation details.
- Layouts, interactions, and components may change where a reviewed Native design improves desktop
  usability, accessibility, clarity, or performance.
- Every Existing Keiko design artifact requires a **Design Adoption Ledger** decision, and all
  Native visual and accessibility acceptance evidence must be generated anew.

## Example dialogue

> **Developer:** "Existing Keiko already implements this capability. Should I port its module?"
> **Product owner:** "Not automatically. Use its behavior and lessons as evidence, perform a Reuse
> Assessment, and choose the cleanest Keiko Native implementation."

## Flagged ambiguities

- "Rewrite" previously appeared alongside "evolution" and "shared governed core". Resolved:
  **Keiko Native** is a **Greenfield Rewrite**; inspiration and reuse remain individually assessed.
- "Parity" means outcome and quality equivalence against an immutable **Parity Baseline**, not code,
  layout, or internal architecture equivalence.
- "Codex CLI integration" means a governed **Codex App Server Integration**, not terminal emulation
  or parsing human-oriented CLI output.
- "Codex integration" does not transfer product, policy, approval, evidence, or delivery ownership
  away from the **Keiko Agentic Control Plane**.
- "Preserve the Keiko style" means evolutionary visual continuity through the **Native Design
  Baseline**, not pixel parity or reuse of the Existing Keiko web implementation.
