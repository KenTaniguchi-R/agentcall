# Sensitivity and clearance: replacing the capability envelope

> **Historical document — not current documentation.** This is a dated design
> record that describes the repository state on 2026-08-06 and is deliberately
> *not* updated when behavior changes.

**Date:** 2026-08-06

**Status:** Proposed

**Research:** [Information-flow control for agent answers](../../research/2026-08-06-information-flow-control-for-agent-answers.md)

## The problem this replaces

Today a task carries an `Envelope` of capabilities:

```ts
export const CAPS = ["read", "write", "fetch", "exec"] as const;  // tasks.ts:8
export interface Envelope { caps: Cap[] }                          // tasks.ts:20-22
```

`caps` maps to Claude's `--allowedTools` and Codex's `--sandbox` level
(`runner.ts:219-233`, `:278-282`). Three separate mechanisms then bound what an
answering agent can reach:

1. **The envelope** — which tool names are pre-approved.
2. **`guard.ts`'s denylist** — `~/.ssh`, `~/.aws`, `.env`, credential basenames,
   denied wherever they sit.
3. **`AGENTCALL_ALLOWED_ROOT`** — a hard root confining the task to one
   directory (`runner.ts:273`, `guard.ts:177-196`, `guard-entry.ts:66`).

Three mechanisms, three failure modes, and together they produce a product that
cannot answer anything. The default line has no `policy.json`, so
`default_offer: ["ask"]` applies (`policy.ts:63`); `ask` carries
`caps: ["read"]` (`tasks.ts:72-81`); and no `workdir` in `config.json` resolves
to `~/AgentCall/<line>/public` (`config.ts:53-54`, `paths.ts:112`), which
`setup` never creates. `Skill` and `mcp__*` appear in no cap, so the owner's
skills and MCP servers are configured but unreachable.

The capability model has no axis for the things that make an agent worth
calling. That is not a missing option — `CAPS` is the whole vocabulary.

## The reframe

**AgentCall is durable, addressable, policy-scoped Q&A over private context —
not remote agent execution.**

The value was never that a coworker's agent can *act*; GitHub already does that
with review attached. The value is that it *knows* things the caller cannot
reach: notes, repository history, why a decision was made.

Accept that, and the only sink is **the reply**. Which means:

- injection cannot write, exec, send, or spend — there is nothing to reach
- the worst an injected Jira ticket achieves is putting more of the owner's
  context into the reply, or making the answer wrong
- a wrong answer to a coworker is not a security incident

**The two-axis IFC model collapses to one: confidentiality.** Integrity labels
are not needed when no effectful sink exists.

## The model

> Every context source has a **sensitivity**. Every caller has a **clearance**.
> The agent may answer with anything at or below that clearance. **Anything
> unlabeled is secret.**

### Sensitivity lattice

```
public  <  internal  <  secret
```

- `public` — safe for any in-organization caller.
- `internal` — the normal working level: repositories, engineering notes.
- `secret` — never leaves, for any caller. No clearance grants it.

Three levels, not FIDES's five-way product. The research note records
over-tainting as IFC's historical failure mode; a shallow lattice and a
single-call run are the two mitigations that keep it shallow here.

### Sources carry sensitivity

```jsonc
// ~/.agentcall/<line>/sensitivity.json
{
  "public":   ["~/AgentCall/<line>/public"],
  "internal": ["~/coding/agentcall", "~/Obsidian/vault/eng"],
  "mcp": { "jira": "internal", "openmemory": "internal", "gmail": "secret" },
  "skills": { "obsidian": "internal" }
}
```

Everything omitted — including all of `$HOME` — is `secret`. Directories, MCP
servers, and skills are labeled by the same one-line-each mechanism. Labeling by
*sensitivity* is a job an owner can keep current; labeling by *tool* is not.

### Callers carry clearance

`policy.json` stops being a task menu and becomes a clearance table:

```jsonc
{
  "default_clearance": "public",
  "callers": { "ken@acme": "internal" },
  "groups":  { "eng": "internal" }
}
```

`policy.ts`'s per-caller and per-group resolution survives structurally — it
becomes the clearance lookup. The CaMeL invariant at `policy.ts:217-219` is
correct as written and must survive untouched:

> this runs on relay-verified `from` and local files only, BEFORE the caller's
> message is placed in any prompt. The message cannot influence which task (and
> therefore which envelope) is chosen.

Identity decides clearance. The message never does.

### The reply is the sink

One check, at one place: **the running context's sensitivity must be ≤ the
caller's clearance.** Reading a `secret` source raises context to `secret`, and
the reply is refused with a fixed, contentless reason — the existing
`DENY_REASON` contract.

### Declassification by capacity

Per the FIDES paper's type lattice (`bool ⊑ enum ⊑ string`), a task that
declares a constrained output schema may emit a typed value derived from
higher-sensitivity content, because a bounded-capacity output cannot carry a
payload:

