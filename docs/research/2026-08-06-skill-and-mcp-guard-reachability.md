# Skill and MCP reachability under the guard — measured, not inferred

Research note, 2026-08-06. Verified against `main` @ `6dbf1c6` and against a live
`claude` on this machine. Opened to settle the two open questions in #392: whether
`classifySkill` is worth wiring, and what `mcp__*` in an allowlist would actually mean.

**Headline: #392's diagnosis is wrong and its conclusion is right, for a different
reason. `--allowedTools` does not gate `Skill` at all.** What keeps skills
unreachable today is `guard.ts`'s fail-closed default for unclassified tools — a
behaviour the issue attributes to the allowlist. That misattribution makes the
issue's step 1 a no-op and its most natural step 2 a hole.

## Method

A throwaway project skill plus a logging `PreToolUse` hook, run headless against a
real `claude`. Everything under the session scratchpad; nothing in `~/.claude` was
touched, and the hook was supplied via `--settings <file>` rather than a
`.claude/settings.json` (which `scripts/guard-verification-gate.sh` correctly
refuses to let an agent write).

- `probe/.claude/skills/hookprobe/SKILL.md` — body carries `MARKER_BODY_001`, links to
  `references/detail.md`
- `probe/.claude/skills/hookprobe/references/detail.md` — carries `MARKER_REFERENCE_002`
- hook logs raw stdin, exits 0 (or exits 2 for the denial run)
- invocation: `claude -p "Invoke the hookprobe skill…" --settings … --allowedTools … --permission-mode dontAsk`

Raw logs remain at `<scratchpad>/probe/hooks.log`.

## What the hook actually sees

| event | fires a `PreToolUse`? |
|---|---|
| `Skill` invocation | **yes** — `tool_name: "Skill"`, `tool_input: {"skill": "hookprobe"}` |
| the `SKILL.md` body loading | **no** — zero `Read` events for it, yet the model reported `MARKER_BODY_001` |
| `references/detail.md` | **yes** — an ordinary `Read` with a full `file_path` |

Exit 2 on the `Skill` event blocked the invocation cleanly; the model reported the
block and declined to route around it by reading the skill files directly.

The body/reference split matches what the skills documentation implies about
progressive disclosure, but the documentation does not state whether the body load
is a tool call. It is not. That had to be measured.

## `--allowedTools` does not gate `Skill`

Run with the exact string `claudeAllowedTools()` produces:

```
claude -p "…" --allowedTools "Read,Grep,Glob,LS" --permission-mode dontAsk
```

**The skill ran.** Both markers came back. This is the production flag pair from
`runner.ts`, comma-joined exactly as `CLAUDE_READ_ONLY_TOOLS.join(",")` emits it.

So this sentence in #392 is false as applied to `Skill`:

> Still no `Skill`. Still no `mcp__*`. With `--permission-mode dontAsk`, everything
> absent from that list is denied.

It holds for `mcp__*`. It does not hold for `Skill`.

## What is actually holding the line

`guard-entry.js` run directly against synthetic events, `AGENTCALL_GUARD_MODE=enforce`,
`AGENTCALL_CLEARANCE=internal`:

| `tool_name` | verdict |
|---|---|
| `Skill` | `deny` |
| `mcp__openmemory__search_memory` | `deny` |
| `mcp__plugin_exa_exa__web_search_exa` | `deny` |

All three land on the same path: absent from `EXACT_TARGET`, `SCANNING_ROOT`,
`NO_PATH_SURFACE` and `SELECTOR_KEY`, so `decide()` falls through to deny. That
fallthrough is the whole control for skills.

In `observe` mode — every Codex line — all three are allowed silently, per #391.
Codex has no equivalent of the `Skill` tool and gets `--ignore-user-config` to drop
MCP servers, so this is currently theoretical there rather than exploitable.

## Consequences for #392

**1. Step 1 is a no-op for skills.** Adding `Skill` to `CLAUDE_READ_ONLY_TOOLS`
changes nothing, because that list never governed it. Only the guard dispatch is
load-bearing. A change that did step 1 and stopped would look done and do nothing.

**2. The natural implementation of step 2 is the dangerous one.** `Skill` has no
filesystem argument, so `NO_PATH_SURFACE` is where a reader would put it — and
`NO_PATH_SURFACE` returns `{allow: true}` unconditionally (`guard.ts:185`). That
single line would enable skills *and* remove the only check on the body, together.
It has to be a name-keyed branch dispatching to `classifySkill`.

**3. `classifySkill` is load-bearing, not dead code.** Because the body load emits no
tool call, no path check ever runs on it. The label on the skill name is the only
thing that can bound the body. #392's "Skills may need nothing — a skill's reads
already pass the guard" is true of `references/` and false of the body.

