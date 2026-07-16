# agentcall — task-menu capabilities & agent cards

Date: 2026-07-16
Status: draft from brainstorming session (Ryusei + Claude); not yet approved
Builds on: [2026-07-13-agentcall-design.md](./2026-07-13-agentcall-design.md)

## Problem

Today every registered caller gets the same, single capability tier: the callee's
agent spawns inside the srt sandbox (writes confined to `~/AgentCall/public`, home
unreadable, network allowlisted) and does whatever the caller's message asks within
that sandbox. There is no way for an owner to say:

- "My agent may only perform *these* tasks" (e.g. introduce me, schedule a meeting)
- "Ken may schedule meetings; strangers may only ask questions"
- "Block this caller entirely"

And there is no way for a caller to discover, before burning a call, what a callee's
agent is willing to do.

## Model

The owner defines a **menu of named tasks**. Each task is implemented as a skill
(SKILL.md + manifest) and advertised on an **agent card**. Capability = the set of
tasks a caller is granted, not raw tool access. Enforcement is **task-scoped
spawning**: the listener resolves which task a call is *before* spawning, then spawns
the agent with only that task's skill loaded and only that task's capability envelope
(tool flags + srt filesystem/network config).

This is the A2A v1.0 Agent Card pattern (skills + authenticated extended card)
implemented locally, plus the enforcement layer A2A itself still lacks (RFC #1716,
open as of 2026-07): per-caller × per-skill authorization, enforced at the boundary.

### Prior-art anchors (July 2026)

- **A2A v1.0** (Linux Foundation, 2026-05): `AgentSkill {id, name, description,
  tags, examples}`; `capabilities.extendedAgentCard` returns a richer card after
  authentication ("may include additional skills"); calling an unadvertised
  capability MUST return a structured error. Card field names below mirror this.
