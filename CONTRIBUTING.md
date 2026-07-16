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

Pull requests target `dev`. Every required check must pass on the exact current head, every review
conversation must be resolved, and commits must be signed. No approving human review is required
after the work has been accepted and the direct app-bound gates are green.

Gitar and `Keiko for Quality` are advisory. Their findings still require owning-layer fixes and
failure-first tests, but their absence must not deadlock delivery until their documented
availability probes pass.

Do not push directly to `dev`, force-push, bypass a gate, dismiss a finding to obtain green status,
or include secrets or unredacted customer content in repository or CI evidence.
