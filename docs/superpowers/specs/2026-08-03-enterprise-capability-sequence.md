# Enterprise capabilities follow evidence, not issue numbering

> **Historical decision record — not current documentation.** This file records
> the decision made on 2026-08-03. Current behavior lives in `README.md`, current
> security contracts in `docs/security/`, and unfinished work in GitHub Issues.

**Date:** 2026-08-03

**Status:** Decided

**Issue:** [#102](https://github.com/KenTaniguchi-R/agentcall/issues/102)

## Decision

Use this dependency and delivery sequence for the hosted enterprise track:

1. establish the Workspace / Organizer / Member product vocabulary and
   self-service onboarding in #205, without building arbitrary custom roles;
2. complete tenant-scoped administrative and audit evidence in #17;
3. integrate hosted SSO through a managed provider only when a real enterprise
   deal requires it, tracked in #15;
4. add SCIM provisioning and IdP group synchronization only for a written
   customer requirement, tracked in #27; and
5. start the SOC 2 readiness program in #18 only after the controls whose
   evidence it consumes are implemented and demonstrable.

Issue numbers are identifiers, not a roadmap. Remove the `B.n` prefixes from the
enterprise issue titles rather than maintaining a second, misleading ordering
system.

Stable agent identity remains a cross-cutting prerequisite. #154 must land
before a role, IdP subject, provisioning record, or offboarding workflow is
treated as durably bound to an agent lifetime rather than today's reclaimable
handle address.

## What is already settled

- #65 delivered organization-scoped tenancy. Do not create another tenancy
  project or make SSO responsible for creating tenants.
- PR #201 delivered the initial `admin` / `member` authorization foundation and
  admin-only audit export. #205 owns the compatible user-facing Organizer /
  Member vocabulary and first-user flow; it is deliberately not custom RBAC.
- Customer-owned Cloudflare Access is the optional self-hosted workforce-access
  profile decided by #109. It does not solve hosted multi-tenant SSO.
- The current audit export is useful evidence, but #17 remains open for central
  call/tool/access/delegation events, the human admin surface, continuous export,
  retention, erasure, legal holds, and completeness operations.

## Hosted SSO: buy the federation boundary

Do not implement SAML parsing, XML signature validation, IdP-specific protocol
quirks, certificate rotation, or an enterprise connection portal in AgentCall.
The hosted product should consume a standards-based token from a managed SSO
provider and keep provider-specific administration behind a narrow adapter.

WorkOS is the currently evaluated candidate because its platform documents both
public-client PKCE and device authorization flows, and its per-connection pricing
matches a small number of enterprise customers. This is not a vendor commitment:
pricing, CLI flows, security posture, exportability, subprocessor terms, and
provider failure behavior must be rechecked when a named deal triggers #15.
WorkOS must not become a dependency of the customer-owned relay profile.

Hosted SSO maps verified IdP principals into the existing workspace and role
model. It does not invent that model, replace application authorization, or turn
email/group claims into durable identity keys.

## SCIM: a separate, later product

SCIM is not part of the first hosted SSO integration. #27 owns provisioning,
deprovisioning, and IdP-sourced group membership after all of these are true:

- a customer has requested the behavior in writing;
- hosted SSO has a stable tenant and subject mapping;
- #154 supplies stable agent identities for lifecycle binding; and
- #26 has settled how group-backed policy interacts with local policy.

A SSO login and a continuously synchronized directory have different failure,
offboarding, audit, retry, and support contracts. They must not share an issue or
be advertised as one feature.

## SOC 2 follows implemented evidence

#18 is blocked on #17, but #17 alone is not a certification gate. The readiness
program also needs the endpoint-security, identity lifecycle, access control,
retention/erasure, incident response, change management, vendor, and operational
controls named by its eventual scope.

When a deal requires an attestation path, evaluate a Type I report first for the
point-in-time control design while operating evidence accrues for Type II. Do not
start a report clock or claim audit readiness while product controls are still
roadmap items.

## Procurement documents

Do not create speculative trust-page questionnaire or DPA implementation issues
now. Open them when a named sales process has an owner, target jurisdiction,
subprocessor inventory, and deadline. Existing living security documents remain
the source material; a marketing trust page or legal template must reflect the
deployed product and reviewed terms rather than guessed future commitments.

## Consequences for the issue tracker

- narrow #15 to deal-triggered, managed hosted SSO;
- keep #27 as the deferred SCIM and IdP-group integration instead of creating a
  duplicate;
- mark #18 blocked on #17 and the other implemented-control prerequisites;
- keep #205 as the next role/onboarding product layer;
- keep #17 open until its remaining evidence and administration scope ships; and
- remove `B.n` title prefixes from #15 through #18.

## References

- [Reference implementations](../../research/reference-implementations.md)
- [Cloudflare Access boundary](./2026-08-02-cloudflare-access-boundary.md)
- [Identity and address separation](./2026-08-02-identity-address-separation.md)
- [GTM sequencing and privacy positioning](./2026-08-03-gtm-sequencing-design.md)
- [EnterpriseReady audit log guide](https://www.enterpriseready.io/features/audit-log/)
- [WorkOS CLI Auth documentation](https://workos.com/docs/authkit/cli-auth)
