# Repository activation checklist

## Status

Manual owner runbook. Repository automation must not activate, weaken, or bypass its own
administrative controls.

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
- restricts updates and merges to the explicit authorized-maintainer allowlist;
- requires the repository-owned agent/tool-policy guard, which denies every agent request for `dev`
  before any provider call; and
- requires each exact-head context and expected App ID listed in `quality-gates.md`, but only after
  its producer has passed the live negative and positive probes.

Repository-wide provider auto-merge is not the Keiko Native epic-delivery mechanism. Because the
guarded operation uses the existing authenticated maintainer credential, GitHub cannot distinguish
agent and human actions and cannot apply a separate automation-identity deny rule. Preserve the
human allowlist, whose current membership is Niko and Oscharko, and all protections as defense in
depth. Prove the repository-owned guard denies every agent merge, update, auto-merge, enqueue,
administration, or bypass request for `dev`.

## 4. Protect `epic/**`

Configure an epic-branch ruleset that requires pull requests, strict up-to-date current-branch
checks, signed commits, linear history, resolved conversations, `PR contract`,
`Issue contract current`, and every deterministic or provider check observed for that target
during the live probes.

The repository-owned guard may use the existing authenticated maintainer credential for one fully
eligible child-issue pull request only when its base is the issue's exact accepted `epic/**` target.
Epic and standalone pull requests remain human-only deliveries to `dev`. Require immediate
revalidation of issue authority, `status: ready for human review`, source and target refs, current
head and base, applicable checks, audit evidence, findings, review conversations, stable reads,
replay state, expected-head provider acceptance, and exact post-effect parents. The guard persists
a durable single-flight compare-and-set claim for the exact operation before any provider
submission and rejects concurrent or replayed claims. Any mismatch, ambiguity, unavailable
evidence, or non-exact target fails closed. The operation explicitly sends `merge_method: merge`,
never uses provider auto-merge, and submits at most once. An ambiguous claim remains blocked with no
retry until explicit human reconciliation using exact refs and ordered parents. Retain only the
sanitized request identity, issue, pull request, exact refs, result class, merge commit and parents,
and read-back as the automation record; never retain the credential or raw provider bodies. The
guard must deny every agent merge, auto-merge, enqueue, push, or update request for `dev`, `main`,
and `release/**`.

The merge endpoint's `sha` precondition binds only the pull-request head and does not atomically
bind the base. Strict current-branch protection and immediate revalidation must therefore make a
base advance invalidate eligibility and reject the merge before the guarded effect. This is
defense in depth, not an atomic base compare-and-swap.

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
7. A guarded-operation probe using the existing authenticated maintainer credential merges one
   fully green child-issue pull request to its exact accepted `epic/**` target, rejects `dev`,
   wrong, stale, replayed, and concurrent requests before mutation, durably persists its
   compare-and-set claim before making at most one expected-head merge call with
   `merge_method: merge`, verifies the exact target tip and ordered parents, and proves an ambiguous
   claim remains blocked with no retry or provider auto-merge until explicit human reconciliation.
   GitHub attribution cannot distinguish this agent operation from a human action; the evidence
   must state that limitation rather than claiming identity isolation. In the disposable live
   probe, advance the base after green evidence and prove that the base advance invalidates
   eligibility and rejects the merge before the guarded effect; eligibility requires fresh
   evidence against the new base.
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

Automated epic-branch merge remains disabled until complete pagination, stable reads, exact-target
denials, expected-head rejection, at-most-once submission, redaction, and exact parent and outcome
evidence are proven live. An unavailable, ambiguous, weak, or failed capability selects human-only
child integration; an ambiguous result causes no retry and must not enable provider auto-merge.
Enrolling merge-group contexts, configuring the queue, or enabling either inert job requires a
separate accepted human activation change.
