# What Codex CLI can actually enforce — costing option 4 of #391

**Date:** 2026-08-06
**Status:** Research note, not a decision. Opened by
[#391](https://github.com/KenTaniguchi-R/agentcall/issues/391) ("A Codex line enforces
none of the sensitivity model — should it be callable?"), specifically its **option 4**,
"make the Codex guard enforce", which the issue records as uncosted.
**Applies to:** `codex-cli 0.146.0` — the version installed on this machine
(`codex --version` → `codex-cli 0.146.0`) and the version `packages/cli/src/runner.ts`
pins for threading and guard trust. Source read at tag `rust-v0.146.0`
(`be44975`, released 2026-07-29). Releases visible on 2026-08-06: `rust-v0.146.1`
(2026-08-05) and `rust-v0.147.0-alpha.13` (2026-08-06) — the alpha channel moves daily,
so **every finding here is version-scoped and must be re-run on a bump.**

**Evidence key.** Each claim is marked: **[doc]** first-party documentation,
**[src]** read in `openai/codex` at the tag above, **[probe]** executed against the
installed 0.146.0 binary on darwin 25.5.0 / arm64 during this research,
**[repo]** established previously in this repository and not re-verified here.
Reproduction commands for every **[probe]** are in the last section.

---

## TL;DR — four findings, in order of how much they change the decision

1. **The load-bearing claim behind observe mode is still true, and I found the exact
   line.** A hook whose trust hash does not match is dropped from the handler list with
   **no warning, no exit-code change, and no stderr** — while still appearing in
   `hooks/list` as an entry. `codex-rs/hooks/src/engine/discovery.rs:566-587`. **[src]**
   Separately, `PreToolUse` failure is fail-**open** by construction: a timeout, a spawn
   error, or any non-zero exit other than `2` sets `should_block = false` and the tool
   runs (`events/pre_tool_use.rs:279-292`). **[src]**

2. **But blocking works when the hook is trusted.** An inline session-flag `PreToolUse`
   hook exiting `2`, trusted via the same hash construction `runner.ts` already builds,
   **blocked a real shell call under `codex exec`**: `Command blocked by PreToolUse hook`.
   **[probe]** So "the hook cannot enforce" is false at 0.146.0. What remains true is
   that it cannot enforce *the sensitivity model*, because the payload it inspects is a
   shell command string — the objection already settled in
   [the read-floor design](../superpowers/specs/2026-08-01-codex-read-floor-design.md).
   **Option 4, as written in #391, buys reliable enforcement of a decision the guard
   cannot make.**

3. **The finding that actually matters: Codex has per-spawn, kernel-enforced read
   confinement, and AgentCall is not using it.** A named permissions profile supplied
   with `-c permissions.<name>.filesystem` and selected with `-c default_permissions`
   denied a read at the OS level on the `codex exec` path — including through a symlink
   planted in a permitted directory (`Operation not permitted`, exit 1). No root, no
   `/etc/codex/requirements.toml`, no MDM. **[probe]**

4. **And AgentCall's current spawn silently disables it.** Passing `--sandbox read-only`
   — which `buildSpawnSpec` does on the fresh-spawn branch (`runner.ts:363`) — makes the
   profile inert: the same denied read returned `SENTINEL-SECRET`, exit 0. The config
   form `-c sandbox_mode="read-only"` (which the *resume* branch already uses,
   `runner.ts:336`) does **not** clobber it. **[probe]** One flag change is the
   difference between a profile that enforces and one that is decoration.

---

## 1. What hook surface Codex exposes

### Events and schema

**[doc]** <https://learn.chatgpt.com/docs/hooks> (fetched 2026-08-06; the old
`developers.openai.com/codex/hooks` 308-redirects there, and `codex-rs/config.md` in the
repo is now a stub pointing at the same site). Events:

