import { authOf, getStatus } from "../api.js";
import { relayUrl } from "../config.js";
import { resolveAddress } from "../contacts.js";
import type { LineContext } from "../line-context.js";
import { pickOutboundLine } from "../outbound.js";
import { getMachinePaths } from "../paths.js";
import { fail } from "../errors.js";

export function register(program: { command(name: string): any }): void {
  program
    .command("status")
    .description("check whether this line's agent is currently online")
    .argument("<address>", "contact name or @org/handle to check")
    .option("--as <line>", "line to check from (defaults to the primary line on the destination's relay)")
    .action(async (address: string, o: { as?: string }) => {
      const machine = getMachinePaths();
      const firstPass = resolveAddress(machine, address);
      if (!firstPass.ok) {
        fail(firstPass.error);
        return;
      }
      let ctx: LineContext;
      try {
        ctx = pickOutboundLine(machine, firstPass.org, { as: o.as });
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
