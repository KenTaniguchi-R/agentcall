# A read floor for Codex answering agents — delegating to Codex's own `deny_read`

**Date:** 2026-08-01
**Status:** **Design, still gated.** Round 1 of verification ran on 2026-08-01 — see
[Verification round 1](#verification-round-1--2026-08-01). P3 passes; P1 is partial (every
indirect route closed, the direct test needs root); P2 and P4 are unchanged and **both
design-collapsing preconditions remain open**. Do not implement past the verification
phase. Two findings outside the preconditions already change the deliverable — see
[Findings outside the preconditions](#findings-outside-the-preconditions--2026-08-01).
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

## Verification round 1 — 2026-08-01

Ran against codex-cli **0.146.0** on darwin 25.5.0 / arm64. Binary
`~/.codex/packages/standalone/current/bin/codex` → `0.146.0-aarch64-apple-darwin`,
sha256 `ae1d3ffe…83da02`.

**Two of five preconditions moved. Neither design-collapsing one closed.** The round also
turned up a shipped bug unrelated to the floor, and one interaction that changes the
deliverable.

| # | Precondition | Before | After |
|---|---|---|---|
| P1 | User config cannot weaken requirements | `open` | **`partial`** — every *indirect* route closed; the direct test needs root |
| P2 | `deny_read` covers every local-read surface | `open` | `open` — and now has a second named suspect |
| P3 | The schema is real and stable | `open` | **`pass`** |
| P4 | Enforcement verified per platform | `open` | `open` — macOS mechanism identified, the floor itself not verified |
| P5 | Version qualification | `open` | `open` — a design rule, not an experiment |

### P3 — passes, and the design was too pessimistic about it

The design called the schema "recovered from binary strings, not documentation," to be
confirmed "before shipping a fragment users install as root." It is in public first-party
source:

- `RawFilesystemRequirementsToml` — binary confirms "struct … with 6 elements":
  `deny_read`, `description`, `extends`, `workspace_roots`, `filesystem`, `network`.
- `FilesystemPermissionsToml { glob_scan_max_depth, entries }` —
  `codex-rs/config/src/permissions_toml.rs`.
- `FileSystemAccessMode { Read, Write, Deny }`, `none` a legacy alias for `deny` —
  `codex-rs/protocol/src/permissions.rs`.
- Resolution: default **Deny** on no match; directory rules inherit to descendants via
  `path.starts_with`; most specific path wins, ties broken `deny > write > read`.
- First-party docs: <https://developers.openai.com/codex/security>.

One rule lands in the design's favour. It worried that `DENIED_BASENAMES` ("anywhere on
disk") "needs recursive glob semantics" that might not exist. They do, and **`deny` is the
only access mode that accepts a glob path** — read/write require an exact path or a
trailing `/**`. The translation concern was real and resolves the easy way.

`glob_scan_max_depth` is a real field, so "glob scan depth may truncate discovery" stands
and must be set explicitly rather than left at its default.

### P1 — every indirect route closed; the direct one still needs root

Closed without root:

- **No environment variable relocates or disables requirements.** A full sweep of
  `CODEX_[A-Z0-9_]+` over the binary returns 14 names, none concerning requirements.
  `CODEX_HOME` moves user config and auth only; the requirements paths are absolute.
- **`-c permissions.filesystem.deny_read=[…]` is accepted and silently ignored.** Two
  runs: exit 0, no error, no warning — and the sentinel was still read
  (`succeeded in 0ms: SENTINEL-CANARY-…`). This **confirms the design's central premise**:
  `deny_read` cannot be injected per-spawn, so agentcall can only require-and-verify.
  It also proves why `configured` must never imply `enforced` — the silent-accept path is
  exactly how a `doctor` that "sets" the floor would report success and enforce nothing.
- Ceiling semantics are stated by the implementation, not merely implied. Strongest
  string: *"has decision 'allow', which is **not permitted in requirements.toml**: Codex
  merges these rules with other config and uses the **most restrictive result**."* Plus
  `configured value is disallowed by requirements; falling back to required value` and
  `… is managed by requirements and cannot be changed`.

**Still unproven, and still design-collapsing:** whether an *installed* requirement can be
weakened by `--sandbox danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`,
a planted `CODEX_HOME`, or a **nested codex** launched from inside a sandboxed shell —
the case argv ownership does not cover. None can be tested without first installing
`/etc/codex/requirements.toml`, which is root-owned and machine-wide.

A ready-to-run script covering all four cases plus a baseline is committed at
[`scripts/verify-codex-deny-read.sh`](../../../scripts/verify-codex-deny-read.sh). It
backs up and restores any existing requirements file and exits non-zero naming the case
that bypassed the floor. Run it as `sudo -v && bash scripts/verify-codex-deny-read.sh`.

It is committed rather than left as spike scratch because P5 requires re-qualifying
`deny_read` behaviour on **every Codex version bump** — this is a recurring check, not a
one-off. Read it before running: step 1 writes a machine-wide file that constrains every
Codex invocation on the box.

**Deliberately not run.** Installing a machine-wide file that constrains every Codex
invocation on the owner's laptop — including their own interactive sessions — is not a
change to make unattended.

### P2 — no progress on the question, and a second suspect

Established: **the sandbox is real and binds to shell commands.** Under
`--sandbox read-only`, `touch` outside the workspace returns `Operation not permitted`;
under the same policy, `cat` of a file outside the workspace **succeeds** — confirming
"confines writes, not reads."

Mechanism correction: there is **no `sandbox-exec` wrapper process**. The shell command is
a direct child of `codex exec` with Seatbelt applied in-process. So "is it wrapped by
`sandbox-exec`" is not a usable test for whether a given surface is sandboxed — which
matters, because it is the obvious way one would try to answer P2.

New: under `--ignore-user-config` the spawn starts a sibling helper,
**`codex-code-mode-host`**, as a direct child of `codex exec`, on every run — including
runs where the model never used it. Whether it honours a requirements-level `deny_read` is
unknown, and it is the same shape as the objection that killed the first draft: a bundled,
non-shell surface that reaches the filesystem. P2 now has two named suspects
(`codex_apps` tools and `codex-code-mode-host`), and closing it needs an installed floor,
so it is blocked behind P1's root step.

### P4 — mechanism identified, floor not verified

macOS enforcement is Seatbelt applied in-process, not `sandbox-exec`. The Windows resolver
`windows-sandbox-rs/src/deny_read_resolver.rs` is confirmed present. No Linux or Windows
machine was available, and **no platform has had `deny_read` itself verified** — only the
read-only sandbox. The instruction to claim "designed to be cross-platform" rather than
"cross-platform" stands unchanged.

---

## Verification round 2 — 2026-08-01, with root

`scripts/verify-codex-deny-read.sh` run by Ryusei against the same binary
(`0.146.0-aarch64-apple-darwin`, sha256 `ae1d3ffe…83da02`). **7 denied / 0 bypassed.**

| Case | Result |
|---|---|
| **Baseline** — floor holds with no interference | denied |
| `-c permissions.filesystem.deny_read=[]` | denied |
| `-c permissions.filesystem.entries."<dir>"="read"` | denied |
| `--sandbox danger-full-access` | denied |
| `--dangerously-bypass-approvals-and-sandbox` | denied |
| `CODEX_HOME=<user-writable>` + planted `config.toml` | denied |
| **Nested codex** launched from inside a sandboxed shell | denied |

### P1 — passes

Ceiling semantics are now a tested property, not an inference from binary strings. The
two "dangerous" escape hatches do not touch requirements, a user-writable `CODEX_HOME`
cannot relocate the floor, and — the case argv ownership does **not** cover — a second
`codex` launched by the model from inside the sandboxed shell is denied just the same, so
requirements are re-read per process rather than inherited from the parent's sandbox.

**Residual gap, small but real:** the design also asked to "confirm malformed requirements
stop startup rather than being ignored." That was not tested. A requirements file that
fails to parse and is silently skipped would be a fail-open path with the same shape as
everything else found today. Worth one more case in the script.

### P4 — upgraded to partial, and this is the round's quiet win

The **baseline denial is the first direct evidence that `deny_read` enforces at all.**
Everything before this was linked symbols and documentation. macOS/arm64 is now verified
for the shell read surface, which is the platform the design is being built on.

Linux and Windows remain unverified, so the standing instruction holds: claim
**"verified on macOS, designed to be cross-platform"** — never "cross-platform".

### P5 — one qualified version

0.146.0 is now a *qualified* version, and the script makes re-qualification a repeatable
20-minute check rather than a research project. The `doctor` requirement is unchanged:
fail closed on any version not on the qualified list.

### What this does and does not unblock

P1 was the precondition whose failure collapsed the design. It held, so **the mechanism is
sound and the design survives.** Implementation is still gated, because **P2 is now the
sole remaining fatal precondition** — and it cannot be tested by the script above, since
its two suspects (`codex_apps` tools, `codex-code-mode-host`) do not read through the
shell. Closing it needs a floor installed *and* a way to make each suspect attempt a read.

Ordering consequence: P2 is now the critical path for C.2, and it needs its own experiment
design rather than another pass of this script.

## Findings outside the preconditions — 2026-08-01

### The Codex guard was registered but never ran — now fixed

Found by running the real spawn rather than reading it, and it invalidates a claim this
document rests on.

Codex gates hook execution on **persisted trust** (`HookStateToml` carries a
`trusted_hash`). A hook supplied inline via `-c` has never been trusted, so Codex skipped
it — no warning on stdout or stderr, no change to the exit code. Controlled A/B on the
exact `buildSpawnSpec` output, each arm having really executed a shell command: **zero**
`tools.log` lines with `--dangerously-bypass-hook-trust` absent (twice), **one** line with
it present.

So §4 above — "the hook stays in observe mode. Already shipped. It remains attempt
telemetry" — described telemetry that did not exist. There was no Codex-side `tools.log`
data at all.

**Attempted with `--dangerously-bypass-hook-trust`, then reverted (`1779ae5`). The bug
stands, unfixed.**

The safety case for the bypass was that `--ignore-user-config` leaves agentcall's inline
hook as the only hook Codex can see. Adversarial review by Codex falsified it, and the
mechanism reproduced on the first try: **Codex replaces the ignored `config.toml` with an
*empty user layer* rather than dropping the layer, and discovers `hooks.json` per-layer
independently of `config.toml`.** A `hooks.json` planted in a controlled `$CODEX_HOME`
executed under the bypass. Hook commands run *outside* the tool sandbox, so this is
host-level execution.

Two things about how that was found are worth keeping:

- **The project-hook test was run twice — once invalidly, once properly — and neither run
  could have caught this.** The first planted a hook in a scratch directory, which is
  untrusted, so it was skipped regardless and the test had no power. The second used a
  genuinely trusted workspace and produced a clean control/treatment split (control,
  without `--ignore-user-config`: planted hook **ran**; treatment, with it: did **not**).
  That result is still true. It is simply about the *project* layer, and the failure was
  in the *user* layer — a question not asked.
- **The remaining case cannot be tested on this machine and matters most where this design
  is aimed.** A workspace trusted via a **system or MDM layer** keeps its project hooks,
  and `--ignore-user-config` does not drop those layers. `/etc/codex` is exactly what
  enterprise IT installs, so caller-plants-`.codex/hooks.json` is live precisely in the
  target deployment.

**Open decision, deliberately not made unattended.** The narrower fix is to trust only our
own hook by supplying `hooks.state.<id>.trusted_hash` inline — SHA-256 over the normalized
hook identity (event name, matcher group, normalized command handler). It fails closed on
mismatch and grants nothing to user, project or plugin hooks, but couples agentcall to an
undocumented hashing scheme and a synthetic source path that may move between versions.
Getting it subtly wrong fails open in exactly the place the change was meant to protect.
`bypass_hook_trust=true` is not an alternative — it is the same blanket bypass.

Note for whoever picks this up: a test asserting argv shape will pass while foreign hooks
execute. Any fix here needs a behavioural test.

### `allow_managed_hooks_only` would silently disable that same guard

`requirements.toml` accepts a top-level `allow_managed_hooks_only = true`, which makes
Codex **ignore user, project, and session hook configs** while still honouring hooks from
the requirements and managed-config layers. Supported *only* in `requirements.toml`.

agentcall registers its guard inline via `-c` — a session hook config. **So the very
artifact this design tells an administrator to install can silently switch off agentcall's
own guard**, and with it all Codex-side telemetry. Nothing errors.

This changes the deliverable. `agentcall codex-requirements` cannot emit a `deny_read`
fragment alone; it must also emit the guard hook into the managed-hooks section
(`ManagedHooksRequirementsToml` carries `managed_dir` plus the standard `PreToolUse`
events), or assert `allow_managed_hooks_only` is unset and have `doctor` fail when it is
not.

### Three admin files, not two

The binary references `/etc/codex/config.toml`, `/etc/codex/requirements.toml`, **and
`/etc/codex/managed_config.toml`**, plus `cloud_requirements`, `cloud_managed_config`,
`legacy_managed_config_file` and `legacy_managed_config_mdm`. Requirements can therefore
arrive from a **cloud bundle** or **MDM**, not only the local file.

`doctor`'s `configured` check was specified as "parse the root-owned file," which can be
wrong in both directions — a floor may be in force via MDM with no local file present.
The app-server exposes `configRequirements/read`, documented as *"Fetches loaded
requirements constraints from requirements.toml and/or MDM"*, which is the correct source
for `effective`.

### `--ignore-user-config` still reads `$CODEX_HOME` for auth

Help text: *"Do not load `$CODEX_HOME/config.toml`; **auth still uses `CODEX_HOME`**."*
The spawn reads `~/.codex/auth.json`. The design flagged that `~/.codex` "needs a surgical
carve-out"; this pins it — `auth.json` must stay readable or the answering agent cannot
authenticate, while being exactly the credential the Claude-side guard denies. The Codex
floor cannot be a straight translation of the Claude denylist, and the entry that matters
most is the one that must be excluded.

### `doctor` may pin a shim rather than the real binary

`which codex` on this machine returns a **1489-byte bash script** in a temp
`cmux-cli-shims` directory that re-execs a wrapper. `resolveAgentBin` happened to resolve
the real binary, but both are reachable through `PATH`, and the listener runs under
launchd's own fixed `PATH`. The provenance check ("the exact binary `buildSpawnSpec`
resolves, its version and digest") must resolve symlinks and reject a script/non-Mach-O
target, or it will happily pin a shim.

Separately: the real binary lives under `~/.codex/packages/`, **mode 755, owned by the
user**. A Codex answering agent holding `exec` can overwrite its own binary for the *next*
call. `deny_read` denies reads, not writes.

### Open question — not answered, not blocking

`--ignore-rules` ("do not load user or project execpolicy `.rules` files") reveals an
**execpolicy** layer this design never mentions. Not a P1 bypass, but a separate Codex-side
policy surface, and whether agentcall should pin it is undecided. Recorded so it is not
rediscovered.

## Sources

- codex-cli 0.146.0 on this machine — binary strings, `--help`, live `codex exec` runs,
  and process-tree inspection, 2026-08-01.
- `openai/codex` source via context7 (`/openai/codex`) — `permissions_toml.rs`,
  `protocol/src/permissions.rs`, `config/src/loader/mod.rs`, `config/src/hook_config.rs`,
  `docs/config.md`, `app-server/README.md`, 2026-08-01.
- Adversarial review by Codex (two rounds), which killed the shell-verb allowlist,
  supplied the `deny_read` lead, and raised precondition 2.
- [cotal-enterprise-installability](../../research/2026-08-01-cotal-enterprise-installability.md) §C.1, §C.2, §A.3.
