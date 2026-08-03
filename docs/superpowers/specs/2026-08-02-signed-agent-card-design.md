# Signed Agent Cards

> **Historical design record — not current documentation.** This file is
> dated and never revised; it explains why the 2026-08-02 decision was made,
> not what the code does now. Read the repository `README.md` and
> `CHANGELOG.md` for current behavior. The living standards watch list is in
> [`docs/research/reference-implementations.md`](../../research/reference-implementations.md).

**Date:** 2026-08-02

**Status:** Decided; implementation follows the #100 identity cutover

**Issue:** [#101](https://github.com/KenTaniguchi-R/agentcall/issues/101)

## Decision

AgentCall will publish one viewer-independent, locally signed A2A Agent Card
revision for each agent identity. The card contains only the stable
public/default offer. A separate authenticated AgentCall authorization
operation returns the
viewer-specific effective skills. The relay never edits, filters, decorates,
or signs the identity-authored card.

The CLI signs the card with a rotatable Ed25519 credential delegated by the
identity's existing P-256 root. The relay publishes subject-bound JWKS,
verifies signed publications before storing them, and serves the exact stored
normalized representation. Verification starts with the expected
`handle@host`, derives the one trusted JWKS location for that subject, and
fails loudly for unsigned or
untrusted cards.

This is host-authorized signing, not proof against a malicious relay. A relay
that supplies both the card and JWKS can substitute both on every use unless
the caller has an independent pin, transparency proof, or out-of-band anchor.
This issue defines none of those anchors and makes no trust-on-first-use
continuity claim.

Signing is not the handle-incarnation mechanism. Cards, signing credentials,
and policy belong to #100's opaque `agent_id`. Address resolution maps the
current `handle@host` binding to that identity. Reclaim creates a different
identity with no inherited card or key state; routine signing-key rotation
preserves the same identity.

## Why the card is immutable

The current A2A route derives a different Agent Card for each viewer by
filtering skills through `visibleTasks()`. A2A JWS authenticates the canonical
whole card. Removing or adding a skill after signing invalidates the
signature, and multiple JWS entries authenticate the same payload rather than
independent fragments.

Three designs were considered:

1. **One signed public/default card.** The agent authors one stable artifact;
   the relay separately reports the permissions it will enforce for a viewer.
2. **Pre-signed audience variants.** The CLI compiles and signs every possible
   effective task set, and the relay selects one without modifying it.
3. **One signed card plus an authorization extension.** The immutable card
   advertises a separate operation whose response is bound to the card digest.

AgentCall chooses the third framing with the first design's single public
card. Pre-signed variants have exponential worst-case growth, require a hard
policy-complexity cap, and still trust the relay to select the correct richer
or narrower variant. They add storage and rotation complexity without removing
the authorization trust boundary.

Each published card revision is immutable. Publishing a description, default
offer, interface, or signature-envelope change creates a new revision rather
than mutating one already served.

The authorization response is not another Agent Card and is not covered by
the agent's JWS. It is the relay's current policy decision. AgentCall will not
set A2A's `extendedAgentCard` capability merely because this local extension
exists: a dynamically filtered standard extended card cannot retain the local
signature. A future standard extended card must either be immutable and
pre-signed for all authenticated viewers or be described honestly as a
relay-authored view.

## Public interfaces and ownership

The shared signing module is a deep boundary with two public operations:

```ts
createSignedPublicCard({ card, expectedSubject, signers }): SignedAgentCard

verifyPublicCard({ card, expectedSubject, keyResolver, now }): VerifiedAgentCard
```

It owns A2A protobuf normalization, removal of exactly the top-level
`signatures` field, RFC 8785 canonicalization, flattened JWS creation and
verification, protected-header validation, key lifecycle checks, and precise
trust errors. Callers receive a branded verified value so an unverified parsed
card cannot flow into display or call logic by accident.

Production adapters load local WebCrypto keys and resolve HTTPS JWKS. Tests
inject deterministic signers, resolvers, and clocks. Routes and CLI commands do
not implement JOSE policy themselves.

The relay has two separate modules:

- card publication verifies and atomically stores a signed public card plus
  the private policy revision, then returns the signed card unchanged; and
- authorization evaluates `visibleTasks()` for an authenticated viewer and
  returns a short-lived view bound to the current signed-card digest.

This separation keeps private grants, groups, blocked callers, and denial
reasons out of the public card and its cache.

## Key hierarchy

The existing P-256 identity signing root remains the locally held authorization
root. It does not sign routine Agent Cards and it is not replaced by an A2A
algorithm migration. The P-256 encryption key remains a separate HPKE/ECDH
credential and is never reused for signatures.

Each `agent_id` owns one P-256 identity root and a set of delegated Agent Card
signers. Under the current product shape, one inbound line maps to one relay
identity and active address, so its local vault holds that identity's root and
signers. A future design that permits several lines or machines to answer for
one `agent_id` must make them separately revocable delegates; it must not give
each line an implicit ability to replace the identity-wide root or publication.
#100's identity ownership controls over #44's local process layout.

The vault owner generates an Ed25519 Agent Card signer. Before a relay accepts
it, the identity root signs a deterministic, length-prefixed authorization
record containing at least:

- version, trust domain, organization, `agent_id`, and current address;
- `kid`, epoch, predecessor `kid`, and public JWK;
- not-before and not-after timestamps; and
- the intended Agent Card signing use.

The address in this authorization record is an event-time audit snapshot, not
an ongoing credential selector. A same-identity rename preserves the root and
delegated signer. It atomically republishes a new card revision whose name,
extension handle, interface URL, and `jku` bind the new address; the old address
stops resolving. Reclaim is different because it creates a new `agent_id` and
cannot reuse the former identity's delegation.

The relay verifies the root authorization against the identity root already
bound to `agent_id` and requires proof of possession of the Ed25519 private
key. It issues an authenticated, single-use, five-minute registration nonce
bound to `agent_id` and the candidate `kid`. The candidate key signs a
domain-separated, length-prefixed transcript containing that nonce and the
SHA-256 digest of the exact root authorization record. The relay consumes the
nonce in the same transaction that registers the credential. A changed
subject, key, authorization record, expired nonce, or replay fails. Bearer
authentication alone cannot authorize replacement of either root or card
signer.

The public JWK is exactly:

```json
{
  "kty": "OKP",
  "crv": "Ed25519",
  "alg": "Ed25519",
  "use": "sig",
  "kid": "<host-unique key id>",
  "x": "<base64url public key>"
}
```

It never contains `d`. The public key and its thumbprint are credentials, not
the identity identifier.

## JWS and canonicalization

AgentCall wraps the upstream A2A JavaScript SDK rather than reproducing its
wire algorithm. The signed payload is the SDK's normalized Agent Card:

1. round-trip through the normative generated Agent Card type;
2. remove exactly the top-level `signatures` member;
3. remove protobuf defaults and empty values according to the upstream
   contract; and
4. serialize with RFC 8785 JSON Canonicalization Scheme.

The relay stores and serves the normalized signed object. Unknown JSON fields
that the generated type drops cannot carry security meaning, and every
AgentCall extension used by the signed card must have a compatibility test
proving it survives the normative round-trip.

Each signature uses a flattened JWS entry embedded in the A2A `signatures`
array. Its protected header is exactly:

```json
{
  "alg": "Ed25519",
  "typ": "JOSE",
  "kid": "<signing key id>",
  "jku": "https://<canonical-host>/v1/a2a/<handle>/jwks.json"
}
```

The verifier rejects deprecated `EdDSA`, another algorithm, missing or
unexpected `typ`, `crit`, an unprotected header, malformed or ambiguous `kid`,
and an Ed25519/OKP/Ed25519 tuple mismatch. The stock upstream verifier accepts
a caller-provided resolver and checks only that several header fields exist;
AgentCall's wrapper enforces this stricter profile before invoking it.

Multi-signature acceptance is any-valid-entry only after strict envelope
validation. Every entry must be a structurally valid flattened JWS with the
exact protected-header profile and expected `jku`; duplicate `kid` entries or
any malformed, unprotected, critical, wrong-algorithm, or wrong-`typ` entry
reject the whole card as ambiguous. The verifier then evaluates key lifecycle
and cryptography independently for each well-formed entry. Retired, unknown,
or cryptographically invalid entries do not invalidate another entry that
fully verifies. At least one entry must resolve to an eligible key and verify;
otherwise the card fails. Thus `[retired old, valid new]` works during cache
transitions, while a retired-only card, malformed extra entry, or duplicate
signer does not.

## Discovery and verification

The subject-bound endpoints are:

- `GET /v1/a2a/:handle/agent-card.json` returns the current signed public card;
- `GET /v1/a2a/:handle/jwks.json` returns only verification-valid keys for the
  identity currently bound to that address; and
- `GET /v1/a2a/:handle/authorization` returns the authenticated viewer's
  current effective authorization bound to the public card digest.

The last operation is the proprietary
`https://agentcall.benree.tech/ext/policy/v1` extension already placed in
`capabilities.extensions` with `required: false` and
`params: { handle: "<card name>" }`. The URI identifies the schema and need not
resolve. The route is derived from the verified interface origin and the
verified handle; clients never follow an arbitrary extension URL. The response
is not an Agent Card or `GetExtendedAgentCard` result:

```ts
interface AuthorizationViewV1 {
  v: 1;
  subject: string;          // exact handle@host
  viewer: string;           // authenticated handle@host
  card_digest: string;      // base64url SHA-256 of canonical unsigned card
  policy_revision: string;
  evaluated_at: string;     // RFC 3339
  expires_at: string;       // RFC 3339, at most 60 seconds later
  skills: A2AAgentSkill[];
}
```

An unsupported optional extension is ignored. This separate authenticated
REST read does not use `A2A-Extensions` request negotiation; that header's
required-extension behavior on A2A protocol operations is unchanged. It
returns `401` for absent/invalid authentication and the same `404` shape for a
missing or blocked subject. Other errors use the existing AIP-193 envelope.

All three remain authenticated and restricted to the current organization.
The public/default label describes content stability, not public transport.
This preserves the existing non-enumeration boundary: an anonymous or
wrong-tenant probe cannot discover employee handles, keys, or task metadata.
The card and JWKS may become anonymous only through a separate privacy and
federation decision. Card and authorization responses are `private, no-store`;
JWKS caching is private and bounded by the rotation contract. The authorization
route uses the same missing/blocked non-disclosure behavior as current card
policy.

Verification always begins with an expected scoped address supplied by the
caller:

1. canonicalize and validate its host, then select that host's configured
   trust resolver;
2. derive the exact JWKS URL from the trusted host and expected handle;
3. inspect every protected header and reject a missing or byte-mismatched
   `jku` before any network fetch;
4. resolve the current address to its subject key set, then select `kid` only
   inside that set;
5. validate key status, time window, algorithm, key type, and curve;
6. canonicalize and verify the card; and
7. verify the exact AgentCall address projection against the expected subject.

For v1 that projection has no implicit or best-effort fields. `name` equals the
expected handle; exactly one `AGENTCALL_POLICY_EXT` entry exists and its only
parameter is the same `handle`; and exactly one supported interface exists
with `protocolBinding: "HTTP+JSON"`, the supported A2A version, and canonical
URL `https://<expected-host>/v1/a2a/<percent-encoded-handle>`. Conflicting or
duplicate policy extensions or interfaces are rejected. The expected host is
never inferred from the unverified URL.

The resolver returns keys only after resolving the trusted expected address to
its current internal `agent_id`; that identifier is not placed in the public
card. Card-to-private-policy default equality is a relay publication check,
not a responsibility of an external verifier.

There is no global key pool, cross-host fallback, same-host cross-handle
fallback, arbitrary `jku` fetch, or unsigned compatibility path.

`agentcall card <address>` verifies the public card by default. If it also
shows viewer-specific skills, output and internal types distinguish
**signature-verified public defaults** from **relay-authorized effective
skills**. The two sets are never merged and described as wholly agent-signed.

## Storage and publication

Exact table names remain implementation details, but the ownership is:

```text
agent identity (agent_id)
  +-- card signing credentials
  |     kid, epoch, public JWK, lifecycle, predecessor, root authorization
  +-- signed public card revisions
  |     revision, canonical digest, exact signed JSON, signer kids, timestamp
  +-- current public card pointer
  +-- private policy revisions
        task catalog, defaults, grants, groups, blocked callers
```

Signed card revisions are append-only, with an atomically advanced current
pointer. Public revision and cache identity change only when signed public
content or its signature envelope changes. Private grant, group, or block
changes advance the policy revision without changing the public card, JWS, or
ETag.

After normalization and signature validation, the relay serializes the signed
object once in its canonical transport form and stores that body opaquely.
Responses return that stored body rather than parsing and reserializing it.
This makes byte-for-byte response stability an explicit storage property;
cryptographic verification still authenticates the canonical unsigned payload,
not the whitespace or member order of the original upload.

Publication is local-sign then verify-before-store:

1. the CLI builds the full private policy and derives a public card from only
   `default_offer` tasks;
2. it normalizes and signs that card with active local signer(s);
3. it uploads the policy and exact signed card in one idempotent operation;
4. the relay authenticates to `agent_id`, verifies key authorization and every
   card invariant, and checks that public skills equal policy defaults; and
5. one transaction appends revisions and advances their current pointers.

A failure stores neither a new current policy nor a new current card. The
relay has no unsigned or relay-signed fallback.

The authorization response contains version, subject, viewer, public card
digest, policy revision, evaluated/expiry timestamps, and effective skills.
It exposes neither grants nor denial reasons. Its digest binding prevents a
client from combining a stale authorization view with a different signed
card; it does not turn the relay decision into an identity signature.

## Rotation and revocation

Planned signer rotation is prepare, overlap, then retire:

1. generate a new Ed25519 key locally and retain the old private key;
2. root-authorize and register the new key with a monotonic epoch and exact
   predecessor, using conditional storage to prevent forks or rollback;
3. expose old and new public keys and wait at least one JWKS cache lifetime;
4. publish the same semantic card with old and new signatures;
5. keep both keys verification-valid for an explicit overlap longer than the
   maximum card/JWKS cache lifetime and deployment skew; and
6. retire the old key, publish future cards with the new key only, and delete
   the old private key after the overlap.

An unknown `kid` may cause one refresh of the exact trusted JWKS endpoint, then
fails loudly. Old and new signatures verify together only during recorded
overlap. With a fresh resolver state, after retirement an old-only card fails
even if its cryptographic signature is otherwise valid.

Emergency revocation removes a key from fresh JWKS and marks it revoked. A
cached card and JWKS may continue to verify until cache expiry; JWS provides no
online freshness guarantee. Short bounded JWKS caching with
`must-revalidate`, no stale-if-error, and key validity checks bound this
residual rather than pretending to eliminate it.

Every JWKS response sets private freshness to the smaller of the configured
JWKS TTL and the seconds remaining until the earliest included key's
`not_after`, plus `must-revalidate`. The resolver records that HTTP freshness
deadline and never uses the key set after it, even when refresh fails or the
machine is offline. A response with no positive freshness window is not
cached. This lets standard JWKs remain standard while making absolute expiry
fail closed; emergency revocation remains bounded by the previously issued
freshness window as described above.

Card signing credentials have a 90-day hard lifetime. The CLI starts rotation
with 30 days remaining during setup, publish, listener startup, and scheduled
credential maintenance; `doctor` warns with 45 days remaining and fails once
the active card has no signer valid beyond the maximum cache/overlap window.
Rotation publishes and verifies the replacement before retiring the old key.
If the owner remains offline past `not_after`, verification fails loudly and
the card is unavailable until the surviving root authorizes and publishes a
replacement. A stable card never silently outlives its verification key.

## Recovery and destructive removal

The Ed25519 signer is a replaceable credential. Losing it is recoverable while
the P-256 identity root survives: authorize a replacement, revoke the old key,
and republish. A bearer token or recovery code alone cannot replace the root.
Root loss fails closed. #52 recovers bearer-token authority and explicitly does
not restore a cryptographic root. Unless a separately approved, independently
protected root-recovery or administrator replacement ceremony is designed,
root loss creates a new identity lifetime.

Normal uninstall and line removal preserve or archive the identity vault.
Routine `--purge` must not casually erase the identity root. Permanent root
destruction is a separately named identity-destroy operation with explicit
confirmation, remote signer revocation when reachable, and an irreversible
continuity warning. If remote revocation fails, local deletion refuses by
default; any force-abandon path must be explicit and must not claim that the
remote identity was revoked.

OS keychain storage remains an adapter owned by #108. Recovery material must
not live only in the same vault that destructive removal erases.

## Zero-user cutover and implementation order

There is no unsigned compatibility mode. Implementation follows #100 so every
row can attach to `agent_id` instead of cementing another handle-owned schema:

1. land the identity/address cutover and assert the no-user production premise;
2. generate the normative A2A types and add the shared signed-card wrapper;
3. add identity-owned signer, card-revision, current-pointer, and policy
   storage;
4. migrate the local key file to a versioned identity vault and generate the
   delegated Ed25519 signer;
5. change setup/publication to register the signer before atomically publishing
   policy and signed card;
6. serve only stored signed cards and subject-bound JWKS from the A2A routes;
7. make every CLI public-card entry point verify by default; and
8. remove the dynamic Agent Card projection and every unsigned read/write
   path. Keep dynamic authorization behind the separate extension.

The migration aborts if identity-bearing production rows contradict the
zero-user premise. It does not infer continuity from a handle. Test fixtures
are regenerated as fresh identities.

## Required acceptance tests

Implementation is incomplete until tests prove:

- local canonicalization/signing verifies with the upstream A2A SDK and an
  upstream-produced vector verifies locally;
- normalization is order-independent, excludes exactly `signatures`, preserves
  every supported extension, and rejects meaning hidden in dropped fields;
- mutating any signed field fails while changing only the signatures array does
  not change the payload digest;
- unsigned cards, malformed flattened JWS, unprotected headers, wrong
  signatures, duplicate/ambiguous `kid`, wrong algorithm, deprecated `EdDSA`,
  wrong curve/key type, missing/wrong `typ`, or cards with no signature eligible
  under fresh key status fail closed;
- `[retired old, valid new]` and `[cryptographically invalid old, valid new]`
  accept through the new signature, while duplicate signer entries, malformed
  extras, and retired/revoked-only cards fail;
- a valid key from another host or another handle never verifies, identical
  `kid` values in two hosts cannot cross, and mismatched `jku` is rejected
  without invoking the resolver;
- the relay rejects subject, `agent_id`, address, interface-origin, default
  catalog, digest, or root-authorization mismatches;
- the relay returns the exact stored normalized signed card without projection;
- two viewers receive identical signed card bytes but may receive different
  authorization views bound to the same card digest;
- grant/group/block-only edits leave the public card, signature, revision, and
  ETag unchanged, while a public-default edit requires a new local signature;
- blocked and missing authorization are indistinguishable and no response
  leaks raw grants or denial reasons;
- old and new keys verify only during explicit overlap, concurrent rotations
  cannot fork, retirement rejects old-only cards, and signer rotation preserves
  `agent_id`;
- a key fetched one second before `not_after` is unusable after `not_after`
  without a successful refresh, including when the network is unavailable;
- renaming preserves `agent_id`, root, and delegated signer but requires a new
  card revision bound to the new name, extension handle, interface, and `jku`;
  the old address and old card route stop resolving;
- reclaim resolves to a new `agent_id` with no inherited card, keys, policy,
  or cache identity; any independently held pin remains outside relay state and
  is never reset merely because the address was rebound;
- a root-authorized candidate without the Ed25519 private key, a replayed or
  expired registration nonce, and a PoP transcript copied across subject or
  key all fail;
- signer loss can recover through the surviving root, root loss cannot recover
  through bearer authentication, and destructive identity removal is explicit;
  and
- every publication failure is atomic and no code path falls back to unsigned
  or relay-signed content.

## Security properties and residual trust

With an independently trusted or pinned subject-key binding, the JWS proves
possession of the delegated local credential and authorship of the signed card
revision. Without that anchor it proves only consistency with the host-provided
subject key set. Root authorization prevents bearer authentication alone from
replacing a signer at an honest relay; it does not make an unpinned external
client safe from a malicious relay. Subject-bound resolution prevents
cross-host and cross-handle key confusion under that host-authorized model.
Stable `agent_id` ownership prevents handle reclaim from inheriting the
previous principal's card state.

The relay still controls address-to-identity resolution, first-contact JWKS,
availability, replay of a still-valid card, and viewer-specific authorization.
It can suppress a card or lie about policy it will enforce. Independent
first-contact authenticity requires a pin, transparency log, or external trust
anchor and is deferred. The UI and documentation must preserve that distinction
instead of describing same-relay card plus JWKS as end-to-end proof.

## Primary sources

- [A2A v1.0 specification, Agent Card signing](https://a2a-protocol.org/latest/specification/#84-agent-card-signing)
- [a2a-js signing implementation](https://github.com/a2aproject/a2a-js/blob/main/src/signature.ts)
- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html)
- [RFC 9864: Fully-Specified Algorithms for JOSE and COSE](https://www.rfc-editor.org/rfc/rfc9864.html)
- [RFC 8037: CFRG Elliptic Curve Diffie-Hellman and Signatures in JOSE](https://www.rfc-editor.org/rfc/rfc8037.html)
- [SPIFFE Federation](https://spiffe.io/docs/latest/spiffe-specs/spiffe_federation/)
