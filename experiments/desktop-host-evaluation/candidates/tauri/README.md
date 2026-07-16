# Tauri candidate

Throwaway Tauri 2.11.5 shell for issue #9. It uses only locally bundled HTML, CSS, and JavaScript,
one programmatically created `main` webview, an exact navigation allowlist, strict CSP, no Tauri
core permissions, and matching capability and `AppManifest` command allowlists. The renderer
receives only seven named application intents; it receives no filesystem, shell, process, network,
or window-creation API.

The same executable enters a harmless fixture-child loop only when the trusted Rust host starts it
with `--fixture-child`. The shared process supervisor owns process-tree termination. Closing the
final window and application exit both invoke the same idempotent cleanup path.

## Reproduction

Use Rust 1.88 and the shared locked workspace:

```text
cargo fmt --manifest-path experiments/desktop-host-evaluation/Cargo.toml --all -- --check
cargo test --locked --manifest-path experiments/desktop-host-evaluation/Cargo.toml -p keiko-tauri-prototype
cargo clippy --locked --manifest-path experiments/desktop-host-evaluation/Cargo.toml -p keiko-tauri-prototype --all-targets -- -D warnings
cargo tauri build --config experiments/desktop-host-evaluation/candidates/tauri/tauri.conf.json --bundles app
```

For Windows packaged WebDriver evidence, drive a separate experimental package with the official
open-source `tauri-driver` plus a matching EdgeDriver. The app embeds no driver command, listener,
or debugging credential, and the default release-like build disables devtools.
Direct Tauri WebDriver is not available for WKWebView on macOS; VoiceOver, IME, native-dialog, and
visual checkpoints therefore require authoritative manual macOS evidence. No paid driver is a
build, test, or release dependency.
