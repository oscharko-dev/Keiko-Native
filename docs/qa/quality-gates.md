# Keiko Native quality gates

## Standard and enforcement

`docs/engineering/code-quality-standard.md` defines the engineering properties that must be planned
at epic and issue creation and understood before implementation. The gates in this document provide
deterministic and independent compliance evidence. Passing a gate does not excuse a missing issue
Quality Plan, an untested changed behavior, or a violated architecture or trust boundary.
Manual label, ruleset, identity, provider, and live-probe sequencing follows
[`repository-activation.md`](repository-activation.md).

## Required exact-head checks

`dev` protection is activated only after a live pull request proves that every context below is
emitted by its expected producer on the exact current head:

1. `PR contract` — GitHub Actions (App ID `15368`)
2. `Issue contract current` — GitHub Actions (App ID `15368`)
3. `ci` — GitHub Actions (App ID `15368`)
4. `actionlint` — GitHub Actions (App ID `15368`)
5. `Verify pinned action SHAs` — GitHub Actions (App ID `15368`)
6. `zizmor` — GitHub Actions (App ID `15368`)
7. `Analyze (actions)` — GitHub Actions (App ID `15368`)
8. `Analyze (javascript-typescript)` — GitHub Actions (App ID `15368`)
9. `Build, scan, SBOM, smoke` — GitHub Actions (App ID `15368`)
10. `Review dependency diff (dev/main)` — GitHub Actions (App ID `15368`)
11. `native` — GitHub Actions (App ID `15368`)
12. `Scan dependency lockfiles` — GitHub Actions (App ID `15368`)
13. `SonarCloud Code Analysis` — SonarQube Cloud (App ID `12526`)
14. `Socket Security: Project Report` — Socket Security (App ID `156372`)
15. `Socket Security: Pull Request Alerts` — Socket Security (App ID `156372`)

Protection uses strict current-branch checks, administrator enforcement, signed commits, linear
history, resolved conversations, no force pushes, and no branch deletion. A same-named check from a
different App ID does not satisfy the policy.

Pull-request workflows emit their applicable checks for both `dev` and `epic/**` targets. Epic
integration branches require the direct deterministic checks needed by child-issue scope before
agent auto-merge. The final epic pull request into `dev` remains subject to the complete required
exact-head set above and integrated epic acceptance.

For user-facing changes, required status includes the machine-executable Acceptance Journey rows
declared by the issue. A draft pull request may be used to obtain remote and authoritative-platform
evidence. Missing journey automation, required manual observations, or platform evidence blocks
`Ready for Human Review` and merge even when unrelated checks are green.

The privileged metadata workflow loads its validator only from protected `dev`; it never checks out,
installs, imports, or executes pull-request or epic-branch content. It checks the current issue
label, planning-contract version and fingerprint, automated readiness record, source and target
branches, acceptance and journey evidence, quality settlement, and delivery attestations. It then
publishes `PR contract` and `Issue contract current` directly on the exact pull-request head. Draft
pull requests may remain red while remote evidence is collected; both contexts must pass before
handoff or merge. Closing or semantically changing the accepted issue, changing its type, or
removing readiness changes `Issue contract current` to failure on every linked open pull-request
head. Restoring issue readiness does not restore those pull requests; their updated contract and
evidence must pass again. Readiness records are accepted only from the canonical GitHub Actions bot
identity; copied or user-authored marker comments have no authority.

Zizmor's `dangerous-triggers` finding is dispositioned only for this one metadata workflow. The
repository contract enforces its protected-`dev` checkout, fixed script, pinned actions,
least-privilege permissions, absence of PR checkout or build commands, and exact branch filters. No
other workflow or dangerous trigger inherits that exception.

## Merge authority and automation boundary

Green gates establish technical eligibility; they do not authorize an automated actor to merge
into `dev`. Every pull request targeting `dev` stops at `Ready for Human Review` and may be merged
only by a deliberate manual action from an authorized maintainer. The current human allowlist is
limited to Niko and Oscharko. This two-maintainer project does not require approval from a second
person: either maintainer may merge their own pull request after reviewing the linked issue and
pull request on the exact current head.

That final review covers scope, acceptance criteria, the issue Quality Plan, verification and audit
evidence, required and advisory findings, review conversations, and residual risks. Agents and bots
must not merge into `dev`, enable auto-merge on a pull request targeting `dev`, or operate through a
human merge-capable credential.

Automatic agent merge is permitted only from a child-issue branch into the epic integration branch
named by its accepted issue. The applicable exact-head gates must be green, acceptance and audit
evidence must be complete, and no blocking finding or review conversation may remain. An epic or
standalone pull request targeting `dev` is always outside this exception.

Repository administration enforces the boundary by limiting merge-capable identities to the two
authorized maintainers, disabling auto-merge for `dev` delivery, and giving every automation
identity credentials without authority to merge into `dev`. A shared human credential cannot prove
whether the actor was human or automated and is therefore prohibited for agent operation.

## Bootstrap and productive phases

The `native` check validates the versioned project contract. During bootstrap it proves that the
quality control plane is operational and that no undeclared productive source exists. It does not
claim that a native application has already been built.

Before productive code lands, the project manifest and CI must add language- and platform-specific
compilation, unit/integration tests, architecture checks, 85% coverage with reserve, artifact
inventory, SBOM, sandbox/egress tests, package verification, and signing/notarization evidence.
Missing target evidence fails closed.

## Epic release acceptance

Before an implementation epic can be handed to `dev`, its final integrated head must satisfy the
Quality Envelope defined by `docs/engineering/code-quality-standard.md`. Green child issues do not
substitute for verification of the assembled capability.

The release-acceptance evidence must:

- cover every in-scope top-level user path and declared Windows or macOS target;
- exercise the actually wired production composition rather than only mocks or fixtures;
- include the applicable failure, recovery, security, accessibility, performance, and resource
  rows declared by the epic;
- be bound to the exact integrated head and expected producer; and
- fail when an automatable claim is backed only by manual notes, screenshots, fixtures, or
  self-reporting.

Manual usability, assistive-technology, visual, signing, notarization, and platform observations may
supplement machine evidence where automation cannot establish the complete claim. They must identify
the tested build, platform, operator, procedure, and result and may not replace an available
deterministic gate.

## Advisory independent review

Gitar and `Keiko for Quality` are installed and produce independent evidence but remain outside
branch protection while availability, plan pacing, or self-deadlock can omit a bounded result. A
finding from either product is still actionable. An absent advisory check is an integration
incident, not a product-quality pass or failure.

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

The bootstrap quality control plane deliberately keeps third-party execution surface minimal:
Prettier is the only npm development dependency. Markdown policy and LCOV generation are local,
tested Node.js gates, and coverage uses the Node.js 24 test runner with the same 85% floors.
