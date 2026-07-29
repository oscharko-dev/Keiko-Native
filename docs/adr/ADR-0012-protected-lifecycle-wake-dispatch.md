# ADR-0012: Protected lifecycle wake-up without Actions write

## Status

Proposed, 2026-07-29. Decision issue #131 v5 selected this outcome. The record becomes accepted
only when an authorized maintainer manually merges its pull request to `dev`.

This record narrowly amends ADR-0011's coordinator authentication and serialization topology. It
does not change ADR-0011's version-1 record or auxiliary schemas, producer identities, coordinator
ownership, lifecycle state graph, activation boundary, or the human-only `dev` merge rule.

## Context

ADR-0011 names `.github/workflows/issue-lifecycle.yml` as the sole coordinator and requires every
coordinator record to authenticate a protected workflow, run, job, ref, commit, artifact anchor,
and attestation. It also requires the exact per-issue concurrency group to enclose every lifecycle
record and effect before the repository provider-budget group is acquired.

Issue #51 tested a direct reusable-workflow call against repository run `30393476770`. GitHub
retains the top-level caller as the run's primary workflow, ref, and SHA. The called workflow is
separately visible through referenced-workflow metadata and the reusable job's OIDC
`job_workflow_ref` and `job_workflow_sha` claims. Treating the called workflow as though it owned a
separate top-level run would make ADR-0011 verification false.

Decision issue #131 v2 next evaluated a protected router with only `actions: write` and a fixed
workflow-dispatch target. Independent audit rejected that option. GitHub's Actions-write
permission is not dispatch-only: the same repository permission also reaches workflow-run
cancellation and rerun, workflow enablement and disablement, and deletion of workflow runs, logs,
and artifacts. That capability could damage the run and artifact evidence ADR-0011 relies on.

The remaining GitHub-native topology is a protected top-level caller whose per-issue job invokes
the sole coordinator as a reusable workflow. This needs no workflow dispatch and no Actions-write
permission. It requires authentication to prove the fixed caller and the exact called writer as
one protected run chain.

## Decision

Adopt one top-level protected caller at `.github/workflows/lifecycle-wakeup.yml` and one reusable
coordinator at `./.github/workflows/issue-lifecycle.yml`.

The caller has two job roles:

1. a read-only resolver derives a canonical issue locator or a bounded scheduled set of locators;
   and
2. one `coordinate` job per resolved issue acquires the exact per-issue concurrency group and calls
   the reusable coordinator for the full duration of that group.

Only the reusable coordinator evaluates lifecycle authority, reconstructs ADR-0011 records, selects
a lane or desired state, authenticates producers, publishes records, or performs an enabled
effect. A resolver result is an untrusted scheduling locator. It is never readiness, evidence,
request authority, lifecycle authority, or merge authority.

### Protected caller and source closure

The caller workflow file exists on the repository default branch and is accepted only when the run
API and OIDC claims prove:

- repository `oscharko-dev/Keiko-Native`;
- caller `.github/workflows/lifecycle-wakeup.yml`;
- ref `refs/heads/dev`;
- caller `workflow_sha` and event `sha` equal one protected `dev` commit; and
- the commit is reachable from the current protected `dev` history.

The REST run `head_sha` is event correlation, not workflow-code identity. For
`pull_request_target`, GitHub reports the pull-request head there even though the caller workflow
is loaded from the protected base. The resolver may compare that value with the event or pull
request it is locating, but authentication never requires it to equal `protected_dev_sha`.

The caller's direct event allowlist is:

