# A read floor for Codex answering agents — delegating to Codex's own `deny_read`

**Date:** 2026-08-01
**Status:** **Design, gated.** The mechanism is identified and the constraints are
verified, but five preconditions below are unproven. Do not implement past the
verification phase until they pass — several would invalidate the design.
**Closes:** [cotal-enterprise-installability](../../research/2026-08-01-cotal-enterprise-installability.md)
§C.2 ("Codex read-guard parity"), which this document argues is misnamed.
**Depends on:** the observe-mode guard and `--ignore-user-config` shipped the same
day (see CHANGELOG *Unreleased*), which this design assumes are already in place.

---

## TL;DR

A Codex answering agent has no read floor. It cannot get one from the PreToolUse
hook, because Codex reaches the filesystem entirely through `Bash` and command-string
inspection is not a boundary. It can get one from Codex's **own** `deny_read`, which
is kernel-enforced and cross-platform — but that lives in a root-owned,
machine-wide requirements file, so agentcall can only *require and verify* it, never
*set* it per call.

The deliverable is therefore not a guard. It is a **verified precondition**: `doctor`
proves the floor is enforced by testing it, and the listener refuses Codex calls when
it is not.

## Why C.2 is misnamed

C.2 reads "A Codex answering agent has no read guard at all. 'Depends which agent the
employee happens to use' does not survive review." True, but it implies the fix is to
wire the existing guard across. It is not, for three reasons established on
2026-08-01 against codex-cli 0.146.0:

1. **Codex has no structured file tools.** Asked to read a file it emits
   `{"tool_name":"Bash","tool_input":{"command":"sed -n '1,200p' note.txt"}}`. The
   guard's enforcement lives in its `EXACT_TARGET` / `SCANNING_ROOT` / `SELECTOR_KEY`
   branches, which a Codex spawn never reaches.
2. **The `Bash` branch allows by design.** `guard.ts` already records rather than
   blocks there, on the stated grounds that string matching is "too weak to be a
   boundary and too eager to be harmless." That judgement does not change because a
   different runtime is calling.
3. **Codex's `--sandbox read-only` does not confine reads.** Verified directly:
   `ls ~/.ssh` under it succeeds. It confines writes.

So for Codex, *100% of the tool surface is the `exec` gap that C.1 describes*. C.2
cannot be closed before C.1, and closing it "for Codex" means solving C.1's problem
in its hardest form.

### Two rejected approaches, and why

**Parse `Bash` commands and extract file arguments.** Aims at the right invariant and
fails on execution. A correct implementation must model parameter expansion, command
substitution, backticks, globbing, brace expansion, redirections, process
substitution, pipelines, subshells, environment assignments, quoting, shell functions,
aliases, and `PATH` resolution — and then, per allowed binary, a version-pinned
semantic model of every path-bearing flag.

**Allowlist safe shell verbs.** Worse, because it invites a safety claim it cannot
support. Command names are not capabilities: `sed` reads files via `r` and `-f`, `awk`
has `getline` and `system()`, `git --git-dir=X cat-file` reaches any object database
(plus `--textconv` execution), `rg --pre` executes, `find -exec` and `xargs` are
launchers, and `cat "$TARGET"` defeats argument inspection before any exotic case.
An attacker can also place a binary named `sed` earlier on `PATH`. Reducing this to a
sound design means no shell evaluation, one parsed argv, a pinned absolute
executable, and a tiny per-binary flag grammar — at which point it is a capability
broker, not an allowlist, and Codex can barely function.

Both were reviewed adversarially and dropped. The conclusion that survived: *a remote
adversary plus an unrestricted shell plus the employee's real credentials cannot be
turned into a defensible boundary by recognizing the word `sed`.*

## The mechanism

Codex 0.146.0 ships its own read-denial facility. Verified from the binary:

- `deny_read` is a field of `RawFilesystemRequirementsToml`, alongside
  `workspace_roots`, `extends`, `network`, `prefix_rules`.
