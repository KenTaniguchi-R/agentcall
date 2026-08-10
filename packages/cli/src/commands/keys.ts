import { authOf, publishEncryptionKey, publishIdentityKey } from "../api.js";
import { configAddress, loadInstallation, relayUrl } from "../config.js";
import { getPaths } from "../paths.js";
import { loadKeys } from "../keys.js";
import { fail } from "../errors.js";

export function register(program: { command(name: string): any }): void {
  const keys = program.command("keys").description("manage this installation's end-to-end encryption keys");
  keys
    .command("publish")
    .description("publish the identity and current encryption key already stored on disk")
    .action(async () => {
      try {
        const ctx = loadInstallation(getPaths());
        const cfg = ctx.config;
        const stored = loadKeys(ctx.paths);
        const auth = authOf(cfg);
        await publishIdentityKey(relayUrl(cfg), auth, stored);
        await publishEncryptionKey(relayUrl(cfg), auth, ctx.paths);
        console.log(`Published identity and encryption key for ${configAddress(cfg)}.`);
      } catch (error) {
        fail(error);
      }
    });
}
