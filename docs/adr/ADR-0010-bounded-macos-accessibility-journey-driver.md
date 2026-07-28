# ADR-0010: Bounded macOS Accessibility journey driver

## Status

Accepted.

## Context

Issue #111 contract v3 requires one repository-owned, test-side mechanism that can drive Epic #98's
automatable packaged-app checkpoints through stable macOS accessibility semantics. The mechanism
must complement the ADR-0006 `acceptance:macos` harness, remain absent from the product package,
fail closed when Accessibility permission is unavailable, and create no product command, debug
surface, listener, or second policy source.

The retained evaluation uses one fixed profile with 16 semantic checkpoints:

- workspace select, cancel, and permission denial;
- task submit, streaming, normal completion, cancellation, and crash recovery;
- terminal summary and zero-descendant quit;
- keyboard focus, VoiceOver-compatible semantics, appearance and contrast, reduced-motion
  applicability, scaling, and Unicode/IME input.

The external AXUIElement adapter and bounded System Events script each completed 20 clean allowed
repetitions against the same generated representative package. Each candidate passed 320 of 320
checkpoint operations, used two-second per-checkpoint subprocess bounds plus a separate bounded
five-second natural-quit observation, produced zero unexplained failures, and left zero owned
descendants. AXUIElement journeys took 3032–3921 ms (3146 ms mean); System Events journeys took
8873–10237 ms (9050 ms mean). Both also failed closed under denied and revoked Accessibility
permission and recovered through fresh processes after permission was restored. The no-driver
baseline cannot machine-evaluate the declared checkpoints.

The fixed weighted matrix selected AXUIElement with 490 points. System Events scored 485 and remains
a viable but unselected alternative. The no-driver baseline scored 260 and failed the absolute
`missing-automatable-checkpoint` gate.

The exact-head ADR-0006 package gate independently passed with closed acceptance evidence, normal
shutdown, zero owned descendants, and no evaluation marker in the Foundation package. The
representative evaluation package and both candidate artifacts were generated outside productive
roots.

## Decision

Keiko Native selects a **bounded external AXUIElement adapter** for issue #104 and the exact Epic
#98 macOS packaged journey.

The authorized mechanism is:

- repository-owned test-support source that generates a small executable using the public macOS
  ApplicationServices AXUIElement API;
- launched only by the existing Node acceptance/evaluation boundary on authoritative physical
  macOS arm64;
- limited to the accepted semantic identifiers and exact journey checkpoints;
- condition-driven with bounded waits and closed reason codes;
- non-prompting during automated probes;
- fail-closed on missing, duplicate, ambiguous, unauthorized, unavailable, stale, or partially
  failed UI state; and
- responsible for terminating its owned representative or packaged-app process tree and proving
  zero descendants.

The adapter complements rather than replaces `acceptance:macos`. ADR-0006 continues to own exact
build identity, package policy, packaged lifecycle, normal shutdown, redaction, and package
publication. The AXUIElement adapter may extend that harness only with the accepted user-visible
semantic checkpoints. This decision proves driver capability against equivalent semantics; it does
not claim that the unimplemented tracer journey already passes.

### Production-package exclusion

The adapter executable, generated representative package, System Events comparison script, raw
Accessibility objects, and physical capture files are evaluation artifacts. They:

- remain outside productive roots and the shipped application bundle;
- are generated beneath an isolated temporary root and removed after use;
- cannot add a product IPC command, debug menu, remote listener, synthetic endpoint, capability,
  entitlement, navigation exception, or relaxed content-security policy;
- cannot retain selected-repository content, task or response content, credentials, paths, raw
  protocol data, or customer data; and
- must fail package acceptance if an adapter, evaluation marker, test hook, or undeclared
  dependency appears in the product.

Repository retention is limited to the bounded generator/harness source, hermetic contracts, the
closed prepared identity and permission-phase captures, the closed decision evidence, and this ADR.
The retained JSON contains only identifiers, digests, aggregate outcomes, reason codes, and elapsed
timings; it contains no raw Accessibility objects or product content. Issue #104 owns any later
journey fixture retained for acceptance and must preserve this exclusion contract.

