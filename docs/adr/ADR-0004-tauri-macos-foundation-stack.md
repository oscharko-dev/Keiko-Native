# ADR-0004: Tauri macOS foundation stack

## Status

Proposed.

## Context

Issue #11 contract v2 and epic #9 contract v5 require a macOS-only foundation decision between
Tauri 2 with the system WebView and Slint. Tauri is the owner-preferred option; Slint may replace it
only by passing every absolute gate and the frozen replacement win-gate. Six additional options
were limited to the source-backed paper screen in
[`paper-screen.md`](../evaluation/paper-screen.md).

The earlier experiment output no longer matches the current candidate trees or package digests and
is not acceptance evidence. A fresh exact-head evaluation is pending. It must bind both candidates,
all four packages, the authoritative physical run, the clean macOS runner runs, and the complete
licence inventories to one authorized signed commit before this record can be accepted. No prior
metric, hard-gate outcome, physical observation, or recommendation is a current decision claim.

## Proposed decision

Subject to the pending exact-head evidence satisfying the frozen gates, Keiko Native proposes
**Tauri 2 with the macOS system WebView and a bundled React/TypeScript frontend** for the macOS
Foundation v0.1 stack. If the fresh evidence does not establish that result, this proposal must be
revised before CH-3 starts.

The proposed baseline is:

- Rust 1.92.0, edition 2024;
- `tauri` 2.11.5 with `wry` 0.55.1 and default features disabled;
- `tauri-build` 2.6.3 and Tauri CLI 2.11.4 for the evaluated build route;
- React and React DOM 19.2.7, TypeScript 5.9.3, Vite 7.3.6, and axe-core 4.12.1;
- exact Cargo and npm lock digests to be recorded from the fresh authorized commit.

If accepted, CH-3 must introduce these pins through its productive-phase dependency and
supply-chain review.
Later version changes are ordinary reviewed dependency changes only when they preserve this ADR's
architecture and gates; a change of host, renderer class, trust boundary, or automation isolation
requires a superseding ADR.

### Productive workspace and ownership

CH-3 must create exactly one Cargo workspace at `native/` and one npm workspace at
`native/frontend/`. The declared productive roots are:

- `native/crates/keiko-application/src/`, containing renderer-independent application contracts
  and policy;
- `native/crates/keiko-ui-port/src/`, containing the serialized UI port and no Tauri types;
- `native/crates/keiko-host-macos/src/`, containing macOS and Tauri adapters;
- `native/apps/keiko-desktop/src/`, containing only composition and lifecycle wiring; and
- `native/frontend/src/`, containing the bundled React presentation adapter.

The native package and Cargo binary target are both `keiko-native-desktop`; the bundle identifier
is `dev.oscharko.keiko-native`. Unit tests remain beside their owning source. Cross-crate contract,
architecture, package, and packaged-shell tests live under `native/tests/`. Cargo owns
`native/Cargo.lock`; npm owns `native/frontend/package-lock.json`. No second package manager,
renderer source root, shared core, or candidate-specific type is part of this baseline.

Dependencies point inward: the frontend depends on the serialized UI-port contract;
`keiko-ui-port` depends on `keiko-application`; the Tauri/macOS host implements application-owned
ports; and the desktop package composes them. Application code cannot import Tauri, WebKit, React,
AppKit, filesystem, process, shell, credential, updater, network, or coding-runtime adapters.

### Initial productive UI port

CH-3 implements one operation, `application-health`, over one Tauri command named
`application_request`. Its canonical JSON request is:

```json
{
  "schemaVersion": 1,
  "requestId": "request-00000001",
  "sequence": 1,
  "timeoutMs": 1000,
  "operation": { "kind": "application-health" }
}
```

The encoded request is at most 4,096 bytes. Unknown and duplicate fields are rejected. `requestId`
is 16 through 64 ASCII alphanumeric or hyphen bytes, is unique for the lifetime of the authenticated
renderer session, and is retained in a bounded 64-entry replay window. `sequence` is an integer from
1 through 9,007,199,254,740,991 and must be strictly greater than the last accepted sequence for
that session. `timeoutMs` is an integer from 1 through 1,000. The operation has no caller-controlled
payload. A renderer reload creates a new host-owned session and clears neither an in-flight request
nor its cancellation state until the old session has been failed closed.

