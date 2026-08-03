# Cross-organization federation is a non-goal

> **Historical document — not current documentation.** This is a dated
> decision record that describes the repository state on 2026-08-02 and is
> deliberately *not* updated when behavior changes.

**Date:** 2026-08-02

**Status:** Decided

**Issue:** [#189](https://github.com/KenTaniguchi-R/agentcall/issues/189)

## Decision

Cross-organization calling, federation, and any inter-organization routing are a
**standing non-goal**. They are not deferred, not gated behind a precondition,
and not a later tier. The organization is the outermost boundary AgentCall
routes within, permanently.

Two consequences follow immediately:

- **No feature may assume a caller outside the organization.** A design that
  needs one is out of scope, not blocked.
- **If a cross-organization path appears, delete it — do not gate it.** A
  disabled federation path still carries its schema, its tests, and its
  reviewer burden. Simplicity is the point of the decision, so the cleanup is
  removal, not a flag.

**A human belonging to two organizations is also out of scope** as of this
record. One credential belongs to one organization. Multi-org identity is not a
deferred requirement to design around; it is not a requirement.

## Why

The reason is cost, not capability. Cross-organization routing does not add one
control — it changes what every existing control has to prove:

- **Mutual org authentication.** Reachability between two tenants has to be
  established by both sides and revocable by either, with the negotiation, its
  audit trail, and its revocation semantics as new durable state. That is the
  NATS export/import shape, and it is a subsystem, not a flag.
- **External caller identity.** The callee's policy engine decides *may this
  caller invoke this task?* An in-organization caller is answerable to the same
  administrator as the callee. An external one is not, so the mapping from an
  outside principal to a local authorization subject becomes load-bearing.
  (#10 existed for exactly this; it is closed by this decision, since in-org
  callers are already resolved by `authenticateRequest` and there are no
  external ones.)
- **Prompt-injection provenance crosses a trust boundary.** The residual risk
  already recorded in the README — a colleague's agent induced to place a call
  by something it read — is bounded today because the induced caller is still
  inside one administrative domain. Across organizations that bound is gone,
  and #1 (`exec`) is still open.
- **Abuse surface.** Invite authority is decentralized and per-caller rate
  budgets are per handle. Inside one tenant that is an accepted residual risk
  with an accountable administrator behind it. Opened outward it becomes an
  unaccountable one.
- **Audit, residency, and disclosure** all currently assume one organization
  owns every party to a call. Cross-organization calls make each of those a
  two-party question.

None of that is unsolvable. It is disproportionate to the value, and it is
work that competes directly with the enterprise track (#15, #16, #17, #18).

## What this supersedes

The [organization-scoped call reachability
record](./2026-08-02-organization-scoped-call-reachability.md) left the door
open:

> Cross-organization federation remains unsupported. If it is added, it belongs
> between organizations and must default closed…

That conditional is withdrawn. The decision is not "closed by default if
added"; it is "not added." The rest of that record — organization as the
reachability boundary, rosters as relationship groups rather than nested
tenancy, calls open inside the boundary — stands unchanged.

## Current state as of this record

No cross-organization feature exists to remove. Every path rejects it:

- `apps/relay/src/tenant.ts` — `requestOrg` derives the organization from the
  request, and `authenticateRequest` verifies the handle token against that
  organization; an Acme credential cannot select Beta.
- `apps/relay/src/a2a.ts:50` — the per-agent A2A card requires an authenticated
  identity and reads cards keyed by `(org, handle)`. Only the service-level
  directory card at `/.well-known/agent-card.json` is unauthenticated, and it
  describes the relay, not an agent.
- `packages/cli/src/contacts.ts:109` — `resolveAddress` rejects a hosted
  address belonging to a different organization rather than silently routing
  its bare handle inside the caller's tenant.

The cleanup obligation is therefore forward-looking: keep it this way.

## Where it is most likely to creep back in

- **The A2A track** (#9, #11, #21, #101, #179). A2A is an interoperability
  protocol whose natural framing is agents from different operators. Under this
  decision, A2A is an in-organization protocol surface. #10 was
  external-principal mapping and is closed on that basis; #179's "external
  roots" blocker dissolves with it. The surface to watch is any future inbound
  A2A execution route — `apps/relay/src/a2a.ts` ships card reads only today.
- **Self-hosted relays** (#12). Two self-hosted deployments are two
  organizations. A call between them is cross-organization routing regardless
  of who operates the infrastructure.
- **Address format work** (#154). Removing the outermost routing boundary from
  the address is only safe *because* of this decision. That makes it a
  dependency, not an assumption — if this decision is ever revisited, the
  address format is revisited with it.

## Verification invariants

The invariants in the reachability record continue to hold and continue to be
tested. This record adds one:

- there is no code path, flag, configuration value, or documented procedure by
  which a credential issued for one organization reaches a handle in another.

Reversing this decision requires a new dated record, a README security-model
update, and the removal of this record's constraint from `CLAUDE.md` — in the
same pull request.

## References

- [Organization-scoped call reachability](./2026-08-02-organization-scoped-call-reachability.md)
- [Identity/address separation](./2026-08-02-identity-address-separation.md)
- #59 — org as tenant, not gate (decided: tenant)
