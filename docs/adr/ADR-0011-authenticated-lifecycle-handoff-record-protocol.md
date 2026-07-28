# ADR-0011: Authenticated lifecycle handoff record protocol

## Status

Proposed, 2026-07-28. Decision issue #129 selected this outcome. The record becomes accepted only
when an authorized maintainer manually merges its pull request to `dev`.

This record completes ADR-0004's protected exact-head handoff persistence and producer protocol. It
does not amend ADR-0009's guarded child-to-epic merge effect, ADR-0010's staged activation, or the
human-only `dev` boundary.

## Context

ADR-0004 defines one canonical nine-state lifecycle, a two-phase exact-head handoff, canonical
generation bytes, protected producers, shared per-issue serialization, and fail-closed recovery.
The existing decision deliberately leaves one production boundary unresolved: GitHub issue
comments are not transactional storage, so an enabled coordinator needs an accepted protocol for
persisting generation attempts, authenticating producer results, fencing effects, reconstructing
state after a crash, and proving exact publication tree evidence.

Issue #51 v4 proved the pure evaluators and guarded-off composition can be implemented, but an
independent audit found no accepted production record protocol. Shipping an enabled adapter without
one would invent authority at implementation time. Decision issue #129 therefore evaluated three
options against the frozen criteria below.

| Criterion                                       |   Weight | Option A | Option B | Option C |
| ----------------------------------------------- | -------: | -------: | -------: | -------: |
| Fail-closed authority and replay resistance     |      30% |        5 |        3 |        5 |
| No added identity, secret, or hosted dependency |      25% |        5 |        5 |        1 |
| Durable recovery and auditability               |      20% |        4 |        2 |        5 |
| Existing protected-workflow fit                 |      15% |        5 |        3 |        2 |
| Least privilege and operational simplicity      |      10% |        4 |        4 |        2 |
| **Weighted total**                              | **100%** | **4.70** | **3.40** | **3.25** |

- **Option A** uses the built-in GitHub Actions identity and append-only issue-comment records.
- **Option B** uses only workflow artifacts and check output.
- **Option C** adds an App, broker, external database, or hosted service.

Option B fails durable cross-run recovery because artifact retention and display metadata cannot
prove an immutable generation chain. Option C violates the operator-approved boundary: no added
account, installed App, personal access token, machine user, broker, database, or hosted service.

## Decision

Adopt Option A. Protected workflows loaded from `dev` use only the built-in
`github-actions[bot]` identity and their short-lived repository `GITHUB_TOKEN`. Canonical
append-only records are stored as issue comments. They are operational evidence, not planning
authority, lifecycle authority, merge authority, or a substitute for repository-backed contracts.

The coordinator remains the sole owner of lane, requested target, activation, lifecycle
reconciliation, and handoff outcome. Producers evaluate only their named predicate and cannot
select or widen those decisions. Before issue #55's signed activation, the complete protocol is
inert: it may emit only sanitized planned, denied, failed, or unavailable observations and performs
no lifecycle, status, branch, pull-request, queue, or merge mutation.

### Canonical record envelope

Every record body is UTF-8, Unicode NFC, and LF-only. It contains exactly:

1. one record-specific HTML marker on the first line;
2. one fenced `text` block containing the canonical record bytes encoded as lowercase hexadecimal;
3. one `Digest: sha-256:<64 lowercase hexadecimal>` line; and
4. one terminal LF.

There is no prefix, suffix, prose, second marker, second record, or trailing byte. The full-body
parser rejects malformed UTF-8, non-NFC text, CR, missing terminal LF, unknown or repeated markers,
extra text, invalid fence shape, uppercase or odd-length hex, unknown digest algorithm, wrong digest
length, and every byte outside this envelope. A marker substring or permissive JSON parse has no
authority.

The record bytes use ADR-0004's canonical version-1 grammar:
`tag#length:payload`. Fixed record field order, byte-counted boundaries, explicit `null`, sorted
set/map encodings, normalized strings, closed enums, unsigned decimal integers, and lowercase
validated commit/digest values apply unchanged. Missing, unknown, duplicate, reordered, incorrectly
typed, oversized, disallowed-null, or trailing fields reject the complete record.

The envelope limit is 32 KiB. A string is at most 4 KiB, a collection at most 256 entries, and a
record at most 128 fields. Repository identity is exactly `owner/name`; issue, pull request,
workflow run, attempt, job, result, comment, and fence integers are positive safe integers. A
commit, tree, or blob object identity is exactly 40 lowercase hexadecimal characters in this
repository.
A SHA-256 value is exactly 64 lowercase hexadecimal characters. Timestamps are UTC RFC 3339 with
whole seconds and `Z`; they are evidence only and never order or authorize a record.

Each record digest is SHA-256 of its exact canonical record bytes with a distinct fixed domain:

- `keiko-native.lifecycle-record.generation-request`
- `keiko-native.lifecycle-record.producer-result`
- `keiko-native.lifecycle-record.phase-fence-claim`
- `keiko-native.lifecycle-record.transition-read-back`

The domain, schema version `1`, algorithm `sha-256`, and record body are fixed fields in the record.
The existing generation-input domain `keiko-native.lifecycle-input-generation` remains unchanged.
Every producer and consumer independently parses the bytes, recomputes the digest, decodes both
fixed-length values, and compares them in constant time. A caller-supplied digest is never trusted.
Changing a domain, algorithm, grammar, or field meaning requires a later accepted ADR and schema
version; runtime negotiation is prohibited.

Closed producer identities are exactly `issue-contract-current`, `pr-contract`, and
`contract-publication`. The first two are produced by `.github/workflows/pr-contract.yml`; the
third is produced by `.github/workflows/contract-publication.yml`. The sole coordinator workflow is
`.github/workflows/issue-lifecycle.yml`. A later path or producer requires a schema-version change;
there is no caller-supplied producer or workflow path.

The closed reason-code enum is exactly `ok`, `activation-disabled`, `not-applicable`,
`unauthorized`, `invalid-schema`, `malformed-record`, `stale-generation`, `fence-lost`,
`producer-mismatch`, `evidence-incomplete`, `provider-rejected`, `provider-conflict`,
`provider-rate-limited`, `provider-timeout`, `provider-unavailable`, `read-back-mismatch`,
`ambiguous-effect`, `recovery-required`, and `superseded`. Provider status values and payloads are
not stored.

Every auxiliary identity is also SHA-256 over ADR-0004 canonical bytes with one fixed domain:

- request identity: `keiko-native.lifecycle-request-identity`
- request payload: `keiko-native.lifecycle-request-payload`
- source observation: `keiko-native.lifecycle-source-observation`
- fence identity: `keiko-native.lifecycle-fence-identity`
- result identity: `keiko-native.lifecycle-result-identity`
- provider observation: `keiko-native.lifecycle-provider-observation`
- effect identity: `keiko-native.lifecycle-effect-identity`
- read-back identity: `keiko-native.lifecycle-read-back-identity`
- publication candidate set: `keiko-native.lifecycle-candidate-set`
- compacted prefix: `keiko-native.lifecycle-compacted-prefix-identity`
- checkpoint identity: `keiko-native.lifecycle-checkpoint-identity`
- recovery suffix accumulator: `keiko-native.lifecycle-recovery-suffix-identity`
- recovery scan identity: `keiko-native.lifecycle-recovery-scan-identity`
- recovery target: `keiko-native.lifecycle-recovery-target-identity`
- recovery settlement: `keiko-native.lifecycle-recovery-settlement-identity`
- artifact anchor: `keiko-native.lifecycle-artifact-anchor`