### Permission and diagnostics

Physical macOS Accessibility permission remains an operator-controlled prerequisite. Automated
probes request no prompt. Denied or revoked permission returns the closed
`accessibility-permission-denied` reason and performs no journey operation. Recovery requires an
explicit operator grant and a fresh process; no automation mutates the macOS privacy database.

AXUIElement is selected over System Events because both passed all absolute gates, while
AXUIElement supplies a typed API/error boundary and received the matrix's full permission and
diagnostics score. System Events has the smaller build footprint, but its AppleScript boundary is
less typed and required an explicit `UI elements enabled` check to distinguish process visibility
from UI authority. That five-point difference is the complete selection margin; it is not evidence
that System Events is unsafe or incapable.

### Platform and ownership boundary

Keiko Native quality and acceptance owners maintain the adapter and its semantic checkpoint
contract on macOS. This ADR authorizes no Windows or Linux implementation and no general desktop
automation framework. A future Windows equivalent requires a separate accepted decision with
authoritative physical Windows evidence, UI Automation semantics, the same fail-closed permission,
redaction, repetition, package-isolation, and process-cleanup gates, and its own package identity.

## Evidence

The retained machine-readable record is
[`macos-accessibility-driver-evidence.json`](../evaluation/macos-accessibility-driver-evidence.json).
Its principal bindings are:

- issue #111 contract v3 readiness fingerprint
  `6d95dc95700c17a2d29850d1f517ad45c53df4a95318e3ae482f7d32d5dc75d7`;
- evaluation head `fbb805ba971c20417d826b90d70b2f5c17c86bdd`;
- evaluation source SHA-256
  `c9aafd2e52846b20f16c03a9925ab1261b751052f1b0501fda187d209db739c5`;
- prepared evidence SHA-256
  `e386a51ab8b2add76faafc65aa9c35740faf12e1b41db06bb3edde9bdf513c81`;
- allowed capture SHA-256
  `52cc09165c8c5fbff45cd721f1f2344abf5069864c9ef420c15bfc2eff1ddf95`;
- denied capture SHA-256
  `efd20f6d8361e787f4e066548ca4c3da097ef9443d78b48a91b8baa8ac4931c0`;
- revoked capture SHA-256
  `a855d6dcd202cff2f2d1be2ea4b403443dc99ccf4b63fc2eae8d9eb4b3ee36b6`;
- recovered capture SHA-256
  `f1f6b0a6861616f8820c3af79c165c955afcce3d1566442504f00434e3f27b53`;
- Foundation acceptance evidence SHA-256
  `ba2a44d8a76118196e26263c7b37d478ab899e7a5eab962935e1aed03e0bb78d`;
- Foundation package-manifest SHA-256
  `66ad909d388961e62fac736fa8a8c374f525933f1e49607f19593508bfff9734`;
  and
- representative package SHA-256
  `9221319c3d37bdd7c2e36c0558f039d60d1aa3b3223f49668c3b4fa7aedf3e0c`.

The retained record also contains the dependency and licence inventories. Both candidates use only
macOS system components and add no vendored binary, runtime, package-manager dependency, or
third-party repository notice.

## Consequences

Issue #104 may implement the smallest real packaged tracer journey by extending the existing Node
harness with the bounded AXUIElement adapter. It may not add another product surface or broaden the
driver beyond the accepted checkpoints.

The adapter remains macOS-specific and depends on operator-granted Accessibility permission and
authoritative physical execution. CI may run hermetic schema, generation, package-isolation, and
failure contracts, but it cannot substitute for required physical permission, VoiceOver, visual,
contrast, scaling, or IME observations.

System Events remains documented dissenting evidence. Replacing AXUIElement with System Events,
adding a cross-platform driver, changing the trust boundary, or allowing adapter code into the
product requires a superseding decision with fresh evidence.
