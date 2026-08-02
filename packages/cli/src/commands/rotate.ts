import { rotateToken } from "../api.js";
import { relayUrl } from "../config.js";
import type { LineContext } from "../lineContext.js";
import { saveLineConfig } from "../lines.js";

export interface RotateDeps {
  rotate?: typeof rotateToken;
  log?: (line: string) => void;
}

// One line's token, rewritten in place. The multi-line listener (Task 8)
// re-reads each line's config.json on every reconnect, so a live listener
// picks up the new token on its own without a restart — and because this
// only ever touches ctx.paths for the resolved line, no other line's
// config is disturbed.
export async function rotateLine(ctx: LineContext, deps: RotateDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const { token } = await (deps.rotate ?? rotateToken)(
    relayUrl(ctx.config), { handle: ctx.config.handle, token: ctx.config.token },
  );
  saveLineConfig(ctx.paths, { ...ctx.config, token });
  log(
    `Token rotated for line "${ctx.name}" (${ctx.config.handle}). The old token no longer works.\n` +
      `The listener re-reads config on reconnect, so it picks this up without a restart; ` +
      `other lines are unaffected.`,
  );
}
