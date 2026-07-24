# AGENTS.md — Working on Keiko Native

Read this file before changing the repository. It is the shared contract for humans and coding
agents. Architecture Decision Records under `docs/adr/` win over this file; report a conflict and
stop before crossing the affected boundary.

Read `CONTEXT.md` before substantial product, domain-model, or architecture work. It defines the
canonical product language and resolved scope boundaries. `AGENTS.md` governs how work is carried
out; `CONTEXT.md` defines what the product terms mean.

## Required preflight

Use a work-type preflight instead of loading every governance document before every prompt:

| Trigger                       | Required review before work starts                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New task                      | `AGENTS.md`, `CONTEXT.md`, and `docs/planning/decision-addendum.md`                                                                                                                          |
| Epic or issue authorship      | Relevant `docs/planning/agent-planning-baseline.md` sections, parity decisions, accepted Native ADRs, `docs/engineering/code-quality-standard.md`, current template, and Definition of Ready |
| Architecture or security work | Relevant Native ADRs, trust boundaries, threat assumptions, and affected quality contracts                                                                                                   |
| User-facing UI work           | `docs/planning/native-design-baseline.md`, adopted component and state contracts, and applicable accessibility requirements                                                                  |
| Implementation                | Accepted issue, acceptance criteria, issue Quality Plan, verification commands, `docs/engineering/code-quality-standard.md`, relevant ADRs, and affected module contracts                    |
| Pull request or handoff       | Complete diff, acceptance criteria, trust boundaries, failure modes, required gates, and evidence obligations                                                                                |

Repeat the relevant preflight whenever the task changes work type, scope, trust boundary, or target
platform. Read the smallest complete set of relevant records; do not load all ADRs, all design
references, or the full product specification when they cannot affect the task. Automated gates
verify compliance but do not replace understanding the applicable contract before implementation.

The private product source is provenance only under `docs/product/source-baseline.md`; never commit,
quote, or require access to it. `docs/planning/agent-planning-baseline.md` is the repository-owned
functional and quality source for planning. Before an epic becomes ready, the planner must select
and restate every issue-specific requirement in its Planning Contract and decompose complete
executable slices into child issues. Planning and implementation must be possible entirely from
repository records and accepted GitHub contracts.

## Accepted planning contract

Any contributor may create a draft epic or issue. An authorized planning actor may request readiness
after the template is complete and all product, UX, policy, risk, scope, and architecture decisions
have been resolved. A planning agent acting under an explicit planning or grilling task is an
authorized planning actor and may request readiness without a second GitHub approval or human
comment.

The canonical target state meanings, transition requests, actors, preconditions, recovery, and
evidence rules are defined by [`docs/qa/issue-lifecycle.md`](docs/qa/issue-lifecycle.md). The
canonical lifecycle states are `status: new`, `status: triaged`, `status: ready`,
`status: in progress`, `status: pr open`, `status: ready for human review`, `status: blocked`,
`status: waiting for user`, and `status: done`. Until the signed final Contract-as-Code activation
switch, that expanded lifecycle is inert: readiness is requested directly from `status: new`,
rejected or invalidated work returns to new, and `status: ready` with its exact matching accepted
record remains the only executable state.

The planning actor requests readiness by applying `status: ready`. The repository workflow keeps
that label only after validating the contract and recording its version and fingerprint; otherwise
it restores `status: new`. Only `status: ready` with a matching readiness record makes an epic or
issue executable. The fingerprint binds the normalized title and issue body. Only progress
checkboxes in acceptance, completion, and Definition-of-Done sections are excluded; classification,
platform, readiness, and all other checkbox states remain contractual. Record actual implementation,
verification, and audit evidence in the pull request or issue comments rather than editing the
frozen contract.

A change to outcome, classification, planning authority, scope, non-goals, acceptance criteria,
Quality Envelope or Quality Plan, interfaces, architecture or trust boundaries, target platforms,
verification or audit obligations, delivery target, or implementation authority is semantic. Stop,
increment the contract version, restore `status: new`, and obtain a new successful readiness
validation before implementation starts or resumes. The planning agent may request that validation
after the changed decisions have been resolved with the user during planning or grilling. Never
reinterpret issue editing or readiness automation as authority to expand the accepted task.

