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
- evaluation head `8d5894350abd2a2e8453449420661608407d0128`;
- evaluation source SHA-256
  `8a1631f2ae7ecdaf7847681ef039c2cc31d01c9cd4a93466da1fce2bb8b0e608`;
- prepared evidence SHA-256
  `2416e483a26ff591b9f8b39dea3b6b4bfd77e745e16ff2d1729bcedd1a53d33d`;
- allowed capture SHA-256
  `7133089a5fe1b69730efc83b712770faa705e82b425cd838b83b58869df08e5a`;
- denied capture SHA-256
  `89f740ac255ae6869ea2d6ab4de9a4a83f46d52211e783893670d8b194bcd591`;
- revoked capture SHA-256
  `8fe8977898d1ad23c192b4e15b941d686b34df258a47a9abf76cd81cf4921039`;
- recovered capture SHA-256
  `2a66993555f0d4abd152335a9c7e80ec290449753c02109f33f995121a7ed4fe`;
- Foundation acceptance evidence SHA-256
  `6e205640a18fa62ba974695ae667c36c75dda15b1728fe3eda1b240c2aee3d60`;
- Foundation package-manifest SHA-256
  `0e672112e252b2e72ee63233b18f3e86af389eff6f6f4518fbc5286323926795`;
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
