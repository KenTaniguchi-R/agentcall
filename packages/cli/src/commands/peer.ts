import { fetchKeys } from "../api.js";
import { relayUrl } from "../config.js";
import { resolveAddress } from "../contacts.js";
import { getMachinePaths } from "../paths.js";
import { pickOutboundLine } from "../outbound.js";
import { resetPeerTrust, verifyAndPinPeer } from "../known-peers.js";

export function register(program: { command(name: string): any }): void {
  program
    .command("verify")
    .description("fetch and verify a peer's pinned identity fingerprint")
    .argument("<address>", "contact name or @org/handle to verify")
    .option("--as <line>", "line whose relay credentials to use")
    .action(async (address: string, o: { as?: string }) => {
      const machine = getMachinePaths();
      try {
        const first = resolveAddress(machine, address);
        if (!first.ok) throw new Error(first.error);
        const ctx = pickOutboundLine(machine, first.org, { as: o.as });
        const cfg = ctx.config;
        const resolved = resolveAddress(machine, address, relayUrl(cfg), cfg.org);
        if (!resolved.ok) throw new Error(resolved.error);
        const bundle = await fetchKeys(
          relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token }, resolved.handle,
        );
        const peer = await verifyAndPinPeer(machine, resolved.address, bundle);
        console.log(`${peer.address}\nPinned fingerprint: ${peer.fingerprint}\nServed fingerprint: ${peer.fingerprint}`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });

  program
    .command("trust")
    .description("manage explicitly pinned peer identities")
    .requiredOption("--reset <address>", "remove one pin after verifying a key change out of band")
    .action(async (o: { reset: string }) => {
      try {
        const machine = getMachinePaths();
        const resolved = resolveAddress(machine, o.reset);
        if (!resolved.ok) throw new Error(resolved.error);
        const address = resolved.address;
        await resetPeerTrust(machine, address);
        console.log(`Removed the identity pin for ${address}. The next verified contact will establish a new pin.`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
