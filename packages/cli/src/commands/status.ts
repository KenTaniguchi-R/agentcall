import { authOf, getStatus } from "../api.js";
import { relayUrl, type Installation } from "../config.js";
import { resolveAddress } from "../contacts.js";
import { outboundInstallation } from "../outbound.js";
import { getPaths } from "../paths.js";
import { fail } from "../errors.js";

export function register(program: { command(name: string): any }): void {
  program
    .command("status")
.description("check whether an agent is currently online")
    .argument("<address>", "contact name or @org/handle to check")
    .action(async (address: string) => {
      const machine = getPaths();
      const firstPass = resolveAddress(machine, address);
      if (!firstPass.ok) {
        fail(firstPass.error);
        return;
      }
      let ctx: Installation;
      try {
        ctx = outboundInstallation(machine, firstPass.org);
      } catch (e) {
        fail(e);
        return;
      }
      const cfg = ctx.config;
      const cfgRelay = relayUrl(cfg);
      const parsed = resolveAddress(machine, address, cfg.org);
      if (!parsed.ok) {
        fail(parsed.error);
        return;
      }
      try {
        const { online } = await getStatus(cfgRelay, parsed.handle, authOf(cfg));
        console.log(online ? "online" : "offline");
        process.exitCode = online ? 0 : 2;
      } catch (e) {
        fail(e);
      }
    });
}
