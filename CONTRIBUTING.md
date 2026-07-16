# Contributing to Keiko Native

Keiko Native follows the same production, security, and evidence bar as Keiko. Read `AGENTS.md`, the
applicable records under `docs/adr/`, and `docs/qa/quality-gates.md` before opening a pull request.

## Local verification

```bash
npm ci --ignore-scripts
npm run quality
npm audit --audit-level=high
```

The current repository is in an explicit bootstrap phase. Productive source may land only together
with declared native targets and deterministic target-specific build, test, coverage, security,
package, platform, and signing gates.

## Pull requests

Standalone and final epic pull requests target `dev`; child-issue pull requests target the exact
epic integration branch accepted in their issue. Every applicable required check must pass on the
exact current head, every review conversation must be resolved, and commits must be signed. A merge
into `dev` is allowed only as a deliberate manual action by an authorized maintainer. The current
allowlist is limited to Niko and Oscharko. A separate non-author approval is not required; either
maintainer may merge their own pull request after completing the same final review.

`Ready for Human Review` is a handoff state, not permission for automation to merge. Before merging
into `dev`, the authorized maintainer reviews the linked issue and pull request, including scope,
acceptance criteria, the Quality Plan, exact-head evidence and checks, findings, conversations, and
residual risks. Agents and bots must stop at that handoff and must never merge into `dev` or enable
auto-merge for a pull request targeting `dev`.

An agent may enable or perform automatic merge only for a child-issue pull request targeting its
designated epic integration branch. The accepted issue must authorize that target, every applicable
exact-head gate must be green, the issue acceptance and audit evidence must be complete, and no
blocking finding or review conversation may remain. This exception never applies to an epic or
standalone pull request targeting `dev`.

Gitar and `Keiko for Quality` are advisory. Their findings still require owning-layer fixes and
failure-first tests, but their absence must not deadlock delivery until their documented
availability probes pass.

Do not push directly to `dev`, force-push, bypass a gate, dismiss a finding to obtain green status,
or include secrets or unredacted customer content in repository or CI evidence.

For user-facing work, locally executable Acceptance Journey checks pass before the first push. A
draft pull request may collect remote macOS, Windows, security, accessibility, or other
authoritative evidence. It remains a draft until every required journey result and exact-head gate
is complete; only then may it move to `Ready for Human Review` or become eligible for merge.
