# Lessons from Composio

**Date:** 2026-07-31
**Type:** Technical reference
**Sources:** [composiohq/composio](https://github.com/composiohq/composio) (29.5k stars,
MIT) and [ComposioHQ/composio-plugin-cc](https://github.com/ComposioHQ/composio-plugin-cc),
both read directly — the plugin was also inspected as installed under
`~/.claude/plugins/`.
**Companion:** [claude-code-enforcement-surfaces](./2026-07-31-claude-code-enforcement-surfaces.md)

Composio ships a Claude Code plugin whose entire implementation is roughly 100 lines of
bash. **The transferable material is its test suite**, which encodes design judgment as
invariants. We are a TDD codebase; this is the closest available model for the plugin we
would ship.

---

## 1. The gap this surfaced: `agentcall search`

Composio has 1,000+ tools and loads **none** of them into context. Two commands:

```
composio search "<task>"   →   composio execute <TOOL>
```

They name context bloat — loading every tool definition upfront — as the first thing
naive implementations get wrong.

**Our equivalent problem is unsolved.** `agentcall card <address>` shows one person's
task menu, and `contacts.ts` shortens addresses you already know. Both assume **the
caller knows who to ask.**

That does not survive a 500-person company. And it is precisely the pain the demand
research identified:

> Managers' #2 challenge: "people with the knowledge spend too much time answering
> questions." The asker's half of that is *not knowing who knows.*

Finding who knows is Glean's entire business. The shape of the answer is Composio's
meta-tool pattern:

```
agentcall search "why did we choose this auth migration"
  → tanaka (task: architecture-history), yamada (task: ask)
agentcall ask tanaka "..."
```

**This is a design gap no earlier doc in this folder identified.** Directory and
discovery are a separate problem from calling, and we have only built calling.

---

## 2. Replace `snippet.ts` with a SessionStart hook

Today `snippet.ts` appends usage text to the user's `~/.claude/CLAUDE.md`. Composio
never touches user files — a SessionStart hook injects the same guidance each session.

| | CLAUDE.md append | SessionStart hook |
|---|---|---|
| Staleness | Old text persists after upgrade | Versioned with the plugin |
| User's files | **Mutated** | Untouched |
| Content | Static | **State-dependent** |
| Uninstall | Manual edit | Removing the plugin removes it |

The old security model listed `~/.claude/CLAUDE.md` as an executable configuration
surface worth protecting. Writing to it ourselves is avoidable.

The state-dependence is the interesting half. Composio varies its injected line by auth
state — not installed / not logged in / signed in. Ours could carry:

- "3 questions from colleagues are waiting for your agent"
- "Your agent is offline — the relay is unreachable"

**That delivers notifications without building a notification channel.**

---

## 3. Proactive routing, and the discipline it requires

Composio's `UserPromptSubmit` hook: SessionStart warms a cache in the background;
UserPromptSubmit reads only that cache, makes **no network call on the hot path**, and
stays completely silent when nothing matches.

Ours would be: user types a question → hook matches against a cached colleague index →
injects "Tanaka's agent publishes this area."

**Nobody has to be trained.** Given that 82% of enterprise AI initiatives stall in pilot
and ~30% die from employee resistance, a product requiring no new habit avoids both.

But this only works with false-positive discipline, which their tests enforce:

```python
def test_bare_action_verb_is_silent(self, tmp_path):
    for prompt in (
        "connect to the local postgres database",
        "the issue is on line 42",
        "post the results to the console",
        "write an email validation regex",
    ):
        assert out.strip() == "", f"bare verb must be silent, but fired on: {prompt!r}"
```

Every one of those would false-positive on a naive matcher — `issue` (GitHub vs. a bug),
`post` (HTTP vs. publish), `email` (Gmail vs. a regex). Their script says why:

> No generic verbs (they collide with coding vocabulary and over-fire), no static
> fallback, no aliases.

**Ours faces the identical problem.** If "auth", "deploy", or "migration" suggests a
colleague every time, it gets muted within days. **Write the over-firing tests first.**

---

## 4. Test patterns worth stealing

### Fake binary on PATH — we already do this

```python
def _fake_composio(self, tmp_path, exit_code, stdout="", stderr=""):
    bindir = tmp_path / "bin"
    script = bindir / "composio"
    script.write_text(f"#!/usr/bin/env bash\n...\nexit {exit_code}\n")
    script.chmod(0o755)
    return f"{bindir}:{os.environ.get('PATH', '')}"
```

The hook runs as a real subprocess, JSON on stdin, JSON asserted on stdout. This is the
same technique `packages/cli/test/runner.test.ts` already uses for the fake agent
binary, so it transfers without new infrastructure.

### Prove the mechanism, not just the behaviour

```python
def test_reads_the_cache(self, tmp_path):
    token = "zzzcustomtoolkit"
    out = self._run(tmp_path, f"please use {token} for this", cache=f"{token}\n")
    self._ctx(out)
```

An invented token proves matching happens against cache *contents* rather than a
hardcoded list. Our analogue: a fictitious colleague name must route, proving the
suggestion is directory-derived.

### Parametrised auth-state parsing — fixes a known weakness of ours

Nine cases: old human-readable output, empty, whitespace-only, "Not logged in" on
stderr, `{"authenticated": false}`, `{"authenticated": true}`, an older JSON shape,
non-zero exit, non-zero exit *with* output. The shell carries the reason inline:

```sh
# CLI 0.2.31 exits 0 with empty output when logged out.
```

**This is the shape `doctor.ts` needs.** We have the same class of problem recorded —
sandboxed `claude` auth failures surface as JSON on **stdout, not stderr**. Parsing
another CLI's auth state across versions is exactly what this parametrisation is for.

### Treat injected context as a contract

```python
assert "composio search" in low
assert "no api key" not in low, "must not say 'no API keys'"
assert "\n" not in ctx.strip(), f"nudge must be one line: {ctx!r}"
```

Required phrases, **forbidden** phrases, and a one-line limit — token discipline
enforced by test rather than by intention.

### Manifest compliance

```python
def test_plugin_entry_has_no_version_key():
    assert "version" not in entry   # "guards against the dual-version regression"

def test_exactly_session_start_and_user_prompt_submit():
    assert set(self.hooks.keys()) == {"SessionStart", "UserPromptSubmit"}

def test_commands_use_plugin_root_and_exist():
    assert "${CLAUDE_PLUGIN_ROOT}" in cmd
    assert script.exists()
    assert mode & stat.S_IXUSR          # executable bit

def test_session_start_is_bounded():
    assert hook["timeout"] == 8
```

Two are worth copying verbatim in spirit. **The dual-version test** is a bug they hit,
fixed, and pinned. **The exact-hook-set test** is a scope guard: no hook can be added
without deliberately editing the assertion — which is what we want for hooks that carry
security meaning.

---

## 5. The one thing not to copy: fail-open

Composio's hooks use `set -u` and **always `exit 0`**. Cold cache, missing `jq`, offline
CLI — all resolve to silence. Correct for a convenience hook.

**Our `PreToolUse` must invert this.** GitHub Copilot CLI has a documented bug where
`preToolUse` hooks silently fail open under parallel tool calls — the timeout expires,
the CLI stops waiting, and **the tool executes anyway**
([issue #2893](https://github.com/github/copilot-cli/issues/2893)). Claude Code's `if`
matcher is likewise documented as best-effort: if the parser cannot evaluate a Bash
command, the hook runs anyway.

| Condition | Composio (convenience) | agentcall (security) |
|---|---|---|
| Cache missing | silent, allow | **deny** |
| Parse failure | silent, allow | **deny** |
| Timeout | allow | **deny** |
| What to test | that it does not over-fire | **that failure always denies** |

Their `test_cold_cache_is_always_silent` becomes our
`test_cold_cache_always_denies`.

---

## 6. Plugin distribution — the concrete layout

```
.claude-plugin/marketplace.json      # marketplace: name, owner, plugins[].source
plugins/<name>/
  .claude-plugin/plugin.json         # the single source of the version
  hooks/hooks.json                   # event → matcher → command + timeout
  hooks/*.sh                         # must be executable
  commands/*.md                      # slash commands: frontmatter + $ARGUMENTS
tests/unit/                          # manifest, hooks, commands, compliance
```

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|resume|clear|compact",
      "hooks": [{ "type": "command",
                  "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh\"",
                  "timeout": 8 }]
    }]
  }
}
```

Install is `/plugin marketplace add <org>/<repo>` then `/plugin install <p>@<market>`.

Slash commands are markdown with frontmatter (`description`, `argument-hint`) and
`$ARGUMENTS` — **the same shape as our task cards**, so `/agentcall-ask <person>
<question>` costs one file.

Their README also notes a decision worth borrowing: *"Because capabilities ship in the
CLI, `composio upgrade` keeps them current — no plugin update needed."* The plugin stays
thin; capability lives in the CLI. Our plugin should likewise carry hooks and commands
only, with policy logic staying in `agentcall`.

---

## 7. What does not transfer

Composio faces the same platform-absorption risk we do, and their defence is **breadth**
— 1,000+ integrations as a moat of surface area. We cannot copy that; ours is depth
(per-caller policy, audit, no data ingestion).

One thing does transfer: `@composio/core` **ships source deliberately so agents can
inspect it**. When trust is the product, being readable is part of the product. What
runs on the callee's machine should be legible to the caller.

---

## Actions this implies

| Area | Change |
|---|---|
| **New** | `agentcall search` — resolve *who* to ask. The largest gap found. |
| `snippet.ts` | Replace with a SessionStart hook; stop writing to the user's CLAUDE.md |
| **New** | UserPromptSubmit routing suggestion — over-firing tests written first |
| `contacts.ts` | Widen from "shorten known addresses" to a local directory cache |
| `doctor.ts` | Parametrised auth-state tests over the messy real outputs |
| **New** | Plugin: `plugin.json` + `hooks.json` + `PreToolUse` (fail-closed) + `ConfigChange` + commands |
