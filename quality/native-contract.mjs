import { compareCodeUnits } from "./deterministic-order.mjs";
import * as closed from "./native-package-policy.mjs";
import { FUNCTIONAL_ACKNOWLEDGEMENT_WATCHDOG_MS } from "./native-lifecycle.mjs";

const PRIVATE_ENDPOINT_PATTERNS = [
  /\b(?:https?|wss?):\/\/[^/\s]+@/iu,
  /\b(?:https?|wss?):\/\/localhost(?=[:/\s]|$)/iu,
  /\b(?:https?|wss?):\/\/[A-Z0-9.-]+\.(?:local|internal)(?=[:/\s]|$)/iu,
  /\b(?:https?|wss?):\/\/0\.0\.0\.0(?=[:/\s]|$)/iu,
  /\b(?:https?|wss?):\/\/127(?:\.\d{1,3}){3}(?=[:/\s]|$)/iu,
  /\b(?:https?|wss?):\/\/10(?:\.\d{1,3}){3}(?=[:/\s]|$)/iu,
  /\b(?:https?|wss?):\/\/169\.254(?:\.\d{1,3}){2}(?=[:/\s]|$)/iu,
  /\b(?:https?|wss?):\/\/192\.168(?:\.\d{1,3}){2}(?=[:/\s]|$)/iu,
  /\b(?:https?|wss?):\/\/172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}(?=[:/\s]|$)/iu,
  /\b(?:https?|wss?):\/\/\[::1\](?=[:/\s]|$)/iu,
  /\b(?:https?|wss?):\/\/\[f[cd][A-F0-9:]*\](?=[:/\s]|$)/iu,
  /\b(?:https?|wss?):\/\/\[fe[89ab][A-F0-9:]*(?:%(?:25)?[A-Z0-9._~-]+)?\](?=[:/\s]|$)/iu,
];

const DENIED_REDACTION_CLASSES = [
  {
    code: "private-key",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/u,
  },
  {
    code: "credential-assignment",
    pattern:
      /(?:token|password|secret|credential|api[_-]?key|authorization)\s*[=:]\s*(?:["'][^"']+["']|[A-Za-z0-9_./\\ -]{4,})/iu,
  },
  {
    code: "email-address",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  },
  {
    code: "reserved-endpoint",
    pattern:
      /\b[A-Z][A-Z0-9+.-]*:\/\/[A-Z0-9.-]+\.(?:invalid|test|example)(?=[:/\s]|$)/iu,
  },
  {
    code: "private-endpoint",
    patterns: PRIVATE_ENDPOINT_PATTERNS,
  },
  {
    code: "macos-home-path",
    pattern: /\/Users\/[^/\s]+/u,
  },
  {
    code: "windows-home-path",
    pattern: /[A-Z]:\\Users\\[^\\\s]+/iu,
  },
  {
    code: "linux-home-path",
    pattern: /\/home\/[^/\s]+/u,
  },
];

function firstMatchingPattern(redactionClass, value) {
  return (redactionClass.patterns ?? [redactionClass.pattern]).find((pattern) =>
    pattern.test(value),
  );
}

export function redactionClasses(value) {
  return DENIED_REDACTION_CLASSES.filter(
    (redactionClass) =>
      firstMatchingPattern(redactionClass, value) !== undefined,
  ).map(({ code }) => code);
}

export function redactionMatches(value) {
  return DENIED_REDACTION_CLASSES.flatMap((redactionClass) => {
    const pattern = firstMatchingPattern(redactionClass, value);
    return pattern === undefined ? [] : [String(pattern)];
  });
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
  const dependencies = Object.keys(cargo.workspace?.dependencies ?? {}).sort(
    compareCodeUnits,
  );
  const expectedDependencies = [
    "keiko-application",
    "keiko-host-macos",
    "keiko-ui-port",
    "objc2-app-kit",
    "objc2-foundation",
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
      "objc2-app-kit",
      "objc2-foundation",
      "serde",
      "serde_json",
      "tauri",
      "wry",
    ],
    "keiko-native-desktop": ["keiko-host-macos", "tauri"],
    "keiko-ui-port": ["keiko-application", "serde", "serde_json"],
  };
  for (const crate of crates) {
    const actual = Object.keys(crate.manifest.dependencies ?? {}).sort(
      compareCodeUnits,
    );
    const expected = allowedCrateDependencies[crate.name];
    if (
      expected === undefined ||
      JSON.stringify(actual) !== JSON.stringify(expected.sort(compareCodeUnits))
    ) {
      failures.push(`crate-dependencies:${crate.name}`);
    }
  }
  if (
    JSON.stringify(
      Object.keys(frontend.dependencies ?? {}).sort(compareCodeUnits),
    ) !== JSON.stringify(["@tauri-apps/api", "react", "react-dom"])
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
    JSON.stringify(Object.keys(policy).sort(compareCodeUnits)) !==
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
    JSON.stringify(
      Object.keys(policy.expectedLocks ?? {}).sort(compareCodeUnits),
    ) !== JSON.stringify(["cargoSha256", "npmSha256"]) ||
    !/^[0-9a-f]{64}$/u.test(policy.expectedLocks?.cargoSha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(policy.expectedLocks?.npmSha256 ?? "")
  ) {
    failures.push("package-policy-locks");
  }
  if (
    JSON.stringify(
      Object.keys(policy.security ?? {}).sort(compareCodeUnits),
    ) !==
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
  const actualPaths = files.map(({ path }) => path).sort(compareCodeUnits);
  if (
    JSON.stringify(actualPaths) !==
    JSON.stringify([...allowedPaths].sort(compareCodeUnits))
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
  ].sort(compareCodeUnits);
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
    for (const redactionClass of redactionClasses(bytes.toString("latin1"))) {
      failures.push(`package-redaction:${redactionClass}:${path}`);
    }
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
  ].toSorted(compareCodeUnits);
  const failures = [];
  if (
    JSON.stringify(Object.keys(evidence).sort(compareCodeUnits)) !==
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
    evidence.acknowledgementMs > FUNCTIONAL_ACKNOWLEDGEMENT_WATCHDOG_MS
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
