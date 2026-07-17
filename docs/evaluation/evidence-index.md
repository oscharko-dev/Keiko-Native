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
| Evidence commit       | `6a9fa49d86a82a698af5c1ac6e5da1690676dfaa`                                   |
| Evidence tree         | `79786a7bdf11ce57070e29ed64630db963f5d43d`                                   |
| Benchmark ID          | `f28abb0708d8d4ea2f775fd993b58f1703528cfc5a470f4d4a0d95acbec5f0a8`           |
| Benchmark file        | [`foundation-benchmark.json`](foundation-benchmark.json)                     |
| Benchmark SHA-256     | `d64e0d75cdcad6010fbd2be55cdc8f7939d25cde17342218117fe9b0b1425c40`           |
| Benchmark authority   | Physical owner Apple M4, 16 GiB, macOS 26.5.1, arm64                         |
| Benchmark count       | 20 cold and 30 warm launches per candidate; `quick=false`; alternating order |
| Harness digest        | `2a59d4b95886c8bcb30517f277c30dda31446e96d60ec285661b1c6d52b4ca6f`           |

## Diagnostic runner evidence

GitHub Actions run `29609865566` (`Foundation evaluation diagnostic`) built, packaged, and ran the
short diagnostic workload on `macos-14` and `macos-26` arm64 runners at exact head
`96d1e6a7c894bebbce2d4374da858d83478a6d97`. Runner timing remains diagnostic only and does not
replace the physical owner benchmark above. The downloaded artifacts were locally validated against
their `.sha256` files, the exact head, `github-actions-diagnostic` provenance, runner labels,
`quick=true`, four samples each, and the repository redaction denylist.

| Runner   | Actions artifact                 | Benchmark ID                                                       | Diagnostic JSON SHA-256                                            |
| -------- | -------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| macos-14 | `foundation-diagnostic-macos-14` | `9c5029d7c5fad4c45403c70b0c1ff46618a9020a34310455893a373ebfdf3048` | `7bf6a9ca0ba8f2fa94263118c62c317f6b9410a2fc0b0cba5228c323b688a870` |
| macos-26 | `foundation-diagnostic-macos-26` | `fb11b718fdee2cb05e4feb070e951bf3cf41c8a8b29968a6f1db34345edcd066` | `75e60e60666cf614628b901110a1a4707b22f2855d7263fcd3e66d25fd3756b9` |

## Candidate package bindings

| Candidate | Source SHA-256                                                     | Lock SHA-256                                                                                                                                     | Evaluation package SHA-256                                         | Release-like package SHA-256                                       | Release-like bytes |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | -----------------: |
| Tauri 2   | `6d2bca52902244e5b6784036cfb3fcc82defb7b1d6264dd3f55cf4c7e7e993f1` | Cargo `8f3d027a9c87907d4f266f2135ab19bc78f6df23eabe8f88e34efe53b43737d3`; npm `ff1b106cdee2f72dcb736839e019a257d78ac160c5b0dc36162480e099ebc739` | `9ec6a1ceec305b3fdd31592e12b6d94a15efc73dfd43305b9a83c915e6359b65` | `d7eef5852f4fc0c940a38a07b6871abf7b990e776ad9e209895d98f8f6e77ea3` |          3,987,305 |
| Slint     | `ad580c84d68f942b53a7817dfa0825b501d0ba0748a8dfbe4d9ebe4f44eb2d56` | Cargo `42e765941098f99e33c13b8951bb8f3fa934248b22adfe0f0ef30110ef5aa707`                                                                         | `07d276bbecee4d9cfaa541550892999e8358610f06722174ae8ba3a2f6dc1a0a` | `c0cee4e292c89ab2c442a893541df3fe1c7b9f173113822b44887d98f9b7134e` |          8,528,257 |

Both release-like package scans report zero test-hook marker findings and passed closed
release-composition proof.

## Retained repository evidence

| Artifact                                                         | Current purpose                                                                                                           | Binding                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`sources.json`](sources.json)                                   | Revalidated official-source index and explicit evidence gaps                                                              | Schema 1; file SHA-256 `f37456a5e61cb6c9024819552badc680a78ca6aecb785fe46d2f1c13ea828a50`                                                                   |
| [`paper-screen.md`](paper-screen.md)                             | Source-backed disposition of the six non-prototyped options                                                               | Issue #11 contract v2 / epic #9 contract v5                                                                                                                 |
| [`foundation-benchmark.json`](foundation-benchmark.json)         | Sanitized raw samples, package/source/lock bindings, hard-gate results, release-hook scans, and release-composition proof | SHA-256 `d64e0d75cdcad6010fbd2be55cdc8f7939d25cde17342218117fe9b0b1425c40`; benchmark ID `f28abb0708d8d4ea2f775fd993b58f1703528cfc5a470f4d4a0d95acbec5f0a8` |
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
