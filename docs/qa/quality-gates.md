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
evidence, required and advisory findings, review conversations, and residual risks. Agents must not
merge into `dev`, enable auto-merge, enqueue a merge group, update its ref, or use a human
merge-capable credential for any `dev` effect.

For a fully eligible child-issue pull request, an agent may use the existing authenticated
maintainer credential only through the ADR-0009 guarded operation and only for its exact accepted
`epic/**` target. Epic and standalone pull requests remain human-only deliveries to `dev`.
Immediately before the effect, the guard independently revalidates current issue authority and
`status: ready for human review`, exact source and target refs, applicable exact-head checks,
acceptance and audit evidence, findings, review conversations, stable reads, and replay state. It
persists a durable single-flight compare-and-set claim for target/base serialization before any
provider submission. The target/base serialization
uniqueness key consists only of repository, exact accepted target, and observed current base. The
immutable per-operation record binds issue, contract, readiness, pull request, exact head, and
request identity. Distinct request identities cannot create another serialization claim. Two
distinct child-issue pull requests for the same exact accepted target and observed base contend on
that one key; only one may reach provider submission. It submits at most once with the exact
expected head by passing the exact revalidated head SHA as the provider request's `sha` parameter
and explicitly sends `merge_method: squash`. It never uses provider auto-merge and verifies that
the exact target tip is the reported squash commit, whose sole parent is the observed base and whose
tree equals the observed head tree. Any mismatch, stale or unavailable evidence, failed or skipped
required check, unresolved item, closed issue, changed ref, ambiguous response, or non-exact target
fails closed. An ambiguous claim remains blocked with no retry until explicit human reconciliation
using exact refs, the squash commit, its parent, and the observed trees. A new request identity is
permitted only after explicit terminal settlement or human reconciliation and fresh revalidation.

This shared identity means GitHub attribution cannot distinguish an agent operation from a
deliberate human action, and repository identity rules cannot technically constrain the credential
to only the guarded effect. The agent policy and guard categorically deny `dev`, `main`,
`release/**`, feature, wrong-epic, direct-ref, provider auto-merge, queue, administration, and
bypass operations. Repository protections remain defense in depth, not a claim of separate
identity. Credential or guard unavailability selects human-only child integration. The accepted
issue, request identity, exact refs, actor, closed provider result, squash commit, parent and tree
identifiers, and post-effect read-back form the sanitized audit trail; credentials and raw provider
bodies never enter evidence. An agent must never merge, enable auto-merge, enqueue, push, or update
`dev`, `main`, or `release/**`, including through the existing authenticated maintainer credential.

## Bootstrap and productive phases

The `native` check validates the versioned project contract. During bootstrap it proves that the
quality control plane is operational and that no undeclared productive source exists. It does not
claim that a native application has already been built.

Before productive code lands, the project manifest and CI must add language- and platform-specific
compilation, unit/integration tests, architecture checks, 85% coverage with reserve, artifact
inventory, SBOM, sandbox/egress tests, package verification, and signing/notarization evidence.
Missing target evidence fails closed.

ADR-0007 closes the Foundation v0.1 internal macOS milestone with unsigned-package evidence, not
public Apple trust. `native:signing` proves that the internal package contract is active and that
Apple credentials are absent. `release:verify` adds exact-head deterministic image, inventory,
SHA-256, SPDX 2.3, mounted copy-out, cleanup, and closed-redaction evidence. Developer ID signing,
notarization, stapling, public delivery, production update signing, and physical Gatekeeper evidence
remain mandatory for a later public release under issue #59; the internal lane does not waive them.

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

