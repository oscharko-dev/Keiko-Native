# ADR-0004: Tauri macOS foundation stack

## Status

Accepted.

## Context

Issue #11 contract v2 and epic #9 contract v5 require a macOS-only foundation decision between
Tauri 2 with the system WebView and Slint. Tauri is the owner-preferred option; Slint may replace it
only by passing every absolute gate and the frozen replacement win-gate. Six additional options
were limited to the source-backed paper screen in
[`paper-screen.md`](../evaluation/paper-screen.md).

Fresh evidence at commit `6a9fa49d86a82a698af5c1ac6e5da1690676dfaa` selects Tauri. The evidence is
bound to #11 v2 readiness fingerprint
`ee7934be0bfcc74630bfb071ec05c724ed97a2458d4b9238d60561292cc06469`, physical owner Apple M4
16 GiB macOS 26.5.1 authority, 20 cold and 30 warm launches per candidate, release-like package
inspection, physical VoiceOver/IME/appearance/scaling observations, official-source records, and
exact dependency inventories.

The superseded v1 branch remains excluded. Its source, binaries, timings, Windows results, and
fingerprint are not accepted evidence for this ADR.

## Decision

Keiko Native selects **Tauri 2 with the macOS system WebView and a bundled React/TypeScript
frontend** for the macOS Foundation v0.1 stack.

The accepted baseline is:

- Rust 1.92.0, edition 2024;
- `tauri` 2.11.5 with `wry` 0.55.1 and default features disabled;
- `tauri-build` 2.6.3 and Tauri CLI 2.11.4 for the evaluated build route;
- React and React DOM 19.2.7, TypeScript 5.9.3, Vite 7.3.6, and axe-core 4.12.1; and
- the exact source, lock, package, and licence-inventory digests recorded in the evidence section.

CH-3 must introduce these pins through its productive-phase dependency and supply-chain review.
Later version changes are ordinary reviewed dependency changes only when they preserve this ADR's
architecture and gates; a change of host, renderer class, trust boundary, or automation isolation
requires a superseding ADR.

### Evidence summary

The retained decision records are:

- [`foundation-benchmark.json`](../evaluation/foundation-benchmark.json), benchmark ID
  `f28abb0708d8d4ea2f775fd993b58f1703528cfc5a470f4d4a0d95acbec5f0a8`, file SHA-256
  `d64e0d75cdcad6010fbd2be55cdc8f7939d25cde17342218117fe9b0b1425c40`;
- [`foundation-decision-report.md`](../evaluation/foundation-decision-report.md), with hard-gate
  results, replacement formula, weighted matrix, dissent, and CH-3 handoff;
- [`physical-observations.md`](../evaluation/physical-observations.md), with release-package
  VoiceOver, IME, appearance, scaling, restoration, and cleanup observations; and
- [`licence-source-inventory.md`](../evaluation/licence-source-inventory.md), with exact-head
  dependency inventory summaries and productive review obligations.

GitHub Actions run `29609865566` adds diagnostic `macos-14` and `macos-26` arm64 build, package,
and quick timing evidence at exact head `96d1e6a7c894bebbce2d4374da858d83478a6d97`. The artifact
JSON SHA-256 values are `7bf6a9ca0ba8f2fa94263118c62c317f6b9410a2fc0b0cba5228c323b688a870`
(`foundation-diagnostic-macos-14`) and
`75e60e60666cf614628b901110a1a4707b22f2855d7263fcd3e66d25fd3756b9`
(`foundation-diagnostic-macos-26`). These runner results validate clean-checkout packageability
and diagnostic harness execution only; they do not replace the physical owner benchmark authority.

Tauri package and lock bindings:

