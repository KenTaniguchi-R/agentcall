import { resolveAddress } from "../contacts.js";
import { getPaths } from "../paths.js";
import { resetPeerTrust } from "../known-peers.js";
import { fail } from "../errors.js";

export function register(program: { command(name: string): any }): void {
  program
    .command("trust")
    .description("manage explicitly pinned peer identities")
    .requiredOption("--reset <address>", "remove one pin after verifying a key change out of band")
    .action(async (o: { reset: string }) => {
      try {
        const machine = getPaths();
        const resolved = resolveAddress(machine, o.reset);
        if (!resolved.ok) throw new Error(resolved.error);
        const address = resolved.address;
        await resetPeerTrust(machine, address);
        console.log(`Removed the identity pin for ${address}. The next verified contact will establish a new pin.`);
      } catch (error) {
        fail(error);
      }
    });
}