| Event                           | Closed activity set                                                                               | Locator source                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `issues`                        | `assigned`, `closed`, `edited`, `labeled`, `reopened`, `unassigned`, `unlabeled`                  | canonical event issue number                                  |
| `pull_request_target`           | `opened`, `edited`, `reopened`, `synchronize`, `ready_for_review`, `converted_to_draft`, `closed` | canonical event pull request followed by a stable read        |
| `issue_comment` (plain issue)   | `created`, `edited`, `deleted`                                                                    | canonical event issue number                                  |
| `issue_comment` (pull request)  | `created`, `edited`, `deleted`                                                                    | canonical event pull request followed by a stable read        |
| `check_run` (external provider) | `completed`, `rerequested`                                                                        | exactly one associated pull request followed by a stable read |
| `workflow_run`                  | `completed`                                                                                       | one closed source run and its exact locator facts             |
| `schedule`                      | hourly at minute 17                                                                               | bounded stable enumeration of open issue locators             |

GitHub sets `GITHUB_REF` and `GITHUB_SHA` for `pull_request_review` and
`pull_request_review_comment` to the pull-request merge ref and merge commit. Those events
therefore cannot call the authenticated coordinator directly. They intentionally have no event
source; the protected hourly scan is their normal reconciliation path.

`workflow_run` has two closed source classes:

| Source class | Source path                                  | Exact display name             | Accepted source event |
| ------------ | -------------------------------------------- | ------------------------------ | --------------------- |
| governance   | `.github/workflows/issue-readiness.yml`      | `Issue readiness`              | `issues`              |
| governance   | `.github/workflows/pr-contract.yml`          | `Pull request contract`        | `pull_request_target` |
| governance   | `.github/workflows/contract-publication.yml` | `Contract publication (inert)` | `workflow_dispatch`   |
| evidence     | `.github/workflows/ci.yml`                   | `CI`                           | `pull_request`        |
| evidence     | `.github/workflows/codeql.yml`               | `CodeQL`                       | `pull_request`        |
| evidence     | `.github/workflows/dependency-review.yml`    | `Dependency Review`            | `pull_request`        |
| evidence     | `.github/workflows/osv-scanner.yml`          | `OSV dependency scan`          | `pull_request`        |

The trigger's workflow display-name list is only a coarse provider filter. Every completion
resolver reloads the source run and requires the exact repository, closed path/name pair, expected
event, run ID, run attempt, and completed conclusion. A governance source additionally requires
its locator-declared `workflow_sha` to identify protected `dev` history. An evidence source and its
associated pull request are untrusted locators; neither its workflow commit nor conclusion grants
authority. In both classes, `head_sha` remains event correlation. A renamed or additional source
path requires a later semantic contract revision.

The three governance sources publish one bounded locator artifact because a `workflow_run` payload
does not always carry an issue or pull request.

GitHub suppresses a `check_run` workflow trigger for checks created by GitHub Actions or associated
with an Actions head SHA. The four closed Actions evidence workflows therefore enter through
`workflow_run` and exactly one associated pull request. The direct `check_run` path is only for
external check providers. Zero or multiple associations fail closed; the hourly reconciliation
supplies liveness after a missing association or source completion.

The hourly run is the normal reconciliation path for review and conversation changes and recovery
for missed provider notifications; it is not a policy source. It performs a complete stable
paginated read of open issues and pull requests, maps pull requests only through their
accepted-issue locator, and never filters on readiness, lifecycle, checks, evidence, or activation.
It sorts and deduplicates canonical issue numbers and fails the whole enumeration on malformed
data, unstable pages, duplicate identities, a third page, more than 200 unique locators, or more
than eight provider requests. A partial scan never presents itself as complete. Each resulting
issue enters an independent coordinate job and the same normal authentication path.

The cron is a nominal cadence, not a one-hour liveness guarantee. GitHub may delay a scheduled run
and may drop a queued run under sufficient provider load. A delayed or dropped run creates no
success evidence and performs no effect. Review and conversation liveness resumes only on a later
successful protected scan or another allowed event, so the provider latency has no finite upper
bound in this design.

The caller exposes no `workflow_dispatch`, `repository_dispatch`, generic webhook,
caller-selected workflow, or caller-selected ref, and it never emits either dispatch event. The
existing contract-publication source may still be started only under its separately accepted
contract.

