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
unexplained failures, and left zero owned descendants. The journeys took 3208–3583 ms (3269.05 ms
mean), with an 844 ms maximum checkpoint observation. AXUIElement also failed closed under denied
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
- evaluation head `b53eceb9dc97e9d25b54486853895e67734d3c2a`;
- evaluation source SHA-256
  `8a1631f2ae7ecdaf7847681ef039c2cc31d01c9cd4a93466da1fce2bb8b0e608`;
- prepared evidence SHA-256
  `cfe6724e99dfa9655f91fcfc76af6bc20b3a408a93f8922e6019e6b66a4ada40`;
- allowed capture SHA-256
  `fd956ea36b14a389d8ed861698f81c98377d028a9ea7b993d50b14f64ee95994`;
- denied capture SHA-256
  `563d973cd62c2b843bcc96869518bd3731da692024db419de8824ede9876c68a`;
- revoked capture SHA-256
  `27f40e7115b57029c9c25a196bfb47f24e1e8c5c055c56e40e3b7a7de51cef7e`;
- recovered capture SHA-256
  `e5a737d9cd7125e1ce13b8b40fbae908fda985685e9b24ae03f27fca434ed0a4`;
- Foundation acceptance evidence SHA-256
  `38e18e251fbf955cf56ed4ecbb5e19ad340a80d4679e73a0dbcf3165893dcfda`;
- Foundation package-manifest SHA-256
  `52cae3c8756918a95613843ef6daab6fe1f010502ae2963f70de5b2e1d05d909`;
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