- It is **requirements-level only**. The binary carries the string:
  `` `permissions.filesystem` is reserved for requirements-level filesystem
  constraints and cannot define a profile ``. So it cannot be set by a permission
  profile, and — the operative consequence — **cannot be injected per-spawn via
  `-c`**.
- Discovery path: `/etc/codex/requirements.toml` (alongside `/etc/codex/config.toml`).
  Root-owned, machine-wide.
- Requirements have **ceiling semantics**: the binary carries
  `configured value is disallowed by requirements; falling back to required value`
  and `is managed by requirements and cannot be changed`.
- Enforcement is at the kernel and appears cross-platform: Seatbelt on macOS,
  `landlock` + `seccomp` symbols for Linux, and `windows-sandbox-rs/src/deny_read_resolver.rs`.

This is strictly better than anything agentcall could build. It mediates the `open`,
so it does not care whether the reader is `cat`, `git`, a Perl one-liner, a symlink,
an unknown binary, or an indirect config flag — the entire shell-parsing arms race
becomes irrelevant. It is maintained by OpenAI, and it cannot break Codex's own
startup because Codex knows which parts of `~/.codex` it needs.

### What it costs

agentcall cannot set it. A root-owned machine-wide file is not a per-call knob. This
inverts the shipping model for the Codex path: from "the CLI enforces this" to "the
CLI requires and proves this."

For the enterprise pivot that is arguably the right shape — IT manages it via MDM,
it is tamper-resistant against the very agent it constrains, and it is one artifact
for the whole fleet. For a solo user it is a `sudo` step, which is a real adoption
cost and the main argument against this design.

## Design

### 1. Ship the fragment

A `requirements.toml` fragment translating the guard's `DENIED_DIRS`,
`DENIED_FILES`, and `DENIED_BASENAMES` into `permissions.filesystem.deny_read`,
emitted by a new `agentcall codex-requirements` command that prints to stdout for the
admin to install. agentcall never writes `/etc` itself.

Translation is **not** mechanical, and the spec must not pretend otherwise:

- `DENIED_BASENAMES` means "anywhere on disk" and needs recursive glob semantics.
- The `.env.example` / `.sample` / `.template` exclusions must survive translation, or
  the floor becomes the false-positive failure the guard was written to avoid.
- Glob scan depth may truncate discovery.
- Files created *after* sandbox initialization may be missed if globs expand eagerly.
- Hard links can expose the same inode under a permitted name.
- `~/.codex` needs a surgical carve-out: Codex requires parts of it to start, so a
  blanket denial is not available. This is the one entry where the Claude-side list
  cannot be copied across.

### 2. `doctor` proves it, rather than reading it

Three distinct statuses, never conflated:

| Status | Means | Established by |
|---|---|---|
| `configured` | the root-owned file contains the expected entries | parsing |
| `effective` | Codex reports them in its merged policy | Codex's own config report |
| `enforced` | reads are actually denied | behavioural canary |

Only `enforced` counts. Parsing proves intent, not enforcement.

**Provenance checks** (all required): the exact binary `buildSpawnSpec` resolves, its
version and digest; the requirements file owned by root, not group/other-writable,
with secure parent directories, and not a symlink to a user-controlled file. On macOS
resolve `/etc` through `/private/etc` before judging.

**Behavioural canary.** Perform a real `open`/read and require an OS-level denial —
`test -r` and `stat` are insufficient, because metadata access can be permitted
independently of data reads. Cover: a denied directory descendant; a denied exact
file; a denied basename under a permitted root; a symlink from a permitted path into
a denied one; a file created after policy initialization; and one ordinary worktree
file that must remain **readable**, so the canary detects over-denial too. Use fixed
sentinel content, never a real credential. A pass requires the failure to be
specifically a sandbox denial, not `ENOENT` and not an unrelated crash.

The canary must run through the **same** composition as the real spawn — same binary,
env, cwd, sandbox mode, and managed-config inclusion. `codex sandbox` is not
automatically equivalent to `codex exec`; its `--include-managed-config` flag is
itself evidence that resolution differs between entry points.

