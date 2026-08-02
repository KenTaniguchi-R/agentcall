import { rmSync } from "node:fs";
import { Command } from "commander";
import type { AgentKind } from "@benree/agentcall-shared";
import { getMachinePaths } from "./paths.js";
import { assertCallableLine, relayUrl } from "./config.js";
import { callAgent, CallError } from "./callClient.js";
import { getStatus, fetchCard, ApiError } from "./api.js";
import { startAllListeners } from "./listenAll.js";
import { runSetup } from "./setup.js";
import { uninstallLaunchAgent } from "./launchd.js";
import { publishCard } from "./card.js";
import { loadPolicy, savePolicy } from "./policy.js";
import { loadTasks, scaffoldTask } from "./tasks.js";
import { execVerb, type Verb } from "./verbs.js";
import { buildCardReport } from "./lint.js";
import { runDoctor } from "./doctor.js";
import { loadContacts, addContact, removeContact, resolveAddress } from "./contacts.js";
import { resolveLine } from "./lineContext.js";
import type { LineContext } from "./lineContext.js";
import { rotateLine } from "./commands/rotate.js";

const program = new Command();
program.name("agentcall").description("Call other people's coding agents").version("0.4.0");

program
  .command("setup")
  .description("register a handle, configure your agent, and install the background listener")
  .option("--handle <handle>", "handle to register (prompted if omitted)")
  .option("--agent <agent>", "agent kind: claude or codex (auto-detected if omitted)")
  .option("--relay <url>", "relay URL to register against")
  .option("--no-snippet", "skip appending the agentcall usage snippet to CLAUDE.md/AGENTS.md")
  .option("--skip-launchd", "skip installing the launchd background listener")
  .option("--caller-only", "register a handle to call others without making your own agent callable")
  .option("--no-verify", "skip verifying the agent can answer a test call")
  .action(
    async (o: {
      handle?: string;
      agent?: string;
      relay?: string;
      snippet?: boolean;
      skipLaunchd?: boolean;
      callerOnly?: boolean;
      verify?: boolean;
    }) => {
      const result = await runSetup({
        handle: o.handle,
        agent: o.agent as AgentKind | undefined,
        relay: o.relay,
        snippet: o.snippet,
        skipLaunchd: o.skipLaunchd,
        callerOnly: o.callerOnly,
        verify: o.verify,
      });
      if (!result.ready) process.exitCode = 1;
    },
  );

