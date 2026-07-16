# Desktop host and renderer paper screen

## Contract and method

This paper screen applies the nine frozen hard gates from issue 9 contract `v1` to all eight named
options. The readiness fingerprint is
`4ef64b75cd9b2f4786f1317f360542b81a65cde058777709b4f2eeb233fc065e`.
Sources were accessed on 2026-07-16 and are registered by citation ID in
[`sources.json`](sources.json).

Every option receives the same gates in the same order:

1. first-class Windows 11 x64 and Apple Silicon macOS operation;
2. no mandatory paid framework, runtime, test tool, or support dependency;
3. licensing compatible with the Apache-2.0 core and a possible future paid tier;
4. a typed, bounded, validated, default-deny privileged boundary;
5. deterministic automation of the packaged evaluation journey;
6. a release-like artifact free of test backdoors;
7. accessibility and international-input evidence on both platforms;
8. deterministic process-tree cleanup; and
9. a credible signing, update, rollback, SBOM, and support path.

Status meanings:

- **Plausible** — primary evidence shows a credible route. This is a paper-screen result, not a
  demonstrated hard-gate pass; prototype and platform evidence remains required.
- **Not demonstrated** — no attributable primary evidence established a credible complete route.
  The option is eliminated at the paper screen unless new evidence reopens the decision.
- **Fail** — primary evidence directly contradicts the gate. The option is eliminated regardless
  of weighted scoring.

`Contract-screened` is a separate disposition for an option whose hard-gate routes remain plausible
but whose frozen rejection condition is already met. It must not be misreported as a hard-gate or
licence failure. Confidence describes the paper-screen conclusion, not production fitness.

## Tauri 2

Disposition: **survivor**. Confidence: **high**. Official capability, platform distribution,
WebDriver, updater, and dual-licence routes justify equal prototype evaluation. Physical
accessibility, IME, release isolation, and package evidence remain obligations.

|   # | Hard gate                                | Status    | Attributable assessment                                                                                                                               | Citations     |
| --: | ---------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
|   1 | Windows and macOS                        | Plausible | Tauri documents desktop targets and platform distributions for Windows and macOS.                                                                     | T03           |
|   2 | No mandatory paid dependency             | Plausible | The core and documented local build, WebDriver, and distribution routes do not require the optional hosted distribution service.                      | T02, T03, T05 |
|   3 | Compatible licensing                     | Plausible | Tauri 2.11.5 is offered under MIT or Apache-2.0 terms; a full transitive inventory remains required.                                                  | T05           |
|   4 | Typed default-deny boundary              | Plausible | Capabilities constrain permissions by window or webview; application commands still require explicit Keiko validation and manifest restriction.       | T01           |
|   5 | Packaged deterministic automation        | Plausible | Tauri documents WebDriver testing across desktop platforms, including an embedded macOS driver route; production isolation must still be proved.      | T02           |
|   6 | Release artifact without backdoors       | Plausible | Test drivers can remain outside the application package, while package inspection must prove evaluation hooks are absent.                             | T02, T03      |
|   7 | Accessibility and international input    | Plausible | First-class system-WebView desktop targets provide a route, but VoiceOver, NVDA, UI Automation, keyboard, and IME behavior require physical evidence. | T03           |
|   8 | Process-tree cleanup                     | Plausible | A Rust host can own bounded child supervision and window shutdown; the framework route does not remove the need for platform cleanup tests.           | T01, T03      |
|   9 | Signing, update, rollback, SBOM, support | Plausible | Tauri documents platform packaging/signing and cryptographically signed updater artifacts; rollback and SBOM remain Keiko-owned controls.             | T03, T04      |

## Slint

Disposition: **survivor**. Confidence: **medium-high**. Official desktop, accessibility, testing,
and royalty-free licence material provides a credible route. Attribution is mandatory, and Keiko
would own more packaging, updater, automation, and support integration than with Tauri.

