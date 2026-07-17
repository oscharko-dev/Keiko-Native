# Foundation candidate licence and source inventory

## Status and exact-head binding

Fresh exact-head licence evidence is pending. The component versions below define the candidate
compositions and the official-source routes that must be checked; they are not a current selection
or legal clearance. Exact source, lock, package, inventory-artifact, and authorized-commit digests
will be recorded only after the fresh inventories are regenerated and validated together.

## Tauri candidate

| Component          | Candidate version | Source authority         | Licence route and obligation                                                                                 |
| ------------------ | ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Rust toolchain     | 1.92.0            | Candidate build contract | Toolchain input; redistributed runtime and standard-library notices require productive release review.       |
| Tauri              | 2.11.5            | T05                      | MIT OR Apache-2.0. A productive adoption must select a route and retain required notices.                    |
| tauri-build        | 2.6.3             | Candidate Cargo manifest | Locked build dependency; its transitive licence and notice inventory remains a productive supply-chain gate. |
| WRY                | 0.55.1            | Candidate Cargo manifest | System-WebView integration dependency; exact transitive terms remain governed by the Cargo inventory.        |
| Tauri CLI          | 2.11.4            | Candidate command pin    | Build tool only; a productive adoption must lock and inventory the adopted CLI route.                        |
| React / React DOM  | 19.2.7            | Candidate npm manifest   | MIT; retain required notices in a shipped frontend inventory.                                                |
| TypeScript         | 5.9.3             | Candidate npm manifest   | Apache-2.0; build-time input.                                                                                |
| Vite               | 7.3.6             | Candidate npm manifest   | MIT; build-time input and plugin chain require locked review.                                                |
| axe-core           | 4.12.1            | Candidate npm manifest   | MPL-2.0; evaluation/test dependency only unless separately approved for production.                          |
| serde / serde_json | 1.0.228 / 1.0.145 | Candidate Cargo manifest | MIT OR Apache-2.0; preserve the adopted notices and exact transitive inventory.                              |

### Sanitized exhaustive inventory summary

The most recent diagnostic inventory covered the complete candidate Cargo and npm lock graphs. It
found no third-party dependency with a missing, ambiguous, or unofficial package-level licence
declaration. One private workspace npm package had no declaration; it is first-party and must not be
misclassified as third-party clearance. Thirty-nine Cargo packages and 51 optional npm platform
binaries lacked a locally shipped licence file even though package metadata declared terms. These
are retained as review obligations, not legal conclusions.

The diagnostic inventory's old source binding is superseded. Its counts and classifications are
preserved so the fresh exact-head inventory can detect drift; the old inventory cannot authorize a
selection, distribution, or merge. The final evidence must include the complete sanitized inventory
artifact, its digest, and the exact source and lock bindings.

Selection would not be blanket legal clearance. A productive issue must generate a complete locked
transitive licence, notice, source-offer where applicable, SBOM, vulnerability, and redistribution
inventory for the productive composition. Framework, toolchain, WebView runtime, package, updater,
signing, and store terms remain distinct reviews.

## Slint candidate

| Component           | Candidate version            | Source authority         | Licence route and obligation                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slint / slint-build | 1.17.1                       | S01–S04                  | The desktop route requires a selected valid Slint licence. Under Royalty-free License 2.0, distribution requires either the `AboutSlint` widget in an About or splash surface or an easily found public-web attribution badge. Legal review remains required. |
| winit backend       | i-slint-backend-winit 1.17.1 | Candidate Cargo manifest | Transitive source and licence obligations follow the selected Slint route and complete Cargo inventory.                                                                                                                                                       |
| femtovg renderer    | Slint 1.17.1 feature route   | Candidate Cargo features | No independent clearance is inferred; it remains part of the locked transitive review.                                                                                                                                                                        |
| system-testing      | Slint 1.17.1 feature route   | S03                      | Test-only remote-control surface; it must be absent from a release package. A governed native semantic-tree route remains an evidence requirement.                                                                                                            |
| Sparkle 2           | Not adopted                  | S05                      | A possible separate macOS updater, not a Slint-owned integrated recipe. Adoption would add framework, packaging, signing, key-management, lifecycle, licence, and notice review.                                                                              |

### Sanitized exhaustive inventory summary

The most recent diagnostic inventory covered 587 packages and reported no missing package-level
licence expression or package checksum. It recorded 30 slash-form expressions, 13 custom Slint
licence references, and 71 packages without a locally shipped licence file. The compiler package
also shipped a CC-BY-ND file that was not represented in its package-level expression. These are
review routes and exceptions requiring human legal interpretation; they are not conclusions about
compatibility or distribution permission.

The diagnostic inventory's old source binding is superseded. Its full sanitized summary is retained
as a drift baseline only. The final evidence must regenerate the exhaustive inventory, bind it to
the exact source and lock graph, and record the sanitized artifact digest before any candidate
outcome is asserted.

## Paper-screen source inventory

The six unbuilt options have source and licence dispositions only. Qt (Q01–Q06), GPUI (P01–P02),
Dioxus (D01–D04), Flutter (F01–F05), separate native clients (N01–N04), and
winit/wgpu/accesskit (B01–B03) are indexed in [`sources.json`](sources.json). Their published
licences do not substitute for a module-level locked transitive inventory, redistribution review,
or physical acceptance evidence. No package, binary, or measured result was produced for these
options.
