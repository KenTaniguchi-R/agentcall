// Standalone process entry for the PreToolUse hook. Deliberately NOT a
// subcommand on index.ts: this runs once per tool call, as its own node
// process, so the whole import graph is paid every time.
//
// Re-measured 2026-08-06 on node 24 (#377; method and raw numbers in
// docs/research/2026-08-06-guard-entry-import-cost.md), p50 of 100 runs:
//
//   bare node, nothing imported          24ms
//   THIS FILE                            48ms
//   index.js, the full commander graph  127ms
//
// The original header quoted 78ms against 33ms. Both sides grew; the gap this
// file exists to avoid grew with them, from 45ms to 79ms per tool call. The
// split is earning more than when it was written, not less.
//
// Of this file's 24ms over bare node, 13ms is zod, reached only through
// sensitivity.ts's SensitivityMapSchema. Measured against a real zod-free
// build, and ACCEPTED rather than removed: the sensitivity map is the security
// boundary, and the only way to drop zod here is to hand-roll a second parser
// for it. Two parsers on one boundary can disagree, and when they do the guard
// enforces a map nothing else believes is in force — a silent failure worth far
// more than 13ms. The cost is also not on a hot loop: PreToolUse is gated by a
// model round-trip, so 13ms lands against an inter-tool interval of a second or
// more. (zod/mini and zod/v4/core were measured too. They save 1ms and 4ms,
// which does not change the trade.)
//
// Still import only what this needs. `guard-entry import budget` in
// test/guard-entry.test.ts pins the third-party graph to exactly zod, from
// exactly sensitivity.js, so the next package to arrive here is a decision
// someone makes rather than one that happens — which is how #372 grew this
// graph while the header still claimed it was minimal.
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { FAIL_CLOSED_REASON, runGuard } from "./guard.js";
// From line-name.js, not lines.js. Not about avoiding zod — sensitivity.js
// already brings it in, and the header above explains why that was accepted.
// It is about not adding a MODULE: lines.js carries LineConfigSchema and the
// config-loading graph behind it, all to validate one env var against a regex
// that line-name.js exports on its own. The budget is the graph, not the
// package count.
import { LINE_NAME_RE } from "./line-name.js";
import { getLinePaths, getMachinePaths } from "./paths.js";
// The one import that costs a package (13ms; see the header). It is here
// because the map is the boundary and a parsed boundary has to be validated.
import { loadSensitivityMap, withFloor } from "./sensitivity.js";
import { appendPrivateLogLine } from "./audit-log.js";

const machine = getMachinePaths();

// The guard runs as a subprocess of the answering agent and has no other way
// to learn which line's call it is policing. Without it, tool events would be
// audited against the wrong line — so an absent or malformed value fails
// closed rather than guessing. This indicates a
// wiring bug (the runner always sets this env var), not an ordinary decide()
// wiring bug rather than an ordinary decide() failure.
// The one event that means "the guard is unwired" must not be the one event
// that leaves no audit trace. There is no LinePaths to log against — that is
// exactly the problem — so this goes to the line-independent listenerLog, the
// only log reachable without already knowing which line. Best-effort: a log
// write failing here must not change the exit code, since the fail-closed exit
// is what actually blocks.
function unwired(type: string): never {
  try {
    mkdirSync(dirname(machine.listenerLog), { recursive: true });
    appendFileSync(machine.listenerLog, JSON.stringify({
      ts: new Date().toISOString(), type,
      call_id: process.env.AGENTCALL_CALL_ID ?? "unknown",
      correlation_id: process.env.AGENTCALL_CORRELATION_ID,
    }) + "\n");
  } catch { /* the exit below still fails closed regardless */ }
  process.stderr.write(FAIL_CLOSED_REASON + "\n");
  process.exit(2);
}

const lineName = process.env.AGENTCALL_LINE ?? "";
if (!LINE_NAME_RE.test(lineName)) {
  unwired("guard_unwired");
}

// AGENTCALL_CLEARANCE is gone (2026-08-07). It carried which of `public` /
// `internal` this caller held, and both the levels and the comparison were
// deleted with the lattice: a source is `shared` or `secret`, and a caller who
// is not answered at all never reaches a source, because resolveAdmission
// refuses a blocked caller before the agent spawns. There is nothing left for
// this value to select, and a single-valued parameter threaded through a
// security boundary reads as a check that is not happening.

try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  const out = runGuard(raw, {
    line: getLinePaths(machine, lineName),
    callId: process.env.AGENTCALL_CALL_ID ?? "unknown",
    correlationId: process.env.AGENTCALL_CORRELATION_ID,
    now: () => new Date().toISOString(),
    // Plain realpathSync, which THROWS on a path that does not exist. That is
    // required: canonical() catches it and walks up to the longest existing
    // ancestor. Swallowing the throw here and returning the text unchanged is
    // what let a Write through /tmp/link (-> ~/.ssh) land inside ~/.ssh.
    realpath: realpathSync,
    appendLine: appendPrivateLogLine,
    // Read from disk rather than passed through the environment. The map is
    // the boundary; ~/.agentcall is itself floored `secret`, so the file is not
    // writable by the agent this guard is policing, whereas an env var is
    // inherited state with no such property.
    map: withFloor(loadSensitivityMap(getLinePaths(machine, lineName)), machine.userHome),
  });


  if (out.stdout) process.stdout.write(out.stdout);
  // Codex reads exit 2 as blocking only when stderr carries a reason, and as
  // a merely-failed hook otherwise — in which case it runs the tool. Writing
  // the reason is what keeps exit 2 fail-CLOSED rather than fail-open.
  if (out.stderr) process.stderr.write(out.stderr + "\n");
  process.exit(out.exitCode);
} catch {
  // Nothing may escape this file. Any exit that is not 0 or 2 is a
  // non-blocking error to Claude, and the tool call proceeds. Even here the
  // reason must be written, for the same reason as above.
  process.stderr.write(FAIL_CLOSED_REASON + "\n");
  process.exit(2);
}
