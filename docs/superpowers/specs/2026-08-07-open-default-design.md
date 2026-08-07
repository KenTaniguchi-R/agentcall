> **Historical design record, dated 2026-08-07 and never revised.** It records why a
> decision was made, not what the code does now. Do not derive current behavior from
> it, and do not "fix" it to match the code. See [README.md](../../../README.md) for
> current behavior.

# The open default

**Status:** Implemented 2026-08-07 on `feat/open-default-demo`.
**Supersedes the seeding half of** [the sensitivity/clearance model](./2026-08-06-sensitivity-clearance-model-design.md).
**Evidence:** [skill and MCP reachability](../../research/2026-08-06-skill-and-mcp-guard-reachability.md),
[repo-seed default evidence](../../research/2026-08-06-repo-seed-default-evidence.md),
[label-creep spike](../../research/2026-08-06-label-creep-spike.md),
[derived access inheritance](../../research/2026-08-06-derived-access-inheritance.md).

## Why

The fail-closed default was sound and unusable. On a fresh install a caller could reach
**one git repository and nothing else** — not the owner's skills, not an MCP server, not
their notes. The complaint that opened this line of work was exactly that: *"It cannot
invoke a skill, cannot reach an MCP server."*

Three attempts to make the closed default usable without configuration all failed on
evidence, and are recorded so they are not re-proposed:

1. **Enumerate-and-ask at setup** — rejected in our own research note; per-tool
   allowlisting with a wizard, and it does not converge.
2. **Org-authored policy distribution** — rejected by the product constraint: long
   admin setup is why tools do not get adopted.
3. **Derive access from provenance** (git remote, MCP transport) — rejected on
   measurement. GitHub's default gives org members read on *public* repos only, so
   "origin points at the org" is a false positive in the disclosing direction; MCP
   transport does not separate the population; and a Gmail MCP server OAuths against a
   rigorously enforced ACL whose membership is one person.

Being useless is a failure mode too. **This makes the default open and writes down what
that gives up.**

## What changed

| | before | after |
|---|---|---|
| seed | the enclosing git repo, `internal`; nothing outside one | **`$HOME`, `shared`** |
| skills | denied — no `Skill` branch in `guard.ts` | dispatched to `classifySkill`, **default `shared`** |
| `~/.claude/skills` | `secret` (inside the `.claude` floor) | **carved out**, `shared` |
| MCP | denied — unlabelled, and `mcp__*` inexpressible | **enumerated from `~/.claude.json`** into the allowlist |
| `classifyMcp`, the `mcp:` map key | present, zero callers | **deleted** |
| source labels | `public < internal < secret` | **`shared \| secret`** |
| caller clearance | `public \| internal \| blocked` | **`allowed \| blocked`** |
| `AGENTCALL_CLEARANCE` | passed to every guard invocation | **deleted** |

## The lattice collapse

Landed the same day, and it is not merely cleanup — **the three-level lattice was
producing a live bug.** The seed labelled `$HOME` `internal` while
`DEFAULT_POLICY.default_clearance` was `public`, and `permits("public", "internal")` is
`false`. The "open" default opened nothing for a caller with no explicit clearance.

Two facts made the collapse obvious once looked for:

1. **Nothing ever produced a `public` source label.** The only occurrences in the CLI
   were the enum declaration and `combine`'s identity value. The middle level was
   documented, tested, and never emitted.
2. **The lattice encoded two questions in one number** — *how sensitive is this* and
   *whose is it*. That is the shape #394 already recorded as known-insufficient, citing
   the MCP extensions draft and Oracle Label Security.

So the model is now two orthogonal yes/no questions:

- **What may leave** — a source is `shared` or `secret` (`sensitivity.ts`).
- **Who is answered** — a caller is `allowed` or `blocked` (`access.ts`, formerly
  `clearance.ts`).

`permits` takes **one argument**. It used to take the caller's clearance too; with one
grantable level there is nothing left to compare, and a caller who is not answered never
reaches a source at all — `resolveAdmission` refuses a blocked caller before the agent
spawns. **The guard therefore no longer receives a clearance**, which is why
`AGENTCALL_CLEARANCE` is gone: a single-valued parameter threaded through a security
boundary reads as a check that is not happening.

This matches the product rule directly: *only people in the group should be able to see,
and everyone in the group sees the same.*

### Resolution order for access

A named caller wins over every roster, in both directions — naming someone is the
owner's most specific statement. Between two attested rosters that disagree, **blocked
wins.**

That inverts the old clearance union, which took the most *permissive* grant, and the
inversion is deliberate: clearance asked "how much may they be told", where the natural
combination is a maximum; access asks "do we answer at all", where the cautious direction
is to refuse.

### What the collapse costs

**You can no longer say one colleague sees more than another.** That capability was
speculative — nothing produced the label that would have made it real — but it is a real
loss and should be re-added deliberately rather than discovered as missing. Re-adding it
means restoring an ordered lattice, not adding a value.

