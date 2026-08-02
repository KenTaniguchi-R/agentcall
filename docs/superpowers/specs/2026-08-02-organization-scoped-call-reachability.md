# Organization-scoped call reachability

> **Historical document — not current documentation.** This is a dated
> decision record that describes the repository state on 2026-08-02 and is
> deliberately *not* updated when behavior changes.

**Date:** 2026-08-02

**Status:** Decided; current behavior documented and regression-tested

**Issue:** [#123](https://github.com/KenTaniguchi-R/agentcall/issues/123)

## Decision

The organization is AgentCall's structural reachability boundary:

- an authenticated handle may call any registered handle in the same
  organization;
- a handle cannot address or authenticate into another organization;
- rosters do not gate call delivery;
- the callee's policy decides which tasks and capabilities a delivered caller
  may invoke.

We will not add a `closed` flag to rosters. Rosters remain relationship groups
for discovery, presence authorization, card projection, and relay-attested
callee policy. Treating them as nested tenancy boundaries would give one table
two incompatible meanings and make a handle's reachability depend on the
interaction of every roster it joins.

Cross-organization federation remains unsupported. If it is added, it belongs
between organizations and must default closed: both sides explicitly establish
the relationship, either side can revoke it, and a unilateral export or import
does not route traffic. That is the NATS account/export/import invariant at the
boundary AgentCall already has, rather than a reason to create another boundary
inside it.

## Why issue #123's recommendation changed

The issue's source snapshot predates two implemented controls:

1. issue #66 keyed handles, tokens, cards, Durable Objects, and lookups by
   `org + handle`; and
2. issue #74 replaced open registration with one-use tenant invites and made
   hosted addresses carry the organization in their hostname.

The current call path authenticates an organization-scoped identity, checks the
target in that same organization, and keys the target Durable Object with both
values. A valid Acme credential cannot select Beta, including when both tenants
have the same handle. The organization therefore already supplies the isolated
subject space that option A proposed adding through a closed roster.

Keeping calls open inside that boundary preserves the zero-negotiation first
contact flow. It also matches existing policy semantics: shared rosters add
relay-attested groups to a call but an empty group list is valid, and the
callee's local policy remains the task/capability enforcement point.

## Current threat boundary

The model is not "anyone on the internet can call anyone." It is:

> Any authenticated handle can reach any registered handle in its organization.
> The relay rejects anonymous and cross-organization callers; it does not use
> roster membership to arbitrate delivery. Consent over what the caller may do
> is enforced on the callee by policy.

Enrollment is invite-only, but invite authority is decentralized. Every
authenticated member may mint a one-use invite that expires after seven days.
A compromised member can mint multiple identities; because call rate limiting
is per caller in each callee's Durable Object, each enrolled handle receives a
separate hourly budget. Registration's five-per-minute source-IP limit slows
that amplification but is not an identity or administrator boundary.

This is an accepted residual risk in the current friends/small-team posture.
An enterprise enrollment design must centralize or policy-bind invite authority,
add revocation and abuse evidence, or otherwise make the organization roster
administratively meaningful. A closed *discovery roster* would not fix the
underlying ability to create organization principals.

## Verification invariants

- two authenticated peers in one organization can complete a call without a
  shared roster, including when each belongs only to a different roster;
- the delivered call carries an empty relay-attested group list in that case;
- the same target handle in another organization remains unreachable;
- a shared roster may add policy groups but never supplies caller identity;
- anonymous or invalid caller credentials are rejected before routing.

Any future reachability control must change these tests deliberately, update
the README security model, and add a new dated decision record in the same pull
request.

## References

- `apps/relay/src/index.ts` — authenticated `/v1/ws?role=call` routing
- `apps/relay/src/tenant.ts` — organization derivation and identity keys
- `apps/relay/src/groups.ts` — roster attestation, separate from admission
- `apps/relay/src/do.ts` — per-caller/per-callee call budget
- [NATS accounts and multitenancy](https://docs.nats.io/learn/security/accounts-and-multitenancy)
- [NATS cross-account authorization](https://docs.nats.io/learn/security/cross-account)
