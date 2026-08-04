import type { AgentKind } from "@benree/agentcall-shared";
import type { Command } from "commander";
import { getStatus } from "../api.js";
import { relayUrl, type LineConfig } from "../config.js";
import { getMachinePaths } from "../paths.js";
import { addLine, listLinesReport } from "./line.js";
import { assertValidLineName, readyLines } from "../lines.js";
import { ask } from "../tty.js";

export function register(line: Command): void {
  line.command("add").description("register another address on this machine")
    .argument("<name>", "local name for this line, e.g. codex (never shared — the handle is)")
    .option("--handle <handle>", "handle to register (prompted if omitted)")
    .option("--invite <token>", "one-time organization invite (required — each line enrolls in its own tenant)")
    .option("--agent <agent>", "agent kind: claude or codex (omit with --caller-only)")
    .option("--relay <url>", "relay URL to register against")
    .option("--caller-only", "register a handle to call others without making this line's agent callable")
    .option("--skip-service", "skip reinstalling the background listener service")
    .option("--no-verify", "skip verifying the agent can answer a test call")
    .action(async (name: string, o: { handle?: string; invite?: string; agent?: string; relay?: string; callerOnly?: boolean; skipService?: boolean; verify?: boolean }) => {
      const machine = getMachinePaths();
      if (!o.callerOnly && o.agent !== "claude" && o.agent !== "codex") {
        console.error("Pass --agent claude or --agent codex, or --caller-only for a line that can only call out."); process.exitCode = 1; return;
      }
      try { assertValidLineName(name); } catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exitCode = 1; return; }
      if (!o.invite?.trim()) { console.error(`An organization invite is required. Run \`agentcall line add ${name} --invite <token>\`.`); process.exitCode = 1; return; }
      const handle = o.handle ?? (await ask(`Choose a handle for "${name}" (e.g. ${name}): `)).trim();
      if (!handle) { console.error("A handle is required."); process.exitCode = 1; return; }
      try {
        const { address } = await addLine(machine, {
          name, handle, relay: (o.relay ?? relayUrl()).replace(/\/+$/, ""), invite: o.invite,
          agent: o.callerOnly ? undefined : (o.agent as AgentKind), callerOnly: o.callerOnly,
          verify: o.verify, installListenerServiceFn: o.skipService ? () => {} : undefined,
        });
        console.log(`Added line "${name}": ${address}`);
      } catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exitCode = 1; }
    });

  line.command("list").description("list the addresses this machine holds, which is primary, and whether each is online")
    .option("--json", "print the full row data (name, address, relay, state, primary) as JSON")
    .action(async (o: { json?: boolean }) => {
      const machine = getMachinePaths(); const online = new Map<string, boolean>();
      for (const l2 of readyLines(machine)) {
        if (!l2.config.agent_kind) continue;
        try { online.set(l2.config.handle, (await getStatus(relayUrl(l2.config), l2.config.handle, { org: l2.config.org, handle: l2.config.handle, token: l2.config.token })).online); }
        catch { online.set(l2.config.handle, false); }
      }
      const rows = listLinesReport(machine, (cfg: LineConfig) => online.get(cfg.handle) ?? false);
      if (o.json) { console.log(JSON.stringify(rows)); return; }
      if (rows.length === 0) { console.log("No lines yet. Run `agentcall setup` to create the first one."); return; }
      for (const r of rows) console.log(`${r.name.padEnd(10)} ${r.address.padEnd(32)} ${r.state}${r.primary ? "   primary" : ""}`);
    });
}
