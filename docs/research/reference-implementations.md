# Reference implementations we follow

This is AgentCall's living design-reference index. Read it before designing work
in `area:enterprise`, `area:security`, or `area:a2a`. Unlike the dated records in
`docs/superpowers/`, this file describes references we follow now and should be
updated when a source, version, or local adoption changes.

Use references by problem shape, not by technology stack:

1. Read the named source, not only its README or this summary.
2. Copy the invariant or boundary, not an implementation accidentally coupled to
   another runtime.
3. Record the precedent in the new design and link the shipped implementation
   back here.
4. Re-check version-sensitive claims. The sources below were last checked on
   2026-08-02.

## Load-bearing references

| Reference | Read this | Pattern to carry into AgentCall | Bears on |
|---|---|---|---|
| [Headscale](https://github.com/juanfont/headscale) and [Tailscale auth keys](https://tailscale.com/docs/features/access-control/auth-keys) | Headscale `hscontrol/types/preauth_key.go` and `hscontrol/db/preauth_keys.go` | Prefix-indexed, hash-stored, reveal-once enrollment keys; explicit expiry and reuse; admission provenance; revocation separate from eviction | #52, #60, #97, #98 |
| [Unkey](https://github.com/unkeyed/unkey) | Audit and authorization packages, plus [engineering notes](https://engineering.unkey.com/) | Administrative authority distinct from end-user keys; typed actors; `noun.verb` audit events; mutations separate from high-volume analytics | #17, #47, #99 |
| [Infisical](https://github.com/Infisical/infisical) | [Universal Auth](https://infisical.com/docs/documentation/platform/identities/universal-auth) and [machine-identity migration](https://infisical.com/blog/introducing-machine-identities) | Multiple overlapping client secrets, bounded TTL/use/IP, lockout, and organization- versus project-scoped machine identities | #15, #52, #98, #100 |
| [A2A](https://github.com/a2aproject/A2A) and [a2a-js](https://github.com/a2aproject/a2a-js) | The normative [protocol sources](https://github.com/a2aproject/A2A/tree/main/specification), release notes, TCK, and Agent Card signing code | Public protocol nouns and operations; generated bindings; conformance tests; canonical JWS-signed cards verified through published JWKS | #9, #10, #21, #101 |
| [MCP Enterprise Managed Authorization](https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/stable/enterprise-managed-authorization.mdx) | The extension specification and official SDK implementations | Enterprise IdP trust and token-exchange architecture as a reference for AgentCall identity work; do not claim EMA interoperability without an MCP resource and extension negotiation | #15, #27, #119 |
| [EnterpriseReady](https://www.enterpriseready.io/) | [Audit log guide](https://www.enterpriseready.io/features/audit-log/) and category teardowns | Procurement requirements as concrete product behavior; audit after successful mutation; RBAC and evidence before SSO/SCIM breadth | #15, #17, #18, #99, #102 |
| [RFC 6121 / XMPP IM](https://datatracker.ietf.org/doc/html/rfc6121), [RFC 6120 / XMPP Core](https://datatracker.ietf.org/doc/html/rfc6120), and [ejabberd](https://github.com/processone/ejabberd) | RFC 6121 roster subscription and presence states; RFC 6120 `node@domain/resource` addressing | A roster as directional consent, not just a member list; separately addressable concurrent sessions for one identity | #44, #48, #116 |
| [SPIFFE federation](https://spiffe.io/docs/latest/spiffe-specs/spiffe_federation/) | Trust domains, bundle endpoints, and endpoint-profile rules | Each namespace authority owns a trust domain and publishes verification material; bind each public-key bundle to its domain and never verify against a cross-domain key pool | #12, #101, #120 |

### Headscale and Tailscale: enrollment credentials

The useful boundary is enrollment versus ongoing identity. A join credential may
be one-off or reusable and must expire; the enrolled node records which credential
admitted it. Revoking future use is not the same operation as evicting identities
that already enrolled. A stable non-secret prefix lets administrators list and
revoke one credential without exposing or scanning every secret.

Do not copy Headscale's storage algorithm blindly: choose a password/secret hash
appropriate to our threat model and runtime. Preserve its lookup shape, lifecycle,
provenance, masked logging, and separation of revoke, destroy, and eviction.

Applied in AgentCall:

- [Keyed roster join credentials design](../superpowers/specs/2026-08-02-roster-join-keys-design.md)
- [`apps/relay/src/roster.ts`](../../apps/relay/src/roster.ts) and
  [`apps/relay/src/events.ts`](../../apps/relay/src/events.ts)

### Unkey and EnterpriseReady: authority and audit evidence

Administrative credentials and user credentials are different actor types, even
when both can invoke an endpoint. Audit event names need both a resource and an
action (`roster.join_key.revoke`), stable CRUD semantics, source metadata, typed
targets, and a description. Emit the record after the mutation succeeds. Keep
read/verification traffic in analytics unless it is itself security-relevant
evidence; an append-only administrative audit log should not become a telemetry
firehose.

Do not copy a vendor's retention tiers or datastore. Retention, export, tamper
evidence, and access policy are AgentCall product decisions; the event contract is
the reusable part.

Applied in AgentCall:

- [`apps/relay/src/events.ts`](../../apps/relay/src/events.ts)
- [Roster lifecycle design](../superpowers/specs/2026-08-01-roster-lifecycle-design.md)
- [Subject erasure and retention](../superpowers/specs/2026-08-02-subject-erasure-and-retention-design.md)
- [Presence telemetry and audit boundary](../superpowers/specs/2026-08-02-presence-telemetry-audit-boundary.md)
- [`apps/relay/src/presence.ts`](../../apps/relay/src/presence.ts), where status
  reads deliberately use identity-unlinked Analytics Engine telemetry rather than the
  mutation audit ledger

### Infisical: machine identity and safe rotation

A machine identity can hold several client secrets at once. That overlap is the
safe rotation window: mint new, migrate, then revoke old. Each bootstrap or access
credential needs an explicit TTL, maximum-use policy, trusted-network policy, and
lockout behavior. Organization-level and project-level identities can share a
model while differing in management scope.

AgentCall has decided to follow the entity boundary as well as the rotation
pattern: a stable agent identity will own reclaimable addresses and multiple
credentials. The handle, token hash, public signing key, and device/line will
not be identity identifiers. User-facing CLI flows may hide login exchange and
refresh, but administrative and audit surfaces will retain non-secret identity
and credential IDs. This future boundary was rechecked against Infisical's
current identity, Universal Auth, and client secret source on 2026-08-02; the
runtime still uses `(org, handle)` today.

Do not treat a renewable, non-expiring token as a default. It is an explicit
secret-zero tradeoff for workloads that cannot retain bootstrap material, and it
needs proof-of-possession or another bounded renewal mechanism.

Decided for AgentCall:

- [Identity and address separation](../superpowers/specs/2026-08-02-identity-address-separation.md)
- [Credential lifecycle](../superpowers/specs/2026-08-02-credential-lifecycle.md)

### A2A: protocol and signed Agent Cards

The protocol source and generated artifacts outrank prose summaries. AgentCall is
currently designed against A2A v1.0.0; the latest upstream release checked on
2026-08-02 is [v1.0.1](https://github.com/a2aproject/A2A/releases/tag/v1.0.1).
Do not silently upgrade the claimed conformance target: review release changes,
regenerate bindings, and run the upstream TCK.

Use A2A for public task/message/card vocabulary and interoperability. Do not ask it
to define AgentCall's authorization, tenancy, durable storage, execution lease, or
abuse controls; those are local invariants behind the protocol boundary.

Historical designs that explain the current target and planned cutover:

- [A2A adoption](../superpowers/specs/2026-08-01-a2a-adoption-design.md)
- [A2A task store and operations](../superpowers/specs/2026-08-01-a2a-task-store-design.md)

### Agent identity: compatible shape, no protocol adoption

The active AI-agent identity proposals are still pre-consensus. Preserve the
common shape without claiming adoption: `handle@host` is scoped by the host
trust domain, the identifier is separate from every rotatable credential, and
a verifier selects public keys by expected host and handle before selecting
`kid`. A host-wide JWKS without an authenticated handle-to-key binding does not
prove which handle owns a key.

A2A v1.0 defines JWS-signed Agent Cards but does not name Ed25519 directly.
Ed25519 fits that generic JWS contract through RFC 9864's fully specified
`alg: Ed25519` plus RFC 8037's `kty: OKP` / `crv: Ed25519` key representation.
RFC 9864 deprecates the older polymorphic `EdDSA` algorithm identifier; do not
emit or accept it by default. A card-supplied `jku` is discovery metadata, not
authority: it must match an endpoint already bound to the expected host and
must never cause an arbitrary pre-verification fetch.

JWKS discovery on the same relay still trusts that relay on first contact. It
supports host-authorized signing and continuity after pinning; it is not an
end-to-end proof against a malicious relay unless an independent trust anchor,
transparency mechanism, or out-of-band pin is added.

Current watch points, checked 2026-08-02:

- `draft-klrc-aiagent-auth-03` is an active individual draft with no formal
  IETF standing; watch for WIMSE adoption or a competing adopted profile.
- `draft-ietf-oauth-identity-chaining-17` is in the RFC Editor queue with
  editing in progress, but is not yet a published RFC.
- A2A's signing contract requires RFC 8785 canonicalization and JWS, permits
  `jku`, and leaves the algorithm choice open; watch for a narrower algorithm
  profile or standardized JWKS location.
- MCP workload-identity federation and proof-of-possession remain watch items,
  not AgentCall dependencies.

Applied in AgentCall:

- [Agent identity compatibility decision](../superpowers/specs/2026-08-02-agent-identity-compatibility.md)
- [Signed Agent Cards](../superpowers/specs/2026-08-02-signed-agent-card-design.md)

### XMPP, Matrix, NATS, and SPIFFE: federation

AgentCall's `handle@host` address belongs to the federated-messaging problem
family. [Matrix federation](https://spec.matrix.org/latest/server-server-api/)
shows signed server-to-server requests, key discovery, and the split between
persistent data and ephemeral presence. [NATS accounts](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/accounts)
show tenancy as structural isolation with explicit exports and imports. XMPP adds
directional roster consent and per-resource addressing. SPIFFE supplies the trust
domain and verification-bundle model.

Do not adopt full room-state replication, XMPP semantics, SPIFFE credential
formats, or NATS subject syntax by analogy. Use these references before choosing
federation signing, discovery, consent, tenant isolation, and multi-session
identity semantics.

## Distribution and managed deployment

| Reference | Pattern to inspect | Bears on |
|---|---|---|
| [Fleet](https://github.com/fleetdm/fleet) | Enrollment secret exchanged for per-host keys; OS credential stores and TPM-backed certificates; TUF updates; end-user transparency | #97, #104, #105, #106, #108, #110 |
| [cloudflared](https://github.com/cloudflare/cloudflared) | Rotation blocks new connections while force-disconnect remains a separate remediation action | #48, #97 |
| [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) | Put the future human admin UI on a distinct hostname; validate `Cf-Access-Jwt-Assertion` inside the Worker; use separate service credentials for headless admin clients | #15, #109 |
| [oclif](https://github.com/oclif/oclif) | Signed platform installers, release channels, updater behavior, and bundled runtimes | #106 |
| [SLSA provenance template](https://github.com/redoubt-cysec/provenance-template) | Keyless signing, provenance, SBOMs, reproducibility, and immutable Actions | #105 |

The rule to preserve from Fleet is a two-phase credential model: enrollment
material gets a device admitted, then per-host identity authenticates normal
operation and renewal. Managed policy, update policy, repair/status tools, and
uninstall behavior are one deployment contract, not independent CLI features.

Cloudflare Access was rechecked against its official documentation on
2026-08-02. It is edge admission, not AgentCall RBAC: the Worker still validates
the assertion's signature, `kid`, issuer, audience, and expiry, then maps only
verified claims to a typed human or service actor. A headless admin client uses
Access's service-token headers or `cf-access-token`; its single-header
`Authorization` mode conflicts with AgentCall's existing handle Bearer token
and is not part of the design. Access supports multiple IdPs, but an
AgentCall-owned Zero Trust organization would leave the operator owning every
customer IdP connection and policy. Customer-owned Access is therefore a
self-hosted SSO profile, while hosted multi-tenant SSO/SCIM remains #15.

Applied in AgentCall:

- [Administrator-managed policy design](../superpowers/specs/2026-08-02-managed-policy-design.md)
- [Cloudflare Access boundary](../superpowers/specs/2026-08-02-cloudflare-access-boundary.md)
- [Enterprise capability sequence](../superpowers/specs/2026-08-03-enterprise-capability-sequence.md)
- [Release workflow](../../.github/workflows/release.yml)

## Governance, same-stack implementations, and observability

These are narrower references. Read the named subsystem rather than treating the
repository as a general architecture endorsement.

- [paddock](https://github.com/ViktorWelbers/paddock): hierarchical budgets,
  default-deny egress, and the open-core boundary between enforcement and
  enterprise evidence (#22, #111, #112).
- [wardyn](https://github.com/cjohnstoniv/wardyn): human, run, and sponsor
  accountability; kill-switch cascades; telemetry-degradation disclosure (#110,
  #112, #120).
- [kitelogik](https://github.com/kitelogik): delegation depth, child-scope
  subset rules, and resource budgets as first-class policy (#112).
- [cloudflare-relay-server](https://github.com/mantisgaming/cloudflare-relay-server):
  per-scope Durable Object rate limiters, fail-closed HMAC configuration, and
  single-use rotating reconnect codes (#19, #52, #113).
- [ketsoc](https://github.com/NeuronEnix/ketsoc): D1 repository seams, owner/member
  tenancy, invitations, and reveal-once keys on the same Workers/DO/D1 stack
  (#49, #97).
- [excalidraw-cf-platform](https://github.com/htlin222/excalidraw-cf-platform):
  Cloudflare Access assertion validation at the Worker boundary (#109).
- [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/):
  agent/tool spans, token usage, conversation correlation, and content capture
  disabled by default (#114). These conventions are still marked Development;
  pin the reviewed version rather than assuming stable names.

Applied in AgentCall:

- [Executable policy assertions design](../superpowers/specs/2026-08-02-policy-assertions-design.md),
  adapted from Tailscale policy tests
- [Capability, resource, and autonomy policy](../superpowers/specs/2026-08-02-capability-authorization-policy.md),
  which keeps one deterministic authorization kernel behind every enforcement adapter
- [Egress and delegated-call boundary](../superpowers/specs/2026-08-02-egress-and-delegation-boundary.md),
  which rejects advisory proxy policy and gates chain claims on per-run authority
- [`apps/relay/src/ratelimit/index.ts`](../../apps/relay/src/ratelimit/index.ts)

## Maintenance rules

- Keep this file undated and revise it in place.
- Prefer specifications, official documentation, and the relevant source file.
- State the exact invariant we follow and the part we reject or leave undecided.
- Record the check date for version-sensitive claims.
- Add an “Applied in AgentCall” link when a design or implementation lands.
- Remove or demote a reference when it is abandoned, unmaintained, contradicted
  by production evidence, or superseded by a stronger primary source.