`agentcall clearance`, `clearance --reset` and `clearance --default` are gone. `block`
and `unblock` are unchanged; `agentcall access --default allowed|blocked` replaces the
line-wide setting, because *answer only named callers and attested rosters* is a posture
the binary model can still express.

**Unchanged, deliberately:** the credential floor, and read-only tools. `Write`, `Edit`,
`Bash`, `WebFetch` and `WebSearch` remain ungrantable. Opening *reads* is not opening
*writes* — a caller's message must not be able to change the owner's machine.

## Why skills default open and MCP servers do not

This asymmetry is the one non-obvious decision here, and it rests on a measurement
rather than a judgement call.

Measured 2026-08-06 against a live `claude` with a logging `PreToolUse` hook:

| | fires a hook the guard can see? |
|---|---|
| the `Skill` invocation | **yes** — `tool_input: {"skill": "<name>"}` |
| a skill's `references/*.md` | **yes** — ordinary `Read` with a full path |
| a skill's `Read`/`Grep`/`Glob`/`LS` | **yes** — ordinary tool calls |
| the `SKILL.md` **body** | **no** — it reaches the model with no tool call at all |

So a skill cannot reach anything the guard does not already check. **The entire exposure
from enabling skills is that skill's own prose.** That bound is what justifies the
generous default, and the owner can still mark a skill `secret` to withhold it.

An MCP server has no such bound — its I/O is opaque to the guard entirely. That is why
there is no `classifyMcp` and no default label: a label on an opaque server would be a
promise the guard cannot keep. Servers are **granted by enumeration** in the allowlist
instead, which is honest about what it is.

Two mechanical notes that constrain any future change here:

- **`--allowedTools` does not gate `Skill` at all** (measured). Before the `Skill` branch
  existed, `guard.ts`'s unclassified-tool deny was the only thing holding skills closed.
  That fallthrough is load-bearing and must not be relaxed.
- **`Skill` must never go in `NO_PATH_SURFACE`.** That set returns allow unconditionally,
  and since the body bypasses the guard, the `Skill` branch is the only check the body
  ever passes through. It is the natural place a reader would put it, and it would open
  the hole in one line.

## What the open default gives up

Stated plainly, because the code comments point here.

**It is credential-safe, not confidential.**

- **The floor still holds.** `~/.ssh`, `~/.aws`, `~/.gnupg`, keychains, `~/.agentcall`,
  `~/.codex`, `~/.claude` (minus `skills`), `Library/LaunchAgents`, and the shell rc
  files are non-overridable `secret`, subtracted by longest-prefix-wins. Nothing inside
  the floor is ever a working directory or an advertised source, even where a carve-out
  makes it readable — otherwise a fresh line would spawn the agent in `~/.claude/skills`,
  which is the shortest reachable path.
- **`redactOutbound` catches credential *shapes*** — `sk-…`, `gh*_…`, `github_pat_…`,
  `AKIA`/`ASIA`, JWTs, `Bearer …`, our own join keys.
- **It misses others.** Stripe (`sk_live_…` — the pattern is `sk-` with a *hyphen*),
  AWS *secret* access keys (only the ID has a shape), Slack `xoxb-`, Google `AIza`, PEM
  blocks pasted into a file, and passwords in prose.
- **It cannot catch confidential *content* at all.** A salary figure, an unreleased plan,
  a customer name — none of that has a shape. Nothing in this design bounds it.

**What actually carries confidentiality is the organization boundary.** Callers are
in-organization by construction (cross-organization routing is a permanent non-goal), and
the relay enforces it. That is the honest security story for this configuration: *anyone
in your organization who can call you can be answered from anything in your home
directory except the credential floor.*

Anyone evaluating this for a deployment should read that sentence and decide, rather than
reading "labelled `internal`" and assuming more.

## Why the guard was kept rather than deleted

The read guard, `classifyPath`, `permits`, `withFloor` and `workdirFor` are all live —
they are what makes the floor work. Only the genuinely dead MCP-label surface was removed.

Keeping the machinery means tightening later is **a change to `defaultSensitivityMap`**,
not a rebuild. The usual objection to "security later" is that you never get it back;
that objection is weak here specifically because nothing was deleted.

## What this does not resolve

- [#399](https://github.com/KenTaniguchi-R/agentcall/issues/399) — the sink-side
  provenance backstop, which is what would let an *opaque* source be bounded rather than
  merely granted. Now more clearly scoped as MCP's long-term answer.
- [#397](https://github.com/KenTaniguchi-R/agentcall/issues/397) — `.gitignore` is still
  honoured nowhere, and the grant is now `$HOME`-wide, so this got *more* valuable.
- [#173](https://github.com/KenTaniguchi-R/agentcall/issues/173) — content scanning of
  the reply; the acknowledged residual, and a detector rather than a boundary.
- The redaction gaps above are unfiled as of this writing.
