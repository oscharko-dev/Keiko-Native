const PRODUCT_CAPABILITY_PATTERN =
  /\b(?:std::fs|std::process|std::net|reqwest|keyring|security_framework|tauri_plugin_(?:fs|shell|http|process|updater))\b/iu;
const FRONTEND_CAPABILITY_PATTERN =
  /(?:\bnode:fs\b|\bnode:child_process\b|\bfetch\s*\(|\bWebSocket\b|\bEventSource\b|\bwindow\.open\b|\blocation\s*=)/iu;

export function architectureFailures(entries, project) {
  const failures = [];
  for (const root of project.productiveSourceRoots) {
    if (!entries.some((entry) => entry.path.startsWith(root)))
      failures.push(`missing-root:${root}`);
  }
  for (const { path, text } of entries) {
    if (
      (path.startsWith("native/crates/keiko-application/src/") ||
        path.startsWith("native/crates/keiko-ui-port/src/")) &&
      /\b(?:tauri|wry|webkit|appkit|react)\b/iu.test(text)
    )
      failures.push(`forbidden-adapter-dependency:${path}`);
    if (
      (path.startsWith("native/crates/keiko-application/src/") ||
        path.startsWith("native/crates/keiko-ui-port/src/")) &&
      PRODUCT_CAPABILITY_PATTERN.test(text)
    )
      failures.push(`forbidden-domain-capability:${path}`);
    if (
      path.startsWith("native/frontend/src/") &&
      FRONTEND_CAPABILITY_PATTERN.test(text)
    )
      failures.push(`forbidden-frontend-capability:${path}`);
    if (
      path === "native/apps/keiko-desktop/src/main.rs" &&
      (text.split(/\r?\n/u).length > 40 ||
        /\b(?:if|match|let|loop|while|for)\b|canonical_origin|document_nonce|evaluate_script/iu.test(
          text,
        ))
    )
      failures.push(`non-declarative-main:${path}`);
  }
  const frontend = entries
    .filter(
      ({ path }) =>
        path.startsWith("native/frontend/src/") && !path.endsWith(".test.ts"),
    )
    .map(({ text }) => text)
    .join("\n");
  for (const command of frontend.matchAll(/["'](application_[a-z_-]+)["']/gu)) {
    if (!new Set(["application_request", "application_cancel"]).has(command[1]))
      failures.push(`forbidden-renderer-command:${command[1]}`);
  }
  return failures;
}
