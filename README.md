# Keiko Native

Keiko Native is the independently implemented desktop edition of Keiko for regulated coding and
knowledge work. It is designed for German banking and insurance environments that require bounded
AI and agent execution, local control, deterministic verification, traceable evidence, and
deliberate human authority.

## Product direction

Keiko Native is a greenfield rewrite, not a wrapper, refactor, shared-core edition, or source-code
migration of the existing Keiko application. Existing Keiko provides versioned evidence for
capabilities, behavior, UX, security, quality, and known failure modes. Every reuse candidate is
assessed individually and becomes fully owned by Keiko Native when adopted.

The product direction includes:

- a high-performance native workspace for coding and knowledge work;
- governed AI and agent workflows, with Agentic Coding as a hard requirement;
- Windows and macOS as first-class platforms;
- API-backed and bring-your-own-key model access;
- model- and runtime-neutral boundaries that permit later customer-hosted local inference; and
- enterprise-grade security, accessibility, reliability, auditability, and operability.

The first required Agentic Coding runtime is integrated through the Codex App Server behind a
Keiko-owned control plane and replaceable runtime adapter. Keiko retains authority over workspaces,
tasks, runs, permissions, approvals, changesets, evidence, verification, recovery, and delivery.

## Repository state

The repository is in its governed bootstrap phase. The planning baseline, architecture decisions,
templates, quality standard, and quality control plane are being established before productive
application source is admitted. A green bootstrap build proves the repository controls; it does
not claim that the native product already exists.

Start with:

- [`CONTEXT.md`](CONTEXT.md) for canonical product language;
- [`AGENTS.md`](AGENTS.md) for the implementation and delivery contract;
- [`docs/product/source-baseline.md`](docs/product/source-baseline.md) for the private Fachkonzept
  identity, access rules, and planning handoff boundary;
- [`docs/planning/decision-addendum.md`](docs/planning/decision-addendum.md) for approved changes to
  the Fachkonzept;
- [`docs/engineering/code-quality-standard.md`](docs/engineering/code-quality-standard.md) for the
  engineering baseline; and
- [`docs/qa/quality-gates.md`](docs/qa/quality-gates.md) for machine and human acceptance gates.

## Local verification

Use Node.js 24.18.x and npm 11.16.x for the repository quality control plane.

```bash
npm ci --ignore-scripts
npm run quality
npm audit --audit-level=high
```

Productive source may enter only after the selected Native technologies, source roots, target
platforms, build and test commands, coverage, packaging, signing, security, and architecture gates
are declared in the repository contract.

Licensed under the [Apache License 2.0](LICENSE).
