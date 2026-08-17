# What the PreToolUse guard's import graph actually costs

**Date:** 2026-08-06
**Issue:** [#377](https://github.com/KenTaniguchi-R/agentcall/issues/377)
**Measured against:** `main` @ `38ff085`, node v24.18.1, M4 Pro / macOS 25.5.0

`guard-entry.ts`'s header defended a minimal import graph with a measurement —
"78ms against 33ms" — taken when the file was written. [#372](https://github.com/KenTaniguchi-R/agentcall/issues/372)
then added zod to that graph, via `sensitivity.ts`, and the header kept quoting
a constraint the file had stopped honouring. #377 exists because a measured
property was regressed without a number.

This is the number.

## Method

The hook command the runner installs is `node <path>/guard-entry.js`
(`runner.ts`'s `guardCommand`), one fresh process per tool call. So the thing to
measure is **whole-process wall time**, not module-graph size and not
`performance.now()` around an import — process startup is most of the cost and
has to be in the total.

Harness: `spawnSync` with a real PreToolUse payload on stdin and the env the
runner sets (`AGENTCALL_HOME`, `AGENTCALL_LINE`, `AGENTCALL_CLEARANCE`,
`AGENTCALL_GUARD_MODE`). Five warm-up runs discarded — the first run of any
binary is dominated by page-in, not by imports — then 100 timed runs, reported
as p50.

The payload is one the guard **allows**. Timing a denial would fold an audit-log
write into a number that is supposed to be about imports.

```
node scripts/bench-guard.mjs <repo-root> 100   # not committed; reproduced below
```

## Results

p50 of 100 runs, ±2ms run to run:

| | p50 | over bare node |
|---|---:|---:|
| bare `node`, nothing imported | 24ms | — |
| **`guard-entry.js`** | **48ms** | **+24ms** |
| `index.js`, the full commander graph | 127ms | +102ms |

The original 78/33 comparison is now 127/48. **Both sides grew, and the gap the
separate entry point exists to avoid grew with them — 45ms then, 79ms now.** The
header's central claim is more true than when it was written, which is the
opposite of what the issue assumed and worth stating plainly.

### What zod costs

Not inferred from an `import zod` microbenchmark — measured against a real
zod-free build. `dist/` was copied, `SensitivityMapSchema` replaced with a
passthrough `{ parse: (v) => v }`, the zod import deleted, and the same harness
re-run against both trees:

| | p50 |
|---|---:|
| `guard-entry.js` with zod (current) | 45.8ms |
| `guard-entry.js`, zod stubbed out | 32.7ms |

**zod costs 13.0ms per tool call** — about 60% of guard-entry's entire import
cost, and a 40% increase on the zod-free guard.

(The `import zod` microbenchmark says 15ms, close enough to confirm the stub
was honest but not a substitute for it: it counts zod's own load in isolation,
not zod's load inside a graph that already resolved other modules.)

### The cheaper-zod option, which does not work

zod 4.4.3 exposes `./mini`, `./v4/core`, and friends. Measured as bare imports
over the 24.9ms baseline:

| entry point | over baseline |
|---|---:|
| `zod` | 14.9ms |
| `zod/mini` | 13.8ms |
| `zod/v4/core` | 10.6ms |

`zod/mini` saves 1.1ms — noise. `zod/v4/core` saves 4.3ms but is the internal
core, not a schema-authoring surface. Neither changes the decision, so the
choice really is binary: pay 13ms, or hand-roll a second parser.

## Decision: pay the 13ms

Two reasons, in order of weight.

**1. The alternative puts two parsers on one security boundary.** Dropping zod
from this graph means `guard-entry` hand-parses `sensitivity.json` while
everything else validates it with `SensitivityMapSchema`. When those two
disagree — over a key it does not know, a type it coerces differently, an
`.strict()` rejection it does not make — the guard enforces a map nothing else
in the system believes is in force. That failure is silent and is discovered by
a leak. It is worth much more than 13ms.

**2. 13ms is not on a hot loop.** PreToolUse is gated by a model round-trip: the
agent cannot issue tool calls faster than it can decide to make them, so the
inter-tool interval is a second or more. 13ms lands against that, ~1%, on a call
the CLI documents as taking 30s–5min. `GUARD_TIMEOUT_S` is 30 **seconds**; the
guard runs in 48 **milliseconds**.

The split proposed in #377 step 2 (a zod-free `sensitivity.ts` plus a
`sensitivity-config.ts`) is therefore **not** being done. It buys 13ms and
costs a duplicated validator on the boundary the whole model rests on.

### What was done instead

- The `guard-entry.ts` header now carries these numbers and this reasoning, so
  it stops describing a constraint it does not honour (#377 step 3).
- `guard-entry import budget` in `packages/cli/test/guard-entry.test.ts` walks
  the built graph and pins the third-party imports to exactly `zod`, from
  exactly `sensitivity.js`. A comment could not catch #372 growing this graph;
  a test can. Verified by planting a second zod import in `dist/paths.js` and
  confirming the test fails.
- Stale `~33ms` figures in `runner.ts` (`GUARD_TIMEOUT_S`) and `verify.ts` (the
  guard binary probe) updated to ~48ms.

## What would change this decision

A **second** package arriving in this graph. 13ms for the boundary validator is
defensible on its own; 13ms plus whatever comes next is a different question,
and the import-budget test is what forces it to be asked.

Also worth revisiting if the guard ever stops being gated by a model
round-trip — a batched or speculative tool-call path would put this on a real
hot loop and invert reason 2.

## Reproducing

The harness is not committed (a benchmark that runs in CI on shared runners
produces numbers nobody can trust). To rebuild it: `spawnSync` the built
`dist/guard-entry.js` with the payload and env described under **Method**,
discard five warm-ups, take the p50 of 100. Compare against `node -e ""` for the
floor and `dist/index.js --version` for the full-graph comparator. For the zod
delta, copy `dist/`, replace the `SensitivityMapSchema` block in
`sensitivity.js` with `{ parse: (v) => v }`, drop its zod import, and run the
same harness against both trees.
