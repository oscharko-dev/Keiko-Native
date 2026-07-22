# ADR-0007: Internal unsigned macOS release engineering

## Status

Accepted.

## Context

Epic #9 contract v6 and issue #13 contract v3 need an exact-head, reproducible internal macOS
artifact without making a public-distribution claim. The repository has no paid Apple Developer
Program credential or approved key-custody boundary. Developer ID signing, Apple notarization,
stapling, public publication, and a production updater therefore cannot be completed honestly in
this issue. Issue #59 owns that later public-distribution decision and implementation.

The existing `native:package` gate produces and validates the accepted ADR-0006 application bundle
from a private exact-tree snapshot. Its `native:signing` gate deliberately proves the unsigned
package contract and rejects Apple credentials. Internal release engineering must build on that
validated package without adding product capabilities, weakening the public-release standard, or
allowing provider and workflow data to enter the application.

Conventional writable HFS+ and UDF images created by `hdiutil create` contain variable image
metadata and did not produce identical bytes in a two-build experiment. `hdiutil makehybrid` with
fixed ISO 9660 and Joliet inputs varies the primary and Joliet volume creation and modification
timestamps and the Rock Ridge/SUSP payload timestamps across independent clean builds. Parsing the
descriptor sequence and both directory trees, then normalizing only the standard recording fields
and exact supported four-timestamp `TF` entries to the source epoch, produces identical read-only
bytes. The format preserves the closed bundle content inventory, mounts on macOS, and supports a
verified copy-out journey. The mounted ISO projects regular-file permission bits as `0755`,
including source files recorded as `0644`, so mounted mode equality would be a false claim. The
mounted filesystem is nevertheless effectively read-only and the required application binary
remains executable.

## Decision

Keiko Native adopts a closed **internal unsigned** macOS release lane for Foundation v0.1.

The canonical command is `npm run release:verify` on Apple Silicon macOS. It first runs
`native:package`, then packages the validated `Keiko Native.app` in a deterministic read-only ISO
9660/Joliet disk image named `Keiko-Native-0.1.0-internal-arm64.dmg`. The `.dmg` suffix is the
internal artifact name; the deterministic content format is explicitly ISO 9660 with Joliet, not a
writable UDIF/HFS+ image and not evidence of Apple trust.

The release command must:

- bind the source revision and source epoch to the exact Git commit;
- normalize package timestamps to that source epoch;
- reject symbolic links, non-regular payloads, unknown files, unsafe modes, and path escape;
- bind the source and package payload to the exact sorted path, mode, size, and digest inventory
  before image construction;
- run two sequential, independent immutable-snapshot native package builds and require their exact
  application inventories and package manifests to match;
- parse exactly one primary and one valid Joliet volume descriptor and their bounded directory
  trees, reject malformed descriptors, records, extents, cycles, and unsupported `TF` layouts,
  normalize only volume creation and modification, directory recording, and all four supported
  short `TF` timestamps to the source epoch, and require the resulting images to match byte for byte
  before retaining either build;
- mount the retained image read-only and require the exact sorted path, size, and digest inventory,
  no extra files, no set-user-ID or set-group-ID modes, retained application executable capability,
  and rejected write-open attempts for every payload file;
- copy the application out, restore modes only from the already validated package inventory, and
  require the copied path, mode, size, and digest inventory to match that trusted inventory exactly;
- publish only after build and verification both succeed, using a private staging directory and an
  atomic directory rename;
- clean staging, candidate, mount, and verification state after success, failure, or cancellation;
  and
- emit only closed reason codes and records without paths, credentials, endpoints, raw provider
  data, user content, or environment values.

The retained bundle contains exactly:

- the internal `.dmg` disk image;
- `SHA256SUMS`;
- `package-manifest.json` from the validated native package;
- `release-manifest.json` with exact source, toolchain, artifact, and payload inventory identity;
- deterministic SPDX 2.3 `sbom.spdx.json`; and
- `release-verification.json` recording the closed verification outcomes.

GitHub Actions builds only on the fixed `macos-14` runner, verifies again on the fixed `macos-26`
runner, and binds checkout, artifact name, attestation, and verification to one exact revision. The
workflow uses only pinned action SHAs, has empty top-level permissions, grants build-job
`contents: read`, `id-token: write`, and `attestations: write`, verifies GitHub artifact attestation
before upload and after download, and retains the revision-bound artifact for exactly 14 days.
It cannot run from `pull_request_target`, use an environment, write repository contents, create a
tag or release, or publish a public download.

The updater boundary is contract-only. `quality/update-metadata.mjs` defines a closed, bounded UTF-8
JSON envelope authenticated with Ed25519. Verification authenticates canonical bytes before
compatibility, time, and replay policy. It rejects duplicate or unknown fields, malformed sizes and
timestamps, wrong key types, invalid signatures, channel/platform/architecture mismatch,
downgrades, not-yet-valid or expired records, and replay-check failure. Clock, public key, and the
read-only replay predicate are injected. No network client, key generation or custody, persistence,
download, install, rollback, application UI, or product updater capability is authorized here.

## Consequences

Developers and CI receive a free, reproducible, inventory-bound macOS artifact suitable for
internal testing. Exact-head SHA-256, SPDX 2.3, package evidence, two-run identity, mounted content
and effective-read-only verification, mode-restored copy-out, and GitHub attestation provide
auditable internal provenance without implying Apple verification.

The artifact is not a public release. Gatekeeper may warn or refuse ordinary installation because
the application has no Developer ID signature or notarization ticket. No document, workflow, file
name, or green check may describe it as trusted, notarized, production-ready, App Store-ready, or
safe for general distribution.

Issue #59 may be scheduled when the maintainers choose to prepare a first public release. It must
establish paid Apple identity and least-privileged secret custody, Developer ID signing,
notarization and stapling, public channel publication, signed update generation and key rotation,
rollback and recovery, supported installation UX, and physical Gatekeeper evidence. It must retain
or supersede the deterministic inventory and exact-head provenance controls in this ADR; the
internal lane is not technical permission to bypass those obligations.

## Reopen conditions

A superseding decision is required before changing the image format, artifact identity, retention,
runner authority, signing model, attestation producer, public distribution ceiling, updater trust
root, metadata schema, key or replay policy, platform, or architecture. A failure of two-build byte
identity, mounted content or effective-read-only verification, copied inventory, exact-head
binding, or attestation fails closed and reopens the affected mechanism rather than permitting an
exception.
