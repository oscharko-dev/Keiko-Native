# Foundation physical interaction observations

## Status

Current sanitized Tauri physical observations are bound to issue #11 contract v2, evidence commit
`6a9fa49d86a82a698af5c1ac6e5da1690676dfaa`, and the retained Tauri release-like package:

- Tauri release-like package SHA-256
  `d7eef5852f4fc0c940a38a07b6871abf7b990e776ad9e209895d98f8f6e77ea3`.

The Slint observations below are retained only as sanitized supplemental context from an earlier
release-like package at commit `d576a5b652027250f3de0c97163f045c71f98c8b`, package SHA-256
`e3ac1d4c973624e3f5cd2138e05e3ef19bd0c52945f3cb089fa97100a000d401`. They do not prove the
current retained Slint release-like package SHA-256
`c0cee4e292c89ab2c442a893541df3fe1c7b9f173113822b44887d98f9b7134e`, and the decision report does
not credit them as a current Slint physical hard-gate pass.

The run used an Apple M4 with 16 GiB running macOS 26.5.1 on 2026-07-17. It used synthetic input
only. No raw path, hostname, username, stable machine identifier, customer content, credential,
endpoint, speech audio, or screenshot was retained.

## Current Tauri release-package observations

The release-like Tauri package exposed a visible shell with labeled structure, a settable synthetic
international-input field, stable keyboard focus, and accessible semantic content. VoiceOver
navigation reached the labeled field and surrounding shell content in the governed journey.

For the IME journey, Japanese-Kana was temporarily installed and selected while the input field had
focus. Actual physical key events committed `かんな` into the field. The temporary input source was
removed after the bounded journey.

Tauri followed system appearance changes between Dark and Light. At the alternate 1352 x 878
display preset and the restored Default 1512 x 982 preset, the shell retained readable content,
contained layout, focusable controls, and no scaling-induced clipping.

## Prior Slint release-package observations

The prior release-like Slint package exposed a titled window, text nodes, a settable synthetic
international-input field, and focusable controls. The semantic tree did not provide the complete
governed VoiceOver journey required by the issue contract: nodes existed, but the final journey was
not equivalent to the labeled Tauri path and could not substitute for the missing machine semantic
gate.

For the IME journey, Japanese-Kana was temporarily installed and selected while the field had
keyboard focus. Actual physical key events committed `ちかんな` into the field after the existing
synthetic prefix, producing the observable value `readyちかんな`. This is recorded as an IME pass,
not as a text-clearing pass.

Slint did not materially follow system Dark appearance in the prior release-like package. It
remained effectively light and low-contrast under Dark, then stayed light when the system changed
to Light. At 1352 x 878 and the restored Default 1512 x 982 preset, layout remained contained
without scaling-induced clipping.

## Restoration and cleanup

After the bounded journeys, the machine was restored to:

- Dark appearance;
- Default display preset at 1512 x 982 selected resolution on the built-in display;
- EurKEY v1.2 input source;
- Japanese-Kana input source removed;
- VoiceOver off and not running; and
- no candidate or evaluation helper processes remaining.

The benchmark's machine evidence separately records zero owned descendants after each candidate
sample. The Tauri physical observations above are complementary current manual evidence for
VoiceOver, IME, appearance, scaling, and restoration. The prior Slint observations remain useful
diagnostic context, but they are not current package evidence.

## Classification

Tauri passes the physical VoiceOver, IME, appearance, scaling, and cleanup gates. Slint receives no
current digest-bound physical hard-gate pass from this file; its prior observations were consistent
with the retained benchmark and source-backed concerns but are supplemental only. Slint's current
replacement failure is controlled by the benchmark, source-backed candidate gates, and replacement
formula in the decision report and ADR-0004.
