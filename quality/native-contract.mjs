import * as closed from "./native-package-policy.mjs";

export function redactionMatches(value) {
  const denied = [
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/u,
    /(?:token|password|secret|credential|api[_-]?key|authorization)\s*[=:]\s*(?:["'][^"']+["']|[A-Za-z0-9_./\\ -]{4,})/iu,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
    /\b[A-Z][A-Z0-9+.-]*:\/\/[A-Z0-9.-]+\.(?:invalid|test|example)(?=[:/\s]|$)/iu,
    /\b(?:https?|wss?):\/\/(?:[^/\s]+@|localhost(?=[:/\s]|$)|(?:[A-Z0-9.-]+\.(?:local|internal))(?=[:/\s]|$)|(?:0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?=[:/\s]|$)|\[(?:::1|f[cd][A-F0-9:]*|fe[89ab][A-F0-9:]*)\](?=[:/\s]|$))/iu,
    /\/Users\/[^/\s]+/u,
    /[A-Z]:\\Users\\[^\\\s]+/u,
    /\/home\/[^/\s]+/u,
  ];
  return denied.filter((pattern) => pattern.test(value)).map(String);
}

export function coverageFailures(report) {
  const totals = report.data?.[0]?.totals;
  return ["branches", "functions", "lines", "regions"]
    .filter((metric) => (totals?.[metric]?.percent ?? 0) < 85)
    .map((metric) => `Native ${metric} coverage is below 85 percent`);
}

