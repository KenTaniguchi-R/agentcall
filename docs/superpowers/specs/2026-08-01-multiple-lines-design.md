# Multiple lines — one person, several addresses

**Date:** 2026-08-01
**Status:** **Design, pending approval.** Nothing built yet.
**Issue:** [#44](https://github.com/KenTaniguchi-R/agentcall/issues/44)
**Supersedes:** [#43](https://github.com/KenTaniguchi-R/agentcall/issues/43) — see "Interactions".
**Reviewed:** adversarially by Codex against the current tree. Every file reference
below was verified, not asserted. The first draft's central architectural claim was
false and is corrected here (see "One process, N sockets"); four citations were wrong
and are fixed.

## The problem

One laptop hosts exactly one agentcall identity. People increasingly run several
agents side by side — Claude, Codex, Hermes — and there is no way to give them
separate addresses on the same machine.

The relay does not impose this. `/v1/register` binds a handle to a token hash and
nothing else (`apps/relay/src/index.ts:35-52`): no device identity, no owner, no
per-owner cap. Nothing in `apps/relay` or `packages/shared` assumes one handle per
machine — every assumption is client-side:

- `Config` is one flat record — one `handle`, one `token`, one `agent_kind`
  (`packages/cli/src/config.ts:5-18`) — at one fixed path,
  `~/.agentcall/config.json` (`packages/cli/src/paths.ts:11-24`).
- The LaunchAgent label is a module constant, `tech.benree.agentcall.listener`
  (`packages/cli/src/launchd.ts:7`), and `installLaunchAgent` boots out whatever
  holds it (`launchd.ts:76`).
- The listener opens one WS with one handle/token pair (`listener.ts:45-46`).

### Why a separate address per agent, rather than one address that routes

The cheaper design is one identity whose listener picks among several local agents.
Rejected on a product ground:

> **The address is the sharing unit.** The owner decides who gets which address, and
> that decision is the disclosure control. Handing the frontend team `ken-codex` and
> your manager `ken` is a boundary drawn by *distribution*, with no policy file to
> edit.

One address means one audience, so a routing design cannot express that. The
mechanism has to be real, separately-registered handles.

Aliases cannot fake it either: `HANDLE_DO.idFromName(handle)`
(`apps/relay/src/index.ts:98,174`) gives one Durable Object per handle, and
`apps/relay/src/do.ts:56` closes any existing listener socket when a new one
attaches. A handle's DO holds at most one listener. **N addresses therefore require
N registrations and N sockets.**

### One process, N sockets

They do **not** require N supervised processes. The first draft of this design
claimed they did — that N LaunchAgents were "a cost to build well, not a choice to
weigh" — and that was false. The relay has no concept of a local process. One Node
process can open N WebSockets, authenticate each with a different handle/token, and
give each its own queue, backoff state, policy, workdir, and agent kind.
`startListener` already takes every piece of state as an injected dependency and
returns `{stop()}` (`listener.ts:15-22`), so N lines in one process is a loop.

The three candidate architectures, compared properly:

| | Meets the product requirement? | Cost |
|---|---|---|
| One identity, local agent routing | **No** — one address, one audience | Smallest |
| N identities, N sockets, **one process** | Yes | One plist, one supervised service, one loop |
| N identities, N sockets, N processes | Yes | N plists, N labels, N `launchctl` operations, N resident processes |

**Chosen: one process.** N processes buy only crash isolation, and the listener
already contains per-call failures (`listener.ts:122-136`). Single-process removes
per-line `launchctl` management, the enumerate-and-reconcile uninstall problem, line
names becoming launchd label suffixes, and N resident Node processes.

It also dissolves the constraint recorded in #44 that a second identity must be
foreground-only. That constraint exists because `plistContent` sets `HOME=${p.home}`
(`launchd.ts:56`) and `p.home` is also `AGENTCALL_HOME` when redirected — so a
service installed under an alternate `AGENTCALL_HOME` spawns the agent with `HOME`
pointing at the agentcall data directory, hiding the home-relative configuration
`claude` needs. With one process serving every line, `HOME` is never redirected in
production and the workaround disappears rather than being fixed.

## Decisions

| Question | Decision |
|---|---|
| What is the new primitive? | A **line** — one registered handle, one agent, one socket. A machine has one *person* and N lines. |
| Process model | **One supervised listener process** holding N sockets. |
| Inbound vs outbound | **N addresses inbound, one identity outbound** — *per relay*. See below. |
| Who names the address? | The **owner**, freely. Line name (local) and handle (global) are separate names and may differ. |
| Migration | **None.** No users; the old layout is deleted, not migrated. |
| Shared across lines | Contacts and the CLAUDE.md/AGENTS.md snippet. Everything callee-side is per-line. |
| Is an unshared address a security boundary? | **No.** It selects *which policy applies*; policy enforces. |

### Outbound identity is per-relay

Fragmenting outbound has no upside and two costs: a colleague who granted access to
`ken` would not recognise `ken-codex` calling, so every caller would grant the same
person N times; and their audit log would show one human as N actors. So outgoing
calls use one identity.

But "one identity" can only mean *one identity per relay*. `callAgent` builds its
WebSocket URL from `opts.relay` and passes only the target handle
(`callClient.ts:36`), so a single relay URL serves both authentication and
destination. A line on relay B cannot be called out from a primary line on relay A.
The first draft asserted both single-primary outbound and free per-line tenancy;
they are in direct conflict.

Resolution — outbound line selection:

1. Resolve the destination address to a relay host.
2. Candidate lines = those whose `relay` host matches.
3. Exactly one candidate → use it.
4. Several → use `person.primary_line` if it is among them; otherwise refuse and
   name the candidates.
5. None → refuse with the relays this machine actually holds lines on.

In the common case (all lines on one relay) this is always the primary, and nothing
is visible to the user. `--as <line>` exists as an explicit override; it is a
tie-breaker, not a concept anyone needs day to day.

### Two names, not one

`HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/` (`packages/shared/src/protocol.ts:3`) —
lengths 2–31 — first-come-first-served, minus twelve reserved words
(`protocol.ts:11-14`). Nothing derives a handle from anything.

- **Line name** — local only. The directory, the `--line` flag, the `line list`
  label. Defaults to the agent kind when free.
- **Handle** — the global address handed out. Prompted for, since it can 409.

They routinely differ: short handles go fast, so an owner may register `ryusei-cdx`
while calling the line `codex` locally.

**Line name validation:** `/^[a-z0-9][a-z0-9-]{0,31}$/`, rejected case-insensitively
against existing names. A line name becomes a directory component and an authored
content path, so the regex is the traversal defence, applied at `line add` before
anything touches disk.

### An unshared address is a soft boundary

Guessability is part of the control, and it is weak. Anyone holding `ken@host` will
try `ken-codex@host`, and while presence requires authentication precisely to stop
anonymous enumeration (`apps/relay/src/index.ts:54-62` explains the oracle it used
to be), an *authenticated* caller still learns existence from 404-vs-200.

So: **the line selects which policy applies; the policy does the enforcing.** Each
line's `policy.json` must be restrictive on its own terms, never permissive on the
theory that only the intended audience knows the address. This matches #26, which
keeps reachability open in-company and places the entire gate on disclosure.

`line add` warns when the requested handle is a predictable derivative of one already
owned (`<existing>-<suffix>`).

## Rejected, with the reason

- **One identity, an agent roster** (`config.agents`, listener picks per task).
  Cheapest, but cannot express audience-by-distribution.
- **Aliases: N addresses on one socket.** Impossible without relay surgery
  (`apps/relay/src/do.ts:56`).
- **N supervised processes.** See the table above — meets the requirement, costs
  more, buys only crash isolation.
- **Deriving handles from a base handle** (`ken` → `ken-codex`). Makes every line
  enumerable from any one of them.
- **Promoting `AGENTCALL_HOME` to the user-facing mechanism.** It relocates the
  plist's `HOME` too (`launchd.ts:56`). It stays a test seam.
- **Migrating the flat layout to a `default` line.** No users; the code would run
  zero times.

## Architecture

### On-disk layout

```
~/.agentcall/                        # person-scoped
  person.json                        # { primary_line }
  contacts.json                      # shared address book
  listener.log                       # one process, one log
  lines/
    claude/
      config.json                    # handle, token, relay, agent_kind?, workdir?
      policy.json
      card.pushed.json
      calls.log                      # inbound audit + guard tool events
      tools.log
    codex/
      ...
  removed/                           # archived lines, see `line remove`

~/AgentCall/                         # owner-authored, deliberately visible
  claude/{tasks,public}/
  codex/{tasks,public}/
```

`listener.log` is person-scoped because there is one process. `calls.log` stays
per-line: it is the audit trail of what one address disclosed, which is exactly the
boundary the address draws. (The first draft justified this with `PIPE_BUF`
atomicity — wrong mechanism, `PIPE_BUF` governs pipes, not `O_APPEND` on regular
files, and moot under one process. The disclosure boundary is the reason.)

### The `Paths` split

`getPaths(home)` conflates three things into one string: where agentcall state
lives, where the user's real home is (the plist's `HOME`, `~/Library/LaunchAgents`,
**and the guard's security root**), and where authored content lives. The names below
avoid reusing `home` for any of them, because that reuse is what caused the
conflation.

```ts
export interface MachinePaths {
  /** Real os.homedir(). The plist's HOME and the guard's security root. */
  userHome: string;
  /** Redirectable state root (AGENTCALL_HOME). Test seam only. */
  stateRoot: string;
  dir: string;          // <stateRoot>/.agentcall
  personFile: string;
  contactsFile: string;
  linesDir: string;
  removedDir: string;
  listenerLog: string;
}

export interface LinePaths {
  machine: MachinePaths;
  name: string;
  dir: string;              // <linesDir>/<name>
  configFile: string;
  policyFile: string;
  cardSnapshotFile: string;
  callsLog: string;
  toolsLog: string;
  tasksDir: string;         // <stateRoot>/AgentCall/<name>/tasks
  shareDir: string;         // <stateRoot>/AgentCall/<name>/public
}

export function getMachinePaths(
  stateRoot: string = process.env.AGENTCALL_HOME ?? os.homedir(),
  userHome: string = os.homedir(),
): MachinePaths;

export function getLinePaths(m: MachinePaths, name: string): LinePaths;
```

`stateRoot` and `userHome` are identical in production and diverge only under test,
where both are passed explicitly.

### `LineContext`

Paths alone do not prevent identity mixing — a command that resolves `--line` once
for policy and again for credentials can pair one line's policy with another's token.
Every line-scoped command resolves exactly one context up front and threads it
through:

```ts
export interface LineContext {
  machine: MachinePaths;
  name: string;
  paths: LinePaths;
  config: LineConfig;
}
```

`resolveLine(machine, opts)` applies the precedence `--line` > `AGENTCALL_LINE` >
`person.primary_line` once, and every downstream call — card publishing, policy
verbs, rotation, the listener's socket, the agent spawn — takes the resulting
`LineContext`.

### Config shapes

```ts
// ~/.agentcall/person.json
export interface Person { primary_line: string }

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

**`agent_kind` stays optional, and caller-only stays a line.** An earlier draft made
it required, on the theory that caller-only is "a person with zero lines" — wrong,
because outbound calls authenticate with a handle's token (`index.ts:75-83` →
`callClient.ts:39`). A person with no lines has no credentials and cannot call
anyone either. Caller-only is *one agentless line*: registered, callable outward, no
listener socket, no card.

`assertCallableConfig` (`config.ts:20-28`) survives, re-scoped to a line. Note it is
not what guards the CLI today — `index.ts:134,154,245`, `doctor.ts:51-54`, and
`card.ts:25-27` are independent manual `!cfg.agent_kind` checks. All five become
`LineContext`-aware.

`AgentKind` moves to `packages/shared` as one exported type, replacing the inline
unions in `config.ts:9`, `setup.ts:24,65,175`, and `api.ts:41`. This removes
duplication only — **it does not make a third agent "a data change."** The closed
`z.enum(["claude","codex"])` at `protocol.ts:128` and `packages/shared/src/card.ts:20,31`
must widen too, and `runner.ts` needs real dispatch work. Hermes is out of scope here.

### The listener process

`agentcall listen` loads `person.json`, enumerates `linesDir`, and calls
`startListener` once per line with an agentless line skipped. Each line gets its own
socket, ping timer, backoff, and `SerialQueue` — so **N lines answer N calls
concurrently**, where today a single in-flight call returns `busy` to everyone
(`listener.ts:138-141`).

One change to `listener.ts` beyond the types: **config is re-read on each reconnect**
rather than once before `startListener`. Today a rotated token is only picked up by
restarting the process; re-reading in `connect()` lets `rotate` close just that line's
socket and have it come back with the new credential, leaving other lines untouched.

`launchd.ts` barely changes: one label, one plist, `ProgramArguments` still
`[node, cliScript, "listen"]` with no line argument. Two fixes — `HOME` becomes
`machine.userHome`, and the plist path derives from `userHome` rather than the state
root.

### The guard

Two things the first draft missed outright.

**The guard's security root is `paths.home`.** `guard.ts:302` passes it to `decide()`
as the home whose `.ssh`, `.claude`, `.codex`, shell startup files, and LaunchAgents
are denied. Handing it the redirectable state root would protect the test directory
and leave the real one open. `runGuard` takes `userHome` explicitly for denial, and
separately takes `machine.dir` — so a compromised agent on one line cannot read
*another* line's token, which is a new attack surface this design creates.

(For the record: the guard does **not** write `~/.claude/settings.json`. `runner.ts:33`
passes `--settings guardSettingsJson()` inline per spawn, and Codex gets `-c`. The
owner's `~/.claude` and `~/.codex` are untouched.)

**The guard subprocess does not know which line it serves.** `guard-entry.ts:20`
calls `getPaths()` independently, and the runner injects only `AGENTCALL_CALL_ID`
(plus guard mode for Codex). Without a change, per-line `calls.log` silently breaks —
guard events land in whatever `getPaths()` resolves to. The runner must inject
`AGENTCALL_LINE` alongside `AGENTCALL_CALL_ID`, and `guard-entry` must resolve its
`LinePaths` from it, failing closed if it is absent or names no line.

### What is shared, and why

**`contacts.json` → shared.** Verified by whole-CLI search: read only by
`contacts.ts` and caller-side resolution in `index.ts`; not by `listener.ts`,
`prompt.ts`, `runner.ts`, `policy.ts`, `tasks.ts`, or `card.ts`. It is not disclosure
surface, and it is the *person's* rolodex — you did not meet a colleague three times
because you run three agents.

**`calls.log` → per-line**, as above.

**The CLAUDE.md/AGENTS.md snippet → shared.** `snippet.ts` writes machine-global
files and names no handle. One consequence to state rather than leave implicit: the
snippet tells an interactive agent to run `agentcall call` with no line selector, so
every agent following it inherits the outbound-selection rules above. Changing
`primary_line` changes the identity used by every shell and agent on the machine
immediately.

The rule this generalises to: **caller-side and person-scoped → shared; callee-side
and audience-scoped → per-line.**

## CLI surface

| Command | Scope | Behaviour |
|---|---|---|
| `agentcall setup` | person | First run only: `person.json`, the first line, marks it primary. `--caller-only` creates it agentless. Once lines exist: re-applies the snippet, prints `line list`, creates nothing. |
| `agentcall line add <name>` | new line | `--handle`, `--agent`, `--relay`, `--caller-only`, `--no-verify`. |
| `agentcall line list` | person | Name, address, relay, presence, primary. `--json`. |
| `agentcall line remove <name>` | line | Archives to `removed/`. `--purge` deletes. |
| `agentcall line primary <name>` | person | Sets the default outbound identity. |
| `agentcall listen [--line <n>]` | process | All lines by default; `--line` runs one, for debugging. |
| `agentcall call` / `status` | person | Outbound selection rules above; `--as <line>` overrides. |
| `agentcall contacts` | person | Shared address book. |
| `agentcall card` / `task` / `allow` / `revoke` / `block` / `unblock` / `offer` / `unoffer` / `rotate` | line | Via `resolveLine`. |
| `agentcall doctor` | person | Every line; see below. |
| `agentcall uninstall` | person | Removes the listener. `--purge` deletes `~/.agentcall`. |

```
$ agentcall line list
claude   ken@agentcall.benree.tech          online    primary
codex    ryusei-cdx@agentcall.benree.tech   online
hermes   ken-hermes@agentcall.benree.tech   —         caller-only
```

**`doctor`** reports per line and exits non-zero if any *callable* line fails.
Agentless lines report caller-only and are not failures. The guard probe runs once
per distinct `agent_kind`, not once per line. The relay self-call runs once per line
and is the reason `line add` should not be scripted in a tight loop: `REGISTER_RL` is
5 per 60s per IP, so adding several lines back-to-back will 429.

## Failure modes

- **Handle taken (409).** Register *before* touching disk, so a 409 leaves nothing
  behind.
- **Register succeeds, disk write fails.** Orphans an unreclaimable handle (#16).
  `config.json` is written atomically (temp + rename, `0600`) as the first action
  after a successful register; policy, tasks, card, and socket follow.
- **Partial line.** A line directory whose `config.json` is missing or fails schema
  validation is *orphaned*, not ready: skipped by the listener, reported by `doctor`,
  removable by `line remove`. `person.json` is updated only after the line validates,
  so a failed first `setup` never leaves `primary_line` dangling.
- **`person.json` missing or corrupt.** Atomic write, `0600`, zod-validated on read.
  A dangling or absent `primary_line` with exactly one line present is repaired
  silently; with several, every person-scoped command refuses and names
  `agentcall line primary`.
- **Removing a line abandons its handle permanently** — release is deliberately not
  implemented (`apps/relay/src/index.ts:66-71`, #16). `line remove` says so and
  requires confirmation. It *archives* the line to `~/.agentcall/removed/<name>-<ts>/`
  rather than deleting, so the audit trail survives; `--purge` deletes outright.
- **Two lines sharing a handle.** Refused at `line add`.
- **Primary line removed.** Refused unless another is promoted first; refused
  outright when it is the only line, since a person with zero lines can neither
  answer nor call. `uninstall --purge` is the exit.
- **A line's socket dies quietly.** `line list` and `doctor` are the surface.
- **`rotate`.** Rewrites one line's `config.json`, then closes that line's socket;
  the reconnect re-reads config and comes back on the new token. Other lines are
  untouched. The relay authenticates only at socket establishment, so the old
  credential stays live on the existing socket until it closes — closing it is the
  point, not a side effect.

## Testing

TDD per `CLAUDE.md`; each point is a failing test written first.

**`test/paths.test.ts`** — line paths derive under `linesDir`; `userHome` does not
move when `AGENTCALL_HOME` moves `stateRoot`.

**`test/launchd.test.ts`** — the plist's `HOME` is `userHome`, not the state root;
the plist path derives from `userHome`. (This is the regression that made a
supervised second identity impossible.)

**`test/line.test.ts`** — `line add` with a taken handle leaves `linesDir` unchanged;
a second line leaves the first's `config.json` byte-identical; invalid line names are
rejected before any disk write; `line remove` of the primary is refused while another
line exists and refused outright when it is the only one; removal archives rather
than deletes; an orphaned line directory is skipped, not fatal.

**`test/outbound.test.ts`** — destination on a relay with one matching line uses it;
several matching use primary; none matching refuses and names the available relays;
`--as` overrides.

**`test/listener.test.ts`** — N lines produce N independent sockets and queues in one
process; each line audits to its own `calls.log`; a reconnect re-reads `config.json`,
so a rotated token takes effect without a process restart.

**`test/guard.test.ts`** — denial is evaluated against `userHome`, not `stateRoot`;
an agent on line A cannot read line B's `config.json`; a guard subprocess with no
`AGENTCALL_LINE` fails closed.

No live agent spawn; `runner.test.ts`'s fake binary remains the seam.

## Interactions

- **#43** — closed as superseded. Its fix ("refuse when `--handle` names a different
  handle") is inverted by this design. With no users the interim protection is not
  worth code that would then be deleted.
- **#26 (channel groups)** — this registers multiple top-level handles per person, a
  variant of the per-channel-address idea #26 rejected. The subdomain objections
  (wildcard TLS, `resolveAddress` misrouting, global channel namespace) do not apply
  to distinct top-level handles, and #26's N-socket objection is answered by the
  single-process model. Lines and groups compose: a line has a policy, and that
  policy can grant against groups.
- **#16 (handle release)** — this multiplies abandoned handles and strengthens #16.
- **#14 (non-macOS callee)** — one supervised process is simpler to port than N; a
  systemd unit is a sibling of the single plist.
- **#24 (`agentcall search`)** — roster membership becomes per-line. Which lines join
  which roster is #24's question.
- **`apps/relay`** — no relay change required. Coordinate anyway per `CLAUDE.md`: the
  A2A track is changing DO addressing.

## Not in this design

- Routing a call between lines, or one line answering for another.
- Per-contact identity pinning (`--as` covers the disambiguation case).
- The merged `calls.log` reader / post-hoc digest. Per-line files keep it possible.
- Hermes as a runnable agent — `AgentKind` moves to `shared` here, the closed zod
  enums and `runner.ts` dispatch are separate work.
- The fate of `~/AgentCall/<line>/public`. The enterprise pivot points at agents
  answering from a real working directory; this design does not depend on it.
