# Keiko for Quality integration

The organization GitHub App `Keiko for Quality` (App ID `4290143`) serves both Keiko repositories
from the independent Cloudflare Worker control plane maintained in `oscharko-dev/Keiko`.

For Keiko Native the Worker must accept `oscharko-dev/Keiko-Native`, discover open pull requests
against `dev`, and evaluate the Native required-check profile. It may write only checks and
redacted pull-request dashboard comments. It receives no repository contents, Actions,
Administration, or secret permissions.

The aggregate remains advisory. It must not enter `dev` protection until negative probes for stale
heads, wrong producers, failed direct checks, Socket warnings, Sonar failure, missing evidence, and
worker reconciliation all block, followed by a complete positive probe. Its own repair and
deployment path must remain independent of the gate it evaluates.
