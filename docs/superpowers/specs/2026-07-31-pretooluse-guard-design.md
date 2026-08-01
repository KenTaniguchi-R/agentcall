# PreToolUse guard — design

**Date:** 2026-07-31
**Status:** Design approved, plan revised. Both review gates resolved by measurement (see
findings 5 and 6), then the plan was reviewed adversarially by Codex — 17 findings, six
critical, all verified and addressed. See [Second review](#second-review--codex-2026-07-31).
`decide()` was rebuilt on canonical path resolution and its 31 tests were **executed**,
not just written. Ready to implement.
**Layer:** #3 of the defence model in
[claude-code-enforcement-surfaces §7](../../research/2026-07-31-claude-code-enforcement-surfaces.md),
the one marked "Gap — the work".
**Also draws on:** [lessons-from-composio](../../research/2026-07-31-lessons-from-composio.md)
§3–§6 — fail-closed inversion, the injected-context contract, and the plugin boundary.

---

## The hole

With the OS sandbox removed on 2026-07-31, the only thing standing between a caller
and the owner's machine is the capability envelope (`runner.ts:30-40`):

```
read:  ["Read","Grep","Glob","LS"]   ← granted on every call, never omitted
write: ["Write","Edit"]
fetch: ["WebFetch","WebSearch"]
exec:  ["Bash"]
```

`read` is unconditional — a task offering nothing but Q&A still permits
`Read ~/.ssh/id_rsa`. That is a wider hole than `exec`, because it is open on every
call rather than only on tasks the owner marked as executing.

`--allowedTools` with `--permission-mode dontAsk` already denies everything *outside*
that list: MCP tools, the Agent tool, and subagent spawns never reach a hook. So this
layer is not about breadth of coverage. It is about depth **inside** the four families
we grant.

## Scope

A **global safety floor**: one fixed guard, identical on every call, independent of
task and caller. It is not a revival of the removed `write_paths`/`network` task fields,
and it does not extend the per-caller `policy.json` vocabulary. Those remain possible
later; they are out of scope here.

## Findings that determined the design

Live experiments against `claude -p` and against the process itself, not documentation
reads. Three of the six contradicted what was assumed going in.

**1. `PreToolUse` fires under `--permission-mode dontAsk`, and exit 2 blocks.**
A hook returning exit 2 refused a `Read`, the canary string did not appear in the
result, and the stderr text was surfaced to the model as the reason. The model then
declined to route around it via `cat` or a subagent.

**2. `permissions.deny` rules suppress the hook entirely.**
With a matching deny rule the read was blocked — and the hook never ran. Deny rules do
not sit *beneath* the hook as a backstop; they sit in front of it and short-circuit it.
Any path covered by a deny rule is therefore enforced **silently**, producing no
`calls.log` entry. This is why the guard is hook-only.

**3. Deny-rule path syntax fails silently when wrong.**
`Read(/absolute/path)` did not match; the read succeeded and `permission_denials` was
`[]` — no error, no warning. A control whose misconfiguration is indistinguishable from
success is not a good floor to build on.

**4. The deny reason is relayed to the caller, in the model's own words.**
Whatever the hook returns as its reason is read by the model, and the model is the thing
composing the reply that goes back over the relay. In test 1 the exit-2 stderr text was
quoted verbatim into the answer. The reason string is therefore caller-facing output, not
an internal diagnostic, and has to be written that way.

Structured deny (`permissionDecision: "deny"` with `permissionDecisionReason`, exit 0)
produces a better rendering than exit 2 — "the read was blocked" rather than
"PreToolUse:Read hook error" — so it is the mechanism for ordinary denials.

**5. `sandbox.filesystem.denyRead` does not cover the `Read` tool.** *(Review gate 1.)*
With `{"sandbox":{"enabled":true,"filesystem":{"denyRead":["<dir>"]}}}` passed through
`--settings`, a `Read` of a file in that exact directory succeeded and the canary was
returned. The research doc's `[unverified]` note that native sandboxing is Bash-only was
**correct**, and the documentation example that appeared to contradict it does not apply
to the `Read` tool.

There is no cheaper floor. This guard is required at full scope, and the denied-path
table is the only thing protecting reads.

**6. The hot path is process startup, not `decide()`.** *(Review gate 2.)* Measured over
20 runs each:

| Path | Per call |
|---|---|
| Standalone guard-shaped script (stdin → parse → `realpath` → append → exit) | **~33 ms** |
| Same work routed through `index.ts` (commander + full import graph) | **~78 ms** |

`decide()` itself is microseconds and irrelevant to the measurement. Two consequences,
both design-level rather than optimisation: the guard gets **its own minimal entry
point** rather than going through the CLI's command dispatch, and the timeout is derived
from the measured process, not the function.

## Architecture

One catch-all `PreToolUse` hook, registered through inline `--settings` JSON at spawn
time, calling back into the `agentcall` binary.

```
listener.ts  resolveTask() → envelope, call_id
     ↓
runner.ts    buildSpawnSpec() adds:
               --settings '{"hooks":{"PreToolUse":[{"hooks":[…]}]}}'
               env AGENTCALL_CALL_ID=<call_id>
     ↓
claude -p    decides a tool call
     ↓
             hook: `<node> <agentcall> _guard`  ← every tool call, no matcher
     ↓
guard.ts     decide(input, home, realpath) → verdict
     ↓
     allow → exit 0           deny → append calls.log + generic reason, exit 0
                                     ↓
                              model continues, answers without that tool
```

Nothing is installed into `~/.claude`. The settings are a JSON string on the command
line, scoped to the one spawn, gone when the process exits. The owner's own interactive
sessions are untouched.

### Why not the plugin

[lessons-from-composio §6](../../research/2026-07-31-lessons-from-composio.md) proposes a
plugin carrying `hooks.json`, and its action table lists `PreToolUse` among the hooks it
would ship. That is the right vehicle for the *owner-facing* surface — the SessionStart
nudge, `UserPromptSubmit` routing, slash commands — and the wrong one here.

A plugin installs into `~/.claude` and fires on every session the owner runs, including
their own work. This guard is scoped to the agent agentcall spawns to answer somebody
else's call; applying it to the owner's own editing would be both wrong and unwelcome.
Two audiences, two delivery mechanisms, no conflict.

The plugin's own stated principle points the same way — *the plugin stays thin;
capability lives in the CLI*. Keeping `decide()` in `agentcall` is that principle, and it
is why Codex parity later is an adapter rather than a second copy of the policy.

**No `matcher` and no `if` field.** Both narrow which calls reach the hook, and the
matcher parser fails *open* — an argument it cannot evaluate runs the tool anyway. For
a safety floor the gate must not be the thing that can silently disappear. Every tool
call reaches `decide()`; `decide()` alone decides.

## Components

| File | Responsibility |
|---|---|
| `packages/cli/src/guard.ts` **(new)** | `decide()` — pure, agent-agnostic, no I/O. The denied-path table. Plus `runGuard()`, which reads the payload, calls `decide()`, appends to both log streams, emits the structured deny on stdout, and returns an exit code. |
| `packages/cli/src/guard-entry.ts` **(new)** | Standalone process entry: stdin → `runGuard()` → exit. **Not** routed through `index.ts` — finding 6 measured that at 2.4× the cost, and this is the hot path. Imports `guard.ts` and nothing else. |
| `packages/cli/src/runner.ts` | `--settings` JSON, `AGENTCALL_CALL_ID` in spawn env, `SpawnSpec.env`. |
| `packages/cli/src/paths.ts` | Adds `toolsLog`. |
| `packages/cli/src/doctor.ts` | Live self-test that the guard actually blocks. |

No `_guard` subcommand on `index.ts`: adding one would invite invoking the guard through
command dispatch, which is the slow path the entry point exists to avoid.

### `decide()`

```ts
export type GuardInput = { tool_name: string; tool_input: Record<string, unknown> };

// `rule` and `detail` are audit-only — they name the matched rule and the
// resolved path, and MUST NOT reach permissionDecisionReason. The caller-facing
// reason is a single fixed string with no per-denial content; see the reason
// contract below. Keeping it constant is what makes the contract testable.
export type GuardVerdict =
  | { allow: true }
  | { allow: false; rule: string; detail: string };

export function decide(
  input: GuardInput,
  home: string,
  realpath: (p: string) => string,   // injected; fs.realpathSync in production
): GuardVerdict;
```

`realpath` is a parameter rather than an import so the function stays pure and
table-testable, and so symlink evasion (`ln -s ~/.ssh/id_rsa /tmp/x`, then read `/tmp/x`)
is resolved rather than matched textually. `..` traversal normalises the same way.

Agent-agnostic by construction: it takes a tool name and an argument bag, not a Claude
hook payload. Wiring Codex's pre-tool hook to the same function later is an adapter, not
a rewrite.

### The denied set

The question `decide()` answers is **"can this call reach a denied path"**, not "is this
call's target a denied path". Those differ, and the difference is a hole:

```
Grep(path: "~", pattern: "BEGIN OPENSSH PRIVATE KEY")
Glob(pattern: "**/id_*")
```

Neither target *is* `~/.ssh`, and both return content or filenames from inside it. So the
three tool shapes are treated differently:

| Shape | Tools | Rule |
|---|---|---|
| Exact target | `Read`, `Write`, `Edit`, `NotebookEdit` | deny if the resolved target is inside a denied path, or its basename is denied |
| Scanning root | `Grep`, **`LS`** | deny if the root is inside a denied path **or is an ancestor of one** |
| Pattern-carried path | `Glob` | its path lives in `pattern`, not `path` — deny on the pattern's literal prefix, on a denied basename in the pattern, or on `..` |
| No filesystem surface | `WebFetch`, `WebSearch` | allow |
| Opaque string | `Bash` | see below |
| **Anything else** | — | **deny** |

The last row is load-bearing. An earlier draft allowed unclassified tools, and `LS` —
granted unconditionally by the `read` capability at `runner.ts:31` — fell straight
through it, listing private-key filenames. A tool this function has never been taught
has an argument shape it cannot inspect, so it must not be waved through.

Comparison is by canonical path, not string prefix. Three reasons, each a bug that was
found by running the code rather than reading it: `resolve("/") + sep` is `"//"` and
prefixes nothing, so a search rooted at `/` was permitted; the supported platform's
default filesystem is case-**in**sensitive, so `~/.SSH` reached `~/.ssh`; and `realpath`
throws on a path that does not exist yet, so a `Write` to `/tmp/link/new_key` where
`link → ~/.ssh` was compared as text and allowed. Resolution therefore walks up to the
longest *existing* ancestor, re-appends the tail, folds case, and compares with
`path.relative()`.

The ancestor clause is what stops `Grep(path: "~")` and `Glob` from a broad root: `~` is
an ancestor of `~/.ssh`, so it is refused, while `Grep(path: "~/project")` is not an
ancestor of anything denied and passes. `/` is an ancestor of everything and is refused
on the same rule rather than as a special case.

Rewriting the call via `updatedInput` to inject exclusions was the alternative. Refusal
is chosen because a rewrite has to be correct for every tool's argument grammar to be
safe, and a silently wrong rewrite looks like success — the same property that
disqualified deny rules in finding 3.

The denied paths themselves:

- `~/.ssh/**`, `~/.gnupg/**`, `~/.aws/**`, `~/.config/gcloud/**`
- `~/Library/Keychains/**`
- `**/.env`, `**/.env.*`, `~/.netrc`, `~/.npmrc`, `~/.docker/config.json`
- `**/id_rsa`, `**/id_ed25519`, `**/*.pem`, `**/*.p12`
- `~/.agentcall/**` — holds `config.json` and the relay token; the guard protects its
  own credentials
- `~/.claude/**`, `~/.claude.json` — executable configuration. This is the surface the
  Seatbelt profile used to carve out, and the class of bug behind CVE-2025-59536.

### `Bash` — record, do not deny

`Bash` takes an opaque command string, so the guard can only pattern-match it. An earlier
draft denied on a match. It should not, and the reason is that string matching fails in
*both* directions:

- **Too weak to be a boundary.** Obfuscation defeats it trivially, so it cannot be
  claimed as a control.
- **Too eager to be harmless.** `cat .env.example`, `ls -la | grep env`, and
  `docker run --env-file` all match a naive rule and are all legitimate. A control that
  blocks real work while not stopping a real attacker is the worst of both.

So matches are **recorded to `calls.log` and allowed**. That keeps the signal — an owner
reviewing the log sees exactly what was attempted — without the false-positive burden,
and it is consistent with this spec's own position that the real control on `exec` is
which tasks the owner writes to grant it.

The honest claim is therefore narrow: the guard is a boundary for path-shaped tool
arguments, and an observer for `Bash`. **A task granting `exec` has no read floor** —
`cat ~/.ssh/id_rsa` is recorded and permitted. Calling this a "global safety floor"
without that sentence oversells it, and the README must carry the caveat too.

### Residual: `Grep` over an allowed root

`Grep(path: "<workdir>", pattern: "BEGIN OPENSSH PRIVATE KEY")` is permitted, and can
return content from a `.env` or `*.pem` that lives inside the workdir. The root is not
denied and the denied thing is in the *results*, which a pre-call hook cannot filter.

Closing it would need either post-call filtering (a `PostToolUse` hook cannot unsend a
result) or refusing `Grep` outright, which removes most of the value of a Q&A agent over
a codebase. It stays open, and it is stated here rather than discovered later. The
mitigation that does exist is the owner's choice of `workdir`.

### Failure behaviour

Two exit paths, deliberately different:

- **Ordinary denial** — exit 0 with `permissionDecision: "deny"`. Reads as a policy
  decision to the model rather than a malfunction.
- **Guard failure** — unparseable stdin, malformed payload, or a throw from `decide()`
  exit **2**, which blocks bluntly. The guard never allows because it failed to decide.

Around the guard, Claude **fails open** in three ways, and each needs its own answer:

| Failure | Result | Answer |
|---|---|---|
| Binary unresolvable | hook never runs, tool proceeds | `doctor` canary check |
| Exit code not 0 or 2 | non-blocking error, tool proceeds | fail-closed exit 2 above |
| **Hook exceeds its timeout** | **abandoned, tool proceeds** | explicit `timeout`, hot path stays cheap |

The timeout case is the one most easily missed. GitHub Copilot CLI has it as a
[documented bug](https://github.com/github/copilot-cli/issues/2893) — under parallel tool
calls the timeout expires, the CLI stops waiting, and the tool executes anyway. A guard
that is merely *slow* is a guard that is not there.

So the hot path is a hard constraint, not a performance goal: `decide()` does no network
I/O, reads no config file, and touches the filesystem only for `realpath`. If the guard
ever needs state, the Composio split applies — warm a cache on `SessionStart`, never fetch
on the hot path
([lessons-from-composio §3](../../research/2026-07-31-lessons-from-composio.md)).

But per finding 6 the constraint that matters is **process startup**, not the function.
Hence the separate minimal entry point: ~33 ms standalone against ~78 ms through the CLI's
command dispatch, for identical work.

**The timeout is biased long, deliberately.** Timeout expiry fails *open* — the tool
runs. So the entire risk sits on the too-short side, and there is no security argument
for a tight value. A guard that hangs stalls one call, which is safe and visible; a guard
that is abandoned lets the call through, which is neither. The registered `timeout` is
therefore set with wide headroom over the measured worst case rather than tuned close to
the median. Latency under contention is a cost worth paying for a control that does not
quietly evaporate under load.

The binary case is covered at setup time by a `doctor` check that spawns a throwaway
`claude -p` against a canary file and asserts the read is refused. It converts a silent
runtime hole into a loud, diagnosable setup failure — the same job `verify.ts` does for
PATH and auth. Being a live spawn it runs only on the user's machine; per CLAUDE.md no
`claude` process is started in CI.

### Audit record

The guard appends to `calls.log`, matching the existing JSONL shape written by
`listener.ts:37-40`:

```json
{"ts":"2026-07-31T…","type":"tool_denied","call_id":"…","tool":"Read",
 "rule":"ssh-private-keys","detail":"~/.ssh/id_rsa"}
```

`call_id` arrives via `AGENTCALL_CALL_ID`; `AGENTCALL_HOME` is already inherited, so
`getPaths()` resolves correctly with no extra plumbing. Existing call records have no
`type` field, so a reader distinguishes them by its absence — nothing parses `calls.log`
today, so this costs nothing now and is worth fixing whenever one is written.

**Two streams, because one stream cannot serve both readers.**

An earlier draft logged denials only, on the grounds that logging every call would bury
the signal. The burying problem is real but omission is the wrong fix: a deterministic
record of *every* tool call is named in
[claude-code-enforcement-surfaces §7](../../research/2026-07-31-claude-code-enforcement-surfaces.md)
as something neither Viven nor the gateway vendors offer, and it is the kind of evidence
EU AI Act deployer obligations ask for. Discarding it to keep a log tidy trades a
differentiator for neatness.

So:

- **`calls.log`** — call records as today, plus one `tool_denied` line per denial and one
  `tool_flagged` line per `Bash` pattern match. Sparse, owner-facing, the thing worth
  reading.
- **`tools.log`** *(new, added to `paths.ts`)* — every tool call **that reaches the
  guard**, allowed or not. Dense, machine-facing, the audit trail. Nothing parses it yet;
  it exists so the claim is true.

A denial appears in both. The signal stays sparse without the record being lossy.

**The precise claim is "every tool call that reaches the guard", not "every tool call".**
Calls rejected by `--allowedTools` never fire a hook, so an attempt to use an MCP tool or
spawn a subagent is refused by Claude and leaves no line here. Nor does a call whose hook
process fails to start. Nor does a call whose payload fails to parse (`runGuard` returns
exit 2 before either log write, on the same fail-closed reasoning as a hook-start
failure — writing to disk before the payload is understood would be recording data this
function never actually decided on). Writing this down matters because the looser
phrasing is the one that would end up in a compliance conversation, and it would not
survive scrutiny.

### What the caller learns — the reason is a contract

An earlier draft of this spec claimed the caller sees nothing. That is false, and the
experiments show it: the reason reaches the model, and the model writes the reply that
goes back over the relay. The caller *will* learn a refusal happened.

What is actually achievable is narrower, and it is the thing worth guaranteeing:

> **The guard tells the caller nothing the model did not already know.**

The model knows the filename because it chose the tool call from the caller's own
request; that much is unavoidable and harmless. What must never cross the boundary is
what only the *guard* knows — the resolved absolute path, the rule that matched, or
anything implying the shape of the denied-path table.

So `permissionDecisionReason` is caller-facing output under test, in the manner of
[lessons-from-composio §4](../../research/2026-07-31-lessons-from-composio.md):

- **Required:** states that the action is not permitted by the owner's policy.
- **Forbidden:** any absolute path, any `~/`-prefixed path, any rule identifier, the word
  `.ssh`, or any other denied-path fragment.
- **Bounded:** one sentence.

The specifics stay in `calls.log`, which only the owner reads. A test enforces both
halves — the reason is generic, the audit line is not — because these are exactly the
strings a later edit makes "more helpful" without noticing what it leaks.

**The residual, which the generic reason does not remove: a denial is an oracle.**
Reading `/tmp/x` succeeds if it is an ordinary file and is refused if it resolves into a
protected directory, so the *fact* of refusal tells the caller something about the
owner's filesystem that neither they nor the model knew. Repeated probing maps the
denied-path table and reveals symlink structure. What is enforced is generic denial
*text*; the stronger information-flow property does not hold, and pre-call inspection
cannot deliver it — refusing to answer at all is the only thing that would.

## Testing

Test-first, per CLAUDE.md.

- **`test/guard.test.ts` (new)** — table-driven `decide()`: each denied family; symlink
  indirection through a fake `realpath`; `..` traversal; ordinary project paths allowed;
  unknown tool names allowed; malformed input denied. No fs, no spawn.
- **`test/runner.test.ts`** — `buildSpawnSpec` emits `--settings` containing the hook and
  an absolute interpreter path; `AGENTCALL_CALL_ID` reaches `SpawnSpec.env`; codex spawn
  is unchanged. Plus an **exact-hook-set assertion**: the generated settings register
  `PreToolUse` and nothing else, so no hook can be added to a security-carrying payload
  without deliberately editing a test that says so.
- **Reason-text contract** — required phrase present, forbidden fragments absent (no
  absolute path, no `~/`, no rule name, no `.ssh`), one sentence. Asserted over every
  denial case in the table, not on a single hand-picked example.
- **Timeout budget — measured on the spawned process, not on `decide()`.** Timing the
  pure function would pass while the real path is slow, since the cost is startup. The
  test spawns `guard-entry` as a real subprocess with a payload on stdin and asserts
  end-to-end wall time inside budget, in the manner `runner.test.ts` already spawns a
  fake agent binary.
- **`Grep`/`Glob` reachability** — `Grep(path: "~")` and a broad `Glob` are denied by the
  ancestor rule; `Grep(path: "~/project")` is not. These are the cases a target-equality
  implementation silently passes, so they belong in the table from the first commit.
- **`test/guard.test.ts`** — also covers `runGuard()` against a temp `AGENTCALL_HOME`:
  exits 0 vs 2, and writes exactly one audit line on deny, none on allow.
- **`test/doctor.test.ts`** — the self-test reports pass/fail correctly against a mocked
  spawn.

`pnpm -r test && pnpm -r typecheck && pnpm -r build` before done. Note that `typecheck`
does not cover `test/`, so a signature change to `buildSpawnSpec` shows up only in the
test run.

## Deliberately not in scope

- Per-task `write_paths`/`network`. Removed on 2026-07-31; not being re-added here.
- Per-caller tool-level policy.
- The `ConfigChange` hook (layer 4). Separate, cheap, and a natural follow-on — the
  `~/.claude/**` read denial above overlaps its territory but does not replace it.
- Codex. `decide()` is agent-agnostic so parity is wiring, but Codex answering agents
  have **no read guard** until it is done, and the README must say so.

## Open questions

1. **Which deny-rule path form actually matches.** Experiment 2 passed `Read(./rel)` and
   `Read(//abs)` together and did not isolate them. Only matters if the deny-rule
   backstop is revisited.
2. ~~Whether `sandbox.filesystem.denyRead` covers the `Read` tool.~~ **Resolved — it does
   not.** See finding 5.
3. ~~Hook process cost per tool call.~~ **Resolved — ~33 ms standalone, ~78 ms through
   command dispatch.** See finding 6.
4. ~~Behaviour under genuinely parallel tool calls.~~ **Resolved during implementation** —
   `guard-entry.test.ts` spawns 8 concurrent hook processes and asserts both the timeout
   budget and that `tools.log` receives exactly 8 parseable lines with none lost or torn.

## Follow-ups after implementation

Carried out of the final review, deliberately not fixed before merge. Each has a ruling.

5. **The `Bash` flag misses relative paths.** It matches only absolute or `~`-prefixed
   denied paths, so `cat .ssh/id_rsa` is neither blocked nor flagged. Observed live: after
   its `Read` was denied, the model attempted exactly that shape twice.
   *Ruling: defer.* Matching relative paths would strengthen the **observer** without
   strengthening the **control**, which is the failure mode the Bash section above is most
   careful to avoid, and it revives the false positives (`cat .env.example`) that motivated
   record-don't-deny. But the flag is the owner's only visibility on `exec`, and the gap
   correlates with adversarial behaviour — exactly when the log line matters most. The
   right fix is to match denied *basenames* anywhere in a command, flag-only, never deny.

6. **The guard's own package root is read-denied, where only write is dangerous.** In a
   dev checkout the root is `packages/cli`, so a caller cannot read `src/guard.ts` or
   `package.json`. The rest of the repo stays readable, and a normal install puts the root
   in `node_modules` where nobody would look.
   *Ruling: defer.* Safe direction, dev-only, and splitting the table into read-denied and
   write-denied shapes costs real complexity for one case. Recorded because it does cut
   against [lessons-from-composio §7](../../research/2026-07-31-lessons-from-composio.md) —
   when trust is the product, being readable is part of the product.

7. **A shared `packages/cli/test/helpers.ts` is now wanted.** `homeWithDenial()` is
   duplicated across `verify.test.ts` and `doctor.test.ts`; `payload()` duplicates `call()`
   in `guard.test.ts`. Second and third signals for one module. *Ruling: defer, cosmetic.*

Verified during the final review and **not** issues: `guardRoot` resolves to the package
root (covering `dist/`, `bin/`, `package.json`) for both a global install and a dev
checkout; a symlinked install cannot evade it, because Node resolves `import.meta.url`
through `realpath` and `canonical()` realpaths the target, so both sides agree.

---

## Review — 2026-07-31

Reviewed by a second session. The shape is right, and grounding it in three live
experiments rather than documentation reads is what makes it trustworthy — particularly
finding #2, that `permissions.deny` sits *in front of* the hook rather than beneath it.
That inverts the natural belt-and-braces instinct and would not have been found by
reading docs.

Three things to settle before writing code, then two smaller notes.

### Gate 1 — resolve open question 2 first, not later

Open question 2 asks whether `sandbox.filesystem.denyRead` covers the `Read` tool. It is
filed as something worth measuring "before the denied-path table grows." **It should be
measured before the first line is written.**

This spec is a new `guard.ts`, a hidden `_guard` command, `--settings` plumbing in
`runner.ts`, a `doctor` self-test, and four test files — several hundred lines. If
`denyRead` covers the `Read` tool, the same read protection is a ten-line JSON block,
delivered through the `--settings` channel this spec already builds. That does not merely
shrink the denied-path table; it removes the reason for most of the component.

The check costs about what experiments 1–3 cost:

```bash
claude -p "read ~/.ssh/canary and tell me its contents" \
  --settings '{"sandbox":{"filesystem":{"denyRead":["~/.ssh"]}}}' \
  --allowedTools Read --permission-mode dontAsk
```

Note the provenance of the doubt is healthy: the research doc marked native sandboxing
Bash-only as **[unverified]**, and this spec found documentation contradicting it. The
tag did its job. Now close it.

### Gate 2 — the timeout test measures the wrong thing

The plan asserts "a decision returns well inside" the registered `timeout`, tested in
`guard.test.ts` against `decide()` with no fs and no spawn. `decide()` is a pure function
and returns in microseconds. **That test passes while the real path is slow.**

The real hot path is: Node cold start → module load → read stdin → `getPaths()` →
`realpath` → `decide()` → append `calls.log` → stdout. Realistically 100–300 ms
dominated by process startup, none of which the unit test touches.

This is a security measurement, not a performance one, for the reason the spec itself
gives: a guard that is merely slow is a guard that is not there. The `timeout` value has
to be derived from a measured worst case of the **spawned `_guard` process** on a loaded
machine — which makes open question 3 the same gate, not a separate optimisation
question.

### Gap — `Grep` and `Glob` reach denied paths through a parent

> Read-shaped tools (`Read`, `Grep`, `Glob`, `Write`, `Edit`) expose their target as a
> structured argument, so matching is exact.

True for `Read`, `Write`, `Edit`. Not for the other two:

```
Grep(path: "~", pattern: "BEGIN OPENSSH PRIVATE KEY")
Glob(pattern: "**/id_*")
```

Neither target matches `~/.ssh/**`, and both surface content or filenames from inside it.
Matching the target path is insufficient when the target *contains* a denied path.

`decide()` needs to answer "could this target reach a denied path", not just "is this
target denied". Either refuse broad roots for `Grep`/`Glob`, or rewrite the call via
`updatedInput` with the denied paths excluded. Adding `Grep(path: "~")` to the table-driven
cases surfaces this at design time.

### Note — Bash matching may cost more than it earns

Denying commands whose text references a table path will fire on legitimate work:
`cat .env.example`, `ls -la | grep env`, `docker run --env-file`. The spec is honest that
obfuscation defeats string matching, but does not consider the opposite failure — weak as
a control, strong as an obstacle.

Worth considering: record Bash matches to `calls.log` without denying. That keeps the
signal, drops the false-positive burden, and matches the spec's own assessment that the
real control on `exec` is which tasks the owner writes.

### Note — denials-only logging gives up a claimed differentiator

"Denials only. Logging every allowed tool call would bury the signal." Sound as log
design, but it conflicts with the positioning in
[claude-code-enforcement-surfaces §7](../../research/2026-07-31-claude-code-enforcement-surfaces.md):
a deterministic audit trail of every tool call is listed as something neither Viven nor
the gateway vendors have, and only 17% of organisations surveyed in Q1 2026 could
reconstruct a full tool-call sequence. EU AI Act enforcement begins 2026-08-02.

The burying problem is real; the answer is probably a separate stream or a setting, not
omission.

### Not in dispute

`realpath` as an injected parameter (purity and symlink resolution from one decision);
declining `matcher` and `if` because a fails-open parser must not be the gate; keeping
this out of `~/.claude` so the owner's own sessions are untouched; and the reason-text
contract — *the guard tells the caller nothing the model did not already know* — which
correctly replaced a false claim in an earlier draft with something testable.

---

## Response — 2026-07-31

All five points accepted; both gates were resolved by measurement rather than by
argument, since both were empirical questions.

| Review point | Disposition |
|---|---|
| Gate 1 — measure `denyRead` first | **Done, negative.** Finding 5. Full scope stands; there is no ten-line alternative. |
| Gate 2 — timeout test measures the wrong thing | **Correct.** Finding 6 measured the process. Produced a new component (`guard-entry.ts`) and a changed test. |
| `Grep`/`Glob` reach denied paths via a parent | **Real bug.** Rule changed from target-equality to reachability, with an ancestor clause. |
| Bash matching costs more than it earns | **Accepted.** Now records and allows rather than denying. |
| Denials-only logging drops a differentiator | **Accepted.** Two streams: `calls.log` sparse, `tools.log` complete. |

Two things worth recording about the review itself.

Gate 2 was the most valuable item, because the proposed test would have **passed** while
leaving the hole open — timing a pure function that returns in microseconds says nothing
about a path dominated by process startup. A green test asserting the wrong quantity is
worse than no test, and nothing in the spec would have revealed it.

The `Grep`/`Glob` gap and the earlier caller-visibility error share a cause: both were
places where the spec asserted a property ("matching is exact", "the caller sees
nothing") that read as obviously true and was not checked. The pattern to carry into
implementation is that the confident sentences are the ones that need a test, not the
hedged ones.

---

## Second review — Codex, 2026-07-31

The implementation plan was reviewed adversarially by Codex before any code was written.
It returned 17 findings, six of them critical. Every claim reported here was verified
independently — by running the path logic, checking `runner.ts`, and testing the
filesystem's case sensitivity — rather than accepted as written.

**Eight were real bugs in the plan's own code, and they shared one cause.** `decide()`
compared unnormalised paths with `startsWith`. That single wrong primitive produced: `~`
never expanded, so `Read("~/.ssh/id_rsa")` was allowed; scanning tools never checking
denied basenames; `Glob` matched on `path` when its path actually lives in `pattern`, so
`Glob("/Users/o/.ssh/*")` enumerated the directory; `LS` unclassified and waved through;
`isAncestorOf("/")` comparing against `"//"`; the `realpath` fallback allowing a write
through a symlink with a nonexistent leaf; and case-sensitive comparison on a
case-insensitive filesystem. Patching eight symptoms would have left a ninth, so the
function was rebuilt on canonical resolution. The rewritten version was then executed
against the plan's tests — 31 of 31 pass, including every bypass Codex named.

**One was the reverse of a fail-closed claim.** The audit writes sat outside the
try/catch, so a full disk would throw, exit the process 1, and — because a non-0/2 exit
is a non-blocking error — let the tool run. The failure mode of the audit trail was to
silently disable the guard.

**Three findings were claims the spec could not support**, and are now narrowed above:
the `exec` read floor, the denial oracle, and "every tool call" versus "every tool call
that reaches the guard."

**One design disagreement, resolved against Codex.** It called `Bash` record-don't-deny a
design error. The decision stands — denying on string match blocks `cat .env.example`
while a one-character change defeats it — but it was right that the *claim* was false.
The wording changed, not the design.

Worth recording: Codex found what a spec review and a self-review both missed, and it
found it by tracing code rather than reading prose. The two review passes were not
redundant — the first caught wrong reasoning, the second caught wrong code.
