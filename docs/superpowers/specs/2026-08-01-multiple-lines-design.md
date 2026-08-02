# Multiple lines — one person, several addresses

**Date:** 2026-08-01
**Status:** **Design, pending approval.** Nothing built yet.
**Issue:** [#44](https://github.com/KenTaniguchi-R/agentcall/issues/44)
**Supersedes:** [#43](https://github.com/KenTaniguchi-R/agentcall/issues/43) — see "What this closes".

## The problem

One laptop hosts exactly one agentcall identity. People increasingly run several
agents side by side — Claude, Codex, Hermes — and there is no way to give them
separate addresses on the same machine.

The relay does not impose this. `/v1/register` binds a handle to a token hash and
nothing else (`apps/relay/src/index.ts:35-52`): no device identity, no per-owner
cap. The ceiling is entirely client-side:

- `Config` is one flat record — one `handle`, one `token`, one `agent_kind`
  (`packages/cli/src/config.ts:5-18`) — at one fixed path,
  `~/.agentcall/config.json` (`packages/cli/src/paths.ts:11-24`).
- The LaunchAgent label is a module constant, `tech.benree.agentcall.listener`
  (`packages/cli/src/launchd.ts:7`), so a second listener cannot be bootstrapped as
  a service — `installLaunchAgent` boots the first one out.
- The listener opens one WS with one handle/token pair
  (`packages/cli/src/listener.ts:45-46`).

### Why a separate address per agent, rather than one address that routes

The obvious cheaper design is one identity whose listener picks among several local
agents. It was considered and rejected on a product ground:

> **The address is the sharing unit.** The owner decides who gets which address, and
> that decision is the disclosure control. Handing the frontend team `ken-codex` and
> your manager `ken` is a boundary you draw by *distribution*, with no policy file to
> edit.

A routing design cannot express that — one address means one audience. The
mechanism therefore has to be real, separately-registered handles.

The relay confirms this cannot be faked with aliases. `HANDLE_DO.idFromName(handle)`
(`apps/relay/src/index.ts:98,174`) gives one Durable Object per handle, and
`apps/relay/src/do.ts:56` closes any existing listener socket when a new one
attaches. **One socket per handle, enforced.** N addresses therefore means N
identities and N supervised listeners — a cost to build well, not a choice to weigh.

## Decisions

| Question | Decision |
|---|---|
| What is the new primitive? | A **line** — one address, one agent, one listener. A machine has one *person* and N lines. |
| Inbound vs outbound symmetry | **N addresses inbound, one identity outbound.** Non-primary lines are answer-only. |
| Who names the address? | The **owner**, freely. Line name (local) and handle (global) are two separate names and may differ. |
| Migration from the flat layout | **None.** No users; the old layout is deleted, not migrated. |
| What is shared across lines? | Contacts and the CLAUDE.md/AGENTS.md snippet. Everything callee-side is per-line. |
| Is an unshared address a security boundary? | **No.** It selects *which policy applies*; policy still enforces. |

### N inbound, 1 outbound

Outgoing calls always use the primary line's handle and token. Fragmenting the
outbound direction has no upside and two costs: a colleague who granted access to
`ken` would not recognise `ken-codex` calling, so every caller would have to grant
the same person N times; and their audit log would show one human as N actors.

This removes the whole question of "which identity am I calling as" — there is no
`--as` flag, no per-contact identity pinning, no ambiguity. When Ken calls, the
callee sees Ken, regardless of which of his agents he is sitting at. If an alternate
outbound identity is ever genuinely needed, `--as <line>` slots in without
disturbing anything designed here.

### Two names, not one

`HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/` (`packages/shared/src/protocol.ts:3`),
first-come-first-served, minus twelve reserved words
(`packages/shared/src/protocol.ts:11-14`). Nothing derives a handle from anything.

- **Line name** — local only, never leaves the machine. The directory name, the
  `--line` flag, the label in `agentcall line list`. Defaults to the agent kind
  (`claude`, `codex`) when free.
- **Handle** — the global address handed out. Prompted for, because registration can
  fail with a 409.

They will routinely differ: the handle namespace is global and short names go fast,
so an owner may register `ryusei-cdx` while calling the line `codex` locally.

### An unshared address is a soft boundary

If the address is the disclosure control, guessability is part of that control — and
it is weak. Anyone holding `ken@host` will try `ken-codex@host`, and
`/v1/status/:handle` answers existence to any authenticated caller (deliberately;
`apps/relay/src/index.ts:54-62` refuses handle *listing* but existence still leaks).

This does not break the design, but it bounds the claim: **the line selects which
policy applies; the policy does the enforcing.** Each line's `policy.json` must be
restrictive on its own terms, never permissive on the theory that only the intended
audience knows the address. This matches #26, which deliberately keeps reachability
open in-company and places the entire gate on disclosure.

`agentcall line add` warns when the requested handle is a predictable derivative of
one already owned (`<existing>-<suffix>`), nudging toward names that are not trivially
enumerable.

### Tenancy comes free

A line carries its own `relay`, so a work line on a customer relay and a personal
line on `agentcall.benree.tech` fall out of this design with no extra mechanism. That
was previously the argument for a separate "profiles" concept; it is now subsumed.

## Rejected, with the reason

- **One identity, an agent roster** (`config.agents: [{name, kind, workdir}]`, the
  listener picks per task). Far cheaper — one socket, one queue, one line changed in
  `listener.ts`. Rejected because it cannot express audience-by-distribution, which is
  the point of the feature.
- **Aliases: N addresses resolving to one listener socket.** Impossible without relay
  surgery — the DO is addressed by handle and holds exactly one listener
  (`apps/relay/src/do.ts:56`).
- **Deriving the handle from the base handle plus agent kind** (`ken` → `ken-codex`).
  Makes every line trivially enumerable from any one of them, defeating the model.
- **Promoting `AGENTCALL_HOME` to the user-facing mechanism.** It relocates
  *everything* including the plist's `HOME` (`packages/cli/src/launchd.ts:56`), which
  points a spawned `claude` at the agentcall data dir and breaks its credential
  lookup. It stays a test seam.
- **Migrating the existing flat layout to a `default` line.** No users; the migration
  code would be written, run zero times, and deleted.

## Architecture

### On-disk layout

```
~/.agentcall/                        # person-scoped, one per machine
  person.json                        # { primary_line: "claude" }
  contacts.json                      # shared address book
  lines/
    claude/
      config.json                    # handle, token, relay, agent_kind, workdir?
      policy.json
      card.pushed.json
      calls.log
      listener.log
      tools.log
    codex/
      ...

~/AgentCall/                         # owner-authored content, deliberately visible
  claude/
    tasks/
    public/
  codex/
    tasks/
    public/
```

Authored content stays outside the dotfile directory for the reason it does today —
an owner edits task markdown in Finder — and gains a per-line level.

### The `Paths` split

This is the load-bearing change and everything else depends on it. Today
`getPaths(home)` conflates three distinct things into one string: where agentcall
state lives, where the *user's real home* is (the plist's `HOME` and the
`~/Library/LaunchAgents` directory), and where authored content lives.

```ts
export interface MachinePaths {
  /** Redirectable root. Test seam only (AGENTCALL_HOME). */
  home: string;
  /** Always the real os.homedir(). The plist's HOME, and nothing else. */
  realHome: string;
  dir: string;          // ~/.agentcall
  personFile: string;   // ~/.agentcall/person.json
  contactsFile: string; // ~/.agentcall/contacts.json
  linesDir: string;     // ~/.agentcall/lines
}

export interface LinePaths {
  machine: MachinePaths;
  name: string;
  dir: string;              // ~/.agentcall/lines/<name>
  configFile: string;
  policyFile: string;
  cardSnapshotFile: string;
  callsLog: string;
  listenerLog: string;
  toolsLog: string;
  tasksDir: string;         // ~/AgentCall/<name>/tasks
  shareDir: string;         // ~/AgentCall/<name>/public
}

export function getMachinePaths(
  home: string = process.env.AGENTCALL_HOME ?? os.homedir(),
  realHome: string = os.homedir(),
): MachinePaths;

export function getLinePaths(m: MachinePaths, name: string): LinePaths;
```

`home` and `realHome` are identical in production and diverge only under test, where
both are passed explicitly. The plist's `HOME` reads `realHome`; every state path
reads `home`. That separation is what makes a supervised second listener possible at
all — it is the fix for the constraint recorded in #44 that a second identity must
be foreground-only.

### Config shapes

```ts
// ~/.agentcall/person.json
export interface Person {
  primary_line: string;
}

// ~/.agentcall/lines/<name>/config.json
export interface LineConfig {
  handle: string;
  token: string;
  relay: string;
  /** Absent = answer-incapable. The line can still call out. */
  agent_kind?: AgentKind;
  workdir?: string;
}
```

**`agent_kind` stays optional, and caller-only stays a line.** An earlier draft of
this design made it required on the theory that caller-only is "a person with zero
lines" — that is wrong, because outbound calls authenticate with a handle's token
(`index.ts:75-83`). A person with no lines has no credentials and cannot call anyone
either. So caller-only is *one agentless line*: registered, callable outward, with no
LaunchAgent installed and no card published. `assertCallableConfig`
(`packages/cli/src/config.ts:20-28`) and its call sites (`index.ts:134,154,245`,
`doctor.ts:49`, `card.ts:20-24`) survive, re-scoped from install to line.

`AgentKind` widens from the inline `"claude" | "codex"` union — appearing in
`config.ts:9`, `setup.ts:24,65,175`, and `api.ts:41` — to a single exported type in
`packages/shared`, so a third agent is a data change rather than a union edit in five
files. Adding Hermes still needs runner work (`runner.ts`); this only removes the
type-level obstacle.

### Per-line LaunchAgent

`launchd.ts` currently hardcodes one label (`launchd.ts:7`) and derives the plist
path from `p.home` (`launchd.ts:15`). Both become line-aware:

- Label: `tech.benree.agentcall.listener.<line>`
- `ProgramArguments`: `[node, cliScript, "listen", "--line", "<name>"]` — the line is
  passed explicitly rather than through a redirected `HOME`.
- `HOME` environment variable: `machine.realHome`.
- `StandardOutPath`/`StandardErrorPath`: that line's `listener.log`.
- Plist file: `${machine.realHome}/Library/LaunchAgents/<label>.plist`.

`isLaunchAgentInstalled` and `uninstallLaunchAgent` take a line name;
`uninstallAllLaunchAgents(machine)` enumerates `linesDir` for `agentcall uninstall`.

### Listener

Unchanged in shape. `startListener` already takes its config and paths as
dependencies (`listener.ts:15-22`), so N instances in N processes need no change
beyond `deps.config` becoming a `LineConfig` and `deps.paths` a `LinePaths`.

Each line gets its own socket, ping timer, backoff state, and `SerialQueue`. This is
the cost #26 named when it rejected per-channel addresses — accepted here because the
product requirement makes it unavoidable — and it buys one thing back: **N lines
answer N calls concurrently.** Today a single in-flight call returns `busy` to
everyone (`listener.ts:138-141`).

Resource cost is honest and worth stating: three lines means three resident node
processes under `KeepAlive`.

### What is shared, and why

**`contacts.json` → shared** at `~/.agentcall/contacts.json`. It is never read by
`prompt.ts`, `runner.ts`, or `card.ts` — nothing on the answering path touches it —
so it is not disclosure surface and sharing cannot leak across the line boundary. It
is the *person's* rolodex: you did not meet a colleague three times because you run
three agents. Per-line contacts would mean adding everyone N times.

**`calls.log` → per-line.** Two independent reasons agree. Technically, N listener
processes plus `guard.ts:318` (which writes the same file from inside the agent
process) would be 2N writers on one file; appends are only atomic below `PIPE_BUF`
(4096 bytes) and these lines carry `message.slice(0,500)` plus `error.slice(0,2000)`,
so a shared file risks torn lines in the one place corruption is least acceptable.
Product-wise the log feeds the post-hoc digest, which is a person-level view — but
that is a *reader* requirement, satisfied by merging N files at read time. No code
reads `calls.log` today, so the merged reader is new surface either way.

**The CLAUDE.md/AGENTS.md snippet → shared.** `snippet.ts` writes machine-global
files and mentions no handle.

The rule this generalises to, for anything added later: **caller-side and
person-scoped → shared; callee-side and audience-scoped → per-line.**

## CLI surface

| Command | Scope | Behaviour |
|---|---|---|
| `agentcall setup` | person | First run only: creates `person.json`, the first line, makes it primary. `--caller-only` creates it agentless. Re-run once lines exist: re-applies the person-level idempotent steps (the CLAUDE.md/AGENTS.md snippet), prints `line list`, and creates nothing — adding a line is `line add`. |
| `agentcall line add <name>` | new line | `--handle`, `--agent`, `--relay`, `--skip-launchd`, `--no-verify`, `--caller-only`. Registers, writes the line, installs its LaunchAgent, verifies. |
| `agentcall line list` | person | Line name, address, presence, which is primary. `--json`. |
| `agentcall line remove <name>` | line | Uninstalls that LaunchAgent, deletes the line directory. Refuses the primary line unless another is promoted first. |
| `agentcall line primary <name>` | person | Sets the outbound identity. |
| `agentcall listen [--line <n>]` | line | Foreground listener for one line. |
| `agentcall call` / `status` / `contacts` | person | Always the primary line's credentials. No `--line`. |
| `agentcall card` / `task` / `allow` / `revoke` / `block` / `unblock` / `offer` / `unoffer` / `rotate` | line | `--line <n>`, else `AGENTCALL_LINE`, else primary. |
| `agentcall doctor` | person | Checks every line and reports per line. |
| `agentcall uninstall` | person | Removes all listeners. `--purge` deletes `~/.agentcall`. |

Line selection precedence for line-scoped commands: `--line` > `AGENTCALL_LINE` >
`person.primary_line`. `doctor` sweeping all lines is deliberate — "is this machine
healthy" is a person-level question, and a silently dead non-primary listener is
exactly the failure this feature introduces.

```
$ agentcall line list
claude   ken@agentcall.benree.tech          online    primary
codex    ryusei-cdx@agentcall.benree.tech   online
hermes   ken-hermes@agentcall.benree.tech   offline   listener not running
```

## Failure modes

- **Handle already taken (409).** Register *before* creating any line state, so a
  409 leaves the disk untouched. No half-made line.
- **Register succeeds, disk write fails.** Orphans a handle that nobody can reclaim
  (#16). Write `config.json` as the first action after a successful register, before
  policy, tasks, card, or LaunchAgent.
- **Removing a line abandons its handle permanently.** Handle release is deliberately
  not implemented (`apps/relay/src/index.ts:66-71`, #16). `line remove` must say so
  explicitly and require confirmation — this design multiplies the number of handles
  a person can strand.
- **Two lines sharing a handle.** Refused at `line add`; each line must be a distinct
  registration.
- **Primary line removed.** Refused unless another line is promoted first; outbound
  calling depends on it. When it is the *only* line, `line remove` is refused
  outright — a person with zero lines has no credentials and can neither answer nor
  call. `agentcall uninstall --purge` is the way out of that state.
- **A non-primary listener dies quietly.** The address goes offline with no signal.
  `line list` and `doctor` are the surface that makes it visible.

## Testing

TDD per `CLAUDE.md`; every point below is a failing test written first.

**`packages/cli/test/paths.test.ts`** — line paths derive under `linesDir`;
`realHome` does *not* move when `AGENTCALL_HOME` moves `home`.

**`packages/cli/test/launchd.test.ts`** — label carries the line name; two lines
produce two distinct plist paths; `ProgramArguments` contains `--line <name>`; the
plist's `HOME` is `realHome`, not the state directory (this is the regression that
made a supervised second identity impossible).

**`packages/cli/test/line.test.ts`** — `line add` with a taken handle leaves
`linesDir` unchanged; adding a second line leaves the first line's `config.json`
byte-identical; `line remove` of the primary is refused while another line exists,
and refused outright when it is the only line; `line primary` rewrites `person.json`
only; an agentless (`--caller-only`) line installs no LaunchAgent and publishes no
card, but can still call out.

**`packages/cli/test/setup.test.ts`** — first run creates `person.json` plus one line
and marks it primary; a second `setup` is idempotent and does not touch the existing
line.

**`packages/cli/test/listener.test.ts`** — unchanged behaviour under `LinePaths`;
each line audits to its own `calls.log`.

No live agent spawn; `runner.test.ts`'s fake agent binary continues to be the seam.

## Interactions

- **#43** — closed as superseded. Its fix ("refuse when `--handle` names a different
  handle") is *inverted* by this design, where a different handle is how a line is
  added. With no users, the interim protection is not worth writing code that would
  then be deleted.
- **#26 (channel groups)** — this registers multiple top-level handles per person, a
  variant of the per-channel-address idea #26 rejected. The subdomain objections
  (wildcard TLS, `resolveAddress` misrouting, global channel namespace) do not apply
  to distinct top-level handles; the N-socket objection does, and is accepted above.
  Lines and groups are two answers to "different audiences see different menus" and
  compose cleanly — a line has a policy, and that policy can grant against groups.
- **#16 (handle release)** — this multiplies the abandoned-handle problem and
  strengthens the case for #16.
- **#14 (non-macOS callee)** — the per-line label and explicit `--line` argument are
  supervisor-agnostic; a systemd implementation inherits the same shape.
- **#24 (`agentcall search`)** — roster membership becomes per-line. Which lines join
  which roster is a question for #24 to answer, not this design.
- **`apps/relay`** — no relay change is required. Per `CLAUDE.md`, coordinate anyway:
  the A2A track is actively changing DO addressing.

## Not in this design

- Routing a call between lines, or one line answering on behalf of another.
- `--as <line>` for outbound, and per-contact identity pinning.
- The merged `calls.log` reader / post-hoc digest. Named as a follow-up; per-line
  files are chosen so it stays possible.
- Adding Hermes as a runnable agent. `AgentKind` stops being a closed union here;
  the runner work is separate.
- The fate of `~/AgentCall/<line>/public`. The enterprise pivot points at agents
  answering from a real working directory; this design does not depend on `public`
  surviving.
