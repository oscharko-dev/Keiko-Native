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
- restricts updates and merges to Niko and Oscharko;
- excludes every agent or automation identity from the `dev` update allowlist; and
- requires each exact-head context and expected App ID listed in `quality-gates.md`, but only after
  its producer has passed the live negative and positive probes.

GitHub's repository-wide auto-merge feature may remain available for epic delivery, but agents must
not be able to merge or enable auto-merge on a pull request targeting `dev`.

## 4. Protect `epic/**`

Configure an epic-branch ruleset that requires pull requests, signed commits, linear history,
resolved conversations, `PR contract`, `Issue contract current`, and every deterministic or
provider check observed for that target during the live probes.

An authenticated agent may use the authenticated maintainer account to merge a fully eligible
accepted child branch only into the exact accepted epic target. Require it to revalidate the issue
contract, source, target, current head, applicable checks, audit evidence, findings, and review
conversations immediately before mutation. Any mismatch or `dev` target fails closed. Never merge
or enable auto-merge for `dev`. Retain the issue, pull request, exact head, actor, and result as the
automation record.

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
7. An authenticated-agent probe using the authenticated maintainer account can merge one fully
   green child pull request to its exact accepted epic branch, rejects a wrong or stale target, and
   does not merge, enable auto-merge, push, or bypass a gate on `dev`.
8. Niko or Oscharko can manually merge a fully green `dev` pull request after reviewing the exact
   head; no separate non-author approval is required.

Activate a status context as required only after the same producer has demonstrated both a failing
negative case and a successful current-head case. Retain the probe links as the activation record.