A wording-only correction that does not change meaning may retain its contract version, but the edit
still invalidates the old fingerprint and requires a new successful readiness validation. Never
classify a semantic change as wording-only to avoid versioning or replanning.

Every implementation issue must provide a compact Execution Authority that names the authorized
repository, exact delivery target, allowed write scope, additional prohibitions, external mutations,
credential requirements, merge boundary, and any additional stop conditions. Repository defaults
remain here and are not copied into the issue. Missing or contradictory authority fails the
Definition of Ready.

The accepted parent epic and implementation issue together are the complete implementation
contract. An instruction to consult the private source, infer omitted requirements, or obtain
private-source access is a missing-requirement defect: stop and return the work to planning.

The target branch is frozen planning scope because it determines delivery and merge authority. The
source branch is runner-managed execution evidence: use a dedicated branch with the runner's own
prefix, include the issue number, never reuse it across issues, and record its actual name when work
starts or in the pull request. An agent-specific source-branch name does not require replanning when
the accepted target and authority remain unchanged.

## Human control and trust boundaries

Keiko Native is the native desktop edition of Keiko. The same non-negotiable invariant applies: a
local human selects or accepts the task, autonomy mode, Authority Envelope, and deployment ceiling.
Automation may act only inside that validated authority. Invalid or expired authority, workspace
escape, denied sensitive paths, secret exfiltration, unsupported actions, exhausted budgets, and
platform restrictions fail closed.

Never weaken a quality gate, trust boundary, redaction rule, or branch protection setting to make a
change pass. Secrets, raw customer content, credentials, endpoints, and PII must not enter source,
logs, tests, evidence, artifacts, issues, or pull requests.

## Repository phase and reuse

`quality/project.json` is the machine-checked project contract. During `bootstrap`, productive
Swift, Rust, C, C++, Objective-C, Kotlin, Java, Go, C#, JavaScript, or TypeScript source is denied.
Before the first productive source lands, change the phase to `productive`, declare every source
root and native target, and add deterministic build, test, coverage, architecture, signing, package,
and platform gates in the same pull request.

Keiko Native is a greenfield rewrite with no mandatory build-time or runtime dependency on Existing
Keiko. Existing Keiko provides evidence for behavior, quality, security, UX, and known failure
modes. Every contract, policy, algorithm, asset, workflow, component, or other reuse candidate
requires a case-by-case Reuse Assessment. Adopted material becomes fully owned, tested, secured,
and maintained by Keiko Native; do not create a shared core by default.

## Local green bar

Use exactly Node.js 24.18.0 and npm 11.16.0 for the repository quality control plane. Use npm only;
the committed `package-lock.json` is authoritative.

```bash
npm ci --ignore-scripts
npm run quality
npm audit --audit-level=high
```

`npm run quality` validates the repository contract, Gitar/provider configuration, Markdown,
formatting, tests, 85% line/branch/function/statement coverage, and the bootstrap smoke path. A
change is not ready for publication until this complete command is green.

For productive native code, the future target-specific commands declared by `quality/project.json`
are additional mandatory gates. Platform-specific release and signing evidence must be generated
on its authoritative platform; macOS evidence cannot stand in for Windows or Linux evidence.

For user-facing work, the accepted issue must define an Acceptance Journey with observable
checkpoints, failure and recovery behavior, platform differences, and expected automated and manual
evidence. Test user-visible behavior instead of selectors or incidental implementation details. A
non-user-facing issue must record why a journey does not apply.

Before the first push, every locally executable journey check and the complete local green bar must
pass. A draft pull request may then collect remote or authoritative-platform evidence. Do not mark a
pull request `Ready for Human Review`, auto-merge it into an epic branch, or merge it into `dev`
until all required automated journey checks, manual observations, platform evidence, and exact-head
gates are complete.

