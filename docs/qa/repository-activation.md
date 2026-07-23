# Repository activation checklist

## Status

Manual owner runbook. Repository automation must not activate, weaken, or bypass its own
administrative controls.

## Restricted caller and broker identity controls

[`quality/repository-controls-policy.json`](../../quality/repository-controls-policy.json) is the
closed repository configuration for issue #50. It records the restricted caller identity, the
separate broker App identity, protected-context producers, the intended epic ruleset, and the
one-member `dev` merge queue. The checked-in caller App ID, broker App ID, installation IDs, slugs,
and epic ruleset ID remain `null` until an authorized human provisions and reads back those exact
resources. The broker receipt-verification SPKI public key and its SHA-256 fingerprint also remain
`null` while the broker App identity is pending. A null or mismatched value is an explicit blocked
activation result, never a warning.
The repository, installation account, disposable `epic/50-controls-probe` target, and complete
required, pending, and epic producer matrices are code-owned constants. The nonempty checked-in
pending matrix is also an explicit activation blocker. A later accepted staged contract must
promote `Contract publication` and `Lifecycle handoff` into the `dev` required matrix, promote only
`Lifecycle handoff` into the epic required matrix, and empty both target-specific `pendingChecks`
lists; editing both policy and evidence to a self-consistent alternative does not grant authority.

The restricted caller and broker App are different principals. The caller is limited to provider
permissions `contents: write`, `issues: write`, `metadata: read`, and `pull_requests: write` for its
accepted branch, issue, pull-request, and lifecycle-request work. Repository rules must still deny
that caller every merge and auto-merge effect. It cannot receive the broker credential or submit a
provider merge directly. Its short-lived provider token is held by the separate server-side
restricted-caller service; the agent receives only bounded typed operations and sanitized results,
never that provider token.

The canonical broker permission and protocol policy is owned once by
`quality/epic-merge-broker-capability.mjs` and consumed by the repository-controls validator. The
JSON configuration deliberately does not copy that permission map. The dedicated broker App has
exactly `administration: read`, `checks: read`, `contents: write`, `issues: read`,
`metadata: read`, `pull_requests: read`, and `statuses: read`. The `contents: write` permission is
usable only by the trusted server-side broker's snapshot-bound dual-ref conditional effect against
the exact accepted `epic/**` target. It grants no caller path and no `dev` effect.

An authorized human creates both repository-selected Apps, installs each only on
`oscharko-dev/Keiko-Native`, and records their immutable IDs and slugs through a governed pull
request. Caller private material stays in its restricted-caller service, and broker private
material stays in the approved broker secret manager. Only those two server-side boundaries may mint
their own short-lived installation tokens; the caller service can never mint or receive the broker
token. Agents, ordinary workflows, repository variables, Actions secrets, logs, caches, artifacts,
issues, and pull requests cannot acquire or receive either App private key, JWT, installation token,
or a human credential.

The same broker-held GitHub App RSA private key signs the canonical receipt payload with
RSA-PSS-SHA256 and never crosses the broker boundary. An authorized human records and reads back
only its canonical SPKI public key and SHA-256 fingerprint through the staged policy. The
repository collector receives the signed receipt only; it has no signing-key, signing-capability,
or raw broker-decision input.

### Sanitized read-back

The repository probe code accepts injected read-only clients for hermetic testing and external
human-operated administration tooling. It contains no credential acquisition path. Every
administration, caller-App, and broker-App configuration source is read twice and compared after
closed canonical projection. The first projection is deep-cloned before the second read begins, so
a provider client cannot hide a torn read by mutating a shared response object. Changed or
unavailable reads emit no configuration and block activation. A metadata `stableReads` assertion
is not evidence. The authorized human runs a
separately reviewed administrator/broker read-back tool outside the agent session. That tool must
perform complete bounded pagination and emit only the closed schema from
`quality/repository-controls-evidence.mjs`: repository/App/installation identifiers, permission
names and levels, exact refs and digests, rule and context identities, result classes, timestamps,
and cleanup state. It must discard provider bodies and all credential material at the producing
boundary.