- **SINT/Enclave tier taxonomy** (A2A RFC #1716 ecosystem): T0 observe / T1 read,
  auto-execute / T2 act, owner approval / T3 irreversible, human sign-off.
- **MCP 2026-07-28**: per-tool (not per-server) scopes; task/session-scoped tokens
  ("scope tokens to tasks, not to agents"); scope-challenge errors that name the
  missing scope (step-up). Task-scoped spawn is this pattern materialized locally —
  the envelope dies with the process.
- **CaMeL / reasoning-kernel invariant**: untrusted content must never choose the
  capability set. The grant is fixed before the model sees a single untrusted byte;
  any delegation can only narrow it. This drives every enforcement decision below.

## Directory & file layout (callee machine)

```
~/AgentCall/
├── public/                          # workspace, as today
└── tasks/
    ├── owner-introduction/
    │   ├── SKILL.md                 # instructions for performing the task
    │   └── task.json                # manifest: envelope + card metadata
    └── schedule-meeting/
        ├── SKILL.md
        └── task.json

~/.agentcall/
├── config.json                      # as today (handle, token, agent_kind, relay)
└── policy.json                      # NEW: offers, per-caller grants, defaults
```

### Task manifest (`task.json`)

Single source of truth for both the card entry (advertisement) and the spawn
envelope (enforcement) — generated from one file so they can never disagree.

```jsonc
{
  "id": "schedule-meeting",
  "name": "Schedule a meeting with Ryusei",
  "description": "Propose and book a time on Ryusei's calendar.",
  "examples": ["Can Ryusei do 30min next Tuesday afternoon?"],
  "tier": "T2",                      // T1 = auto-execute, T2 = owner approval (phase 3)
  "envelope": {
    "tools": ["Read", "WebFetch"],   // claude --allowedTools / codex sandbox mapping
    "write_paths": [],               // srt allowWrite additions under ~/AgentCall
    "network": ["calendar.google.com"] // srt allowedDomains additions
  },
  "timeout_s": 300                   // optional per-task override, ≤ AGENT_TIMEOUT_MS
}
```

Envelope semantics: the **base envelope** is read-only Q&A (read `publicDir`, no
Bash, no writes, model-API network only). A task's envelope only ever *adds* to the
base — and everything it adds is enumerated in the manifest. There is no "full
access" manifest value; a task that needs broad write access lists
`"write_paths": ["public"]` explicitly.

### Policy file (`~/.agentcall/policy.json`)

```jsonc
{
  "default_offer": ["owner-introduction", "ask"],   // what any registered caller gets
  "callers": {
    "ken":     { "offer": ["+schedule-meeting"] },  // + adds to default_offer
    "spammer": { "block": true }
  }
}
```

- `ask` is a built-in task (base envelope, generic Q&A) present unless removed.
- `block: true` refuses calls from that handle at the listener without spawning.
- Unknown callers get exactly `default_offer`. Setting `"default_offer": []`
  makes the agent invite-only.

## Agent card

Generated from `policy.json` + the task manifests; pushed to the relay so it is
fetchable while the callee is offline (the card is the phone-book entry).

- **Public card** (`GET /v1/card/:handle`, unauthenticated): handle, description,
  agent_kind, the tasks in `default_offer` (id, name, description, examples, tier),
  limits, `updated_at`.
- **Extended card** (same route, authenticated caller): additionally includes tasks
  granted specifically to that caller. A caller sees only *their own* grants, never
  the full ACL — per-caller grants are private between owner and that caller.
- Relay storage: `cards` D1 table (or column on `handles`), replaced wholesale on
  `agentcall card push` (also run automatically by `setup` and whenever the listener
  detects policy/manifest changes on connect).

CLI: `agentcall card <address>` prints the (extended, since callers are
authenticated) card. `agentcall card push` republishes your own.

Deferred: JWS-signed cards (A2A v1.0 supports them; adds key management — not
needed while the relay is the single trusted distribution channel).

## Protocol changes (packages/shared first, as always)

- `call_request` gains optional `task?: string` (task id from the card).
- New caller-facing error codes: `blocked`, `task_not_offered`, `task_unknown`,
  `approval_denied` (phase 3), `approval_timeout` (phase 3).
- `call_error task_not_offered` carries `detail` and a structured `offered: string[]`
  — the caller's personalized menu (MCP scope-challenge shape: tell the caller what
  *would* work).
- `call_reply` gains optional `task?: string` echoing which task actually ran.
- New relay route `GET /v1/card/:handle` (public + extended via Bearer token).
- Listener→relay: `card_update {card}` or the CLI pushes over HTTP — pick HTTP
  (`PUT /v1/card`, Bearer auth) to keep the WS protocol untouched.

## Call flow (listener)

```
incoming_call {call_id, from, message, task?}
  1. policy check: from blocked?            → call_failed blocked (no spawn)
  2. resolve offered set for `from`         (default_offer ∪ caller grants)
  3. task resolution:
     a. task specified & in offered set     → that task
     b. task specified, exists, not offered → call_failed task_not_offered + offered[]
     c. task specified, unknown             → call_failed task_unknown + offered[]
     d. no task, offered set has one entry  → that task
     e. no task (phase 1)                   → built-in `ask` if offered, else task_not_offered
        no task (phase 2)                   → dispatcher picks from offered set or `none`
  4. tier gate (phase 3): T2 task           → owner approval flow; deny → approval_denied
  5. build envelope: base + manifest additions
     → write per-call srt settings, build spawn args (allowedTools / codex sandbox)
  6. spawn with SKILL.md content + preamble + caller message; reply as today
  7. audit line gains: task, resolved_via (explicit|dispatch|default), envelope hash
```

**Invariant (CaMeL):** steps 1–5 complete before the caller's message is placed in
any model prompt. The dispatcher (phase 2) is the only model call that sees the
message pre-envelope, and it is tool-less and schema-constrained: its entire output
is one task id from the offered set or `none`. Worst-case injection outcome is
"wrong task from the offered set" — never a task outside it, never a widened
envelope.

