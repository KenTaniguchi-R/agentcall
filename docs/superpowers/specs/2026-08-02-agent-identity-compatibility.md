# Agent identity compatibility

> **Historical design record — not current documentation.** This file is
> dated and never revised; it explains why the 2026-08-02 decision was made,
> not what the code does now. Read the repository `README.md` and
> `CHANGELOG.md` for current behavior. The living standards watch list is in
> [`docs/research/reference-implementations.md`](../../research/reference-implementations.md).

**Date:** 2026-08-02

**Status:** Decided; constrains #101, with no signing implementation in this change

**Issue:** [#120](https://github.com/KenTaniguchi-R/agentcall/issues/120)

## Decision

AgentCall will preserve a trust-domain-scoped identity shape without adopting a
pre-consensus agent-identity protocol:

1. The current canonical scoped name is `handle@host`. `host` is the namespace
   authority and trust domain; a bare handle is never globally meaningful.
2. A future Agent Card signer will use Ed25519 through JOSE's standard
   `alg: Ed25519`, `kty: OKP`, and `crv: Ed25519` representation.
3. Verification material is host-scoped and subject-bound. The expected
   identity's `host` selects one configured resolver/bundle, its `handle`
   selects the keys authorized for that subject, and `kid` selects one key
   only inside that set. Verification never falls through to a global pool or
   to another handle's keys in the same host.
4. The identity, its routable address, and its credentials remain separate
   schema fields. A public key or JWK thumbprint is a rotatable credential,
   not the agent identifier and not a database primary key.

These are compatibility choices, not adoption of WIMSE, SPIFFE, OAuth identity
chaining, DPoP, token exchange, or a delegation protocol.

## Why this shape

The active individual draft `draft-klrc-aiagent-auth-03` profiles agents as
workloads with a stable identifier scoped to a trust domain and cryptographic
credentials bound to that identifier. It has no formal IETF standing today,
but the identifier/credential separation also appears in the adopted WIMSE
architecture and mature SPIFFE model. AgentCall already has the scoped-name
shape by accident: `handle@host` names a handle inside the authority operated
at `host`.

The useful part is the boundary, not the draft's protocol stack. Keeping the
authority in the identity prevents two relays from silently sharing one
subject namespace. Keeping the credential separate allows normal key rotation
without changing every card, audit event, policy entry, or delegation record
that refers to the agent.

This does **not** make handle reclamation safe by itself. Reassigning the same
`handle@host` to a new owner would reuse the scoped name for a different
identity lifetime. #16 and #100 must decide how an incarnation is represented
before reclamation ships. A signing key cannot be used as that incarnation:
doing so would make routine key rotation look like an identity replacement.

## Signing algorithm

A2A v1.0 specifies JWS over an RFC 8785-canonicalized Agent Card. Its protected
header requires `alg`, `typ`, and `kid`; `typ` should be `JOSE`. It may carry
`jku`, and its examples use ES256. The A2A specification does not enumerate an
exclusive algorithm list or name Ed25519 directly.

Ed25519 is nevertheless a standards-compatible choice. RFC 8037 defines the
`OKP` JWK representation, and RFC 9864 updates it with a fully specified JOSE
algorithm identifier:

- protected-header algorithm `Ed25519`;
- JWK key type `OKP`;
- JWK curve `Ed25519`; and
- public key bytes in `x`, with no private `d` member in the published JWKS.

#101 must use that exact JOSE representation rather than inventing an
algorithm identifier. RFC 9864 deprecates RFC 8037's polymorphic `EdDSA`
identifier, so new signatures must not emit it and verification rejects it by
default. Supporting a legacy peer would require a separately documented,
explicit compatibility policy. The JWS protected header, key type, curve, and
selected key must be checked as one tuple so algorithm/key confusion fails
closed.

## Key discovery and verification

Each relay host will publish stable HTTPS JWKS discovery for its trust domain.
#101 chooses the concrete path, whether the public representation is a
per-handle JWKS or a host bundle with a separate authenticated handle-to-key
mapping, and the rotation/cache contract. A plain host-wide JWKS is
insufficient on its own: RFC 7517 does not bind a key to an AgentCall handle,
so it would let any valid key in the organization sign as any other handle.
The selected representation may publish multiple public keys during rotation,
and every key has a stable `kid` unique within its host.

The signed card may advertise the endpoint through JWS `jku`, but `jku` is not
a trust anchor. A verifier must already know or explicitly configure the
binding between expected `host` and JWKS endpoint. It must not fetch an
arbitrary URL from an unverified card and then trust whatever key it returns.
This is both a trust-confusion boundary and an SSRF boundary.

Verification therefore takes the expected scoped identity as an input:

1. parse the expected `handle@host`, select the configured resolver for that
   exact host, and restrict its result to keys authorized for that handle;
2. if `jku` is present, require it to match that configured endpoint;
3. resolve `kid` only inside the selected host's bundle;
4. require the Ed25519/OKP/Ed25519 tuple and protected `typ: JOSE`;
5. canonicalize and verify the A2A card; and
6. fail loudly on every mismatch, unknown key, revoked key, or unsigned card
   once the zero-user signing cutover occurs.

SPIFFE federation makes the same trust-domain/bundle binding load-bearing:
bundles from different domains must remain distinct because pooling them lets
one domain impersonate identities in another. A stable endpoint supports key
rotation, but the endpoint-to-domain association must be established outside
the unverified credential.

This model still trusts the host authority that serves the handle-to-key
binding. Fetching a card and its JWKS from the same relay does not, on first
contact, prove authenticity against a malicious relay operator: that operator
can substitute both. Removing the relay from that trust boundary requires an
out-of-band pin, transparency mechanism, or independently authenticated
identity binding. #101 must describe its result as host-authorized signing or
trust-on-first-use continuity unless it adds one of those anchors.

## Required acceptance tests for #101

The signing implementation is incomplete until tests prove all of these:

- a card for `ken@a.example` signed by a key from `b.example` fails, even when
  the signature is cryptographically valid;
- a card for `ken@a.example` signed by a key authorized only for
  `ryu@a.example` fails;
- identical `kid` values in two hosts never cause cross-host key selection;
- an untrusted or mismatched `jku` is rejected without being fetched;
- unknown, revoked, expired, wrong-curve, wrong-algorithm, and deprecated
  `EdDSA` keys/signatures fail closed unless a legacy policy explicitly opts in;
- missing or unexpected protected-header `typ` values fail closed;
- both old and new keys may verify only during an explicit rotation overlap;
- changing a signing key does not change the stored agent identifier;
- JWS verification uses A2A's canonicalization and excludes only the
  `signatures` field required by the specification; and
- after the zero-user cutover, unsigned cards are rejected rather than
  accepted with a warning.

## Deferred decisions

- The identity-incarnation representation needed for safe handle reclamation
  belongs to #16 and #100.
- Private-key persistence, backup, and OS keychain storage belong to #101,
  #52, and #108. The public signing key is not a substitute for a recovery
  credential.
- Removing the relay operator from first-contact key discovery requires an
  independent trust anchor and remains part of #101's threat-model decision.
- Federation bootstrap and which foreign hosts are trusted belong to #12.
  Discovery of a JWKS endpoint does not authorize that trust domain.
- Delegation-chain representation and proof belong to #10 and #112.

## Standards watch list

Re-check the living reference index at the next A2A, federation, or enterprise
identity design point:

- whether WIMSE adopts `draft-klrc-aiagent-auth` or another AI-agent profile;
- when `draft-ietf-oauth-identity-chaining-17`, currently in the RFC Editor
  queue with editing in progress, is published as an RFC;
- whether A2A narrows its JWS algorithm profile, changes Agent Card
  canonicalization, or standardizes a JWKS discovery location; and
- whether MCP's workload-identity and proof-of-possession proposals become
  normative specifications.

Until one of those signals lands, AgentCall keeps only the compatible shape
above and does not claim conformance to an agent-identity standard.

## Primary sources

- [A2A v1.0 specification, Agent Card signing](https://a2a-protocol.org/latest/specification/#84-agent-card-signing)
- [RFC 9864: fully specified JOSE algorithms](https://www.rfc-editor.org/rfc/rfc9864.html)
- [RFC 8037: Ed25519 in JOSE](https://www.rfc-editor.org/rfc/rfc8037.html)
- [SPIFFE Federation](https://github.com/spiffe/spiffe/blob/main/standards/SPIFFE_Federation.md)
- [`draft-klrc-aiagent-auth-03`](https://datatracker.ietf.org/doc/draft-klrc-aiagent-auth/)
- [`draft-ietf-wimse-arch`](https://datatracker.ietf.org/doc/draft-ietf-wimse-arch/)
- [`draft-ietf-oauth-identity-chaining`](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-chaining/)
