const F = (name, type, fixed) => ({ name, type, fixed });
const E = (...values) => ({ kind: "enum", values });
const N = (inner) => ({ kind: "nullable", inner });
const R = (name) => ({ kind: "record", name });
const SET = (inner, sortBy) => ({ kind: "set", inner, sortBy });
const LIST = (inner, uniqueBy) => ({ kind: "list", inner, uniqueBy });
const S = { kind: "string" };
const SHA = { ...S, format: "sha256" };
const OID = { ...S, format: "object-id" };
const REPO = { ...S, format: "repository" };
const TIME = { ...S, format: "timestamp" };
const U = { kind: "uint" };
const P = { ...U, positive: true };
const B = { kind: "bool" };

export const RECORD_TYPES = Object.freeze([
  "generation-request",
  "producer-result",
  "phase-fence-claim",
  "transition-read-back",
]);
export const PRODUCERS = Object.freeze([
  "issue-contract-current",
  "pr-contract",
  "contract-publication",
]);
export const REQUESTED_LIFECYCLE_STATES = Object.freeze([
  "status: new",
  "status: triaged",
  "status: ready",
  "status: in progress",
  "status: pr open",
  "status: ready for human review",
  "status: blocked",
  "status: waiting for user",
  "status: done",
]);
export const LIFECYCLE_OBSERVATIONS = Object.freeze([
  ...REQUESTED_LIFECYCLE_STATES,
  "no-lifecycle",
]);
export const REASON_CODES = Object.freeze([
  "ok",
  "activation-disabled",
  "not-applicable",
  "unauthorized",
  "invalid-schema",
  "malformed-record",
  "stale-generation",
  "fence-lost",
  "producer-mismatch",
  "evidence-incomplete",
  "provider-rejected",
  "provider-conflict",
  "provider-rate-limited",
  "provider-timeout",
  "provider-unavailable",
  "read-back-mismatch",
  "ambiguous-effect",
  "recovery-required",
  "superseded",
]);

export const COORDINATOR_PATH = ".github/workflows/issue-lifecycle.yml";
export const PR_CONTRACT_PATH = ".github/workflows/pr-contract.yml";
export const PUBLICATION_PATH = ".github/workflows/contract-publication.yml";
const WRITERS = [COORDINATOR_PATH, PR_CONTRACT_PATH, PUBLICATION_PATH];
const PHASES = [
  "request",
  "phase-one",
  "mutation",
  "phase-two",
  "terminal",
  "recovery",
];
const CONCLUSIONS = [
  "success",
  "failure",
  "cancelled",
  "timed-out",
  "unavailable",
];
const OWNERS = [
  "request",
  "assignment",
  "pull-request",
  "handoff",
  "closure",
  "reopen",
  "invalidation",
  "recovery",
];
const WAKE_SOURCE_PATHS = [
  ".github/workflows/issue-readiness.yml",
  ".github/workflows/pr-contract.yml",
  ".github/workflows/contract-publication.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/dependency-review.yml",
  ".github/workflows/osv-scanner.yml",
];
const primaryHeader = (name) => [
  F("record_type", E(name), name),
  F("schema_version", U, 1),
  F("digest_algorithm", E("sha-256"), "sha-256"),
  F(
    "digest_domain",
    E(`keiko-native.lifecycle-record.${name}`),
    `keiko-native.lifecycle-record.${name}`,
  ),
];
const common = [
  F("repository", REPO),
  F("issue_number", P),
  F("pull_request_number", N(P)),
  F("exact_head_sha", N(OID)),
];
const tail = [F("protected_dev_sha", OID), F("recorded_at", TIME)];

