# Identity and address separation

> **Historical design record — not current documentation.** This file is
> dated and never revised; it explains why the 2026-08-02 decision was made,
> not what the code does now. Read the repository `README.md` and
> `CHANGELOG.md` for current behavior. The living reference is in
> [`docs/research/reference-implementations.md`](../../research/reference-implementations.md).

**Date:** 2026-08-02

**Status:** Decided; requires a dedicated zero-user cutover before #15, #16, or #101

**Issue:** [#100](https://github.com/KenTaniguchi-R/agentcall/issues/100)

## Decision

AgentCall will separate four concepts that the current `(org, handle)` row
collapses:

1. **Agent identity** is an opaque, relay-assigned `agent_id` representing one
   principal lifetime inside one organization.
2. **Address** is the human-facing, routable `handle@host` currently bound to an
   identity. A handle can be released and later bound to a different identity.
3. **Credential** is one revocable proof that authenticates an identity. An
   identity may hold multiple credentials; no credential value, hash, public
   key, or JWK thumbprint is the identity identifier.
4. **Line/session** is one connected endpoint that can answer for an identity.
   It is neither the identity nor the address; #44 decides its concrete model.

The user-visible name and routing syntax remain `handle@host`. The opaque
`agent_id` is the incarnation that distinguishes successive owners of that
address. Any durable authorization, membership, card, audit subject, or runtime
state attaches to `agent_id`, never only to the reusable handle.

This structural cutover happens in a dedicated change after the in-flight #52
recovery work, but before SSO/SCIM (#15), handle reclaim (#16), or Agent Card
signing (#101). Those features must not add another dependency on `(org,
handle)` as a permanent subject key.

The normal CLI continues to present setup and routine use as one saved login.
Users do not need to learn the internal identity model or manually exchange
tokens. Administrative commands and audit exports may expose stable agent and
credential IDs because listing and revoking one credential requires them.

## Current coupling

Today the `handles` table has primary key `(org, handle)` and stores the only
Bearer-token hash on the same row. That pair also selects or names:

- native and A2A card rows;
- roster membership and caller group policy;
- Durable Object instances and their presence/call state;
- call/presence rate-limit subjects;
- invitation provenance and roster audit actors; and
- the identity returned by every authenticated relay request.

This means a future delete-and-reinsert of the same handle could inherit the
previous owner's card, roster authority, policy grants, Durable Object state,
cached discovery, and audit continuity. Remembering to clean each table and
object in the release endpoint is not an identity boundary. A new feature could
reintroduce inheritance simply by keying one more row by handle.

## Identity lifetime and scope

`agent_id` is a random, opaque identifier created by the relay at enrollment.
It is stable for the principal lifetime and scoped by the relay trust domain
and organization. It is not derived from a handle, email address, device,
credential, or signing key. A relay must not interpret an identifier copied
from a different trust domain as the same principal.

An identity does not silently move between organizations. Organization
transfer, merging identities, or splitting one identity into several are
separate explicit operations, not updates to an address row.

The public routing address remains `handle@host`, consistent with the
[agent identity compatibility decision](2026-08-02-agent-identity-compatibility.md).
The durable subject is `agent_id` scoped by the expected trust domain and
organization; the handle is its authenticated routing binding, not part of the
stable subject. A rename changes that binding without changing identity. A
different `agent_id` later bound to the same address is a replacement
principal, not a key rotation.

An `agent_id` is not self-authenticating. On the same relay, only the relay may
derive it from a verified credential and inject it into call/presence frames;
clients never choose their actor ID in a request body or header. Across relays,
an asserted ID is untrusted until it is bound to the expected host and address
through that host's authenticated discovery/signing contract. A random opaque
value copied from another host does not establish continuity.

## Address binding and reclaim

An address binding records which identity currently owns `(org, handle)`, when
the binding began, and when it ended. At most one active binding may exist for
an address, and an identity may have at most one active address. Historical
bindings remain available for security audit and reclamation evidence even
after the active name is released. Aliases or several simultaneous addresses
would require a separate routing design; #44's lines/sessions do not create
additional identities or address bindings by accident.

The important operations are distinct:

- **rename:** move the same identity to another handle without changing its
  durable state or credentials;
- **release:** end the active binding and make the old address unroutable;
- **reclaim:** create or select a different identity, then create a new binding
  for the available handle; and
- **disable identity:** stop all of that identity's credentials and routes
  without making its address available to someone else.

Reclaim never transfers cards, roster memberships, caller grants, task state,
contexts, Durable Object state, or credentials. A replacement starts with new
state. A local contact or caller policy pinned to the old `agent_id` fails
closed until its owner explicitly accepts the replacement identity.

Release does not implicitly disable the identity. Its existing credential may
authenticate only to an explicit, narrow address-management flow that can bind
that same identity to an available address under organization policy. An
addressless identity cannot call, listen, publish a card, join/use a roster,
mint invites, or reach another normal relay operation. Those endpoints require
an active binding. Rename should replace the binding atomically so a successful
rename has no observable addressless interval. Disabling the identity rejects
its credentials even on the rebind flow; recovery then requires separately
authorized organization administration.

## Storage ownership

The cutover should establish these ownership directions; exact table names and
indexes remain implementation details:

```text
organization
  └─ agent identity (agent_id, lifecycle)
       ├─ address bindings (handle, assigned/released timestamps)
       ├─ credentials (credential_id, hash/key, lifecycle)
       ├─ card and signing-key bindings
       ├─ roster memberships and policy subject bindings
       ├─ Durable Object / task / context state
       └─ lines or sessions
```

Display and routing records may retain the current handle as a snapshot, but
that snapshot is not a foreign key or authorization subject. Audit records keep
both stable `agent_id` and the address shown at event time so later rename or
reclaim does not rewrite history.

Durable Objects must be named by the stable identity, not by `(org, handle)`.
An address lookup resolves to `agent_id` before the object is selected. Release
makes the old address stop resolving; reclaim resolves the address to a fresh
object. Object retention and deletion remain explicit lifecycle policy rather
than a side effect of name reuse.

## Credential boundary

The initial cutover may preserve today's single long-lived Bearer token
behavior, but its stored row belongs to `agent_id` and has its own opaque,
non-secret, relay-unique `credential_id`. The schema must permit more than one
credential per identity so safe rotation can be mint-new, migrate, then
revoke-old instead of an outage-causing hard swap.

Authentication selects a credential by non-secret ID or prefix, verifies its
secret proof, checks that the identity is active, and obtains `agent_id` from
the credential record. Address-scoped operations additionally resolve and
require the identity's one active address; only the explicit rebind flow admits
an active but addressless identity. Authentication must not select the security
principal from a caller-supplied handle and merely use the credential as a
password for that row. A compact saved “token” may encode the credential ID and
secret while the CLI keeps that representation opaque to users. If an
implementation shortens the ID to a lookup prefix, uniqueness is enforced by
storage and generation retries; it never selects the first of several matching
credentials.

#98 decides expiry, renewal, last-used coarsening, use limits, and revocation
semantics. This decision only requires that those fields live on credentials,
not on identity or address rows. #101's public signing keys are also
credentials: rotating one must not create a new identity, while rebinding a
handle to another `agent_id` must not make the new owner capable of using the
old key.

Infisical's current Universal Auth model is useful precedent, not a schema to
copy wholesale. It creates an organization-scoped machine identity, permits
separate client secrets with their own TTL/use/revocation state, and exchanges
a client ID plus secret for a bounded access token. AgentCall adopts the entity
and credential boundaries. It does not adopt Infisical's complete permission
surface, defaults, or token lifecycle before #98 decides them.

## CLI contract

Routine setup remains simple:

1. The CLI redeems an organization invite and chooses a handle.
2. The relay creates an identity, active address binding, and initial
   credential atomically.
3. The CLI saves the returned login material and continues to send authenticated
   requests without asking the user to reason about identity IDs.

The config format may gain internal, versioned `agent_id`, `credential_id`, and
secret/access-token fields. User-facing output still leads with the address and
calls the saved proof a token unless a credential-management command needs a
more precise noun. A future client-ID/client-secret exchange and refresh loop
must be transparent during normal `call`, `listen`, `status`, and card
operations, fail before expiry when renewal is impossible, and update stored
material atomically.

One user-facing `token` concept does not mean one database credential forever.
It means the CLI owns exchange, caching, refresh, overlap, and migration rather
than exporting those mechanics into every command invocation.

## Zero-user cutover

There is no compatibility benefit to dual-reading the old `(org, handle)` model
when there are no users. The implementation should be one coordinated cutover:

- take a D1 backup and verify the expected row counts before migration;
- add a new forward migration rather than rewriting already-recorded files;
- fail the migration if identity-bearing production rows unexpectedly exist,
  instead of guessing identity continuity from a handle;
- update D1 ownership, authentication results, Durable Object naming, public
  frames, caches, policies, tests, and current documentation together; and
- delete old read/write paths rather than keeping a fallback or shadow-write
  period.

If production evidence contradicts the zero-user premise, stop and design an
explicit, reviewed mapping and rollback plan. Do not silently manufacture
`agent_id` values and claim they preserve historical identity.

The cutover must coordinate with #52 because recovery currently adds credential
state to `handles`. Landing both refactors independently would create migrations
that immediately rebuild one another and make the security owner unclear. #52
may land first, but the identity cutover then moves recovery material onto the
credential or identity-recovery boundary chosen by that design.

## Required acceptance tests

The identity cutover is incomplete until tests prove:

- releasing and reassigning one handle creates a different `agent_id` and fresh
  Durable Object, card, roster, task, context, and policy state;
- an old token, recovery proof, or signing key cannot authenticate the new
  owner of the same address;
- a client-supplied `agent_id`, mismatched credential/address tuple, or foreign
  unverified ID cannot choose or impersonate a security principal;
- a policy/contact pinned to the old identity does not authorize the
  replacement until explicitly re-bound;
- renaming an identity preserves its state and credentials while the old
  address stops routing;
- releasing an address blocks every normal relay operation while preserving
  credential access only to the explicit rebind flow; disabling the identity
  also blocks that flow;
- concurrent attempts to give an identity two active addresses, or an address
  two active identities, cannot both succeed;
- credential rotation preserves `agent_id` and supports an explicit overlap
  without changing address ownership;
- a duplicate credential ID or shortened-prefix collision cannot select the
  wrong identity and is rejected or regenerated before issuance;
- two organizations may use the same handle without sharing identity, state,
  credentials, keys, policy, or audit subjects;
- audit events retain stable identity and event-time address after rename,
  release, and reclaim;
- registration creates identity, binding, and credential atomically, and a
  partial failure consumes neither the invite nor the address; and
- unexpected pre-cutover production rows make the zero-user migration fail
  closed.

## Rejected alternatives

### Keep `(org, handle)` as identity and add cleanup

Rejected because safe reclaim would depend on an ever-growing list of cleanup
sites. It also makes rename an identity replacement and lets future tables
silently reintroduce inheritance.

### Use a token hash or signing key as identity

Rejected because routine credential rotation would look like a new principal,
while credential loss would erase authorization and audit continuity. Public
keys are rotatable verification material, not subject IDs.

### Adopt the complete Infisical model now

Rejected as unnecessary breadth. AgentCall needs the stable subject/address/
credential seams now; TTLs, renewable sessions, trusted networks, lockout,
roles, and use limits land only with their owning issues and threat models.

### Hide stable identity entirely

Rejected for administrative surfaces. Humans should not need `agent_id` for a
normal call, but audit, revocation, policy pinning, incident response, and
reclaim safety require a non-secret identifier that survives address changes.

## Sources checked

Infisical's official documentation and current source were checked through
Context7 on 2026-08-02:

- [Machine identities](https://github.com/infisical/infisical/blob/main/docs/documentation/platform/identities/overview.mdx)
- [Universal Auth](https://github.com/infisical/infisical/blob/main/docs/documentation/platform/identities/universal-auth.mdx)
- [Identity API](https://github.com/infisical/infisical/blob/main/backend/src/server/routes/v1/identity-router.ts)
- [Universal Auth client secrets](https://github.com/infisical/infisical/blob/main/backend/src/server/routes/v1/identity-universal-auth-router.ts)
