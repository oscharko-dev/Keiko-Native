# Issue Lifecycle

This is the canonical operational contract for Keiko Native issue lifecycle state. It projects
ADR-0004 into the repository-owned words and machine checks used by agents, humans, templates, and
quality gates.

Readiness and lifecycle are separate. Current readiness is a trusted evidence predicate over the
latest accepted contract version and fingerprint. A lifecycle label never creates readiness, and a
readiness record never bypasses the action limits of the current lifecycle state.

## Canonical States

Every governed open issue has exactly one of these labels. A completed closed issue has exactly
`status: done`. Closed non-completed issues carry no `status:*` label.

- `status: new`
- `status: triaged`
- `status: ready`
- `status: in progress`
- `status: pr open`
- `status: ready for human review`
- `status: blocked`
- `status: waiting for user`
- `status: done`

## State Meanings

### `status: new`

Planning intake is unreviewed, changed, reopened, or invalidated. Current readiness must be absent.
Template creation, semantic contract edits, type or authority changes, and trusted reopen recovery
enter this state. No pull request can pass from this state.

### `status: triaged`

Planning is reviewed, correctly typed and classified, and ordered for delivery, but the exact
contract is not accepted. Current readiness must be absent. Only an authorized planning actor can
request ready from here.

### `status: ready`

The exact contract has current readiness and is unclaimed. This state authorizes a valid claim or
an authorized pause. A linked delivery pull request cannot pass while the issue remains ready.

### `status: in progress`

An authorized implementer has claimed current-ready work and no delivery pull request is active.
Opening or reopening a contract-authorized pull request can enter PR open.

### `status: pr open`

At least one contract-authorized delivery pull request is open. Current readiness is required. The
linked PR must match the accepted issue, target, source rule, and exact head evidence.

### `status: ready for human review`

The open linked PR's exact current head has complete verification, audit, conversation, journey,
platform, and evidence obligations. Current readiness is required. This is the automation stop
state for a `dev` target; only an allowlisted human may initiate a `dev` merge.

### `status: blocked`

Progress is paused by a dependency, decision, or failing external condition. Matching readiness may
be retained, but it grants no authority to continue. Linked PR contract evidence is invalidated.

### `status: waiting for user`

Progress is paused for explicit human product, policy, risk, scope, or approval input. Matching
readiness may be retained, but it grants no authority to continue. A comment alone does not resume
work.

### `status: done`

Final accepted delivery is complete and the issue is closed with reason `completed`. Earlier
readiness is historical and non-executable. Reopen removes done and returns to new.

## Allowed Edge Graph

Every unlisted edge is invalid and fails closed.

- Creation or reopen enters `status: new`.
- `status: new` may enter `status: triaged`, `status: blocked`, or
  `status: waiting for user`.
- `status: triaged` may enter `status: ready`, `status: blocked`,
  `status: waiting for user`, or `status: new`.
- `status: ready` may enter `status: in progress`, `status: blocked`,
  `status: waiting for user`, or `status: new`.
- `status: in progress` may enter `status: ready`, `status: pr open`,
  `status: blocked`, `status: waiting for user`, or `status: new`.
- `status: pr open` may enter `status: ready`, `status: in progress`,
  `status: ready for human review`, `status: blocked`, `status: waiting for user`,
  or `status: new`.
- `status: ready for human review` may enter `status: pr open`,
  `status: in progress`, `status: blocked`, `status: waiting for user`,
  `status: new`, or `status: done`.
- `status: blocked` may enter `status: waiting for user`, `status: new`,
  `status: triaged`, `status: ready`, `status: in progress`, or `status: pr open`.
- `status: waiting for user` may enter `status: blocked`, `status: new`,
  `status: triaged`, `status: ready`, `status: in progress`, or `status: pr open`.
- `status: done` may enter only `status: new`, and only through reopen.

Semantic edits from any open state override the ordinary edge and enter new. A valid final merge
cannot enter done directly from PR open because ready-for-human-review exact-head evidence is a
precondition.

## Permitted Label Requests

Label changes are requests, not authority. The trusted workflow reloads state and validates the
request before reconciliation. These are the only permitted source and requested-target pairs:

- `status: new` -> `status: triaged`: planner or maintainer.
- `status: triaged` -> `status: ready`: planner or maintainer.
- `status: new` -> `status: blocked`: implementer or maintainer with a blocking condition.
- `status: triaged` -> `status: blocked`: implementer or maintainer with a blocking condition.
- `status: ready` -> `status: blocked`: implementer or maintainer with a blocking condition.
- `status: in progress` -> `status: blocked`: implementer or maintainer with a blocking condition.
- `status: pr open` -> `status: blocked`: implementer or maintainer with a blocking condition.
- `status: ready for human review` -> `status: blocked`: implementer or maintainer with a
  blocking condition.
- `status: waiting for user` -> `status: blocked`: implementer or maintainer with a blocking
  condition.
- `status: new` -> `status: waiting for user`: implementer or maintainer with the missing input.
- `status: triaged` -> `status: waiting for user`: implementer or maintainer with the missing
  input.
- `status: ready` -> `status: waiting for user`: implementer or maintainer with the missing input.
- `status: in progress` -> `status: waiting for user`: implementer or maintainer with the missing
  input.
- `status: pr open` -> `status: waiting for user`: implementer or maintainer with the missing
  input.
- `status: ready for human review` -> `status: waiting for user`: implementer or maintainer with
  the missing input.
- `status: blocked` -> `status: waiting for user`: implementer or maintainer with the missing
  input.

Direct label gestures for new, in progress, PR open, ready for human review, or done are never
authority. Workflow-authored reconciliation mutations are effects carrying trusted transition
identity, not user requests.

## Preconditions And Recovery

The lifecycle owner reloads the issue, comments, provider label inventory, current readiness, PR
topology where applicable, and exact issue identity before deciding. Zero lifecycle labels, multiple
lifecycle labels, unknown labels, stale readiness, replayed readiness, mismatched issue identity,
unauthorized actor role, unavailable provider data, or malformed provider data fail closed.

Pause entry requires blocked or waiting evidence. Resume is explicit and never restores ready for
human review. Without current readiness, unchanged suspended triaged returns to triaged and every
other suspended source returns to new. With current readiness, topology may return ready, in
progress, or PR open.

Completed closure requires final delivery evidence and enters done. Non-completed closures remove
all lifecycle labels. Reopen always enters new and requires fresh readiness before execution.

The label mutation path uses set-to-desired reconciliation: remove undesired `status:*` labels,
apply the sole desired label, then read back and verify exact issue identity plus exactly one
matching lifecycle label.
