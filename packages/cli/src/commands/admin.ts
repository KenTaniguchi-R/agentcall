import type { Command } from "commander";
import { authOf, publishEncryptionKey, publishIdentityKey } from "../api.js";
import { publishCard } from "../card.js";
import {
  assertCallable,
  configAddress,
  loadInstallation,
  relayUrl,
} from "../config.js";
import { fail } from "../errors.js";
import { loadKeys } from "../keys.js";
import { getPaths } from "../paths.js";

export function register(program: Command): void {
  const admin = program.command("admin").description("explicit remote publication operations");

  const card = admin.command("card").description("administer this installation's published card");
  card.command("publish")
    .description("publish the current local card to the relay")
    .action(async () => {
      try {
        const ctx = loadInstallation(getPaths());
        assertCallable(ctx.config);
        await publishCard(ctx.config, ctx.paths);
        console.log("Card published.");
      } catch (error) {
        fail(error);
      }
    });

  const keys = admin.command("keys").description("administer this installation's published keys");
  keys.command("publish")
    .description("publish the identity and current encryption key already stored on disk")
    .action(async () => {
      try {
        const ctx = loadInstallation(getPaths());
        const stored = loadKeys(ctx.paths);
        const auth = authOf(ctx.config);
        await publishIdentityKey(relayUrl(ctx.config), auth, stored);
        await publishEncryptionKey(relayUrl(ctx.config), auth, ctx.paths);
        console.log(`Published identity and encryption key for ${configAddress(ctx.config)}.`);
      } catch (error) {
        fail(error);
      }
    });
}
