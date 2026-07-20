# Foundation host paper screen

## Contract and method

This paper screen is scoped to issue #11 contract v2 and epic #9 contract v5. The frozen live
comparison is Tauri 2 versus Slint on macOS; the six options below receive research dispositions
only. They are not authorized for prototype work, and this record does not contain a Tauri or Slint
prototype result.

All claims use the freshly revalidated primary-source IDs in
[`sources.json`](sources.json). The old v1 `sources.json` and `paper-screen.md` at `8684b68` were
used only as untrusted search leads. No v1 wording, implementation, measurement, result, timing,
binary, Windows evidence, or fingerprint was imported.

The paper screen asks the same questions of each option:

1. Can Keiko keep one typed, bounded, validated application-to-host port and a default-deny
   privileged boundary?
2. Is there a credible licence route for an Apache-2.0 core and possible paid product without a
   mandatory paid framework, test tool, runtime, or support dependency?
3. Is there a primary-source route for keyboard, focus, accessibility semantics, VoiceOver, and
   international input, with physical evidence still required?
4. Can an external harness drive the packaged shell and one bounded native surface without a test
   backdoor in production?
5. Is there a credible signed package, update, rollback, SBOM, and support path?
6. Does the route reduce rather than multiply Keiko-owned language, bridge, UI, automation,
   release, and support surfaces?

`Paper-screened out` means the option is outside the frozen two-candidate experiment because its
documented burden or evidence gap does not justify changing issue v2 or epic v5. It is not a claim
that the technology can never work. Reopening one of these options changes the accepted candidate
set and requires replanning and a new readiness record.

## Qt Quick with a Rust boundary

Disposition: **paper-screened out**. Confidence: **high**.

| Concern                        | Primary-source assessment                                                                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Boundary                       | CXX-Qt can generate a typed Rust/C++ bridge, but Keiko would own authorization and validation across Rust, generated CXX code, C++, Qt objects, and QML. Its published CI covers x86-64 macOS rather than the issue's Apple Silicon authority. [Q06]                                       |
| Licences                       | Qt offers commercial and LGPLv3/GPL routes with module-specific exceptions. A future paid Keiko tier is possible only after module-by-module linking, redistribution, notice, source-offer, and SBOM review; the route is materially more complex than a permissively licensed host. [Q02] |
| Accessibility and IME          | Qt Quick controls expose keyboard behavior and accessibility metadata; custom QML items need explicit roles, names, and actions. These are credible implementation inputs, not physical VoiceOver or IME evidence. [Q03]                                                                   |
| Automation and native surfaces | Qt Quick Test is an in-process QML unit-test framework. Apple XCUIAutomation could drive an external macOS journey, but the inspected Qt sources do not supply a complete packaged-shell and native-dialog harness for Keiko. [Q04, A01]                                                   |
| Update and signing             | Qt Installer Framework supplies installer and maintenance primitives, while Apple supplies Developer ID and notarization. Keiko would still own updater signatures, rollback, macOS integration, and release evidence. [Q05, A02]                                                          |
| Maintenance                    | Qt Quick adds QML, C++, CMake, generated CXX-Qt bindings, module-level licence governance, and a second native lifecycle beside the Rust control plane. [Q02, Q06]                                                                                                                         |
| Issue v2 / epic v5 rationale   | The accepted contract authorizes exactly Tauri and Slint prototypes and rejects six-way prototype work. Qt's additional bridge and licence surface has no established benefit that warrants replacing either frozen candidate, so it stays a sourced paper option.                         |

## GPUI or another custom GPU renderer

Disposition: **paper-screened out**. Confidence: **high**.

| Concern                        | Primary-source assessment                                                                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Boundary                       | GPUI is Rust-native, so Keiko could keep the application port in Rust, but GPUI's platform services do not constitute Keiko's default-deny capability model. A more custom renderer would make Keiko own that model in full. [P01]                                                         |
| Licences                       | The pinned GPUI crate declares Apache-2.0. A product decision would still need a locked transitive inventory and notices; the Zed repository's broader licensing must not be mistaken for the published GPUI crate grant. [P02]                                                            |
| Accessibility and IME          | GPUI links to an accessibility topic and uses platform text backends, but the current consumer documentation does not establish the required macOS VoiceOver and IME acceptance route. A generic custom renderer would own semantics, focus, text shaping, and composition behavior. [P01] |
| Automation and native surfaces | GPUI documents an in-process test macro and simulated platform input. It does not establish an external packaged-shell driver or native-dialog journey with production-hook exclusion. [P01, A01]                                                                                          |
| Update and signing             | The framework overview does not provide an integrated signed updater, rollback, or packaging contract. Apple signing and notarization remain available, but Keiko would own their integration and all update machinery. [P01, A02]                                                         |
| Maintenance                    | GPUI is explicitly pre-1.0, warns of frequent breaking changes, and directs consumers to source code for much of the API. A generic custom GPU route increases ownership further. [P01]                                                                                                    |
| Issue v2 / epic v5 rationale   | Epic v5 needs the smallest governed foundation and freezes two live candidates. No measured Tauri or Slint ceiling has justified taking ownership of a pre-1.0 or bespoke UI platform, so this route cannot displace the accepted pair.                                                    |

