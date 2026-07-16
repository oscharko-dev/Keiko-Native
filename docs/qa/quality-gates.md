# Keiko Native quality gates

## Required exact-head checks

`main` protection is activated only after a live pull request proves that every context below is
emitted by its expected producer on the exact current head:

1. `ci` — GitHub Actions (App ID `15368`)
2. `actionlint` — GitHub Actions (App ID `15368`)
3. `Verify pinned action SHAs` — GitHub Actions (App ID `15368`)
4. `zizmor` — GitHub Actions (App ID `15368`)
5. `Analyze (actions)` — GitHub Actions (App ID `15368`)
6. `Analyze (javascript-typescript)` — GitHub Actions (App ID `15368`)
7. `Build, scan, SBOM, smoke` — GitHub Actions (App ID `15368`)
8. `Review dependency diff (main)` — GitHub Actions (App ID `15368`)
9. `native` — GitHub Actions (App ID `15368`)
10. `Scan dependency lockfiles` — GitHub Actions (App ID `15368`)
11. `SonarCloud Code Analysis` — SonarQube Cloud (App ID `12526`)
12. `Socket Security: Project Report` — Socket Security (App ID `156372`)
13. `Socket Security: Pull Request Alerts` — Socket Security (App ID `156372`)

Protection uses strict current-branch checks, administrator enforcement, signed commits, linear
history, resolved conversations, no force pushes, and no branch deletion. A same-named check from a
different App ID does not satisfy the policy.

## Bootstrap and productive phases

The `native` check validates the versioned project contract. During bootstrap it proves that the
quality control plane is operational and that no undeclared productive source exists. It does not
claim that a native application has already been built.

Before productive code lands, the project manifest and CI must add language- and platform-specific
compilation, unit/integration tests, architecture checks, 85% coverage with reserve, artifact
inventory, SBOM, sandbox/egress tests, package verification, and signing/notarization evidence.
Missing target evidence fails closed.

## Advisory independent review

Gitar and `Keiko for Quality` are installed and produce independent evidence but remain outside
branch protection while availability, plan pacing, or self-deadlock can omit a bounded result. A
finding from either product is still actionable. An absent advisory check is an integration incident,
not a product-quality pass or failure.

Promotion to a required gate needs a live negative/positive probe proving exact-head emission,
stable producer identity, bounded settlement, machine-readable evidence, and a repair path that does
not depend on the gate succeeding.

The Claude GitHub App has organization-wide repository access. `CLAUDE.md` delegates to the same
machine-checked `AGENTS.md` contract used by all coding agents, so Claude does not operate under a
parallel or weaker repository policy. Claude is not a required status context because Keiko does
not define a separate Claude CI workflow.

## Local-first rule

Run `npm run quality` and `npm audit --audit-level=high` before the first push. Reproduce remote
findings locally, add a prevention test or contract check, rerun the affected gate, and then rerun
the complete local suite before another push. GitHub is remote-only validation, not the test loop.