Refusals (blocked / not offered / unknown) never spawn an agent: no tokens burned
by menu-probing, and the caller already got the menu from the card.

## Enforcement mechanics

Two independent layers per spawn, both derived from the resolved task's manifest:

1. **Agent flags** — claude: `--allowedTools <envelope.tools>` +
   `--permission-mode dontAsk` (locked-down headless pattern), skill content
   injected via the prompt (not `~/.claude/skills`, which stays denyWrite-protected
   and owner-private). codex: `--sandbox read-only` unless `write_paths` non-empty.
2. **srt config** — `writeSrtSettings` takes the envelope: `allowWrite` = base +
   `write_paths`; `allowedDomains` = model-API list + `network`. Written per-call
   (srt.json is already rewritten before every spawn today).

Prompt preamble additionally states the active task and its bounds (soft layer,
behavior-shaping only — never the security boundary).

## Phases

- **Phase 1 — tasks, cards, explicit selection.** Manifests, policy.json, card
  push/fetch, `task` field, task-scoped envelopes, structured refusals, built-in
  `ask`. No dispatcher, no approvals. Callers are usually other agents that read
  the card, so explicit `--task` covers the common case immediately.
- **Phase 2 — dispatcher.** Tool-less classifier call resolves free-form messages
  to an offered task. Adds natural UX for human callers.
- **Phase 3 — approval gates (T2).** Listener queues T2 calls, notifies the owner
  (push/CLI), spawns on approval with a bounded wait; `approval_timeout` otherwise.

## Security model (delta from v1 spec)

- The card can never over- or under-state capability: card and envelope are
  generated from the same manifests + policy.
- Capability resolution uses only relay-verified `from` and local files; the
  caller's message cannot influence the envelope (phase 2 dispatcher bounded as
  above).
- Residual risks: prompt injection can still make a task *misbehave within its
  envelope* (e.g. write junk to an allowed path, produce a misleading reply);
  relay still sees card + message plaintext; a stale relay-cached card may
  advertise tasks the callee has since removed (enforcement is local, so the call
  fails closed with `task_not_offered`).
- Any registered caller can probe task ids and distinguish `task_unknown` from
  `task_not_offered`, so private (unadvertised) task ids are enumerable by
  guessing — treat task ids as non-secret. This is deliberate: A2A itself
  requires structured errors that name the missing capability rather than a
  uniform refusal, and the alternative (collapsing both codes into one to hide
  which task ids exist) would break the caller-facing menu discovery this
  whole design is built around.

## Testing (TDD, per repo conventions)

- `packages/shared`: schema round-trip/rejection for `task` field, new error codes,
  card schema.
- `apps/relay`: card push/fetch (public vs extended), unknown-handle card 404.
- `packages/cli`: policy resolution unit tests (blocked / offered / step-up refusal
  paths, `+` grant merging); manifest→envelope→spawn-args mapping for both agent
  kinds; manifest→srt-settings mapping; card generation snapshot; listener flow
  with fake `run` (existing pattern) asserting no-spawn on refusal paths.

## Open questions

1. Manifest `tools` vocabulary: use claude tool names as canonical and map to codex
   sandbox levels, or define an agent-neutral enum (`read`, `write`, `fetch`,
   `exec`)? Leaning agent-neutral enum — manifests shouldn't break if the owner
   switches agent kind.
2. Does the built-in `ask` task allow reading `publicDir` only, or also WebFetch?
   Leaning publicDir only; web research is an explicit task an owner opts into.
3. Card staleness: push-on-listener-connect may not be enough if policy changes
   while connected — watch policy.json/task dirs, or accept staleness until next
   reconnect? Leaning accept staleness (enforcement is local; card is advisory).
4. Where SKILL.md content enters the claude spawn: prompt injection of the file
   content vs `--append-system-prompt` vs a temp settings dir. Needs a spike
   against real `claude -p` behavior before the implementation plan.