const DOMAINS = Object.freeze({
  "request identity": "keiko-native.lifecycle-request-identity",
  "request payload": "keiko-native.lifecycle-request-payload",
  "source observation": "keiko-native.lifecycle-source-observation",
  "fence identity": "keiko-native.lifecycle-fence-identity",
  "result identity": "keiko-native.lifecycle-result-identity",
  "provider observation": "keiko-native.lifecycle-provider-observation",
  "effect identity": "keiko-native.lifecycle-effect-identity",
  "read-back identity": "keiko-native.lifecycle-read-back-identity",
  "publication candidate set": "keiko-native.lifecycle-candidate-set",
  "compacted prefix": "keiko-native.lifecycle-compacted-prefix-identity",
  "checkpoint identity": "keiko-native.lifecycle-checkpoint-identity",
  "recovery suffix accumulator":
    "keiko-native.lifecycle-recovery-suffix-identity",
  "recovery scan identity": "keiko-native.lifecycle-recovery-scan-identity",
  "recovery target": "keiko-native.lifecycle-recovery-target-identity",
  "recovery settlement": "keiko-native.lifecycle-recovery-settlement-identity",
  "authorized recovery request":
    "keiko-native.lifecycle-recovery-authorized-request",
  "artifact anchor": "keiko-native.lifecycle-artifact-anchor",
});
export const AUXILIARY_IDENTITY_NAMES = Object.freeze(Object.keys(DOMAINS));
export const auxiliaryDomain = (name) => DOMAINS[name];
const aux = (name, fields) => [
  F("digest_domain", E(DOMAINS[name]), DOMAINS[name]),
  F("schema_version", U, 1),
  F("digest_algorithm", E("sha-256"), "sha-256"),
  ...fields,
];

