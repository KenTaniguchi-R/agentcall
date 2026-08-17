> **Historical design record, dated 2026-08-07 and never revised.** It records why a
> decision was made, not what the code does now. Do not derive current behavior from
> it, and do not "fix" it to match the code. See [README.md](../../../README.md) for
> current behavior.

# Invert the default: a denylist, not a label model

**Status:** Proposed. Not approved, not started.
**Follows** [the open default](./2026-08-07-open-default-design.md), which made the seed
generous but left the model that made a generous seed necessary.

## The problem is concept count, not code size

The open default fixed the *behaviour*. It did not reduce what a person has to
understand to answer "what can my colleague see?":

| # | concept | where |
|---|---|---|
| 1 | path → label, longest-prefix-wins | `sensitivity.json` |
| 2 | a non-overridable floor of `secret` paths | `FLOOR_DIRS` / `FLOOR_FILES` |
| 3 | a carve-out punching back through the floor | `FLOOR_CARVEOUTS` |
| 4 | denied basenames, matched anywhere on disk | `guard.ts` |
| 5 | skills by name, **defaulting the opposite way to everything else** | `classifySkill` |
| 6 | MCP servers granted by allowlist enumeration rather than by label | `runner.ts` |
| 7 | the guard meaning different things on different runtimes | enforce / observe |

**Items 1–4 are four different ways to say "this is secret."** Deleting any one of them
removes a quarter of a mechanism and none of the confusion.

Item 5 is the sharpest symptom. Skills default `shared` while everything else defaults
`secret` — an exception that exists *only because* the default is inverted from what the
product wants, and one every reader has to memorise.

## The inversion

**The agent may read under one root, minus a denylist. Everything else is out of scope.**

Four facts replace seven concepts:

1. **A root.** `$HOME` by default. The owner may add another (a repo on a volume, `/opt`);
   anything outside a root is unreachable, full stop.
2. **A denylist.** Paths that are never readable — today's floor, plus the basename rules,
   as one list rather than three mechanisms in two files.
3. **Who is answered** — `allowed` / `blocked`, unchanged from the collapse.
4. **What is stripped from the reply** — `redactOutbound`, unchanged.

What falls out:

- **1, 2, 3 merge.** There is no map-versus-floor-versus-carve-out distinction, because
  there is no label model to carve. A path is denied or it is not.
- **5 disappears.** The skills exception exists only to escape the secret default. With no
  secret default there is nothing to except; a skill is readable like anything else, and
  `classifySkill` can go.
- **6 stops being a concept.** MCP needs no label. The allowlist enumeration stays as
  plumbing — `mcp__*` is still inexpressible — but nobody has to learn a rule about it.
- **4 survives as an entry shape**, not a separate mechanism: `.env` anywhere is a
  denylist rule that matches by basename rather than by prefix.

`sensitivity.json` stops being required at all for the normal case. Today `setup` writes a
seed file whose entire content says "you may read your own home directory" — a file that
exists to undo a default.

## The cost, stated plainly

**This flips the failure direction, which is the property the current design was built
around.** `sensitivity.ts` opens with it:

> Everything not named is `secret`, so the failure mode of an unconfigured or
> half-configured line is a refusal to answer rather than a leak.

After the inversion, the failure mode of an unconfigured line is a **leak**, bounded only
by the root and the denylist. Four specific consequences:

**1. New source types default open.** Today, a tool or source the model does not know about
classifies `secret` and is refused. That is why the `Skill` gap was a capability loss and
not a disclosure. After the inversion, whatever Claude Code or Codex adds next is readable
the day it ships. The rot direction reverses: today new means denied (safe, annoying);
after, new means allowed (useful, risky).

**2. Symlink escape stops being protective.** Today a symlink out of a labelled tree
resolves to an unlabelled path and is refused — `sensitivity.test.ts` pins exactly this.
After, it resolves to a path that is simply not on the denylist, and is read. Canonicalisation
still happens; it just stops changing the answer. **Keep the root check applied to the
resolved path**, or this becomes an escape from the root itself, which would be worse than
the label model ever was.

**3. Anything the owner acquires later is in scope.** A repo cloned into `$HOME` next week
is readable without anyone deciding so. This is the capability-grant framing from
Anthropic's [*How we contain Claude*](https://www.anthropic.com/engineering/how-we-contain-claude),
and it is now the whole model rather than one seeded entry.

**4. The denylist can never be complete.** [#411](https://github.com/KenTaniguchi-R/agentcall/issues/411)
established this before it was closed: five real gaps on one developer machine, three of
them shell startup files the floor's own reasoning already covered. Under a label model an
omission means one directory stays secret that could have been shared. Under a denylist an
omission means one directory is shared that should have been secret. **Same list, opposite
blast radius.**

## One distinction that must not be lost

There are two different fail-closed decisions in the guard today, and they are easy to
conflate because both currently produce a denial:

- **"I cannot understand this tool call."** An unclassified tool name, an unparseable path,
  a missing argument. This must **stay** fail-closed. Not knowing what a call does is a
  different thing from knowing it touches an ordinary file.
- **"This path has no label."** This is what inverts.

Keeping the first and flipping the second is coherent. Flipping both would mean a tool the
guard cannot parse gets waved through, which is the `LS` bug `guard.ts` already records:

> A tool absent from all four groups is DENIED, not allowed… `LS` was missed exactly that
> way in an earlier draft and fell through to allow.

## What still holds it together

The inversion is defensible only because two other things carry the weight, and both should
be stated wherever the model is:

- **The organization boundary.** Callers are in-organization by construction; cross-org
  routing is a permanent non-goal. This is what makes "readable by any caller we answer"
  mean "readable by a colleague".
- **The root.** `$HOME` is a real bound. `/etc`, `/var`, other users' home directories, and
  mounted volumes stay out of scope without appearing on any list.

Without the root this is not a simplification, it is `/`.

## Implementation sketch

Not a plan — the shape, so the size is visible.

- `SENSITIVITIES` and the label vocabulary go away. `classifyPath` becomes
  `isDenied(path)`: inside a root, and not matching a denylist entry.
- `FLOOR_DIRS` + `FLOOR_FILES` + `DENIED_BASENAMES` become one list with two entry kinds
  (prefix, basename).
- `classifySkill`, `DEFAULT_SKILL_SENSITIVITY`, `FLOOR_CARVEOUTS`, `combine`, `permits` are
  all deleted. The `Skill` branch in `guard.ts` becomes an allow, since a skill's own reads
  are checked normally and only its body bypasses — which under this model is fine, because
  the body is a file under a root that is not denied.
- `sensitivity.json` becomes optional and, when present, holds only extra roots and extra
  denials.
- `readableSources` / `workdirFor` collapse to "the root", which is also what the prompt
  names.

## What would make this the wrong call

Written down now, while it is cheap to be honest:

- **A deployment that is not a demo.** The failure direction matters much more when a
  mistake reaches someone who did not choose it.
- **Callers who are not colleagues.** The moment a caller is outside the organization, the
  thing carrying this model is gone.
- **A second root that is not `$HOME`.** Each added root widens the blast radius of every
  denylist omission, and roots are added by people who want something to work.

The reversal is not symmetrical. Going from denylist back to labels means re-labelling
everything an owner has accumulated, which nobody will do. **This is a one-way door in
practice even though it is reversible in git.**

## Related

- [the open default](./2026-08-07-open-default-design.md) — the behaviour this generalises
- #411 / #410 — the denylist-completeness evidence, closed by decision
- #391 — enforce/observe, concept 7, which this spec does not address
