# Encryption-key chain continuity

**Date:** 2026-08-03

**Status:** Accepted

**Issue:** [#184](https://github.com/KenTaniguchi-R/agentcall/issues/184)

## Decision

Encryption-key records form a locally authored, forward-only chain. Epoch 1
uses `prev: null`. Every later epoch uses the first 16 bytes of SHA-256 over
the previous epoch's canonical `encryptionKeyTranscript`, encoded as 32
lowercase hexadecimal characters.

The relay never supplies chain input to the publisher. After a relay accepts an
encryption-key record, the CLI installs an immutable public epoch marker with
that record's transcript hash. Rotation requires the marker and carries its
hash into the next epoch as `previous_encryption_transcript_hash`. A failed
publication therefore cannot become a chain basis. If relay acceptance succeeds
but local persistence fails, later rotation fails closed instead of publishing
an unlinked epoch.

Before the PUT, the CLI also persists the exact pending record and signature.
If the relay commits but the HTTP response is lost, retry sends those same bytes
even if wall-clock time has advanced. The relay treats an exact retry of its
latest epoch as idempotent; a different record at that epoch, or a retry older
than the latest epoch, remains a conflict. The epoch winner remains immutable
after acknowledgement; retaining this public signed record and marker prevents
a stale publisher from reusing the same epoch slot.

Concurrent publishers converge without an ownership lock. Each signs a complete
public candidate, then exclusively creates its epoch-scoped pending filename.
The first create wins; all losers read and publish the
winner's bytes. The canonical epoch file is the election slot itself, so a
crash cannot strand a secret-bearing candidate or temporary sidecar outside
recovery's view. A non-secret election lock keeps losers from observing the
slot before the winner finishes writing and syncing it. Losers wait for a
bounded interval; an abandoned lock or interrupted canonical write fails
closed.
Because publication and acknowledgement files are immutable and epoch-scoped,
an old publisher can neither reclaim a completed epoch nor affect a later
epoch's artifact.

Rotation uses first-writer-wins election for the complete next-epoch private key
state. Current state is derived as the highest active elected epoch, never from
a replaceable current pointer. Once a successor exists, the prior epoch file is
atomically replaced with a public tombstone and the epoch-1 root becomes
identity-only; historical encryption private keys are not retained. A crash
between election and retirement is repaired on the next load by scrubbing every
lower active private state. A paused publisher or rotator can later add only an
idempotent old-epoch public marker or observe an existing epoch filename—it has
no mutable path that can roll the current epoch backward.

## Gap handling

The chain is gap-detection only. The relay serves only the latest encryption-key
record and does not expose an epoch lookup endpoint. Stage 1B (#171) pins the
current peer identity/encryption tuple but does not retain a peer epoch chain.
When continuity across peer rotations is added, it must reject a move from a
previously accepted epoch 5 to epoch 7; it cannot safely reconcile that gap from
relay-supplied history. Adding fetchable history would expand relay storage,
retention, and equivocation behavior and requires a separate decision.

This is intentional: a chain link can prove that continuity is missing, but a
malicious relay must not be allowed to choose the bytes an endpoint signs next.

## Invariants

- `prev` is null only for epoch 1.
- The hash covers the exact canonical transcript that the identity key signs,
  not JSON serialization and not a relay response envelope.
- Only successful local publication records a next-rotation chain basis.
- A lost publication response is recovered by an exact latest-epoch retry, not
  by signing a replacement record or fetching relay state.
- Rotation without a recorded successful publication fails before generating or
  writing a replacement encryption key.
- The highest active elected epoch is current; superseded files are public
  tombstones and never retain historical encryption private keys.
- Pre-chain key files are rejected: an already-published legacy epoch cannot
  safely reconstruct the exact signed record required for an idempotent retry.
- When peer continuity verification is added, missing epochs are a hard failure;
  it must not add a fallback history fetch or plaintext acceptance.
