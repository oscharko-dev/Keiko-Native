# Internal macOS release evidence

ADR-0007 defines the Foundation v0.1 internal release ceiling. This runbook does not authorize a
public release, Developer ID signing, notarization, stapling, update delivery, or Apple credentials.

## Canonical local verification

Use the pinned repository toolchains on Apple Silicon macOS:

```bash
npm ci --ignore-scripts
npm run native:dependencies
npm run release:verify
```

The last command runs two independent immutable-snapshot `native:package` builds, requires exact
application inventory and package-manifest identity, creates one candidate image from each package,
parses the primary and Joliet descriptors and their bounded directory trees, normalizes only volume,
directory-recording, and exact supported four-timestamp `TF` fields to the source epoch, and
requires final byte identity. It then mounts and copies the retained image, validates every closed
record, and publishes the verified bundle only to
`native/target/keiko-native-internal-release/`. Mounted ISO verification requires exact paths,
sizes, and digests, no extras or privilege modes, an executable application binary, and rejected
write-open attempts for every file. ISO 9660/Joliet projects regular-file modes as `0755`, including
package files recorded as `0644`; copied modes are therefore restored only from the validated
package manifest before the copied path, mode, size, and digest inventory is checked exactly. The
target directory is generated evidence and is not committed.

The directory must contain exactly:

- `Keiko-Native-0.1.0-internal-arm64.dmg`;
- `SHA256SUMS`;
- `package-manifest.json`;
- `release-manifest.json`;
- `release-verification.json`; and
- `sbom.spdx.json`.

The `.dmg` is a deterministic read-only ISO 9660/Joliet disk image for internal testing. It is not
a signed or notarized Apple distribution image. The manifest and verification receipt must bind
the exact 40-character source revision; `SHA256SUMS`, the release manifest, SPDX record, and GitHub
attestation must bind the same artifact digest.

## GitHub evidence

`.github/workflows/internal-release.yml` runs only for pull requests targeting the accepted epic
branch or by explicit workflow dispatch. `macos-14` builds and verifies the exact revision before
attestation and upload. `macos-26` downloads that exact revision-bound artifact, verifies its
GitHub attestation, and reruns the mounted bundle verification. Retention is 14 days.

An accepted receipt requires both jobs on the same exact head. A missing artifact, unknown file,
wrong digest or revision, invalid SBOM, attestation failure, non-identical candidate, mounted
content or effective-read-only failure, copied inventory failure, cancellation, partial
publication, or cleanup failure is a failed release check. Manual notes cannot replace any of
those automatable claims.

## Updater boundary

The repository currently owns only the offline metadata verifier in
`quality/update-metadata.mjs`. Its public key, clock, and replay observation are supplied by the
caller, and its output is verified metadata plus a bounded replay token. There is no network,
download, persistence, installation, rollback, production key, or product updater implementation.

Issue #59 owns the public Apple distribution and production updater follow-up. Until it is accepted
and complete, never describe an internal artifact as trusted for general users or publish it as a
release.
