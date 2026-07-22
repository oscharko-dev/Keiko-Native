# Keiko Native design adoption ledger

## Status

Active repository-owned record. Each entry is independently implemented and verified by Keiko
Native; Existing Keiko remains provenance evidence rather than a source or runtime dependency.

## Foundation v0.1 entries

| Source and immutable provenance                                                                                                                                | Disposition | Rationale                                                                                                                                                                   | Native owner and target                                    | Required acceptance evidence                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Existing Keiko brand intent at `oscharko-dev/Keiko@9f3fb998d052f6d8873a24c1bd35de938ab4357e`                                                                   | adapt       | Preserve recognizability while creating an original native shell, tokens, layout, copy, and mark. No CSS, component, font, logo file, or private-source material is copied. | Frontend; Foundation shell and repository-owned CSS tokens | Four-state screenshots in Light and Dark appearance; readable scaling; independent reuse audit  |
| Existing Keiko semantic-state and keyboard intent at the same provenance                                                                                       | adopt       | Semantic structure, visible focus, keyboard operation, and non-color-only meaning remain valid product requirements.                                                        | Frontend; four closed Foundation states                    | Automated semantic contract plus physical keyboard and VoiceOver observations                   |
| Existing Keiko browser layout, components, selectors, responsive workarounds, PWA behavior, updater UI, and productive feature surfaces at the same provenance | retire      | They are web-specific or outside the internal Foundation milestone.                                                                                                         | No Native target                                           | Architecture and scope audit confirms no copied implementation and no fifth or productive state |
| Existing Keiko fonts, icons, logos, screenshots, and other third-party visual assets at the same provenance                                                    | revalidate  | Licensing and native accessibility would require separate evidence. Foundation v0.1 does not use them.                                                                      | Deferred; no Foundation target                             | Package inventory and visual audit confirm absence                                              |
| Native design baseline appearance, focus, reduced-motion, scaling, Unicode, and IME intent                                                                     | adapt       | Implement through system appearance, original CSS tokens, semantic HTML, and the inert IME harness in the selected Tauri/React stack.                                       | Frontend and macOS host                                    | Automated state tests and exact-package physical macOS evidence                                 |

## Reuse settlement

The Foundation slice reuses behavioral risk evidence only. Its application state, IPC schema,
persistence, host effects, React presentation, German copy, and visual treatment are newly owned by
Keiko Native. No Existing Keiko source, binary artifact, credential, updater provider, or historical
acceptance result is an implementation dependency or current acceptance evidence.
