import { rotateToken } from "../api.js";
import { relayUrl } from "../config.js";
import { LAUNCH_LABEL } from "../launchd.js";
import type { LineContext } from "../lineContext.js";
import { saveLineConfig } from "../lines.js";

export interface RotateDeps {
  rotate?: typeof rotateToken;
  log?: (line: string) => void;
}

// One line's token, rewritten in place. The multi-line listener (Task 8)
// re-reads each line's config.json on every reconnect, so a live listener
// picks up the new token on its NEXT reconnect — not immediately: the relay
// only checks the Authorization header at socket establishment, and a
// healthy socket can otherwise sit open for a long time (ping/pong keeps it
// alive without re-authenticating). Because this only ever touches
// ctx.paths for the resolved line, no other line's config is disturbed.
export async function rotateLine(ctx: LineContext, deps: RotateDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const { token } = await (deps.rotate ?? rotateToken)(
    relayUrl(ctx.config), { org: ctx.config.org, handle: ctx.config.handle, token: ctx.config.token },
  );
  saveLineConfig(ctx.paths, { ...ctx.config, token });
  // A caller-only line (no agent_kind) has no listener socket of its own — the
  // whole "next reconnect" / "restart to force it off now" paragraph below is
  // about a listener this line doesn't have. Pre-lines code guarded this with
  // `else if (cfg.agent_kind)`; only print it for a line that can actually be
  // listening.
  const listenerGuidance = ctx.config.agent_kind
    ? `, but this line's listener won't use the new one until its next reconnect — other lines are ` +
      `unaffected either way.\n` +
      `If the old token may have leaked, restart the listener now to force it off the relay immediately ` +
      `instead of waiting for that reconnect: \`agentcall listen\` in the foreground, or for the background ` +
      `one, \`launchctl kickstart -k gui/$UID/${LAUNCH_LABEL}\`.`
    : ".";
  log(`Token rotated for line "${ctx.name}" (${ctx.config.handle}). The old token is invalid for new connections immediately${listenerGuidance}`);
}