The host accepts the request only from the Tauri window labelled `main`, with the bundled
`tauri://localhost` origin (or Tauri's platform-equivalent `http://tauri.localhost` representation),
while the application is in its accepting lifecycle state. Window identity, origin, schema,
serialized size, field closure, request identifier, sequence, timeout, and operation authorization
are checked before application code runs. Navigation and capabilities allow only bundled assets and
this command; all other commands, origins, windows, URLs, and capabilities are denied.

The successful canonical response is:

```json
{
  "schemaVersion": 1,
  "requestId": "request-00000001",
  "result": {
    "kind": "application-health",
    "status": "healthy",
    "build": {
      "version": "0.1.0",
      "sourceRevision": "40-lowercase-hex-characters",
      "targetTriple": "aarch64-apple-darwin"
    }
  }
}
```

Build values are compiled immutable package metadata, never renderer input. Failure uses the same
schema and request identifier with exactly one bounded reason code in `error.code`:
`invalid-request`, `payload-too-large`, `unsupported-schema`, `unknown-operation`,
`unauthenticated-sender`, `unauthenticated-origin`, `unauthorized`, `replayed-request`,
`stale-request`, `cancelled`, `timed-out`, `host-unavailable`, `shutting-down`, or
`internal-failure`. No response contains a path, origin string, raw input, stack, platform error,
credential, endpoint, hostname, username, customer content, or provider identifier.

Cancellation is application-owned and keyed by the accepted request identifier. Renderer exit,
session replacement, application shutdown, or an explicit local `AbortSignal` cancels in-flight
work; timeout wins only when its deadline is observed before cancellation. Completion is emitted at
most once, late adapter results are discarded, and replay, stale sequence, cancellation, timeout,
unavailable host, and shutdown are terminal for that request. CH-3 may inject clocks, cancellation,
and unavailable adapters in tests, but no mutation, delay, diagnostic, or evaluation command is
compiled into the product package.

### Repository-owned packaged-shell harness

The root `acceptance:macos` command owns the stable harness. It builds and launches the exact
`keiko-native-desktop` package from a clean workspace, obtains the package digest and immutable build
identity, performs the health roundtrip through the actual bundled renderer, kills the renderer to
observe unavailable/recovery behavior, requests normal application shutdown, escalates only after
5,000 ms, and proves zero owned descendant processes. Contract-mode tests additionally cover every
request bound and reason code through dependency injection without adding a product command.

The harness writes schema `keiko-native-packaged-shell-evidence/v1`, containing only source
revision, readiness fingerprint, package and lock digests, runner image identifier, architecture,
command outcomes, bounded reason codes, elapsed durations, cleanup counts, and a closed redaction
result. Each record is bound to the exact Git commit and package digest and exits nonzero for a
missing field, unknown field, failed check, non-arm64 target, test-hook marker, or redaction match.
Package inspection must prove that experiment commands, evaluation capabilities, fixture strings,
synthetic endpoints, test listeners, debug menus, relaxed CSP/navigation, and test-only dependencies
are absent.

The CH-5 user-facing journey extends this stable harness with visible presentation, focus and IME,
VoiceOver semantics, native cancellation, appearance and scaling, and renderer recovery. Physical
platform evidence remains mandatory where a runner cannot establish interaction, accessibility,
IME, signing, or packaging behavior. Evaluation-only operations used to make this decision are
throwaway evidence and are not the productive port or harness contract.

## Windows reopen

If accepted, this ADR resolves macOS only. It does not close APD-01, APD-08, or APD-11 for Windows.
Before the first productive Windows foundation or Windows release work, a new decision issue must
reopen this choice on an authoritative physical Windows reference system and a clean Windows runner.
The reopen must use current locked dependencies and the same workload, thresholds, hostile cases,
process accounting, redaction, package isolation, and release-like inspection.

The Windows decision must additionally prove WebView2 runtime and distribution policy, UI
Automation semantics, keyboard and IME composition, native-dialog cancellation, high-contrast and
scaling behavior, owned process-tree cleanup, MSIX or the selected package identity, signing,
signed update and rollback, and Windows-specific payload and attributable RSS. Tauri remains the
default candidate, not a pre-approved Windows result. A Windows hard-gate failure, unavailable
free mandatory route, material support or licence change, or a competitor satisfying the complete
replacement win-gate requires a superseding decision before productive Windows work.

## Consequences

If the pending evaluation accepts this proposal, CH-3 receives one exact macOS host, renderer,
frontend, trust boundary, and acceptance-harness contract. Until then, CH-3 has no authorized
foundation selection from this record.

Acceptance would make Keiko responsible for the WebView boundary, CSP and capability correctness,
bundled frontend supply chain, system-WebView variance, and web accessibility regression coverage.
Tauri's documented updater and signing routes are inputs, not release acceptance; key custody,
rollback, notarization, provenance, and recovery would still require productive implementation and
physical evidence.

Slint remains an evaluated macOS alternative, not an invalid framework. Its final disposition and
any dissenting measurements remain pending the fresh exact-head evidence. After acceptance, the
decision can be revisited only by a superseding ADR under the documented reopen conditions.
