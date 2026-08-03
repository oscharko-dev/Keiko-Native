# ADR-0013: Bounded macOS Accessibility journey driver

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

The external AXUIElement adapter completed 20 clean allowed repetitions against the generated
representative package. It passed 320 of 320 checkpoint operations, used two-second per-checkpoint
subprocess bounds plus a separate bounded five-second natural-quit observation, produced zero
unexplained failures, and left zero owned descendants. The journeys took 3009–3392 ms (3192 ms
mean), with an 838 ms maximum checkpoint observation. AXUIElement also failed closed under denied
and revoked Accessibility permission and recovered through a fresh process after permission was
restored.

The same predeclared profile and absolute criteria were applied to System Events before candidate
activity. System Events cannot report Accessibility state until it crosses a separate Apple Events
Automation-consent boundary, and the evaluation found no non-prompting preflight for that boundary.
Apple Event error `-1743` is Automation denial, not Accessibility denial, and an AppleScript result
containing `prompted=false` cannot prove that macOS displayed no consent prompt before the script
returned. System Events therefore failed the `authoritative-evidence-unavailable` absolute gate
before any Apple Events probe, process launch, or checkpoint. Continuing the workload would have
crossed an unauthenticated permission boundary, so all retained System Events phases contain zero
repetitions and zero operations. The no-driver baseline cannot machine-evaluate the declared
checkpoints.

The fixed weighted matrix selected AXUIElement with 490 points. System Events scored 260 and is
rejected by the `authoritative-evidence-unavailable` absolute gate. The no-driver baseline also
scored 260 and failed the absolute `missing-automatable-checkpoint` gate.

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
Automation-consent boundary. The final candidate is an inert rejection artifact: it performs no
Apple Events activity and records the prompt state as unknown. This decision treats error `-1743`
and an unknown Automation-consent state as `authoritative-evidence-unavailable`; it does not accept
the rejected prototype's classification as Accessibility denial. Interim measurements from an
already-authorized environment are superseded and are not selection evidence.

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
- evaluation head `6df13bfed5dd0d5a71031e4c7304fad998b0af27`;
- evaluation source SHA-256
  `7bb83da1c35b1590343fb14171b5da1a5ad556ed6153c7a30c79a7ce512d85d3`;
- prepared evidence SHA-256
  `dac9512a9b453081ca1ac45ed50791b7d7651a2b8975692abbcc7929813ec1e0`;
- allowed capture SHA-256
  `001a55ae22934741cc61735d15c6b399da8d5fe592e50288dbbd75d2c77f478e`;
- denied capture SHA-256
  `c5f825c61b5633b2f5e41065a8fccae5efbb69872f3369fd38f2a760dfa4dabe`;
- revoked capture SHA-256
  `82a373a1834f4520c38ad9012ac9792cc82bb5f5af91f49fd96dfd8c25ebeb5d`;
- recovered capture SHA-256
  `bf15dca8265c5ad5f429393b59eb18e2f467d5061705f11419a1a1d4eb6f60bd`;
- Foundation acceptance evidence SHA-256
  `2446fc46e06d08301b83207c31a3df8b8bdd8a37d9ccb89cd9ab346b788e1db9`;
- Foundation package-manifest SHA-256
  `8241d395cad92973dcf620117bcae7577440fd894dcb4682b0657a5b60ab3cb3`;
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
