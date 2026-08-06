# Non-blocking Room membership verification

> **Historical document — not current documentation.** This is a dated design
> record that describes the repository state on 2026-08-06 and is deliberately
> *not* updated when behavior changes. Read it for *why*, not for *what the code
> does now*. [README.md](../../../README.md) is the authority on current behavior.

## The change in one line

The membership fingerprint stops being a blocking `[y/N]` gate that every
participant must answer within 60 seconds, and becomes a line of output that is
always shown and never waited on — matching how Zoom, Signal, and WhatsApp ship
the same primitive.

## Verified current state

Verified against `main` at `1c524d2` on 2026-08-06.

**The gate is relay-enforced, not just a CLI prompt.** When a Room locks
(`apps/relay/src/room/do.ts:368-386`) the relay deletes every pending
participant and every invite, bumps `membership_epoch`, moves the Room to
`verifying`, and stamps a `verification_deadline` of
`ROOM_VERIFICATION_TTL_MS` = **60 seconds**
(`packages/shared/src/room.ts:8`). The Room becomes `active` only when *every*
non-departed participant has sent `confirm` (`do.ts:279-297`).

**Three separate one-person actions destroy the Room for everyone:**

| Trigger | Code | Result |
| --- | --- | --- |
| Any participant sends `reject` | `do.ts:298-303` | Room closes, `verification_failed` |
| Any participant `leave`s while `verifying` | `do.ts:321-329` | Room closes, `verification_failed` |
| The 60s deadline passes with anyone unconfirmed | `do.ts:837-838` | Room closes, `verification_failed` |

And the Room cannot be re-formed, because `lock()` already deleted the invites
(`do.ts:376-377`). A host who loses a Room this way restarts from
`agentcall room` with a fresh invite string for everyone.

**The CLI side is a blocking prompt racing that deadline.**
`packages/cli/src/room-verification.ts:36-91` computes the fingerprint, prints
`formatFingerprintPrompt` (`room-render.ts:34-43`), and does a
`Promise.race` between a stdin line and a `setTimeout` at the relay's
deadline. Anything other than a typed `y` — a timeout, a stray keystroke, an
empty line — becomes `reject`, which closes the Room
(`room-verification.ts:84`).

**The original spec already predicted this wouldn't work.** From
[the frozen Rooms spec](./2026-08-03-accountless-group-rooms.md):

> The fingerprint is not an access secret. It detects substitution only when
> people actually compare it.

and, in its own residual-risk table for "wrong person admitted":

> Humans may skip or falsely confirm comparison.

## Why change it

**1. A mandatory prompt manufactures false assurance.** A gate everyone must
clear to use the product trains people to clear it reflexively. The spec's own
risk row concedes the check only works when people genuinely compare — and a
blocking prompt is the design most likely to produce a reflexive `y`. An
always-shown, never-blocking code is *weaker on paper and stronger in practice*,
because the only people who act on it are the people who were going to look.

**2. The availability cost is severe and lands on the whole group.** One person
stepping away for 90 seconds, hitting Ctrl-C, or typing anything but `y` kills
a Room for everyone, unrecoverably. That is a very high price for a check the
spec says humans skip.

**3. It breaks the agent-driven path this feature is for.** Rooms are expected
to be set up by asking Claude Code or Codex, not by hand at a prompt. A blocking
read on stdin is a hang when no human is watching the terminal — and the 60s
deadline turns that hang into a closed Room. Auto-confirm plus a printed code is
strictly better here: the agent can *relay* the code to its human, which manual
blocking never allowed.

**4. It is what the comparable products actually do.** Zoom's E2EE meeting
security code is behind a shield icon and never blocks the meeting; Signal and
WhatsApp safety numbers are several taps deep and never block a message. The
universal split is **access control blocks, key verification does not.** Rooms
already have the access-control half: a 256-bit invite, a 5-minute invite TTL, a
6-seat ceiling, and `abuse_limit` closure after three failed joins.

## What we keep and what we give up

**Keep:** the fingerprint itself, its derivation, and the relay's epoch binding.
`roomMembershipFingerprint` and the `membership_epoch` that gates call
authorization (`do.ts:454`, `do.ts:526`) are untouched. Every participant still
sees the same code, so a substitution attack is still *detectable* by anyone who
looks.

**Give up:** substitution is detected *after* the Room activates rather than
*before*. Since messages inside a Room only start flowing once it is active, a
determined attacker gains the window between activation and whenever someone
glances at the code. This is precisely the Signal/WhatsApp posture — a changed
safety number is surfaced, not prevented — and it is the trade the three
arguments above are worth.

**Explicitly not given up:** the option to make it blocking again. Everything
needed for a future `--verify` strict mode stays in the relay.

## The change

### Relay: no change

