# Cloudflare Access boundary

> **Historical design record — not current documentation.** This file is
> dated and never revised; it explains why the 2026-08-02 decision was made,
> not what the code does now. Read the repository `README.md` and
> `CHANGELOG.md` for current behavior. The living reference is in
> [`docs/research/reference-implementations.md`](../../research/reference-implementations.md).

**Date:** 2026-08-02

**Status:** Decided; no admin UI, self-hosted distribution, or Access middleware exists yet

**Issue:** [#109](https://github.com/KenTaniguchi-R/agentcall/issues/109)

## Decision

Cloudflare Access is the preferred edge admission layer for two future
deployment shapes:

1. The AgentCall-operated human admin web surface will use a dedicated
   hostname such as `admin.<relay-host>` protected by Access from its first
   deployment.
2. A self-hosted relay may document Access as a supported SSO profile when the
   relay owner controls the Cloudflare account, Zero Trust organization, IdP,
   Access application, and policies.

Access will not be placed in front of the current relay API, will not replace
AgentCall handle authentication or application authorization, and will not be
the customer-identity control plane for the multi-tenant hosted relay. That
hosted SSO and SCIM problem remains [#15](https://github.com/KenTaniguchi-R/agentcall/issues/15).

This change records the boundary only. The repository has no admin web UI and
no supported self-hosted distribution today, so adding JWT middleware or
deployment variables now would create an unexercised security path.

## Why a separate admin hostname

The public relay serves CLI registration, presence, card, call, and WebSocket
traffic. Established-handle routes use an AgentCall handle token in the
`Authorization` header, registration exchanges a one-use invite before a
handle token exists, and generic relay discovery is intentionally public.
Protecting the relay with a browser-oriented Access application would either
break those flows or require every caller to acquire a second,
operator-managed credential.

A separate admin hostname gives the future human console one complete Access
application and policy boundary without changing the public protocol. It is
also safer than relying on path policy inheritance: a newly added admin route
cannot accidentally fall outside a protected prefix. The current
`POST /v1/admin/invite` endpoint is an operator bootstrap API guarded by
`BOOTSTRAP_TOKEN`; its name does not make it the future admin web surface.

Access authenticates admission to that hostname. AgentCall must still map a
verified Access identity to an application actor, enforce tenant and role
authorization, and write an audit event for the action. Passing an Access
policy is never equivalent to being an AgentCall administrator.

## Human request verification

The Worker must validate the `Cf-Access-Jwt-Assertion` JWT even when Cloudflare
Access is configured at the edge. Header presence is not authentication. The
verification contract is:

- obtain keys only from the configured Zero Trust organization's JWKS endpoint;
- select the public key by `kid` and verify the signature;
- require the configured team-domain issuer and the exact admin application's
  audience tag;
- enforce token time claims and fail closed on an unknown key, failed refresh,
  missing claim, or malformed token; and
- derive the admin actor only from verified claims. Never log the assertion.

The Worker must not accept a caller-supplied issuer, audience, JWKS URL, email,
or group as configuration. Optional identity-detail lookups may enrich an audit
event after JWT validation; they do not replace validation of the application
token.

For a human token, the authorization and audit key is an issuer-scoped stable
subject such as `(iss, sub)`, or a separately validated issuer-scoped
`user_uuid` if the implementation documents its lifecycle. Email and IdP group
claims are display or policy metadata, not durable identity keys: both can
change or be reassigned. A missing stable human subject fails closed.

## Headless automation

A future admin automation endpoint may admit CI or an operator tool with an
Access service token under a `Service Auth` policy. Service credentials belong
in the operator's secret manager and have an explicit owner, purpose, expiry,
rotation, and revocation procedure.

AgentCall will keep Access credentials out of the current user
`~/.agentcall/config.json`. It will also not configure Access's single-header
mode on `Authorization`: AgentCall already owns that header for its handle
Bearer token. A headless admin client uses the standard
`CF-Access-Client-Id` and `CF-Access-Client-Secret` headers for admission, or
the returned Access token in `cf-access-token` where the configured policy
permits JWT reuse.

An Access service token identifies an automation principal, not a human and
not an AgentCall handle. The application authorization and audit model must
represent that distinction explicitly. A valid service token alone does not
grant an application role. Service-token JWTs have an empty `sub`, so they are
keyed by a verified, issuer-scoped service identifier such as `common_name` or
`service_token_id`; an empty subject can never collapse multiple automations
into one actor.

## Browser request integrity

Access authentication can arrive through the `CF_Authorization` browser
cookie. It proves the admitted identity, not that the user intended a
state-changing request. Every future browser admin mutation must therefore
enforce an application CSRF boundary: a session-bound CSRF token or an
equivalently reviewed mechanism, strict `Origin`/`Referer` validation, and the
most restrictive cookie `SameSite` policy compatible with the login flow.
Read-only handlers must not mutate state as a side effect. Access admission and
application RBAC do not waive this requirement.

## Self-hosted ownership

The supported self-hosted shape is customer-owned:

- the relay owner creates and pays for its Cloudflare/Zero Trust account;
- the owner connects its IdP and controls Access membership and policy;
- the owner assigns a distinct admin hostname and removes unprotected origins
  and alternate routes; and
- AgentCall validates that owner's configured issuer and application audience
  inside the Worker.

Cloudflare Access can connect multiple IdPs simultaneously. The reason not to
use the AgentCall-operated Access organization for hosted customer SSO is
therefore ownership, not a claim that multiple IdPs are impossible. Doing so
would make the AgentCall operator configure and administer customer IdP
connections, Access applications, account limits, policy mappings, offboarding,
and SCIM lifecycle in its own Cloudflare control plane. It would not give each
tenant a customer-owned, self-service identity boundary. #15 must choose that
hosted product architecture separately.

## Deployment acceptance contract

The first implementation of either supported shape is incomplete until it has
all of these properties:

1. Access covers the exact admin hostname. `workers.dev`, preview aliases,
   fallback origins, and any other route that could reach the same handler are
   disabled or independently protected.
2. The Worker revalidates signature, `kid`, issuer, audience, and expiry using
   pinned configuration and fails closed.
3. Human and service actors are typed separately and keyed by their verified,
   issuer-scoped stable identifiers, then pass application RBAC and tenant
   checks before any mutation. Email is never the durable actor key and an
   empty service `sub` is never accepted as one.
4. JWTs, service-token secrets, and raw authentication headers are redacted
   from application, Access, test, and CI logs.
5. Browser mutations enforce CSRF and origin protections independently of
   Access and RBAC.
6. Negative tests cover missing and spoofed assertions, wrong issuer or
   audience, expiration, unknown keys, human/service confusion, email reuse,
   empty-subject service collisions, a valid Access identity denied by
   application RBAC, cross-site mutations, and attempted direct-origin access.
7. Operations documentation covers IdP and policy ownership, emergency
   revocation, key/JWKS failure, service-token rotation, and a break-glass path
   that does not create a permanently unprotected route.

The deployment review must inspect Cloudflare configuration as well as Worker
code. Unit tests cannot prove that an alternate hostname or origin bypass is
absent.

## Rejected alternatives

### Protect the entire relay with Access

Rejected because it conflates workforce admission with AgentCall's public
machine protocol, breaks existing CLI/WebSocket authentication, and forces a
second credential onto every caller.

### Trust the edge-injected header

Rejected because a routing or origin-exposure mistake would turn a spoofable
header into administrator identity. Worker-side JWT validation is a required
defense-in-depth boundary.

### Use Access as hosted tenant SSO

Rejected for this issue. Multiple IdPs do not supply customer-owned tenancy,
self-service enterprise setup, SCIM lifecycle, or AgentCall application RBAC.
Those remain product decisions in #15.

### Build middleware before the surface exists

Rejected because dead security code cannot be exercised against real routes,
actors, deployment configuration, or browser/headless flows. The acceptance
contract above should drive the implementation alongside #17 and #12.

## Sources checked

Cloudflare documentation was checked on 2026-08-02:

- [Validate the Access JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
- [Identity providers](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/)
