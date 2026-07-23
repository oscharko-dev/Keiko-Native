import { isDeepStrictEqual } from "node:util";

import { compareCodeUnits } from "./deterministic-order.mjs";

export const BROKER_CAPABILITY_SCHEMA =
  "keiko-native-epic-merge-broker-capability/v1";

export const BROKER_APP_PERMISSIONS = Object.freeze({
  administration: "read",
  checks: "read",
  contents: "write",
  issues: "read",
  metadata: "read",
  pull_requests: "read",
  statuses: "read",
});

export const BROKER_PROTOCOL_SEMANTICS = Object.freeze({
  completePagination: true,
  cursorOrdering: true,
  dualRefConditional: true,
  exactOutcome: true,
  fencing: true,
  liveProbe: true,
  stableReads: true,
});

const capabilityKeys = Object.freeze([
  "app",
  "capturedAt",
  "credential",
  "protocol",
  "repository",
  "schema",
]);
const appKeys = Object.freeze([
  "account",
  "appId",
  "appSlug",
  "installationId",
  "permissions",
  "repositories",
  "repositorySelection",
  "suspended",
]);
const credentialKeys = Object.freeze([
  "callerReadable",
  "custody",
  "expiresAt",
  "kind",
  "ordinaryWorkflowReadable",
]);
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

function exactKeys(value, expected) {
  return (
    record(value) &&
    isDeepStrictEqual(
      Object.keys(value).toSorted(compareCodeUnits),
      [...expected].toSorted(compareCodeUnits),
    )
  );
}

function exactStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.every(text) &&
    new Set(actual).size === actual.length &&
    isDeepStrictEqual(
      actual.toSorted(compareCodeUnits),
      expected.toSorted(compareCodeUnits),
    )
  );
}

function timestamp(value) {
  if (!text(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function brokerAppPermissionsMatch(value) {
  return (
    exactKeys(value, Object.keys(BROKER_APP_PERMISSIONS)) &&
    isDeepStrictEqual(value, BROKER_APP_PERMISSIONS)
  );
}

export function brokerProtocolSemanticsProven(value) {
  return (
    exactKeys(value, Object.keys(BROKER_PROTOCOL_SEMANTICS)) &&
    Object.keys(BROKER_PROTOCOL_SEMANTICS).every(
      (key) => value[key] === BROKER_PROTOCOL_SEMANTICS[key],
    )
  );
}

function capabilityShapeValid(value) {
  return (
    exactKeys(value, capabilityKeys) &&
    exactKeys(value.app, appKeys) &&
    exactKeys(value.credential, credentialKeys)
  );
}

function add(failures, condition, code) {
  if (condition && !failures.includes(code)) failures.push(code);
}

function identityFailures(value) {
  const failures = [];
  const app = value.app;
  add(
    failures,
    !text(app.account) ||
      !text(app.appSlug) ||
      !positiveInteger(app.appId) ||
      !positiveInteger(app.installationId),
    "broker_identity_invalid",
  );
  add(
    failures,
    app.repositorySelection !== "selected",
    "broker_repository_selection_invalid",
  );
  add(
    failures,
    !exactStrings(app.repositories, [value.repository]),
    "broker_repository_scope_invalid",
  );
  add(failures, app.suspended !== false, "broker_installation_suspended");
  add(
    failures,
    !brokerAppPermissionsMatch(app.permissions),
    "broker_permissions_mismatch",
  );
  return failures;
}

function credentialFailures(value, now) {
  const failures = [];
  const credential = value.credential;
  add(
    failures,
    credential.kind !== "short-lived-installation-token" ||
      credential.custody !== "server-side-broker-only" ||
      credential.callerReadable !== false ||
      credential.ordinaryWorkflowReadable !== false,
    "broker_credential_custody_invalid",
  );
  const capturedAt = timestamp(value.capturedAt);
  const expiresAt = timestamp(credential.expiresAt);
  add(failures, capturedAt === undefined, "broker_capture_time_invalid");
  add(failures, expiresAt === undefined, "broker_token_expiry_invalid");
  add(
    failures,
    capturedAt !== undefined &&
      expiresAt !== undefined &&
      (expiresAt <= capturedAt ||
        expiresAt <= now ||
        expiresAt - capturedAt > 60 * 60 * 1000),
    "broker_token_expired",
  );
  return failures;
}

export function brokerCapabilityFailures(value, now = Date.now()) {
  try {
    if (!capabilityShapeValid(value))
      return ["broker_capability_shape_invalid"];
    const failures = [];
    add(
      failures,
      value.schema !== BROKER_CAPABILITY_SCHEMA,
      "broker_capability_schema_invalid",
    );
    add(failures, !text(value.repository), "broker_repository_invalid");
    failures.push(
      ...identityFailures(value),
      ...credentialFailures(value, now),
    );
    add(
      failures,
      !brokerProtocolSemanticsProven(value.protocol),
      "broker_protocol_unproven",
    );
    return failures;
  } catch {
    return ["broker_capability_invalid"];
  }
}
