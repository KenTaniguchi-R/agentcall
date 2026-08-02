# Subject erasure and retention

> **Historical design record — not current documentation.** This file records the
> 2026-08-02 decision. The living behavior and implementation status are in
> [`docs/security/data-residency.md`](../../security/data-residency.md) and
> [`docs/security/audit-retention.md`](../../security/audit-retention.md).

**Date:** 2026-08-02  
**Status:** Decided; implementation depends on stable `agent_id` ownership and audit export  
**Issue:** [#160](https://github.com/KenTaniguchi-R/agentcall/issues/160)

## Decision

AgentCall commits to a supported subject-erasure path and time-bounded hosted-relay
retention. Indefinite, unexplained retention is not the product policy.

Erasure and handle reclaim are separate authorized operations, but they share the same
post-`agent_id` address-lifecycle module:

- **Erasure ends the binding and starts a 30-day address quarantine.** The quarantine
  contains the address and release time, but no old `agent_id`, credential, card, or
  erasure-request reference. It prevents an immediate replacement from impersonating a
  recently erased address in human workflows and caches. It is identity-unlinked, not
  anonymous: a human-facing handle can still identify or single out the former owner,
  so the retained record remains potentially personal data and is disclosed.
- **Reclaim is explicit, never automatic.** After quarantine, #16 may bind the address
  to a fresh `agent_id` and Durable Object only through verified organization
  administration. No enrollment can take the address during quarantine. At the exact
  30-day boundary the quarantine row is hard-deleted; the address then becomes eligible
  for a new organization-authorized binding without retaining former-owner metadata.
  The replacement still receives a fresh identity and never inherits state.

This chooses reclaim after a bounded quarantine, not a permanent tombstone. It depends
on the stable identity/address cutover and #16's safe binding operation; it is not a
cleanup workaround for today's handle-keyed Durable Objects.

Audit evidence uses **crypto-shredding plus bounded retention**, not mutable
free-form history. Subject-bearing audit fields are encrypted under per-subject erasure
keys. Erasure destroys the subject mapping and key while preserving the structured
event, action, time, and ciphertext. This retains evidence that an action happened
without keeping a readable handle, IP address, country, or prose description. The
remaining pseudonymous event is still treated as personal data and expires normally.

These are product defaults, not legal conclusions:

- security-audit events: **400 days**;
- source IP and country inside audit evidence: **30-day ordinary maximum**, even when
  the event remains; only an explicit legal/incident hold may exceed it;
- terminal invite rows: **30 days**, matching the cleanup already implemented;
- cards, memberships, credentials, active address bindings, published keys, contexts,
  inbound policy references from other cards, and live Durable Object state: delete
  during erasure;
- legal holds may extend ordinary expiry only through an authorized, tenant-scoped,
  audited policy. A hold does not silently defeat a subject request; it produces an
  explicit exception in the erasure result.

The 400-day event default covers one annual security-review cycle plus operational
margin. It is not a claim that every customer or jurisdiction requires 400 days.
Configuration, export, legal holds, and shorter/longer **event** windows land with
#17/#18 and must stay within an explicitly reviewed bound. The ordinary network-evidence
window is not tenant-configurable above 30 days; an authorized hold is a separately
reported exception, not a longer default.

## Why this shape

The storage-limitation principle requires identifiable data to be kept no longer than
necessary, and erasure has enumerated exceptions rather than an unlimited “audit”
exception. Pseudonymisation reduces risk but does not by itself remove data from data-
protection scope. Security-log guidance likewise treats disposal and retention policy
as parts of log management, not reasons to retain everything forever.

That rules out three tempting shortcuts:

1. deleting active rows while leaving readable handles and IPs in audit prose;
2. calling an opaque stable ID anonymous while the relay still holds its mapping; and
3. promising immediate deletion from live D1 while ignoring Analytics Engine, Time
   Travel, exported backups, logs, and a later restore.

The product therefore needs both an erasure workflow and an ordinary retention
workflow. Neither substitutes for the other.

## Ownership model

Erasure is keyed by stable `agent_id`, never by the current handle. The accepted
[identity/address decision](2026-08-02-identity-address-separation.md) already makes
cards, credentials, memberships, keys, runtime state, and address bindings children of
that subject. Implement erasure after that zero-user cutover rather than adding a second
ever-growing list of `(org, handle)` cleanup statements.

The ownership tree is:

```text
organization
  └─ agent identity
       ├─ address binding and credentials
       ├─ card, published keys, memberships and policy bindings
       ├─ contexts and Durable Object state
       ├─ subject audit-encryption key
       └─ audit references (retained by policy, unreadable after key destruction)
```

Invites and audit ledgers are organization-owned, not identity-owned. The lifecycle
module therefore scrubs or crypto-shreds subject references in those rows instead of
deleting organization evidence wholesale.

## Lifecycle module

Expose one deep module at the subject-lifecycle seam:

```ts
eraseSubject(request: {
  org: string;
  agent_id: string;
  authority: VerifiedAdministrativeAuthority;
  request_id: string;
}): Promise<ErasureResult>
```

The interface guarantees idempotency, fail-closed authority, resumability, an explicit
list of retained exceptions, and a result only after verification. Callers do not know
table order, audit cryptography, Durable Object cleanup, Analytics Engine limitations,
or backup replay rules.

D1 and Durable Objects cannot participate in one transaction, so the implementation is
a persisted state machine:

1. **Freeze:** atomically mark the identity erasing, increment its authorization epoch,
   revoke credentials, and end address routing. Every subject-reference writer rejects
   erasing/erased owners and targets at its storage statement, so a card, invite,
   membership, policy binding, key, context, or call cannot recreate a reference after
   freeze. Send the new epoch to the subject's Durable Object; it stores the epoch,
   rejects every frame carrying an older epoch, closes attached listener/caller sockets,
   cancels active calls, clears alarms, and acknowledges quiescence. The request remains
   `pending` and relational purge does not begin until that acknowledgement arrives.
   Failure after freeze never reactivates the subject.
2. **Relational purge:** in one D1 transaction delete subject-owned rows and inbound
   policy references, end the address binding, create the disclosed identity-unlinked
   quarantine record,
   sever invite provenance, delete subject-linked network-evidence sidecars, and
   destroy the audit erasure key.
3. **Object purge:** after quiescence, call the subject's Durable Object adapter to
   `deleteAll()` and verify the object is empty. Reclaimed addresses resolve to a
   different `agent_id` and therefore a different object. A failed purge cannot restore
   traffic because the identity epoch remains revoked in both D1 and the object.
4. **External-surface handling:** record the deadline for bounded sinks and backups
   that cannot target-delete, and make them part of the result rather than silently
   reporting success.
5. **Verify:** query every owned table and object through the same ownership registry.
   Complete only when no undeclared subject reference remains.

Production uses D1 and Durable Object adapters; tests use the existing local D1 and an
in-memory object adapter. Those are real adapters at remote-owned seams. The external
interface remains one lifecycle operation, giving every route and future table one
place to register ownership and verification.

## Audit schema direction

Before real volume exists, replace free-form identity-bearing audit fields with
structured fields:

- stable event ID, event name, action, organization, scope/target type, and time stay
  readable and append-only;
- actor and target subject references are opaque `agent_id` values;
- event-time display addresses and other subject-bearing details are encrypted
  separately for actor and target under their erasure keys;
- source IP/country lives in a separate short-retention evidence row, not in the
  append-only event; erasure deletes subject-linked evidence immediately and ordinary
  cleanup deletes it after 30 days;
- descriptions are rendered from structured event data at read/export time, not stored
  as prose that duplicates handles;
- destroying a subject key is itself an organization audit event that names the
  erasure request and aggregate row counts, never the erased handle.

Crypto-shredding preserves the append-only row and any future hash chain. It is a
safeguard, not magic anonymisation: pseudonymous clear fields retain the 400-day expiry,
access control, export, legal-hold, and backup requirements.

Because there are no users, the migration should fail closed if production contains
identity-bearing rows rather than guessing keys or rewriting meaningful history. Do
the schema cutover once; do not dual-write old readable prose and new encrypted fields.

## Surface contract

| Surface | Erasure action | Ordinary retention target |
|---|---|---|
| Identity, credentials, recovery material | Revoke/freeze, then delete | Subject lifetime only |
| Active address binding | End binding; retain a disclosed, identity-unlinked quarantine, then hard-delete it and allow organization-authorized reclaim onto a fresh identity | Subject lifetime; quarantine exactly 30 days |
| Card and published key records | Delete owned records; remove this subject from every other card's grants/blocks | Subject lifetime |
| Roster membership and subject policy bindings | Delete | Subject lifetime |
| Invite provenance | Remove subject link; keep terminal anti-replay row | 30 days terminal |
| Audit ledgers | Destroy subject erasure key, delete network-evidence sidecars, keep structured pseudonymous event | 400 days; network evidence 30 days |
| Durable Object state | Close, cancel, clear alarms, `deleteAll()` | Existing call/rate windows; immediate on erasure |
| Analytics Engine | No erasure claim while stable subject/IP dimensions are present; remove them or move the data to a deletable sink before launch | Vendor three-month window until replaced |
| Worker/account logs | Follow configured vendor retention; never log request bodies, tokens, or subject content | Account policy, disclosed separately |
| D1 Time Travel and exported backups | Keep an erasure manifest until the oldest copy expires; replay it before any restored database serves traffic | Vendor/operator backup window |
| Endpoint-local files | Local uninstall/purge remains separate and explicit | Device-owner policy |

## Completion and failure language

An erasure result has three states:

- `complete`: every target-deletable live surface is verified clean and each retained
  exception names its purpose and expiry;
- `pending`: the subject is frozen but a retryable purge/verification step remains;
- `held`: specifically authorized evidence is retained under a named hold and the result
  states which categories remain.

There is no generic success with warnings. A failed DO purge, unknown backup state, or
non-deletable analytics dimension keeps the request pending or held.

## Implementation gates

1. Land the zero-user `agent_id` ownership cutover (#154/#100) and #16's explicit
   address-lifecycle operation so erasure has one subject key and reclaimed names
   receive fresh state.
2. Refactor audit rows before they contain customer history; fail the migration if the
   zero-user premise is false.
3. Build #17's tenant export/checkpoint, bounded expiry, legal holds, and failure
   visibility before enabling automatic event deletion.
4. Remove stable subject/IP dimensions from non-deletable analytics or replace the sink.
5. Add a verified administrative authority through #15/#17; a Bearer handle token alone
   cannot erase a principal or place a legal hold.
6. Document Time Travel, managed backups, exports, logs, and restore replay in the
   operator runbook before advertising an erasure SLA.

## Required tests

- authority, organization isolation, request idempotency, and concurrent requests;
- freeze-before-delete, authorization-epoch rejection, attached-socket closure, DO
  quiescence acknowledgement, and no reactivation after partial failure;
- concurrent subject-reference writes cannot recreate owned or inbound references after
  freeze;
- every subject-owned table, address binding, invite reference, card, membership,
  credential, key, context, policy binding, and DO storage surface;
- crypto-shredded actor and target independently, including one event involving two
  subjects;
- descriptions cannot reintroduce erased handles and network evidence expires at the
  exact 30-day boundary;
- 400-day event cutoff, count cap interaction, export failure, legal holds, interrupted
  batches, concurrent writes, and configuration changes;
- 30-day address quarantine and clean fresh identity/object state after explicit reclaim;
- backup restore replays erasure manifests before serving;
- the ownership registry test fails whenever a subject-bearing migration has no declared
  erasure and retention behavior.

## Sources

- [EU GDPR Articles 5, 17 and 32](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng) — data minimisation, storage limitation, erasure grounds/exceptions, and security safeguards
- [EDPB pseudonymisation guidance announcement](https://www.edpb.europa.eu/news/edpb-adopts-pseudonymisation-guidelines-and-paves-the-way-to-improve-cooperation-with_en) — pseudonymised data remains personal data and requires its own safeguards
- [NIST SP 800-92, Guide to Computer Security Log Management](https://csrc.nist.gov/pubs/sp/800/92/final) — retention and disposal belong to an organization-wide log-management policy