export function workspaceDependencyNames(text) {
  const section =
    text.split("[workspace.dependencies]")[1]?.split(/^\[/mu)[0] ?? "";
  return [...section.matchAll(/^([A-Za-z0-9_-]+)\s*=/gmu)].map(
    (match) => match[1],
  );
}

export function sourceSecurityFailures(entries) {
  const encoded = entries.map(({ text }) => text).join("\n");
  const failures = [];
  if (redactionMatches(encoded).length > 0)
    failures.push("source-sensitive-content");
  if (/tauri-plugin-(?:shell|fs|http|process|updater)/u.test(encoded))
    failures.push("source-generic-capability");
  return failures;
}

export function sourceDeclarationFailures(paths, project) {
  const roots = [...project.productiveSourceRoots, ...project.testSourceRoots];
  const support = new Set(project.supportFiles);
  return paths
    .filter(
      (path) =>
        !support.has(path) && !roots.some((root) => path.startsWith(root)),
    )
    .map((path) => `undeclared-native-file:${path}`);
}

export function manifestFailures({ cargo, crates, desktopConfig, frontend }) {
  const failures = [];
  if (cargo.workspace?.members?.length !== 4)
    failures.push("cargo-workspace-members");
  const dependencies = Object.keys(cargo.workspace?.dependencies ?? {}).sort();
  const expectedDependencies = [
    "keiko-application",
    "keiko-host-macos",
    "keiko-ui-port",
    "serde",
    "serde_json",
    "tauri",
    "tauri-build",
    "wry",
  ];
  if (JSON.stringify(dependencies) !== JSON.stringify(expectedDependencies)) {
    failures.push("cargo-workspace-dependencies");
  }
  const allowedCrateDependencies = {
    "keiko-application": ["serde"],
    "keiko-host-macos": [
      "keiko-application",
      "keiko-ui-port",
      "serde_json",
      "tauri",
      "wry",
    ],
    "keiko-native-desktop": ["keiko-host-macos", "tauri"],
    "keiko-ui-port": ["keiko-application", "serde", "serde_json"],
  };
  for (const crate of crates) {
    const actual = Object.keys(crate.manifest.dependencies ?? {}).sort();
    const expected = allowedCrateDependencies[crate.name];
    if (
      expected === undefined ||
      JSON.stringify(actual) !== JSON.stringify(expected.sort())
    ) {
      failures.push(`crate-dependencies:${crate.name}`);
    }
  }
  if (
    JSON.stringify(Object.keys(frontend.dependencies ?? {}).sort()) !==
    JSON.stringify(["@tauri-apps/api", "react", "react-dom"])
  ) {
    failures.push("frontend-production-dependencies");
  }
  for (const required of ["@vitest/coverage-v8", "vitest"]) {
    if (frontend.devDependencies?.[required] !== "4.1.8")
      failures.push(`frontend-test-dependency:${required}`);
  }
  const csp = desktopConfig.app?.security?.csp;
  if (
    csp !==
    "default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' asset: http://asset.localhost; script-src 'self'; style-src 'self'"
  ) {
    failures.push("desktop-csp");
  }
  if (
    desktopConfig.build?.beforeBuildCommand !==
    "npm --prefix ../frontend run build"
  ) {
    failures.push("frontend-build-path");
  }
  if (
    desktopConfig.bundle?.resources?.["../../third-party-notices.json"] !==
    "THIRD-PARTY-NOTICES.json"
  ) {
    failures.push("third-party-notice-resource");
  }
  return failures;
}

export function productionMarkerFailures(entries, markers) {
  return entries.flatMap(({ bytes, path }) =>
    markers
      .filter((marker) => bytes.includes(Buffer.from(marker)))
      .map((marker) => `${path}:${marker}`),
  );
}

export function packagePolicyFailures({
  cargo,
  fileClasses,
  files,
  npm,
  policy,
}) {
  const failures = [];
  const allowedPaths = Array.isArray(policy.allowedBundlePaths)
    ? policy.allowedBundlePaths
    : [];
  const requiredNotices = Array.isArray(policy.requiredNoticePaths)
    ? policy.requiredNoticePaths
    : [];
  const policyCargo = Array.isArray(policy.cargoInventory)
    ? policy.cargoInventory
    : [];
  const policyNpm = Array.isArray(policy.npmInventory)
    ? policy.npmInventory
    : [];
  const acceptedSpdx = Array.isArray(policy.acceptedSpdxExpressions)
    ? policy.acceptedSpdxExpressions
    : [];
  const prohibitedMarkers = Array.isArray(policy.security?.prohibitedMarkers)
    ? policy.security.prohibitedMarkers
    : [];
  const prohibitedPathFragments = Array.isArray(
    policy.security?.prohibitedPathFragments,
  )
    ? policy.security.prohibitedPathFragments
    : [];
  const expectedPolicyKeys = [
    "acceptedSpdxExpressions",
    "allowedBundlePaths",
    "allowedFileClasses",
    "allowedFileModes",
    "bundleIdentifier",
    "cargoInventory",
    "expectedLocks",
    "npmInventory",
    "requiredNoticePaths",
    "schema",
    "security",
    "target",
  ];
  if (
    JSON.stringify(Object.keys(policy).sort()) !==
    JSON.stringify(expectedPolicyKeys)
  ) {
    failures.push("package-policy-fields");
  }
  if (policy.schema !== "keiko-native-package-policy/v1")
    failures.push("package-policy-schema");
  if (policy.target !== "keiko-native-desktop")
    failures.push("package-policy-target");
  if (policy.bundleIdentifier !== "dev.oscharko.keiko-native")
    failures.push("package-policy-bundle-identifier");
  if (
    JSON.stringify(Object.keys(policy.expectedLocks ?? {}).sort()) !==
      JSON.stringify(["cargoSha256", "npmSha256"]) ||
    !/^[0-9a-f]{64}$/u.test(policy.expectedLocks?.cargoSha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(policy.expectedLocks?.npmSha256 ?? "")
  ) {
    failures.push("package-policy-locks");
  }
  if (
    JSON.stringify(Object.keys(policy.security ?? {}).sort()) !==
      JSON.stringify([
        "allowedBundledOrigins",
        "csp",
        "prohibitedMarkers",
        "prohibitedPathFragments",
      ]) ||
    JSON.stringify(policy.security?.allowedBundledOrigins) !==
      JSON.stringify(["tauri://localhost", "http://tauri.localhost"]) ||
    policy.security?.csp !==
      "default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' asset: http://asset.localhost; script-src 'self'; style-src 'self'" ||
    JSON.stringify(prohibitedMarkers) !==
      JSON.stringify(closed.CLOSED_PROHIBITED_MARKERS) ||
    JSON.stringify(prohibitedPathFragments) !==
      JSON.stringify(closed.CLOSED_PROHIBITED_PATH_FRAGMENTS)
  ) {
    failures.push("package-policy-security");
  }
  if (
    JSON.stringify(allowedPaths) !==
      JSON.stringify(closed.CLOSED_PACKAGE_PATHS) ||
    JSON.stringify(requiredNotices) !==
      JSON.stringify([closed.CLOSED_PACKAGE_PATHS[2]]) ||
    JSON.stringify(policy.allowedFileClasses) !==
      JSON.stringify(closed.CLOSED_FILE_CLASSES) ||
    JSON.stringify(policy.allowedFileModes) !==
      JSON.stringify(closed.CLOSED_FILE_MODES)
  ) {
    failures.push("package-policy-path-classes");
  }
  if (
    fileClasses !== undefined &&
    JSON.stringify(fileClasses) !== JSON.stringify(closed.CLOSED_FILE_CLASSES)
  ) {
    failures.push("package-observed-file-classes");
  }
  const fileModes = Object.fromEntries(
    files.map(({ mode, path }) => [path, mode]),
  );
  if (JSON.stringify(fileModes) !== JSON.stringify(closed.CLOSED_FILE_MODES))
    failures.push("package-observed-file-modes");
  const actualPaths = files.map(({ path }) => path).sort();
  if (
    JSON.stringify(actualPaths) !== JSON.stringify([...allowedPaths].sort())
  ) {
    failures.push("package-path-inventory");
  }
  for (const notice of requiredNotices) {
    if (!actualPaths.includes(notice))
      failures.push(`missing-notice:${notice}`);
  }
  if (JSON.stringify(cargo) !== JSON.stringify(policyCargo)) {
    failures.push("cargo-dependency-inventory");
  }
  if (JSON.stringify(npm) !== JSON.stringify(policyNpm)) {
    failures.push("npm-dependency-inventory");
  }
  const licenses = [
    ...new Set([...cargo, ...npm].map(({ license }) => license)),
  ].sort();
  if (JSON.stringify(licenses) !== JSON.stringify(acceptedSpdx)) {
    failures.push("spdx-inventory");
  }
  if (
    JSON.stringify(acceptedSpdx) !==
    JSON.stringify(closed.CLOSED_SPDX_EXPRESSIONS)
  ) {
    failures.push("spdx-reviewed-expressions");
  }
  const markerFailures = productionMarkerFailures(files, prohibitedMarkers);
  failures.push(
    ...markerFailures.map((failure) => `production-marker:${failure}`),
  );
  for (const { bytes, path } of files) {
    if (redactionMatches(bytes.toString("latin1")).length > 0)
      failures.push(`package-redaction:${path}`);
  }
  for (const path of actualPaths) {
    if (prohibitedPathFragments.some((fragment) => path.includes(fragment))) {
      failures.push(`prohibited-package-path:${path}`);
    }
  }
  return failures;
}

export function evidenceFailures(evidence, expected) {
  const expectedKeys = [
    "architecture",
    "boundedReasonCodes",
    "cargoLockSha256",
    "cleanupOwnedDescendants",
    "acknowledgementMs",
    "npmLockSha256",
    "outcomes",
    "packageManifestSha256",
    "readinessFingerprint",
    "redaction",
    "runner",
    "schema",
    "shutdownMs",
    "sourceRevision",
  ].toSorted();
  const failures = [];
  if (
    JSON.stringify(Object.keys(evidence).sort()) !==
    JSON.stringify(expectedKeys)
  ) {
    failures.push("evidence-fields");
  }
  if (evidence.schema !== "keiko-native-packaged-shell-evidence/v1")
    failures.push("evidence-schema");
  if (!/^[0-9a-f]{40}$/u.test(evidence.sourceRevision ?? ""))
    failures.push("evidence-revision");
  if (evidence.sourceRevision !== expected?.sourceRevision)
    failures.push("evidence-revision-binding");
  if (!/^[0-9a-f]{64}$/u.test(evidence.packageManifestSha256 ?? ""))
    failures.push("evidence-package-digest");
  if (evidence.packageManifestSha256 !== expected?.packageManifestSha256)
    failures.push("evidence-package-digest-binding");
  if (!/^[0-9a-f]{64}$/u.test(evidence.cargoLockSha256 ?? ""))
    failures.push("evidence-cargo-lock-digest");
  if (evidence.cargoLockSha256 !== expected?.cargoLockSha256)
    failures.push("evidence-cargo-lock-binding");
  if (!/^[0-9a-f]{64}$/u.test(evidence.npmLockSha256 ?? ""))
    failures.push("evidence-npm-lock-digest");
  if (evidence.npmLockSha256 !== expected?.npmLockSha256)
    failures.push("evidence-npm-lock-binding");
  if (
    evidence.readinessFingerprint !==
    "da2459bd3becc6cbf651a24ef1b64d1b11a8ed642bfddc92923f0d6ed6dc8e5e"
  )
    failures.push("evidence-readiness-fingerprint");
  if (evidence.readinessFingerprint !== expected?.readinessFingerprint)
    failures.push("evidence-readiness-binding");
  if (
    JSON.stringify(evidence.outcomes) !==
    JSON.stringify([
      "packaged-health-acknowledged",
      "normal-shutdown",
      "zero-owned-descendants",
      "package-policy",
    ])
  )
    failures.push("evidence-outcomes");
  if (
    JSON.stringify(evidence.boundedReasonCodes) !==
    JSON.stringify([
      "invalid-request",
      "unauthorized",
      "cancelled",
      "timed-out",
      "host-unavailable",
      "shutting-down",
    ])
  )
    failures.push("evidence-reason-codes");
  if (
    !/^(?:local-macos|macos(?:14|26)-[A-Za-z0-9._-]+)$/u.test(
      evidence.runner ?? "",
    )
  )
    failures.push("evidence-runner");
  if (evidence.architecture !== "arm64") failures.push("evidence-architecture");
  if (
    !Number.isSafeInteger(evidence.acknowledgementMs) ||
    evidence.acknowledgementMs < 0 ||
    evidence.acknowledgementMs > 5000
  )
    failures.push("evidence-acknowledgement-duration");
  if (
    !Number.isSafeInteger(evidence.shutdownMs) ||
    evidence.shutdownMs < 0 ||
    evidence.shutdownMs > 5000
  )
    failures.push("evidence-shutdown-duration");
  if (
    !Number.isSafeInteger(evidence.cleanupOwnedDescendants) ||
    evidence.cleanupOwnedDescendants !== 0
  )
    failures.push("evidence-descendants");
  if (evidence.redaction !== "closed") failures.push("evidence-redaction");
  return failures;
}
