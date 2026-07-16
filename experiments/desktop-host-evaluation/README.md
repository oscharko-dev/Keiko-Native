# Desktop host evaluation evidence

This directory is the temporary evaluation workspace and the intended evidence-only retention
layer for [Keiko Native issue 9](https://github.com/oscharko-dev/Keiko-Native/issues/9). The
governing planning contract is version `v1`, with readiness fingerprint
`4ef64b75cd9b2f4786f1317f360542b81a65cde058777709b4f2eeb233fc065e`.

The retained paper screen is in [`paper-screen.md`](paper-screen.md). Its citation registry is
[`sources.json`](sources.json). These records use only public official or primary sources. They do
not depend on the private product source.

## Evidence boundary

The candidate applications, evaluation runner, fixtures, test hooks, lockfile, and generated
packages in this directory are throwaway evaluation material. They are not productive Keiko Native
architecture and are not authorized to enter `dev`. Their frozen prototype source commit is
`cbbec89b509216df23cdab99842942e4ece5dabc`.

Before the decision pull request is ready for human review, the throwaway source and test-only
drivers will be removed. The retained layer will contain only sanitized results, schemas, source and
package references, official-source research, reproduction metadata, and the governed decision
record outside this directory. Generated binaries, path-bearing logs, user data, credentials, and
private evidence are never retained.

## Canonical experimental commands

The frozen experiment pins Rust `1.92.0`. From the repository root, the contract commands are:

```shell
cargo run --locked --manifest-path experiments/desktop-host-evaluation/Cargo.toml --bin keiko-eval -- verify --platform current
cargo run --locked --manifest-path experiments/desktop-host-evaluation/Cargo.toml --bin keiko-eval -- benchmark --platform current --output artifacts/current-platform.json
```

The repository quality control plane is checked separately with:

```shell
npm ci --ignore-scripts
npm run quality
npm audit --audit-level=high
```

## Current limitations

- The paper screen proves only which candidates warranted equal prototype work. `plausible` is not a
  demonstrated hard-gate pass.
- The paper screen has two survivors, Tauri 2 and Slint, but does not select a winner.
- Cross-platform prototype, manual accessibility and IME, release-package, signing, update,
  rollback, SBOM, provenance, and clean-machine evidence are evaluated elsewhere in this issue.
- Timing from virtual CI is diagnostic only. Physical Windows and Apple Silicon macOS evidence is
  authoritative for the contract's platform-specific observations.
- Candidate documentation can change after the access date. The source registry records the
  inspected version or channel and exact URL; later material requires an explicit evidence update.
- The current branch still contains throwaway prototype material. Its presence is temporary and
  does not satisfy the contract's removal requirement.

No decision is ready and no desktop host or renderer is selected by this artifact alone.