```yaml
---
description: Report the status of a Jira ticket
sources: [jira]
output:
  status: enum[todo, in-progress, blocked, done]
  updated: date
---
```

`jira-status` answers from `internal` content to a `public`-cleared caller.
Free-text `ask` cannot; it emits `string`, which is unbounded.

## What this deletes

| Today | Fate |
|---|---|
| `CAPS`, `Cap`, `Envelope`, `FULL_ACCESS_ENVELOPE` (`tasks.ts:8-28`) | **deleted** — no write/exec/read distinction remains |
| `guard.ts` denylist as a special case | **re-expressed as floor rules** — see below |
| `AGENTCALL_ALLOWED_ROOT` / `allowedRoot` | **deleted** — "unlabeled is secret" is strictly more general |
| `deriveThreadable` (`tasks.ts:93-96`) | **deleted** — threading is safe when the only sink is a clearance-checked reply |
| task and line `workdir` (`config.ts:53-64`, `listener-stages.ts:206`) | **deleted** — the sensitivity map replaces a single working directory |
| `claudeAllowedTools` cap mapping (`runner.ts:230-233`) | **replaced** — tools follow from labeled sources |
| `policy.json` `default_offer` / `offer` / task menus | **replaced** by clearance |

`guard.ts` does not disappear — it becomes the enforcement point for
"is this path's sensitivity ≤ clearance", which is the same hook seam it already
occupies. The net is fewer mechanisms, not more.

### Correction: the denylist becomes floor rules, not nothing

The first draft of this spec said `DENIED_DIRS` could simply be deleted, because
those paths are unlabeled and therefore `secret`. **That is wrong**, and it was
caught while implementing: it holds only while nobody labels a *parent*. An
owner who writes `{ "path": "~", "sensitivity": "internal" }` would classify
`~/.ssh/id_rsa` as `internal` and hand it to any `internal`-cleared caller.

The fix keeps one mechanism rather than restoring two. Those paths are merged in
as built-in `secret` **sources** (`builtinSecretSources`, `withFloor`), so:

- longest-prefix-wins makes `~/.ssh` beat a broader `~` automatically
- the most-restrictive tie-break makes the floor **non-overridable** from the
  owner's map, even by an exact-path label
- `withFloor` is idempotent, so double application cannot change a verdict

The denylist stops being a parallel mechanism and becomes data in the one that
remains. That is a better outcome than the original deletion and it preserves
every property `guard.ts` had.

### The change is contained to `packages/cli`

**Capabilities never cross the wire.** Nothing in `packages/shared`'s protocol
schemas or in `apps/relay` carries `caps` — the `Envelope` that appears there is
`HpkeEnvelope`, the E2EE crypto envelope (`packages/shared/src/e2ee.ts:45-64`),
which is unrelated and unaffected. A grep for `Envelope` alone conflates the two
and overstates the blast radius; an earlier draft of this spec did exactly that.

The capability surface is **9 source files and 8 test files, all in
`packages/cli`**: `card.ts`, `lint.ts`, `listener-stages.ts`, `policy-report.ts`,
`policy.ts`, `prompt.ts`, `runner.ts`, `verbs.ts`, `verify.ts`.

So there is no protocol version to bump, no relay deploy to coordinate, and no
migration between old and new callers. That materially lowers the cost of this
change and is a point in its favour.

## What this does *not* solve

**It bounds the audience, not the content.** A secret pasted into an
`internal` source reaches every `internal`-cleared caller.
[#173](https://github.com/KenTaniguchi-R/agentcall/issues/173) — content
scanning of the reply — stays open, stays complementary, and its framing is
unchanged by this design.

**Effectful tasks are out of scope, not forbidden.** "Run the tests and tell me"
is a real request implemented with exec. Such tasks remain reachable through an
explicit per-caller grant, are never a default, and are **declared outside the
guarantee** in their own documentation. The core is not designed around them.

## Risks

1. **Over-tainting.** If realistic questions routinely touch a `secret` source,
   every answer degrades to a refusal and the product is useless in a new way.
   *This is the one that kills the design, and it is cheap to measure.* A spike
   replaying a dozen realistic questions against a labeled setup should run
   before implementation is trusted.
2. **Labeling burden at setup.** Mitigated by defaulting `internal` to the git
   repository `setup` runs in, and by the emerging MCP `_meta.ifc` convention.
3. **This design was written the day after the source papers were read.** The
   reframe (Q&A, one sink) is the confident part. The labeling machinery is the
   part to prototype before believing.

## Positioning note

"Sensitivity levels and clearances" is vocabulary an enterprise buyer already
owns, with existing compliance analogues. Given the enterprise direction, that
may be worth more than the security property itself — this stops being a novel
AI-safety mechanism that has to be sold and becomes classification and
clearance, which every CISO can already place.
