# Claude Code enforcement surfaces — what we can use after removing the sandbox

**Date:** 2026-07-31
**Type:** Technical reference (not market research — see the other four docs for that)
**Context:** `9456b4f` removed the `sandbox-runtime` (Seatbelt) wrapper. This documents
what Claude Code itself offers to enforce policy against an untrusted inbound request,
and what it cannot.

**Verification:** managed-settings key names and `sandbox.credentials` were confirmed
directly against [code.claude.com/docs/en/settings](https://code.claude.com/docs/en/settings).
Hook schemas, precedence, and `-p` behaviour come from a documentation deep-dive dated
2026-07-29 and are marked **[unverified]** where I did not confirm them myself.

---

## The headline

Three things we would otherwise build already exist:

1. **The IT-ceiling layer** — managed settings, deployable by MDM, not overridable by
   the user. This answers the "how do IT policy and the employee's own policy compose"
   question: the platform enforces a ceiling.
2. **A central audit sink** — `allowedHttpHookUrls` lets hooks POST to an endpoint.
3. **A config-tampering guard** — the `ConfigChange` hook, which replaces protection
   the sandbox used to provide.

One thing we must build: **per-tool-call inspection via `PreToolUse`**, shipped as a
plugin.

And one thing nobody can provide: **prompt-injection immunity.** Hooks fire *after* the
model has decided. Design assuming the caller injects instructions.

---

## 1. `PreToolUse` — the layer we are missing

Fires before any tool executes. Receives JSON on stdin:

```json
{
  "session_id": "abc123",
  "cwd": "/home/user/project",
  "permission_mode": "default|acceptEdits|plan|auto|dontAsk|bypassPermissions",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash|Edit|Write|Read|Grep|Glob|WebFetch|Agent|...",
  "tool_input": { "command": "npm test" },
  "tool_use_id": "toolu_01ABC...",
  "agent_id": "subagent-123",
  "agent_type": "Explore|Plan|..."
}
```

**`agent_id` / `agent_type` are present only when the call comes from a subagent.**
Worth noting: GitHub Copilot CLI has a documented bug where subagent tool calls bypass
`preToolUse` entirely ([issue #2392](https://github.com/github/copilot-cli/issues/2392)).
Claude Code exposes the provenance instead, so a hook can decline to trust subagent
calls rather than being blind to them.

### Blocking

| Exit | Behaviour |
|---|---|
| `0` | No block; optional structured JSON on stdout |
| **`2`** | **Blocks the call.** stderr is fed back to Claude as the reason |
| other | Non-blocking error; execution continues |

Structured form (exit 0):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask|defer",
    "permissionDecisionReason": "why this was denied",
    "updatedInput": { "command": "npm run lint" },
    "additionalContext": "text injected into Claude's context"
  }
}
```

`updatedInput` **rewrites the tool arguments** — useful for forcing a read-only flag
rather than refusing outright. `defer` exists only for Agent SDK `-p` mode with a
`canUseTool` callback.

**What `PreToolUse` cannot override** [unverified]: `permissions.deny` rules at any
scope, managed deny rules, org-set connector `ask`, MCP tools with
`requiresUserInteraction`, and the `EndConversation` tool.

### Matching on arguments

`matcher` takes a tool name, alternation (`Edit|Write`), `*`, or regex (`mcp__github__.*`).
An `if` field filters on input contents using permission-rule syntax:

```json
{ "if": "Bash(rm *)" }
{ "if": "Edit(*.env)" }
{ "if": "WebFetch(domain:github.com)" }
```

**Limits that matter to us** [unverified]:

- **Fails open.** If the parser cannot evaluate a Bash command, the hook runs anyway.
  Any hook we ship must therefore decide *deny* on its own failure, not rely on the
  matcher having caught the case.
- Cannot inspect dynamic variable substitution (`$VAR`).
- Compound commands are decomposed — `Bash(rm *)` matches the `rm` inside
  `echo && rm -rf`. Command substitution (`$(...)`, backticks) is detected, and leading
  wrappers (`timeout`, `nice`, `xargs`, …) are stripped.

---

## 2. Managed settings — the IT ceiling, already built

Deployed via MDM or managed-settings file. **Not overridable by user, project, or CLI.**
Confirmed key names:

```
allowManagedHooksOnly            allowManagedPermissionRulesOnly
allowManagedMcpServersOnly       allowedHttpHookUrls
allowedMcpServers                deniedMcpServers
blockedMarketplaces              strictKnownMarketplaces
allowedChannelPlugins            claudeMd
disableAutoMode                  disableSkillShellExecution
disableRemoteControl             enforceAvailableModels
disableSideloadFlags             disableBrowserExternalNavigation
```

Directly relevant:

- **`allowManagedHooksOnly`** — only managed and force-enabled plugin hooks run. An
  employee cannot disable the answering-side guard.
- **`allowManagedPermissionRulesOnly`** — user and project permission rules are ignored.
- **`allowedHttpHookUrls`** — constrains where hooks may POST. This is the audit sink.
- **`disableSkillShellExecution`** — relevant because our tasks *are* SKILL.md files.
- **`claudeMd`** — managed CLAUDE.md content.

This resolves the open design question from the pivot doc. IT sets a ceiling; the
employee narrows within it; the platform enforces the ceiling. We do not implement it.

### Precedence [unverified]

```
1. managed deny            always wins
2. PreToolUse exit 2       blocks, but still subject to managed deny
3. managed ask             not overridable by a hook "allow"
4. managed allow
5. PreToolUse "allow"      skips the prompt; deny/ask still apply
6. CLI --allowedTools
7. project settings
8. user settings
```

---

## 3. `ConfigChange` — replaces a protection the sandbox provided

Fires on modification of settings and skills:

```json
{
  "source": "user_settings|project_settings|local_settings|policy_settings|skills",
  "file_path": "/path/to/file",
  "hook_event_name": "ConfigChange"
}
```

Exit 2 blocks the change.

**Why this matters now.** The old Seatbelt profile carved `~/.claude/CLAUDE.md`,
`hooks`, `plugins`, `commands`, and `agents` out of the write-allowlist precisely
because they are executable configuration surfaces — a hostile prompt writing to them
persists beyond the call. Removing the sandbox removed those carve-outs.
`ConfigChange` is the replacement, and it is a better fit: it is a targeted rule rather
than a filesystem carve-out.

This is also the class of bug behind **[CVE-2025-59536](https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/)**
(CVSS 8.7, fixed in 1.0.111): a `SessionStart` hook planted in a repository's
`.claude/settings.json` executed before the trust dialog. Cloning an untrusted repo was
enough.

---

## 4. Native sandbox settings

Claude Code has a native `sandbox` setting. **Confirmed:** `sandbox.credentials`, with
`files` and `envVars` entries, validated from v2.1.191. **[unverified]** but reported:
`sandbox.filesystem` (`allowRead`/`denyRead`/`allowWrite`/`denyWrite`) and
`sandbox.network` (`allowedDomains`/`deniedDomains`), implemented with Seatbelt on
macOS and bubblewrap on Linux.

```json
{
  "sandbox": {
    "credentials": {
      "files":   [{ "path": "~/.aws/credentials", "mode": "deny" }],
      "envVars": [{ "name": "GITHUB_TOKEN", "mode": "mask",
                    "injectHosts": ["api.github.com"] }]
    }
  }
}
```

**Worth investigating before treating the sandbox as permanently gone.** The stated
reason for removing `srt.ts` was 374 lines plus the toolchain-read-dir archaeology that
only existed because `denyRead:["~"]` also blocked the agent's own binary. Native
configuration has none of that cost — it is JSON, no `npx` wrapper, no PATH excavation.

**The limitation that prevents overclaiming** [unverified]: native sandboxing is
described as covering **Bash only**. Read, Edit, and WebFetch run outside it. If that
holds, `denyRead: ["~/.ssh"]` would not stop the Read tool. We cannot say "OS-level
isolation" on this basis.

---

## 5. `claude -p` specifics — two hard constraints

We spawn `claude -p`, so these bind us [unverified]:

- **`PermissionRequest` hooks do not fire in plain `-p`.** They require the Agent SDK's
  `canUseTool` callback. **Automated permission decisions must be written as
  `PreToolUse`.**
- **`ask` rules error in `-p`** — there is no user to prompt.

The second closes a door. The draft-then-approve flow discussed in
[enterprise-pivot-research](./2026-07-31-enterprise-pivot-research.md) **cannot be
built on Claude's `ask` mechanism.** It has to live in our own protocol: hold the reply,
notify the owner, deliver on approval.

---

## 6. The limit that no configuration removes

> Hooks fire *after* the model decides. They constrain the consequences of an
> injection, not the injection.

[Endor Labs](https://www.endorlabs.com/learn/when-the-guardrails-slip-the-case-for-hook-based-governance-across-agent-platforms),
stated plainly:

> **"A hook layer is not a sandbox and shouldn't be sold as one."**

Hooks also cannot intercept anything firing before the hook loader initialises, and
userspace hooks are bypassable by code already executing in the runtime.

**This is why `resolveTask()` remains the most important control we own.** It runs
before the caller's message enters any prompt, so an injected instruction cannot change
which task — and therefore which tool envelope — was selected. Everything in this
document is downstream of that.

---

## 7. Resulting defence model

| Layer | Mechanism | Status |
|---|---|---|
| 1. Caller → task | `resolveTask()`, pre-prompt | **Built** (`policy.ts:71`) |
| 2. Task → tool set | `--allowedTools` / codex `--sandbox` | **Built** |
| 3. Individual tool call | `PreToolUse` hook, shipped as a plugin | **Gap — the work** |
| 4. Config tampering | `ConfigChange` hook | **Gap — cheap** |
| 5. IT ceiling | managed settings | **Platform-provided** |
| 6. Audit trail | `allowedHttpHookUrls` → central sink | **Platform-provided** |
| 7. Credential masking | `sandbox.credentials` | **Platform-provided, unused** |

Layers 3 and 4 are ours. Layers 5–7 are configuration we ship, not code we write.

**What we can honestly claim after this:** per-caller capability scoping resolved before
the message is trusted, deterministic inspection of every tool call, an append-only
audit trail, and an IT-enforced ceiling the employee cannot disable.

**What we cannot claim:** OS-level isolation, or immunity to prompt injection.

## Prior art worth reading

- [claude-code-security-hooks](https://github.com/slavaspitsyn/claude-code-security-hooks)
  — credential-exfiltration guard, read guards, hook self-protection, canary files
- [OpenGuardrails](https://openguardrails.com/blog/guarding-a-hermes-agent-with-openguardrails/)
  — **provenance-aware**: distinguishes user-typed commands from ones synthesised out of
  tool output. That distinction is exactly ours (owner-authored vs caller-supplied)
- [Destructive Command Guard](https://github.com/Dicklesworthstone/destructive_command_guard)
  — allowlist blocking, JSON on stdin, binary decision

## Other agents

Claude Code, Codex CLI (experimental, v0.114), GitHub Copilot CLI, and OpenCode all
have pre-tool hooks that can deny. Gemini CLI was shut down 2026-06-18 and replaced by
Antigravity CLI. Our Claude + Codex support is therefore preservable at the hook layer,
though Codex's is newer and less proven.
