import { publishEncryptionKey, publishIdentityKey } from "../api.js";
import { addressHost, relayUrl } from "../config.js";
import { getMachinePaths } from "../paths.js";
import { resolveLine } from "../lineContext.js";
import { loadKeys } from "../keys.js";

export function register(program: { command(name: string): any }): void {
  const keys = program.command("keys").description("manage this line's end-to-end encryption keys");
  keys
    .command("publish")
    .description("publish the identity and current encryption key already stored on disk")
    .option("--line <name>", "line whose persisted keys to publish")
    .action(async (o: { line?: string }) => {
      try {
        const ctx = resolveLine(getMachinePaths(), o);
        const cfg = ctx.config;
        const stored = loadKeys(ctx.paths);
        const auth = { org: cfg.org, handle: cfg.handle, token: cfg.token };
        const relayHost = addressHost(cfg);
        await publishIdentityKey(relayUrl(cfg), auth, stored, relayHost);
        await publishEncryptionKey(relayUrl(cfg), auth, ctx.paths, relayHost);
        console.log(`Published identity and encryption key for ${cfg.handle}@${relayHost}.`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
