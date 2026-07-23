import {
  BROKER_APP_PERMISSIONS,
  BROKER_CAPABILITY_SCHEMA,
  BROKER_PROTOCOL_SEMANTICS,
} from "./epic-merge-broker-capability.mjs";
import {
  REPOSITORY_CONTROLS_EVIDENCE_SCHEMA,
  REPOSITORY_CONTROLS_POLICY_SCHEMA,
  REPOSITORY_CONTROLS_PROBES_SCHEMA,
} from "./repository-controls.mjs";
import {
  acceptedEpicMergeEffectFromReceipt,
  createAcceptedEpicMergeReceipt,
} from "./epic-merge-broker-receipt.mjs";
import {
  createRsaPssReceiptSigningCapability,
  receiptPublicKeyFingerprint,
} from "./epic-merge-broker-receipt-crypto.mjs";
import {
  DEV_ACTIVATION_CHECKS,
  EPIC_REQUIRED_CHECKS,
  EPIC_ACTIVATION_CHECKS,
  REQUIRED_CHECKS,
} from "./repository-controls-policy.mjs";
import {
  denialAttemptForEffect,
  denialEffects,
} from "./repository-controls-probe-denials.mjs";
import {
  BROKER_PERMISSION_ENTRIES,
  brokerRejectionScenarios,
  permissionSetDigest,
} from "./repository-controls-probe-scenarios.mjs";
import { acceptedBrokerAuthorizationInput } from "./repository-controls-broker.test-fixtures.mjs";

const repository = "oscharko-dev/Keiko-Native";
const receiptKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const receiptPublicKey = receiptKeys.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();
const receiptFingerprint = receiptPublicKeyFingerprint(receiptPublicKey);
const receiptSigner = createRsaPssReceiptSigningCapability(
  receiptKeys.privateKey,
);
export const repositoryControlsNow = Date.parse("2026-07-23T12:30:00.000Z");
const callerPermissions = {
  contents: "write",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
};
export function repositoryControlsPolicy() {
  return {
    devBranch: "dev",
    epic: {
      include: ["refs/heads/epic/**"],
      probeTarget: "epic/50-controls-probe",
      requiredChecks: [...EPIC_REQUIRED_CHECKS, ...EPIC_ACTIVATION_CHECKS].map(
        (value) => ({ ...value }),
      ),
      rulesetId: 9191,
    },
    evidenceMaxAgeMinutes: 60,
    humanAllowlist: ["Niko4417", "oscharko"],
    identities: {
      broker: {
        appId: 4242,
        appSlug: "keiko-epic-merge-broker",
        capabilityPolicy: BROKER_CAPABILITY_SCHEMA,
        installationAccount: "oscharko-dev",
        installationId: 4343,
        receiptVerificationKey: receiptPublicKey,
        receiptVerificationKeyFingerprint: receiptFingerprint,
      },
      caller: {
        appId: 5252,
        appSlug: "keiko-restricted-caller",
        installationAccount: "oscharko-dev",
        installationId: 5353,
        permissions: { ...callerPermissions },
      },
    },
    mergeQueue: { maxEntriesToMerge: 1 },
    pendingChecks: { dev: [], epic: [] },
    repository,
    requiredChecks: [...REQUIRED_CHECKS, ...DEV_ACTIVATION_CHECKS].map(
      (value) => ({ ...value }),
    ),
    schema: REPOSITORY_CONTROLS_POLICY_SCHEMA,
  };
}

function appEvidence(identity, permissions) {
  return {
    account: "oscharko-dev",
    appId: identity.appId,
    appSlug: identity.appSlug,
    installationId: identity.installationId,
    permissions: { ...permissions },
    repositories: [repository],
    repositorySelection: "selected",
    suspended: false,
  };
}

function brokerCapability(value) {
  return {
    app: appEvidence(value.identities.broker, BROKER_APP_PERMISSIONS),
    capturedAt: "2026-07-23T12:00:00.000Z",
    credential: {
      callerReadable: false,
      custody: "server-side-broker-only",
      expiresAt: "2026-07-23T12:50:00.000Z",
      kind: "short-lived-installation-token",
      ordinaryWorkflowReadable: false,
    },
    protocol: { ...BROKER_PROTOCOL_SEMANTICS },
    repository,
    schema: BROKER_CAPABILITY_SCHEMA,
  };
}

