# Foundation decision evidence index

## Status

Current retained decision evidence selects Tauri 2 for the macOS Foundation v0.1 stack. The evidence
is issue-scoped to #11 contract v2 and must not be reused as Windows acceptance evidence.

Superseded v1 source, binaries, timings, Windows results, and fingerprints are excluded. Only the
current sanitized benchmark, official-source records, licence inventories, physical observations,
and ADR/report records below are retained.

## Exact-head bindings

| Field                 | Binding                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| Issue contract        | #11 v2                                                                       |
| Readiness fingerprint | `ee7934be0bfcc74630bfb071ec05c724ed97a2458d4b9238d60561292cc06469`           |
| Evidence commit       | `7614c18d98077b96e1da89d0b7493515c96a042e`                                   |
| Evidence tree         | `e760a1d50a814bae24a23b5e70acbdfa3f772e40`                                   |
| Benchmark ID          | `087910f94c8189526de1d143bf1dd9c2ffe2defac763f394da175cbd961d43ea`           |
| Benchmark file        | [`foundation-benchmark.json`](foundation-benchmark.json)                     |
| Benchmark SHA-256     | `23d558d7a5c4da7e719e0e2afd660648475c018255d25b3dbc0e498871f1a1b6`           |
| Benchmark authority   | Physical owner Apple M4, 16 GiB, macOS 26.5.1, arm64                         |
| Benchmark count       | 20 cold and 30 warm launches per candidate; `quick=false`; alternating order |
| Harness digest        | `1fc358534ec9a5d5f22117c35070462a250ed9ceaf1301a15825de9ed0492af1`           |

## Candidate package bindings

| Candidate | Source SHA-256                                                     | Lock SHA-256                                                                                                                                     | Evaluation package SHA-256                                         | Release-like package SHA-256                                       | Release-like bytes |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | -----------------: |
| Tauri 2   | `ec92ea434fe3474e894a8be1dd68d69393c42d4d2556509ab44178b85a9a1144` | Cargo `8f3d027a9c87907d4f266f2135ab19bc78f6df23eabe8f88e34efe53b43737d3`; npm `ff1b106cdee2f72dcb736839e019a257d78ac160c5b0dc36162480e099ebc739` | `35e8b3bb6dede3de8d0c9e3bd8b67d82df5b4ae3f3779db44935bebcaa5851ed` | `d7eef5852f4fc0c940a38a07b6871abf7b990e776ad9e209895d98f8f6e77ea3` |          3,987,305 |
| Slint     | `f4186fa3be5f91e66251dab30260f38affca42f73815c11c180293269111533b` | Cargo `42e765941098f99e33c13b8951bb8f3fa934248b22adfe0f0ef30110ef5aa707`                                                                         | `e502598551887711046e11c115f2973898f44712159315fc4c9c1a35e187b5ad` | `a9658ae1b67af425d41e10f27c8ac59d0ac33f17a688d9c4afa5cf87bd6fb6d8` |          8,528,257 |

Both release-like package scans report zero test-hook marker findings and passed closed
release-composition proof.

## Retained repository evidence

| Artifact                                                         | Current purpose                                                                                                           | Binding                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`sources.json`](sources.json)                                   | Revalidated official-source index and explicit evidence gaps                                                              | Schema 1; file SHA-256 `f37456a5e61cb6c9024819552badc680a78ca6aecb785fe46d2f1c13ea828a50`                                                                   |
| [`paper-screen.md`](paper-screen.md)                             | Source-backed disposition of the six non-prototyped options                                                               | Issue #11 contract v2 / epic #9 contract v5                                                                                                                 |
| [`foundation-benchmark.json`](foundation-benchmark.json)         | Sanitized raw samples, package/source/lock bindings, hard-gate results, release-hook scans, and release-composition proof | SHA-256 `23d558d7a5c4da7e719e0e2afd660648475c018255d25b3dbc0e498871f1a1b6`; benchmark ID `087910f94c8189526de1d143bf1dd9c2ffe2defac763f394da175cbd961d43ea` |
| [`foundation-decision-report.md`](foundation-decision-report.md) | Gate outcomes, replacement formula, weighted matrix, dissent, risks, and CH-3 handoff                                     | Derived only from #11 v2 exact-head evidence                                                                                                                |
| [`physical-observations.md`](physical-observations.md)           | Sanitized equal release-package VoiceOver, IME, appearance, scaling, and restoration observations                         | Release-like package digests named in that file; no speech audio or screenshots retained                                                                    |
| [`licence-source-inventory.md`](licence-source-inventory.md)     | Exact-head dependency/licence inventory summaries and productive review obligations                                       | Inventory digests listed in that file                                                                                                                       |
| [`ADR-0004`](../adr/ADR-0004-tauri-macos-foundation-stack.md)    | Accepted scoped macOS architecture contract and Windows reopen                                                            | Accepted from this evidence set                                                                                                                             |

## Source map

- Tauri boundary and automation: T01-T02.
- Tauri updater, signing, and framework licence: T03-T05.
- Slint platform, semantics, test surface, licence, and updater gap: S01-S05.
- Apple physical automation, signing, and notarization: A01-A02.
- Runner identity: GH01.
- Paper-screened alternatives: Q01-Q06, P01-P02, D01-D04, F01-F05, N01-N04, and B01-B03.

Each identifier resolves to its official URL, inspected version, and bounded claims in
[`sources.json`](sources.json). The explicit gaps GAP-SLINT-UPDATER, GAP-SLINT-LICENCE, and
GAP-SLINT-TEST-ISOLATION are source-backed evaluation inputs and contributed to Slint's failed
replacement gate in this issue. They are not claims that a future Slint solution is impossible.

## Retention and exclusion

Only sanitized decision evidence is retained. Throwaway source, packages, temporary quality
declarations, raw local receipts, hostnames, usernames, paths, stable machine identifiers, secrets,
customer content, and superseded experiment output are not decision artifacts. Diagnostic runner
timing cannot replace the authoritative physical benchmark. The six paper-screen candidates were
not prototyped, and their source records must not be represented as measured results.