That list is the exact one-to-one domain-to-schema mapping: the label before each colon is the
identity-schema row below, and the literal after it is that row's sole permitted domain. For every
auxiliary identity, the SHA-256 preimage is one top-level ADR-0004 `record` node whose fields are
exactly, in order: `digest_domain` as an `enum` containing that row's mapped literal;
`schema_version` as `uint` `1`; `digest_algorithm` as `enum` `sha-256`; then every remaining field
in that row's table schema after its leading `schema_version`, with the exact names and types shown.
Thus the table's leading `schema_version` occupies the second preimage field and is not encoded
twice. There is no wrapper, implicit type, omitted field, alternate domain, or raw domain prefix.

The exact auxiliary v1 schemas are:

| Identity                    | Fixed fields, in order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| request identity            | `schema_version:uint=1`, `repository:string`, `issue_number:uint`, `pull_request_number:uint-or-null`, `exact_head_sha:commit-or-null`, `exact_target:string-or-null`, `generation_identity:sha256`, `attempt:uint`, `request_payload_digest:sha256`, `expected_producers:set<producer>`, `predecessor_comment_id:uint-or-null`, `predecessor_record_digest:sha256-or-null`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| request payload             | `schema_version:uint=1`, `request_kind:enum(event-reconciliation,planner-request,pause-request,recovery-request,scheduled-reconciliation)`, `requested_state:requested-lifecycle-state-or-null`, `request_owner:enum(planner,assignment,pull-request,handoff,closure,reopen,invalidation,recovery,schedule)`, `recovery_target_identity:sha256-or-null`, `reason_code:closed-reason-code`                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| source observation          | `schema_version:uint=1`, `generation_bytes_sha256:sha256`, `observed_state:lifecycle-observation`, `issue_updated_at:timestamp`, `readiness_identity:sha256-or-null`, `assignment_identity:sha256`, `pr_topology_identity:sha256`, `reviews_identity:sha256`, `conversations_identity:sha256`, `checks_identity:sha256`, `evidence_identity:sha256`, `activation_identity:sha256`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| fence identity              | `schema_version:uint=1`, `generation_identity:sha256`, `attempt:uint`, `phase:phase-enum`, `fence_sequence:uint`, `owner_workflow_path:coordinator-path`, `owner_run_id:uint`, `owner_run_attempt:uint`, `source_observation_identity:sha256`, `predecessor_comment_id:uint-or-null`, `predecessor_record_digest:sha256-or-null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| result identity             | `schema_version:uint=1`, `expected_producer:producer`, `producer_contract_version:uint`, `generation_identity:sha256`, `attempt:uint`, `phase_fence_digest:sha256`, `workflow_path:producer-path`, `workflow_id:uint`, `workflow_run_id:uint`, `workflow_run_attempt:uint`, `workflow_job_id:uint`, `provider_observation_identity:sha256`, `conclusion:producer-conclusion`, `reason_code:closed-reason-code`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| provider observation        | `schema_version:uint=1`, `expected_producer:producer`, `generation_identity:sha256`, `exact_head_sha:commit-or-null`, `phase_fence_digest:sha256`, `provider_result_id:uint`, `provider_result_name:closed-producer-result-name`, `provider_result_conclusion:producer-conclusion`, `provider_result_sha:commit-or-null`, `producer_payload_digest:sha256`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| effect identity             | `schema_version:uint=1`, `generation_identity:sha256`, `attempt:uint`, `phase_fence_digest:sha256`, `source_state:lifecycle-observation`, `desired_state:lifecycle-observation`, `transition_owner:transition-owner`, `mutation:enum(no-effect,set-lifecycle,remove-lifecycle)`, `source_observation_identity:sha256`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| read-back identity          | `schema_version:uint=1`, `generation_identity:sha256`, `attempt:uint`, `phase_fence_digest:sha256`, `effect_identity:sha256-or-null`, `observed_state:lifecycle-observation`, `issue_updated_at:timestamp`, `source_observation_identity:sha256`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| publication candidate set   | `schema_version:uint=1`, `exact_commit_sha:commit`, `root_tree_sha:tree`, `entries:set<candidate-entry>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| compacted prefix            | `schema_version:uint=1`, `repository:string`, `issue_number:uint`, `checkpoint_sequence:uint`, `prior_checkpoint_identity:sha256-or-null`, `members:list<checkpoint-member>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| checkpoint identity         | `schema_version:uint=1`, `repository:string`, `issue_number:uint`, `checkpoint_sequence:uint`, `prior_checkpoint_comment_id:uint-or-null`, `prior_checkpoint_record_digest:sha256-or-null`, `compacted_prefix_identity:sha256`, `chain_tip_comment_id:uint`, `chain_tip_record_digest:sha256`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| recovery suffix accumulator | `schema_version:uint=1`, `repository:string`, `issue_number:uint`, `checkpoint_sequence:uint`, `scan_direction:enum(backward)`, `accumulator_step:uint`, `prior_accumulated_suffix_identity:sha256-or-null`, `page_members:list<recovery-suffix-member>`, `cumulative_member_count:uint`, `next_provider_cursor:string-or-null`, `complete:bool`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| recovery scan identity      | `schema_version:uint=1`, `repository:string`, `issue_number:uint`, `checkpoint_sequence:uint`, `scan_direction:enum(backward)`, `provider_cursor:string-or-null`, `scanned_page_count:uint`, `scanned_comment_count:uint`, `accumulated_suffix_identity:sha256`, `complete:bool`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| recovery target             | `schema_version:uint=1`, `repository:string`, `issue_number:uint`, `orphan_comment_id:uint`, `orphan_comment_body_sha256:sha256`, `orphan_record_digest:sha256`, `last_authenticated_comment_id:uint-or-null`, `last_authenticated_record_digest:sha256-or-null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| recovery settlement         | `schema_version:uint=1`, `repository:string`, `issue_number:uint`, `authorized_request_identity:sha256`, `recovery_target_identity:sha256`, `orphan_comment_id:uint`, `orphan_comment_body_sha256:sha256`, `orphan_record_digest:sha256`, `orphan_author_login:enum(github-actions[bot])`, `orphan_author_id:uint=41898282`, `orphan_actor_type:enum(Bot)`, `orphan_app_id:uint=15368`, `orphan_workflow_path:protected-writer-path`, `orphan_workflow_run_id:uint`, `orphan_workflow_run_attempt:uint`, `orphan_protected_dev_sha:commit`, `orphan_run_conclusion:enum(failure,cancelled,timed-out)`, `orphan_anchor_count:uint=0`, `orphan_attestation_count:uint=0`, `last_authenticated_comment_id:uint-or-null`, `last_authenticated_record_digest:sha256-or-null`, `quarantine_reason:enum(anchor-publication-interrupted)` |
| artifact anchor             | `schema_version:uint=1`, `repository:string`, `issue_number:uint`, `record_type:record-type`, `record_digest:sha256`, `comment_id:uint`, `comment_body_sha256:sha256`, `generation_identity:sha256`, `attempt:uint`, `workflow_path:protected-writer-path`, `workflow_run_id:uint`, `workflow_run_attempt:uint`, `protected_dev_sha:commit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

`requested-lifecycle-state` is exactly `status: new`, `status: triaged`, `status: ready`,
`status: in progress`, `status: pr open`, `status: ready for human review`, `status: blocked`,
`status: waiting for user`, and `status: done`; it excludes `no-lifecycle`.
`lifecycle-observation` is exactly those nine canonical lifecycle values plus `no-lifecycle`.
`recovery_target_identity` is non-null only for `recovery-request` and binds the exact orphan plus
the last authenticated predecessor selected by the authorized request; every other request kind
uses explicit null.
`phase-enum`, `producer-conclusion`, and `transition-owner` are the closed enums declared by the
record fields below. `closed-producer-result-name` maps the three producers one-to-one to `Issue
contract current`, `PR contract`, and `Contract publication`; another name rejects the observation.
The producer payload is the owning protected producer's already-versioned canonical result bytes,
not JSON or display text. The upstream readiness, assignment, PR-topology, review, conversation,
check, evidence, and activation identities are the exact authenticated identities owned by
ADR-0003, ADR-0004, ADR-0009, ADR-0010, and their repository contracts; missing or unversioned
upstream identity rejects the source observation rather than creating a default.

The nested `candidate-entry` schema is exactly `path:string`, `mode:enum(100644,100755)`,
`blob_object_id:blob`, `byte_count:uint`, and `content_sha256:sha256`, in that order. The nested
`producer-result-reference` schema is exactly `producer:producer`, `comment_id:uint`,
`record_digest:sha256`, `workflow_run_id:uint`, `workflow_job_id:uint`, and
`result_identity:sha256`, in that order. Candidate entries sort by their complete canonical path
node and reject duplicate normalized paths. Producer-result references sort by their complete
canonical producer node and require exactly one member for every expected producer.

The nested `checkpoint-member` schema is exactly `comment_id:uint` and `record_digest:sha256`, in
that order. Its enclosing list preserves authenticated predecessor order and rejects duplicate
comment IDs or record digests.

The nested `recovery-suffix-member` schema is exactly `comment_id:uint`,
`comment_body_sha256:sha256`, `classification:enum(irrelevant,authenticated-record)`,
`record_digest:sha256-or-null`, `artifact_anchor_identity:sha256-or-null`,
`predecessor_comment_id:uint-or-null`, and `predecessor_record_digest:sha256-or-null`, in that
order. An irrelevant member has all four record/anchor/predecessor fields null. An authenticated
record member requires the record and anchor identities; its predecessor pair is both null only for
the unique genesis root and otherwise both non-null.

`record-type` is the exact four-value record enum. `protected-writer-path` is the closed coordinator
or producer workflow path. The artifact anchor is canonical bytes in one immutable GitHub Actions
artifact; it is not a fifth issue-record schema or authority source.

The generation-bytes checksum is SHA-256 of the exact already-domain-separated ADR-0004 generation
bytes. No identity uses raw concatenation, display text, JSON serialization, an implicit default,
an unspecified child digest, or another identity's domain.

### Generation request v1

Marker:

`<!-- keiko-native-lifecycle-generation-request:v1 -->`

Fixed fields, in order:

1. `record_type`: enum `generation-request`
2. `schema_version`: uint `1`
3. `digest_algorithm`: enum `sha-256`
4. `digest_domain`: enum `keiko-native.lifecycle-record.generation-request`
5. `repository`: string
6. `issue_number`: uint
7. `pull_request_number`: uint or explicit null
8. `exact_head_sha`: commit or explicit null
9. `exact_target`: string or explicit null
10. `lane`: enum `normal`, `publication`, or `not-applicable`
11. `publication_submode`: enum `ordinary`, `migration`, or `not-applicable`
12. `generation_schema`: uint `1`
13. `generation_bytes_sha256`: SHA-256
14. `generation_identity`: SHA-256
15. `attempt`: uint
16. `request_identity`: SHA-256
17. `request_payload_digest`: SHA-256
18. `expected_producers`: sorted set of closed producer identities
19. `source_observation_identity`: SHA-256
20. `predecessor_comment_id`: uint or explicit null
21. `predecessor_record_digest`: SHA-256 or explicit null
22. `workflow_path`: closed protected workflow path
23. `workflow_run_id`: uint
24. `workflow_run_attempt`: uint
25. `protected_dev_sha`: commit
26. `recorded_at`: timestamp

The generation identity is independently recomputed from ADR-0004's complete trusted input. The
request identity binds the repository, issue, pull request, exact head, generation, attempt,
request-payload digest, expected-producer set, and predecessor. The request-payload digest is
domain-separated and contains only normalized identifiers, the optional recovery-target identity,
and a closed reason code. A raw reason, issue body, provider payload, endpoint, credential, customer
content, or private-source content is never stored.

### Producer result v1

Marker:

`<!-- keiko-native-lifecycle-producer-result:v1 -->`

Fixed fields, in order:

1. `record_type`: enum `producer-result`
2. `schema_version`: uint `1`
3. `digest_algorithm`: enum `sha-256`
4. `digest_domain`: enum `keiko-native.lifecycle-record.producer-result`
5. `repository`: string
6. `issue_number`: uint
7. `pull_request_number`: uint or explicit null
8. `exact_head_sha`: commit or explicit null
9. `exact_target`: string or explicit null
10. `generation_identity`: SHA-256
11. `attempt`: uint
12. `request_identity`: SHA-256
13. `generation_request_comment_id`: uint
14. `generation_request_digest`: SHA-256
15. `phase_fence_comment_id`: uint
16. `phase_fence_digest`: SHA-256
17. `expected_producer`: closed producer identity
18. `producer_contract_version`: uint
19. `workflow_path`: closed protected workflow path
20. `workflow_id`: uint
21. `workflow_run_id`: uint
22. `workflow_run_attempt`: uint
23. `workflow_job_id`: uint
24. `result_identity`: SHA-256
25. `protected_dev_sha`: commit
26. `provider_observation_identity`: SHA-256
27. `conclusion`: enum `success`, `failure`, `cancelled`, `timed-out`, or `unavailable`
28. `reason_code`: closed redacted enum
29. `predecessor_comment_id`: uint
30. `predecessor_record_digest`: SHA-256
31. `recorded_at`: timestamp

The protected producer independently reloads complete provider state, rebuilds the canonical
generation bytes, and requires exact equality with the request and current fence. It evaluates only
its named contract. It may report success or a closed failure class; it cannot select lifecycle
lane, requested target, activation state, transition, reconciliation, or merge authority.

### Phase/fence claim v1

Marker:

`<!-- keiko-native-lifecycle-phase-fence-claim:v1 -->`

Fixed fields, in order:

1. `record_type`: enum `phase-fence-claim`
2. `schema_version`: uint `1`
3. `digest_algorithm`: enum `sha-256`
4. `digest_domain`: enum `keiko-native.lifecycle-record.phase-fence-claim`
5. `repository`: string
6. `issue_number`: uint
7. `pull_request_number`: uint or explicit null
8. `exact_head_sha`: commit or explicit null
9. `generation_identity`: SHA-256
10. `attempt`: uint
11. `request_identity`: SHA-256
12. `phase`: enum `request`, `phase-one`, `mutation`, `phase-two`, `terminal`, or `recovery`
13. `fence_sequence`: uint
14. `fence_identity`: SHA-256
15. `owner_workflow_path`: closed protected coordinator path
16. `owner_run_id`: uint
17. `owner_run_attempt`: uint
18. `source_observation_identity`: SHA-256
19. `claim_outcome`: enum `claimed`, `settled`, `abandoned`, `ambiguous`, or `superseded`
20. `recovery_scan_identity`: SHA-256 or explicit null
21. `recovery_scanned_page_count`: uint
22. `recovery_scanned_comment_count`: uint
23. `recovery_accumulated_suffix_identity`: SHA-256 or explicit null
24. `recovery_provider_cursor`: string or explicit null
25. `recovery_scan_complete`: bool
26. `recovery_settlement_identity`: SHA-256 or explicit null
27. `predecessor_comment_id`: uint or explicit null
28. `predecessor_record_digest`: SHA-256 or explicit null
29. `protected_dev_sha`: commit
30. `recorded_at`: timestamp

An incomplete `recovery` scan uses a non-null recovery-scan identity, positive page and comment
counts, its non-null accumulated-suffix identity, a non-null cursor, `false`, and a null settlement
identity. Its final scan claim preserves the cumulative positive counts and accumulator, uses an
explicit null cursor, sets completion to `true`, and keeps the settlement identity null. A forward
orphan settlement instead uses null, zero, zero, null, null, `false`, and a non-null
`recovery_settlement_identity`. Every non-recovery claim uses null, zero, zero, null, null, `false`,
and null. A cursor is accepted only after Issue #55's live probe proves GitHub's backward GraphQL
timeline cursor preserves the exact stable page boundary under the held per-issue group. It is an
opaque provider locator, never authority.

For each issue, the unique serialization domain is exactly
`issue-lifecycle-${decimal issue number}` with `queue: max` and no `cancel-in-progress` key. Every
writer and every lifecycle effect uses that group. GitHub therefore runs one member and retains up
to 100 pending members in FIFO order by the time each member started waiting, rather than by
workflow dispatch time. This is the behavior documented by the GitHub Actions workflow syntax
concurrency reference below, retrieved 2026-07-28;
`queue: max` cannot be combined with `cancel-in-progress: true`. A pull request, head, readiness
identity, request identity, lane, workflow path, or record type can never partition the group. A
queue-full cancellation is visible in provider queue state and the generation request's missing
expected result, makes that generation abandoned, and requires explicit recovery; it is never
silently redispatched. A cancelled duplicate wake-up carries no authority and scheduled
reconciliation reloads current state. Waiting start and dispatch order are provider scheduling
facts, not authority: the canonical fence is the sole latest valid claim in the complete record
chain for one generation and attempt. Its identity binds the generation, attempt, phase, sequence,
owning run/attempt, predecessor comment/digest, and current provider observation.

### Transition/read-back v1

Marker:

`<!-- keiko-native-lifecycle-transition-read-back:v1 -->`

Fixed fields, in order:

1. `record_type`: enum `transition-read-back`
2. `schema_version`: uint `1`
3. `digest_algorithm`: enum `sha-256`
4. `digest_domain`: enum `keiko-native.lifecycle-record.transition-read-back`
5. `repository`: string
6. `issue_number`: uint
7. `pull_request_number`: uint or explicit null
8. `exact_head_sha`: commit or explicit null
9. `exact_target`: string or explicit null
10. `generation_identity`: SHA-256
11. `attempt`: uint
12. `request_identity`: SHA-256
13. `phase_fence_comment_id`: uint
14. `phase_fence_digest`: SHA-256
15. `source_state`: lifecycle-observation enum
16. `desired_state`: lifecycle-observation enum
17. `observed_state`: lifecycle-observation enum
18. `transition_owner`: enum `request`, `assignment`, `pull-request`, `handoff`, `closure`,
    `reopen`, `invalidation`, or `recovery`
19. `effect_identity`: SHA-256 or explicit null
20. `read_back_identity`: SHA-256
21. `producer_results`: sorted set of exact `producer-result-reference` members
22. `checkpoint_sequence`: uint
23. `prior_checkpoint_comment_id`: uint or explicit null
24. `prior_checkpoint_record_digest`: SHA-256 or explicit null
25. `compacted_prefix_identity`: SHA-256
26. `outcome`: enum `planned`, `no-op`, `applied`, `denied`, `failed`, `abandoned`,
    `ambiguous`, or `superseded`
27. `reason_code`: closed redacted enum
28. `predecessor_comment_id`: uint
29. `predecessor_record_digest`: SHA-256
30. `protected_dev_sha`: commit
31. `recorded_at`: timestamp

Before activation, `effect_identity` is explicit null, `outcome` is never `applied`, and the
observation proves zero lifecycle/status/branch/merge effect. After activation, success requires
the exact desired state, provider read-back identity, phase fence, same-generation fresh producers,
and stable provider reread. A label or green status without this complete record grants nothing.

Every transition/read-back is also the next per-issue checkpoint. Its compacted-prefix identity
binds the prior checkpoint identity plus the ordered comment-ID/record-digest identities from that
checkpoint through this record's predecessor. After immediate comment read-back, the new checkpoint
identity binds that compacted prefix and this transition's provider-assigned comment ID and record
digest. Checkpoint sequence starts at one and increments exactly once. A checkpoint summarizes
already authenticated canonical evidence; it cannot change an outcome or make missing suffix
evidence valid.

### Record authentication and chain reconstruction

Authorship is necessary but insufficient. A record is trusted only when all these independently
loaded facts match:

- comment author login `github-actions[bot]`, numeric user ID `41898282`, and type `Bot`;
- `performed_via_github_app.id` equals GitHub Actions App ID `15368`;
- the referenced workflow, run, attempt, job, and result exist and equal the record;
- the workflow path is the expected repository-owned protected producer or coordinator path;
- the workflow ref is exactly `refs/heads/dev`;
- the loaded workflow commit equals the record's `protected_dev_sha` and is reachable from
  protected `dev`; and
- a post-publication GitHub artifact attestation over the exact artifact-anchor identity binds the
  provider-assigned comment ID, exact comment-body digest, record digest, repository, protected
  workflow, workflow ref, protected commit, run, and attempt claimed by the record; and
- repository, issue, pull request, head, target, generation, request, predecessor, and fence
  identities independently match current canonical inputs.

Login, marker, author association, check name, details URL, event timing, or a copied comment cannot
authenticate a record alone. A missing `performed_via_github_app`, wrong App, wrong workflow/ref,
deleted run, missing or invalid attestation, changed identity, unavailable metadata, or
contradictory reread fails closed.

The attestation and artifact anchor are provider evidence, not additional lifecycle record types.
The protected writer first publishes the canonical comment and immediately reads it back by the
provider-assigned comment ID. It requires the exact full body and computes
`comment_body_sha256` over those exact UTF-8 body bytes. Only then does it encode the
artifact-anchor schema above, upload those canonical bytes as the sole file in one immutable
artifact named exactly `keiko-lifecycle-anchor-v1-issue-{decimal-issue}`, and use GitHub's native
artifact-attestation capability with only `id-token: write`, `attestations: write`,
`contents: read`, and the writer's separately scoped comment permission. It attests a subject whose
name is exactly
`keiko-native/lifecycle-comment/v1/{repository}/{decimal-issue}/{decimal-comment-id}/{generation-identity}/{decimal-attempt}/{record-type}/{decimal-run-id}/{decimal-run-attempt}`
and whose digest is exactly `sha256:{artifact-anchor-identity}`. The writer performs a final
comment, artifact, attestation, run, and job reread and may expose the record to a later phase only
after that complete binding is stable. A crash before the post-publication anchor completes leaves
an unauthenticated comment and grants no authority. A raw OIDC token, signing certificate,
Sigstore bundle, credential, or provider response is never placed in the issue record.

The exact writer permission set is `actions: read`, `attestations: write`, `contents: read`,
`id-token: write`, and `issues: write`; every other permission is `none`. A producer that also owns
an existing check receives only that already-declared check permission in its separately fenced
check-publication job. The exact verified attestation claim set is `repository`,
`job_workflow_ref`, `ref`, `sha`, `run_id`, `run_attempt`, and `iss`. Claims map respectively to
the record's repository, protected workflow path, `refs/heads/dev`, `protected_dev_sha`,
`workflow_run_id`, `workflow_run_attempt`, and GitHub Actions OIDC issuer. Missing, additional
authority-bearing, or mismatched claim values reject the attestation.

Verification downloads the anchor artifact, requires one exact canonical file and matching
artifact digest, recomputes its artifact-anchor identity, and matches its comment ID,
`comment_body_sha256`, record digest, workflow run, and protected head to independently loaded
comment and run facts. It downloads the attestation bundle by the artifact-anchor identity,
cryptographically verifies GitHub's trusted root and OIDC issuer, and requires the certificate and
SLSA provenance claims to name the exact repository, protected workflow path, `refs/heads/dev`,
`protected_dev_sha`, workflow run, and attempt in the record. The attestation subject name and
digest must match exactly, including the provider-assigned comment ID, and there must be one
matching verified bundle. This binds the shared Actions App comment to the particular protected run
without adding an account, App, PAT, machine user, broker, database, or hosted Keiko service.
Attestation and anchor creation and verification are GitHub-provider operations; repository code
must use full-SHA-pinned GitHub-maintained transports and may not add an npm or runtime dependency.

The effect-capable loader first reads issue comments newest-first through the GitHub GraphQL
timeline, 100 comments per page and at most two pages, until it finds the latest authenticated
checkpoint or an authenticated incomplete recovery scan. It lists repository artifacts with the
exact per-issue anchor name, newest-first, and reads only anchors newer than that checkpoint or
recovery cursor. There may be at most 15 non-checkpoint record anchors after one checkpoint; the
next record must be a transition/read-back checkpoint. A relevant anchor without its exact comment
proves an unreferenced suffix deletion. A relevant Actions-bot record comment without its exact
post-publication anchor proves an interrupted or forged publication. One run with two anchors, two
comments for one anchor, an expired/deleted anchor in the live suffix, or any
comment-body/anchor/run/attestation disagreement is ambiguous and fails closed.

The latest authenticated checkpoint replaces its compacted prefix for operational authorization;
older comments remain audit evidence but are no longer live inputs. The loader directly verifies
that checkpoint's comment, artifact, attestation, writer run, checkpoint identity, and compacted
prefix, then verifies every live suffix member. It rejects a malformed page, duplicate comment or
artifact ID, unstable page boundary, missing record body, edited canonical record, digest mismatch,
unknown marker/version, multiple records in one comment, missing predecessor, predecessor digest
mismatch, fork, cycle, gap, duplicate fence sequence, multiple terminal claims, conflicting
generation/attempt, or truncation. It repeats the complete checkpoint-and-suffix read and requires
exact equality before using the chain.

An empty-history bootstrap is distinct from truncated-history recovery. A complete bounded stable
double-read must prove zero relevant lifecycle record comments and zero exact-name anchor artifacts
for the issue. The coordinator may then append the first generation request with both predecessor
fields explicit null; for the first transition/read-back, checkpoint sequence starts at one and
both prior checkpoint fields are explicit null. Successful bootstrap continues through the same
producers, fences, stable read-backs, and activation guard as every later generation, so an issue
with no comments or artifacts does not remain effect-disabled merely because no checkpoint exists.

The sequence-one null-root compacted-prefix values are:

| Field                       | Exact value                                        |
| --------------------------- | -------------------------------------------------- |
| `digest_domain`             | `keiko-native.lifecycle-compacted-prefix-identity` |
| `schema_version`            | `1`                                                |
| `digest_algorithm`          | `sha-256`                                          |
| `repository`                | `current repository`                               |
| `issue_number`              | `current issue`                                    |
| `checkpoint_sequence`       | `1`                                                |
| `prior_checkpoint_identity` | `null`                                             |
| `members`                   | `ordered authenticated genesis suffix`             |

The members list starts at the unique authenticated null-predecessor record and ends at the
transition/read-back predecessor. It uses the exact nested `checkpoint-member` schema and preserves
predecessor order. The domain, schema, algorithm, repository, issue, sequence, null root, and
complete members list form the exact canonical compacted-prefix preimage; no implicit empty digest,
sentinel string, omitted field, or prior checkpoint default is permitted.

A crash before the first checkpoint has three closed outcomes. If it occurred before any record
publication, the empty-history bootstrap rule applies. If all published records are authenticated,
the loader reconstructs the bounded authenticated genesis suffix from its unique null-predecessor
generation request and the next serialized run resumes or settles that generation. If publication
was interrupted, or any comment, anchor, attestation, predecessor, or provider fact is missing or
ambiguous, the workflow performs no effect and requires explicit authorized recovery; it never
reclassifies partial history as empty.

The forward orphan-settlement record is exactly:

| Field                                  | Required value                                  |
| -------------------------------------- | ----------------------------------------------- |
| `request_kind`                         | `recovery-request`                              |
| `phase`                                | `recovery`                                      |
| `claim_outcome`                        | `settled`                                       |
| `recovery_scan_identity`               | `null`                                          |
| `recovery_scanned_page_count`          | `0`                                             |
| `recovery_scanned_comment_count`       | `0`                                             |
| `recovery_accumulated_suffix_identity` | `null`                                          |
| `recovery_provider_cursor`             | `null`                                          |
| `recovery_scan_complete`               | `false`                                         |
| `recovery_settlement_identity`         | `sha-256 of exact recovery-settlement preimage` |
| `predecessor`                          | `last authenticated record or null root`        |
| `orphan_authority`                     | `quarantined-only`                              |

The orphan body is never trusted as a record or predecessor. An explicit authorized recovery
request binds the exact recovery-target identity: orphan comment ID, body digest, parsed record
digest, and last authenticated predecessor. Under the per-issue fence, two complete stable reads
must independently verify the unchanged canonical orphan body and digest; built-in bot user, ID,
type, and Actions App; claimed protected writer path, `refs/heads/dev`, protected commit, run, and
attempt; a terminal `failure`, `cancelled`, or `timed-out` run conclusion; and zero matching anchors
and attestations. Orphan body fields are candidate locators only and grant nothing until every
provider fact is independently loaded.

The coordinator then appends one normally authenticated phase/fence claim with the exact settlement
matrix above and the last authenticated record as predecessor, or a null predecessor when none
exists. Its domain-separated recovery-settlement identity binds the authorized request,
recovery-target identity, all exact verified orphan/provider facts, the last authenticated
predecessor, and reason `anchor-publication-interrupted`. Once that settlement's own
comment/anchor/attestation tuple is stably authenticated, chain reconstruction quarantines only the
exact orphan ID/body pair as a non-member and may continue from the settlement. A changed body,
different or missing provider fact, non-terminal or successful run, existing anchor or attestation,
authorization mismatch, second orphan, unstable reread, or settlement-publication failure remains
blocked and effect-disabled; it cannot be settled by inference.

If two comment pages do not reach the checkpoint, the workflow performs no lifecycle or status
effect and enters recovery mode only when the stable reads prove that relevant non-empty history
continues beyond those pages. A recovery-phase claim records the provider's backward cursor, exact
counts, accumulated-suffix identity, and recovery-scan identity. Every scanned timeline comment,
including an irrelevant comment, contributes one `recovery-suffix-member`; members retain the exact
stable GraphQL edge order returned for that backward page. Provider order is evidence of complete
pagination, never lifecycle or predecessor authority. Recovery starts its accumulator at the first
of the two normal-load pages and computes exactly one accumulator step per stably double-read page.
The `checkpoint_sequence` is `0` on every incomplete step. On the complete step it remains `0` for
the unique genesis root or becomes the exact sequence from the authenticated checkpoint that ended
the scan. The recovery-scan identity uses that same value. The fresh transition/read-back
checkpoint is sequence `1` after genesis or the authenticated prior checkpoint's sequence plus one.

The recovery suffix accumulator update is exactly:

| Field                               | Root step                    | Resumed step                                        |
| ----------------------------------- | ---------------------------- | --------------------------------------------------- |
| `checkpoint_sequence`               | `0`                          | `0 until root; then exact checkpoint sequence or 0` |
| `accumulator_step`                  | `1`                          | `prior step + 1`                                    |
| `prior_accumulated_suffix_identity` | `null`                       | `exact prior digest`                                |
| `page_members`                      | `stable provider edge order` | `stable provider edge order`                        |
| `cumulative_member_count`           | `page member count`          | `prior count + page member count`                   |
| `next_provider_cursor`              | `exact non-null cursor`      | `exact cursor; null iff root found`                 |
| `complete`                          | `false`                      | `false until root found; then true`                 |

A resumed recovery run first authenticates the prior progress claim and its comment, artifact,
attestation, protected writer run, and predecessor. It recomputes that claim's recovery-scan
identity from the stored page count, comment count, accumulated-suffix digest, cursor, and
completion flag, then resumes at exactly that cursor. Two stable reads of the next page must agree
in edge order, comment IDs, exact body digests, classifications, authenticated record and anchor
identities, predecessor pairs, and next cursor before the workflow computes the next accumulator
step. A step, count, cursor, page boundary, classification, or order discontinuity; duplicate
comment, record, or anchor; relevant unauthenticated comment; or unmatched relevant anchor blocks
progress and emits no accumulator identity.

The next serialized recovery run scans at most 100 more pages and remains effect-disabled. Each
authenticated progress claim supersedes only the prior scan cursor and grants no authority. Its
`recovery_scanned_page_count` equals the accumulator's `accumulator_step`, and its
`recovery_scanned_comment_count` equals the accumulator's `cumulative_member_count`. A resumed
claim's page count equals the prior authenticated claim's page count plus the number of new
accumulator page steps, and its first new step is exactly the prior page count plus one. A provider
cursor that becomes null before an authenticated checkpoint or unique genesis is found proves
truncation and emits no progress claim. When the prior checkpoint or the unique null-predecessor
genesis is found, the final recovery claim sets
`recovery_scan_complete` to true and the accumulator's `complete` to true, replays every
authenticated accumulator step and page, revalidates the compacted prefix or complete genesis
suffix in predecessor order, and emits a fresh transition/read-back checkpoint. If the #55 live
probe cannot prove stable backward-cursor continuation, cursor recovery remains unavailable and the
protocol cannot activate.

Every lifecycle workflow first holds its per-issue group and then acquires the additional
repository-wide job concurrency group `issue-lifecycle-provider-budget` with `queue: max` and no
`cancel-in-progress` key for all provider reads, record writes, read-backs, and effects. No
lifecycle job acquires those groups in the opposite order. This prevents lifecycle issues from
concurrently consuming the repository-wide `GITHUB_TOKEN` quota; it does not pretend unrelated
repository checks share that group.

One normal stable pass is budgeted at no more than two comment-page requests, one exact-name
artifact-list request, 16 artifact downloads, one bulk attestation-list request for at most 16
digests, 16 bundle downloads, 32 run/job requests, and 25 current-provider-state requests: 93
requests. The mandatory second pass is at most 186 requests, and write/read-back operations bring
the hard local request-counter ceiling to 200. Recovery mode has a separate 150-request ceiling and
cannot perform a lifecycle/status/branch/merge effect. Neither mode relies on a racy
`x-ratelimit-remaining` read for safety. Any core or secondary limit response, counter exhaustion,
pagination overflow, lower observed limit, or unavailable response yields
`provider-rate-limited` and no effect; a later scheduled run may resume only after the provider
allows it. The global group prevents lifecycle-on-lifecycle races, while unrelated workflow quota
use can reduce availability but cannot create authority or bypass stable rereads.

Protected workflows never edit or delete canonical records. GitHub comments are only logically
append-only, so deletion cannot be made impossible. A missing previously referenced comment, an
unmatched relevant writer run proving suffix loss, rewritten body, or incomplete predecessor
sequence is therefore an ambiguous terminal condition, not absence and never permission to
restart. Recovery requires an explicit authorized settlement record referencing the last complete
chain and the missing/conflicting run or record identity.

GitHub assigns the current comment ID only after it accepts the comment body, so that ID cannot
appear inside its own canonical bytes. The immutable record identity is the provider-assigned
comment ID paired with the exact body digest in the post-publication attested artifact-anchor
identity. Every later record binds the comment ID and canonical record digest as its predecessor
and independently revalidates that post-publication binding. Failure to create and stably reread
the exact comment/anchor/attestation tuple prevents the workflow from using it or performing a
later effect.

### Serialization, fencing, and stable effects

Every dispatch, record write, label/status effect, and transition read-back occurs inside the one
per-issue `queue: max` concurrency group. A run releases the group only after its one record
obligation is read back or its lack of an effect is settled. Immediately before each effect, the
coordinator performs a stable complete double-read and requires:

- the issue/PR/head/target, readiness, lifecycle, claim, reviews, conversations, checks, evidence,
  provider inventory, generation inputs, record chain, and predecessor are unchanged;
- the current claim is the sole latest valid fence for its generation, attempt, phase, and owning
  workflow run;
- the protected workflow/run remains current and the fence has not been superseded; and
- every producer result is authenticated, same-generation, same-attempt, same-fence, exact-head,
  and from its expected producer.

After an effect, the coordinator reloads the same complete facts and verifies exact desired
read-back before writing the transition/read-back record. Lock loss, fence loss, unstable reads,
write failure, result mismatch, or provider unavailability prevents success.

The phases are:

1. `request`: reconstruct the record chain and append one generation request;
2. `phase-one`: claim its fence and start each prerequisite producer at most once;
3. `mutation`: after phase-one success, claim a new fence, reread, reconcile set-to-desired, and
   verify the provider read-back;
4. `phase-two`: claim a fresh fence, start every lifecycle-sensitive producer once, and attach only
   authenticated same-generation results;
5. `terminal`: publish success only after exact equality, otherwise publish a closed failed,
   abandoned, or ambiguous settlement; and
6. `recovery`: an authorized request creates the exact next attempt while binding the settled
   predecessor.

Duplicate wake-ups and duplicate identical results are no-ops. An authenticated input change
creates a new generation digest. An unchanged failed or abandoned generation is terminal and does
not retry automatically. A crash before any external effect may resume the same generation only
after stable reconstruction proves the exact current fence and that no effect occurred. A crash,
timeout, deletion, or unavailable response at or after a possibly accepted effect is ambiguous,
blocked, and never retried. Explicit recovery increments the attempt, uses a new request identity,
binds the settled predecessor, and revalidates all current authority. Responses classified as
403, 404, 409, 422, 429, timeout, malformed, unavailable, or partial never become success.

### Protected producer interface

Every protected producer accepts only these typed inputs:

- schema/version;
- repository and issue;
- pull request and exact head or explicit null;
- exact target or explicit null;
- canonical generation bytes and digest;
- attempt;
- fence comment ID and digest;
- generation request ID and digest;
- request identity and payload digest; and
- exact expected producer identity.

The producer independently reloads the provider, parses the canonical record chain, recomputes the
generation, and authenticates the current fence. It emits only a producer-result record. It does
not accept caller-selected lane, target state, activation, transition, producer conclusion, or
merge authority.

Producer workflows load code only from protected `dev`, use `persist-credentials: false`, and never
check out or execute pull-request content. Job-level permissions are least privilege. Comment
publication receives only `issues: write`; status/check publication receives only the specific
status permission owned by that producer; contents and pull requests remain read-only. No producer
has contents write, pull-request write, queue, ruleset, branch, bypass, or `dev` merge authority.

### Exact publication tree adapter

Publication evidence never treats the pull-request files API as complete tree authority. The
protected adapter starts from the exact candidate commit, loads its root tree, then obtains a
complete recursive Git-tree enumeration. It requires `truncated === false`, unique NFC repository
paths, and exact set equality with the candidate envelope. Each candidate entry must be type
`blob`, an allowed regular-file mode, and have the expected Git object ID and declared size.

For each entry, the adapter loads the exact blob, strictly decodes its base64 payload, verifies the
declared byte size and Git blob identity, computes SHA-256 over the exact bytes, and binds:

- exact commit SHA;
- root tree SHA;
- normalized path;
- regular-file mode;
- blob object ID;
- exact byte count;
- exact-byte SHA-256; and
- complete candidate-set identity.

It then repeats the commit/tree/blob reads and requires exact equality. A truncated tree, missing,
extra, duplicate, renamed, copied, symlink, submodule, tree entry, invalid mode, malformed base64,
wrong size/object/digest, changed commit/tree/blob, unavailable API, stale candidate envelope, or
PR-files-only observation fails closed. Issue #54 may supply this evidence only if its exact
candidate envelope implements this adapter; otherwise #54 must be semantically revised after this
ADR is accepted.

### All nine lifecycle states and complete edge policy

The record protocol preserves exactly:

`status: new`, `status: triaged`, `status: ready`, `status: in progress`,
`status: pr open`, `status: ready for human review`, `status: blocked`,
`status: waiting for user`, and `status: done`.

The allowed directed edges are exactly ADR-0004 and `docs/qa/issue-lifecycle.md`:

- new -> triaged, blocked, waiting for user;
- triaged -> ready, blocked, waiting for user, new;
- ready -> in progress, blocked, waiting for user, new;
- in progress -> ready, PR open, blocked, waiting for user, new;
- PR open -> ready, in progress, ready for human review, blocked, waiting for user, new;
- ready for human review -> PR open, in progress, blocked, waiting for user, new, done;
- blocked -> waiting for user, new, triaged, ready, in progress, PR open;
- waiting for user -> blocked, new, triaged, ready, in progress, PR open; and
- done -> new only through reopen.

A source equal to target is an idempotent no-op, not an edge. Every other ordered pair in the
nine-by-nine source/target complement is rejected. Semantic invalidation from any open state
overrides ordinary edges and enters new. The outside-lifecycle observation `no-lifecycle` is not a
tenth state and does not alter that nine-by-nine complement. Its only permitted paths are:

- issue creation: `no-lifecycle -> status: new`;
- reopen after non-completed closure: `no-lifecycle -> status: new`;
- non-completed closure: any of the eight open states -> `no-lifecycle`; and
- completed closure: `status: ready for human review -> status: done`, followed by issue closure
  whose read-back remains `status: done`.

Completed reopen is exactly `status: done -> status: new`; completed closure retains the done label
and never observes `no-lifecycle`. The provider observation is `no-lifecycle -> status: new` only
when non-completed closure removed all lifecycle labels. Every other source or target involving
`no-lifecycle` is rejected. `no-lifecycle` cannot be requested, applied as a label, treated as
executable, or used as a default for unavailable provider state.

Semantic invalidation from any open state overrides ordinary edges and enters new. Reopen alone
returns done or a non-completed closure to new. Final verified delivery alone permits ready for
human review to done. Label requests remain limited to planner new-to-triaged and triaged-to-ready
requests plus authorized blocked/waiting requests. Assignment alone owns entry to in progress, PR
topology alone owns PR open, the protected handoff alone owns ready for human review, and verified
completion alone owns done. Resume is explicitly derived and never restores ready for human
review.

Every permitted edge and the complete rejected complement must produce a sanitized planned, no-op,
applied, denied, failed, or recovery record after activation. Before activation, only non-applied
observations are permitted.

## Failure and recovery

There is no last-write-wins behavior. A missing, malformed, stale, replayed, forged, edited,
deleted, duplicated, conflicting, truncated, wrong-producer, wrong-generation, wrong-fence, or
unavailable record blocks the affected generation. Stable rereads and set-to-desired reconciliation
can converge only while the original authority and current fence remain valid.

If a provider response makes mutation outcome ambiguous, the coordinator records ambiguity when it
can do so safely, invalidates technical eligibility, and never retries the effect. Authorized human
reconciliation must reload exact provider state and append a settlement bound to the prior request,
generation, attempt, fence, effect identity, and observed outcome before a new attempt is possible.
Recovery moves forward; it never edits or deletes a record, guesses an outcome, restores stale
review evidence, or weakens the sacred `dev` boundary.

## Governance and rollout

This ADR is inert documentation. It creates no workflow, token permission, lifecycle transition,
status, branch, check, merge, or repository setting.

After an authorized maintainer manually merges this ADR to `dev`:

1. Epic #49 increments to v8, returns to `status: new`, cites ADR-0011, and receives fresh
   readiness.
2. Issue #51 increments to v5, returns to `status: new`, implements this protocol while activation
   stays disabled, and receives fresh readiness.
3. Issue #55 increments its contract, returns to `status: new`, binds activation and live proof to
   this protocol, and receives fresh readiness.
4. Issue #52 remains unchanged.
5. Issue #54 changes only if its publication candidate envelope does not already implement the
   exact commit/tree/blob/mode adapter.

Existing issue #51 work may be salvaged only line-by-line where it conforms to this ADR and the
refreshed contract. Full verification and independent audit must run again on the final exact head.
Issue #55 alone owns activation and live disposable-metadata proof. No implementation may introduce
a new account, installed GitHub App, PAT, machine user, broker, database, hosted service, second
credential, application/runtime dependency, private-source access, or automated `dev` effect. A
GitHub-maintained attestation transport is provider composition, must be pinned to a full commit
SHA under the refreshed #51 contract, and receives only the permissions declared above.

## Consequences

The selected design reuses the same built-in Actions identity as the repository's existing PR
checkers. There is no new account or installation step. Records are visible, append-only by policy,
and recoverable across workflow runs. GitHub-native attestations bind each surviving record to its
exact protected writer run, while exact-name per-issue artifact anchors detect an unreferenced
suffix deletion.
Attested checkpoints bound live reconstruction, effect-disabled cursor recovery advances deep
history, and the repository-wide provider-budget group prevents lifecycle quota races. Strict
producer/run/ref authentication, bounded queued serialization, complete pagination, fencing, and
stable rereads compensate for the lack of transactional comment storage.

The trade-off is comment growth and a more demanding parser. Pagination and record sizes are
bounded. The protocol deliberately fails closed when a comment is deleted or provider ordering
cannot be reconstructed; it does not claim GitHub comments are immutable or transactional.
GitHub's built-in Actions App is an existing provider identity, not a new installed Keiko App.

ADR-0009 continues to govern the separate guarded child-to-epic merge effect and its shared
maintainer credential. ADR-0011's lifecycle fences do not resurrect ADR-0004's superseded broker,
dedicated effect identity, or dual-ref merge semantics. `dev` remains human-only.

## Verification obligations

Issue #51 must add hermetic fixtures for all four record types, exact bytes and digests, full-body
parsing, every size/type/null/order constraint, domain separation, constant-time comparison,
bot/App/workflow/ref/run authentication, post-publication artifact-anchor attestation verification,
exact per-issue artifact anchors, checkpoint compaction, referenced and unreferenced-suffix
deletion, the 15-record live-suffix bound, normal and cursor-resumed pagination boundaries, exact
request-budget accounting, stable double-reads, edit, fork, cycle, gap, truncation,
duplicate/conflict, fencing, `queue: max` saturation and FIFO-by-wait-start behavior, empty-history
bootstrap, every pre-checkpoint crash outcome, replay, explicit recovery, and every provider failure
class.

Producer tests must prove independent generation recomputation, same-generation/fence binding,
one start per producer, closed conclusions, least privilege, protected-`dev` loading, no pull-request
execution, and inability to choose lane, target, activation, transition, or merge authority.

Publication tests must prove exact commit/root-tree/entry/blob/mode/bytes equality and reject
PR-files authority, truncated trees, every non-regular mode/type, malformed base64, object/size
mismatch, changed rereads, and candidate-set drift.

Lifecycle tests must enumerate all nine states, every allowed edge, all self no-ops, the complete
rejected nine-by-nine complement, and every permitted and rejected `no-lifecycle` observation.
They must prove activation-disabled composition creates no lifecycle/status/branch/merge effect and
retains no raw reason, credential-shaped input, provider payload, endpoint, customer content, or
private-source content.

Issue #55 must run guarded-off and post-activation disposable GitHub probes that authenticate the
built-in bot/App/run identity and GitHub attestation, prove same-generation producer composition,
exercise exact-name immutable artifact anchors, checkpoint rollover, more-than-100-page cursor
recovery, rate-limit refusal, queue saturation, referenced deletion, suffix deletion, and ambiguity
recovery without retry, and bind every live observation to the signed activation commit. Failure
leaves the lifecycle unavailable or probe-only and never widens merge authority.

## Residual risks and uncertainty

An actor with repository administration authority may delete GitHub comments, workflow runs, or
attestations. This protocol detects a referenced deletion and a comment-only suffix deletion while
the immutable artifact anchor remains, but it cannot restore a deleted provider object.
Administrative deletion of both the suffix and every independent provider anchor is outside the
Actions identity's defensive power. Repository administration remains human-controlled; any
missing or unavailable live anchor that is observable yields blocked explicit recovery, not silent
reconstruction.

GitHub may change comment attribution, workflow metadata, pagination, or App identity fields. Any
change that prevents exact authentication or stable reread disables the protocol until a later
accepted decision and implementation update.

The comment chain is not a general database or event bus. It is limited to bounded body-free
governance evidence for one lifecycle issue. Product data, source, diagnostics, and arbitrary
workflow payloads remain prohibited.

## Reopen triggers

Reopen this decision if GitHub removes or materially changes the required bot/App/run/ref,
comment-body, pagination, recursive-tree, blob, or workflow metadata; the record chain cannot detect
deletion or conflict; stable rereads cannot fence effects; a fifth durable record type is required;
SHA-256 or the canonical grammar must change; an added identity or service becomes necessary; or
the lifecycle, activation, producer ownership, publication adapter, or sacred-`dev` boundary must
change.

## References

| Source                | Reference                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Decision contract     | [Issue #129](https://github.com/oscharko-dev/Keiko-Native/issues/129)                                                                     |
| Lifecycle authority   | [ADR-0004](ADR-0004-readiness-authority-and-workflow-lifecycle.md)                                                                        |
| Repository contracts  | [ADR-0003](ADR-0003-repository-backed-planning-contracts.md)                                                                              |
| Guarded epic delivery | [ADR-0009](ADR-0009-agent-scoped-maintainer-credential-epic-merge.md)                                                                     |
| Staged activation     | [ADR-0010](ADR-0010-stage-guarded-epic-merge-proof-at-activation.md)                                                                      |
| Canonical lifecycle   | [Issue lifecycle](../qa/issue-lifecycle.md)                                                                                               |
| Quality-gate policy   | [Quality gates](../qa/quality-gates.md)                                                                                                   |
| Activation runbook    | [Repository activation](../qa/repository-activation.md)                                                                                   |
| GitHub concurrency    | [Workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) |
| GitHub attestations   | [Artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)                                       |
| GitHub artifacts      | [Actions artifacts API](https://docs.github.com/en/rest/actions/artifacts)                                                                |
| GitHub token limits   | [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)                                   |
