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
8873–10237 ms (9050 ms mean). AXUIElement also failed closed under denied and revoked Accessibility
permission and recovered through a fresh process after permission was restored.

The System Events runs used an already-authorized Apple Events Automation relationship. A clean
runner may encounter the separate Automation-consent boundary before System Events can report
Accessibility state. Apple Event error `-1743` is Automation denial, not Accessibility denial, and
an AppleScript result containing `prompted=false` cannot prove that macOS displayed no consent
prompt before the script returned. The evaluation did not establish a non-prompting preflight for
that boundary, so System Events fails the `authoritative-evidence-unavailable` absolute gate. The
no-driver baseline cannot machine-evaluate the declared checkpoints.

The fixed weighted matrix selected AXUIElement with 490 points. System Events scored 485 on the
measured workload but is rejected by the `authoritative-evidence-unavailable` absolute gate. The
no-driver baseline scored 260 and failed the absolute `missing-automatable-checkpoint` gate.

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

Physical macOS Accessibility permission remains an operator-controlled prerequisite for the
selected AXUIElement adapter. Its automated probe requests no prompt. Denied or revoked
Accessibility permission returns the closed `accessibility-permission-denied` reason and performs
no journey operation. Recovery requires an explicit operator grant and a fresh process; no
automation mutates the macOS privacy database.

AXUIElement is selected because it passed every absolute gate, supplies a typed API/error boundary,
and received the matrix's full permission and diagnostics score. System Events has the smaller
build footprint, but its AppleScript boundary is less typed and crosses a separate Apple Events
Automation-consent boundary. The retained Accessibility-state results remain measured dissenting
evidence from an already-authorized environment; they do not authenticate clean-runner,
non-prompting operation. This decision treats error `-1743` and an unknown Automation-consent state
as `authoritative-evidence-unavailable`; it does not accept the rejected prototype's classification
as Accessibility denial. The candidate is therefore rejected regardless of its five-point
weighted-score difference.

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
- evaluation head `826f456df60cb5da6a5c8e814005836dc1fc78b1`;
- evaluation source SHA-256
  `cca20f5a35d41c89b2bce0f28960b1ac66404df957fa5aa7b39f2b40d975d9ee`;
- prepared evidence SHA-256
  `c08eb729d9f75795022a6b8854d951170af8bd7e10a25725ec0ccebd12cbc888`;
- allowed capture SHA-256
  `f3618e0874aa4b1e4967994e11959d9fdab92ac883362e04cd2af40e2ffd9b3a`;
- denied capture SHA-256
  `7691163736deff1c0704a218b76dc7919245dd215ddf857f7c372cefe424d000`;
- revoked capture SHA-256
  `6e062042fa20326637f55ab6a285196cfda9ed2cd27df60f15bf23480de1658a`;
- recovered capture SHA-256
  `93fe61c9ca7023a3480b0768467a52471655e56059f981aa56b41bbcdf12c70d`;
- Foundation acceptance evidence SHA-256
  `ab0a93a9f1df9c03a05582c7f7d8153e0e14a20c2001ee035bd82f3ed3e5f902`;
- Foundation package-manifest SHA-256
  `70c515d8c70a94194202f06feec0e5f636d7ff59c06bffd3987e94d1dc759cca`;
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

System Events remains rejected dissenting evidence. Replacing AXUIElement with System Events
requires a superseding decision with a distinct, non-prompting Apple Events Automation permission
model and fresh authoritative evidence. Adding a cross-platform driver, changing the trust
boundary, or allowing adapter code into the product likewise requires a superseding decision.
