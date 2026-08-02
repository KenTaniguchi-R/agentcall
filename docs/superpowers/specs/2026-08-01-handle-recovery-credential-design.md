# A recovery credential for a lost handle token

**Date:** 2026-08-01
**Status:** **Design, approved.** Ready for an implementation plan. Nothing built yet.
**Issue:** [#52](https://github.com/KenTaniguchi-R/agentcall/issues/52)
**Reviewed:** adversarially by Codex against the tree at `a2166d3`. The review killed
an earlier design outright (see "What the review killed") and corrected the
concurrency shape below. Every file reference was verified, not asserted.

## The problem

The token is a single unbacked copy of a credential that can never be reclaimed.

- `/v1/token/rotate` (`apps/relay/src/index.ts:80`) authenticates with the token you
  just lost.
- Handle release is deliberately unimplemented (`apps/relay/src/index.ts:71-75`).
- `saveConfig` writes one file (`packages/cli/src/config.ts:70-75`). There is no
  second copy anywhere.

So every way to lose that file is unrecoverable: the `--handle` clobber (#43), the
pre-0.5 upgrade orphan, `uninstall --purge`, disk failure, a lost laptop, a stray
`rm`. Guarding entry points one at a time is whack-a-mole against a catastrophe
downstream of all of them.

## Why this, and why now

Issue #52 argues urgency from a claim that is false: that a recovery code "cannot be
retrofitted onto credentials already in the wild." It can. `recovery_hash` is
nullable, and any handle whose owner still holds the token can mint one on demand at
any point in the future. Only already-lost handles miss out, and those are lost under
every scheme.

So the honest case is not a deadline. It is two things:

1. **Every day without it is a day a loss becomes permanent.** Cheap retrofit does not
   retroactively save the handle someone loses next week.
2. **It is a prerequisite for handle release (#16), not a sequel to it.** Release
   raises the question "is this the same person coming back, or a stranger taking the
   name?" A continuity credential is the only thing that lets the relay answer.
   Without one, release can only ever fail closed and burn every saved contact
   pointing at that handle.

The second point is the stronger one and it emerged from the review, not the issue.

## What the review killed

The first draft of this work proposed something else entirely: a `generation` column
on `handles`, Durable Objects addressed as `handle#generation`, and owner-initiated
release. Its sequencing argument was that DO addressing cannot be retrofitted, so it
had to land before durable offline delivery made the cutover expensive.

**That argument is wrong.** Address the DO as
`generation === 1 ? handle : \`${handle}#${generation}\``. Generation 1 keeps the
legacy DO name, so no existing Durable Object is ever re-addressed — not at cutover,
not after durable mailboxes land. Only a released-and-reused handle gets a fresh DO.
The `handles` row is already the indirection table. The retrofit is cheap at any
time, and the window that design claimed was closing does not exist.

The review also found that the proposed scope would have shipped two security bugs:

- **Roster membership inheritance.** `roster_members` is keyed
  `PRIMARY KEY (roster_id, handle)` (`apps/relay/migrations/0004_rosters.sql:12`) and
  `/v1/roster/:id/bundle` states that "Membership is the real authorization." A
  released-and-re-registered handle silently inherits every private roster membership
  of the former owner, with no roster secret.
- **Card and A2A identity inheritance.** `cards` is keyed by handle with no
  incarnation check (`apps/relay/src/index.ts:107,121`), and the A2A AgentCard
  (`apps/relay/src/a2a.ts:35`) is served from it. A new registrant immediately
  presents the previous owner's description, task catalogue, default offers and
  grants. A2A ETags are `handle` + `updated_at`, so release does not even invalidate
  the cache.

Neither is in this spec's scope. Both are recorded on #16, where they belong: **cards,
roster members, live WebSocket attachments, and soon A2A tasks all key off the bare
handle.** That is the real content of handle reclamation and it is larger than either
this issue or the design that was killed.

## Design

### Schema

Migration `0005_handle_recovery.sql`:

```sql
ALTER TABLE handles ADD COLUMN recovery_hash TEXT;
ALTER TABLE handles ADD COLUMN recovery_redeemed_at INTEGER;
```

Both nullable. `recovery_hash IS NULL` means "never issued" — the retrofit state for
every handle registered before this lands. SQLite accepts `ADD COLUMN` with no
default for a nullable column; existing rows get NULL.

### The code

Crockford base32, 24 characters (120 bits), prefixed and grouped in fours:

```
agcr_JB6H-9K2M-QT4X-7NPW-5RZC-8EYD
```

- **Crockford, not base64url.** The token is base64url (`apps/relay/src/auth.ts`) and
  nobody transcribes it. Crockford excludes `I`, `L`, `O` and `U`, is
  case-insensitive, and survives being read off a sticky note or over the phone. The
  common path is still copy-paste into a password manager; hand transcription is the
  fallback that has to work.
- **`agcr_` prefix.** Makes the credential greppable and gives secret-scanning a
  pattern to match. Same reasoning as `doctor`'s provenance checks.
- **A word list was rejected.** ~88 bits from a 2048-word list is memorable and adds
  a 13KB dictionary to the Worker bundle plus a normalization problem (homophones,
  locale, plurals). Not worth it for a credential that lives in a password manager.

### Endpoints

Two, not one. The issue proposed an `X-AgentCall-Recovery` header on
`/v1/token/rotate`; two auth paths in one handler is where this grows bugs, and they
need different rate limits and different failure semantics.

| route | auth | effect |
|---|---|---|
| `POST /v1/recovery/issue` | handle token | mints a new code, **replaces** any existing one, returns it once |
| `POST /v1/recovery/redeem` | recovery code | returns a **new token and a new code**; the redeemed code is dead |
| `GET /v1/recovery/state` | handle token | `{ issued: boolean, redeemed_at: number \| null }` — never the code or its hash |

`state` exists because `doctor` cannot otherwise see either fact it is meant to
report. It returns booleans and a timestamp only; a caller already holding the token
learns nothing from it they could not learn by minting a fresh code.

The code travels in the JSON body, not a header — it is the primary credential on
`redeem`, and a body keeps it out of any middlebox that logs headers.

`/v1/register` mints and returns a code alongside the token. The majority of owners
will never run `recovery issue`, so registration has to hand them one unprompted.

### The code must be re-mintable

The issue frames the code as a one-time artifact printed at registration. That
reintroduces "single unbacked copy" one level up: lose the printout and you are back
where you started, still holding a working token that could have minted another.

So `recovery issue` is available to anyone holding the token, any number of times,
each call invalidating the previous code. Losing the paper is only fatal once you
have *also* lost the token.

### Concurrency: compare-and-swap, never read-then-write

The review found that read-then-write on credential transitions is not race-free
under Workers concurrency. Two concurrent redeems of the same code both pass the
check, both issue a token, and the first caller's freshly-returned token is silently
already dead.

Every credential transition uses a single conditional statement:

```sql
-- redeem
UPDATE handles
   SET token_hash = ?, recovery_hash = ?, recovery_redeemed_at = ?
 WHERE handle = ? AND recovery_hash = ?
RETURNING handle;
```

Zero rows returned means someone else won the race — return 401, identical to a wrong
code. `issue` uses the same shape conditioned on the authenticated `token_hash`.

**`/v1/token/rotate` has this bug today** (`apps/relay/src/index.ts:80-91`: verify,
then unconditional `UPDATE`). Two concurrent rotations issue two tokens and one is
silently dead. Fixing redeem while leaving rotate racy is incoherent, so rotate gets
the same `WHERE handle = ? AND token_hash = ?` treatment in this change. It is a
two-line fix and the test comes free alongside redeem's.

### The NULL trap

`constantTimeEqual` (`apps/relay/src/auth.ts`) takes two strings. When
`recovery_hash` is NULL — every pre-migration handle — a naive comparison either
throws or, worse, coerces into a match. Redeem must reject `recovery_hash IS NULL`
explicitly before any comparison, and that rejection gets its own test. This is the
single most dangerous line in the change: a null-matches-empty bug would make every
handle that never issued a code redeemable by anyone.

### Rate limiting

A new `RECOVER_RL` binding, limited on **both** keys per request:

- `handle:<handle>` — stops one handle being ground down from many IPs
- `ip:<ip>` — stops one IP grinding many handles

`{ limit: 3, period: 60 }`, checked on **both** keys per request. Cloudflare's
ratelimit bindings accept only a 10s or 60s `period` (documented in
`apps/relay/wrangler.jsonc`), so an hourly window is not available at this layer —
3/min is the tightest useful cap the binding supports, against `REGISTER_RL`'s 5/min.
At 120 bits the brute-force math is already hopeless; the limit exists so the endpoint
cannot be used as a cheap DO-waking or enumeration oracle.

Rate-limit tests must give each test its own synthetic `cf-connecting-ip` and its own
handle, the way `apps/relay/test/register.test.ts` already does. That file's burst
test is a known flake precisely because it depends on six requests landing inside one
ambient 60s window; the recovery tests must assert the limit trips without depending
on wall-clock timing across more requests than the limit itself.

Redeem returns an identical 401 for unknown handle, wrong code, never-issued, and
lost-race. It must not become the handle-enumeration oracle that `/v1/status` was
before it required auth.

### CLI surface

```
agentcall recovery issue          # mint a fresh code, invalidating the old one
agentcall recovery redeem <code>  # rebuild config.json from a code alone
```

`redeem` is the one command that works with no local config — it takes `--handle` and
`--relay` and writes a fresh `config.json` from the token it gets back.

**The code is never written to disk.** Storing it beside the token defeats the entire
point. It is printed through the `/dev/tty` path in `packages/cli/src/tty.ts` rather
than stdout, so `agentcall setup | tee log` does not put a live credential in a log
file.

### `doctor`

The issue's open question asked whether `doctor` should warn when a code has never
been "acknowledged." It should not — retention is unobservable, so that warning is
noise.

Two things *are* observable and both are actionable:

- `recovery_hash IS NULL` → "no recovery code has ever been issued for this handle —
  run `agentcall recovery issue`." This is how retrofit reaches existing owners.
- `recovery_redeemed_at IS NOT NULL` → report the date. "If that wasn't you, run
  `agentcall recovery issue` now." It is the only forensic trail a stolen code
  leaves, and it costs one column rather than an events table.

### Interaction with #44 (multiple lines)

Registration is per line, so each line gets its own code and its own
`recovery issue --line <name>`. This multiplies the number of codes an owner keeps,
and that is accepted rather than solved: a master code covering every line would be a
single point of failure and a third credential concept. The N-codes cost is real and
lands on people running many lines, which is the smaller population.

## The honest tradeoff

**A recovery code is a second full-authority credential.** Anyone who obtains it can
take the handle and lock the owner out, and unlike today there is now a second thing
to protect. Redemption is at least loud — the owner's token stops working, and
`doctor` reports the redemption date — but "loud" is not "recoverable."

The trade is: a permanent, silent, unrecoverable loss that has already deformed one
schema, against a second credential that never touches disk, is single-use, and is
re-mintable by whoever holds the token. That is worth taking. It is not free, and the
spec should not pretend otherwise.

## Tests

TDD; failing test first. `packages/shared` for schemas, `apps/relay` driving routes
directly, `packages/cli` with mocked fetch.

**shared**
- round-trip and rejection for `RecoveryIssueResponse`, `RecoveryRedeemRequest`,
  `RecoveryRedeemResponse`
- the `agcr_` code format validates; a malformed or unprefixed code rejects

**relay**
- redeem with the correct code returns a working new token
- redeem invalidates the code: the same code fails on second use
- **redeem against a handle with `recovery_hash IS NULL` fails** — the NULL trap
- redeem with a wrong code, an unknown handle, and a never-issued handle all return
  byte-identical 401s
- two concurrent redeems: exactly one succeeds, the other 401s
- two concurrent rotates: exactly one succeeds (the regression fix)
- `issue` replaces the previous code — the old one no longer redeems
- `issue` requires a valid token
- `register` returns a code and sets `recovery_hash`
- `RECOVER_RL` trips on both the handle key and the IP key

**cli**
- `recovery redeem` writes a valid `config.json` with no prior config present
- the code is never written to any file — assert against the whole `~/.agentcall`
  tree after both commands
- `doctor` reports never-issued and reports a redemption date when set

## Out of scope

- Handle release and reclamation (#16), and the incarnation problem recorded there.
- Inactivity-based reclaim.
- Any change to `idFromName` addressing.