The `verifying` state, `confirm`/`reject` actions, `verification_deadline`, and
`verified`/`verified_epoch` participant fields all stay exactly as they are. The
CLI simply answers `confirm` immediately instead of after a human. This keeps the
diff off the epoch/state surface that R2b (#347, the Room call protocol) is about
to build on, per CLAUDE.md's warning about colliding work in `apps/relay`.

### `packages/cli/src/room-verification.ts` — the substance

Replace the prompt-and-race with a single confirm per epoch:

```ts
if (snapshot.room.state !== "verifying") return;
if (confirmedEpoch === snapshot.room.membership_epoch) return;
confirmedEpoch = snapshot.room.membership_epoch;

const fingerprint = await roomMembershipFingerprint({ /* unchanged */ });
lastFingerprint = fingerprint;
await mutate(relay, credential, "confirm").catch(() => {});
```

Three things disappear with it:

- the `createLineListener` import and the entire listener lifecycle,
- the `Promise.race` against `verification_deadline` and its `setTimeout`,
- the 13-line comment block explaining why this code could not use `ask()`
  without re-creating the "two readline interfaces race for the typed line"
  hang. **That hazard stops existing rather than being managed** — the largest
  simplification in the change.

The `confirmedEpoch` guard (today's `promptedEpoch`) must survive: the poller
fires repeatedly and a second `confirm` would 409 once the participant is
`verified`.

### `RoomVerificationResult` carries the fingerprint

```ts
export type RoomVerificationResult =
  | { outcome: "active"; snapshot: RoomMutationResponseType; fingerprint: string }
  | { outcome: "closed"; reason: RoomCloseReasonType | "unknown" };
```

The callers in `commands/room.ts` need it to print the activation line, and R2b
needs it for `/verify`.

### `packages/cli/src/room-render.ts` — replace the prompt formatter

`formatFingerprintPrompt` (which ends in a question) is replaced by
`formatMembershipCode`, which does not. Recommended output, printed once by both
host and guest at activation:

```text
Room active · ken, sota, mira
Membership code 7K2-MQ9-PDX-4HF — the same on every screen unless someone was substituted.
```

The alternative considered was hiding the code behind `/verify` only, strictly
mirroring Zoom's shield icon. Rejected: a terminal has no shield icon to
discover, printing one line costs the user nothing, and an agent relaying the
Room's state to its human can only pass along what was printed.

### R2b: `/verify` reprints on demand

The REPL that would host `/verify` does not exist yet — both flows currently
terminate at `Room active · N people` (`commands/room.ts:29`, `:43`). `/verify`
is therefore specified here and **built as part of #347 (R2b)**, not in this
change. It should recompute the fingerprint from the live snapshot rather than
echoing the stored one, so it stays correct if an epoch ever rotates.

## Options considered

**A. CLI auto-confirms; relay untouched.** ~60 lines net deletion in
`packages/cli`, no schema or relay change, fully reversible into a strict mode
later.

**B. Keep the prompt but make it non-fatal** — treat a timeout as `confirm` and
only a typed `n` as `reject`. Rejected: it keeps the stdin hang, keeps the
listener hazard, keeps the 60-second clock, and still blocks an agent-driven
Room. It buys the appearance of a check while removing its teeth, which is the
worst of both.

**C. Delete the `verifying` state entirely** — `lock()` transitions straight to
`active`, and `confirm`/`reject`/`verification_deadline`/`verified_epoch`/the
`verified` participant state/`verification_failed` all get deleted from
`packages/shared`, `apps/relay`, and their tests. Structurally the cleanest end
state and the one this repo's instincts favor.

**Recommendation: A now, C as a follow-up decision issue.** C touches
`membership_epoch` handling, the `RoomParticipantRecord` state refinements
(`room.ts:225-231`), and the room state machine — the exact surface #347's call
protocol is about to be written against. Ship the user-visible win as a small,
self-contained CLI diff; take the structural deletion when R2b is not in flight.
This matches how the whole feature has been sliced (R0 → R1a/b/c → R2a → R2b),
and C gets strictly easier to argue once auto-confirm has proven nobody misses
the gate.

## Test plan

Relay tests are unchanged, because relay behavior is unchanged. In
`packages/cli`:

- `room-verification.test.ts` — rewritten. Asserts: `confirm` is sent on the
  first `verifying` snapshot with no listener created and no stdin read; a
  repeated `verifying` snapshot at the same epoch does **not** re-confirm; the
  `active` result carries the fingerprint; a `closed` snapshot still resolves
  `closed` with its reason; a failed `confirm` mutation does not throw.
- `room-render.test.ts` — `formatMembershipCode` renders names and code and
  contains no `[y/N]`.
- `room-host.test.ts` / `room-guest.test.ts` — both inject `runVerification`, so
  they only need their fakes updated to return the new `fingerprint` field.

A regression worth planting red first: a fake that never sends a line must now
reach `active`, where today it reaches `closed`/`verification_failed`.

## Adjacent findings — deliberately out of scope

These surfaced while tracing the state machine and are **not** fixed here:

- **Late join is impossible, and verification is not why.** `lock()` deletes
  every invite (`do.ts:376-377`), so once a Room starts, nobody can be added.
  This — not the fingerprint prompt — is what stands between Rooms and a
  Zoom-like "drop in whenever" flow. Fixing it means rotating
  `membership_epoch` on a late join and re-deriving every participant's call
  capability, which is a real design problem deserving its own issue.
- **A small Room never auto-locks.** Auto-lock fires only when admitted count
  equals `expected_participants` (`do.ts:267`), which `ROOM_SEATS` fixes at 6
  (`room-host.ts:11`) after #367 dropped `--seats`. A 3-person Room therefore
  waits for the host to type `/start`. Worth revisiting alongside late join.