// prettier-ignore
export const SCHEMAS = Object.freeze({
  "generation-request": [...primaryHeader("generation-request"), ...common, F("exact_target", N(S)), F("lane", E("normal", "publication", "not-applicable")), F("publication_submode", E("ordinary", "migration", "not-applicable")), F("generation_schema", U, 1), F("generation_bytes_sha256", SHA), F("generation_identity", SHA), F("attempt", U), F("request_identity", SHA), F("request_payload_digest", SHA), F("expected_producers", SET(E(...PRODUCERS))), F("source_observation_identity", SHA), F("predecessor_comment_id", N(P)), F("predecessor_record_digest", N(SHA)), F("workflow_path", E(COORDINATOR_PATH)), F("workflow_run_id", P), F("workflow_run_attempt", P), ...tail],
  "producer-result": [...primaryHeader("producer-result"), ...common, F("exact_target", N(S)), F("generation_identity", SHA), F("attempt", U), F("request_identity", SHA), F("generation_request_comment_id", P), F("generation_request_digest", SHA), F("phase_fence_comment_id", P), F("phase_fence_digest", SHA), F("expected_producer", E(...PRODUCERS)), F("producer_contract_version", P), F("workflow_path", E(PR_CONTRACT_PATH, PUBLICATION_PATH)), F("workflow_id", P), F("workflow_run_id", P), F("workflow_run_attempt", P), F("workflow_job_id", P), F("result_identity", SHA), F("protected_dev_sha", OID), F("provider_observation_identity", SHA), F("conclusion", E(...CONCLUSIONS)), F("reason_code", E(...REASON_CODES)), F("predecessor_comment_id", P), F("predecessor_record_digest", SHA), F("recorded_at", TIME)],
  "phase-fence-claim": [...primaryHeader("phase-fence-claim"), ...common, F("generation_identity", SHA), F("attempt", U), F("request_identity", SHA), F("phase", E(...PHASES)), F("fence_sequence", P), F("fence_identity", SHA), F("owner_workflow_path", E(COORDINATOR_PATH)), F("owner_run_id", P), F("owner_run_attempt", P), F("source_observation_identity", SHA), F("claim_outcome", E("claimed", "settled", "abandoned", "ambiguous", "superseded")), F("recovery_scan_identity", N(SHA)), F("recovery_scanned_page_count", U), F("recovery_scanned_comment_count", U), F("recovery_accumulated_suffix_identity", N(SHA)), F("recovery_provider_cursor", N(S)), F("recovery_scan_complete", B), F("recovery_settlement_identity", N(SHA)), F("predecessor_comment_id", N(P)), F("predecessor_record_digest", N(SHA)), ...tail],
  "transition-read-back": [...primaryHeader("transition-read-back"), ...common, F("exact_target", N(S)), F("generation_identity", SHA), F("attempt", U), F("request_identity", SHA), F("phase_fence_comment_id", P), F("phase_fence_digest", SHA), F("source_state", E(...LIFECYCLE_OBSERVATIONS)), F("desired_state", E(...LIFECYCLE_OBSERVATIONS)), F("observed_state", E(...LIFECYCLE_OBSERVATIONS)), F("transition_owner", E(...OWNERS)), F("effect_identity", N(SHA)), F("read_back_identity", SHA), F("producer_results", SET(R("producer-result-reference"), "producer")), F("checkpoint_sequence", P), F("prior_checkpoint_comment_id", N(P)), F("prior_checkpoint_record_digest", N(SHA)), F("compacted_prefix_identity", SHA), F("outcome", E("planned", "no-op", "applied", "denied", "failed", "abandoned", "ambiguous", "superseded")), F("reason_code", E(...REASON_CODES)), F("predecessor_comment_id", P), F("predecessor_record_digest", SHA), ...tail],
  "candidate-entry": [F("path", S), F("mode", E("100644", "100755")), F("blob_object_id", OID), F("byte_count", U), F("content_sha256", SHA)],
  "producer-result-reference": [F("producer", E(...PRODUCERS)), F("comment_id", P), F("record_digest", SHA), F("workflow_run_id", P), F("workflow_job_id", P), F("result_identity", SHA)],
  "checkpoint-member": [F("comment_id", P), F("record_digest", SHA)],
  "recovery-suffix-member": [F("comment_id", P), F("comment_body_sha256", SHA), F("classification", E("irrelevant", "authenticated-record")), F("record_digest", N(SHA)), F("artifact_anchor_identity", N(SHA)), F("predecessor_comment_id", N(P)), F("predecessor_record_digest", N(SHA))],
  "lifecycle-wake-locator": [F("repository", REPO), F("issue_number", P), F("pull_request_number", N(P)), F("source_workflow_path", E(...WAKE_SOURCE_PATHS)), F("source_run_id", P), F("source_run_attempt", P), F("source_protected_dev_sha", OID)],
  "aux:request identity": aux("request identity", [...common, F("exact_target", N(S)), F("generation_identity", SHA), F("attempt", U), F("request_payload_digest", SHA), F("expected_producers", SET(E(...PRODUCERS))), F("predecessor_comment_id", N(P)), F("predecessor_record_digest", N(SHA))]),
  "aux:request payload": aux("request payload", [F("request_kind", E("event-reconciliation", "planner-request", "pause-request", "recovery-request", "scheduled-reconciliation")), F("requested_state", N(E(...REQUESTED_LIFECYCLE_STATES))), F("request_owner", E("planner", "assignment", "pull-request", "handoff", "closure", "reopen", "invalidation", "recovery", "schedule")), F("recovery_target_identity", N(SHA)), F("reason_code", E(...REASON_CODES))]),
  "aux:source observation": aux("source observation", [F("generation_bytes_sha256", SHA), F("observed_state", E(...LIFECYCLE_OBSERVATIONS)), F("issue_updated_at", TIME), F("readiness_identity", N(SHA)), F("assignment_identity", SHA), F("pr_topology_identity", SHA), F("reviews_identity", SHA), F("conversations_identity", SHA), F("checks_identity", SHA), F("evidence_identity", SHA), F("activation_identity", SHA)]),
  "aux:fence identity": aux("fence identity", [F("generation_identity", SHA), F("attempt", U), F("phase", E(...PHASES)), F("fence_sequence", P), F("owner_workflow_path", E(COORDINATOR_PATH)), F("owner_run_id", P), F("owner_run_attempt", P), F("source_observation_identity", SHA), F("predecessor_comment_id", N(P)), F("predecessor_record_digest", N(SHA))]),
  "aux:result identity": aux("result identity", [F("expected_producer", E(...PRODUCERS)), F("producer_contract_version", P), F("generation_identity", SHA), F("attempt", U), F("phase_fence_digest", SHA), F("workflow_path", E(PR_CONTRACT_PATH, PUBLICATION_PATH)), F("workflow_id", P), F("workflow_run_id", P), F("workflow_run_attempt", P), F("workflow_job_id", P), F("provider_observation_identity", SHA), F("conclusion", E(...CONCLUSIONS)), F("reason_code", E(...REASON_CODES))]),
  "aux:provider observation": aux("provider observation", [F("expected_producer", E(...PRODUCERS)), F("generation_identity", SHA), F("exact_head_sha", N(OID)), F("phase_fence_digest", SHA), F("provider_result_id", P), F("provider_result_name", E("Issue contract current", "PR contract", "Contract publication")), F("provider_result_conclusion", E(...CONCLUSIONS)), F("provider_result_sha", N(OID)), F("producer_payload_digest", SHA)]),
  "aux:effect identity": aux("effect identity", [F("generation_identity", SHA), F("attempt", U), F("phase_fence_digest", SHA), F("source_state", E(...LIFECYCLE_OBSERVATIONS)), F("desired_state", E(...LIFECYCLE_OBSERVATIONS)), F("transition_owner", E(...OWNERS)), F("mutation", E("no-effect", "set-lifecycle", "remove-lifecycle")), F("source_observation_identity", SHA)]),
  "aux:read-back identity": aux("read-back identity", [F("generation_identity", SHA), F("attempt", U), F("phase_fence_digest", SHA), F("effect_identity", N(SHA)), F("observed_state", E(...LIFECYCLE_OBSERVATIONS)), F("issue_updated_at", TIME), F("source_observation_identity", SHA)]),
  "aux:publication candidate set": aux("publication candidate set", [F("exact_commit_sha", OID), F("root_tree_sha", OID), F("entries", SET(R("candidate-entry"), "path"))]),
  "aux:compacted prefix": aux("compacted prefix", [F("repository", REPO), F("issue_number", P), F("checkpoint_sequence", P), F("prior_checkpoint_identity", N(SHA)), F("members", LIST(R("checkpoint-member"), ["comment_id", "record_digest"]))]),
  "aux:checkpoint identity": aux("checkpoint identity", [F("repository", REPO), F("issue_number", P), F("checkpoint_sequence", P), F("prior_checkpoint_comment_id", N(P)), F("prior_checkpoint_record_digest", N(SHA)), F("compacted_prefix_identity", SHA), F("chain_tip_comment_id", P), F("chain_tip_record_digest", SHA)]),
  "aux:recovery suffix accumulator": aux("recovery suffix accumulator", [F("repository", REPO), F("issue_number", P), F("checkpoint_sequence", U), F("scan_direction", E("backward"), "backward"), F("accumulator_step", P), F("prior_accumulated_suffix_identity", N(SHA)), F("page_members", LIST(R("recovery-suffix-member"))), F("cumulative_member_count", P), F("next_provider_cursor", N(S)), F("complete", B)]),
  "aux:recovery scan identity": aux("recovery scan identity", [F("repository", REPO), F("issue_number", P), F("checkpoint_sequence", U), F("scan_direction", E("backward"), "backward"), F("provider_cursor", N(S)), F("scanned_page_count", P), F("scanned_comment_count", P), F("accumulated_suffix_identity", SHA), F("complete", B)]),
  "aux:recovery target": aux("recovery target", [F("repository", REPO), F("issue_number", P), F("orphan_comment_id", P), F("orphan_comment_body_sha256", SHA), F("orphan_record_digest", SHA), F("last_authenticated_comment_id", N(P)), F("last_authenticated_record_digest", N(SHA))]),
  "aux:recovery settlement": aux("recovery settlement", [F("repository", REPO), F("issue_number", P), F("authorized_request_identity", SHA), F("recovery_target_identity", SHA), F("orphan_comment_id", P), F("orphan_comment_body_sha256", SHA), F("orphan_record_digest", SHA), F("orphan_author_login", E("github-actions[bot]"), "github-actions[bot]"), F("orphan_author_id", U, 41898282), F("orphan_actor_type", E("Bot"), "Bot"), F("orphan_app_id", U, 15368), F("orphan_workflow_path", E(...WRITERS)), F("orphan_workflow_run_id", P), F("orphan_workflow_run_attempt", P), F("orphan_protected_dev_sha", OID), F("orphan_run_conclusion", E("failure", "cancelled", "timed-out")), F("orphan_anchor_count", U, 0), F("orphan_attestation_count", U, 0), F("last_authenticated_comment_id", N(P)), F("last_authenticated_record_digest", N(SHA)), F("quarantine_reason", E("anchor-publication-interrupted"), "anchor-publication-interrupted")]),
  "aux:authorized recovery request": aux("authorized recovery request", [F("repository_id", P), F("issue_number", P), F("comment_id", P), F("command_body_sha256", SHA), F("comment_created_at", TIME), F("author_id", P), F("author_type", E("User"), "User"), F("recovery_target_identity", SHA)]),
  "aux:artifact anchor": aux("artifact anchor", [F("repository", REPO), F("issue_number", P), F("record_type", E(...RECORD_TYPES)), F("record_digest", SHA), F("comment_id", P), F("comment_body_sha256", SHA), F("generation_identity", SHA), F("attempt", U), F("workflow_path", E(...WRITERS)), F("workflow_run_id", P), F("workflow_run_attempt", P), F("protected_dev_sha", OID)]),
});