### Locator schema and resolver boundary

A direct-event resolver emits only:

- schema version;
- repository;
- canonical decimal issue number;
- pull request number or explicit null;
- source event kind;
- source run ID and attempt or explicit null; and
- the resolver's protected caller SHA.

The protected source-workflow locator uses domain
`keiko-native.lifecycle-wake-locator`, schema version `1`, digest algorithm `sha-256`, and the
following fixed ADR-0004 canonical fields in order:

1. `repository:string`;
2. `issue_number:uint`;
3. `pull_request_number:uint-or-null`;
4. `source_workflow_path:closed-source-path`;
5. `source_run_id:uint`;
6. `source_run_attempt:uint`;
7. `source_protected_dev_sha:commit`.

The canonical bytes are the sole file in one immutable source-run artifact named exactly
`keiko-lifecycle-wake-locator-v1`. The file, artifact, source run, and source attempt are read
twice and must remain identical. The resolver rejects a missing, extra, repeated, malformed,
oversized, non-canonical, wrong-run, wrong-path, wrong-ref, wrong-SHA, or unstable locator. The
artifact contains no issue body, pull-request body, comment, reason, credential, provider payload,
requested state, lane, readiness result, producer result, activation value, or merge value.

This locator artifact is deliberately not attested and is not an ADR-0011 record. It only selects
a concurrency key. Compromise or staleness can cause one bounded coordinator call for a canonical
issue. That call may perform a real transition only when the locked coordinator's independent
reload authorizes it; no locator field contributes authority to that decision.

The caller splits resolution into exact event-class jobs so unused reads are not inherited:

| Resolver job          | Accepted events                                                           | Exact non-`none` permissions                             | Provider request ceiling |
| --------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------ |
| issue                 | `issues`; plain-issue `issue_comment`                                     | `contents: read`                                         | 0                        |
| pull request          | `pull_request_target`; pull-request `issue_comment`; external `check_run` | `contents: read`, `pull-requests: read`                  | 2                        |
| governance completion | `workflow_run` for a governance source                                    | `actions: read`, `contents: read`                        | 6                        |
| evidence completion   | `workflow_run` for an evidence source                                     | `actions: read`, `contents: read`, `pull-requests: read` | 4                        |
| schedule              | `schedule`                                                                | `contents: read`, `issues: read`, `pull-requests: read`  | 8                        |

Every write permission is `none`. An event selects exactly one resolver job; every other resolver
job is skipped. Each job checks out only the exact caller workflow SHA with
`persist-credentials: false`.

Repository permissions alone do not deny runner-artifact upload: GitHub's artifact transport uses
the runner artifact service rather than `actions: write`. The resolver boundary is therefore also
structural. Its only steps are the exact full-SHA-pinned checkout, full-SHA-pinned Node setup, and
one exact repository-owned resolver command. Contract tests reject `upload-artifact`, an artifact
client, another action, another command, or another step. The resolver command starts only after
`ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RUNTIME_URL`, and `ACTIONS_RESULTS_URL` are removed from its
environment. With those runtime credentials absent and its repository token read-only, the
resolver cannot publish a comment, label, status, check, artifact, attestation, ref, pull-request
mutation, dispatch, queue action, merge, or repository setting.

The exact resolver bounds are:

- every selected scalar locator string is at most 64 UTF-8 bytes;
- a pull-request body used only to extract the accepted-issue locator is at most 65,536 UTF-8
  bytes;
- one canonical locator is at most 512 bytes;
- one locator artifact archive is at most 65,536 downloaded bytes, contains exactly one regular
  file, and that file is at most 512 bytes;
- issue and pull-request enumeration uses `per_page=100`, at most two pages of each collection, and
  repeats the complete enumeration once for exact equality;
- the scheduled union contains at most 200 unique canonical issue numbers, sorted ascending, with
  no other matrix dimension;
