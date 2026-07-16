import { rmSync } from "node:fs";
import { Command } from "commander";
import { parseAddress } from "@benree/agentcall-shared";
import { getPaths } from "./paths.js";
import { loadConfig, relayUrl } from "./config.js";
import { callAgent, CallError } from "./callClient.js";
import { getStatus, fetchCard, ApiError } from "./api.js";
import { startListener } from "./listener.js";
import { runSetup } from "./setup.js";
import { uninstallLaunchAgent } from "./launchd.js";
import { publishCard } from "./card.js";
import { loadPolicy, savePolicy } from "./policy.js";
import { loadTasks } from "./tasks.js";
import { execVerb, type Verb } from "./verbs.js";
import { buildCardReport } from "./lint.js";

const program = new Command();
program.name("agentcall").description("Call other people's coding agents").version("0.1.2");

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
  .option("--task <id>", "task from the callee's card to perform (see: agentcall card <address>)")
  .action(async (address: string, messageParts: string[], o: { json?: boolean; task?: string }) => {
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
        task: o.task,
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
  .command("card")
  .description("show your own card with problems, another agent's menu, or publish yours (push)")
  .argument("[target]", "handle@host to fetch, 'push' to publish, or omit to review your own card")
  .action(async (target?: string) => {
    const paths = getPaths();
    if (target === undefined) {
      const cfg = loadConfig(paths);
      if (!cfg.agent_kind) {
        console.error("This handle is caller-only (no agent configured) — no card to review.");
        process.exitCode = 1;
        return;
      }
      const report = buildCardReport(cfg, paths);
      for (const line of report.menu) console.log(line);
      if (report.problems.length || report.notices.length) console.log("\nProblems:");
      for (const p of report.problems) console.log(`  ✗ ${p}`);
      for (const n of report.notices) console.log(`  ! ${n}`);
      if (report.problems.length > 0) process.exitCode = 1;
      return;
    }
    if (target === "push") {
      const cfg = loadConfig(paths);
      if (!cfg.agent_kind) {
        console.error("This handle is caller-only (no agent configured) and has nothing to publish a card for.");
        process.exitCode = 1;
        return;
      }
      await publishCard(cfg, paths);
      console.log("Card published.");
      return;
    }
    const parsed = parseAddress(target);
    if (!parsed) {
      console.error(`Invalid address: ${target} (expected handle@host, or 'push')`);
      process.exitCode = 1;
      return;
    }
    let cfg;
    try { cfg = loadConfig(paths); } catch { cfg = undefined; }
    try {
      const card = await fetchCard(
        cfg ? relayUrl(cfg) : relayUrl(undefined),
        parsed.handle,
        cfg ? { handle: cfg.handle, token: cfg.token } : undefined,
      );
      console.log(`${card.handle} (${card.agent_kind})${card.description ? ` — ${card.description}` : ""}`);
      for (const t of card.tasks) {
        console.log(`  ${t.id} [${t.tier}] — ${t.description}`);
        for (const ex of t.examples) console.log(`      e.g. ${ex}`);
      }
      console.log(`\nCall with: agentcall call ${target} --task <id> "<message>"`);
    } catch (e) {
      console.error(e instanceof ApiError ? e.message : String(e));
      process.exitCode = 1;
    }
  });

function policyVerbAction(verb: Verb) {
  return async (a: string, b?: string) => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    try {
      const { policy, lines } = execVerb(loadPolicy(paths), loadTasks(paths), verb, a, b);
      savePolicy(paths, policy);
      for (const line of lines) console.log(line);
      try {
        await publishCard(cfg, paths);
        console.log("Card updated.");
      } catch (e) {
        console.error(`Warning: policy saved locally, but the card push failed (${String(e)}). Run \`agentcall card push\` later.`);
      }
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
  };
}

program.command("allow").description("grant a caller an extra task (and republish your card)")
  .argument("<handle>").argument("<task-id>").action(policyVerbAction("allow"));
program.command("revoke").description("remove a caller's task grant")
  .argument("<handle>").argument("<task-id>").action(policyVerbAction("revoke"));
program.command("block").description("refuse all calls from a handle")
  .argument("<handle>").action(policyVerbAction("block"));
program.command("unblock").description("lift a block")
  .argument("<handle>").action(policyVerbAction("unblock"));
program.command("offer").description("offer a task to any registered caller")
  .argument("<task-id>").action(policyVerbAction("offer"));
program.command("unoffer").description("stop offering a task publicly")
  .argument("<task-id>").action(policyVerbAction("unoffer"));

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
