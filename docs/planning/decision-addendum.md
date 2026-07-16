# Keiko Native Decision Addendum

## Status

Accepted planning baseline, 2026-07-16. This addendum records human-approved product and scope
changes to the locked source Fachkonzept before implementation planning begins.

## Source Baseline

- document: `Keiko-Native-Fachkonzept.md` (private external source; not committed)
- version: 0.6
- date: 2026-07-15
- SHA-256: `d77a78fb79fc1de882487195d3f2295936f24a34e6bc0579106ad06104737a98`
- source status: locked functional and quality baseline; not a direct implementation contract

The Fachkonzept remains the detailed functional and quality baseline wherever this addendum does
not explicitly change its product or scope direction.

Access and implementation handoff follow
[`docs/product/source-baseline.md`](../product/source-baseline.md). An implementation agent does not
need or receive the private source: every relevant requirement must be complete in its accepted
epic and issue Planning Contract.

## Normative Responsibilities

| Artifact                        | Authority                                                                 |
| ------------------------------- | ------------------------------------------------------------------------- |
| This Decision Addendum          | Human-approved product, scope, replacement, and sequencing changes        |
| Source Fachkonzept              | Functional and quality baseline where this addendum does not supersede it |
| Accepted Native ADRs            | Technical decisions within the approved product and scope boundary        |
| `CONTEXT.md`                    | Current canonical vocabulary and projection of approved decisions         |
| `AGENTS.md`                     | Repository working, verification, and delivery rules                      |
| Existing Keiko sources and ADRs | Reference evidence without automatic Native authority                     |

An accepted Native ADR may supersede an earlier Native ADR. It must not silently contradict this
addendum or change an approved product requirement. Such a conflict stops implementation until a
human-approved product change and any required ADR amendment resolve it.

`CONTEXT.md` must remain consistent with this addendum and accepted Native ADRs. It summarizes the
current domain language but cannot create or override a decision independently.

## Superseding Decisions

### Greenfield Rewrite

Keiko Native is an independently implemented greenfield product. Existing Keiko is evidence for
capabilities, behavior, UX, security, quality, data, and known failure modes. It is not a mandatory
build-time or runtime dependency, implementation base, shared core, or thin-host target.

This decision supersedes the no-rewrite, evolution-first, thin-host, shared-governed-core, and
two-editions-on-one-core direction in sections 12.3, 14.3, 14.4, 43.1, and 49 of the source
Fachkonzept. Reuse remains possible only after a case-by-case Reuse Assessment, after which Keiko
Native fully owns the adopted material.

### Existing Keiko Lifecycle

Existing Keiko remains a separate application during Native development. Once Keiko Native is
operational and the approved replacement criteria are satisfied, Existing Keiko enters maintenance
mode and a code and feature freeze. This is a product-transition rule, not a shared-runtime or
shared-source architecture.

### Agentic Coding Runtime

Agentic Coding is a hard Keiko Native replacement requirement. The Codex App Server is the first
required production coding runtime and is integrated behind a governed, runtime-neutral adapter.
Keiko Native owns workspaces, tasks, runs, authority, tool policy, approvals, changesets, evidence,
verification, recovery, and delivery. Provider identifiers and events remain correlation data.

### OpenCode Retirement

OpenCode is retired from the Native product direction. It is not a runtime, fallback, compatibility
target, migration dependency, or parity target. Existing OpenCode behavior may provide historical
lessons and failure evidence only.

This decision supersedes the transition, normalization, fallback, parity, and optional-adapter
direction in section 26 and related decision-register and roadmap entries.

### Supported Platforms

Windows and macOS are the first-class Keiko Native platforms. Linux is explicitly deferred and may
be added later through a separate product and platform decision. Initial Native epics must not
expand their acceptance matrix to Linux.

### Local Model Support

API-backed and bring-your-own-key model access remains required. Locally hosted model inference on
customer-controlled hardware is a planned later capability. The initial architecture must preserve
a model- and runtime-neutral boundary but must not include local inference in the first
implementation scope.

### Design Continuity

Keiko Native preserves recognizable Keiko identity, semantic states, accessibility modes, and the
visual language for AI and agents. Its implementation is independent and may improve layouts,
interactions, and components for native desktop usability, accessibility, clarity, and performance.
Pixel-identical reproduction and reuse of Existing Keiko web CSS are not requirements.

## Repository Administration

Organization naming, repository naming, repository transfer, remotes, and GitHub Project
administration are handled manually by the product owners and are outside this implementation
readiness process. No implementation issue may assume an administrative change that has not
already been completed by them.

## Implementation Guardrails

- No issue may require a shared runtime or mandatory source dependency on Existing Keiko.
- No issue may introduce OpenCode compatibility or fallback work.
- Every reuse candidate requires a recorded Reuse Assessment.
- Every parity claim concerns user outcomes and quality attributes, not code or layout identity.
- Every Native architecture decision must remain consistent with the Keiko-owned control plane.
- Deferred Linux and local-inference work must not enter initial epic acceptance criteria.
- Existing Keiko evidence cannot satisfy Native implementation, security, accessibility, platform,
  or release acceptance on its own.