Cache the `enforced` result against binary identity, requirements content hash and
metadata, platform, and relevant env. Any change re-runs the canary.

### 3. The listener refuses

Absent `enforced`, `agentcall listen` rejects inbound calls routed to the Codex
runtime, with a message naming the missing precondition. This is the enforced form of
"classify Codex as lacking the floor" — documenting it, as the README does today, is
not equivalent.

### 4. The hook stays in observe mode

Already shipped. It remains attempt telemetry and is not upgraded to enforcement by
this design: PreToolUse reports intent, one shell call can contain many reads, and the
kernel may deny after the hook has already logged the attempt.

## Preconditions — all unproven, all blocking

Ordered by how badly failure damages the design.

1. **User config cannot weaken requirements.** If any of `config.toml`, `-c`, a
   profile, `CODEX_PERMISSION_PROFILE`, `CODEX_HOME`, `--sandbox danger-full-access`,
   `--dangerously-bypass-approvals-and-sandbox`, or a nested Codex launched from
   inside a sandboxed shell can drop `deny_read`, **the design collapses entirely.**
   Static strings suggest ceiling semantics; that is not a security claim. Test each
   adversarially, and confirm malformed requirements stop startup rather than being
   ignored. Note the listener owns the argv, so a remote prompt cannot add flags
   directly — but the nested-process case is not covered by that.
2. **`deny_read` covers every local-read surface, not just shell.** This is the
   objection that killed the first draft. `--ignore-user-config` removes the owner's
   MCP servers, but Codex's own bundled `codex_apps` tools survive it — verified —
   and those include outward-facing actions (`sites_deploy_site_version`,
   `plugin_management_uninstall_app`). Establish whether they are inside the sandbox.
   If any tool reads files outside it, `deny_read` is not a floor and this design
   fails for the same reason the hook does.
3. **The schema is real and stable.** It was recovered from binary strings, not
   documentation. Confirm against Codex source or first-party enterprise docs before
   shipping a fragment users install as root.
4. **Enforcement is verified per platform.** Linked symbols prove linkage, not
   behaviour. The binary also warns that some Windows sandbox modes cannot enforce
   deny-read directly. Until tested per OS and per sandbox mode, claim "designed to be
   cross-platform," not "cross-platform."
5. **Version qualification.** `deny_read` behaviour is unqualified across Codex
   versions. `doctor` must fail closed on an unqualified version rather than assume
   forward compatibility.

## What this does not solve

A credential-path denylist, even kernel-enforced, is not read isolation. Secrets in
source trees, browser profiles, `.git` history, arbitrary config directories, and
environment variables remain readable. The honest claim is a **credential floor for
the paths named**, which is the same claim the Claude-side guard makes — no more.

## Alternative considered: agentcall writes its own Seatbelt profile

A permissive profile with targeted `(deny file-read* (subpath …))` around the Codex
spawn. Rejected as the primary mechanism: same kernel enforcement, but macOS-only
against an explicit non-macOS deal blocker (§A.3), maintained by us, and at risk of
breaking Codex's startup because we would be guessing which parts of `~/.codex` it
needs. Worth revisiting only if precondition 1 or 3 fails.

Note this is **not** the layer removed on 2026-07-31. That was deny-by-default reads
plus workspace confinement plus a network allowlist, removed because it prevented the
answering agent from having the owner's real context. A narrow read-denylist over a
permissive default does not, so "we removed the sandbox" is not an argument against
it. It is an argument against *that* sandbox.

## Sources

- codex-cli 0.146.0 on this machine — binary strings, `--help`, and live
  `codex exec` runs, 2026-08-01.
- Adversarial review by Codex (two rounds), which killed the shell-verb allowlist,
  supplied the `deny_read` lead, and raised precondition 2.
- [cotal-enterprise-installability](../../research/2026-08-01-cotal-enterprise-installability.md) §C.1, §C.2, §A.3.
