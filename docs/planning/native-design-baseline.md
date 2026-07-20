# Keiko Native Design Baseline

## Status

Approved planning baseline. Concrete technology, component, and platform decisions require their
own implementation evidence and, where appropriate, an ADR.

## Decision

Keiko Native must remain immediately recognizable as Keiko while implementing its design system
independently for a native desktop product. Logo, brand language, semantic states, accessibility
modes, and the visual language for AI and agent workflows remain continuous. Layouts,
interactions, and components may be improved where a reviewed change produces better desktop
usability, accessibility, clarity, or performance.

Pixel-identical reproduction of Existing Keiko is not a requirement. Existing web CSS, framework
components, selectors, breakpoints, browser workarounds, and historical acceptance evidence are not
Native implementation contracts.

## Evidence Sources

The Existing Keiko design system is a reference source under the same immutable evidence snapshots
defined by the parity baseline:

- released baseline: `oscharko-dev/Keiko` at
  `9f3fb998d052f6d8873a24c1bd35de938ab4357e` (`v0.2.15`)
- development snapshot: `oscharko-dev/Keiko` at
  `c79f1cda7a806d8d48fe22ba51b560a7a9c4ddff`

Its token architecture, state matrix, accessibility guidance, component documentation,
AI-and-agent patterns, visual-regression principles, assets, and licences are inputs to assessment,
not automatically authoritative Native artifacts.

## Adoption Policy

Each design artifact or rule must receive one recorded disposition before use:

- `adopt`: the product or design contract remains valid without semantic change
- `adapt`: the intent remains valid but its Native realization changes
- `retire`: the artifact is web-specific, obsolete, or deliberately excluded
- `revalidate`: suitability, licensing, accessibility, platform behavior, or quality evidence must
  be established again before adoption

The ledger entry must record the source path and commit, decision rationale, Native owner, target
artifact, and required acceptance evidence.

## Initial Classification

### Adopt as Product Intent

- Keiko brand identity and recognizable visual language
- semantic rather than raw-color communication
- explicit interaction, data, synchronization, conflict, and failure states
- keyboard and focus visibility requirements
- Dark, Light, and High Contrast modes
- accessible AI, agent, provenance, evidence, and human-control surfaces
- documented component ownership and state coverage

### Adapt for Native Desktop

- design tokens and component APIs
- information density, window layout, navigation, dialogs, menus, and command surfaces
- editor, terminal, diff, approval, evidence, and long-running agent-workflow interactions
- macOS and Windows conventions without creating two different products
- visual regression and interaction test harnesses
- reduced-motion, forced-colors, scaling, text rendering, and input-method behavior

### Retire by Default

- PWA and browser-only behavior
- mobile-first behavior that has no approved Native use case
- Existing Keiko CSS architecture and framework-specific selectors
- browser workarounds and implementation-specific component internals
- stale component status, screenshots, and historical pass results as Native acceptance evidence

### Revalidate Before Use

- fonts, icons, logos, and all third-party assets and licences
- WCAG 2.2 AA behavior in the selected Native technology
- Windows High Contrast, scaling, keyboard, screen-reader, and system-theme integration
- macOS keyboard, VoiceOver, scaling, reduced-motion, and system-theme integration
- performance budgets and rendering behavior on supported hardware

## Quality Contract

Native components must document anatomy, intended and prohibited use, variants, supported states,
accessibility behavior, tokens, ownership, and change history. Every applicable state must be
demonstrated in supported visual and accessibility modes. Automated checks support but do not
replace human visual and interaction acceptance on running macOS and Windows builds.

All Native screenshots, accessibility results, and visual-regression baselines must be produced by
Keiko Native. Existing Keiko evidence may identify expected behavior and known risks but cannot
close Native acceptance criteria.

## Non-Goals

- preserving source compatibility with the Existing Keiko design system
- constraining Native to the Existing Keiko web framework or CSS architecture
- achieving pixel parity at the expense of platform conventions or product quality
- redesigning the brand without an explicit product decision

## Follow-Up

Before the first user-facing epic that adopts or adapts Existing Keiko design material becomes
implementation ready, create the affected Design Adoption Ledger entries. Ratify the component,
accessibility, and visual-acceptance governance after the Native UI technology is selected and
before its first productive UI slice.

Foundation v0.1 dispositions are recorded in
[`design-adoption-ledger.md`](design-adoption-ledger.md).
