# Foundation candidate licence and source inventory

## Status and exact-head binding

This inventory summarizes exact-head evidence for issue #11 contract v2 at commit
`6a9fa49d86a82a698af5c1ac6e5da1690676dfaa`. It is decision evidence, not final legal clearance for
a productive release. CH-3 and later release work must regenerate complete locked transitive
licence, notice, SBOM, vulnerability, redistribution, updater, signing, notarization, and store-term
evidence for the productive composition.

## Tauri candidate

| Component          | Candidate version | Source authority         | Licence route and obligation                                                                             |
| ------------------ | ----------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Rust toolchain     | 1.92.0            | Candidate build contract | Toolchain input; redistributed runtime and standard-library notices require productive release review.   |
| Tauri              | 2.11.5            | T05                      | MIT OR Apache-2.0. A productive adoption must select a route and retain required notices.                |
| tauri-build        | 2.6.3             | Candidate Cargo manifest | Locked build dependency; transitive licence and notice inventory remains a productive supply-chain gate. |
| WRY                | 0.55.1            | Candidate Cargo manifest | System-WebView integration dependency; exact transitive terms remain governed by the Cargo inventory.    |
| Tauri CLI          | 2.11.4            | Candidate command pin    | Build tool only; productive adoption must lock and inventory the adopted CLI route.                      |
| React / React DOM  | 19.2.7            | Candidate npm manifest   | MIT; retain required notices in a shipped frontend inventory.                                            |
| TypeScript         | 5.9.3             | Candidate npm manifest   | Apache-2.0; build-time input.                                                                            |
| Vite               | 7.3.6             | Candidate npm manifest   | MIT; build-time input and plugin chain require locked review.                                            |
| axe-core           | 4.12.1            | Candidate npm manifest   | MPL-2.0; evaluation/test dependency only unless separately approved for production.                      |
| serde / serde_json | 1.0.228 / 1.0.145 | Candidate Cargo manifest | MIT OR Apache-2.0; preserve adopted notices and exact transitive inventory.                              |

### Exact inventory summary

The Tauri inventory is bound to two deliberately separate digest scopes:

- benchmark candidate source SHA-256
  `6d2bca52902244e5b6784036cfb3fcc82defb7b1d6264dd3f55cf4c7e7e993f1`;
- licence-inventory source-input SHA-256
  `dda377833a50c75da1881cfbf17f3505fecf46e8858e4a0c676c187b83f36125`;
- Cargo lock SHA-256 `8f3d027a9c87907d4f266f2135ab19bc78f6df23eabe8f88e34efe53b43737d3`;
- npm lock SHA-256 `ff1b106cdee2f72dcb736839e019a257d78ac160c5b0dc36162480e099ebc739`;
- full inventory SHA-256 `569df08d5ebc01e9104195206024b8ab323960cf2062522c8ed729160db4c564`; and
- summary artifact SHA-256 `eb5d8a43872718d118c7a95f88d957d40fc12e06725c45e8a71e689683aebbb7`.

The inventory covers 404 Cargo packages, 403 Cargo third-party packages, 120 npm lock nodes, and
119 npm third-party packages. It reports no ambiguous declared third-party licence, custom
third-party expression, non-crates.io source, or non-official npm source. It records 39 Cargo
packages and 51 npm tarball packages without a licence file in the local package root/tarball root,
plus one first-party evaluation workspace package without a declared licence. These are productive
review obligations and do not block the macOS decision.

## Slint candidate

| Component           | Candidate version            | Source authority         | Licence route and obligation                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slint / slint-build | 1.17.1                       | S01-S04                  | The desktop route requires a selected valid Slint licence. Under Royalty-free License 2.0, distribution requires either the `AboutSlint` widget in an About or splash surface or an easily found public-web attribution badge. Legal review remains required. |
| winit backend       | i-slint-backend-winit 1.17.1 | Candidate Cargo manifest | Transitive source and licence obligations follow the selected Slint route and complete Cargo inventory.                                                                                                                                                       |
| femtovg renderer    | Slint 1.17.1 feature route   | Candidate Cargo features | No independent clearance is inferred; it remains part of the locked transitive review.                                                                                                                                                                        |
| system-testing      | Slint 1.17.1 feature route   | S03                      | Test-only remote-control surface; it must be absent from a release package. A governed native semantic-tree route remains an evidence requirement.                                                                                                            |
| Sparkle 2           | Not adopted                  | S05                      | A possible separate macOS updater, not a Slint-owned integrated recipe. Adoption would add framework, packaging, signing, key-management, lifecycle, licence, and notice review.                                                                              |

### Exact inventory summary

The Slint inventory is bound to:

- Cargo lock SHA-256 `42e765941098f99e33c13b8951bb8f3fa934248b22adfe0f0ef30110ef5aa707`;
- source-inventory SHA-256 `7673dd658eabb6bc87eb0845face1aad6d37783162066a9655ab32ac2f98db1c`;
- full inventory SHA-256 `043d562226a7d17e0767b2cccc0b9be512a72345276eda91cf90bfe6862f1f26`;
- 587 total packages;
- 586 registry packages; and
- one workspace package.

The inventory records 30 slash-form legacy expressions, 13 custom Slint licence references, and
registry packages without local licence files. The custom Slint route is a decision cost because
the prototype did not include the required Royalty-free attribution surface. The Slint inventory
does not establish an owned integrated signed-update route.

## Paper-screen source inventory

The six unbuilt options have source and licence dispositions only. Qt (Q01-Q06), GPUI (P01-P02),
Dioxus (D01-D04), Flutter (F01-F05), separate native clients (N01-N04), and
winit/wgpu/accesskit (B01-B03) are indexed in [`sources.json`](sources.json). Their published
licences do not substitute for a module-level locked transitive inventory, redistribution review,
or physical acceptance evidence. No package, binary, or measured result was produced for these
options.
