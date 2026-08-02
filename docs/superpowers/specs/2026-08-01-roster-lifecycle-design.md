# Roster membership lifecycle — expel, rotate, leave, teardown

**Date:** 2026-08-01
**Status:** **Design, approved.** Ready for an implementation plan. Nothing built yet.
**Issue:** [#48](https://github.com/KenTaniguchi-R/agentcall/issues/48)
**Also closes:** [#49](https://github.com/KenTaniguchi-R/agentcall/issues/49) — the CLI
refactor in Phase 1 removes the untestable seam that issue describes.
**Grounding:** every file and line reference below was read against the tree at
`f4bc390`. Production D1 was queried directly on 2026-08-01: **0 rosters, 0 members.**
That fact licenses two decisions that would otherwise be unavailable — a destructive
migration and a breaking schema change.

## The problem

`agentcall search` shipped in #24 with a hole documented in the README rather than
papered over:

> There is no way to remove a roster member and no way to rotate a roster's join
> secret. If the secret leaks, abandon the roster and create a new one.

So membership is append-only and permanent. Someone who leaves the company keeps
seeing the roster. A leaked secret has no remediation short of rebuilding. And
`agentcall roster forget` — which sounds exactly like leaving — is local-only, so a
user who runs it is still a member and no longer knows it.

## Decisions

Five forks, settled before the design:

| Question | Decision |
|---|---|
| Who may expel and rotate? | A **separate admin secret**, issued alongside the join secret at create. No roles, no owner column, no admin table. |
| What does rotation do to existing members? | **Nothing, by default.** `--evict` adds the purge. Remediation is composed, not conflated. |
| How does evidence survive expulsion? | An **append-only `roster_events` table**. `roster_members` stays the live set with hard deletes. No read endpoint yet. |
| Where does the admin secret live? | **Nowhere on disk.** Printed once; supplied per-command by prompt, flag, or env. |
| How much restructuring rides along? | **Relay route guards + CLI command extraction**, as a prerequisite phase. |

## Why two secrets

The issue treats the authority question as hard because a previous round rejected
`owner_handle`, and the schema comment in `0004_rosters.sql` records why:

- `agentcall uninstall --purge` destroys local credentials (`index.ts:493`)
- relay-side handle release is deliberately unimplemented (`apps/relay/src/index.ts`)
- token rotation changes the credential, not the handle

So the sole owner's laptop is a single point of failure, and purging it leaves a
permanently unadministrable roster.

**That reasoning is correct for a handle-based owner and does not transfer to a
secret.** A secret lives in a password manager, not in `~/.agentcall`. `--purge`
cannot reach it. The failure mode degrades from *"the credential was destroyed by a
routine command"* to *"someone lost a password"* — a different class of problem, and
one every organization already has a process for.

Splitting the secret in two is what makes it safe to use as authority:

- The **join secret** circulates. It goes in Slack, in onboarding docs, in a
  colleague's terminal history. It is the one that leaks.
- The **admin secret** never travels. It is printed once and stored by whoever
  administers the roster.

Leaking the join secret therefore costs a rotation, not the roster. Under a
single-secret scheme the credential you hand to every joiner is also the one that can
empty the roster — and rotating it as remediation would revoke your own ability to
administer.

### What this does not solve

Losing the admin secret leaves the roster unadministrable, with no recovery path.
That is accepted. The blast radius argument from #48 still bounds it: a joiner sees
only what each member publishes *to them* (`visibleTasks`, `packages/shared/src/card.ts`),
never the full grant map, and search results are hints — the callee's policy still
decides whether any call is answered. Abandon-and-recreate remains the floor, and it
is a better floor than today's, because it is reachable by choice rather than forced
by a leak.

If membership ever derives from an IdP (#15), this scheme is replaced rather than
extended. Nothing here should grow toward being a permissions system.

## Phase 1 — Prerequisite refactor

No behavior change. Lands before anything in Phase 2 is written.

### Why it is a prerequisite and not a follow-up

Three structural facts, measured:

1. **`packages/cli/src/index.ts` is 500 lines holding 26 commands, 15 `catch`
   blocks, and 23 copies of `process.exitCode = 1`.** Every action is a commander
   closure containing real logic, so none of it is reachable from a test.
   `bin.test.ts` tests `src/bin.ts` — agent-binary resolution — not the entrypoint.
   **Nothing in the repo drives an `index.ts` action.** That is #49, and #43, #50,
   and #51 all lived there.
2. **`apps/relay/src/roster.ts` retypes the same preamble in every handler** — auth,
   `ROSTER_ID_RE`, rate limit, `NOT_FOUND`. Two of those are security invariants, not
   style: the shared `NOT_FOUND` body that keeps roster ids non-enumerable, and the
   `constantTimeEqual` on the secret. The file's own comment says `NOT_FOUND` is
   "declared once so the two call sites cannot drift." That instinct does not survive
   six call sites.
3. **Secret verification is inline.** `sha256Hex` + `constantTimeEqual` appears once
   today. With two secrets across five endpoints it needs to be a function, or
   someone eventually writes `===`.

Phase 2 adds four endpoints and five commands. Doing it first means writing the
security preamble six times and adding four more untested closures to the exact file
where three bugs already hid.

### CLI extraction

`setup` already demonstrates the target shape: `index.ts` holds thirty lines of
option declarations and delegates to `runSetup()` in `setup.ts`, which has a 24KB
test file driving it. This generalizes that to the other 25 commands.

```
packages/cli/src/commands/
  roster.ts     contacts.ts     call.ts     card.ts     ...
```

Each command becomes a plain exported function taking explicit dependencies:

```ts
type Deps = { paths: Paths; io: { log(s: string): void; error(s: string): void;
                                 ask(q: string): Promise<string> } };
export async function expelMember(d: Deps, name: string, handle: string,
                                  o: { adminSecret?: string }): Promise<void>;
```

Output goes through injected `io` rather than global `console`, so tests capture it
instead of racing on a process-wide spy, and `ask` is injected so prompts are
drivable. `tty.ts` already supports this — `createPrompter(open)` takes its streams
as a parameter and `ask` is just the default instance.

`index.ts` becomes commander wiring plus one wrapper:

```ts
function run<A extends unknown[]>(fn: (...a: A) => Promise<void> | void) {
  return async (...a: A) => {
    try { await fn(...a); }
    catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
  };
}
```

23 `exitCode` assignments collapse to one. Commands throw; only the wrapper knows
about process state. Target: ~120 lines.

### Relay guards

`apps/relay/src/roster.ts` becomes `apps/relay/src/roster/`:

| file | holds |
|---|---|
| `index.ts` | `mountRoster` — the route table, nothing else |
| `guards.ts` | `requireRoster` (auth + id shape + rate limit), `requireMember`, `requireAdmin`, `secretMatches`, and the single `NOT_FOUND` |
| `bundle.ts` | the per-caller search projection — the one genuinely complex handler |
| `admin.ts` | expel / rotate / delete |
| `events.ts` | the append-only audit write, so no path can forget it |

`secretMatches(supplied, hash)` hashes the supplied value even when the row is
missing, so the missing-roster and wrong-secret paths cost the same. That property is
currently derived inline inside `join`; four more handlers would each have to derive
it again.

The `import type { Env }` discipline at the top of the current file — type-only so the
`index → roster → index` cycle is erased at compile time — carries over to every file
in the new directory unchanged.

### Verification

Extracting untested code is unverified by construction; there is no net to catch a
behavior change in a command that has never had a test. So the rule is **TDD per
command**: the commit that extracts a command also writes its test against the
extracted function. That converts an unverifiable refactor into net-new coverage and
matches the repo's test-first rule. Roster commands go first, since Phase 2 builds on
them.

The relay half is different — `roster-bundle`, `roster-join`, and `roster-create`
tests already cover it, so the guard extraction is a genuine safety-netted refactor.

## Phase 2 — Data model

### Migration `0005`

`rosters` is recreated rather than altered. `ALTER TABLE ADD COLUMN ... NOT NULL`
forces a `DEFAULT ''` sentinel that every future reader has to decode; recreating
buys a real `NOT NULL` and lets `secret_hash` be renamed to `join_secret_hash`, which
is what makes the two-secret model self-documenting instead of comment-documented.
This is safe **only** because production was verified empty, and the migration says
so.

Editing `0004` in place is not an option: wrangler tracks applied migrations by name
and would silently skip the edit in production while applying it to every fresh test
database — the two would diverge with no error.

```sql
-- Two secrets, deliberately separate. The join secret circulates -- Slack,
-- onboarding docs, a colleague's terminal history -- and is the one that leaks.
-- The admin secret never travels. Leaking the join secret costs a rotation,
-- not the roster. See the roster-lifecycle design for why a secret, and not an
-- owner_handle, is what makes this survive `uninstall --purge`.
DROP TABLE rosters;            -- verified 0 rows in production, 2026-08-01
CREATE TABLE rosters (
  id                TEXT PRIMARY KEY,
  join_secret_hash  TEXT NOT NULL,
  admin_secret_hash TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

-- Append-only. roster_members is the live set and is hard-deleted; this is the
-- evidence, and it outlives both expulsion and teardown -- a leaked secret
-- leaves no other trail.
CREATE TABLE roster_events (
  id        INTEGER PRIMARY KEY,
  roster_id TEXT NOT NULL,
  kind      TEXT NOT NULL,  -- create|join|leave|expel|rotate|evict_all|delete
  actor     TEXT NOT NULL,  -- handle that performed it; always known
  subject   TEXT,           -- handle acted upon; NULL for roster-scoped events
  at        INTEGER NOT NULL
);
CREATE INDEX roster_events_by_roster ON roster_events(roster_id, at);
```

`actor` is `NOT NULL` because every roster route requires a valid handle token before
it looks at any secret, so even admin-secret operations have a named actor.

`roster_events.roster_id` has no foreign key, deliberately — the rows outlive the
roster. One consequence is accepted rather than designed around: `delete` frees the
primary key, so a later roster could in principle be issued the same id and its
events would interleave with the dead roster's. Ids are 16 random bytes generated by
the relay (`roster.ts:14-17`) and never client-chosen, so this requires a 128-bit
accidental collision. Not worth a tombstone table.

There is no `count` column for bulk operations: membership at any moment is
reconstructable from prior events, and a derived column would be one more thing to
keep honest.

**Not in scope:** any endpoint that reads `roster_events`. The rows exist for the
relay operator, who has D1 access. #47 (abuse monitoring) should decide the read
surface.

**In scope, because writes start here:** a growth bound. The table is append-only,
has no owner, no foreign key, and no retention — and every mutation appends to it, so
its size is driven by whoever holds a join secret. A leave/rejoin loop writes two
rows per cycle forever. `ROSTER_RL` keyed `{op}:{ip}:{id}` does not bound this: it is
segmented per operation and per source IP, so distributing across IPs and alternating
operations evades it entirely.

Deferring retention until #47 would be reasonable if the table were only written by
trusted paths. It is not. So the write path carries **a per-roster event budget
independent of source IP** — a roster that exceeds it stops accepting membership
mutations rather than growing without bound, and the rejection is itself recorded
once rather than per attempt. Terminal security events (`rotate`, `evict_all`,
`delete`, `expel`) are exempt from suppression: an attacker must never be able to
flood the log to starve out the record of their own expulsion.

### Deploy ordering

**The build order below sequences code, not deploys, and the two are not the same
thing.** `0005` renames a column that the running Worker reads, and the wire renames
`secret` to `join_secret`. Applying the migration and deploying the Worker are two
separate operations, and every roster route breaks in the window between them —
whichever order they happen in:

- **Migration first:** the deployed Worker still selects `secret_hash` from a table
  that no longer has it. Every roster route 500s until the deploy lands.
- **Deploy first:** the new Worker selects `join_secret_hash` from a table that does
  not have it yet. Same outcome, same window.

There is no zero-downtime ordering for a rename, and the usual fix — expand,
migrate, contract across three deploys — is not worth building for **0 rosters and 0
members**. The correct answer here is to make the window explicit rather than
pretend it does not exist:

1. Apply `0005` and deploy the Worker back to back, migration first.
2. Accept that roster routes 500 for the duration. Nothing else on the relay touches
   these tables, so calls, registration, and cards are unaffected.
3. The release note says so.

**If this design is ever revisited when the roster tables are non-empty, this section
is wrong and must be redone as expand/contract.** The zero-row measurement is what
makes the shortcut legitimate, and it has an expiry date.

That expiry is not hypothetical, and a comment in the SQL is not a safeguard. The
2026-08-01 count is an observation, not a precondition, and rows can appear between
the measurement and the deploy. `DROP TABLE rosters` is also unconditional, so it
executes the same way against **every** database it is applied to — including preview
and staging environments, which were never measured and may well hold test rosters.

So zero-rows becomes a checked precondition at deploy time, per database:

1. Re-run the count against the target database immediately before migrating.
2. **Abort on any rows.** Non-zero means this design is out of date, not that the
   rows are unimportant.
3. Take a D1 export first regardless.
4. Apply, deploy, verify a create/join round-trip.

Preview and staging are migrated under the same rule or deliberately reset. Neither
gets the shortcut on the strength of a production measurement.

### Write atomicity

`rotate --evict` is four statements: update the join secret hash, delete every
membership row, and insert two event rows. `delete` is three. Issued as separate
`.run()` calls, a failure between them is reachable, and the reachable states are
security-relevant in both directions:

- Secret rotated, members **not** evicted — the operator believes the roster was
  purged and it was not. Silent failure of a remediation.
- Members evicted, secret **not** rotated — the leaked secret still works and
  everyone has to rejoin. Loud, but wrong.

`D1Database::batch()` is the fix and it is genuinely atomic: per Cloudflare's Workers
API docs, statements in a batch are "executed sequentially and non-concurrently as a
transaction," and "if any statement fails, the entire sequence is aborted or rolled
back." (`env.DB.transaction(async tx => …)` also exists; `batch()` is the better fit
for these because every statement is known up front.)

**So every multi-statement roster mutation goes through one `batch()` call.** That is
`rotate`, `rotate --evict`, `expel`, `leave`, `delete`, and `create`.

`create` is on that list because **it has the same latent bug today**:
`roster.ts:40-44` inserts the roster and then, in a separate `.run()`, inserts the
creator's membership row. A failure between them produces a roster nobody belongs to
and — after this design lands — one whose admin secret was returned to a caller who
was never recorded as its creator. Batching `create` is a bug fix that this refactor
should carry rather than leave behind.

### What `batch()` does not fix — `join` is a read-then-write

`batch()` makes the statements *inside one batch* atomic. It does not serialize a
decision another request made before its batch ran. `join` makes exactly such a
decision, and it is the one route that does:

```
roster.ts:71   SELECT secret_hash          -- read
roster.ts:76   compare                     -- decide
roster.ts:80   SELECT membership
roster.ts:84   SELECT COUNT(*)             -- read
roster.ts:91   INSERT OR IGNORE            -- write
```

Two races follow, **both of which exist in shipped code today** and neither of which
batching the new routes would close:

1. **A join straddling `rotate --evict` survives the purge.** A caller validates the
   *old* join secret at line 76, `rotate --evict` commits, and the caller's insert
   lands afterward. The roster the operator believes they purged now contains someone
   holding a revoked secret — the precise outcome the remediation exists to prevent.
   Attempting it requires no timing skill: a caller who leaked the secret and expects
   remediation can simply retry `join` in a loop until a rotation window is straddled.

2. **`MAX_ROSTER_MEMBERS` is not enforced.** The `COUNT(*)` at line 84 and the
   `INSERT` at line 91 are separate statements, so N concurrent joins by *distinct*
   handles can each observe 199 and each insert. `INSERT OR IGNORE` resolves only the
   same-handle collision the existing comment describes; it says nothing about the
   total. Combined with the deliberate rejoin-after-expel behavior, a holder of a
   current join secret can fill or overfill a roster from many handles and lock
   legitimate members out of rejoining after an evict.

**Fix: collapse authorization, capacity, and insertion into one conditional
statement**, so the secret check and the limit are evaluated by the database at write
time rather than by the Worker beforehand:

```sql
INSERT OR IGNORE INTO roster_members (roster_id, handle, joined_at)
SELECT ?, ?, ?
  FROM rosters
 WHERE id = ?
   AND join_secret_hash = ?
   AND (SELECT COUNT(*) FROM roster_members WHERE roster_id = ?) < 200;
```

Success is then determined by rows affected, not by a prior read. The join event is
written in the same `batch()`.

One property is lost and must be reacquired deliberately: the constant-time compare.
Matching `join_secret_hash` inside SQL is not `constantTimeEqual`. Because the
compared value is a SHA-256 digest of an unguessed 32-byte token rather than the
token itself, a byte-wise early exit leaks nothing usable — but that argument has to
be written into the code as a comment, or the next reader will "restore" the
in-Worker compare and reintroduce the race.

**These two races are defects in `main`, not in this design.** They are filed as
[#58](https://github.com/KenTaniguchi-R/agentcall/issues/58) so they can be fixed
without waiting on the lifecycle work. If #58 lands first, Phase 3 inherits the
conditional `INSERT ... SELECT` and only has to rename `secret_hash` to
`join_secret_hash` inside it.

### Shared schemas

Per the repo rule that protocol types live in `packages/shared`, all four go in
`packages/shared/src/roster.ts` before either side is touched:

```ts
CreateRosterResponse  { roster_id, join_secret, admin_secret }   // was { roster_id, secret }
JoinRosterRequest     { join_secret }                            // was { secret }
ExpelRequest          { admin_secret, handle }
RotateRequest         { admin_secret, evict?: boolean }
RotateResponse        { join_secret }
DeleteRequest         { admin_secret }
```

Renaming `secret` → `join_secret` is a breaking wire change, which is free at 0 users
and stops being free the moment there is one.

## Phase 3 — Operations

### Routes

Four new, all `POST`, all inheriting their preamble from `guards.ts`:

| route | gate | effect | event |
|---|---|---|---|
| `/v1/roster/:id/leave` | member | remove self | `leave` |
| `/v1/roster/:id/expel` | admin secret | remove `{handle}` | `expel` |
| `/v1/roster/:id/rotate` | admin secret | new join secret; `{evict}` also clears members | `rotate`, plus `evict_all` |
| `/v1/roster/:id/delete` | admin secret | drop roster + members, **keep events** | `delete` |

`rotate --evict` writes **both** events, in that order — two things happened, and the
log is literal about what it observed rather than summarizing.

Rate limiting follows the existing pattern: `ROSTER_RL` keyed `{op}:{ip}:{id}`.

**The three admin routes require a valid handle token but not membership.** The gate
is the admin secret, so whoever holds it can administer a roster they never joined —
an IT admin who set one up for a team, for instance. Membership and administration
are deliberately orthogonal; this is the same separation that keeps `rotate --evict`
from locking you out of the roster you just emptied.

### The enumeration invariant

Unknown roster, wrong join secret, wrong admin secret, and non-member all return the
byte-identical `404 {error:"not found"}`. This is the single property `guards.ts`
exists to own.

"Byte-identical" means the **whole response**, not the body. Headers are observable,
and this route already varies them deliberately — the bundle handler sets `ETag` and
`Cache-Control` (`roster.ts:156-165`). A 404 that carries different caching headers
depending on *why* it was a 404 would leak exactly what the shared body is hiding. So
`guards.ts` emits one canonical `Response` object — status, body, and headers — and
every guard returns that same value rather than constructing its own.

**Timing is mitigated, not equalized, and the spec should not claim otherwise.**
`secretMatches` equalizes the hash cost, and the rate-limit check runs before any
existence-dependent query so a 429 cannot distinguish a real roster from a fake one.
But `requireAdmin` and `requireMember` necessarily issue different D1 queries, and no
amount of care makes their latency distributions identical without deliberate
padding, which is not proposed. The claim being made is that no *practical* oracle
exists, not that the paths are indistinguishable to a patient attacker with a
statistical model.

Past a proven admin secret the rules relax: expelling a handle that is not a member
returns a **distinct** 404, because at that point there is nothing left to hide and a
silent no-op would mask a typo'd handle. This is the same reasoning `join` already
applies at its "past this point the caller has proved the secret, so revealing that
the roster exists and is full costs nothing" comment.

### Rotation semantics

`rotate` issues a new join secret and leaves membership untouched — it closes the
door, it does not empty the room. `rotate --evict` additionally clears every member
while the roster itself survives with the same id and the **same admin secret**, so
re-inviting is one paste rather than a rebuild.

#48 objects that rotation alone is not remediation, and that is right. The answer is
composition, not a single conflated operation:

- You know who leaked it → `expel <handle>` then `rotate`.
- You do not → `rotate --evict`.

Making rotation always evict would force every remaining member to rejoin for the
common case (someone left the company, close the door behind them), which is exactly
the friction that stops people rotating at all.

### Revocation needs no coordination

`searchRefresh.ts:67-68` already deletes the local cache on a 404 from `/bundle`,
with a comment stating it is there so "a revoked roster's cache cannot outlive the
revocation under `--offline`." Expel, evict, and delete all produce exactly that 404.
The client half of expulsion was built before the server half existed; this phase
lights it up without touching it.

**But expulsion revokes future access, not past disclosure, and the bound is not 15
minutes.** `searchRefresh.ts:42-47` returns a cached bundle under `--offline` with
**no age check at all** — only a `stale: true` flag. An expelled member who simply
never goes online keeps reading the last bundle indefinitely, because the deletion at
line 68 only fires on a network response that never happens. `CACHE_TTL_MS` bounds
staleness for an *online* member; it bounds nothing for an offline one.

That is not a flaw to fix here — it is what caching means, and the same is true of
anything they screenshotted. The threat model must say so plainly rather than imply
a 15-minute revocation window that does not exist:

> Expelling a member stops them from fetching new roster data. It cannot retract what
> they already have. Rotate the join secret and treat anything previously visible to
> them as disclosed.

If a bounded offline window is ever wanted, the change is to have `--offline` refuse
or erase entries older than some multiple of `CACHE_TTL_MS`. That is a separate
decision with its own UX cost, and it is not taken here.

### Rejoin after expel

An expelled member who still holds the join secret can rejoin. This is correct —
expel closes the room, rotate changes the lock — but it is a support question waiting
to happen, so `roster expel` prints the rotate hint rather than leaving it to the
docs. A test pins the behavior so nobody later "fixes" it into a silent ban list,
which would be a permissions system arriving by accident.

### CLI surface

```
agentcall roster leave  <name>                     # relay leave + local forget
agentcall roster forget <name>                     # local only -- escape hatch
agentcall roster expel  <name> <handle>
agentcall roster rotate <name> [--evict]
agentcall roster delete <name>
```

`leave` is what people already assume `forget` does. `forget` keeps its local-only
meaning and its warning, for the case where the relay is unreachable or the
membership is already gone. `leave` clears the membership row, the local
`rosters.json` entry, and the cache entry.

**The last member leaving does not delete the roster.** It survives with zero members
and remains fully administrable, because administration rides on the admin secret
rather than on anyone's membership. Auto-deleting on the last departure would make
`leave` silently destructive and would hand any member a way to destroy a roster they
do not administer. Teardown is `roster delete`, and nothing else.

The admin secret is **never written to disk**. Writing it to `rosters.json` would put
it back inside `~/.agentcall`, which `uninstall --purge` destroys — recreating the
exact failure mode the two-secret split exists to avoid. It resolves per command:

1. `--admin-secret <s>` — for scripting; noted as visible in shell history and `ps`
2. `AGENTCALL_ADMIN_SECRET` — for CI
3. **prompt** — the default, and the only path that leaks it to neither

`roster create` prints both secrets once with an explicit instruction to store the
admin secret in a password manager, alongside the existing "shown once and not
recoverable" line.

### Confirmation

`roster delete` and `roster rotate --evict` require a typed confirmation, bypassable
with `--yes`. These are the only CLI operations whose blast radius lands on *other
people's* machines.

Noted but out of scope: `uninstall --purge` currently `rmSync`s `~/.agentcall` with no
confirmation at all (`index.ts:490-495`). That deserves its own issue rather than
widening this change.

## Testing

### Relay — `roster-leave`, `roster-admin`, `roster-events`

- **The enumeration invariant, asserted on the full response** — status, serialized
  body, *and* headers — for all four paths: unknown roster, wrong join secret, wrong
  admin secret, non-member. Asserting the body alone would pass while `Cache-Control`
  or `ETag` differed between them, which is the leak the invariant exists to prevent.
  This is the test that makes `guards.ts` load-bearing rather than decorative.
- Rate limiting fires **before** any existence-dependent query, so a 429 is
  indistinguishable between a real and a fabricated roster id.
- `join` against a roster at `MAX_ROSTER_MEMBERS` is rejected even when many joins
  by distinct handles are issued concurrently — the test that the conditional
  `INSERT ... SELECT` actually replaced the `COUNT`-then-`INSERT` pair.
- Expelled member's next `/bundle` returns 404.
- Rotate: the old join secret stops working, the new one works, membership is
  untouched.
- Rotate `--evict`: members cleared, roster survives, **admin secret unchanged** —
  the property that keeps you administrator of the roster you just emptied.
- Delete: roster gone, members gone, `roster_events` rows retained.
- Rejoin-after-expel with a still-valid join secret **succeeds**.
- An event row is written for every mutating operation.
- **Atomicity**: a forced failure on the last statement of `rotate --evict` leaves
  the join secret hash unchanged *and* every membership row intact. This is the test
  that proves `batch()` was actually used rather than assumed.

Migration `0005` needs no dedicated test: `applyD1Migrations` runs it for every relay
test, so the existing suite passing is the assertion that the recreate is sound.

### Shared

Round-trip and rejection tests for the six schemas above, following the existing
`packages/shared/test/roster.test.ts` pattern. `JoinRosterRequest` must reject the
old `{ secret }` shape.

### CLI

The extracted command functions driven directly with a mocked `api` module, a fake
`io`, and a fake `ask`:

- `leave` clears membership, `rosters.json`, and the cache entry.
- `delete` and `rotate --evict` refuse without confirmation, proceed with `--yes`.
- Admin secret resolves flag → env → prompt, in that order.
- `expel` output contains the rotate hint.

Plus the Phase 1 tests for each extracted command, which is where #49 is actually
closed.

## Build order

1. Relay guard extraction (`roster/` split) — safety-netted by existing tests.
2. CLI command extraction, TDD per command, roster commands first.
3. `packages/shared` schemas.
4. Migration `0005`.
5. Relay routes: `leave`, then `expel`, `rotate`, `delete` — all writes via `batch()`,
   including the `create` fix.
6. CLI commands and README.
7. **Deploy:** apply `0005`, then deploy the Worker, back to back. See "Deploy
   ordering" — roster routes 500 in between, and the release note says so.

Steps 1 and 2 are independent of each other and of everything downstream; 3 gates 5
and 6, per the repo rule that the shared schema changes first.

## README

The paragraph quoted at the top of this document is deleted and replaced with the
lifecycle commands, the two-secret model, the fact that the admin secret is
unrecoverable, and the rejoin-after-expel behavior. The gap is being closed, so the
disclosure documenting it goes with it.