## Dioxus Desktop

Disposition: **paper-screened out**. Confidence: **high**.

| Concern                        | Primary-source assessment                                                                                                                                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boundary                       | Dioxus runs Rust natively beside a system WebView and exposes raw JavaScript plus bidirectional evaluation messaging. Keiko would need to design and prove the same typed, bounded, authenticated, default-deny renderer boundary required of Tauri. [D01]  |
| Licences                       | Dioxus v0.7.0 is MIT-licensed, subject to the usual locked transitive inventory and notice review. No mandatory paid framework is identified in the inspected route. [D04]                                                                                  |
| Accessibility and IME          | A system WebView offers a potential semantic and input path, but the inspected Dioxus desktop documentation does not establish macOS VoiceOver, focus, or IME behavior for the packaged shell. Physical proof would remain mandatory. [D01]                 |
| Automation and native surfaces | Official end-to-end guidance points to Playwright browser output, not a packaged desktop process or native dialog. The missing journey would need a Keiko-owned external driver and release-isolation proof. [D03]                                          |
| Update and signing             | The CLI documents desktop bundling, but the inspected primary sources do not establish a complete signed updater and rollback path. Apple signing and notarization would still need Keiko integration. [D02, A02]                                           |
| Maintenance                    | This route adds Dioxus, its CLI, WebView behavior, Rust-to-JavaScript evaluation, frontend dependencies, and a new automation design while retaining the same system-WebView class as preferred Tauri. [D01, D02]                                           |
| Issue v2 / epic v5 rationale   | Dioxus does not provide primary evidence of a packaged native-surface automation or updater advantage over Tauri. Adding a second WebView prototype would violate the frozen two-candidate scope without resolving a documented gap in the preferred route. |

## Flutter with a Rust boundary

Disposition: **paper-screened out**. Confidence: **high**.

| Concern                        | Primary-source assessment                                                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boundary                       | Flutter desktop can call C APIs through `dart:ffi`, so a narrow Rust C ABI is possible. Keiko would nevertheless own validation, authority, memory safety, cancellation, and lifecycle semantics across Dart, generated bindings, C ABI, and Rust. [F02] |
| Licences                       | Flutter 3.44.0 uses BSD 3-Clause terms. The engine, Dart SDK, plugins, native runner, and transitive dependencies still require a locked inventory and notices. [F05]                                                                                    |
| Accessibility and IME          | Flutter supplies semantics and accessibility guidance, but the cited release checklist is not macOS VoiceOver or IME evidence. The issue's physical keyboard, focus, VoiceOver, composition, appearance, and scaling journey remains unproved. [F04]     |
| Automation and native surfaces | Flutter states that `integration_test` cannot interact with native UI such as native dialogs. A separate native test framework or tool is required for the issue journey, increasing harness and production-isolation work. [F03, A01]                   |
| Update and signing             | Flutter documents macOS release builds but not one complete Keiko-ready signed updater and rollback contract in the inspected sources. Apple signing and notarization remain separate release work. [F01, A02]                                           |
| Maintenance                    | The route adds the Flutter engine, Dart SDK, plugin ecosystem, native runner projects, an FFI layer, and at least one additional native automation path beside Rust. [F01, F02, F03]                                                                     |
| Issue v2 / epic v5 rationale   | The native-dialog automation gap and additional language/runtime boundary provide no established foundation advantage over the accepted pair. Prototyping Flutter would expand the frozen candidate set and contradict the six-way-prototype non-goal.   |

## Separate native platform clients

Disposition: **paper-screened out**. Confidence: **high**.