After independently confirming that the file is sanitized, validate it locally:

```text
node quality/repository-controls-probe.mjs /absolute/path/to/sanitized-repository-controls.json
```

The validator never echoes the evidence file. Unknown fields, missing or extra permissions,
same-principal caller/broker identity, extra repositories, stale timestamps, expired tokens,
incomplete pages, unavailable sources, producer drift, protection drift, or a secret-shaped field
fail closed. Delete the local evidence file after its durable credential-free receipt is linked from
the issue or pull request.

### Required live probe matrix

The human-operated disposable probe must record all of these machine-readable rows:

1. The restricted caller creates its accepted signed branch commit, issue/lifecycle request, and
   pull request, while direct merge and auto-merge are denied.
2. The broker-only App completes one fully eligible snapshot-bound child merge into the exact
   disposable `epic/50-controls-probe` target. At the producing boundary, repository code reruns
   the shared broker binder and accepted-effect decision over the complete transient input,
   including readiness, lifecycle, expected producers, evidence, pagination, composition, issue
   and target locks/fences, both stable reads, pre-submit refs, durable snapshot, submission ledger,
   conditional response, exact parents, and target read-back. Durable evidence contains only the
   closed canonical receipt: a distinct request ID, the broker-owned bound authorization snapshot,
   and the accepted conditional response. The snapshot contains normalized identifiers, digests,
   refs, fences, result classes, and producer evidence, but excludes `handoffInput`, provider
   bodies, and readiness comment text. The canonical broker core independently recomputes the
   snapshot ID and lock/ref invariants and verifies the exact accepted effect; a separately
   recomputable wrapper hash cannot grant authority. Before those checks, it verifies the exact
   RSA-PSS-SHA256 envelope, SPKI fingerprint, and signature over the fixed canonical payload.
3. Both principals are denied `dev` update, merge, auto-merge, queue enqueue, bypass, and
   administration effects. Each principal separately proves secret, environment, broader-target,
   and maintainer-impersonation denial. Caller access to the broker credential and direct caller
   merge are denied. The caller also proves denial for the wrong branch, issue, pull request, and
   lifecycle request while binding the accepted actor, repository, and coordinates. Every denied
   attempt proves protected state remained unchanged.
4. Separate broker rejections prove no effect for wrong target, broader target, stale source, stale
   base, replay, concurrent request, permission drift, and provider failure. Scenario-specific
   fields bind competing requests and fences, expected and observed permission sets and digests,
   closed provider failure class and no-submission state, replay linkage, submission count and
   no-retry state, or the exact stale/attempted coordinate. Relabelling one row as another scenario
   is invalid. Caller capability, rejection, and denial rows bind the exact actor App ID,
   repository, issue, pull request, artifact, source/head/base/target, request, snapshot, and fences
   where applicable. Request IDs are globally unique across those row classes; replay links use
   separate fields. Every `dev` attempt names `dev`; every accepted probe merge names the
   configured disposable target. Every nested observation is current within the evidence window; a
   fresh outer capture cannot make a stale row acceptable.
5. The exact expected producer supplies every enrolled context. The epic ruleset reads its
   provider-canonical `integration_id` bindings and strict-status policy, has no excluded epic ref
   or bypass actor, blocks deletion and non-fast-forward updates, and names only the broker App
   by both immutable App ID and slug among automated update principals. `dev` names neither
   automated principal and retains only `Niko4417` and `oscharko`.
6. Signed commits, linear history, resolved conversations, strict checks, administrator
   enforcement, blocked force-push/deletion, and the one-member `dev` merge queue read back exactly.
7. Every disposable issue, branch, pull request, queue entry, and server-side request is removed or
   has a sanitized cleanup failure that keeps activation blocked.