|   # | Hard gate                                | Status    | Attributable assessment                                                                                                                                                   | Citations |
| --: | ---------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
|   1 | Windows and macOS                        | Plausible | Slint documents desktop operation on Windows and macOS, including supported backend and renderer choices.                                                                 | S01       |
|   2 | No mandatory paid dependency             | Plausible | Royalty-free desktop distribution and open local tooling are available; optional paid products are not required by the proposed route.                                    | S01, S04  |
|   3 | Compatible licensing                     | Plausible | Royalty-free licence 2.0 permits desktop distribution and commercial use subject to its conditions, including attribution; legal review remains required.                 | S04       |
|   4 | Typed default-deny boundary              | Plausible | Compiled Slint callbacks and a Rust application port can form a typed boundary, but Keiko must enforce authority because the UI is in-process.                            | S01, S02  |
|   5 | Packaged deterministic automation        | Plausible | Slint exposes a system-testing feature, explicitly not for production; a Keiko-owned packaged test route must prove equivalent behavior and isolation.                    | S03       |
|   6 | Release artifact without backdoors       | Plausible | The documented system-testing feature is unsuitable for production and can be excluded; actual release-package inspection remains required.                               | S03       |
|   7 | Accessibility and international input    | Plausible | Slint exposes accessibility properties and desktop backends; NVDA, VoiceOver, keyboard, and IME behavior still require physical evidence.                                 | S01, S02  |
|   8 | Process-tree cleanup                     | Plausible | The Rust event loop and Keiko-owned host can supervise children, but the framework documentation does not substitute for platform cleanup tests.                          | S01       |
|   9 | Signing, update, rollback, SBOM, support | Plausible | Native desktop output and royalty-free distribution permit a Keiko-owned release chain, but no integrated complete route is claimed and the ownership burden is material. | S01, S04  |

## Qt Quick with a Rust boundary

Disposition: **contract-screened**. Confidence: **high**. The field has credible hard-gate routes,
but Qt, QML, C++, Rust, and CXX-Qt add toolchain and boundary complexity without a material verified
benefit over the two survivors. This applies the frozen rejection condition; it is not a licensing
failure.

|   # | Hard gate                                | Status    | Attributable assessment                                                                                                                           | Citations     |
| --: | ---------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
|   1 | Windows and macOS                        | Plausible | Qt 6 documents supported Windows and macOS targets; CXX-Qt adds another generated integration layer that would need both-platform proof.          | Q01, Q05      |
|   2 | No mandatory paid dependency             | Plausible | Qt documents open-source use and the open Qt Installer Framework; obligations must be met without relying on commercial-only services.            | Q03, Q04      |
|   3 | Compatible licensing                     | Plausible | Qt documents LGPLv3, GPLv2, and GPLv3 module licensing; a compliant dynamic-linking and notice strategy is credible but materially more complex.  | Q03           |
|   4 | Typed default-deny boundary              | Plausible | CXX-Qt generates Rust/C++ interoperability, allowing a narrow interface, but Keiko would own policy and validation across that extra boundary.    | Q05           |
|   5 | Packaged deterministic automation        | Plausible | Qt's platform accessibility integration permits OS automation, while Keiko would still own the packaged cross-platform journey driver.            | Q02, N03, N05 |
|   6 | Release artifact without backdoors       | Plausible | External OS automation can avoid embedded test capability; package inspection is still necessary.                                                 | N03, N05      |
|   7 | Accessibility and international input    | Plausible | Qt Quick documents accessible properties and platform accessibility bridge behavior; physical NVDA, VoiceOver, and IME proof remains required.    | Q02           |
|   8 | Process-tree cleanup                     | Plausible | A Rust control plane behind the generated bridge can retain process ownership, but the added C++/QML lifecycle is another failure boundary.       | Q05           |
|   9 | Signing, update, rollback, SBOM, support | Plausible | Qt Installer Framework documents installer and maintenance operations; signing, rollback policy, SBOM, and licence compliance remain Keiko-owned. | Q04           |

## GPUI or another custom Rust GPU renderer

Disposition: **eliminated as not demonstrated and independently contract-screened**. Confidence:
**high**. Current official material documents Windows, macOS, and Linux/FreeBSD platform routes,
correcting an earlier Windows-support assumption, but does not establish the complete automation,
release-isolation, accessibility/IME, or release-operations gates. Independently, no measured need
has triggered the frozen exception for maintaining a custom UI platform.

|   # | Hard gate                                | Status           | Attributable assessment                                                                                                       | Citations |
| --: | ---------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------- |
|   1 | Windows and macOS                        | Plausible        | GPUI's current official README documents Windows, macOS, and Linux/FreeBSD platform routes.                                   | G01       |
|   2 | No mandatory paid dependency             | Plausible        | The documented local Rust and platform-toolchain setup identifies no mandatory paid framework, test tool, or support service. | G01       |
|   3 | Compatible licensing                     | Not demonstrated | The inspected GPUI overview does not establish a complete distributable dependency-licence inventory for Keiko's use.         | G01       |
|   4 | Typed default-deny boundary              | Not demonstrated | GPUI is a Rust UI framework, but the inspected README does not document a bounded, default-deny privilege system.             | G01       |
|   5 | Packaged deterministic automation        | Not demonstrated | The inspected official material does not establish a packaged cross-platform automation route.                                | G01       |
|   6 | Release artifact without backdoors       | Not demonstrated | No attributable release-isolation route was found in the inspected material.                                                  | G01       |
|   7 | Accessibility and international input    | Not demonstrated | The inspected material does not establish Windows/macOS accessibility and IME evidence.                                       | G01       |
|   8 | Process-tree cleanup                     | Not demonstrated | The inspected README does not establish bounded child-process supervision or deterministic descendant cleanup.                | G01       |
|   9 | Signing, update, rollback, SBOM, support | Not demonstrated | The pre-1.0, frequently breaking consumer surface does not establish a complete desktop release and support path.             | G01       |

