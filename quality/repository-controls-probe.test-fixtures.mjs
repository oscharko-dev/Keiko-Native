import {
  BROKER_APP_PERMISSIONS,
  BROKER_PROTOCOL_SEMANTICS,
} from "./epic-merge-broker-capability.mjs";

export const repository = "oscharko-dev/Keiko-Native";
const checks = [{ app_id: 15368, context: "PR contract" }];

function identity(appId, slug, permissions) {
  return {
    app: { id: appId, slug, private_key: "PRIVATE" },
    installation: {
      account: { login: "oscharko-dev" },
      app_id: appId,
      app_slug: slug,
      id: appId + 1,
      permissions,
      repository_selection: "selected",
      suspended_at: null,
    },
    repositories: {
      repositories: [{ full_name: repository, secret: "TOKEN" }],
      total_count: 1,
    },
  };
}

export function rawProviderEvidence() {
  return {
    actions: {
      can_approve_pull_request_reviews: false,
      default_workflow_permissions: "read",
      token: "TOKEN",
    },
    branch: { commit: { sha: "a".repeat(40) } },
    broker: identity(4242, "keiko-epic-merge-broker", BROKER_APP_PERMISSIONS),
    caller: identity(5252, "keiko-restricted-caller", {
      contents: "write",
      issues: "write",
      metadata: "read",
      pull_requests: "write",
    }),
    devProtection: {
      allow_deletions: { enabled: false },
      allow_force_pushes: { enabled: false },
      enforce_admins: { enabled: true },
      required_conversation_resolution: { enabled: true },
      required_linear_history: { enabled: true },
      required_pull_request_reviews: {},
      required_signatures: { enabled: true },
      required_status_checks: { checks, strict: true },
      restrictions: {
        apps: [],
        teams: [],
        users: [{ login: "Niko4417" }, { login: "oscharko" }],
      },
    },
    epicProtection: {
      restrictions: {
        apps: [{ id: 4242, slug: "keiko-epic-merge-broker" }],
        teams: [],
        users: [{ login: "Niko4417" }, { login: "oscharko" }],
      },
    },
    epicRuleset: {
      bypass_actors: [],
      conditions: {
        ref_name: { exclude: [], include: ["refs/heads/epic/**"] },
      },
      enforcement: "active",
      id: 9191,
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        { type: "pull_request" },
        { type: "required_signatures" },
        { type: "required_linear_history" },
        { type: "required_conversation_resolution" },
        {
          parameters: {
            required_status_checks: checks.map(({ app_id, context }) => ({
              context,
              integration_id: app_id,
            })),
            strict_required_status_checks_policy: true,
          },
          type: "required_status_checks",
        },
      ],
    },
    humanPermissions: [
      { permission: "admin", user: { login: "Niko4417", email: "PRIVATE" } },
      { permission: "admin", user: { login: "oscharko" } },
    ],
    mergeQueue: { parameters: { max_entries_to_merge: 1 } },
  };
}

export function cleanRawProviderEvidence() {
  const raw = rawProviderEvidence();
  delete raw.actions.token;
  delete raw.broker.app.private_key;
  delete raw.caller.app.private_key;
  delete raw.broker.repositories.repositories[0].secret;
  delete raw.caller.repositories.repositories[0].secret;
  delete raw.humanPermissions[0].user.email;
  return raw;
}

export function repositoryControlMetadata() {
  return {
    brokerCredential: {
      callerReadable: false,
      custody: "server-side-broker-only",
      expiresAt: "2026-07-23T12:50:00.000Z",
      kind: "short-lived-installation-token",
      ordinaryWorkflowReadable: false,
    },
    callerCredential: {
      agentReadable: false,
      custody: "server-side-restricted-caller-only",
      expiresAt: "2026-07-23T12:50:00.000Z",
      kind: "short-lived-installation-token",
      ordinaryWorkflowReadable: false,
    },
    capturedAt: "2026-07-23T12:00:00.000Z",
    probes: {
      broker: {},
      brokerRejections: [],
      callerCapabilities: [],
      cleanup: {},
      denials: [],
      recovery: [],
      schema: "keiko-native-repository-controls-probes/v2",
    },
    protocol: { ...BROKER_PROTOCOL_SEMANTICS },
    repository,
    sourceStatuses: {
      administration: "ok",
      broker: "ok",
      caller: "ok",
      probes: "ok",
    },
  };
}
