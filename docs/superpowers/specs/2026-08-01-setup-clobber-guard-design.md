# Closing #43 inside the multiple-lines plan

**This is an amendment to Task 11 of `docs/superpowers/plans/2026-08-01-multiple-lines.md`,
not standalone work.** No change lands on `main`. Nothing here is implemented until the
multiple-lines branch reaches Task 11.

## Why this is an amendment and not a fix

[#43](https://github.com/KenTaniguchi-R/agentcall/issues/43) reports that
`agentcall setup --handle <different>` overwrites `~/.agentcall/config.json` and burns
the old handle forever. The diagnosis is correct as written:

- `setup.ts:154-155` computes `reusedCfg` as `undefined` whenever `opts.handle` differs
  from the saved handle.
- The guard at `setup.ts:164` fires only for a *caller-only* outcome landing on a
  callable config. A second *callable* setup passes it.
- `setup.ts:195-206` then registers the new handle and calls `saveConfig`, which
  overwrites in place (`config.ts:70-75`).
- The overwritten token is the only copy. `/v1/token/rotate` authenticates with the old
  token, and handle release is deliberately unimplemented (#16), so the old handle stays
  registered forever and unreachable.

The obvious fix is a refusal guard. We are not building it, because
`2026-08-01-multiple-lines-design.md:464` already states that #43's fix is **inverted**
by the lines design: once a machine holds many lines, `setup --handle ken-codex` should
*add an address*, not refuse. Task 11 rewrites `setup.ts:148-206` wholesale. A guard on
`main` would be deleted by the branch it conflicts with.

Task 11's early return (`plan:1855`) already closes the clobber — it fires before any
handle is read, any registration is sent, or any file is written, and there is no single
`config.json` left to overwrite. This amendment covers the two contract gaps it leaves
(A, B), plus a rollout step (C) that is deliberately *not* code.

Read the root-cause section last. It is the reason this document is short.

### State of the record

`multiple-lines-design.md:464` says #43 was "closed as superseded." It was not — #43 is
open, created 2026-08-02T01:01:14Z and untouched since. #43's own body says the reverse
("#44 is the feature they were actually reaching for; this issue blocks it"). Reconcile
by re-pointing #43 at Task 11 rather than closing it, so the gaps below have an owner.

## A. Acknowledge an unmatched `--handle` instead of ignoring it

Task 11's early return prints a generic notice and a template command. A user who ran
`setup --handle ken-codex` gets no acknowledgement that the flag they passed was dropped
— the same silent-flag-ignoring failure as the `--relay` bug spun off as #51.

When `opts.handle` is supplied and matches no existing line's handle, name it and
pre-fill the command:

```
agentcall is already set up on this machine.

  claude     ken@agentcall.benree.tech   primary

--handle ken-codex was ignored: setup does not add addresses.
To add it:  agentcall line add codex --handle ken-codex
```

Bare `setup`, or `--handle` matching an existing line, keeps the generic notice.

## B. Exit non-zero when `--handle` went unmatched

`plan:1828` asserts `res.ready === true` for `runSetup({ handle: "other", ... })`.
`index.ts:53` maps `ready` to the exit code, so that invocation exits 0 having done
nothing the caller asked for, and a script reads it as success.

| Invocation | `ready` | Rationale |
|---|---|---|
| bare `setup` re-run | `true` | genuinely idempotent |
| `setup --handle ken`, matching a line | `true` | genuinely idempotent |
| `setup --handle ken-codex`, no match | `false` | an address was requested and not created |

The split is on whether a supplied `--handle` matched, not on whether lines exist.

## C. The pre-0.5 flat config is a rollout step, not code

`MachinePaths` (Task 2) has no `configFile` field; `listLines(machine)` reads
`~/.agentcall/lines/`. A 0.4.x install's `~/.agentcall/config.json` is therefore
invisible to Task 11's check: `existing.length === 0`, setup takes the fresh-machine
path, registers a **new** handle, and the old handle stays registered forever with its
only token orphaned in a file nothing reads. Same outcome as #43, reached by upgrading
rather than by a flag.

An earlier draft of this document proposed detecting that state and refusing. **That was
wrong.** There are no users, so the check is dead code the day it ships — which is the
*identical* argument `multiple-lines-design.md:464` used to kill #43's guard: "with no
users the interim protection is not worth code that would then be deleted." Writing it
would repeat the error this document exists to point out.

**Decision: a rollout step in the plan, before Task 11. No shipped code.**

> Task 11 changes the on-disk layout with no migration path (`multiple-lines-design.md:89`).
> Any machine carrying a pre-0.5 `~/.agentcall/config.json` must be cleared first, or
> setup will register a second handle and strand the first.
>
> ```bash
> cp -R ~/.agentcall ~/.agentcall.pre-lines.bak   # do not skip
> rm -rf ~/.agentcall
> ```

The backup is not optional. The one machine this applies to is the maintainer's, which
carries a non-default `workdir`, a granted caller, and call history — state that is
tedious rather than impossible to rebuild, and only if it still exists.

## Tests

All in `packages/cli/test/setup.test.ts`, extending Task 11 Step 1.

- **A** — existing line `claude`/`ken` + `--handle ken-codex`: output matches
  `/--handle ken-codex was ignored/` and `/line add codex --handle ken-codex/`.
- **A (negative)** — bare re-run: output matches `/agentcall line add/` but not
  `/was ignored/`.
- **B** — the three rows of the table above, asserting `res.ready`. Amend `plan:1828`
  from `true` to `false`; add the bare-re-run and matching-handle cases.

C has no tests — it is a rollout step, not code.

No live agent spawn; `runner.test.ts`'s fake binary remains the seam.

## The root cause, which is not any of these

#43, #51, and C are three faces of one fact:

> **The token is a single unbacked copy of a credential that can never be reclaimed.**

`/v1/token/rotate` (`apps/relay/src/index.ts:80`) authenticates with the token you just
lost, and release is deliberately unimplemented (`index.ts:71-75`, #16). So *every* way
to lose that file is unrecoverable — clobber, upgrade-orphan, `uninstall --purge`, disk
failure, a lost laptop, a stray `rm`. Guarding entry points one at a time is whack-a-mole
against a catastrophe that sits downstream of all of them. That is why this document
ships ten lines and a rollout note instead of a guard.

The cost is not hypothetical; it has already bent a schema decision.
`apps/relay/migrations/0004_rosters.sql` omits an owner column specifically because
"`uninstall --purge` destroys local credentials while handle release is deliberately
unimplemented" — a dead-owner failure mode designed around rather than fixed.

"No users yet" argues for *less* code in A, B, and C, all of which stay equally cheap to
fix later. It argues the opposite way here: a recovery credential cannot be retrofitted
onto handles already issued, so its cost rises with every registration and is at its
floor right now, at zero. Split out as #52; not in scope for Task 11.

## Not in this design

- Any change to `main`. #43's refusal guard is not being built.
- Any handling of the pre-0.5 layout in code — migration, `agentcall line adopt`, or
  detect-and-refuse. All three were considered; C is a rollout step instead.
- The recovery credential itself. That is #52, and it touches `apps/relay`, not
  `setup.ts`.
- Making `setup --handle <unmatched>` delegate to `line add` rather than print it.
  Registration is irreversible while #16 is open, so an act with a permanent cost should
  be typed on purpose, not inferred from a flag on the wrong command.
- `--relay` being silently ignored on a re-run (`setup.ts:155` compares only `handle`,
  never `relay`, so `setup --relay <other>` reuses the saved config and prints an
  address derived from the old relay). Same expression, opposite failure — a silent
  no-op rather than a silent clobber, and fully recoverable. Spun off as #51, which
  also notes that Task 11's early return may resolve it incidentally.
- Whether `uninstall` should warn that it keeps `config.json` (`index.ts:493` deletes
  `~/.agentcall` only under `--purge`). Moot once lines lands.
