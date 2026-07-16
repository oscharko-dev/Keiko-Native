# Gitar review policy

Gitar is an independent advisory reviewer for pull requests targeting `main`. Its GitHub check must
come from App ID `827041`; comments and reviews must come from the Gitar bot identity. Producer
identity makes evidence attributable but does not make an unavailable service merge-critical.

Review every pull request as a potentially large native integration. Inspect productive sources,
FFI/IPC boundaries, entitlements, sandbox and filesystem access, network egress, persistence,
updates, signing, packaging, workflows, manifests, public contracts, and tests before generated or
binary evidence. If service limits prevent complete review, identify the unreviewed files instead of
issuing a clean verdict.

Draft processing, merge blocking, auto-approve, Gitar auto-merge, approval labels,
`gitar unblock`, and unrelated-CI retries remain disabled. A ready pull request may receive one
`gitar review` request on its final locally verified head. A later commit invalidates that evidence.

A clean advisory verdict requires zero unresolved findings and current-head review evidence. Every
confirmed behavioral or trust-boundary finding requires an owning-layer fix and a failure-first
regression or boundary test.