This matters most because personal skills live under `~/.claude`, which is in the
**non-overridable secret floor** (`sensitivity.ts:138`, `FLOOR_DIRS`). Today a
`Read` of a personal `SKILL.md` is denied for every clearance. Via `Skill`, the same
bytes would enter the answering agent's context unexamined. Project skills in a
repo's `.claude/skills` are not floored (the floor is home-relative) and inherit the
repo's label — an asymmetry stated nowhere.

**4. The `guard.ts` group comment is now inaccurate.** It says the four groups cover
"every tool the envelope can grant (see `CLAUDE_TOOLS` in runner.ts)". `Skill`
arrives without the envelope granting it. The comment understates what the
fallthrough is doing, which is how a fallthrough gets simplified away.

## Consequences for `mcp__*`

**`mcp__*` is not expressible in an allowlist.** Per the permissions reference, allow
rules accept tool-name globs only after a literal `mcp__<server>__` prefix, and the
server segment must be glob-free. `mcp__puppeteer__*` is valid; `mcp__*` is not.

So #392 step 1's "`mcp__*` needs a prefix match, which the current `join(",")`
allowlist does not express" understates it: no allowlist syntax expresses it.
Enabling MCP means naming each server at setup — which is the enumerate-and-ask
step [the research note](./2026-08-06-information-flow-control-for-agent-answers.md)
rejected as non-convergent and #394 §3 records as already-rejected. **#392 and #394
are in direct conflict here, and the CLI's permission syntax decides it against
#392.**

Separately, `PreToolUse` *does* fire for MCP tools with the full
`mcp__<server>__<tool>` name, so a guard can see and deny them. The enforcement point
exists; it is the allowlist that does not cooperate.

**Plugin-bundled servers are named differently.** `mcp__plugin_<plugin>_<server>__<tool>`,
and per the MCP docs a matcher on the bare server key "never fires for a
plugin-bundled server". Since `lookup` (`sensitivity.ts:119`) is an **exact-key**
match, not longest-prefix, an owner labelling `exa` would not cover
`plugin_exa_exa`. Unlabelled is secret, so this fails closed — but invisibly: the
owner believes they granted something and the agent keeps refusing. Confirmed above
that the plugin-scoped form denies.

## The `lookup` asymmetry, stated

`classifyPath` gets longest-prefix-wins and carve-outs. `classifyMcp` and
`classifySkill` get one flat exact string match each. The "opaque container" problem
#394 attributes to MCP is, in our code, a property of how these two classifiers were
written — not of the protocol. Worth separating in the amendment.

`tool_input` for `Skill` is the bare skill name, with no scope marker, so a personal
`~/.claude/skills/foo` and a project `.claude/skills/foo` are both `"foo"` to the
hook. One `skills:` entry labels both. Whether that is acceptable is a decision, not
an oversight to fix silently.

## What I could not verify

- **Whether the `Skill` body load bypasses hooks by design or incidentally.** Observed,
  not documented. It could change in a Claude Code release without notice, in either
  direction. Anything built on it should be built on the `Skill` deny (documented and
  stable-looking), not on the absence of a `Read`.
- **Skill precedence across personal/project/plugin scopes.** The docs describe
  discovery but not conflict resolution; not probed here.
- **Whether `Skill` being ungated by `--allowedTools` is intended.** It is the observed
  behaviour of the installed version on this machine, nothing more. Do not assume it
  holds across versions — which is itself an argument for the guard fallthrough
  remaining the control rather than the allowlist.

## Recommendation

Split #392. The skills half and the MCP half are not the same task and no longer
belong in one issue.

**Skills — do it, and it is small.** Dispatch `Skill` to `classifySkill` in
`guard.ts` as a name-keyed branch, never via `NO_PATH_SURFACE`. Leave
`CLAUDE_READ_ONLY_TOOLS` alone. Add a test asserting an unclassified tool name still
denies, so the fallthrough cannot be refactored away. The `~/.claude` floor
interaction needs an explicit decision: today a personal skill's *files* are
permanently unreadable while its *body* would be readable through `Skill`, and those
two should not disagree.

**MCP — do not start.** The wiring is not the blocker; the allowlist syntax forces
per-server enumeration, which this project has already rejected twice on the record.
That is a decision for #394, not work for #392.

## Related

- #392 — the issue this corrects
- #394 — the labelling-model amendment; the `mcp__*` conflict belongs there
- #391 — observe mode, which allows all three of these on a Codex line
- #372 — the model being completed