program
  .command("call")
  .description("call another handle's agent with a message and print its reply")
  .argument("<address>", "contact name or handle@host to call")
  .argument("<message...>", "message to send")
  .option("--json", "print the full reply envelope instead of just the text")
  .option("--task <id>", "task from the callee's card to perform (see: agentcall card <address>)")
  .action(async (address: string, messageParts: string[], o: { json?: boolean; task?: string }) => {
    const machine = getMachinePaths();
    // The line is resolved before address resolution so the address can be
    // checked against the relay this call will actually dial (see
    // resolveAddress). Every line lives on one machine's `--line` selection
    // today; picking a line by the DESTINATION's relay is pickOutboundLine's
    // job (Task 14).
    let ctx: LineContext;
    try {
      ctx = resolveLine(machine);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
      return;
    }
    const cfg = ctx.config;
    const parsed = resolveAddress(machine, address, relayUrl(cfg));
    if (!parsed.ok) {
      console.error(parsed.error);
      process.exitCode = 1;
      return;
    }
    if (parsed.warning) console.error(parsed.warning);
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
  .argument("<address>", "contact name or handle@host to check")
  .action(async (address: string) => {
    const machine = getMachinePaths();
    // Presence is caller-only on the relay, so status needs credentials —
    // this used to fall back to the default relay with no config at all.
    let ctx: LineContext;
    try {
      ctx = resolveLine(machine);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
      return;
    }
    const cfg = ctx.config;
    const cfgRelay = relayUrl(cfg);
    const parsed = resolveAddress(machine, address, cfgRelay);
    if (!parsed.ok) {
      console.error(parsed.error);
      process.exitCode = 1;
      return;
    }
    if (parsed.warning) console.error(parsed.warning);
    try {
      const { online } = await getStatus(cfgRelay, parsed.handle, { handle: cfg.handle, token: cfg.token });
      console.log(online ? "online" : "offline");
      process.exitCode = online ? 0 : 2;
    } catch (e) {
      console.error(e instanceof ApiError ? e.message : String(e));
      process.exitCode = 1;
    }
  });

program
  .command("doctor")
  .description("verify this install can answer calls: binary, auth, agent spawn, listener, relay self-call")
  .action(async () => {
    process.exitCode = await runDoctor({ machine: getMachinePaths() });
  });

program
  .command("card")
  .description("show your own card with problems, another agent's menu, or publish yours (push)")
  .argument("[target]", "contact name or handle@host to fetch, 'push' to publish, or omit to review your own card")
  .option("--line <name>", "line to use (defaults to the primary line)")
  .action(async (target: string | undefined, o: { line?: string }) => {
    const machine = getMachinePaths();
    if (target === undefined) {
      let ctx: LineContext;
      try {
        ctx = resolveLine(machine, { line: o.line });
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exitCode = 1;
        return;
      }
      if (!ctx.config.agent_kind) {
        console.error("This line is caller-only (no agent configured) — no card to review.");
        process.exitCode = 1;
        return;
      }
      const report = buildCardReport(ctx.config, ctx.paths);
      for (const line of report.menu) console.log(line);
      if (report.problems.length > 0) {
        console.log("\nProblems:");
        for (const p of report.problems) console.log(`  ✗ ${p}`);
      }
      if (report.notices.length > 0) {
        console.log("\nNotes:");
        for (const n of report.notices) console.log(`  ! ${n}`);
      }
      if (report.problems.length > 0) process.exitCode = 1;
      return;
    }
    if (target === "push") {
      let ctx: LineContext;
      try {
        ctx = resolveLine(machine, { line: o.line });
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exitCode = 1;
        return;
      }
      if (!ctx.config.agent_kind) {
        console.error("This line is caller-only (no agent configured) and has nothing to publish a card for.");
        process.exitCode = 1;
        return;
      }
      await publishCard(ctx.config, ctx.paths);
      console.log("Card published.");
      return;
    }
    let ctx: LineContext | undefined;
    try { ctx = resolveLine(machine, { line: o.line }); } catch { ctx = undefined; }
    const parsed = resolveAddress(machine, target, relayUrl(ctx?.config));
    if (!parsed.ok) {
      console.error(`${parsed.error} (or 'push')`);
      process.exitCode = 1;
      return;
    }
    if (parsed.warning) console.error(parsed.warning);
    try {
      const card = await fetchCard(
        ctx ? relayUrl(ctx.config) : relayUrl(undefined),
        parsed.handle,
        ctx ? { handle: ctx.config.handle, token: ctx.config.token } : undefined,
      );
      console.log(`${card.handle} (${card.agent_kind})${card.description ? ` — ${card.description}` : ""}`);
      for (const t of card.tasks) {
        console.log(`  ${t.id} — ${t.description}`);
        for (const ex of t.examples) console.log(`      e.g. ${ex}`);
      }
      console.log(`\nCall with: agentcall call ${target} --task <id> "<message>"`);
    } catch (e) {
      console.error(e instanceof ApiError ? e.message : String(e));
      process.exitCode = 1;
    }
  });

const contacts = program.command("contacts").description("manage your local address book of callable agents");
contacts
  .command("add")
  .description("save (or update) a contact so you can call them by name")
  .argument("<name>", "short name to call them by (no @)")
  .argument("<address>", "their handle@host")
  .option("--note <note>", "who they are and what to ask them about")
  .action((name: string, address: string, o: { note?: string }) => {
    try {
      const result = addContact(getMachinePaths(), name, address, o.note);
      console.log(`${result === "added" ? "Added" : "Updated"} ${name} -> ${address}`);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
  });
contacts
  .command("list")
  .description("list saved contacts (name, address, who they are)")
  .option("--json", "print the raw contacts array")
  .action((o: { json?: boolean }) => {
    try {
      const sorted = [...loadContacts(getMachinePaths()).contacts].sort((a, b) => a.name.localeCompare(b.name));
      if (o.json) {
        console.log(JSON.stringify(sorted));
        return;
      }
      if (sorted.length === 0) {
        console.log('No contacts yet. Save one with:\n  agentcall contacts add <name> <handle@host> --note "who they are"\nThen call by name: agentcall call <name> "<message>"');
        return;
      }
      for (const c of sorted) console.log(`${c.name}  ${c.address}${c.note ? `  — ${c.note}` : ""}`);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
  });
contacts
  .command("remove")
  .description("delete a contact")
  .argument("<name>", "contact name to delete")
  .action((name: string) => {
    try {
      removeContact(getMachinePaths(), name);
      console.log(`Removed ${name}.`);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
  });

// Shared by allow/revoke/block/unblock/offer/unoffer: resolve exactly once
// (never once for policy and once for credentials — see LineContext), then
// require the line be callable before touching its policy or card.
async function runPolicyVerb(verb: Verb, a: string, b: string | undefined, opts: { line?: string }): Promise<void> {
  const machine = getMachinePaths();
  let ctx: LineContext;
  try {
    ctx = resolveLine(machine, { line: opts.line });
    assertCallableLine(ctx.config);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exitCode = 1;
    return;
  }
  try {
    const { policy, lines } = execVerb(loadPolicy(ctx.paths), loadTasks(ctx.paths), verb, a, b);
    savePolicy(ctx.paths, policy);
    for (const line of lines) console.log(line);
    try {
      await publishCard(ctx.config, ctx.paths);
      console.log("Card updated.");
    } catch (e) {
      console.error(`Warning: policy saved locally, but the card push failed (${String(e)}). Run \`agentcall card push\` later.`);
    }
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exitCode = 1;
  }
}

const task = program.command("task").description("manage the tasks your agent offers");
task
  .command("new")
  .description("scaffold a new task (does not publish it)")
  .argument("<id>", "task id: lowercase kebab-case, becomes the directory name")
  .option("--line <name>", "line to use (defaults to the primary line)")
  .action((id: string, o: { line?: string }) => {
    let ctx: LineContext;
    try {
      ctx = resolveLine(getMachinePaths(), { line: o.line });
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
      return;
    }
    try {
      const file = scaffoldTask(ctx.paths, id);
      console.log(`Created ${file}\nEdit it, then:`);
      console.log(`  agentcall card                      # check it validates`);
      console.log(`  agentcall offer ${id}    # offer to everyone, or:`);
      console.log(`  agentcall allow <handle> ${id}`);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
  });

program.command("allow").description("grant a caller an extra task (and republish your card)")
  .argument("<handle>").argument("<task-id>").option("--line <name>", "line to use (defaults to the primary line)")
  .action((handle: string, taskId: string, o: { line?: string }) => runPolicyVerb("allow", handle, taskId, o));
program.command("revoke").description("remove a caller's task grant")
  .argument("<handle>").argument("<task-id>").option("--line <name>", "line to use (defaults to the primary line)")
  .action((handle: string, taskId: string, o: { line?: string }) => runPolicyVerb("revoke", handle, taskId, o));
program.command("block").description("refuse all calls from a handle")
  .argument("<handle>").option("--line <name>", "line to use (defaults to the primary line)")
  .action((handle: string, o: { line?: string }) => runPolicyVerb("block", handle, undefined, o));
program.command("unblock").description("lift a block")
  .argument("<handle>").option("--line <name>", "line to use (defaults to the primary line)")
  .action((handle: string, o: { line?: string }) => runPolicyVerb("unblock", handle, undefined, o));
program.command("offer").description("offer a task to any registered caller")
  .argument("<task-id>").option("--line <name>", "line to use (defaults to the primary line)")
  .action((taskId: string, o: { line?: string }) => runPolicyVerb("offer", taskId, undefined, o));
program.command("unoffer").description("stop offering a task publicly")
  .argument("<task-id>").option("--line <name>", "line to use (defaults to the primary line)")
  .action((taskId: string, o: { line?: string }) => runPolicyVerb("unoffer", taskId, undefined, o));

program
  .command("listen")
  .description("run the foreground listener (launchd runs this in the background after setup)")
  .action(() => {
    // One process, every callable line: startAllListeners enumerates
    // ~/.agentcall/lines itself and opens one socket per callable line, so
    // there's no single config/paths pair to load up front here anymore.
    const l = startAllListeners(getMachinePaths());
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
  .command("rotate")
  .description("replace a line's relay token (use if it may have leaked)")
  .option("--line <name>", "line to rotate (defaults to the primary line)")
  .action(async (o: { line?: string }) => {
    let ctx: LineContext;
    try {
      ctx = resolveLine(getMachinePaths(), { line: o.line });
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
      return;
    }
    try {
      // The multi-line listener (Task 8) re-reads each line's config.json on
      // every reconnect, so a running listener — foreground or under launchd —
      // picks up the new token on its own; no restart needed here.
      await rotateLine(ctx);
    } catch (e) {
      console.error(e instanceof ApiError ? e.message : String(e));
      process.exitCode = 1;
    }
  });

program
  .command("uninstall")
  .description("remove the background listener")
  .option("--purge", "also delete ~/.agentcall (config, token, logs)")
  .action((o: { purge?: boolean }) => {
    const machine = getMachinePaths();
    uninstallLaunchAgent(machine);
    if (o.purge) rmSync(machine.dir, { recursive: true, force: true });
    console.log("agentcall listener removed." + (o.purge ? " Config purged." : ""));
  });

program.parseAsync().catch((e) => {
  console.error(String(e));
  process.exitCode = 1;
});
