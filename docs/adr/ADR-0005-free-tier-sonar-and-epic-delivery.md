# ADR-0005: Free-tier Sonar and authenticated epic delivery

## Status

Accepted, 2026-07-17.

## Context

Keiko Native originally invoked CI-based SonarQube Cloud analysis on pull requests and pushes for
both `dev` and `epic/**`. The public Sonar organization accepts `dev` and pull-request analysis but
denies access to non-main branch data. An epic push therefore uploaded a report and then failed its
quality-gate lookup with HTTP 403 even though coverage and the child pull request were green.

The repository also required a dedicated automation identity for child-to-epic merges although no
such identity was provisioned. Original Keiko instead uses an authenticated maintainer account for
eligible child-to-epic delivery and preserves a separate human-only boundary for `dev`.

PR #15 was merged to `epic/9-foundation-v0.1` with all applicable exact-head gates, acceptance
evidence, audit evidence, and review conversations settled, but GitHub attributed the operation to
`Niko4417` rather than the then-required dedicated identity. This is recorded as a settled one-time
policy mismatch. Its valid content and history are retained; neither history rewriting nor a
content-only revert would improve the delivery control.

## Decision

Repository coverage runs and fails closed on every accepted CI event. CI-based SonarQube Cloud
analysis runs and fails closed only for:

- pull requests whose base is exactly `dev`;
- pushes whose ref is exactly `refs/heads/dev`; and
- manual dispatches whose selected ref is exactly `refs/heads/dev`.

Epic pull requests, epic pushes, and release pushes do not download or invoke the scanner and do
not request non-main branch data. They retain every applicable non-Sonar deterministic, security,
dependency, contract, native, and platform gate. The final epic pull request to `dev` supplies the
integrated Sonar evidence. A repository-owned contract test enforces the exact event predicate,
unconditional coverage, and the required-event token and quality-gate failure behavior.

An authenticated agent may use the authenticated maintainer account to merge a fully eligible
accepted child branch only into the exact accepted epic target. Immediately before mutation it
must revalidate the accepted issue and target, source issue number, exact current head, applicable
green gates, completed acceptance and audit evidence, zero blocking findings, and zero unresolved
review conversations. A wrong, changed, stale, closed, or `dev` target fails closed. Never merge or
enable auto-merge for `dev`.

Every pull request targeting `dev` stops at `Ready for Human Review`. Only an authorized maintainer
acting deliberately as a human may merge it. Sonar provider administration, secret inspection,
branch-protection mutation, and gate bypass remain outside agent authority.

## Consequences

Keiko Native can deliver ordered epic children autonomously within the public Sonar model without
discarding coverage or any applicable non-Sonar quality class. Sonar still evaluates the integrated
change at the protected `dev` boundary, where non-main branch access is unnecessary.

GitHub merge attribution records the authenticated maintainer account for both human and agent
operations. The accepted issue, exact-target validation, pull-request evidence, and automation
handoff therefore become required audit context for child-to-epic merges. This narrower evidence
model does not grant, imply, or technically excuse agent delivery to `dev`.
