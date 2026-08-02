# The unscoped `agentcall` npm name — what ships now, and what waits on the brand

**Date:** 2026-08-01
**Status:** **Design, approved. Partially deferred — see "Scope".** Nothing built yet.
**Issue:** [#45](https://github.com/KenTaniguchi-R/agentcall/issues/45)
**Blocked by:** [#53](https://github.com/KenTaniguchi-R/agentcall/issues/53) — for the
CI guard only. The `doctor` check is name-independent and is not blocked.

> **Revision, same day.** The first draft of this spec concluded "accept
> `@benree/agentcall` permanently, the question is closed." **That conclusion is
> withdrawn.** It was written before the npm manifest was checked against the
> owner's homepage, which showed the package and `agentcall.co` are one company in
> our own market rather than an unrelated telephony vendor. Closing the naming
> question at the packaging altitude would have made the real decision — #53 — harder
> to reach, in a file this repo does not revise. The evidence below is unchanged and
> was verified; only the conclusion drawn from it was wrong.

## The problem, restated

The unscoped `agentcall` on npm is not ours. Ours is `@benree/agentcall`. Issue #45
was opened after a live setup session typed `npx agentcall setup` and `npx agentcall
doctor` throughout and worked correctly — purely because a global install already
existed and `npx` prefers a binary already on `PATH`. The concern was that a new user
copying that command from a chat log would execute a stranger's code.

Three of the issue's premises did not survive checking against the registry and the
tree, and the design turns on all three.

### The repo is already clean

`grep -rn "npx agentcall"` over every tracked file returns nothing. README,
CONTRIBUTING, AGENTS.md, CLAUDE.md, `docs/`, `.github/` — no occurrence. The only
`npx` invocations anywhere in the tree are for `wrangler` and the removed
sandbox-runtime, in `CHANGELOG.md` and historical `docs/superpowers/` plans.

The install path is correct as written. `apps/relay/src/install-sh.ts` runs
`npm install -g @benree/agentcall`, then `exec`s the **absolute** path
`$(npm prefix -g)/bin/agentcall` rather than a `PATH` lookup — so even a machine with
a shadowing binary runs ours.

The docs sweep the issue asks for is therefore already satisfied.

### The blast radius today is smaller than stated, and not stable

`agentcall@0.9.3` (`Kintupercy/AgentCall`, maintainer `kintupercy`, last modified
2026-07-02). Checked against the registry on 2026-08-01:

- **No `bin` field.** `npm view agentcall bin` returns empty.
- **No lifecycle scripts.** `scripts` is `{ prebuild, build, prepublishOnly, test }` —
  no `preinstall`, `install`, or `postinstall`.

So on a machine without our global install, an unscoped `npx` invocation fetches their
package, finds no executable, and fails with npm's "could not determine executable to
run". It is not arbitrary code execution today. There is also no `PATH` collision:
since their package ships no binary, a global `agentcall` on `PATH` is unambiguously
ours.

This is a property of *their current publish*, not a guarantee. A `bin` field or a
`postinstall` in any future release of theirs flips the failure mode from "loud error"
to "runs their code", and we would receive no signal that it happened.

### It is a brand collision, not a packaging accident — and that changes the issue

The npm manifest declares `homepage = "https://agentcall.co"`. That site is
**"AgentCall — Programmable Phone Numbers for AI Agents"**: a REST API *plus an MCP
server*, free tier, npm keywords `phone, sms, otp, ai, agent, voip, call, voice,
verification, programmable`.

One entity holds the `.co`, the unscoped npm name, and a shipping product — and sells
to AI-agent developers, on the same discovery surfaces this project needs: npm search,
MCP directories, and a web search for "agentcall". They were there first.

This is not a decision about which string to type into a package manager. It is
whether "agentcall" is the product's name, and it is time-sensitive for a reason that
has nothing to do with npm: handles are addresses. `RELAY_HOST` is a constant at
`apps/relay/src/index.ts:28`, and contacts and rosters **store** `<handle>@<host>`.
With zero users a rename is a find-and-replace; after the first user it breaks every
saved address, with no migration path while handle release stays unimplemented (#16).

That question is **#53**. This spec does not answer it and must not appear to.

## Scope

Two deliverables, split by whether they survive a rename.

| | Survives a rename? | Status |
|---|---|---|
| `doctor` provenance check | Yes — reports which binary is answering, under any name | **Ships now** |
| CI guard against the unscoped name | No — only has a job if the name stays "agentcall" | **Parked on #53** |
| Agent-facing rule in `CLAUDE.md` | Partly — wording depends on the final name | **Parked on #53** |

The parked items are specified below so that, if #53 resolves as "keep the name", the
work is ready to execute rather than re-derived. If #53 resolves as "rename", they are
deleted unbuilt and nothing is lost.

## Ships now — a provenance check in `agentcall doctor`

**What it cannot do.** "Did you install the wrong package?" is unanswerable from
inside our own binary. If someone installed `Kintupercy/AgentCall`, our `doctor` code
is not running at all, so a check asserting the package name can only ever pass. It
would be a green tick that proves nothing. The check must therefore report *which*
install is answering, not *whether* it is the right one.

**Placement.** First check in `runDoctor`, before `loadConfig`. Today a missing
config reports and returns 1 at `doctor.ts:42-48` having printed nothing about the
running binary — which is exactly the situation ("I ran setup and something is
wrong") where that fact matters most.

**What it reports.**

- `name@version`, read from the CLI's own manifest via
  `new URL("../package.json", import.meta.url)`. Correct from `dist/doctor.js`, since
  `packages/cli/package.json` ships `files: ["bin", "dist"]` — so `../package.json`
  resolves to the manifest in both the workspace and an installed package. Reading the
  manifest rather than hardcoding a name is also what keeps this check correct through
  a rename.
- The `realpath` of the running entry, resolving the symlink that npm's global bin
  directory installs, so the reported path is the file that actually executed.

**Shadow detection.** `which -a <bin>`, then `realpathSync` every hit and
deduplicate. Report a shadow only when **two or more distinct real paths** survive
deduplication. One binary reachable through several symlinked `PATH` directories is
the normal case, not a shadow, and must not warn. The binary name comes from the
manifest's `bin` key, not a literal, for the same rename-survival reason.

**Warn, not fail.** `VerifyCheck` already carries `warn?: boolean`
(`packages/cli/src/verify.ts:19`), rendered as `!` by `formatCheck`
(`verify.ts:85-88`), and `runDoctor`'s header comment defines it precisely: "a `!`
warning is a check that could not be proven, not one that failed, and does not turn
the run red" (`doctor.ts:32-33`). Two binaries on `PATH` fits that definition — it is
suspicious, not broken. It is also the *normal* state for anyone developing this repo,
who has a global install alongside a workspace build. Reporting `ok: false` would make
`doctor` exit 1 on healthy contributor machines, which trains people to ignore the
exit code. So: `ok: true, warn: true`, detail listing every distinct path, hint stating
that the first on `PATH` wins and naming the one to remove.

**Test seams.** `DoctorDeps` already carries seams for every impure dependency
(`launchctlList`, `isDarwin`, `getStatusFn`, `callFn`). Three more follow the same
convention: `whichFn` for the `which -a` invocation, `selfPathFn` for the running
entry's real path, and `pkgFn` for the manifest read. Production callers leave all
three at their defaults, as the existing comment at `doctor.ts:12` requires.

### Testing

Test-first, per `CLAUDE.md`. In `packages/cli/test/doctor.test.ts`:

- Single resolved path — reports `✓`, detail contains `name@version` from the manifest
  and the real path.
- Two distinct real paths — reports `!` (not `✗`), detail names both paths, and the
  returned exit code is unchanged from the equivalent single-path run.
- Several `PATH` entries symlinking to one real file — reports `✓`, no warning. This
  is the case a naive `which -a` count gets wrong.
- `whichFn` throws — the package and path are still reported and `runDoctor` does not
  crash. A broken `which` must not take down the whole diagnostic.
- Missing config — the provenance line is printed *before* the config failure, and the
  return code is still 1.

No new tests in `apps/relay` or `packages/shared`; neither is touched.

## Parked on #53 — CI guard, `scripts/check-unscoped-name.sh`

Specified but **not built** until #53 resolves as "keep the name".

Wired as one step in the `verify` job of `.github/workflows/ci.yml`, immediately after
`actions/checkout` and before `pnpm/action-setup`. It needs only a git checkout, so it
fails in seconds rather than after a full install and build.

**File list.** `git ls-files`, which excludes untracked trees — notably
`.claude/worktrees/`, where per-session worktrees hold full copies of the repo that
would otherwise be scanned.

**Exclusions.** `docs/superpowers/**`, `CHANGELOG.md`, and the guard script itself.

The first two are append-only history that `CLAUDE.md` explicitly forbids revising to
match current code. A hit inside either would be unfixable without breaking that rule,
so the guard must not look there. This file lives under `docs/superpowers/` and is
covered by that exclusion, which is why the bad commands above may be written out in
full.

The third exclusion is not optional and is easy to miss: `scripts/check-unscoped-name.sh`
is itself a tracked file whose `--self-test` table necessarily contains every string
the guard is built to reject. Without excluding it, the guard's first CI run fails on
its own source. Its correctness is covered by `--self-test`, not by scanning itself.

**Escape hatch.** Any line containing the marker `check-unscoped-name:allow` is
skipped. Needed because a file that legitimately has to *quote* the wrong command in
order to warn about it would otherwise be unable to say so.

**Pattern.** A package-manager verb, then whitespace, then the bare name:

```
(npx|npm (i|install|exec)|pnpm (add|dlx)|yarn (add|dlx)|bunx|bun add)[[:space:]]+(-[A-Za-z-]+[[:space:]]+)*agentcall([[:space:]]|$)
```

Verified against both self-test tables on 2026-08-01 before this spec was committed:
every must-match string matches, every must-not-match string does not.

The trailing `([[:space:]]|$)` is deliberately not `\b`. Word-boundary `\b` is a GNU
extension that BSD `grep` does not honour — the script would behave one way on the
ubuntu CI runner and another on the macOS machines this project is developed on. That
is the same GNU/BSD split that bit the `date -d` / `date -v` fallback in #40, and it
fails in the worse direction here: silently, with no output difference to notice.

Two things it must not match, both load-bearing:

- `@benree/agentcall` — cannot match, because the `/` occupies the position where the
  pattern requires whitespace.
- Prose such as "the `agentcall` command" or "run `agentcall doctor`" — cannot match,
  because there is no package-manager verb in front.

**`--self-test`.** The regex is the only part of this script that can be silently
wrong, and a wrong regex fails open — it reports success while catching nothing, which
is worse than not having the guard. So the script accepts `--self-test`, which runs
the pattern against a fixed table of strings that must match and strings that must not,
and exits nonzero on any disagreement. CI runs `--self-test` first, then the real scan.
This is how the guard gets test coverage without contorting a package-scoped vitest
suite into grepping the repository root.

Must-match: `npx agentcall`, `npx agentcall setup`, `npx --yes agentcall`,
`npm i -g agentcall`, `npm install agentcall`, `npm exec agentcall`,
`pnpm add agentcall`, `pnpm dlx agentcall`, `yarn add agentcall`, `bunx agentcall`,
`bun add agentcall`. Must-not-match: `npx @benree/agentcall`,
`npm i -g @benree/agentcall`, `agentcall setup`, `agentcall doctor`,
"the `agentcall` command", `npx wrangler deploy`, `@benree/agentcall-shared`, and a
would-be match carrying the `check-unscoped-name:allow` marker.

**Failure output.** The offending `path:line:text` for every hit, followed by one
sentence naming the cause and the fix. Exit 1. No hits, exit 0.

Run under both `bash` and `sh` locally before merging. The regex avoids `\b`
specifically to survive BSD `grep`, and an assertion about portability that is never
executed on the other platform is an assumption, not a test.

## Parked on #53 — an agent-facing rule in `CLAUDE.md`

The commands in #45 were generated by a coding agent, not copied by a human. Agents
read `CLAUDE.md`; the README's install story is already correct and does not need a
warning about a package nobody lands on by accident.

One rule, in the repo-conventions region: never reach for the unscoped `agentcall`
name through npx, npm, pnpm, yarn, or bun — that name on npm is a different package.
Use the global binary after `install.sh`, or write the scoped name out in full.

Worded as prose deliberately. Spelling the forbidden command out literally would trip
the CI guard, since `CLAUDE.md` is a tracked, non-excluded file — the rule and its
enforcement have to agree. The `check-unscoped-name:allow` marker is available if a
future edit needs the literal form.

It goes in `CLAUDE.md` alone, not duplicated into `AGENTS.md`, because `AGENTS.md`
already closes with "For everything else — repo layout, test commands, TDD
expectations, where protocol types live — read CLAUDE.md."

## What is deliberately not in scope

- **Deciding the product name.** That is #53. This spec is explicitly agnostic on it,
  and the shipping deliverable is built to survive either outcome.
- **Editing `docs/superpowers/` or `CHANGELOG.md`** to remove historical `npx`
  references. They are dated records and are not revised.
- **A README note about the collision.** The README's install story is already
  correct, and the population that reaches for the wrong command reads `CLAUDE.md`,
  not the README.