- direct issue resolution makes zero provider requests, pull-request resolution at most two,
  governance-completion resolution at most six, evidence-completion resolution at most four, and
  scheduled resolution at most eight; and
- every collection, archive, response body, and request counter exceeding its limit rejects the
  complete resolver output.

The 200-item output cap is below GitHub's 256-job matrix maximum. A 201st unique locator, a third
page, a ninth scheduled provider request, or any partial enumeration fails closed and produces no
coordinate job. Contract tests cover each exact boundary and its first rejected complement.

Locator resolution occurs before the per-issue concurrency key is known and therefore outside the
authority lock. It may parse event metadata, read one locator artifact, map one pull request to its
accepted issue, or perform the bounded scheduled enumeration. It may not read readiness,
lifecycle records, desired state, reviews, conversations, checks, activation, or merge authority
to make a decision. Any staleness is resolved only by the complete read inside the lock.

### Per-issue caller lock and reusable coordinator

The resolver outputs only canonical positive safe decimal issue numbers. The caller creates one
job per unique number with:

```yaml
concurrency:
  group: issue-lifecycle-${{ matrix.issue_number }}
  queue: max
uses: ./.github/workflows/issue-lifecycle.yml
```

There is no `cancel-in-progress` key. GitHub acquires this job-level group before starting the
reusable call and holds it until every called job completes. The called workflow has only
`workflow_call`; it has no direct event, manual dispatch, workflow-level per-issue group, or path
by which another caller can bypass this job.

The calling job has no runner, checkout, action, shell, service, environment, secret, or sibling
workflow call. Its exact permission ceiling is:

- `actions: read`;
- `attestations: write`;
- `checks: read`;
- `contents: read`;
- `id-token: write`;
- `issues: write`;
- `pull-requests: read`; and
- `statuses: read`.

Every other permission is `none`. Reusable-workflow permission inheritance can only preserve or
reduce this ceiling. Inside the callee, read-only evaluation jobs receive only their declared read
permissions. A record-publication job retains ADR-0011's exact writer permissions:
`actions: read`, `attestations: write`, `contents: read`, `id-token: write`, and `issues: write`.

Every provider-intensive callee job acquires
`issue-lifecycle-provider-budget` with `queue: max` and no `cancel-in-progress` key. The fixed lock
order is therefore:

```text
caller coordinate job: issue-lifecycle-{issue}
  -> called coordinator provider job: issue-lifecycle-provider-budget
```

No job acquires the groups in the opposite order. Resolver reads do not enter the provider-budget
group because they cannot read lifecycle authority or perform a write. After entering both groups,
the coordinator performs ADR-0011's complete stable reload before any record obligation or effect.

This amends ADR-0011's serialization phrase “every dispatch” to “every reusable coordinator call.”
There is no dispatch in the selected design. Every coordinator record write, lifecycle effect, and
transition read-back remains inside the caller-held per-issue group. The read-only locator stage is
explicitly outside that authority boundary.

### Dual caller and callee authentication

For coordinator-authored ADR-0011 records, `workflow_path` and `owner_workflow_path` retain their
version-1 meaning: the exact writer is `.github/workflows/issue-lifecycle.yml`. The record's
`workflow_run_id` and `workflow_run_attempt` identify the top-level run that contains that reusable
writer job. The fixed caller path does not need a new record field.

Authentication of a coordinator record requires all of the following:

1. the provider run exists and names `.github/workflows/lifecycle-wakeup.yml` on
   `refs/heads/dev`;
2. its verified `workflow_sha` and event `sha` equal the record's `protected_dev_sha`, while its
   REST `head_sha` is checked only against the event correlation it represents;
3. its referenced-workflow inventory contains exactly the expected
   `.github/workflows/issue-lifecycle.yml` call at that same protected commit;
