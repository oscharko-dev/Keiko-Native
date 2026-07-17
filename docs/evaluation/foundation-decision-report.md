# Foundation host decision report

## Status

Accepted recommendation: use **Tauri 2 with the macOS system WebView and a bundled
React/TypeScript frontend** for the macOS Foundation v0.1 stack.

This report is scoped to issue #11 contract v2 and epic #9 contract v5. It does not close the
Windows host decision. Windows remains a mandatory reopen under ADR-0004 before productive Windows
foundation or release work.

## Evidence binding

The recommendation is derived from the fresh exact-head evidence below. Superseded v1 source,
binaries, timings, Windows results, and fingerprints are excluded.

| Field                  | Binding                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| Issue contract         | #11 v2                                                                       |
| Readiness fingerprint  | `ee7934be0bfcc74630bfb071ec05c724ed97a2458d4b9238d60561292cc06469`           |
| Evidence commit        | `d576a5b652027250f3de0c97163f045c71f98c8b`                                   |
| Evidence tree          | `c1a46253c57365805fb04243d5399cd2212b6696`                                   |
| Benchmark ID           | `18a4f580448f060fc9172c471c766e772eff00009ba4c9ac80c3de143e205a88`           |
| Benchmark file SHA-256 | `aadedda4bc96ff3e652cc3d86c6bef06072369c1f1ae4907a71361d5ceaba9a6`           |
| Authority              | Physical owner Apple M4, 16 GiB, macOS 26.5.1, arm64                         |
| Sample count           | 20 cold and 30 warm launches per candidate; `quick=false`; alternating order |

The benchmark retained in [`foundation-benchmark.json`](foundation-benchmark.json) contains the raw
sanitized samples, source inventories, package digests, release-package hook scans, release
composition proof, and computed distributions.

## Candidate bindings

| Candidate | Source SHA-256                                                     | Lock SHA-256                                                                                                                                     | Evaluation package SHA-256                                         | Release-like package SHA-256                                       |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Tauri 2   | `b99a5bb49e99be11123febf8f8697390b42b43947fb67d9e52a168aa9ed56adf` | Cargo `8f3d027a9c87907d4f266f2135ab19bc78f6df23eabe8f88e34efe53b43737d3`; npm `ff1b106cdee2f72dcb736839e019a257d78ac160c5b0dc36162480e099ebc739` | `35e8b3bb6dede3de8d0c9e3bd8b67d82df5b4ae3f3779db44935bebcaa5851ed` | `d7eef5852f4fc0c940a38a07b6871abf7b990e776ad9e209895d98f8f6e77ea3` |
| Slint     | `f4186fa3be5f91e66251dab30260f38affca42f73815c11c180293269111533b` | Cargo `42e765941098f99e33c13b8951bb8f3fa934248b22adfe0f0ef30110ef5aa707`                                                                         | `0d59803121ddf8f3e2a38d48cb323ba1ad5adcd9363d305184f59ca0ca9abed8` | `e3ac1d4c973624e3f5cd2138e05e3ef19bd0c52945f3cb089fa97100a000d401` |

Release-like hook scans and release-composition proofs passed for both candidates: no evaluation
hook marker, relaxed capability, symbol finding, or package allowlist violation was retained in the
release-like packages.

## Hard-gate results

| Gate                           | Threshold                     | Tauri 2                                 | Slint                                                                      |
| ------------------------------ | ----------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| Cold launch p50                | at most 1,500 ms              | 465.045 ms, pass                        | 373.329 ms, pass                                                           |
| Cold launch p95                | at most 3,000 ms              | 581.939 ms, pass                        | 532.251 ms, pass                                                           |
| Warm launch p95                | at most 1,000 ms              | 595.500 ms, pass                        | 678.495 ms, pass                                                           |
| Input-to-paint p75             | at most 33 ms                 | 32.000 ms, pass                         | 39.370 ms, fail                                                            |
| Input-to-paint p95             | at most 50 ms                 | 35.000 ms, pass                         | 55.408 ms, fail                                                            |
| Runtime-to-UI p95              | at most 100 ms                | 34.170 ms, pass                         | 33.021 ms, pass                                                            |
| Shutdown maximum               | at most 5,000 ms              | 0.067 ms, pass                          | 0.065 ms, pass                                                             |
| Orphans after cleanup          | zero                          | pass                                    | pass                                                                       |
| Automated native semantic tree | governed machine check        | pass                                    | fail: `automated_native_semantic_tree_unavailable`                         |
| Physical VoiceOver semantics   | usable labeled journey        | pass                                    | fail: nodes exist, but the complete governed journey was not usable        |
| Physical IME composition       | committed international input | pass                                    | pass                                                                       |
| Physical dark appearance       | follows system appearance     | pass                                    | fail: release-like package remained effectively light/low-contrast in Dark |
| Physical display scaling       | same release-package journey  | pass                                    | pass                                                                       |
| Licence route                  | implementable compliant route | pass with productive review obligations | fail: royalty-free attribution surface absent in prototype                 |
| Signed-update recipe           | owned integrated route        | pass as Tauri documented route input    | fail: no Slint-owned integrated signed updater recipe                      |