function callerCapability(value) {
  return {
    app: appEvidence(value.identities.caller, callerPermissions),
    credential: {
      agentReadable: false,
      custody: "server-side-restricted-caller-only",
      expiresAt: "2026-07-23T12:50:00.000Z",
      kind: "short-lived-installation-token",
      ordinaryWorkflowReadable: false,
    },
  };
}

const requestId = (index) => index.toString(16).padStart(64, "0");

function brokerProbe() {
  const brokerDecisionInput = acceptedBrokerAuthorizationInput();
  return {
    actorAppId: 4242,
    mergeCommitSigned: true,
    observedAt: "2026-07-23T12:00:00.000Z",
    receipt: createAcceptedEpicMergeReceipt(
      brokerDecisionInput,
      requestId(100),
      receiptSigner,
    ),
  };
}

function negativeCoordinates(effect, index) {
  return {
    actorAppId: 4242,
    automationDisabled: true,
    base: effect.base,
    head: effect.head,
    issue: 5050,
    issueFence: effect.issueFence,
    observedAt: "2026-07-23T12:00:00.000Z",
    protectedStateUnchanged: true,
    pullRequest: effect.pullRequest,
    repository: effect.repository,
    requestId: requestId(index),
    result: "rejected",
    snapshotId: effect.snapshotId,
    source: effect.source,
    target: effect.target,
    targetFence: effect.targetFence,
  };
}

function brokerRejectionProbes(effect) {
  const permissionDrift = [...BROKER_PERMISSION_ENTRIES].map((entry) =>
    entry === "contents:write" ? "contents:read" : entry,
  );
  return brokerRejectionScenarios.map((scenario, index) => {
    const row = {
      ...negativeCoordinates(effect, index + 1),
      scenario,
    };
    const details = {
      broader_target: { attemptedTarget: "epic/**", submitted: false },
      concurrent_request: {
        competingRequestId: requestId(200),
        competingTargetFence: "competing-target-fence",
        submitted: false,
      },
      permission_drift: {
        expectedPermissions: [...BROKER_PERMISSION_ENTRIES],
        expectedPermissionsDigest: permissionSetDigest([
          ...BROKER_PERMISSION_ENTRIES,
        ]),
        observedPermissions: permissionDrift,
        observedPermissionsDigest: permissionSetDigest(permissionDrift),
        submitted: false,
      },
      provider_failure: {
        failureClass: "provider_unavailable",
        providerResult: "unavailable",
        submitted: false,
      },
      replay: {
        noRetry: true,
        replayOfRequestId: effect.requestId,
        replayOfSnapshotId: effect.snapshotId,
        submissionCount: 1,
        submitted: false,
      },
      stale_base: {
        expectedBase: effect.base,
        observedBase: "4".repeat(40),
        submitted: false,
      },
      stale_head: {
        expectedHead: effect.head,
        observedHead: "3".repeat(40),
        submitted: false,
      },
      wrong_target: { attemptedTarget: "dev", submitted: false },
    };
    row.details = details[scenario];
    return row;
  });
}

function callerProbes(effect) {
  return ["branch", "issue", "lifecycle_request", "pull_request"].map(
    (capability, index) => {
      const active = ["branch", "pull_request"].includes(capability);
      const artifacts = {
        branch: `refs/heads/${effect.source}`,
        issue: "issues/5050",
        lifecycle_request: "issues/5050#lifecycle",
        pull_request: `pulls/${String(effect.pullRequest)}`,
      };
      return {
        actorAppId: 5252,
        artifact: artifacts[capability],
        base: active ? effect.base : null,
        capability,
        commitSigned: active ? true : "not_applicable",
        head: active ? effect.head : null,
        issue: 5050,
        observedAt: "2026-07-23T12:00:00.000Z",
        pullRequest: capability === "pull_request" ? effect.pullRequest : null,
        repository: effect.repository,
        requestId: requestId(index + 20),
        result: "accepted",
        source: active ? effect.source : null,
        target: active ? effect.target : null,
      };
    },
  );
}

