import { realpathSync } from "node:fs";
import { FAIL_CLOSED_REASON, runGuard } from "./guard.js";
import { getPaths } from "./paths.js";
import { loadScope } from "./scope.js";
import { appendPrivateLogLine } from "./audit-log.js";

const paths = getPaths();

try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const out = runGuard(raw, {
    paths,
    callId: process.env.AGENTCALL_CALL_ID ?? "unknown",
    correlationId: process.env.AGENTCALL_CORRELATION_ID,
    now: () => new Date().toISOString(),
    realpath: realpathSync,
    appendLine: appendPrivateLogLine,
    scope: loadScope(paths),
  });
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr + "\n");
  process.exit(out.exitCode);
} catch {
  process.stderr.write(FAIL_CLOSED_REASON + "\n");
  process.exit(2);
}