The broker effect receipt must conform to the same `epic-merge-broker` snapshot and exact-parent
protocol already used by the authorization module. A separate script, status name, or policy file
cannot authorize a merge.

### Rotation, revocation, outage, and ambiguity

- **Rotation:** suspend new requests, let no submitted snapshot be retried, rotate the same App
  private key in the broker secret manager, revoke the predecessor, and update the repository-owned
  SPKI public key plus fingerprint through a governed pull request. Mint a fresh short-lived token
  only inside the broker and rerun capability, signed-receipt, and denial probes before resuming.
  Retain prior credential-free signed receipts only where their historical verification material
  remains governed and applicable.
- **Revocation or uninstall:** disable automated epic delivery immediately, invalidate outstanding
  unsubmitted snapshots, preserve credential-free receipts, and require fresh installation,
  identity, permission, repository-scope, ruleset, capability, and denial read-back.
- **Outage or permission drift:** select human-only child integration. Do not grant a workflow the
  credential, enable provider auto-merge, weaken a gate, or use a maintainer credential. Resume
  automation only after a fresh complete probe.
- **Ambiguous or partially accepted result:** do not retry, refresh, or replace the submitted
  snapshot. Disable automation and have an authorized human reconcile the exact source/target refs,
  merge commit, ordered parents, target tip, and pull request. A fresh capability probe is required
  after settlement.

Each recovery receipt records only scenario, automation-disabled state, no-retry state, human
reconciliation where ambiguity requires it, result class, and timestamp. Missing recovery or
cleanup evidence blocks activation.

## 1. Merge the governance baseline

- Deliver this baseline through a human-reviewed pull request to `dev` under the currently active
  rules.
- Do not require the new `PR contract` or `Issue contract current` contexts until their workflows
  exist on protected `dev` and a live pull request has emitted them.
- Keep `dev` as the default integration branch. Do not push the baseline directly.

## 2. Install the label contract

Copy the Existing Keiko label taxonomy without renaming its existing labels. Add these Native
template labels, which do not exist in the current source taxonomy:

| Label            | Purpose                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `type: decision` | Evidence-backed architecture, product, security, or platform decision |
| `type: defect`   | Reproducible defect or user finding that restores accepted behavior   |

Confirm that these copied labels retain their exact names: `type: epic`, `type: task`,
`status: new`, `status: triaged`, `status: ready`, `status: in progress`,
`status: pr open`, `status: ready for human review`, `status: blocked`,
`status: waiting for user`, and `status: done`. The legacy `bug`, `User Findings`, area,
dependency, and contributor labels may coexist; they do not replace the single supported `type:*`
label required by the Native issue contract.

Create one disposable issue from every template and confirm that its declared labels are applied.
Delete the disposable issues after the readiness probes below.

## 3. Protect `dev`

Configure a ruleset or branch protection that:

- requires pull requests, strict current-branch checks, signed commits, linear history, and resolved
  conversations;
- blocks force pushes and branch deletion and applies to administrators;
- restricts updates and merges to Niko and Oscharko;
- excludes every agent or automation identity from the `dev` update allowlist; and
- requires each exact-head context and expected App ID listed in `quality-gates.md`, but only after
  its producer has passed the live negative and positive probes.

Repository-wide provider auto-merge is not the Keiko Native epic-delivery mechanism. Repository
rules must prove that no automated principal, including the dedicated non-human GitHub App used by
the trusted server-side merge-authority broker, can update, merge, enable auto-merge, enqueue,
administer, or bypass `dev`.

## 4. Protect `epic/**`

Configure an epic-branch ruleset that requires pull requests, signed commits, linear history,
resolved conversations, `PR contract`, `Issue contract current`, and every deterministic or
provider check observed for that target during the live probes.

