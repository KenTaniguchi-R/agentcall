// Standalone process entry for the PreToolUse hook. Deliberately NOT a
// subcommand on index.ts: routing through commander and the full import graph
// measured 78ms against 33ms here, and this runs once per tool call.
// Import only what it needs.
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { runGuard } from "./guard.js";
import { getPaths } from "./paths.js";

try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  const out = runGuard(raw, {
    paths: getPaths(),
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
  });

  if (out.stdout) process.stdout.write(out.stdout);
  process.exit(out.exitCode);
} catch {
  // Nothing may escape this file. Any exit that is not 0 or 2 is a
  // non-blocking error to Claude, and the tool call proceeds.
  process.exit(2);
}
