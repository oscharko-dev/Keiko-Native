import assert from "node:assert/strict";
import test from "node:test";

import {
  LIFECYCLE_OBSERVATION_MARKER,
  LIFECYCLE_REQUEST_SCHEMA,
  lifecycleObservation,
  lifecycleObservationComment,
  lifecycleObservationRecords,
  lifecycleRequestReplay,
  parseLifecycleDispatchRequest,
  trustedLifecycleObservation,
} from "./issue-lifecycle-request.mjs";

function dispatchEvent(overrides = {}) {
  const { inputs: inputOverrides = {}, ...eventOverrides } = overrides;
  return {
    inputs: {
      expected_source: "status: ready",
      issue_number: "51",
      ordering_attestation: "not-applicable",
      reason: "blocked by exact-head evidence",
      request_identity: "request-51-0001",
      requested_target: "status: blocked",
      schema: LIFECYCLE_REQUEST_SCHEMA,
      ...inputOverrides,
    },
    ref: "dev",
    repository: { full_name: "oscharko-dev/Keiko-Native" },
    sender: { login: "Niko4417" },
    ...eventOverrides,
  };
}

function parse(event = dispatchEvent(), overrides = {}) {
  return parseLifecycleDispatchRequest({
    actor: "Niko4417",
    event,
    protectedRef: "refs/heads/dev",
    repository: "oscharko-dev/Keiko-Native",
    runAttempt: "1",
    runId: "30350729504",
    ...overrides,
  });
}

function botComment(body, overrides = {}) {
  return {
    body,
    id: 19,
    user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    ...overrides,
  };
}

test("parses and binds an authenticated versioned dispatch request", () => {
  const result = parse();
  assert.equal(result.ok, true);
  assert.equal(result.request.issueNumber, 51);
  assert.equal(result.request.reason, "blocked by exact-head evidence");
  assert.match(result.request.requestDigest, /^[0-9a-f]{64}$/u);
  assert.match(result.request.requestIdentityDigest, /^[0-9a-f]{64}$/u);
  assert.match(result.request.eventIdentity, /^30350729504:1:[0-9a-f]{64}$/u);

  const triage = parse(
    dispatchEvent({
      inputs: {
        expected_source: "status: new",
        ordering_attestation: "confirmed",
        reason: "",
        requested_target: "status: triaged",
      },
    }),
  );
  assert.equal(triage.ok, true);
  assert.equal(
    parse(
      dispatchEvent({
        inputs: {
          expected_source: "status: new",
          ordering_attestation: "confirmed",
          reason: undefined,
          requested_target: "status: triaged",
        },
      }),
    ).ok,
    true,
  );
});

test("rejects malformed, hostile, stale, and unauthorized dispatch input", () => {
  const cases = [
    [{ inputs: { schema: "v0" } }, "unsupported_request_schema"],
    [{ inputs: { issue_number: "01" } }, "invalid_issue_number"],
    [
      { inputs: { expected_source: "status: done" } },
      "invalid_expected_source",
    ],
    [
      { inputs: { requested_target: "status: done" } },
      "invalid_requested_target",
    ],
    [{ inputs: { request_identity: "short" } }, "invalid_request_identity"],
    [{ sender: { login: "attacker" } }, "authenticated_actor_mismatch"],
    [
      { repository: { full_name: "attacker/replay" } },
      "repository_identity_mismatch",
    ],
    [{ ref: "feature" }, "protected_ref_required"],
    [{ inputs: { reason: "" } }, "request_reason_required"],
    [
      {
        inputs: {
          expected_source: "status: new",
          ordering_attestation: "confirmed",
          requested_target: "status: triaged",
        },
      },
      "request_reason_not_permitted",
    ],
  ];
  for (const [overrides, expected] of cases) {
    const result = parse(dispatchEvent(overrides));
    assert.equal(result.ok, false, expected);
    assert.ok(result.failures.includes(expected), expected);
  }
  assert.ok(
    parse(dispatchEvent(), { runId: "not-a-run" }).failures.includes(
      "provider_event_identity_missing",
    ),
  );
});

test("records only trusted bounded observations and detects replay", () => {
  const request = parse().request;
  const observation = lifecycleObservation({
    activation: "disabled",
    issueNumber: 51,
    now: new Date("2026-07-28T10:30:00Z"),
    request,
    result: { desiredState: "status: blocked", outcome: "planned" },
  });
  const body = lifecycleObservationComment(observation);
  assert.match(body, new RegExp(LIFECYCLE_OBSERVATION_MARKER, "u"));
  assert.doesNotMatch(body, /blocked by exact-head evidence/u);
  assert.doesNotMatch(
    body,
    /ghp_|api\.github|blocked by exact-head evidence/iu,
  );

  const comment = botComment(body);
  assert.equal(trustedLifecycleObservation(comment, body), true);
  assert.deepEqual(lifecycleObservationRecords([comment]), [
    {
      commentId: 19,
      issueNumber: 51,
      requestDigest: request.requestDigest,
      requestIdentityDigest: request.requestIdentityDigest,
    },
  ]);
  assert.equal(
    lifecycleRequestReplay([comment], request),
    "duplicate_or_replayed_request",
  );

  const conflictingRequest = {
    ...request,
    requestDigest: "f".repeat(64),
  };
  assert.equal(
    lifecycleRequestReplay([comment], conflictingRequest),
    "request_identity_conflict",
  );
  const changedReason = parse(
    dispatchEvent({
      inputs: { reason: "waiting for a different exact-head decision" },
    }),
  ).request;
  assert.equal(
    changedReason.requestIdentityDigest,
    request.requestIdentityDigest,
  );
  assert.notEqual(changedReason.requestDigest, request.requestDigest);
  assert.equal(
    lifecycleRequestReplay([comment], changedReason),
    "request_identity_conflict",
  );
  for (const malformedBody of [
    `${LIFECYCLE_OBSERVATION_MARKER}\n- Request identity digest: \`${request.requestIdentityDigest}\`\n- Request digest: \`${request.requestDigest}\``,
    body.replace("- Outcome: `planned`", "- Outcome: `planned`\nraw"),
    body.replace("- Issue: `51`", "- Issue: `052`"),
  ])
    assert.equal(
      lifecycleRequestReplay([botComment(malformedBody)], request),
      "malformed_lifecycle_observation",
    );
  assert.equal(
    lifecycleRequestReplay(
      [
        {
          ...comment,
          user: { id: 1, login: "attacker", type: "User" },
        },
      ],
      request,
    ),
    undefined,
  );
});
