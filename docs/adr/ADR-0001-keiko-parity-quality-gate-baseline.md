# ADR-0001: Keiko-parity quality-gate baseline

## Status

Accepted for repository bootstrap, 2026-07-15.

## Context

Keiko Native starts as a documentation-only repository but must not accumulate productive native
code before the same governance, security, supply-chain, static-analysis, coverage, and delivery
standards as Keiko are operational. Blindly copying Keiko's TypeScript-monorepo jobs would create
permanent failures or misleading no-op checks.

## Decision

The repository adopts the Keiko quality classes with a native bootstrap profile:

- strict, app-bound current-head branch protection;
- repository-owned CI, actionlint, SHA pinning, zizmor, build/SBOM/smoke, native contract, and
  cross-platform checks;
- CodeQL for workflow and JavaScript quality-control-plane code;
- Dependency Review, OSV, Socket, and SonarQube Cloud;
- signed pull-request-only integration into `main` with linear history and resolved conversations;
- Gitar and `Keiko for Quality` as advisory evidence until their liveness probes pass; and
- an 85% coverage floor with no rounding-edge exception.

`quality/project.json` fails closed if productive source appears during bootstrap. The first native
implementation pull request must declare its language, source roots, targets, supported platforms,
artifact/signing model, and target-specific deterministic gates. A green bootstrap check is not
permission to ship an undeclared target.

## Consequences

The repository is protected before product code arrives, without pretending that Keiko's UI,
package graph, or release artifacts already exist. The quality control plane itself is tested,
covered, scanned, and reviewable. Future native targets cannot enter silently because productive
file extensions invalidate the bootstrap contract.
