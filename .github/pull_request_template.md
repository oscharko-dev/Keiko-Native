## Scope

- Accepted task or issue:
- Native targets or trust boundaries affected:
- Out of scope:

## Reuse and architecture

- [ ] I inspected Keiko's existing shared core, contracts, policy, evidence, memory, connector, and
      workflow surfaces before adding native-specific behavior.
- [ ] This change does not create a second policy or governance subsystem.
- [ ] Any architecture change is recorded in an ADR.

## Trust boundaries and failure modes

- [ ] Hostile, malformed, empty, boundary, oversized, unauthorized, unavailable, stale, replayed,
      conflicting, and partially failed inputs are covered where applicable.
- [ ] Secrets and raw customer content are absent from code, logs, fixtures, evidence, artifacts,
      issues, and this pull request.
- [ ] Evidence remains redacted, exact-head, and producer-bound.

## Verification

- [ ] `npm ci --ignore-scripts`
- [ ] `npm run quality`
- [ ] `npm audit --audit-level=high`
- [ ] Every declared native target-specific gate passed on its authoritative platform.
- [ ] I reviewed the complete diff line by line against requirements and failure modes.

## Delivery

- [ ] The branch targets `dev`; no direct push, force push, gate bypass, finding dismissal, or
      authority widening occurred.
- [ ] The commit is signed and every check is bound to the exact current head.
- [ ] Gitar and Keiko for Quality evidence is treated as advisory under the current policy.
