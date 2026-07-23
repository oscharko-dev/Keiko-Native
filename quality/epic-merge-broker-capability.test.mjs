import assert from "node:assert/strict";
import test from "node:test";

import {
  BROKER_APP_PERMISSIONS,
  BROKER_CAPABILITY_SCHEMA,
  BROKER_PROTOCOL_SEMANTICS,
  brokerAppPermissionsMatch,
  brokerCapabilityFailures,
  brokerProtocolSemanticsProven,
} from "./epic-merge-broker-capability.mjs";

const repository = "oscharko-dev/Keiko-Native";
const now = Date.parse("2026-07-23T12:30:00.000Z");

function capability() {
  return {
    app: {
      account: "oscharko-dev",
      appId: 4242,
      appSlug: "keiko-epic-merge-broker",
      installationId: 4343,
      permissions: { ...BROKER_APP_PERMISSIONS },
      repositories: [repository],
      repositorySelection: "selected",
      suspended: false,
    },
    capturedAt: "2026-07-23T12:00:00.000Z",
    credential: {
      custody: "server-side-broker-only",
      expiresAt: "2026-07-23T12:50:00.000Z",
      kind: "short-lived-installation-token",
      ordinaryWorkflowReadable: false,
      callerReadable: false,
    },
    protocol: { ...BROKER_PROTOCOL_SEMANTICS },
    repository,
    schema: BROKER_CAPABILITY_SCHEMA,
  };
}

test("defines the exact provider-canonical ADR-0008 App permission set", () => {
  assert.deepEqual(BROKER_APP_PERMISSIONS, {
    administration: "read",
    checks: "read",
    contents: "write",
    issues: "read",
    metadata: "read",
    pull_requests: "read",
    statuses: "read",
  });
  assert.equal(brokerAppPermissionsMatch(BROKER_APP_PERMISSIONS), true);
  assert.equal(
    brokerAppPermissionsMatch({
      ...BROKER_APP_PERMISSIONS,
      pull_requests: "write",
    }),
    false,
  );
  assert.equal(
    brokerAppPermissionsMatch({
      ...BROKER_APP_PERMISSIONS,
      actions: "read",
    }),
    false,
  );
});

test("accepts only a repository-scoped, broker-custodied short-lived capability", () => {
  assert.deepEqual(brokerCapabilityFailures(capability(), now), []);
});

test("rejects caller-readable credentials, extra repositories, expiry, and identity drift", () => {
  const cases = [
    [
      "broker_credential_custody_invalid",
      (value) => (value.credential.callerReadable = true),
    ],
    [
      "broker_credential_custody_invalid",
      (value) => (value.credential.ordinaryWorkflowReadable = true),
    ],
    [
      "broker_repository_scope_invalid",
      (value) => value.app.repositories.push("owner/other"),
    ],
    [
      "broker_repository_selection_invalid",
      (value) => (value.app.repositorySelection = "all"),
    ],
    ["broker_installation_suspended", (value) => (value.app.suspended = true)],
    [
      "broker_token_expired",
      (value) => (value.credential.expiresAt = "2026-07-23T12:20:00.000Z"),
    ],
    [
      "broker_permissions_mismatch",
      (value) => (value.app.permissions.contents = "read"),
    ],
  ];
  for (const [expected, mutate] of cases) {
    const value = capability();
    mutate(value);
    assert.ok(
      brokerCapabilityFailures(value, now).includes(expected),
      expected,
    );
  }
});

test("shares the broker protocol semantics instead of accepting a second policy path", () => {
  assert.equal(brokerProtocolSemanticsProven(BROKER_PROTOCOL_SEMANTICS), true);
  for (const key of Object.keys(BROKER_PROTOCOL_SEMANTICS)) {
    const value = { ...BROKER_PROTOCOL_SEMANTICS, [key]: false };
    assert.equal(brokerProtocolSemanticsProven(value), false, key);
    assert.ok(
      brokerCapabilityFailures(
        { ...capability(), protocol: value },
        now,
      ).includes("broker_protocol_unproven"),
      key,
    );
  }
});

test("rejects unknown capability fields without reflecting hostile values", () => {
  const value = capability();
  value.credential.secret = "PRIVATE";
  const failures = brokerCapabilityFailures(value, now);
  assert.ok(failures.includes("broker_capability_shape_invalid"));
  assert.doesNotMatch(failures.join(","), /PRIVATE/u);
});
