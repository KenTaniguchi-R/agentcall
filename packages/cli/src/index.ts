import { rmSync } from "node:fs";
import { Command } from "commander";
import type { AgentKind } from "@benree/agentcall-shared";
import { getMachinePaths } from "./paths.js";
import { assertCallableLine, relayUrl, type LineConfig } from "./config.js";
import { callAgent, CallError } from "./callClient.js";
import { getStatus, fetchCard, ApiError } from "./api.js";
import { startAllListeners } from "./listenAll.js";
import { startListener } from "./listener.js";
import { runSetup } from "./setup.js";
import { uninstallLaunchAgent } from "./launchd.js";
import { publishCard } from "./card.js";
import { loadPolicy, savePolicy } from "./policy.js";
import { loadLineConfig, readyLines } from "./lines.js";
import { loadTasks, scaffoldTask } from "./tasks.js";
import { execVerb, type Verb } from "./verbs.js";
import { buildCardReport } from "./lint.js";
import { runDoctor } from "./doctor.js";
import { loadContacts, addContact, removeContact, resolveAddress } from "./contacts.js";
import { resolveLine } from "./lineContext.js";
import type { LineContext } from "./lineContext.js";
import { pickOutboundLine } from "./outbound.js";
import { rotateLine } from "./commands/rotate.js";
import { addLine, listLinesReport, removeLine, setPrimary } from "./commands/line.js";
import { ask as ttyAsk } from "./tty.js";

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
  .option("--as <line>", "line to call from (defaults to the primary line on the destination's relay)")
  .action(async (address: string, messageParts: string[], o: { json?: boolean; task?: string; as?: string }) => {
    const machine = getMachinePaths();
    // The address is resolved BEFORE line selection now: which line places
    // this call depends on the destination's host (pickOutboundLine matches
    // it against each line's own relay), so the destination has to be known
    // first. No relay is passed to resolveAddress here — with several lines
    // possibly on several relays, "the configured relay" isn't a single
    // thing to compare against anymore; pickOutboundLine's own error already
    // names which relays this machine actually holds lines on when none fit.
    const parsed = resolveAddress(machine, address);
    if (!parsed.ok) {
      console.error(parsed.error);
      process.exitCode = 1;
      return;
    }
    let ctx: LineContext;
    try {
      ctx = pickOutboundLine(machine, `https://${parsed.host}`, { as: o.as });
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
      return;
    }
    const cfg = ctx.config;
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
  .option("--as <line>", "line to check from (defaults to the primary line on the destination's relay)")
  .action(async (address: string, o: { as?: string }) => {
    const machine = getMachinePaths();
    // Presence is caller-only on the relay, so status needs credentials —
    // same reasoning as `call` above for resolving the address before the
    // line: which line has credentials for this relay depends on the
    // destination's host.
    const parsed = resolveAddress(machine, address);
    if (!parsed.ok) {
      console.error(parsed.error);
      process.exitCode = 1;
      return;
    }
    let ctx: LineContext;
    try {
      ctx = pickOutboundLine(machine, `https://${parsed.host}`, { as: o.as });
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
      return;
    }
    const cfg = ctx.config;
    const cfgRelay = relayUrl(cfg);
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
        assertCallableLine(ctx.config);
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
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
        assertCallableLine(ctx.config);
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
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

const line = program.command("line").description("manage the addresses (lines) this machine answers on and calls from");

line
  .command("add")
  .description("register another address on this machine")
  .argument("<name>", "local name for this line, e.g. codex (never shared — the handle is)")
  .option("--handle <handle>", "handle to register (prompted if omitted)")
  .option("--agent <agent>", "agent kind: claude or codex (omit with --caller-only)")
  .option("--relay <url>", "relay URL to register against")
  .option("--caller-only", "register a handle to call others without making this line's agent callable")
  .option("--skip-launchd", "skip reinstalling the background listener")
  .option("--no-verify", "skip verifying the agent can answer a test call")
  .action(
    async (
      name: string,
      o: { handle?: string; agent?: string; relay?: string; callerOnly?: boolean; skipLaunchd?: boolean; verify?: boolean },
    ) => {
      const machine = getMachinePaths();
      if (!o.callerOnly && o.agent !== "claude" && o.agent !== "codex") {
        console.error("Pass --agent claude or --agent codex, or --caller-only for a line that can only call out.");
        process.exitCode = 1;
        return;
      }
      const handle = o.handle ?? (await ttyAsk(`Choose a handle for "${name}" (e.g. ${name}): `)).trim();
      if (!handle) {
        console.error("A handle is required.");
        process.exitCode = 1;
        return;
      }
      const relay = (o.relay ?? relayUrl()).replace(/\/+$/, "");
      try {
        const { address } = await addLine(machine, {
          name,
          handle,
          relay,
          agent: o.callerOnly ? undefined : (o.agent as AgentKind),
          callerOnly: o.callerOnly,
          verify: o.verify,
          installLaunchAgentFn: o.skipLaunchd ? () => {} : undefined,
        });
        console.log(`Added line "${name}": ${address}`);
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exitCode = 1;
      }
    },
  );

line
  .command("list")
  .description("list the addresses this machine holds, which is primary, and whether each is online")
  .action(async () => {
    const machine = getMachinePaths();
    // listLinesReport's presence callback is synchronous (it's a pure report
    // over what's already on disk), so the network round-trip has to happen
    // first: one relay status check per callable line, keyed by handle
    // (unique per machine — addLine refuses a duplicate) since listLinesReport
    // re-reads config from disk itself and won't hand back the same object
    // reference this loop read.
    const online = new Map<string, boolean>();
    for (const l2 of readyLines(machine)) {
      if (!l2.config.agent_kind) continue; // caller-only: nothing listens, nothing to probe
      try {
        online.set(
          l2.config.handle,
          (await getStatus(relayUrl(l2.config), l2.config.handle, { handle: l2.config.handle, token: l2.config.token })).online,
        );
      } catch {
        online.set(l2.config.handle, false);
      }
    }
    const rows = listLinesReport(machine, (cfg: LineConfig) => online.get(cfg.handle) ?? false);
    if (rows.length === 0) {
      console.log("No lines yet. Run `agentcall setup` to create the first one.");
      return;
    }
    for (const r of rows) {
      console.log(`${r.name.padEnd(10)} ${r.address.padEnd(32)} ${r.state}${r.primary ? "   primary" : ""}`);
    }
  });

line
  .command("remove")
  .description("remove a line (archives calls.log; the handle can never be reused, see README)")
  .argument("<name>", "line to remove")
  .option("--yes", "confirm removal — required, since the handle can never be reclaimed")
  .option("--purge", "delete outright instead of archiving calls.log")
  .action((name: string, o: { yes?: boolean; purge?: boolean }) => {
    try {
      removeLine(getMachinePaths(), name, { confirm: o.yes, purge: o.purge });
      console.log(`Removed line "${name}".`);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
  });

line
  .command("primary")
  .description("set which line places an outbound call when several could answer it")
  .argument("<name>", "line to make primary")
  .action((name: string) => {
    try {
      setPrimary(getMachinePaths(), name);
      console.log(`Primary line is now "${name}".`);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
  });

program
  .command("listen")
  .description("run the foreground listener (launchd runs this in the background after setup)")
  .option("--line <name>", "run only this line instead of every callable line")
  .action((o: { line?: string }) => {
    const machine = getMachinePaths();
    let l: { stop(): void };
    if (o.line) {
      // Single-line foreground run: mirrors startAllListeners' own per-line
      // wiring (listenAll.ts) instead of duplicating it — same loadConfig
      // re-read on every reconnect, so a rotated token or edited workdir
      // still takes effect without a restart.
      let ctx: LineContext;
      try {
        ctx = resolveLine(machine, { line: o.line });
        assertCallableLine(ctx.config);
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exitCode = 1;
        return;
      }
      l = startListener({
        relay: relayUrl(ctx.config),
        paths: ctx.paths,
        loadConfig: () => {
          const cfg = loadLineConfig(ctx.paths);
          assertCallableLine(cfg);
          return cfg;
        },
      });
      console.log(`listening as ${ctx.config.handle} (line ${ctx.name})`);
    } else {
      // One process, every callable line: startAllListeners enumerates
      // ~/.agentcall/lines itself and opens one socket per callable line, so
      // there's no single config/paths pair to load up front here.
      l = startAllListeners(machine);
    }
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
