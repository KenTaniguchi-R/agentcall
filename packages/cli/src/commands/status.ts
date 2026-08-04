import { ApiError, getStatus } from "../api.js";
import { relayUrl } from "../config.js";
import { resolveAddress } from "../contacts.js";
import type { LineContext } from "../lineContext.js";
import { pickOutboundLine } from "../outbound.js";
import { getMachinePaths } from "../paths.js";

export function register(program: { command(name: string): any }): void {
  program
    .command("status")
    .description("check whether a handle's agent is currently online")
    .argument("<address>", "contact name or handle@host to check")
    .option("--as <line>", "line to check from (defaults to the primary line on the destination's relay)")
    .action(async (address: string, o: { as?: string }) => {
      const machine = getMachinePaths();
      const firstPass = resolveAddress(machine, address);
      if (!firstPass.ok) {
        console.error(firstPass.error);
        process.exitCode = 1;
        return;
      }
      let ctx: LineContext;
      try {
        ctx = pickOutboundLine(machine, `https://${firstPass.host}`, { as: o.as });
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exitCode = 1;
        return;
      }
      const cfg = ctx.config;
      const cfgRelay = relayUrl(cfg);
      const parsed = resolveAddress(machine, address, cfgRelay, cfg.org);
      if (!parsed.ok) {
        console.error(parsed.error);
        process.exitCode = 1;
        return;
      }
      if (parsed.warning) console.error(parsed.warning);
      try {
        const { online } = await getStatus(cfgRelay, parsed.handle, { org: cfg.org, handle: cfg.handle, token: cfg.token });
        console.log(online ? "online" : "offline");
        process.exitCode = online ? 0 : 2;
      } catch (e) {
        console.error(e instanceof ApiError ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}