- source SHA-256 `6d2bca52902244e5b6784036cfb3fcc82defb7b1d6264dd3f55cf4c7e7e993f1`;
- Cargo lock SHA-256 `8f3d027a9c87907d4f266f2135ab19bc78f6df23eabe8f88e34efe53b43737d3`;
- npm lock SHA-256 `ff1b106cdee2f72dcb736839e019a257d78ac160c5b0dc36162480e099ebc739`;
- evaluation package SHA-256 `9ec6a1ceec305b3fdd31592e12b6d94a15efc73dfd43305b9a83c915e6359b65`; and
- release-like package SHA-256 `d7eef5852f4fc0c940a38a07b6871abf7b990e776ad9e209895d98f8f6e77ea3`.

Slint package and lock bindings:

- source SHA-256 `ad580c84d68f942b53a7817dfa0825b501d0ba0748a8dfbe4d9ebe4f44eb2d56`;
- Cargo lock SHA-256 `42e765941098f99e33c13b8951bb8f3fa934248b22adfe0f0ef30110ef5aa707`;
- evaluation package SHA-256 `07d276bbecee4d9cfaa541550892999e8358610f06722174ae8ba3a2f6dc1a0a`; and
- release-like package SHA-256 `c0cee4e292c89ab2c442a893541df3fe1c7b9f173113822b44887d98f9b7134e`.

Tauri passed all absolute benchmark hard gates and the physical VoiceOver, IME, Dark/Light
appearance, scaling, release-hook exclusion, release-composition, and cleanup gates. Slint passed
several lifecycle and performance checks but failed input-to-paint p75/p95, governed native
semantic-tree automation, physical VoiceOver journey completeness, Dark appearance, the required
Royalty-free attribution surface, and the Slint-owned integrated signed-update recipe. Slint also
failed the frozen replacement formula: no comparable hard metric improved by 20%, input-to-paint
p95 regressed 18.0%, and release-like payload size regressed 113.9%.

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
`tauri://localhost` origin or Tauri's platform-equivalent `http://tauri.localhost` representation,
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
`keiko-native-desktop` package from a clean workspace, obtains the package digest and immutable
build identity, performs the health roundtrip through the actual bundled renderer, kills the
renderer to observe unavailable/recovery behavior, requests normal application shutdown, escalates
only after 5,000 ms, and proves zero owned descendant processes. Contract-mode tests additionally
cover every request bound and reason code through dependency injection without adding a product
command.

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

This ADR resolves macOS only. It does not close APD-01, APD-08, or APD-11 for Windows. Before the
first productive Windows foundation or Windows release work, a new decision issue must reopen this
choice on an authoritative physical Windows reference system and a clean Windows runner. The reopen
must use current locked dependencies and the same workload, thresholds, hostile cases, process
accounting, redaction, package isolation, and release-like inspection.

The Windows decision must additionally prove WebView2 runtime and distribution policy, UI
Automation semantics, keyboard and IME composition, native-dialog cancellation, high-contrast and
scaling behavior, owned process-tree cleanup, MSIX or the selected package identity, signing,
signed update and rollback, and Windows-specific payload and attributable RSS. Tauri remains the
default candidate, not a pre-approved Windows result. A Windows hard-gate failure, unavailable
free mandatory route, material support or licence change, or a competitor satisfying the complete
replacement win-gate requires a superseding decision before productive Windows work.

## Consequences

CH-3 receives one exact macOS host, renderer, frontend, trust boundary, and acceptance-harness
contract. It may start productive macOS foundation work only from the roots, dependency direction,
typed port, and packaged-shell evidence contract above.

Keiko is responsible for the WebView boundary, CSP and capability correctness, bundled frontend
supply-chain review, system-WebView variance, and web accessibility regression coverage. Tauri's
documented updater and signing routes are implementation inputs, not release acceptance; key
custody, rollback, notarization, provenance, and recovery still require productive implementation
and physical evidence.

Slint remains an evaluated macOS alternative, not an invalid framework. It may be reconsidered only
through a superseding decision that resolves the failed gates and meets the same workload,
threshold, evidence, licence, updater, and Windows-reopen obligations.
