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

Pull-request workflows emit their applicable checks for both `dev` and `epic/**` targets. The full
set above applies to `dev`. CI-based SonarQube Cloud analysis and its provider context are selected
only for pull requests targeting `dev`, pushes to `dev`, and manual dispatches bound exactly to
`dev`. Repository coverage remains unconditional. Epic pull requests and pushes retain all
applicable deterministic, security, dependency, contract, native, and platform checks without
requesting unavailable non-main Sonar branch data. The final epic pull request into `dev` remains
subject to the complete required exact-head set above, including integrated Sonar and epic
acceptance.

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
must not merge into `dev`, enable auto-merge on a pull request targeting `dev`, or, for actions
targeting `dev`, operate through a human merge-capable credential.

An authenticated agent may use the authenticated maintainer account to merge a fully eligible
accepted child branch only into the exact accepted epic target. Immediately before mutation it
revalidates the accepted issue, exact source and target, current head, applicable green checks,
acceptance and audit evidence, blocking findings, and review conversations. Any mismatch, stale
evidence, failed or skipped required check, unresolved thread, closed issue, or `dev` target fails
closed. Never merge or enable auto-merge for `dev`. An epic or standalone pull request targeting
`dev` is always outside this exception.

Repository administration limits `dev` merge authority to the two authorized maintainers and keeps
repository auto-merge available for epic delivery. Because GitHub attribution identifies the
account rather than whether its operation was human- or agent-driven, the accepted issue, pull
request evidence, exact target validation, and recorded automation handoff provide the audit trail
for child-to-epic delivery. They never authorize an agent action against `dev`.

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

The quality control plane uses exactly Node.js 24.18.0 and npm 11.16.0. Root `engines`, npm
`devEngines`, `packageManager`, and the sole `.npmrc` setting (`engine-strict=true`) fail closed on
toolchain drift before installation or scripts. The direct `quality` and `native:dependencies`
entry points also run the dependency-free exact-toolchain checker. Every workflow job that consumes
npm first installs exact Node through the pinned setup action, activates npm 11.16.0 through the
Corepack bundled with that Node release, and runs the same checker before any npm command. Contract
tests reject missing, conditional, reordered, or version-ranged activation.

The Linux `core-quality` job runs `quality:control`, the portable Node and repository-contract suite
shared with root `quality`. The full root `quality` command then runs every native gate and is
authoritative only on Apple Silicon macOS; `native:package` fails closed on other hosts instead of
emitting or publishing package evidence. Both declared macOS runners execute the complete native
command set, including packaging, with stable Rust, rustfmt, clippy, and the pinned coverage-only
nightly installed by the native matrix.

Root coverage runs exactly one test file at a time. Serial execution prevents native filesystem
helper compilers and race fixtures from intermittently contending for shared runner resources. The
custom reporter emits one bounded failure line containing validated failure type and error code.
Test identity and message fields retain only ordinary allowlisted ASCII diagnostics; any path, URI,
email, structured marker, credential or key marker, long token-like value, control byte, or other
non-allowlisted character replaces the whole field with a stable placeholder. Stacks, causes, and
raw error objects are never emitted.

Productive native quality begins with the exact standalone frontend `npm ci` command owned by
`native:dependencies`; install scripts and npm workspace inference are disabled. Each native gate
captures the exact Git tree into a private mode-0700 snapshot and compiles the repository-owned
native filesystem quality helper from the eight expected Git blobs. The runner verifies the source
set, Git-blob IDs, SHA-256 digests, and tree identity before compilation and verifies the sources
again before publishing the private mode-0700 executable. Compiler inputs are inherited read-only
descriptors, including descriptor-bound local headers; mutable source pathnames are never compiler
inputs. Compiler failure, unexpected output, or detected source drift recursively cleans the private
random build root and fails closed.

Node and macOS do not expose descriptor-based process execution (`fexecve`) through the supported
spawn interface. Helper execution therefore trusts the fresh same-user mode-0700 snapshot root,
opens the expected helper without following links, binds its SHA-256 and full file identity, and
checks descriptor-to-name identity immediately before and after pathname spawn. A changed owner,
mode, name, byte digest, or identity fails closed. This boundary excludes a malicious process
already running as the same local account, which can modify another same-user private directory;
defending against that stronger host-compromise model would require a separately approved native
launcher or privilege boundary and is outside the repository quality helper's authority.

On macOS and Linux, that dependency-free POSIX C helper performs mutable dependency, generated
package, evidence, and delivery operations through descriptor-relative traversal. It rejects
symlinked components, non-regular files, replacements, concurrent changes, and root-identity drift.
Writes use exclusive no-follow creation. Existing delivery directories are atomically exchanged
with a fully staged tree (`renameatx_np` on macOS and `renameat2` on Linux); an unavailable atomic
exchange fails closed instead of degrading to a non-atomic replacement. The runner accepts only the
canonical `/var` to `/private/var` macOS system alias during private-root creation and does not
resolve a caller-supplied final root symlink.

The helper copies the installed frontend dependencies into the private snapshot before inventory.
The snapshot requires the npm-ci hidden lock marker, binds it to the committed lock and exact
installed package inventory (including empty or unexpected top-level entries), rejects unexpected
or non-regular inputs, and retains a deterministic digest of every copied dependency byte. It
becomes read-only before the native command starts, and the command never reads the original
`node_modules` after capture. This proves reproducibility of the installed tree used by the gate;
it does not independently reproduce npm registry tarball-integrity verification. That residual
trust remains with the preceding exact npm-ci operation and npm's verification of the committed
integrity records.

The bootstrap quality control plane deliberately keeps third-party execution surface minimal:
Prettier is the only npm development dependency. Markdown policy and LCOV generation are local,
tested Node.js gates, and coverage uses the Node.js 24 test runner with the same 85% floors.