4. the called job exists in that run and is the record-producing job;
5. verified OIDC and attestation claims contain the exact repository, issuer, run ID, run attempt,
   `ref`, `sha`, `workflow_ref`, `workflow_sha`, `job_workflow_ref`, and
   `job_workflow_sha`;
6. `workflow_ref` and `workflow_sha` bind the fixed caller at protected `dev`;
7. `job_workflow_ref` and `job_workflow_sha` bind the exact reusable coordinator at the same
   protected commit; and
8. the comment, record digest, artifact anchor, subject name, run, attempt, caller, callee, commit,
   and attestation independently agree.

The artifact anchor's version-1 `workflow_path` remains the callee writer path. Its
`workflow_run_id`, `workflow_run_attempt`, and `protected_dev_sha` remain sufficient because the
caller path is one fixed authenticated constant and the callee path is already recorded. Producer
results written by `.github/workflows/pr-contract.yml` or
`.github/workflows/contract-publication.yml` retain ADR-0011's direct protected-workflow
authentication; the dual-chain rule applies only to coordinator-authored records.

A run that names only the caller, a claim that names only the callee, a different caller or callee,
an unlisted referenced workflow, a caller/callee SHA mismatch, a mutable ref, an absent job, a
deleted run or anchor, or any claim/body/provider disagreement rejects the record. Login, marker,
author association, workflow display name, event timing, or a copied locator never authenticates
it.

### Failure, duplicate, and recovery behavior

Duplicate and reordered wake-ups are expected and grant no authority. Runs for one issue contend on
the same caller-held group, reload current provider state, and become a no-op, superseded
observation, or new ADR-0011 generation. Resolver order and GitHub scheduling order never order the
record chain.

These conditions produce no lifecycle effect and no automatic retry:

- unsupported event or source workflow;
- zero, multiple, malformed, stale, or unstable locators;
- wrong repository, caller, callee, ref, run, attempt, or SHA;
- Actions-write or any undeclared permission;
- locator artifact or referenced-workflow disagreement;
- caller/callee OIDC or attestation mismatch;
- per-issue or provider-budget queue refusal or cancellation;
- delayed or dropped scheduled run;
- API 403, 404, 409, 422, 429, timeout, malformed response, or partial response; and
- lock loss, fence loss, run deletion, artifact deletion, or ambiguous effect.

A later independent provider event or successful nominally hourly reconciliation may observe
current state. It does not retry a possibly accepted effect. ADR-0011's explicit authenticated
forward recovery remains the only path after ambiguity.

### Inert rollout

Before issue #55's signed activation, the caller and reusable coordinator remain inert. They may
produce only the guarded-off sanitized observations expressly authorized by issue #51. They perform
no lifecycle, label, status, content, branch, pull-request, queue, merge, or repository-setting
effect.

Issue #51 must prove the exact source closure, zero Actions-write permission, locator rejection
matrix, caller-held lock duration, provider-budget lock order, dual caller/callee authentication,
and disposable guarded-off GitHub behavior. Issue #55 must repeat the live proof after activation
and cover all nine lifecycle states and the complete rejected-edge complement.

## Alternatives

### Workflow-dispatch router with Actions write

Rejected. Its fixed target was operationally simple, but `actions: write` also reaches destructive
run, log, artifact, and workflow operations. Repository code cannot narrow the provider token to
dispatch only, so the option contradicts least privilege and ADR-0011 evidence durability.

### Accept only the reusable callee identity

Rejected. The provider run remains owned by its top-level caller. Ignoring that caller would leave
the authenticated run chain incomplete and permit an unapproved protected workflow to host the
writer job.

### Resolve lifecycle authority before serialization

Rejected. Read-only locator resolution is safe because the locator grants nothing. Reading
readiness, records, desired state, reviews, checks, activation, or merge authority before the
per-issue group would create a race at the authority boundary.

### Add an App, machine user, PAT, broker, database, or hosted service