## Dioxus Desktop

Disposition: **eliminated as not demonstrated**. Confidence: **high**. Desktop and bundling routes
exist, but official testing guidance covers browser Playwright rather than the packaged native
journey, and the inspected material does not establish a complete signed update and rollback path.

|   # | Hard gate                                | Status               | Attributable assessment                                                                                                                         | Citations          |
| --: | ---------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
|   1 | Windows and macOS                        | Plausible            | Dioxus 0.7 documents system-WebView desktop applications and desktop bundle targets.                                                            | D01, D02           |
|   2 | No mandatory paid dependency             | Plausible            | The documented local desktop, bundle, and browser-test tools have an open-source route.                                                         | D01, D02, D03, D04 |
|   3 | Compatible licensing                     | Plausible            | Dioxus 0.7 is distributed under MIT terms; a complete transitive inventory would still be required.                                             | D04                |
|   4 | Typed default-deny boundary              | Not demonstrated     | The inspected desktop material does not provide Tauri-equivalent capability enforcement for renderer-to-host privilege.                         | D01                |
|   5 | Packaged deterministic automation        | **Not demonstrated** | Official testing guidance uses Playwright for browser output and does not establish packaged desktop/native-dialog automation.                  | D03                |
|   6 | Release artifact without backdoors       | Plausible            | An external driver could avoid embedded hooks, but this depends on the missing packaged automation route.                                       | D02, D03           |
|   7 | Accessibility and international input    | Not demonstrated     | System WebViews are documented, but no attributable complete Windows/macOS accessibility and IME route was found.                               | D01                |
|   8 | Process-tree cleanup                     | Plausible            | A Rust host could own process supervision, but evidence would be Keiko-owned.                                                                   | D01                |
|   9 | Signing, update, rollback, SBOM, support | **Not demonstrated** | Bundling is documented, but the inspected official material does not establish the complete signing, updater, rollback, SBOM, and support path. | D02                |

## Flutter with a Rust boundary

Disposition: **eliminated as not demonstrated**. Confidence: **high**. Flutter supports desktop,
integration tests, and native-code FFI, but its official integration-test guidance cannot operate
native platform UI. That leaves the required packaged native-folder-dialog journey without a
demonstrated driver.

|   # | Hard gate                                | Status               | Attributable assessment                                                                                                                         | Citations |
| --: | ---------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
|   1 | Windows and macOS                        | Plausible            | Flutter documents native Windows and macOS desktop builds.                                                                                      | F01       |
|   2 | No mandatory paid dependency             | Plausible            | The Flutter SDK and documented integration-test route are open source and locally runnable.                                                     | F02, F05  |
|   3 | Compatible licensing                     | Plausible            | Flutter 3.44 is published under the BSD 3-Clause licence; a transitive inventory remains required.                                              | F05       |
|   4 | Typed default-deny boundary              | Plausible            | Flutter documents FFI to native code, permitting a narrow Rust bridge, but Keiko must own authority and generated-boundary validation.          | F03       |
|   5 | Packaged deterministic automation        | **Not demonstrated** | The official integration-test guidance states that native platform UI cannot be operated, so the native-dialog journey lacks a complete driver. | F02, F04  |
|   6 | Release artifact without backdoors       | Plausible            | External integration tests can avoid a production endpoint, subject to package inspection.                                                      | F02       |
|   7 | Accessibility and international input    | Plausible            | Flutter supplies desktop and accessibility facilities, but physical NVDA, VoiceOver, and IME evidence would still be required.                  | F01       |
|   8 | Process-tree cleanup                     | Plausible            | A Rust host boundary could own process supervision, but the extra Dart/native lifecycle requires verification.                                  | F03       |
|   9 | Signing, update, rollback, SBOM, support | Not demonstrated     | Desktop release builds are documented, but the inspected sources do not establish one complete cross-platform update, rollback, and SBOM route. | F01       |

## Separate native platform clients

Disposition: **contract-screened**. Confidence: **high**. SwiftUI/AppKit and WinUI have credible
native platform, accessibility, automation, and packaging routes, but maintaining two UI,
automation, and release stacks is rejected for the foundation while cross-platform survivors have
not failed a hard gate.

