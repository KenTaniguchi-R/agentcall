# Credential lifecycle

> **Historical design record — not current documentation.** This file is
> dated and never revised; it explains why the 2026-08-02 decision was made,
> not what the code does now. Read the repository `README.md` and
> `CHANGELOG.md` for current behavior. The living reference is in
> [`docs/research/reference-implementations.md`](../../research/reference-implementations.md).

**Date:** 2026-08-02

**Status:** Decided; runtime implementation belongs to #154 after #52

**Issue:** [#98](https://github.com/KenTaniguchi-R/agentcall/issues/98)

## Decision

AgentCall will implement expiry, revocation, liveness, and safe overlap directly
on the credential model decided in #100. It will not add a temporary
`last_used_at` or `revoked_at` to the current `handles` row.

Each stable agent identity will use two credential layers:

1. A **client credential** is a relay-unique public credential ID plus a
   high-entropy secret generated and retained by the CLI; only its digest is
   registered with the relay. It has a 90-day hard lifetime, is independently
   revocable, and exchanges for access tokens.
2. An **access token** is a separate opaque reveal-once credential with a
   one-hour lifetime. It authorizes normal HTTP and WebSocket operations for
   the identity and remains valid only while its parent client credential and
   identity are active.

The CLI exchanges automatically, begins client-credential rotation with 30
days remaining, and refreshes an access token before five minutes remain.
Normal rotation permits old and new client credentials to overlap for at most
24 hours and revokes the old one as soon as the new credential has been saved,
exchanged, and proven against the relay. Recovery is different: redeeming the
recovery proof revokes every existing client credential and descendant access
token in the D1 transaction that creates replacement login and recovery
material, then idempotently evicts the revoked sessions.

This is option C from the issue, implemented as part of the zero-user identity
cutover in #154 rather than layered onto the obsolete handle row. Option B was
a sensible incremental recommendation before the identity/address decision;
it would now create migration and application code whose only purpose is to be
deleted by the immediately following cutover.

## Current behavior

The current relay stores one immortal `token_hash` on `(org, handle)`.
Authentication selects the row by caller-supplied organization and handle and
compares that hash. There is no expiry, last-used time, credential ID, list,
individual revocation, or parent/child provenance.

`POST /v1/token/rotate` verifies that token and replaces its hash immediately.
The old proof dies before the CLI can persist or verify the new one. A process
failure can therefore strand the install, concurrent rotations can return a
credential that is already dead, and any listener still holding the old token
must restart. An already-open WebSocket is not reauthenticated and can outlive
a later token replacement.

The recorded migration path contains a recovery-specific alteration, while the
current runtime has no recovery protocol. #52 owns the final recovery schema
and remains the prerequisite for #154. This decision does not edit that active
path in parallel.

## Client credentials

A client credential belongs to exactly one `agent_id` and has at least:

- relay-unique, non-secret `credential_id` used for lookup and audit;
- a hash of the high-entropy secret, never the secret itself;
- creation and absolute expiry timestamps;
- last-used and revoked timestamps;
- description/provenance sufficient to distinguish setup, normal rotation,
  recovery, and later administrator issuance; and
- an optional overlap deadline when it is the old side of a rotation.

The compact login string may encode the public ID and secret, but the CLI keeps
that representation opaque in routine output. Prefix lookup follows #100's
collision rule: storage uniqueness and generation retries, never first-match
selection among several candidate identities.

The CLI generates at least 256 bits of secret entropy and sends only its digest
when setup or rotation registers a client credential. The request carries a
high-entropy operation ID; retrying the same operation returns the same public
credential ID without creating another row. The idempotency record is bound to
identity, operation kind, credential/recovery generation, candidate public IDs
and digests, and the invite or recovery generation authorizing it. Reusing an
ID with a changed payload, another identity, or another operation fails. Records
have bounded retention beyond the longest retry window. This avoids a
response-loss window where the server has committed the only copy of a
reveal-once replacement secret that the client never received.

Expiry bounds relay acceptance; it does not secure a plaintext secret at rest.
#108 still owns OS-keychain storage and process-access boundaries. Until that
lands, current configuration-file risk remains explicit even after lifecycle
semantics are implemented.

Ninety days is a hard lifetime, not a default that can silently become
unbounded. The first implementation uses the fixed policy above. A later
organization policy may shorten it, but lengthening it or disabling expiry is
a separately reviewed exception with explicit owner-visible posture.

Under the current one-install-per-identity model, the identity may hold two
active client credentials during normal rotation. Issuing a third is rejected
until one is revoked or expired. Recovery and identity-disable operations are
allowed to revoke the whole set atomically. This keeps the overlap bounded and
makes a credential inventory meaningful. #44 must revisit the cap explicitly
if several lines ever share one identity instead of receiving distinct
identities and credentials.

## Access tokens

The exchange endpoint verifies the client credential and identity status, then
returns a new opaque access token and server-authored `expires_at`. Only the
token hash, public token ID, parent credential ID, identity ID, issuance time,
expiry, and revocation state persist. No refresh token exists: refresh is
another client-credential exchange.

The access-token deadline is the earliest of its one-hour TTL, its parent
client credential's hard expiry, and any earlier parent overlap deadline. The
WebSocket uses that same effective deadline. A child minted shortly before a
parent deadline cannot extend the parent's authority.

Every authenticated HTTP request checks all of these conditions and fails
closed if storage is unavailable:

- access-token secret hash matches the selected token ID;
- access token is unexpired and unrevoked;
- parent client credential is unexpired and unrevoked;
- identity is active; and
- an active address exists unless the route is the narrow address-rebind flow
  defined by #100.

Opaque tokens fit the current centralized Worker/D1 trust boundary better than
self-contained JWTs. AgentCall already performs a D1 authentication lookup, and
opaque state makes parent revocation immediate without a distributed JWT deny
list. A future federation token is a separate protocol decision.

Access-token issuance is rate-limited and retained storage is bounded. Expired
or revoked tokens are deleted after their audit/incident window; the runtime
must not accumulate one row per hourly listener refresh forever. Exact cleanup
batch and retention values belong to the data-retention implementation review,
but a production alarm is required before the table reaches its configured
bound.

## Listener and CLI continuity

Normal commands exchange in memory and do not need to persist each one-hour
access token. The long-running listener keeps its current access token in
memory, obtains a replacement before the five-minute threshold, authenticates
the replacement, then reconnects. A WebSocket receives the token expiry at
admission and is closed no later than that deadline; otherwise a one-hour token
could authorize an immortal connection.

Client-credential rotation is ordered:

1. serialize local rotation with a lock shared by CLI and listener processes;
2. generate and persist a candidate secret plus operation ID atomically without
   discarding the old fallback;
3. register its digest while the old credential remains valid, retrying the
   same operation ID until the public credential ID is known;
4. exchange and prove the new credential, then reconnect the listener;
5. revoke the old credential and all of its descendant access tokens; and
6. remove the fallback from local storage.

If the process fails before the proof step, the old credential keeps the
install online and the new credential remains visible in the server inventory.
The next run lists the identity's public credential inventory, revokes an
unrecognized pending replacement while authenticated by the known old
credential, and only then retries; it does not mint a third. If revocation of
the recognized old credential is not completed, that old credential expires at
the 24-hour overlap deadline.

The CLI starts rotation with 30 days remaining so a laptop can be offline for a
meaningful interval without crossing the 90-day hard stop. `agentcall doctor`
warns before rotation or expiry failures become outages. A device offline past
hard expiry must use #52 recovery or administrator re-enrollment; silently
extending the secret would make the expiry claim false.

## Last-used semantics

`last_used_at` is a coarse liveness signal, never an audit log and never sole
authority for automatic handle reclaim.

A successful client-credential exchange updates that credential at most once
per hour. Authentication already reads the stored value; only a stale value
causes a conditional update, so normal requests do not create a D1 write per
call. Successful access-token use may be counted in Analytics Engine for abuse
and operations, while security mutations remain in the audit ledger.

Failure to record the coarse timestamp does not turn a verified request into an
authentication failure, but it emits an operational signal. Expiry and
revocation checks themselves fail closed. #16 may use last-used data as one
input to offboarding/reclaim review, not as proof that an identity is abandoned.

## Revocation and live sessions

Revocation has explicit scope:

- revoking one access token invalidates only that token;
- revoking or expiring a client credential invalidates every descendant access
  token;
- normal rotation revokes the replaced client credential after the new one is
  proven;
- recovery revokes all client credentials and access tokens for the identity;
  and
- disabling an identity rejects every credential, including address rebind.

D1 state blocks the next HTTP request or WebSocket handshake. That is
insufficient for an established socket. Today a caller socket is stored in the
callee's Durable Object, which makes caller-wide revocation require an
unbounded scan of other identities. #154 therefore changes connection
ownership: every physical caller and listener WebSocket terminates in the
authenticated subject's identity Durable Object. Caller-owned DOs proxy call
coordination to callee-owned DOs; a target never owns the caller's socket.

The identity DO records access-token ID, parent-credential ID, effective expiry,
and identity/address authorization epoch for every connection. It also retains
revoked-token and revoked-parent tombstones until those credentials could no
longer be valid. Admission and disconnect commands are serialized in that same
DO:

- if a stale handshake attaches first, the later idempotent revoke command
  records its tombstone and closes the matching socket;
- if the revoke command arrives first, the tombstone rejects the later attach;
  and
- release or identity disable increments an authorization epoch, so a handshake
  validated under the older epoch cannot attach after the command.

Revocation reports whether the identity DO confirmed eviction. Persistent D1
state prevents reconnect if command delivery is delayed, while a bounded retry
path and alarm continue delivery. “Immediate eviction” is not claimed until
the subject-owned DO acknowledges the new state.

Normal expiry also closes the WebSocket at its access-token deadline. A client
refreshes before then; it does not extend an existing connection merely by
possessing a newer token. Address release and identity disable likewise send an
idempotent command to close every session for the identity, because an
already-admitted socket must not route around the new lifecycle state.

## Recovery is not renewal

#52's recovery proof is an out-of-band root for regaining control after every
online credential is lost. It is not sent on normal requests, exchanged hourly,
or used to avoid client-credential expiry.

The recovery proof is outside the 90-day online-client lifecycle. #52 owns its
exact time policy, but it must be generation-versioned, single-use,
revocable/reissuable while logged in, and invalidated whenever a successor is
created. If it is intentionally non-expiring so an offline backup can recover a
long-abandoned identity, documentation and doctor report it as the sole
long-lived full-authority exception rather than implying that every credential
expires.

Successful recovery is a security reset. Before the request, the CLI generates
and durably saves a candidate **client** secret and high-entropy operation ID in
pending online-credential state. It generates the successor recovery proof in
memory, displays/exports it once to a user-chosen out-of-band store, and requires
acknowledgement before continuing. The user must retain both the current and
successor recovery proofs in that out-of-band store until the relay's public
credential receipt is confirmed; only then does the CLI instruct them to remove
the consumed predecessor. The recovery proofs are never written to AgentCall
config, state, logs, or the same credential store as the client secret.

A resumed operation asks the user to provide both proofs. The consumed current
proof authorizes only an exact replay of its already-bound operation receipt;
it cannot authorize a different payload or another recovery. The successor
proof verifies that the acknowledged backup still matches the committed
successor digest. This two-phase handoff prevents a crash after commit and
before receipt confirmation from stranding the new client credential's public
ID.

The CLI sends the candidate digests with the current recovery proof. One D1
transaction consumes that proof, revokes all online credentials, and registers
the replacement digests and public IDs. An idempotent replay is accepted only
when the identity, recovery generation, operation kind, operation ID, and exact
candidate digests all match the committed receipt; a changed or cross-identity
payload fails. The relay therefore never owns the only copy of replacement
secret material if a committed response is lost.

After commit, the relay sends an idempotent Durable Object command to evict the
revoked sessions; that delivery is not falsely described as part of the D1
transaction. The response reports whether eviction was confirmed, and a
bounded retry path plus operations alarm continues attempted eviction.
Persistent revocation prevents reconnect even while an old socket is waiting
to close. A concurrent redemption or rotation cannot register a generation
that the D1 transaction has already superseded.

## Abuse, audit, and secrecy

Credential IDs and prefixes are public lookup/audit material; secrets, hashes,
access tokens, and recovery proofs are always redacted. Authentication failures
use one generic response so callers cannot enumerate valid IDs, status, expiry,
or identity. Failed attempts are rate-limited by both source and presented
credential prefix with bounded-cardinality limiters.

Issue, normal rotation, revoke, expire-by-policy, recovery, and identity-disable
are typed audit events. Routine successful authentication is telemetry rather
than mutation-audit volume. The server is the authority for all timestamps and
returns absolute deadlines to the CLI.

## Required acceptance tests

The #154 implementation is incomplete until tests prove:

- an access token expires after one hour and a WebSocket admitted with it is
  closed no later than the same deadline;
- an access token and WebSocket are capped by an earlier parent hard/overlap
  deadline, and release or identity disable closes every admitted session;
- an expired or revoked client credential cannot mint or sustain an access
  token, even when the child token's own expiry is later;
- normal rotation keeps the old credential valid until the new one is saved
  and proven, then revokes the old credential and descendants;
- a lost setup, rotation, or recovery response can be replayed by operation ID
  without creating a second credential or losing client-held secret material;
- after recovery commits but its response is lost, a restart can use the
  retained consumed predecessor proof only to authorize the exact receipt
  replay, verifies the retained successor proof, and does not remove the
  predecessor backup until the public credential receipt is confirmed;
- changing an idempotent payload or replaying its ID across identities,
  operation kinds, or recovery generations fails, and expired receipts cannot
  grow without bound;
- an abandoned normal rotation cannot leave more than two active client
  credentials or extend the 24-hour overlap;
- concurrent rotations/retries cannot return silently dead credentials, exceed
  the active limit, or revoke the only locally persisted proof;
- recovery atomically consumes one proof, revokes existing D1 credentials, and
  creates one new client credential and recovery proof, then idempotently
  evicts old sessions without losing the reveal-once response;
- individual access-token revocation, parent revocation, identity disable, and
  address release have the distinct scopes defined above;
- a revoked or expired credential is rejected when D1 or disconnect delivery
  races with a live WebSocket, and reconnect remains impossible;
- revoking caller A closes A's outbound sockets owned by A's identity DO even
  when calls target B and C; a stale handshake cannot attach after the matching
  tombstone or authorization epoch is applied;
- client-ID/prefix collisions, wrong secrets, cross-identity token IDs, and
  caller-supplied handles cannot select another principal;
- `last_used_at` advances no more than once per hour per client credential and
  a telemetry-write failure does not bypass expiry/revocation checks;
- access-token cleanup and issuance limits keep retained rows bounded; and
- a listener refreshes and rotates without human interaction, while an
  unrecoverable hard expiry fails loudly rather than silently extending trust;
  and
- client and recovery secrets never coexist in AgentCall's normal credential
  store, logs, or pending-operation files.

## Rejected alternatives

### Add lifecycle columns to `handles` now

Rejected because #100/#154 replace that row as the security principal. The
temporary code would conflict with #52 and then be deleted without providing a
usable revocation authority or safe rotation model.

### Keep an immortal client secret behind short-lived access tokens

Rejected because theft of the stored secret would still grant permanent token
minting. Short access-token TTL does not bound a compromise when its parent
never expires.

### Use a renewable non-expiring access token

Rejected as the default. It recreates the current immortal Bearer under a new
name. The stored client credential is the bounded secret-zero tradeoff, and
routine access authority remains short-lived.

### Preserve hard-swap rotation

Rejected because server-side replacement happens before durable local save and
verification. Restarting one listener afterward does not fix crash safety,
concurrent rotation, future lines, or CI users.

### Treat last-used as audit or automatic reclaim authority

Rejected because it is intentionally coarsened, may fail independently of
authentication, and cannot distinguish benign offline time from abandonment.

## Sources checked

Official sources were checked on 2026-08-02. Tailscale documentation was
resolved and read through Context7; Infisical documentation/current source was
reused from the immediately preceding #100 decision review:

- [Tailscale key expiry](https://tailscale.com/docs/features/access-control/key-expiry)
- [Tailscale auth keys](https://tailscale.com/docs/features/access-control/auth-keys)
- [Tailscale node keys](https://tailscale.com/docs/concepts/node-keys)
- [Infisical Universal Auth](https://github.com/infisical/infisical/blob/main/docs/documentation/platform/identities/universal-auth.mdx)
- [Infisical access-token TTL computation](https://github.com/infisical/infisical/blob/main/backend/src/services/identity-access-token/identity-access-token-fns.ts)
