# End-to-end encryption

**Date:** 2026-08-02

**Status:** Proposed

**Issue:** [#13](https://github.com/KenTaniguchi-R/agentcall/issues/13)

**Scope:** Specifies stages 1 and 2 below. Stages 3 and 4 are described only far
enough to show that this design does not preclude them; each needs its own spec.

## Decision

Call content is encrypted end to end between the caller's and callee's CLIs. The
relay routes ciphertext and holds no key that can open it.

Two key types, never one. A **stable identity key** is pinned by contacts and is
the trust root. **Short-lived encryption keys** are signed by it and rotate
freely. Pinning a rotating key would make every legitimate rotation
indistinguishable from an attack, which trains users to accept the one warning
that matters.

Payloads are sealed with HPKE ([RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html))
using `DHKEM(P-256, HKDF-SHA256)` / `HKDF-SHA256` / `AES-128-GCM`. P-256 rather
than X25519 because Apple's Secure Enclave and most TPMs support P-256 only, so
a hardware-backed enterprise tier stays reachable without a wire-format break.
It is also the lower-dependency choice: `DhkemP256HkdfSha256` ships in
`@hpke/core`, while X25519 requires the separate `@hpke/dhkem-x25519` package.

Senders sign inside the ciphertext, using HPKE **base** mode rather than auth
mode. Auth mode authenticates the sender at the KEM layer but does so
*deniably* — the recipient can construct transcripts that appear authenticated
to itself, so the ciphertext is not evidence to a third party. A product whose
value is proving who asked whom for what wants transferable proof, so
authentication comes from a signature over the transcript instead. That choice
also removes a third key: base mode needs no sender KEM key.

There is no plaintext path in the protocol and no negotiation that reaches one.

## What we claim

> The relay infrastructure cannot decrypt content produced by uncompromised,
> correctly-pinned endpoint clients.

Deliberately narrower than "we cannot read your data". We also control CLI
distribution, so a malicious update could exfiltrate keys. The claim excludes
endpoint and supply-chain compromise; the release provenance work
(issue [#122](https://github.com/KenTaniguchi-R/agentcall/issues/122)) is what
backs the excluded half.

## Threat model

### Defended

| Adversary capability | Mechanism |
|---|---|
| Relay reads call content | HPKE payload encryption |
| Relay forges a request as another handle | Sender signature over the transcript, verified against the pinned identity key |
| Relay forges a reply from the callee | Same, response direction |
| Relay replays a captured call | Caller-generated `request_id`, authenticated expiry, atomic reservation |
| Relay tampers with a peer outcome | Peer-authenticated outcome union |
| Relay serves a stale, compromised key | Monotonic epoch plus client memory of the highest accepted |
| Relay begins intercepting an established relationship | Identity pinned on first contact |

### Not defended, by decision

- **Relay interception of a first contact.** Inherent to trust-on-first-use.
  Mitigated by out-of-band fingerprint comparison, not eliminated.
- **`groups[]` under a malicious relay.** The relay is the sole authority on
  roster membership, so a relay signature would prove only that the relay made
  the claim. No cryptographic fix exists at this layer. Stage 4.
- **Endpoint compromise.** The callee holds plaintext by definition.
  `packages/cli/src/listener.ts` additionally writes `message.slice(0, 500)` of
  every call to a local calls log.
- **Metadata.** Caller, callee, presence, call frequency, ciphertext sizes,
  timing, duration, delivery status, IP and connection metadata.
- **Availability.** The relay can deny service, forge `offline`, delay, or
  cancel. Encryption does not address this.

## Staging

Each stage ships something usable on its own.

| Stage | Delivers | Also unblocks |
|---|---|---|
| 1 — Key infrastructure | Identity keys, signed encryption-key records, publication, pinning, `agentcall verify`. No encryption yet. | [#101](https://github.com/KenTaniguchi-R/agentcall/issues/101), [#100](https://github.com/KenTaniguchi-R/agentcall/issues/100), [#52](https://github.com/KenTaniguchi-R/agentcall/issues/52) |
| 2 — Encrypted payload | HPKE base mode with signed transcripts, replay protection, encrypted outcome union, fail-closed. This is the #13 claim. | #13 |
| 3 — Per-call forward secrecy | One-call ephemeral recipient keys. Additive if stage 2's envelope is built for it. | — |
| 4 — Capability credentials | Replaces relay-attested `groups[]`. Requires its own design. | [#15](https://github.com/KenTaniguchi-R/agentcall/issues/15) |

Stage 1 is worth doing even if stage 2 slipped: signed AgentCards (#101) already
wants exactly this primitive.

## Key architecture

| | Identity key | Encryption key |
|---|---|---|
| Algorithm | ECDSA P-256 | HPKE `DHKEM(P-256, HKDF-SHA256)` |
| Lifetime | Years; effectively permanent | 30 days maximum; rotates routinely |
| Pinned by contacts | Yes — the trust root | No |
| Rotation | Exceptional, needs re-verification | Routine, cryptographically verifiable |
| Hardware-backable later | Yes | Yes |

Identity signing and HPKE recipient decryption use **two distinct private
keys**. They share a curve; they must not share a scalar. Base mode requires no
third sender-authentication key.

Encryption-key validity is bounded: `not_after - not_before` must not exceed 30
days. Rotation cadence within that bound is an implementation choice, but a
record outside it is rejected.

### One identity key per line, not per machine

A **line** is exactly one handle on one relay, and one machine may hold several.
Both key pairs are therefore stored per line — `~/.agentcall/lines/<name>/identity.key.json` —
not once per install.

This follows from what an identity key *is*. It is the trust root **for an
address**, and every record it signs names an address. A machine-scoped
identity key would put one private key behind two addresses, so the holder of
line A could mint a valid, correctly-signed encryption-key record for line B's
address; contacts who pinned that key for A would accept it for B. The relay is
modeled as an adversary here, and this would hand it a second address for free
every time a user added a line.

It is also the same rule the rest of the per-line state already follows:
rosters, the bundle cache, and the context stores are all keyed to an audience,
and machine-scoping any of them leaks one audience into another. The identity
key is the sharpest case, because what leaks is signing authority rather than
data.

Consequences: each line generates, publishes, and rotates its own keys, and its
own epoch counter. Two lines on one machine are cryptographically unrelated,
which is the intent — nothing should let a contact of one line prove the other
belongs to the same person.

### Records

Published at registration, pinned on first contact:

```
IdentityRecord {
  v:            1
  address:      "ken@agentcall.benree.tech"   // handle + relay origin
  identity_pub: <SEC1 P-256 point>
}

fingerprint = SHA-256(canonical(IdentityRecord))
```

Fetched per call, cached, verified against the pinned identity key:

```
EncryptionKeyRecord {
  v:          1
  address:    "ken@agentcall.benree.tech"
  key_id:     <first 16 bytes of SHA-256(pub)>
  suite:      "DHKEM(P-256,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM"
  pub:        <SEC1 P-256 point>
  epoch:      <monotonic integer, per address>
  not_before: <epoch ms>
  not_after:  <epoch ms>
  prev:       <first 16 bytes of SHA-256 of the previous epoch's transcript, or null>
}

signature = ECDSA-P256-SHA256(identity_key, canonical(EncryptionKeyRecord))
```

Each field earns its place:

- **`epoch`**, with clients remembering the highest accepted, prevents rollback.
  Without it the relay serves a validly signed but compromised older key.
- **`not_after`** lets a cached record remain usable when the relay is
  unreachable, without remaining usable forever.
- **`prev`** chains records, so a client seeing epochs 5 and 7 knows it missed 6
  rather than silently accepting a fork. It hashes the previous epoch's
  *transcript* — the same canonical bytes that were signed — not the JSON
  record, which has no single serialization to hash. Truncated to 16 bytes and
  hex-encoded (32 characters), matching `key_id`'s width: 128 bits of
  second-preimage resistance is enough for a chain link, and a fixed short
  width keeps the record small.

### Canonical encoding

Signed and authenticated bytes use canonical CBOR or an explicitly
length-prefixed binary encoding. Not `JSON.stringify` — key order and Unicode
escaping are not stable enough to sign over, and that instability is a
well-known source of signature-bypass bugs.

### Identity key rotation and loss

Rotation while the old key is still held: sign a rotation certificate with the
old identity key. Contacts verify it and update the pin without user action.

Loss: no cryptographic path exists. It is a new identity and every contact must
re-verify out of band. The pin must never update silently, because a silent
update is precisely the attack being defended against.

This makes the recovery credential in #52 more load-bearing than it appears, and
argues for backing up the identity private key at generation time.

## Envelope

Sign-then-encrypt. The signature is inside the ciphertext, so the relay cannot
harvest signatures that prove who communicated with whom, while the recipient
can still reveal plaintext plus signature to produce transferable proof when an
audit requires it.

The known weakness of sign-then-encrypt — a recipient re-encrypting a signed
message to a third party and claiming it was addressed to them — is closed by
binding the recipient's address and key id into the signed transcript.

```
call_request {
  to:     "ken"        // cleartext, routing
  key_id: <16 bytes>   // which recipient encryption key was used
  epoch:  <int>        // rollback check
  enc:    <65 bytes>   // HPKE encapsulated key, SEC1 P-256 point
  ct:     <AEAD ciphertext>
}
```

Signed transcript, inside the ciphertext:

```
v, direction, relay_origin, from, to,
request_id, sender_identity_key_id,
recipient_encryption_key_id, recipient_epoch,
issued_at, expires_at,
task, context_id, message
```

AAD, authenticated but not encrypted, carrying only what the relay must already
see:

```
v || direction || relay_origin || from || to || key_id || epoch
```

HPKE `info` is capped at 128 bytes, so it carries only the stable domain string
(`"agentcall/v1/request"` or `"agentcall/v1/response"`). Per-call binding goes in
`aad`, which is unbounded.

`request_id` is inside the ciphertext rather than the AAD. The callee decrypts,
then reserves, then evaluates policy. This costs one decryption on a replayed
frame — cheap, and bounded by existing rate limits — and in exchange the relay
learns one fewer identifier.

### Field visibility

| Field | Visibility | Reason |
|---|---|---|
| `to`, `from`, `call_id` | Cleartext | Routing, rate limiting, roster lookup |
| `groups[]` | Cleartext | The relay authors this field; encrypting it protects nothing from the relay |
| `task` | Encrypted | Per-caller private grants exist, so an invocation reveals that a private capability relationship exists |
| `context_id` | Encrypted | Cleartext gives the relay conversation linkability across calls |
| `message`, reply text, peer `detail`, `offered[]` | Encrypted | Content |

Encrypting `task` removes the relay's ability to record which capability was
requested. When a central audit trail is wanted, the replacement is a signed
audit event emitted by the endpoint and encrypted to a separate auditor key,
which the relay stores or forwards without learning. Deferred, not precluded.

## Replay protection

The relay mints `call_id` only after receiving the request
(`apps/relay/src/do.ts`), so the caller cannot bind it without a preflight round
trip. `request_id` — 128 random bits, caller-generated — is the security
identifier. `call_id` remains routing and operational correlation only.

Callee order of operations:

1. Decrypt and verify the sender signature against the pinned identity.
2. Validate `expires_at - issued_at <= RELAY_CALL_TIMEOUT_MS`.
3. Validate `now < expires_at` and `issued_at` no more than two minutes ahead.
4. Atomically reserve `(sender_identity_fingerprint, request_id)`. A concurrent
   duplicate is a replay.
5. Only then evaluate policy and spawn the agent.

The reservation store persists so a listener restart does not reopen the window,
holds nonce and expiry only, never content, and evicts at `expires_at` plus
skew. Authenticated expiry is what makes eviction safe: without it, evicting
ever permits a delayed replay. At `RATE_LIMIT_PER_HOUR` the store stays small;
it reuses the bounded-store pattern already used for contexts.

Responses bind to their request by `request_id` and a hash of the request
transcript, so the relay cannot splice a valid reply from one call into another.

## Outcome authentication

Every failure currently reaches the caller in the same shape. Under a hostile
relay this is exploitable: forging `blocked` makes the caller believe they were
refused, and forging `task_not_offered` with a misleading `offered[]` steers
them toward a different capability.

| Origin | Frames | Trust |
|---|---|---|
| Relay, operational | `offline`, `rate_limited`, `timeout`, `unknown_handle`, `protocol_error` | Unauthenticated claim |
| Peer, semantic | reply text, `blocked`, `task_not_offered`, `offered[]`, `task_unknown`, `context_unknown`, `agent_error`, `detail` | Sealed and signed by the peer |

The CLI renders the two differently. "The relay says they are offline" and "they
refused you" are different facts and must not print identically.

## Failure modes and availability

- Fail closed. No plaintext path, no null-cipher negotiation, no override flag.
  A peer without a published key cannot be called.
- Cached encryption-key records remain usable while `not_after` holds, so an
  unreachable relay does not block calls between established contacts.
- A changed identity pin hard-fails in non-interactive contexts — the listener,
  CI, any non-TTY. Only an interactive terminal offers accept or abort. A
  warning that an automated agent accepts is a downgrade in practice.
- `agentcall verify <address>` prints the fingerprint for out-of-band
  comparison. `agentcall trust --reset <address>` is the explicit re-pin.
- Setup is transactional: registration must never succeed while pointing at a
  key that failed to write.
- The private key is `0600` inside a `0700` directory, created exclusively,
  opened symlink-safely, with permissions re-checked on every load and verified
  by `agentcall doctor`.

The `0600` file protects against other unprivileged local accounts. It does not
protect against malware running as the user, backups and filesystem snapshots,
an administrator, or a malicious CLI update. Hardware-backed keys are the
enterprise-tier answer and are why P-256 was chosen.

Caller-only installs must also generate keys: a caller authenticates its
requests and decrypts replies.

## Responsibilities that move to the client

- **Terminal sanitization.** Peer-controlled display text must be sanitized at
  the display sink. This is already a live defect
  ([#164](https://github.com/KenTaniguchi-R/agentcall/issues/164)) and becomes
  mandatory here, because the relay will no longer be able to see the text.
- **Size limits in three places.** The relay caps the ciphertext frame; the
  recipient caps the WebSocket payload before parsing or allocating; the
  recipient caps post-decryption UTF-8 bytes. The caller enforces the reply
  bound independently, because the callee may be hostile.
- **No compression.** Compression before encryption leaks through length, and
  decompression bombs are a separate problem.

## Testing

- RFC 9180 known-answer vectors, to prove our integration rather than the
  library.
- Negative tests: wrong key, tampered AAD, tampered ciphertext, expired
  envelope, replayed envelope, rolled-back epoch, unsigned key record, record
  signed by the wrong identity.
- A changed pin hard-fails in non-interactive mode.
- A peer with no published key is refused, and no plaintext reaches the socket.
- A test that scans the wire bytes for the plaintext message, which is the test
  that catches encryption silently not happening.

## Residual leakage, documented

Caller and callee addresses, presence, call frequency, ciphertext sizes, timing
and duration, delivery and result status, IP and connection metadata. Ciphertext
length tracks plaintext length; padding to coarse size buckets is possible but
not proposed here.

## Deferred

- Per-call ephemeral recipient keys (stage 3). Because the callee must be online
  for a call to occur, per-call forward secrecy is reachable without an X3DH-style
  prekey pool: the callee mints a one-call key on demand and deletes it after
  opening. This costs a round trip and requires a carefully specified
  authenticated handshake, which is why it is staged rather than assumed.
- Capability credentials replacing relay-attested `groups[]` (stage 4).
- Signed audit events encrypted to a separate auditor key, restoring a central
  record of which capability was requested.
- Key transparency, which would remove the first-contact interception window
  that trust-on-first-use leaves open.

## Provenance

Reviewed adversarially through Codex before adoption. That review corrected the
original proposal in five material ways: a pinned key cannot also be a rotating
key; base-mode HPKE lets the relay forge in both directions; relay-generated
`call_id` is the wrong replay root; scheduled rotation is epochal key-erasure
protection rather than per-call forward secrecy; and the encrypted field set was
too narrow. It also identified #164 and the local calls-log persistence, both of
which were verified against source before being recorded here.

`@hpke/core` must be version-pinned, and auth-mode parameters, P-256 point
validation, Node compatibility, and Cloudflare Workers behaviour verified
against the pinned version before implementation begins.