| Concern                        | Primary-source assessment                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Boundary                       | A SwiftUI/AppKit macOS client and a later WinUI client could each call a narrow Rust port, but Keiko would own two language bindings, authority adapters, event-loop integrations, and lifecycle implementations. [N01, N04]                                                         |
| Licences                       | Keiko would own its client code rather than distribute a cross-platform UI framework. Apple and Microsoft SDK, store, signing, and runtime terms still need platform-specific release review; this is not a blanket licence clearance. [N01, N03, N04]                               |
| Accessibility and IME          | Native controls have direct platform accessibility and input routes. Windows XAML integrates with UI Automation, and macOS can be validated with VoiceOver and XCUIAutomation; both clients still require their own semantic, focus, IME, and physical acceptance suites. [N02, A01] |
| Automation and native surfaces | XCUIAutomation and Microsoft UI Automation are external platform routes that can exercise native surfaces without a production test endpoint. Keiko would maintain two harnesses and reconcile their evidence schemas. [A01, N02]                                                    |
| Update and signing             | Apple supplies Developer ID and notarization; MSIX supplies Windows package identity, signed integrity, and updates. Keiko would still unify provenance, rollback, updater policy, SBOMs, and support across two release stacks. [A02, N03]                                          |
| Maintenance                    | Separate clients duplicate UI implementation, accessibility regression work, automation, release engineering, platform expertise, and support while sharing only the Rust application contract. [N01, N04]                                                                           |
| Issue v2 / epic v5 rationale   | Epic v5 deliberately makes a scoped macOS decision now and defers Windows through a reopen. Duplicating client and release stacks before both cross-platform candidates fail would work against the smallest-foundation outcome and change the accepted candidate set.               |

## Bespoke winit plus wgpu host

Disposition: **paper-screened out**. Confidence: **high**.

| Concern                        | Primary-source assessment                                                                                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Boundary                       | A Rust-only host could keep the typed application port in one language, but winit and wgpu provide no Keiko authority model. Keiko would own every capability, navigation, native-surface, timeout, cancellation, and process-lifecycle rule. [B01, B02]                                         |
| Licences                       | winit, wgpu, and accesskit_winit publish permissive licences, subject to an exact dependency inventory. Permissive substrates do not reduce the ownership of a complete UI platform. [B01, B02, B03]                                                                                             |
| Accessibility and IME          | winit exposes opt-in IME events and candidate geometry; accesskit_winit exposes a platform adapter. Keiko must still build the widget semantics, focus model, text editor, composition state, scaling, and VoiceOver behavior. [B01, B03]                                                        |
| Automation and native surfaces | The substrates do not provide an external packaged-shell journey driver or native-dialog automation contract. Keiko would have to build the harness and prove it absent from production. [B01, B02, B03, A01]                                                                                    |
| Update and signing             | Graphics, windowing, and accessibility crates provide no updater or rollback platform. Apple signing and notarization are available, but packaging, signed updates, provenance, and recovery remain entirely Keiko-owned. [B01, B02, B03, A02]                                                   |
| Maintenance                    | This route makes Keiko the owner of rendering integration, widgets, text input, accessibility, testing, packaging, updates, and long-term platform adaptation. wgpu alone changes breaking versions regularly, and the combined surface is larger than a foundation host choice. [B01, B02, B03] |
| Issue v2 / epic v5 rationale   | The accepted plan says to measure before specialization and selects Tauri and Slint only. No measured toolkit ceiling or unavoidable product requirement justifies building a UI platform, so a bespoke host cannot enter the v2 experiment.                                                     |

## Cross-cutting inputs and unresolved evidence

The later Tauri-versus-Slint decision must use, but must not overread, these source-backed inputs:

- Tauri capabilities can constrain window or webview permissions, but application commands need an
  explicit manifest restriction and Keiko-owned validation. [T01]
- Tauri's current free macOS WebDriver route embeds a test server in the tested application. The
  release-like package must prove both WebDriver plugins and all test authority are absent. Direct
  `tauri-driver` does not support macOS; the separate cross-platform fork requires a paid macOS API
  key and is not part of the mandatory route. [T02]
- Tauri documents a signed updater and macOS signing route. This recipe does not prove that
  Keiko's rollback, key custody, package isolation, or release journey has passed. [T03, T04]
- Slint Royalty-free License 2.0 requires either an `AboutSlint` widget in an accessible About or
  splash surface, or an easily found public-web attribution badge. Legal review and an explicit
  selected route are required before licence acceptance. [S04]
- Slint's `system-testing` feature enables remote introspection and control and is not recommended
  for production. A release-like package must prove the feature and its environment-triggered
  connection path are absent. [S03]
- No Slint-owned integrated signed updater was identified in the official Slint desktop, platform,
  feature, or licence material inspected on 2026-07-17. Sparkle documents a possible separate macOS
  framework, but that adds native packaging, signing, key, and lifecycle boundaries and is not a
  valid Slint win-gate result until a complete governed recipe is demonstrated. [S05]
- Apple documents XCUIAutomation, Developer ID notarization, and stapling. Candidate documentation
  cannot replace physical VoiceOver, IME, native-surface, Gatekeeper, or cleanup proof. [A01, A02]
- GitHub's current standard-runner table identifies `macos-14` and `macos-26` as Apple Silicon M1
  arm64 labels, so the issue's labels are consistent with current documentation. Each run must
  still retain its exact image identity because runner images change. [GH01]

These are explicit uncertainties, not candidate results. If the Slint licence or updater route
remains ambiguous, or the declared environments cannot execute the equal workload, issue v2
requires the executor to stop rather than infer a pass.