Rejected. It violates the operator-approved repository boundary and is unnecessary.

## Security and operational consequences

The protected caller's coordinate job carries the maximum permission envelope required by called
jobs, including `issues: write`, attestation, and OIDC access. It cannot execute a step of its own:
the job is structurally only one exact local reusable-workflow call, and repository contract tests
deny drift. The callee reduces permissions per job. Protected review and exact-head gates therefore
remain part of the trust boundary.

The resolver can consume read quota or cause redundant coordinator calls. Bounded input, stable
reads, canonical deduplication, schedule caps, per-issue serialization, provider-budget
serialization, and complete coordinator reload turn that risk into bounded availability loss, not
authority.

Review and conversation changes have no bounded reconciliation latency because their sole normal
wake is provider scheduling. The operator accepts that availability cost to preserve the
protected-caller identity without Actions write or an additional account. A later accepted
decision is required to add another protected review wake source.

The GitHub-hosted runner starts with an artifact-service capability that repository permissions do
not model. Removing its runtime artifact credentials before the only repository-owned command and
machine-denying any artifact action or additional step is part of the enforced boundary. A later
need for resolver-produced artifacts is semantic replanning, not a permission-only edit.

The same `github-actions[bot]` and GitHub Actions App identity appears across protected workflows.
Dual workflow/run/job/ref/SHA verification, immutable anchors, and OIDC attestations distinguish
the caller, reusable writer, and producer roles without another account.

There is no added account, App installation, PAT, secret, broker, database, hosted service, or
human credential in automation. No agent receives `dev` merge, auto-merge, enqueue, push, update,
administration, or bypass authority.

## Governance and rollout

This ADR is inert documentation. It creates no workflow, token permission, locator artifact,
lifecycle transition, status, branch, pull request, queue, merge, or repository setting.

After an authorized maintainer manually merges this ADR to `dev`:

1. epic #49 increments to v9, returns to `status: new`, cites ADR-0012, and receives fresh
   readiness;
2. issue #51 increments to v6, adopts the exact protected caller/callee topology, returns to
   `status: new`, and receives fresh readiness;
3. issue #55 increments to v7, includes the live dual-identity and no-Actions-write proof, returns
   to `status: new`, and receives fresh readiness;
4. issues #50, #52, #53, and #54 remain unchanged; and
5. issue #51 may salvage its guarded-off implementation only where it matches the refreshed
   contract and passes full verification plus independent audit.

Every pull request targeting `dev` stops at `status: ready for human review`. An agent must not
merge it, enable auto-merge, enqueue it, or use a human credential to bypass the maintainer action.

## References

- Decision issue [#131](https://github.com/oscharko-dev/Keiko-Native/issues/131)
- [ADR-0004](ADR-0004-readiness-authority-and-workflow-lifecycle.md)
- [ADR-0011](ADR-0011-authenticated-lifecycle-handoff-record-protocol.md)
- [GitHub OIDC claim reference][oidc]
- [Reusable workflow configuration][reuse]
- [The `workflow_run` event][workflow-run]
- [Workflow concurrency][concurrency]
- [Workflow permissions][permissions]
- [Actions workflow-run API][runs]
- [Actions artifact API][artifacts]
- Repository evidence run
  [30393476770](https://github.com/oscharko-dev/Keiko-Native/actions/runs/30393476770)

[artifacts]: https://docs.github.com/en/rest/actions/artifacts
[concurrency]: https://docs.github.com/actions/using-jobs/using-concurrency
[oidc]: https://docs.github.com/en/actions/reference/security/oidc
[permissions]: https://docs.github.com/actions/using-jobs/assigning-permissions-to-jobs
[reuse]: https://docs.github.com/actions/using-workflows/reusing-workflows
[runs]: https://docs.github.com/en/rest/actions/workflow-runs
[workflow-run]: https://docs.github.com/actions/using-workflows/events-that-trigger-workflows
