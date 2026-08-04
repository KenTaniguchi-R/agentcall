import { rotateToken } from "../api.js";
import { relayUrl } from "../config.js";
import type { LineContext } from "../lineContext.js";
import { listenerServiceRestartCommand } from "../listener-service.js";
import { loadLineConfig, saveLineConfig } from "../lines.js";
import { withFileLock } from "../file-lock.js";
import { ApiError } from "../api.js";
import { getMachinePaths } from "../paths.js";
import { resolveLine } from "../lineContext.js";

export function register(program: { command(name: string): any }): void {
  program.command("rotate").description("replace a line's relay token (use if it may have leaked)")
    .option("--line <name>", "line to rotate (defaults to the primary line)")
    .action(async (o: { line?: string }) => {
      try { await rotateLine(resolveLine(getMachinePaths(), { line: o.line })); }
      catch (e) { console.error(e instanceof ApiError ? e.message : String(e instanceof Error ? e.message : e)); process.exitCode = 1; }
    });
}

export interface RotateDeps {
  rotate?: typeof rotateToken;
  log?: (line: string) => void;
  platform?: NodeJS.Platform;
}

// One line's token, rewritten in place. The multi-line listener (Task 8)
// re-reads each line's config.json on every reconnect, so a live listener
// picks up the new token on its NEXT reconnect — not immediately: the relay
// only checks the Authorization header at socket establishment, and a
// healthy socket can otherwise sit open for a long time (ping/pong keeps it
// alive without re-authenticating). Because this only ever touches
// ctx.paths for the resolved line, no other line's config is disturbed.
export async function rotateLine(ctx: LineContext, deps: RotateDeps = {}): Promise<void> {
  return withFileLock(ctx.paths.configFile, "line credential", () => rotateLineLocked(ctx, deps));
}

async function rotateLineLocked(ctx: LineContext, deps: RotateDeps): Promise<void> {
  const current = loadLineConfig(ctx.paths);
  const log = deps.log ?? console.log;
  const { token } = await (deps.rotate ?? rotateToken)(
    relayUrl(current), { org: current.org, handle: current.handle, token: current.token },
  );
  saveLineConfig(ctx.paths, { ...current, token });
  // A caller-only line (no agent_kind) has no listener socket of its own — the
  // whole "next reconnect" / "restart to force it off now" paragraph below is
  // about a listener this line doesn't have. Pre-lines code guarded this with
  // `else if (cfg.agent_kind)`; only print it for a line that can actually be
  // listening.
  const restartCommand = listenerServiceRestartCommand(deps.platform);
  const backgroundGuidance = restartCommand
    ? `, or for the background one, \`${restartCommand}\``
    : "";
  const listenerGuidance = current.agent_kind
    ? `, but this line's listener won't use the new one until its next reconnect — other lines are ` +
      `unaffected either way.\n` +
      `If the old token may have leaked, restart the listener now to force it off the relay immediately ` +
      `instead of waiting for that reconnect: \`agentcall listen\` in the foreground${backgroundGuidance}.`
    : ".";
  log(`Token rotated for line "${ctx.name}" (${current.handle}). The old token is invalid for new connections immediately${listenerGuidance}`);
}