const pair = (value, left, right, fail) => {
  if ((value[left] === null) !== (value[right] === null))
    fail(`${left}/${right} pair`);
};
// prettier-ignore
export function validateSchema(name, value, fail) {
  if (["generation-request", "phase-fence-claim", "aux:request identity", "aux:fence identity"].includes(name)) pair(value, "predecessor_comment_id", "predecessor_record_digest", fail);
  if (["transition-read-back", "aux:checkpoint identity"].includes(name)) pair(value, "prior_checkpoint_comment_id", "prior_checkpoint_record_digest", fail);
  if (["aux:recovery target", "aux:recovery settlement"].includes(name)) pair(value, "last_authenticated_comment_id", "last_authenticated_record_digest", fail);
  const paths = {
    "issue-contract-current": PR_CONTRACT_PATH,
    "pr-contract": PR_CONTRACT_PATH,
    "contract-publication": PUBLICATION_PATH,
  };
  if (["producer-result", "aux:result identity"].includes(name) && paths[value.expected_producer] !== value.workflow_path) fail("producer/workflow mismatch");
  const names = {
    "issue-contract-current": "Issue contract current",
    "pr-contract": "PR contract",
    "contract-publication": "Contract publication",
  };
  if (name === "aux:provider observation" && names[value.expected_producer] !== value.provider_result_name) fail("producer/result name mismatch");
  if (name === "aux:request payload" && (value.request_kind === "recovery-request") !== (value.recovery_target_identity !== null)) fail("recovery target coupling");
  if (name === "recovery-suffix-member") {
    pair(value, "predecessor_comment_id", "predecessor_record_digest", fail);
    const irrelevant = value.classification === "irrelevant";
    if (irrelevant !== [value.record_digest, value.artifact_anchor_identity, value.predecessor_comment_id, value.predecessor_record_digest].every((item) => item === null)) fail("recovery member discriminant");
  }
  if (name === "aux:compacted prefix" && (value.checkpoint_sequence === 1) !== (value.prior_checkpoint_identity === null)) fail("compacted-prefix genesis mismatch");
  if (name === "aux:checkpoint identity" && (value.checkpoint_sequence === 1) !== (value.prior_checkpoint_comment_id === null)) fail("checkpoint genesis mismatch");
  if (name === "aux:recovery suffix accumulator") {
    if ((value.accumulator_step === 1) !== (value.prior_accumulated_suffix_identity === null)) fail("accumulator predecessor mismatch");
    if (value.complete !== (value.next_provider_cursor === null)) fail("accumulator cursor mismatch");
    if (value.page_members.length === 0) fail("accumulator page must not be empty");
    if (value.cumulative_member_count < value.page_members.length) fail("accumulator count mismatch");
    if (!value.complete && value.checkpoint_sequence !== 0) fail("incomplete accumulator checkpoint must be zero");
    for (const field of ["comment_id", "record_digest", "artifact_anchor_identity"]) {
      const values = value.page_members.map((member) => member[field]).filter((item) => item !== null);
      if (new Set(values).size !== values.length) fail(`duplicate recovery ${field}`);
    }
  }
  if (name === "aux:recovery scan identity") {
    if (value.complete !== (value.provider_cursor === null)) fail("scan cursor mismatch");
    if (!value.complete && value.checkpoint_sequence !== 0) fail("incomplete scan checkpoint must be zero");
  }
  if (name === "phase-fence-claim") validateRecoveryClaim(value, fail);
}

// prettier-ignore
function validateRecoveryClaim(value, fail) {
  const scan = value.recovery_scan_identity !== null;
  const settlement = value.recovery_settlement_identity !== null;
  const empty = value.recovery_scanned_page_count === 0 && value.recovery_scanned_comment_count === 0 && value.recovery_accumulated_suffix_identity === null && value.recovery_provider_cursor === null && !value.recovery_scan_complete;
  if (value.phase !== "recovery") {
    if (scan || settlement || !empty) fail("non-recovery fields");
  } else if (scan === settlement) fail("recovery shape");
  else if (settlement && !empty) fail("settlement scan fields");
  else if (scan && (value.recovery_scanned_page_count === 0 || value.recovery_scanned_comment_count === 0 || value.recovery_accumulated_suffix_identity === null || value.recovery_scan_complete !== (value.recovery_provider_cursor === null))) fail("scan fields");
}