function recoveryProbes() {
  return ["ambiguous_result", "outage", "revocation", "rotation"].map(
    (scenario) => ({
      automationDisabled: true,
      capabilityReproven: true,
      humanReconciled: scenario === "ambiguous_result",
      noRetry: true,
      observedAt: "2026-07-23T12:00:00.000Z",
      result: "recovered",
      scenario,
    }),
  );
}

export function repositoryControlsEvidence(value = repositoryControlsPolicy()) {
  const broker = brokerProbe();
  const effect = acceptedEpicMergeEffectFromReceipt(
    broker.receipt,
    value.identities.broker.receiptVerificationKey,
    value.identities.broker.receiptVerificationKeyFingerprint,
  );
  const result = {
    actions: {
      canApprovePullRequestReviews: false,
      defaultWorkflowPermissions: "read",
    },
    administration: { humanAdmins: ["Niko4417", "oscharko"] },
    broker: brokerCapability(value),
    caller: callerCapability(value),
    capturedAt: "2026-07-23T12:00:00.000Z",
    devHeadSha: "a".repeat(40),
    devProtection: {
      adminsEnforced: true,
      branchDeletionAllowed: false,
      conversationResolutionRequired: true,
      forcePushAllowed: false,
      linearHistoryRequired: true,
      pullRequestRequired: true,
      requiredChecks: value.requiredChecks.map((check) => ({ ...check })),
      signedCommitsRequired: true,
      strictChecks: true,
      updateAllowlist: {
        apps: [],
        teams: [],
        users: ["Niko4417", "oscharko"],
      },
    },
    epicProtection: {
      adminsEnforced: true,
      branchDeletionAllowed: false,
      bypassActors: [],
      conversationResolutionRequired: true,
      enforcement: "active",
      exclude: [],
      forcePushAllowed: false,
      include: ["refs/heads/epic/**"],
      linearHistoryRequired: true,
      pullRequestRequired: true,
      requiredChecks: value.epic.requiredChecks.map((check) => ({ ...check })),
      rulesetId: 9191,
      signedCommitsRequired: true,
      strictChecks: true,
      updateAllowlist: {
        apps: [
          {
            appId: 4242,
            appSlug: "keiko-epic-merge-broker",
          },
        ],
        teams: [],
        users: ["Niko4417", "oscharko"],
      },
    },
    mergeQueue: { maxEntriesToMerge: 1 },
    probes: {
      broker,
      brokerRejections: brokerRejectionProbes(effect),
      callerCapabilities: callerProbes(effect),
      cleanup: {
        artifactsRemaining: 0,
        observedAt: "2026-07-23T12:00:00.000Z",
        result: "passed",
      },
      denials: denialEffects.map((denial, index) => {
        const { automationDisabled: _unused, ...coordinates } =
          negativeCoordinates(effect, index + 40);
        return {
          ...coordinates,
          actorAppId: denial.startsWith("broker_") ? 4242 : 5252,
          ...denialAttemptForEffect(denial, effect),
          effect: denial,
          result: "denied",
          target: effect.target,
        };
      }),
      recovery: recoveryProbes(),
      schema: REPOSITORY_CONTROLS_PROBES_SCHEMA,
    },
    repository,
    schema: REPOSITORY_CONTROLS_EVIDENCE_SCHEMA,
    sources: {
      administration: "ok",
      broker: "ok",
      caller: "ok",
      probes: "ok",
    },
  };
  const administration = {
    actions: result.actions,
    administration: result.administration,
    devHeadSha: result.devHeadSha,
    devProtection: result.devProtection,
    epicProtection: result.epicProtection,
    mergeQueue: result.mergeQueue,
  };
  result.configurationReads = {
    administration: [
      structuredClone(administration),
      structuredClone(administration),
    ],
    broker: [
      structuredClone(result.broker.app),
      structuredClone(result.broker.app),
    ],
    caller: [
      structuredClone(result.caller.app),
      structuredClone(result.caller.app),
    ],
  };
  return result;
}
import { generateKeyPairSync } from "node:crypto";
