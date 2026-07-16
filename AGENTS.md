# AGENTS.md — Working on Keiko Native

Read this file before changing the repository. It is the shared contract for humans and coding
agents. Architecture Decision Records under `docs/adr/` win over this file; report a conflict and
stop before crossing the affected boundary.

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

Keiko and Keiko Native are one product family with a governed shared core. Reuse an existing Keiko
contract, policy, evidence, memory, connector, workflow, and security boundary before creating a
second subsystem. Native platform adapters must remain narrow and must not fork shared policy.

## Local green bar

Use Node.js 24.18.x and npm 11.16.x for the repository quality control plane. Use npm only; the
committed `package-lock.json` is authoritative.

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

## Engineering rules

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

`main` is the protected integration branch. Work on `type/short-slug` branches and use pull
requests. Never push directly to `main`, force-push, bypass a required gate, dismiss a finding to
obtain green status, or widen task authority. Signed commits, linear history, resolved
conversations, and exact current-head checks are required.

Direct deterministic GitHub Actions, CodeQL, SonarQube Cloud, OSV, Dependency Review, and Socket
checks own merge authority. Gitar and `Keiko for Quality` remain independent advisory evidence until
their availability and liveness probes satisfy `docs/qa/quality-gates.md`. A successful processing
badge never substitutes for zero unresolved findings on the exact current head.

Before pushing, review the full diff against the task requirements, trust boundaries, failure modes,
and every affected gate. Use GitHub only for remote-only evidence, not as the primary test loop.
