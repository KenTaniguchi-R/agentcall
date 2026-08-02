// Standalone process entry for the PreToolUse hook. Deliberately NOT a
// subcommand on index.ts: routing through commander and the full import graph
// measured 78ms against 33ms here, and this runs once per tool call.
// Import only what it needs.
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { FAIL_CLOSED_REASON, runGuard } from "./guard.js";
// From lineName.js, not lines.js: lines.js imports zod at module scope (for
// LineConfigSchema), and this file is a standalone process entry that runs
// once per tool call — see the header comment above for why it stays a
// minimal import graph. Pulling zod in here to validate one env var would be
// exactly the cost that comment exists to avoid.
import { LINE_NAME_RE } from "./lineName.js";
import { getLinePaths, getMachinePaths } from "./paths.js";

// Only the exact string opts out of enforcement. Anything else — a typo, a
// stale value, an empty string — enforces, so a mangled env var cannot
// silently downgrade the guard to watching.
const mode = process.env.AGENTCALL_GUARD_MODE === "observe" ? "observe" : "enforce";

const machine = getMachinePaths();

// The guard runs as a subprocess of the answering agent and has no other way
// to learn which line's call it is policing. Without it, tool events would be
// audited against the wrong line — so an absent or malformed value fails
// closed rather than guessing. Unconditional on `mode`: this indicates a
// wiring bug (the runner always sets this env var), not an ordinary decide()
// failure, so it is not eligible for observe mode's fail-open treatment.
const lineName = process.env.AGENTCALL_LINE ?? "";
if (!LINE_NAME_RE.test(lineName)) {
  // The one event that means "the guard is unwired" must not be the one
  // event that leaves no audit trace. There is no LinePaths to log against —
  // that is exactly the problem — so this goes to the line-independent
  // listenerLog instead, the only log reachable without already knowing
  // which line. Best-effort: a log write failing here must not change the
  // exit code, since the fail-closed exit below is what actually blocks.
  try {
    mkdirSync(dirname(machine.listenerLog), { recursive: true });
    appendFileSync(machine.listenerLog, JSON.stringify({
      ts: new Date().toISOString(), type: "guard_unwired",
      call_id: process.env.AGENTCALL_CALL_ID ?? "unknown",
    }) + "\n");
  } catch { /* the exit below still fails closed regardless */ }
  process.stderr.write(FAIL_CLOSED_REASON + "\n");
  process.exit(2);
}

try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  const out = runGuard(raw, {
    line: getLinePaths(machine, lineName),
    callId: process.env.AGENTCALL_CALL_ID ?? "unknown",
    now: () => new Date().toISOString(),
    // Plain realpathSync, which THROWS on a path that does not exist. That is
    // required: canonical() catches it and walks up to the longest existing
    // ancestor. Swallowing the throw here and returning the text unchanged is
    // what let a Write through /tmp/link (-> ~/.ssh) land inside ~/.ssh.
    realpath: realpathSync,
    appendLine: (file, line) => {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, line + "\n");
    },
    allowedRoot: process.env.AGENTCALL_ALLOWED_ROOT,
  }, mode);

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
  if (mode !== "observe") process.stderr.write(FAIL_CLOSED_REASON + "\n");
  process.exit(mode === "observe" ? 0 : 2);
}
