import { rmSync } from "node:fs";
import { Command } from "commander";
import { parseAddress } from "@benree/agentcall-shared";
import { getPaths } from "./paths.js";
import { loadConfig, relayUrl } from "./config.js";
import { callAgent, CallError } from "./callClient.js";
import { getStatus, ApiError } from "./api.js";
import { startListener } from "./listener.js";
import { runSetup } from "./setup.js";
import { uninstallLaunchAgent } from "./launchd.js";

const program = new Command();
program.name("agentcall").description("Call other people's coding agents").version("0.1.1");

program
  .command("setup")
  .description("register a handle, configure your agent, and install the background listener")
  .option("--handle <handle>", "handle to register (prompted if omitted)")
  .option("--agent <agent>", "agent kind: claude or codex (auto-detected if omitted)")
  .option("--relay <url>", "relay URL to register against")
  .option("--no-snippet", "skip appending the agentcall usage snippet to CLAUDE.md/AGENTS.md")
  .option("--skip-launchd", "skip installing the launchd background listener")
  .action(async (o: { handle?: string; agent?: string; relay?: string; snippet?: boolean; skipLaunchd?: boolean }) => {
    await runSetup({
      handle: o.handle,
      agent: o.agent as "claude" | "codex" | undefined,
      relay: o.relay,
      snippet: o.snippet,
      skipLaunchd: o.skipLaunchd,
    });
  });

program
  .command("call")
  .description("call another handle's agent with a message and print its reply")
  .argument("<address>", "handle@host to call")
  .argument("<message...>", "message to send")
  .option("--json", "print the full reply envelope instead of just the text")
  .action(async (address: string, messageParts: string[], o: { json?: boolean }) => {
    const parsed = parseAddress(address);
    if (!parsed) {
      console.error(`Invalid address: ${address} (expected handle@host)`);
      process.exitCode = 1;
      return;
    }
    const paths = getPaths();
    const cfg = loadConfig(paths);
    const message = messageParts.join(" ");
    try {
      const reply = await callAgent({
        relay: relayUrl(cfg),
        from: cfg.handle,
        token: cfg.token,
        to: parsed.handle,
        message,
        onStatus: (s) => console.error(s === "ringing" ? "ringing..." : "answered, agent working..."),
      });
      console.log(o.json ? JSON.stringify(reply) : reply.text);
    } catch (e) {
      console.error(e instanceof CallError ? `Call failed (${e.code}): ${e.message}` : String(e));
      process.exitCode = 1;
      return;
    }
  });

program
  .command("status")
  .description("check whether a handle's agent is currently online")
  .argument("<address>", "handle@host to check")
  .action(async (address: string) => {
    const parsed = parseAddress(address);
    if (!parsed) {
      console.error(`Invalid address: ${address} (expected handle@host)`);
      process.exitCode = 1;
      return;
    }
    const paths = getPaths();
    let cfgRelay: string;
    try {
      cfgRelay = relayUrl(loadConfig(paths));
    } catch {
      cfgRelay = relayUrl(undefined);
    }
    try {
      const { online } = await getStatus(cfgRelay, parsed.handle);
      console.log(online ? "online" : "offline");
      process.exitCode = online ? 0 : 2;
    } catch (e) {
      console.error(e instanceof ApiError ? e.message : String(e));
      process.exitCode = 1;
    }
  });

program
  .command("listen")
  .description("run the foreground listener (launchd runs this in the background after setup)")
  .action(() => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    console.log(`agentcall listener starting for ${cfg.handle} -> ${relayUrl(cfg)}`);
    const l = startListener({ relay: relayUrl(cfg), config: cfg, paths });
    process.on("SIGTERM", () => {
      l.stop();
      process.exit(0);
    });
    process.on("SIGINT", () => {
      l.stop();
      process.exit(0);
    });
    // Keep the process alive without a busy loop; setInterval's max delay.
    setInterval(() => {}, 1 << 30);
  });

program
  .command("uninstall")
  .description("remove the background listener")
  .option("--purge", "also delete ~/.agentcall (config, token, srt.json, logs)")
  .action((o: { purge?: boolean }) => {
    const paths = getPaths();
    uninstallLaunchAgent(paths);
    if (o.purge) rmSync(paths.dir, { recursive: true, force: true });
    console.log("agentcall listener removed." + (o.purge ? " Config purged." : ""));
  });

program.parseAsync().catch((e) => {
  console.error(String(e));
  process.exitCode = 1;
});