For the internal macOS lane, `.github/workflows/internal-release.yml` is the authoritative remote
artifact check. It builds on `macos-14`, verifies on `macos-26`, attests only after local
verification, re-verifies attestation after download, and retains the exact-revision artifact for
14 days. It has no tag, release, public upload, environment, Apple secret, or product updater
authority. The complete artifact and failure contract is in
[`internal-macos-release.md`](internal-macos-release.md).

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
npm first installs the exact Node distribution through the pinned setup action and verifies its
bundled npm 11.16.0 before any npm command. Workflows do not replace the bundled executable with
Corepack shims. Contract tests reject missing, conditional, reordered, or version-drifted
verification.

Packaged-shell acceptance uses a 30,000 ms functional-liveness watchdog while waiting for the
two-request acknowledgement. This operational bound allows cold macOS/WebKit startup without
turning the harness into a startup-performance assertion; performance-distribution evidence remains
excluded. Once acknowledgement arrives, the independently accepted 5,000 ms normal-shutdown budget
still applies exactly, and each application IPC request remains bounded to 1,000 ms.

Cargo's committed lock is intentionally cross-target, while the declared native deliverable is
only `aarch64-apple-darwin`. Vulnerability workflows therefore derive a transient inventory from
the exact locked Cargo resolve graph filtered to that target, then scan it with the checksum-pinned
OSV 2.3.8 binary together with both npm locks. A closed result validator enforces the repository's
moderate threshold. Missing or unknown severity fails closed unless RustSec classifies every
affected record only as `informational: unmaintained`, supplies no CVSS score or patched range, and
matches the expected schema and source. Mixed, malformed, patched-informational, low, moderate,
high, and critical records remain distinguishable; moderate and above block. GitHub Dependency
Review retains its exact diff, scope, license, and OpenSSF checks; only its platform-blind
vulnerability decision is disabled in favor of the target-aware OSV step in the same read-only job.
No advisory exception, ignore list, warning mode, universal-Cargo-lock scan, or lowered threshold is
permitted.

Dependency Review's license parser cannot represent the SPDX expression
`Apache-2.0 WITH LLVM-exception` even though that expression is already accepted by the
repository-owned dependency policy. The workflow therefore carries one exact package-URL exception,
`pkg:cargo/target-lexicon@0.12.16`, for that already-reviewed locked package. Contract checks reject
removal, version drift, or any additional package exception; the general license allowlist, scope,
OpenSSF, and target-aware vulnerability controls remain unchanged.

Tauri 2.11.5 reaches `urlpattern` 0.3.0 through `tauri-utils` 2.9.3 on macOS arm64. That frozen stack
currently retains five visible RustSec informational-unmaintained signals with no patched version:
`unic-char-property` (RUSTSEC-2025-0081), `unic-char-range` (RUSTSEC-2025-0075), `unic-common`
(RUSTSEC-2025-0080), `unic-ucd-ident` (RUSTSEC-2025-0100), and `unic-ucd-version`
(RUSTSEC-2025-0098). They remain in the uploaded exact-head OSV results and are not advisory
exceptions or claims of zero findings.

The Linux `core-quality` job runs `quality:control`, the portable Node and repository-contract suite
shared with root `quality`. The full root `quality` command then runs every native gate and is
authoritative only on Apple Silicon macOS; `native:package` fails closed on other hosts instead of
emitting or publishing package evidence. Both declared macOS runners execute the complete native
command set, including packaging, with stable Rust, rustfmt, clippy, and the pinned coverage-only
nightly installed by the native matrix. The matrix has a 45-minute job ceiling so the complete
fail-closed chain can finish on either runner; the packaged journey and shutdown operations retain
their independently enforced functional timeouts.

Root coverage runs exactly one test file at a time. Serial execution prevents native filesystem
helper compilers and race fixtures from intermittently contending for shared runner resources. The
custom reporter suppresses pass-event names and emits no arbitrary test identity or failure-message
text. A failure contains only fixed rerun guidance plus failure type and error code selected from
strict closed catalogs; every unknown metadata value becomes `unknown`. Stacks, causes, paths,
payloads, and raw error objects are never emitted. LCOV source paths remain independently validated
as repository-contained paths.

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
