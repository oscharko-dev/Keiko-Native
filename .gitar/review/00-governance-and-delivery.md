@AGENTS.md
@CONTRIBUTING.md
@docs/qa/quality-gates.md
@docs/qa/gitar-review-policy.md

# Governance and delivery review

Treat every pull request targeting `main` as a potentially large native integration. Verify the
accepted task boundary, complete changed-file inventory, project phase, declared native targets,
exact current head, and all applicable acceptance criteria before reviewing implementation detail.

Reject direct `main` pushes, force pushes, gate bypasses, authority widening, unsigned delivery,
unresolved review findings, stale evidence, and secrets or unredacted customer content. A green
bootstrap contract cannot approve undeclared productive source. Gitar and Keiko for Quality remain
advisory and must not arm merge or approve a pull request.