## Engineering rules

Follow `docs/engineering/code-quality-standard.md`. Quality is planned at epic and issue creation,
made concrete in the issue Quality Plan, and verified before implementation begins. Do not start
productive implementation when acceptance criteria, applicable quality areas, or verification
commands are missing.

- Prove regressions with a failure-first test and cover malformed, empty, boundary, hostile,
  unauthorized, unavailable, stale, replayed, and partially failed inputs where applicable.
- Fix the whole defect class at the owning layer. Do not duplicate policy or patch around an
  invariant at one call site.
- Validate untrusted workspace, model, connector, IPC, filesystem, network, and persisted input
  before use. Authentication and authorization remain separate.
- Keep diagnostics actionable and redacted. Do not swallow errors or emit raw request/response
  bodies.
- Tests are hermetic: no real network, shared mutable global state, wall-clock sleeps, or free-port
  assumptions.
- Keep workflows least-privileged and pin every external GitHub Action to a full 40-hex commit SHA.
- Use English for code, comments, identifiers, documentation, commits, issues, and pull requests.
- Match the formatter and neighbouring code. Delete dead code; do not hide unfinished behavior in a
  TODO.

## Delivery

`dev` is the protected integration and default branch. Use a dedicated runner-prefixed source
branch that includes the accepted issue number and deliver through a pull request to the issue's
exact target. Never push directly to `dev`, force-push, bypass a required gate, dismiss a finding to
obtain green status, or widen task authority. Signed commits, linear history, resolved
conversations, and exact current-head checks are required.

Direct deterministic GitHub Actions, CodeQL, SonarQube Cloud, OSV, Dependency Review, and Socket
checks determine technical merge eligibility. They do not grant authority to choose or perform a
merge into `dev`. Gitar and `Keiko for Quality` remain independent advisory evidence until their
availability and liveness probes satisfy `docs/qa/quality-gates.md`. A successful processing badge
never substitutes for zero unresolved findings on the exact current head.

Repository coverage runs on every accepted CI event. CI-based SonarQube Cloud analysis runs only
for pull requests targeting `dev`, pushes to `dev`, and manual dispatches bound exactly to `dev`.
Epic pull requests and pushes retain every applicable non-Sonar gate without requesting unavailable
non-main branch data. The final epic pull request supplies the integrated Sonar evidence for `dev`.

`Ready for Human Review` is the automation stop state for every pull request targeting `dev`. Only
an authorized maintainer may manually initiate that merge; the current allowlist is limited to Niko
and Oscharko. A separate non-author approval is not required, so either maintainer may merge their
own pull request after personally reviewing the linked issue, acceptance criteria, Quality Plan,
evidence, exact current head, findings, conversations, and residual risks. An agent must never merge
into `dev`, enable auto-merge for a pull request targeting `dev`, or use a human credential to evade
this boundary.

The sole automated-merge exception is an accepted child-issue pull request targeting its exact
accepted `epic/**` target. Under ADR-0009, an agent may use the existing authenticated maintainer
credential only through the repository-owned guarded operation and only after independently
revalidating the open issue, accepted contract and target, `status: ready for human review`,
source issue number, exact current head and base, applicable green gates, completed acceptance and
audit evidence, and zero blocking findings or unresolved review conversations. The operation
submits at most once, verifies the exact target tip and ordered parents, never uses provider
auto-merge, and retains no credential material. Wrong, changed, stale, closed, unavailable,
replayed, or non-exact authority fails closed. An ambiguous result causes no retry and requires
human reconciliation. Shared GitHub attribution cannot distinguish agent and human actions; this
accepted limitation does not widen agent authority. An agent must never merge, enable auto-merge,
enqueue, push, or update `dev`, `main`, or `release/**`, including through a maintainer credential.
The exception does not extend to epic or standalone pull requests targeting `dev`.

Before pushing, review the full diff against the task requirements, trust boundaries, failure modes,
and every affected gate. Use GitHub only for remote-only evidence, not as the primary test loop.