> During turns: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`,
> `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`. Session/subagent starts:
> `SessionStart`, `SubagentStart`. Session end: `SessionEnd` (main thread only).

**[src]** `HookEventName` in `codex-rs/hooks/src/engine/dispatcher.rs:159-173` carries
exactly that set. Config shape, per the docs:

```toml
[[hooks.PreToolUse]]
matcher = "^Bash$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = '/usr/bin/python3 "hook.py"'
timeout = 30
```

`type = "prompt"` and `type = "agent"` parse but are **not implemented** — discovery
pushes a warning `prompt hooks are not supported yet` and skips them
(`discovery.rs:590-597`). **[src]** Only `command` handlers exist.

### Is there a `PreToolUse` that can deny? Yes.

**[doc]** `PreToolUse` blocks via `{"hookSpecificOutput": {"permissionDecision": "deny"}}`
or exit code `2` with the reason on stderr. **[src]** confirmed in
`events/pre_tool_use.rs:262-270`: exit `2` with non-empty stderr sets
`should_block = true`; the dispatcher then returns `PreToolUseHookResult::Blocked` and
`codex-rs/core/src/tools/registry.rs:527-537` turns it into a `FunctionCallError` before
the handler runs. `PostToolUse` can also block, but only the *result* — the comment at
`registry.rs:646` is explicit: "A PostToolUse block rejects the result, not the
already-completed tool execution."

### Where hooks are discovered, including the layer AgentCall uses

**[src]** `discovery.rs:681-695` enumerates every config layer that can carry hooks:

| `ConfigLayerSource` | `HookSource` | `is_managed` |
|---|---|---|
| `System` | `System` | **true** |
| `Mdm` | `Mdm` | **true** |
| `EnterpriseManaged` | `CloudManagedConfig` | **true** |
| `LegacyManagedConfigTomlFromFile` / `FromMdm` | `LegacyManagedConfigFile` / `Mdm` | **true** |
| `User` | `User` | false |
| `Project` | `Project` | false |
| **`SessionFlags`** | **`SessionFlags`** | **false** |

`SessionFlags` is the `-c hooks.PreToolUse=[...]` layer `runner.ts:156-166` writes. It is
a first-class, source-recognised layer — not a hack — but it is **non-managed**, which is
what puts it behind the trust gate below. Managed hooks additionally come from
`requirements.toml` via `[hooks]` with `managed_dir` / `windows_managed_dir` / `hooks`
(`codex-rs/config/src/requirements_layers/hooks.rs`). **[src]**

### Stability

**[doc]** The hooks docs are published as ordinary product documentation with no
stability annotation, and `features list` reports `hooks  stable  true` **[probe]**.
There is no versioned schema guarantee anywhere I found. The trust-hash *normalization*
that `runner.ts:193-199` reproduces is an internal detail with no documented contract —
it is the thing most likely to move under a release, and its failure mode is silent
(§2).

---

## 2. When is a hook silently skipped? — the load-bearing claim

This is the stated reason for observe mode. **It holds at 0.146.0.** Four distinct
mechanisms, all verified:

### 2.1 Untrusted or modified → dropped silently **[src]**

`discovery.rs:566-587`, the exact gate:

```rust
if enabled
    && (source.bypass_hook_trust
        || matches!(
            trust_status,
            HookTrustStatus::Managed | HookTrustStatus::Trusted
        ))
{
    handlers.push(ConfiguredHandler { … });
}
*display_order += 1;
```

There is no `else`, and no `warnings.push` on that path. `hook_trust_status` returns
`Modified` when a `trusted_hash` exists but differs and `Untrusted` when none exists
(`discovery.rs:655-669`). So a normalization change on Codex's side moves the entry from
`Trusted` to `Modified`, the handler vanishes from dispatch, and the run proceeds with no
diagnostic. This is precisely the failure `runner.ts:172-178` anticipates ("A CLI-side
normalization change makes the hash mismatch and fails closed (the hook is skipped)") —
correct, but note that *skipped* is fail-closed for the hook and fail-**open** for the
tool call.

`allow_managed_hooks_only = true` in `requirements.toml` is the administrative form of
the same thing: `policy.allows()` returns false for every non-managed source and the hook
is filtered before it is ever hashed (`discovery.rs:57-63, 117`). **[src]** This is
already named in `verify.ts`'s `CODEX_GUARD_HINT`.

### 2.2 Hook failure is fail-open **[src]**

`events/pre_tool_use.rs`, `parse_completed`. Every path other than a clean exit-0 deny or
an exit-2 with stderr leaves `should_block = false`:

- `run_result.error` set (spawn failure, stdin write failure, **timeout**) → `Failed`,
  not blocked (`:207-215`).
- exit code other than 0 or 2 → `Failed`, not blocked (`:279-285`).
- no exit code at all (killed by signal) → `Failed`, not blocked (`:286-292`).
- exit 2 with *empty* stderr → `Failed`, not blocked (`:272-277`).
- stdin serialization failure → `serialization_failure_outcome`, `should_block: false`
  (`:313-320`).

`command_runner.rs:139-149` produces the timeout as `error: Some("hook timed out after
{n}s")`, which lands in the first bullet. The docs' phrasing — "If a command times out or
exits with an error, Codex reports it as a hook failure" — is accurate but does not say
what a failure *does*; the source says it allows the call. `GUARD_TIMEOUT_S = 30` in
`runner.ts:104` already documents this correctly for the Claude side; it is identical
here.

### 2.3 Tool calls that do not fire `PreToolUse` at all **[src]**

`registry.rs:517` gates the hook on `tool.pre_tool_use_payload(&invocation)` returning
`Some`. The default implementation returns `None` for any payload that is not
`ToolPayload::Function` (`registry.rs:107-116`), and `ToolPayload` has three variants —
`Function`, `ToolSearch`, `Custom` (`codex-rs/tools/src/tool_payload.rs:6-11`). Concrete
consequences:

- **`write_stdin` never fires `PreToolUse`**, by explicit override
  (`core/src/tools/handlers/unified_exec/write_stdin.rs:101-106`). The comment's
  rationale is that the originating `exec_command` "already ran PreToolUse as Bash" —
  which is true and is exactly the problem: a hook that permitted an interactive shell
  sees nothing of what is subsequently typed into it. `unified_exec` is `stable true` by
  default **[probe]**, so this path is live in AgentCall's spawns today.
- **The code-mode `execute` tool uses `ToolPayload::Custom`**
  (`core/src/tools/code_mode/execute_handler.rs:120-124`) and therefore emits no
  `PreToolUse` for the cell itself. Nested tool calls made *from inside* the cell do go
  back through the router (`code_mode/mod.rs:293-333` → `ToolCallRuntime`), so they are
  hooked; the un-hooked unit is the cell. This matches the note already in
  `runner.ts:20-23` ("reached its default code-mode tool path without emitting either
  lifecycle hook"). `code_mode` is `under development false`, `code_mode_host` is
  `stable true` **[probe]** — the host process exists, the tool is off by default.
- **[doc]** "Excluded: hosted tools like `WebSearch`. MCP tools don't trigger
  `PreToolUse` hooks during `write_stdin` polling operations."

### 2.4 Verdict on the claim

**The "silently skipped" concern is not obsolete — it is confirmed at source level on the
current release.** #391's premise stands. What is *new* is that the skip is now
*detectable in advance*: the predicate the dispatcher uses (`enabled && trust_status ∈
{Managed, Trusted}`) is the same pair of fields `hooks/list` reports, which is what
`checkCodexGuard` already reads (`verify.ts:259-273`). That makes §3 possible.

---

## 3. Is a fail-closed construction available?

Three layers, increasing strength. All are buildable today.

### 3.1 Registration proof (already built, under-used)

`checkCodexGuard` (`verify.ts:219-307`) runs `codex app-server` with the exact production
`-c` overrides and an empty `CODEX_HOME`, then reads `hooks/list` for the synthetic key
`/<session-flags>/config.toml:pre_tool_use:0:0` and requires `enabled === true` and
`trustStatus === "trusted"`. **[repo]** Because those are the same two fields
`discovery.rs:566` gates on, this is a genuine positive check of the registration
predicate — not a "config file exists" check. Its residual gap is that `app-server` and
`exec` are different entry points and could in principle resolve layers differently;
nothing in `discovery.rs` is entry-point-aware, but I did not prove equivalence.

**Cost: zero per call** (cacheable against binary digest + argv hash). It is currently
only wired into `doctor`, not into the listener's admission path.

### 3.2 Liveness proof — a per-session canary

A second inline hook on `SessionStart` (or `Stop`) whose command writes a nonce, supplied
per spawn via env and checked by the listener. If the nonce is absent, the hooks engine
did not run for *this* session and the reply is discarded rather than returned. This is
the "verify-then-release" shape: the read may already have happened, but nothing leaves.

**Cost: one extra ~50ms process per session** — the same order as the guard's measured
~48ms (`runner.ts:100-103`). Reliable, because `SessionStart` does not depend on the
model choosing to do anything.

### 3.3 What a canary cannot do

A canary that proves *denial* — "make a tool call that must be blocked" — is **not**
reliably constructible. Codex gives the harness no way to inject a tool call; you would
have to ask the model to make one, and the model declines. I hit this directly: with a
deny rule active, two separate prompts explicitly instructing the model to attempt the
denied read produced *refusals*, not attempts — "I can't attempt that command because the
requested path is explicitly blocked by the active filesystem policy." **[probe]** Codex
surfaces the policy to the model, which makes a denial canary observe the model's
compliance rather than the boundary. (I got the kernel denial only by planting a symlink
so the model saw a permitted path.) **Any per-call denial canary should be treated as
unbuildable until someone finds a harness-side tool-injection path.**

### 3.4 The strongest available form: managed hooks

**[src]** Hooks declared under `[hooks]` in `requirements.toml` get `is_managed: true`,
which means `HookTrustStatus::Managed` unconditionally (`discovery.rs:660-661`),
`hook_enabled` returns true regardless of state (`:671-673`), and they survive
`allow_managed_hooks_only`. A managed guard cannot be untrusted, disabled, or
hash-drifted out of existence. `verify.ts`'s hint already says "AgentCall does not yet
install a managed guard" — this is the path that closes 2.1 entirely. It costs a
root-owned, machine-wide file, i.e. the same adoption cost the read-floor design flagged:
right for enterprise/MDM, a `sudo` step for a solo user.

---

## 4. Capability table — what Codex offers that we are and are not using

| Control | Offered? | Exact flag / config | What it actually restricts | Used by AgentCall today |
|---|---|---|---|---|
| Pre-tool interception that can deny | **Yes** | `hooks.PreToolUse` (`-c`, `~/.codex/hooks.json`, `<repo>/.codex/`, requirements `[hooks]`) | Blocks `Function`-payload tool calls: shell, `apply_patch`, MCP, local function tools. Not `write_stdin`, not code-mode cells, not hosted tools | Registered, run in **observe** mode |
| Hook trust | Yes | `hooks.state.<key>.trusted_hash`; `--dangerously-bypass-hook-trust` | Untrusted/modified hooks are dropped **silently** | Hash reproduced in `runner.ts:193-207` |
| Sandbox level | Yes | `--sandbox {read-only,workspace-write,danger-full-access}` / `sandbox_mode` | Writes and command execution. **Not reads** — `read-only` is documented as "can inspect files, but can't edit files or run commands without approval" **[doc]**, and a read outside the workspace succeeds **[repo]** | `--sandbox read-only` (fresh), `-c sandbox_mode` (resume) |
| **Filesystem read confinement** | **Yes** | `-c default_permissions="<name>"` + `-c permissions.<name>.filesystem.<path>="read"\|"write"\|"deny"` | **Kernel-enforced read denial, per spawn, no root.** Denies through symlinks. `deny` is the only mode accepting globs **[repo]**; default is Deny on no match | **No** — and `--sandbox` disables it |
| Read-confinement ceiling (tamper-proof) | Yes | `/etc/codex/requirements.toml` → `permissions.filesystem.deny_read` | Same enforcement, root-owned, cannot be weakened by `-c`, `CODEX_HOME`, `danger-full-access`, or a nested codex — 7 denied / 0 bypassed **[repo]** | No (designed, gated) |
| Glob scan depth | Yes | `permissions.<name>.filesystem.glob_scan_max_depth` | Bounds glob expansion before sandbox start; leave-at-default truncates discovery | No |
| Network control | Yes | `sandbox_workspace_write.network_access`; `features.network_proxy` + `domains = { "host" = "allow"\|"deny" }` **[doc]** | Off by default; proxy allows per-domain rules, deny overrides allow, wildcards cannot match local IPs. `network_proxy` is `experimental false` **[probe]** | No (relies on default-off) |
| Approval policy | Yes | `approval_policy = "untrusted"\|"on-request"\|"never"`, `--ask-for-approval` **[doc]** | Which actions prompt. **Useless headless** — `codex exec` hard-sets `AskForApproval::Never` (`codex-rs/exec/src/lib.rs:427`) **[src]** | n/a |
| Auto-review of approvals | Yes | `approvals_reviewer = "auto_review"` **[doc]** | Routes approvals to a model reviewer that "denies critical-risk items" | No — and inert headless, per the row above |
| Per-tool allowlist (`--allowedTools` analogue) | **No** | — | `[tools]` has exactly three keys: `web_search`, `experimental_request_user_input`, `update_plan` (`config_toml.rs:632-640`) **[src]** | n/a |
| Coarse tool disabling | Yes | `--enable`/`--disable <FEATURE>` = `features.<name>` | Whole subsystems, not individual tools | `apps`, `image_generation` disabled |
| MCP server control | Yes | `mcp_servers` table; `--ignore-user-config` drops the user layer | Which MCP servers load | `--ignore-user-config` |
| Shell command policy | Yes | execpolicy `.rules` files (`prefix_rule(pattern=[…], decision="allow"\|"prompt"\|"forbidden")`, `host_executable(...)`); `--ignore-rules` to skip | Command *strings* by token prefix, with pinned absolute executable paths | No — see caveat below |
| Config-shape drift detection | Yes | `--strict-config` | Errors on unrecognised config fields | Yes |

### 4.1 The read-confinement finding, in detail

This is the part of #391's option 4 that is worth building, and it is not a hook.

**[probe]** Model-free, via `codex sandbox` (no API call involved):

```
codex sandbox -P acall -c 'permissions={acall={filesystem={"/"="read","<secret>"="deny"}}}' \
  /bin/cat <secret>/creds.txt
→ cat: …/creds.txt: Operation not permitted        (exit 1)
… same profile, /bin/cat <allowed>/ok.txt
→ SENTINEL-OK                                       (exit 0)
```

**[probe]** On the real `codex exec` path, through a symlink planted inside the permitted
directory so the model saw only an allowed path:

```
codex exec --ignore-user-config --skip-git-repo-check --cd <canary> \
  -c 'default_permissions="acall"' \
  -c 'permissions={acall={filesystem={"/"="read","<secret>"="deny"}}}' \
  "Run: cat <allowed>/notes.txt …"          # notes.txt → symlink → <secret>/creds.txt
→ exit 1, stderr: cat: …/allowed/notes.txt: Operation not permitted
```

So it enforces on `exec`, at the kernel, on the resolved path. Two operational caveats,
both found the hard way:

- **`--sandbox read-only` silently voids it.** Same canary, same profile, plus
  `--sandbox read-only` → `SENTINEL-SECRET`, exit 0. **[probe]** `-c
  sandbox_mode="read-only"` in place of the flag → `Operation not permitted`, exit 1.
  **[probe]** `codex exec` passes `sandbox_mode` as a `ConfigOverrides` field while
  leaving `default_permissions: None` (`codex-rs/exec/src/lib.rs:429-431`) **[src]**, and
  `derive_permission_profile` is documented as being for the legacy-sandbox path only —
  "Call this only after ruling out `default_permissions`"
  (`config/src/config_toml.rs:746-752`) **[src]**. The CLI flag takes the legacy branch
  and the profile is discarded. There is **no warning** on this path.
- **Allowlist-shaped profiles abort.** A profile naming only the directories that should
  be readable (`{"<allowed>"="read","/bin"="read","/usr"="read",…}`) exits **134**
  (SIGABRT) with no diagnostic on either stream. **[probe]** The denylist shape
  (`"/"="read"` plus explicit `deny` entries) works. Whatever this is, an
  undiagnosed abort is not a shape to ship on; the denylist form is also the one that
  maps onto the guard's existing `DENIED_DIRS`/`DENIED_FILES`/`DENIED_BASENAMES`.

This does not make Codex safe. It is a **credential floor for named paths** — the same
claim the Claude-side guard makes, no more (a denylist is not read isolation: secrets in
source trees, `.git` history, browser profiles and env vars stay readable). But it is a
kernel boundary rather than a log line, and it is available per spawn with no `sudo`.

### 4.2 On execpolicy

`.rules` files are real and loaded by default (`--ignore-rules` opts out), and
`decision = "forbidden"` exists. **[doc/src]** But this is command-string matching by
token prefix — the approach
[the read-floor design](../superpowers/specs/2026-08-01-codex-read-floor-design.md#two-rejected-approaches-and-why)
rejected in detail and adversarially, on the grounds that command names are not
capabilities (`sed` reads via `r`/`-f`, `git --git-dir` reaches any object database, `cat
"$TARGET"` defeats argument inspection). `host_executable(...)` pinning closes only the
`PATH`-shadowing subcase. **Nothing here changes that judgement**; execpolicy belongs in
the table for completeness, not as a candidate.

### 4.3 Surfaces AgentCall's `codexRemoteBoundary` does not cover

**[probe]** `features list` at 0.146.0 reports `browser_use`, `browser_use_external`,
`browser_use_full_cdp_access`, `computer_use`, `in_app_browser`, and `multi_agent` all
`stable true`. `runner.ts:316-321` disables `apps`, `image_generation`, and web search
only. Asked to enumerate its tools under AgentCall's exact flag set, the model listed
`functions.exec`, `functions.wait`, `functions.request_user_input`, and six
`collaboration.*` tools including `spawn_agent` **[probe, weak]** — model self-report,
not a registry dump, so treat it as a lead rather than a finding. Whether the browser and
computer-use surfaces are actually instantiated headless, and whether a spawned subagent
inherits the permissions profile, are both **unverified** and both worth a follow-up:
each would be a second egress path the clearance model does not see.

---

## 5. Precedents for degrading capability rather than the guarantee

Brief, as asked.

- **Kubernetes admission webhooks.** The canonical form of this exact problem: a policy
  hook the API server calls before admitting a request. **[doc]**
  <https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/>
  — "If the webhook call times out, the request is handled according to the webhook's
  `failurePolicy`." The policy is an explicit, per-webhook choice between `Ignore` and
  `Fail` rather than an implicit default, which is the design lesson: the fail direction
  is configuration, declared by whoever owns the guarantee. (I could not retrieve the
  documented default from the fetched page — see below.)
- **Codex itself degrades to the safe value.** When a configured default sandbox policy
  is disallowed by requirements, `derive_permission_profile` logs "default sandbox policy
  is disallowed by requirements; falling back to required default" and returns
  `PermissionProfile::read_only()` (`config/src/config_toml.rs:813-822`) **[src]**. And
  requirements-layer hook-directory merging is commented "conflicting values for the
  active platform fail closed" (`requirements_layers/hooks.rs:1-5`) **[src]**. The
  runtime we are trying to constrain applies the principle internally.
- **AgentCall already does this once.** `codexThreadingEnabled` returns false on every
  version but the one probed, with the reason stated in place: "a CLI upgrade changes the
  security boundary and must be re-probed before resumed sessions are trusted again"
  (`runner.ts:11-15`). **[repo]** Whatever is decided for #391 should reuse that shape
  rather than invent a second one.

---

## 6. Verdict on option 4, and on #391's recommendation

**Is fail-closed enforcement buildable today? Yes — but option 4 as worded targets the
wrong layer, and building it as worded would produce a boundary that is reliable and
empty.**

Splitting it:

- **4a — "make the PreToolUse hook enforce, fail closed."** Mechanically available.
  Blocking works **[probe]**; the skip is silent but pre-detectable via `hooks/list`
  (§3.1) and eliminable via managed hooks (§3.4). **Cost:** low — a listener-side
  admission check reusing `checkCodexGuard`, plus optionally a `SessionStart` nonce
  (~50ms/session). **Value: near zero, and worth stating plainly.** Codex reaches the
  filesystem through a shell command string; `guard.ts`'s `Bash` branch already records
  rather than blocks, on the stated grounds that string matching is "too weak to be a
  boundary and too eager to be harmless" **[repo]**. Flipping `AGENTCALL_GUARD_MODE` to
  `enforce` on a Codex line would deny nothing it does not deny today, while *sounding*
  like enforcement — which is the same defect #390 just fixed in the docs, relocated into
  the runtime. **Do not do 4a alone.**
- **4b — "use the permissions profile as the read floor, and refuse to serve without
  it."** This is the option nobody costed, and it is the one that works. Concretely:
  translate the guard's denylists into `-c permissions.<line>.filesystem`, select it with
  `-c default_permissions`, **replace `--sandbox read-only` with `-c
  sandbox_mode="read-only"`** on the fresh-spawn branch, and gate the listener on a
  behavioural canary — `codex sandbox` with the composed profile against a sentinel, one
  denied path and one permitted path, cached against binary digest + profile hash +
  platform, exactly the `configured`/`effective`/**`enforced`** distinction the read-floor
  design already specifies. **Cost:** the canary is model-free and cacheable, so ~0 per
  call and one bounded probe per binary/profile change. The real costs are (i)
  re-qualification on every Codex bump, which is already the policy for threading, and
  (ii) the risk that a mis-shaped profile aborts the spawn (the SIGABRT above), which the
  canary catches by construction.

**Does this change the recommendation in #391 ("option 3 now, option 4 as the real
fix")?** Partly, in two ways:

1. **Option 3 (force `public` on a Codex line) is still the right immediate move**, and
   this research strengthens rather than weakens it: nothing here is shippable this week,
   and until 4b exists the honest ceiling on a Codex line is `public`. Keep it.
2. **"Option 4 as the real fix" should be re-scoped from the hook to the filesystem
   profile.** As currently worded — "make the Codex guard enforce… `doctor` already probes
   for the exact hook, so the signal exists" — it points at 4a, whose probe is indeed
   nearly free and whose enforcement value is nil. The sentence to change is the framing,
   not the priority.

There is also a **third thing worth doing regardless of the decision**, at near-zero cost
and independent of the sensitivity model: `--sandbox read-only` → `-c
sandbox_mode="read-only"` on the fresh-spawn branch, so the two branches compose
identically and a future profile is not silently discarded. Today that flag choice is
inert; the moment 4b lands it is the difference between enforcing and not.

---

## 7. What I could not verify

Stated plainly, because these are the gaps that would change the above.

- **Whether `app-server`'s `hooks/list` resolves layers identically to `codex exec`.**
  Nothing in `discovery.rs` is entry-point-aware, but I did not prove equivalence, and
  `codex sandbox`'s `--include-managed-config` flag is standing evidence that entry
  points *can* differ in config resolution. §3.1's guarantee rests on this.
- **The documented default of Kubernetes' `failurePolicy`.** The fetched page truncated
  the section; I have the timeout sentence verbatim and nothing more. Do not cite a
  default from this note.
- **Whether a `SessionStart` canary hook's synthetic trust key follows the same
  `<source>:<event_snake>:<index>:<order>` shape** as the `pre_tool_use` key. I inferred
  it from `crate::hook_key(...)` at `discovery.rs:541` and from AgentCall's working
  `pre_tool_use`/`post_tool_use` keys; I did not build and run one.
- **Why an allowlist-shaped permissions profile aborts with SIGABRT.** Reproducible, no
  diagnostic on stdout or stderr, not investigated further.
- **Whether a spawned subagent (`collaboration.spawn_agent`) inherits the permissions
  profile and the hook registration.** `PreToolUse` carries `agent_id`/`agent_type` and
  `SubagentStart`/`SubagentStop` exist, which suggests subagent tool calls are hooked, but
  I did not run one.
- **Whether `browser_use` / `computer_use` / `in_app_browser` are actually instantiated
  under headless `codex exec --ignore-user-config`.** Only the model's self-reported tool
  list, which is weak evidence.
- **Whether `$CODEX_HOME/hooks.json` still loads under `--ignore-user-config`.**
  `verify.ts:99-105` asserts it does; I did not re-verify it here.
- **Anything about Linux or Windows.** Every probe was darwin 25.5.0 / arm64. The
  standing instruction from the read-floor work applies unchanged: claim "verified on
  macOS, designed to be cross-platform", never "cross-platform".
- **Anything about 0.146.1 or the 0.147 alphas.** All probes ran against 0.146.0.

---

## 8. Reproducing the probes

All of these ran on 2026-08-06 against `codex-cli 0.146.0`, darwin 25.5.0 / arm64, in a
scratch directory with `allowed/ok.txt` = `SENTINEL-OK`, `secret/creds.txt` =
`SENTINEL-SECRET`, and `allowed/notes.txt` a symlink to `secret/creds.txt`. Never use a
real credential path. `$S` is the canary root.

```bash
# 4.1 — model-free read denial (no API call)
codex sandbox -P acall \
  -c "permissions={acall={filesystem={\"/\"=\"read\",\"$S/secret\"=\"deny\"}}}" \
  /bin/cat "$S/secret/creds.txt"        # → Operation not permitted, exit 1
  # …and /bin/cat "$S/allowed/ok.txt"   # → SENTINEL-OK, exit 0

# 4.1 — enforcement on the exec path, via symlink (one model call)
codex exec --ignore-user-config --skip-git-repo-check --cd "$S" \
  -c 'default_permissions="acall"' \
  -c "permissions={acall={filesystem={\"/\"=\"read\",\"$S/secret\"=\"deny\"}}}" \
  "Run: cat $S/allowed/notes.txt   Report its exact stdout, exit code, and stderr verbatim."

# 4.1 — the --sandbox regression: add `--sandbox read-only` to the above → SENTINEL-SECRET, exit 0
#        replace it with `-c sandbox_mode="read-only"` → Operation not permitted, exit 1

# 1/2 — a trusted session-flag PreToolUse hook really blocks
#        hook script: reads stdin, writes a reason to stderr, exit 2
#        trust hash: sha256 over the canonicalized identity, exactly as runner.ts:193 builds it
codex exec --ignore-user-config --skip-git-repo-check --sandbox read-only --cd "$S" \
  -c 'hooks.PreToolUse=[{hooks=[{type="command",command="…/blockhook.sh",timeout=30}]}]' \
  -c 'hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:…"}}' \
  "Run: cat $S/allowed/ok.txt and report exactly what happened."
# → "hook: PreToolUse Blocked" / "Command blocked by PreToolUse hook: denied by canary hook."
```
