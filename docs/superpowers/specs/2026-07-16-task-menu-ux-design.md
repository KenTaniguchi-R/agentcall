# agentcall — task-menu owner UX (Phase 1.5)

Date: 2026-07-16
Status: draft from UX review session (Ryusei + Claude); not yet approved
Builds on: [2026-07-16-task-menu-capabilities-design.md](./2026-07-16-task-menu-capabilities-design.md) (Phase 1, implemented on branch `task-menu-phase1`)

## Problem

Phase 1's caller UX is good (personalized cards, structured refusals with the
offered menu, `--task` flag). The owner UX is not:

1. **Defining a task = hand-authored JSON with invisible invariants.** Directory
   name must equal manifest `id`; schema known by heart; two files per task;
   policy edited in a third place; then remember `agentcall card push`.
2. **Validation errors go where owners never look.** `loadTasks` warn-and-skips
   invalid manifests into `~/.agentcall/listener.log`. A typo'd manifest
   silently vanishes from the menu; callers get `task_not_offered`; the owner
   has no idea why.
3. **Card staleness is a manual chore.** Any policy/manifest edit leaves the
   relay-cached card wrong until a manual `card push`.
4. **No management verbs.** "Let Ken schedule meetings" and "block this guy"
   require hand-editing `policy.json`.
5. **Two-file ceremony.** `task.json` + `SKILL.md` splits the one-markdown-file-
   with-frontmatter idiom owners already know from Claude Code skills.

## Scope

Four changes, one decision:

- **A. `agentcall card` (no args) = show my own card + lint** (fixes #2)
- **B. Policy verbs** that rewrite `policy.json` and auto-push the card (fixes #3, #4)
- **C. `agentcall task new <id>` scaffold** (fixes #1)
- **D. Frontmatter SKILL.md replaces `task.json`** (fixes #5 — DECISION: adopt now)

Explicit non-goals for 1.5: `agentcall task test` (local dry-run — deferred),
listener file-watching for auto-push (verbs cover the common paths), T2
approval gates (Phase 3), any protocol or relay change (none needed — the
relay is untouched by this entire phase).

## D first — the on-disk format decision

`task.json` is replaced by YAML frontmatter in `SKILL.md`. One file per task:

```markdown
---
name: Schedule a meeting with Ryusei
description: Propose and book a time on Ryusei's calendar.
tier: T1
tools: [read, fetch]
write_paths: []
network: [calendar.google.com]
timeout_s: 120
examples:
  - Can Ryusei do 30min next Tuesday afternoon?
---
# How to schedule

Check the calendar first, then ...
```

- **The directory name IS the task id.** The `id` field is gone entirely,
  eliminating the id-must-match-dirname dual source and its failure mode.
- Every frontmatter field except `description` is optional with Phase 1's
  defaults (`name` defaults to the id; `tools: [read]`; empty
  `write_paths`/`network`/`examples`; `tier: T1`). `description` stays
  required — a card entry without one is useless to callers.
- Validation: the existing zod `TaskManifest` shape (minus `id`) applied to
  the parsed frontmatter; same warn-and-skip semantics; same regexes
  (`write_paths` public-only, domain pattern, 300s timeout cap).
- Missing or unparsable frontmatter → warn-and-skip (a bare SKILL.md is not a
  publishable task; the lint command in A tells the owner exactly why).
- Skill body = everything after the closing `---`, passed to `buildPrompt`
  exactly as `Task.skill` is today.
- Parser: the `yaml` package (eemeli/yaml — zero deps, maintained) added to
  `packages/cli`. Hand-rolling YAML is how quoting bugs are born.
- **No migration path, deliberately.** The `task.json` format has existed for
  one day on an unmerged branch with zero external users. `loadTasks` reads
  only frontmatter; `task.json` support is deleted, its loader tests rewritten
  against frontmatter fixtures. This is exactly why D is decided now rather
  than after release.

Everything downstream of `loadTasks` (`Task`, `Envelope`, policy resolution,
spawn envelopes, cards) is unchanged — this swaps the parse layer only.

## A. `agentcall card` (no args): own card + lint

Running `agentcall card` with no address renders the owner's own menu from
local files — the same `loadPolicy` + `loadTasks` + `buildCardUpload` path the
push uses — and surfaces every problem to the terminal:

```
ken (claude) — Ken's public agent
  Offered to anyone:
    ask [T1] — Answer questions using the files in the public directory.
    owner-introduction [T1] — Introduce the owner.
  Granted per caller:
    mia: schedule-meeting [T1]

Problems:
  ✗ tasks/deploy-prod: invalid frontmatter, skipped (tier: expected T1|T2, got "T9")
  ✗ policy.json: default_offer references "old-task" but no such task exists
  ! card out of date: local menu differs from last push — run `agentcall card push`
```

- Lint sources: (1) the `warn` callback of `loadTasks`, captured instead of
  passed to `console.error`; (2) policy ids (default_offer + every grant) with
  no matching task; (3) staleness — see below.
- **Staleness detection via local snapshot, no protocol change:** every
  successful push (from setup, `card push`, or a policy verb) writes the
  uploaded JSON to `~/.agentcall/card.pushed.json`. `agentcall card` compares
  the freshly built upload against the snapshot; any difference → the
  out-of-date warning. Missing snapshot → "never pushed" warning.
- Exit code 1 if any `✗` problem exists (lintable in scripts), 0 otherwise
  (the staleness `!` warning alone does not fail).
- `agentcall card <address>` and `agentcall card push` keep their Phase 1
  behavior; `push` now also writes the snapshot.

## B. Policy verbs

Each verb: load policy (or `DEFAULT_POLICY` if missing) → validate → mutate →
write `policy.json` → rebuild card → push → write snapshot → print the result.
A failed push degrades to the Phase 1 warning (local change is still saved).

| Command | Effect |
|---|---|
| `agentcall allow <handle> <task-id>` | add task to `callers[handle].offer` |
| `agentcall revoke <handle> <task-id>` | remove it (drop the caller entry if empty) |
| `agentcall block <handle>` | `callers[handle].block = true` |
| `agentcall unblock <handle>` | clear the block flag |
| `agentcall offer <task-id>` | add to `default_offer` |
| `agentcall unoffer <task-id>` | remove from `default_offer` |

- `<handle>` validated against `HANDLE_RE`; `<task-id>` against `TASK_ID_RE`.
- `allow`/`offer` on a task id with no manifest on disk: hard error naming the
  fix (`agentcall task new <id>`), because publishing a dangling grant is never
  what the owner wants. `revoke`/`unoffer`/`block`/`unblock` never error on
  missing targets (idempotent removal).
- After mutating, print the affected view: for caller verbs, that caller's
  effective menu ("mia can now: ask, owner-introduction, schedule-meeting");
  for offer verbs, the public menu.
- Duplicate adds are idempotent (Set semantics already in `offeredFor`).
- Verbs write the policy file with the same shape `PolicySchema` parses —
  hand-edits and verbs interoperate.

## C. `agentcall task new <id>`

```
$ agentcall task new schedule-meeting
Created ~/AgentCall/tasks/schedule-meeting/SKILL.md
Edit it, then:
  agentcall card                      # check it validates
  agentcall offer schedule-meeting    # offer to everyone, or:
  agentcall allow <handle> schedule-meeting
```

- Validates `<id>` against `TASK_ID_RE`; refuses `ask` (reserved) and existing
  directories (never overwrites).
- The scaffold is a complete, valid frontmatter SKILL.md whose `description`
  is a self-describing placeholder (`description: TODO — one line callers
  will see on your card`). It parses cleanly, so no artificial lint rule is
  needed; `agentcall card` simply shows the TODO verbatim as the card entry,
  which is its own nudge to edit before offering.
- Does NOT touch policy or push anything — a scaffolded task is invisible
  until the owner runs `offer`/`allow` (create ≠ publish).

## Error-visibility principle (applies to all of A–C)

Anything that used to warn into the listener log now ALSO reaches the owner
through the nearest interactive surface: `agentcall card` (lint), verbs
(validation errors), `task new` (refusals). The listener's own warn-to-log
behavior is unchanged — resilience semantics stay identical.

## Testing (TDD, per repo conventions)

- Frontmatter: parse round-trip (all fields), defaults application, missing
  description → skip+warn, unparsable YAML → skip+warn, body extraction,
  dirname-as-id; existing loader behaviors (duplicate/reserved/dir-mismatch
  now moot — dir-mismatch test deleted with the `id` field) re-anchored on
  frontmatter fixtures.
- Card lint: warnings captured and printed; dangling policy ref detected;
  snapshot staleness (differs / missing / matches); exit codes.
- Verbs: each verb's policy-file round-trip; allow-on-missing-task hard error;
  idempotency; push called with the rebuilt upload (mock at the `pushCard`
  seam like setup tests); push-failure degrades to warning with local change
  saved.
- Scaffold: creates valid template (`loadTasks` accepts it barring the TODO
  description), refuses existing/reserved ids.
- No relay changes → no relay test changes.

## Open questions

1. Verb naming: flat verbs (`agentcall allow ken x`) vs namespaced
   (`agentcall policy allow ken x`). Leaning flat — these are the product's
   core owner actions, and `block`/`allow` read like the phone-model mental
   moves they are.
2. Should `agentcall card` (own view) fetch the relay's copy to detect
   out-of-band drift (e.g. pushed from another machine)? Leaning no for 1.5 —
   the snapshot covers the single-machine reality; multi-machine owners can
   `card push` unconditionally.
