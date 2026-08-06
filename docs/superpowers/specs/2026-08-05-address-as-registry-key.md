# The address is a registry key, not a DNS locator

> **Historical document — not current documentation.** This is a dated
> decision record that describes the repository state on 2026-08-05 and is
> deliberately *not* updated when behavior changes.

**Date:** 2026-08-05

**Status:** Decided

**Issue:** [#307](https://github.com/KenTaniguchi-R/agentcall/issues/307)

## Decision

The canonical address becomes `@<org>/<handle>` — `@acme/ken`. Inside an
organization the bare handle `ken` is the everyday form. No hostname appears in
an address in any form.

## Why a hostname was there, and why it should not be

A hostname appears in an address for exactly one reason: federation. `ken@acme.com`
carries a host because a stranger's mail server must be told where to deliver. It
is a routing instruction aimed at someone who does not already know you.

AgentCall has no strangers. Every caller is authenticated to one relay, may only
reach their own organization ([federation non-goal](./2026-08-02-cross-organization-federation-non-goal.md),
#189), and already holds the relay URL in `cfg.relay`. Nothing resolves an
AgentCall address. There is no lookup step for a hostname to serve.

The grammar has always agreed. `HANDLE_RE` and `ORG_RE`
(`packages/shared/src/protocol.ts:3-4`) both forbid dots, so neither has ever
been able to hold a hostname, and the comment on `HOSTED_RELAY_HOST` already
says "This is deployment configuration, not protocol." The DNS wrapper was a
costume over a key that was already flat.

## Why `@acme/ken` rather than `ken@acme`

Both drop the vendor domain. The npm-scope shape is chosen because:

1. It is shaped like what it is — a key in a namespace, not an address at a host.
   Email shape is the one form that misrepresents the value.
2. The leading `@` reads as "an addressable entity" across Slack, GitHub, Discord
   and Twitter. That is learned behaviour we get for free.
3. It inherits an allocation policy. If `acme` is a registry key rather than a
   domain, someone must allocate it and ICANN no longer does that job. npm's
   answers transfer directly: scopes are first-come within a registry, one
   organization may hold several, published names are immutable.

Rejected: `ken@agents.acme.com` on a customer-verified subdomain. Cosmetically
ideal and vendor-free, but it promises resolution semantics we do not implement.
A key dressed as a locator is a trap regardless of whose domain it is.

## What this deletes

The hostname in the address is not merely redundant; it manufactures a class of
bug. `relayHostWarning` (`packages/cli/src/contacts.ts:100`) exists because an
address names a relay while the call is dialled on the calling line's relay, so
"calling a hosted address from a line registered elsewhere actually reaches
whichever `ken` is on that other relay." The function warns; its twenty-line
comment explains why it warns rather than rejects, and records that a merge once
reinstated the rejection and re-broke local development and self-hosting.

With no host in the address that situation cannot be constructed. The hazard, the
warning, the explanation, and the regression history all go.

| Deleted | Lines |
| --- | --- |
| `contacts.ts::relayHostWarning` + its comment | ~35 |
| `contacts.ts::addressTenant` | 6 |
| `tenant.ts::registrationAddressHost` | 6 |
| `tenant.ts::requestOrg` hostname branch | ~7 |
| `config.ts::addressHost`, `relayAddressHost` | 7 |
| `RegisterResponse.address` | 1 field |

Plus 63 occurrences of the host string across 13 test files.

The cross-tenant rejection (#66) gets *stronger*, not weaker. It currently derives
the target org by string-parsing a hostname (`addressTenant`); under `@org/handle`
it reads the org directly from the parsed address. A security boundary stops
depending on a suffix match.

## Address as a rendering

No composed address is stored or transmitted. Storage and the wire carry
`(org, handle)` and `agent_id`; the address is a pure function of those plus the
context it appears in:

```
render(org, handle, context) -> "ken"        // within the organization
                                "@acme/ken"  // sharing, rosters, audit, export
```

`RegisterResponse` currently returns `{ org, token, address }`. The `address`
field is the composed string and is what forces `registrationAddressHost` to
exist. It is removed; registration returns `org` and `handle` and the client
renders.

This is what makes the format cheap to change again: one function, not a
migration.

## Consequences accepted

**CSV escaping.** A leading `@` is a spreadsheet formula prefix. `csvCell`
(`packages/cli/src/commands/audit-export.ts:25`) already escapes `^\s*[=+\-@]`
with a leading apostrophe, so exports are safe, but every address in every audit
CSV will render as `'@acme/ken`. Accepted: correct escaping beats export
cosmetics. `acme/ken` without the leading `@` was the CSV-clean alternative and
was rejected for losing the entity signal in prose.

**Addresses are relay-scoped, not global.** A self-hosted deployment and the
hosted relay may each mint `@acme/ken` and they are different people. Acceptable
under the federation non-goal — the two can never meet — but it means the address
cannot double as a durable global identifier. `agent_id` is that identifier
(#154).

**Handles remain reassignable.** `0020_cards_by_identity` moves card, task and
grant ownership to the stable subject so reassignment cannot inherit policy. The
system is safe; a human reading an eight-month-old audit export is not. Anywhere
an address is written for later human reading, render `agent_id` alongside it.

**Org length.** `ORG_RE` permits 63 characters, so
`@acme-corporation-platform-engineering/ken` is currently legal and would trade a
vendor domain for a self-inflicted one. Cap near 20.

## Out of scope

`AGENTCALL_POLICY_EXT` (`packages/shared/src/a2a/card.ts:10`) is vendor-branded
and appears in machine surfaces, but it is a namespace identifier and changing it
is a protocol break. Separate decision.

The relay *endpoint* hostname is unaffected by this document. The relay still
lives somewhere and that somewhere is still named in `cfg.relay`, the
`wrangler.jsonc` route, and the docs — which is [#310](https://github.com/KenTaniguchi-R/agentcall/issues/310)
and its open PR #312. This decision removes the host from *addresses* only.

## Sequencing

PR #312 (#310) renames the host across 25 files, most of them address fixtures
this change rewrites again. The endpoint rename is still required — the relay
must live somewhere that is not `benree.tech` — so #312 is not wasted, but the
fixture churn is paid twice.

Recommendation: land #312 first because it is written and reviewable, then this
change on top. The double touch is a mechanical fixture sweep and is cheaper than
holding a finished PR.

## The address is inside signed transcripts

Found while implementing, and it changes the sequencing. `packages/shared/src/keys.ts`
holds a **second, independent** `ADDRESS_RE` — `handle@host` — and its comment
states a security property:

> The relay origin is part of the signed identity so a record published on one
> relay cannot be presented as valid on another.

`identityTranscript` signs `[..., address, identity_pub]` and
`encryptionKeyTranscript` signs `[..., address, key_id, suite, pub, epoch, ...]`.
The host inside `address` is therefore **load-bearing cryptographic binding**, not
decoration. Removing it without replacement would make `@acme/ken` signed on a
self-hosted relay indistinguishable from `@acme/ken` signed on the hosted relay,
and a key record published on one could be replayed against the other.

The fix is to make the binding explicit rather than smuggled inside a string:
`IdentityRecord` and `EncryptionKeyRecord` gain a `relay_origin` field, and both
transcripts cover it. That is strictly better than the status quo — a signed field
rather than a substring convention — but it changes transcript shape, which breaks
signatures and the `prev` chain links between encryption-key epochs. Free at zero
users, but it is a protocol change and deserves its own review.

The E2EE envelopes are already fine: `HpkeEnvelopeHeader` and `InnerBase` carry
`relay_origin` **explicitly** alongside host-shaped `from`/`to`, so there the host
in the address is already redundant.

Because the CLI builds envelopes whose `from`/`to` are validated by the keys.ts
grammar, the CLI cannot cut over to `@org/handle` before the crypto layer does.
The layers are coupled and must move in that order.

## Plan

1. **Grammar, additive.** `formatAddress`, `parseKeyAddress`, and a private
   `ADDRESS_RE` in `packages/shared/src/protocol.ts`, with round-trip and
   rejection tests. The outgoing `parseAddress` stays live and wired up so the
   tree remains green. **Done in this change.** `ORG_RE` also tightens from 63 to
   20 characters here.
2. **Relay origin becomes an explicit signed field.** Add `relay_origin` to
   `IdentityRecord` and `EncryptionKeyRecord`; include it in both transcripts;
   re-point the keys.ts `ADDRESS_RE` at the key grammar. Signature-breaking,
   reviewed on its own.
3. **Wire and relay.** Remove `RegisterResponse.address` and
   `registrationAddressHost`; `requestOrg` loses its hostname branch.
4. **CLI.** Delete `addressHost`, `relayAddressHost`, `relayHostWarning`,
   `addressTenant`; `resolveAddress` branches on `/`; the cross-tenant check reads
   the parsed org. Delete the outgoing `parseAddress`.
5. **Fixtures and docs.**

Each step keeps `pnpm -r build && pnpm -r typecheck && pnpm -r test` green. Step 1
deliberately leaves two address grammars in the tree; that is the drift hazard
this document otherwise warns about, and it is tolerable only because step 2
follows immediately and deletes one of them.