Tracked RSS is retained as diagnostic only. Tauri shared WebKit XPC processes cannot be consistently
attributed, so RSS cannot decide the Slint replacement gate.

## Replacement formula

Lower is better; improvement is `(Tauri - Slint) / Tauri`. Slint can replace the owner-preferred
Tauri candidate only if it passes every absolute gate, improves at least one comparable hard metric
by 20% or more, regresses no hard metric by more than 5%, and passes all additional accessibility,
IME, licence, and signed-update gates.

| Comparable metric     | Slint result                                          |
| --------------------- | ----------------------------------------------------- |
| Cold p95              | 8.5% improvement; below the 20% replacement threshold |
| Warm p95              | 13.9% regression; exceeds the 5% regression limit     |
| Input-to-paint p95    | 58.3% regression; exceeds the 5% regression limit     |
| Runtime-to-UI p95     | 3.4% improvement; below the 20% replacement threshold |
| Packaged payload size | 113.9% regression; exceeds the 5% regression limit    |

Slint therefore does not clear the replacement formula even before considering the failed semantic,
appearance, licence, and updater gates.

## Weighted decision matrix

Scores are 0 through 5. The weighted total is informative only; hard gates and the replacement
formula control the outcome.

| Criterion                                          |  Weight |       Tauri 2 |         Slint | Rationale                                                                                                                                                                    |
| -------------------------------------------------- | ------: | ------------: | ------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security and authority containment                 |      20 |             5 |             4 | Both candidates proved hostile request, timeout, cancellation, recovery, and release-hook isolation; Tauri has the clearer command/capability model for CH-3.                |
| Accessibility, IME, and desktop UX                 |      15 |             5 |             2 | Tauri passed automated semantics, VoiceOver, IME, appearance, and scaling. Slint passed IME and scaling but failed the governed semantic/VoiceOver path and Dark appearance. |
| Performance and resource efficiency                |      15 |             4 |             3 | Slint was faster on cold p95 and runtime-to-UI, but missed input thresholds and more than doubled release-like payload size. RSS is diagnostic only.                         |
| Packaging, signing, update, and rollback           |      15 |             4 |             2 | Tauri supplies an integrated updater/signing route as implementation input; Slint needs a separate owned updater decision.                                                   |
| Testing, diagnostics, and recovery                 |      15 |             5 |             3 | Tauri satisfied the machine-evaluated semantic and lifecycle harness. Slint recovered and cleaned up, but lacked the governed semantic automation route.                     |
| Future coding-runtime boundary fit                 |      10 |             5 |             4 | Both can host the typed application port; Tauri maps more directly to a bundled React UI and Tauri command boundary for the first productive slice.                          |
| Maintainability, support, licensing, and ecosystem |      10 |             4 |             2 | Tauri keeps ordinary MIT/Apache-style productive review obligations. Slint's custom licence route and required attribution surface remain decision costs.                    |
| **Weighted total**                                 | **100** | **460 / 500** | **290 / 500** | Hard-gate outcome selects Tauri regardless of total.                                                                                                                         |

## Dissent and residual uncertainty

Slint remains a credible macOS UI technology, not an invalid framework. It produced lower cold p95,
lower runtime-to-UI p95, and lower tracked root-process RSS in this evidence set. Those benefits do
not overcome the frozen replacement gate because the accessibility, appearance, licence, updater,
payload, and input-latency failures affect release acceptance and support cost.

The main Tauri residual risks are system-WebView variance, frontend supply-chain review, CSP and
capability correctness, WebView accessibility regressions, update key custody, notarization, and
rollback behavior. CH-3 must implement only the stable typed port and packaged-shell harness in
ADR-0004; it must not retain any evaluation hook or infer Windows acceptance from this macOS
decision.

## CH-3 handoff

CH-3 may use ADR-0004's accepted macOS baseline: Tauri 2.11.5, WRY 0.55.1, Tauri CLI 2.11.4,
React/React DOM 19.2.7, TypeScript 5.9.3, Vite 7.3.6, Rust 1.92.0, the typed
`application_request` port, the declared productive roots, and the repository-owned
`acceptance:macos` packaged-shell harness contract.

Evaluation source, packages, temporary manifest declarations, and temporary CI harnesses are not
productive inputs and must be absent from the #11 merge head.
