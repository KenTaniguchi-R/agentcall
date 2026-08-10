import { authOf, fetchKeys } from "../api.js";
import { relayUrl } from "../config.js";
import { resolveAddress } from "../contacts.js";
import { getPaths } from "../paths.js";
import { outboundInstallation } from "../outbound.js";
import { resetPeerTrust, verifyAndPinPeer } from "../known-peers.js";
import { fail } from "../errors.js";

export function register(program: { command(name: string): any }): void {
  program
    .command("verify")
    .description("fetch and verify a peer's pinned identity fingerprint")
    .argument("<address>", "contact name or @org/handle to verify")
    .action(async (address: string) => {
      const machine = getPaths();
      try {
        const first = resolveAddress(machine, address);
        if (!first.ok) throw new Error(first.error);
        const ctx = outboundInstallation(machine, first.org);
        const cfg = ctx.config;
        const resolved = resolveAddress(machine, address, cfg.org);
        if (!resolved.ok) throw new Error(resolved.error);
        const bundle = await fetchKeys(
          relayUrl(cfg), authOf(cfg), resolved.handle,
        );
        const peer = await verifyAndPinPeer(machine, resolved.address, bundle);
        console.log(`${peer.address}\nPinned fingerprint: ${peer.fingerprint}\nServed fingerprint: ${peer.fingerprint}`);
      } catch (error) {
        fail(error);
      }
    });

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