Grant the dedicated non-human GitHub App only the permissions and ruleset access required by the
trusted server-side merge-authority broker to merge a fully eligible child branch into its exact
accepted epic target. An agent or ordinary workflow may submit and observe a bounded request but
cannot merge, enable provider auto-merge, hold the App credential, select a broader target, or
impersonate a maintainer. Require broker-side revalidation of protected-`dev` policy, issue
authority and lifecycle, source and target refs, current head and base, applicable checks, audit
evidence, findings, review conversations, locks, fences, replay state, conditional provider
acceptance, and exact post-effect parents. Any mismatch, ambiguity, unavailable evidence, or `dev`
target fails closed. Retain the request, authorization snapshot, issue, pull request, exact refs,
App identity, result, and read-back as the automation record.

## 5. Verify workflow permissions and providers

- Keep the repository Actions default token read-only. Retain only the job-level permissions
  declared in the checked-in workflows.
- Confirm that SonarQube Cloud, Socket, CodeQL, Dependency Review, OSV, Gitar, and Keiko for Quality
  are installed or configured for Keiko Native with the documented producer identities.
- Keep Gitar and Keiko for Quality advisory until their documented liveness and negative probes
  succeed.
- After any organization or repository rename, update remotes and provider bindings manually, then
  change checked-in repository coordinates in a separate governed pull request. Do not disable a
  failing binding check as a shortcut.

## 6. Run the activation probes

Record the issue, pull request, exact head, actor, result, and timestamp for each probe:

1. An incomplete template cannot retain `status: ready`; a complete template can, and receives a
   GitHub-Actions-authored readiness record.
2. A copied or human-authored readiness marker has no authority.
3. An incomplete draft pull request receives failing `PR contract` evidence; a fully settled pull
   request receives both required contract statuses on its exact head.
4. Editing the accepted issue title or semantic body, closing it, changing its type, or removing
   readiness changes `Issue contract current` to failure on every linked open pull request.
5. Restoring issue readiness does not restore a pull request until its contract and evidence pass
   again.
6. A wrong source issue number, delivery target, readiness URL, contract version, or stale head
   fails closed.
7. A dedicated-App probe through the trusted server-side merge-authority broker merges one fully
   green child pull request to its exact accepted epic branch, rejects wrong, stale, replayed, and
   concurrent requests, verifies the exact commit parents and target tip, and proves no automated
   principal can merge, update, enable auto-merge, enqueue, administer, or bypass `dev`.
8. Niko or Oscharko can manually merge a fully green `dev` pull request after reviewing the exact
   head; no separate non-author approval is required.

Activate a status context as required only after the same producer has demonstrated both a failing
negative case and a successful current-head case. Retain the probe links as the activation record.

## Pending contract-publication controls

Contract publication remains disabled. The inert workflow checks out only protected `dev` with
non-persistent credentials and requests read-only contents access. Its activation variable remains
unset, and its only permitted commands are syntax checks. It does not check out or execute
pull-request content. The `Contract publication` context is not enrolled as required.

Before a human activates publication, complete ADR-0003's negative and positive lane probes,
authenticate the expected producer, prove exact-head and merge-group emission, and verify the
signed receipt, isolated merge, actor, ancestry, tree, and exact-byte evidence. Activation must be
a separate accepted change; do not turn the inert job on or add its context from this baseline.

## Pending merge-queue and epic-merge controls

The merge queue remains disabled until its human liveness and ordering probe passes. The inert
merge-group workflow checks out only protected `dev` with non-persistent credentials, requests
read-only contents access, is gated by an unset activation variable, and permits only syntax-check
commands. It never executes constituent content.

Automated epic-branch merge remains disabled until complete pagination, stable ordering, lock
fences, dual-ref conditional rejection, and exact parent and outcome evidence are proven live. An
unavailable, ambiguous, weak, or failed capability selects human-only child integration; it must
not enable auto-merge or approximate the broker. Enrolling merge-group contexts, configuring the
queue, granting the broker identity, or enabling either inert job requires a separate accepted
human activation change.
