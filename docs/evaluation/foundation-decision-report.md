# Foundation host decision report

## Status

Fresh exact-head evaluation pending. This report does not currently select a foundation host.

The earlier benchmark, package bindings, physical transcript, gate results, weighted scores, and
recommendation were produced from superseded candidate packages. They are historical diagnostics
only and have been removed from the current evidence set. They must not authorize ADR acceptance,
CH-3 implementation, or a merge.

This report remains scoped to issue #11 contract v2 and epic #9 contract v5. Windows is explicitly
unresolved and will follow the reopen contract in ADR-0004 after the macOS decision is accepted.

## Evidence required before recommendation

The final report must be derived only from evidence bound to one authorized signed commit:

- fresh source and lock inventories for both candidates;
- fresh evaluation and release-like package digests for both candidates;
- the authoritative physical Apple M4, 16 GiB, macOS 26.5.1 benchmark with 20 cold and 30 warm
  launches per candidate using the alternating schedule and `quick=false`;
- exact-workflow clean-runner evidence from both required macOS runner classes;
- equal-package VoiceOver, focus, IME, appearance, and scaling observations;
- closed release-composition, process-cleanup, redaction, and provenance results; and
- sanitized exhaustive licence inventory summaries for the exact locked dependency graphs.

The benchmark artifact, its digest, the commit binding, the package bindings, and the runner
artifact bindings are intentionally pending. They will be recorded only after validation.

## Frozen hard-gate method

The fresh evidence must evaluate the following thresholds without changing them after measurement:

| Gate                           | Threshold                     |
| ------------------------------ | ----------------------------- |
| Cold launch p50                | at most 1,500 ms              |
| Cold launch p95                | at most 3,000 ms              |
| Warm launch p95                | at most 1,000 ms              |
| Input-to-paint p75             | at most 33 ms                 |
| Input-to-paint p95             | at most 50 ms                 |
| Runtime-to-UI p95              | at most 100 ms                |
| Shutdown maximum               | at most 5,000 ms              |
| Orphans after cleanup          | zero                          |
| Automated native semantic tree | governed machine check        |
| Physical VoiceOver semantics   | usable labeled journey        |
| Physical IME composition       | committed international input |
| Physical dark appearance       | follows system appearance     |
| Physical display scaling       | same release-package journey  |
| Licence route                  | implementable compliant route |
| Signed-update recipe           | owned integrated route        |

Tracked RSS remains diagnostic because shared system processes may not be attributable
consistently. It cannot decide the replacement gate unless the final evidence establishes a common,
closed attribution method.

## Frozen replacement formula

Lower is better; improvement is `(Tauri - Slint) / Tauri`. Slint can replace the owner-preferred
Tauri candidate only if it passes every absolute gate, improves at least one hard metric by 20% or
more, regresses no hard metric by more than 5%, and passes all additional accessibility, IME,
licence, and signed-update gates.

No current percentage, winner, or weighted score is asserted. The final report must show every
input and calculation from the fresh retained benchmark.

## Frozen weighted decision matrix

Scores are 0 through 5. The weighted total is informative only; hard gates and the replacement
formula control the outcome.

| Criterion                                          |  Weight |
| -------------------------------------------------- | ------: |
| Security and authority containment                 |      20 |
| Accessibility, IME, and desktop UX                 |      15 |
| Performance and resource efficiency                |      15 |
| Packaging, signing, update, and rollback           |      15 |
| Testing, diagnostics, and recovery                 |      15 |
| Future coding-runtime boundary fit                 |      10 |
| Maintainability, support, licensing, and ecosystem |      10 |
| **Total**                                          | **100** |

Candidate scores, rationales, dissent, and residual risks are pending fresh evidence. Source-backed
capability claims remain indexed in `sources.json`; the paper-only disposition of the six unbuilt
alternatives remains in `paper-screen.md` and is not a measured result.

## CH-3 handoff

There is no executable CH-3 foundation handoff while ADR-0004 is Proposed. If the fresh evidence
accepts the Tauri proposal, the handoff must use the exact baseline, productive roots, trust
boundary, and packaged-shell harness contract recorded in the accepted ADR. Evaluation hooks and
relaxed capabilities must remain compile-time isolated and absent from release packages. Windows
work cannot inherit a future macOS result; it follows the explicit ADR reopen.