|   # | Hard gate                                | Status    | Attributable assessment                                                                                                                                      | Citations          |
| --: | ---------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
|   1 | Windows and macOS                        | Plausible | WinUI is Microsoft's Windows UI framework and SwiftUI is Apple's application UI framework.                                                                   | N01, N04           |
|   2 | No mandatory paid dependency             | Plausible | The platform SDK and local UI-automation routes do not require a paid UI framework or support contract.                                                      | N01, N03, N04, N05 |
|   3 | Compatible licensing                     | Plausible | Keiko would own the clients and use platform SDKs rather than distributing a conflicting cross-platform framework; release terms still need review.          | N01, N04           |
|   4 | Typed default-deny boundary              | Plausible | Each client can call a narrow Keiko-owned Rust port, although two bridges and policy integrations must be maintained.                                        | N01, N04           |
|   5 | Packaged deterministic automation        | Plausible | Windows UI Automation and XCTest UI tests provide official platform automation routes.                                                                       | N03, N05           |
|   6 | Release artifact without backdoors       | Plausible | External platform automation permits production packages without embedded test endpoints.                                                                    | N03, N05           |
|   7 | Accessibility and international input    | Plausible | Native UI frameworks integrate with their operating-system semantics and input stack; the issue journey still requires physical proof.                       | N01, N03, N04      |
|   8 | Process-tree cleanup                     | Plausible | A shared Rust core can retain supervision ownership, but two native lifecycle adapters must be proved.                                                       | N01, N04           |
|   9 | Signing, update, rollback, SBOM, support | Plausible | MSIX provides a Windows package lifecycle and the native toolchains provide platform release routes; Keiko must unify provenance, rollback, and SBOM policy. | N02, N04           |

## Bespoke winit and wgpu host

Disposition: **contract-screened**. Confidence: **high**.

The substrates are credible, but they leave Keiko responsible for a complete UI platform. The
frozen option says to reject this route until measured evidence proves an unavoidable toolkit
ceiling; no such ceiling has been established.

|   # | Hard gate                                | Status           | Attributable assessment                                                                                                                      | Citations     |
| --: | ---------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
|   1 | Windows and macOS                        | Plausible        | wgpu supports DirectX 12 and Metal; winit and AccessKit integrate with desktop windows on these platforms.                                   | B01, B02, B03 |
|   2 | No mandatory paid dependency             | Plausible        | The named Rust substrates are available through their official open-source projects and documentation.                                       | B01, B02, B03 |
|   3 | Compatible licensing                     | Plausible        | The official projects expose permissive Rust ecosystem licensing, subject to a complete dependency inventory.                                | B01, B02, B03 |
|   4 | Typed default-deny boundary              | Plausible        | Keiko could build the host boundary entirely in Rust, but it would own every authorization and capability control.                           | B01, B02      |
|   5 | Packaged deterministic automation        | Not demonstrated | The inspected substrate documentation does not provide a complete packaged desktop journey driver.                                           | B01, B02, B03 |
|   6 | Release artifact without backdoors       | Plausible        | An external Keiko-owned driver could avoid embedded hooks, but that route has not been built or proved.                                      | B02, B03      |
|   7 | Accessibility and international input    | Plausible        | winit exposes IME control and AccessKit provides a Windows/macOS accessibility bridge, while Keiko would own complete widgets and semantics. | B02, B03      |
|   8 | Process-tree cleanup                     | Plausible        | Rust host ownership permits direct supervision, but implementation evidence remains necessary.                                               | B01, B02      |
|   9 | Signing, update, rollback, SBOM, support | Not demonstrated | Graphics, windowing, and accessibility substrates do not establish a complete release, updater, rollback, SBOM, and support platform.        | B01, B02, B03 |

## Paper-screen outcome and uncertainty

Tauri 2 and Slint are the only paper-screen survivors and therefore the only options authorized for
equal throwaway prototypes. Qt Quick and separate native clients remain technically plausible but
are screened out by their frozen complexity conditions. The bespoke route is screened out because
no measured toolkit ceiling exists. Current GPUI material corrects an earlier Windows-support
assumption, but GPUI still lacks several demonstrated hard-gate routes and has no measured reason to
accept custom-platform ownership. Dioxus and Flutter lack a demonstrated complete packaged
automation route, with additional missing evidence recorded above.

This outcome does not select a host or renderer, does not score the weighted matrix, and does not
claim either survivor has passed the hard gates. Candidate documentation, licensing interpretation,
transitive dependencies, platform WebView behavior, short prototype coverage, and long-term support
remain sources of uncertainty. Any new primary evidence that changes a hard-gate status or triggers
a reopen condition must be recorded explicitly rather than silently changing this frozen screen.
