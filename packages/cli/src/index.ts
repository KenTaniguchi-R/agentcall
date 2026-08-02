import { rmSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { getPaths } from "./paths.js";
import { loadConfig, saveConfig, relayUrl, assertCallableConfig } from "./config.js";
import { rotateToken, ApiError } from "./api.js";
import { startListener } from "./listener.js";
import { runSetup } from "./setup.js";
import { installLaunchAgent, isLaunchAgentInstalled, uninstallLaunchAgent } from "./launchd.js";
import { runDoctor } from "./doctor.js";
import { DEFAULT_SEARCH_LIMIT } from "./search.js";
import { ExitOnly, realDeps } from "./commands/deps.js";
import { rosterCreate, rosterForget, rosterJoin, rosterList } from "./commands/roster.js";
import { search } from "./commands/search.js";
import { contactsAdd, contactsList, contactsRemove } from "./commands/contacts.js";
import { call, status } from "./commands/call.js";
import { card, taskNew } from "./commands/card.js";
import { policyVerb } from "./commands/policy.js";

export function createProgram(): Command {
const program = new Command();
program.name("agentcall").description("Call other people's coding agents").version("0.4.0");

// The ONLY place that knows about process state. Commands throw; this
// converts a thrown error into the message-plus-exit-code convention. Before
// this existed the same six lines appeared 15 times and the exit code was
// set in 23 places.
function run<A extends unknown[]>(fn: (...a: A) => Promise<void> | void) {
  return async (...a: A) => {
    try {
      await fn(...a);
    } catch (e) {
      // ExitOnly: the failure was already reported (e.g. per-roster errors
      // printed in a loop); a summary message here would be redundant.
      if (!(e instanceof ExitOnly)) console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  };
}

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
        agent: o.agent as "claude" | "codex" | undefined,
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
  .action(run((address: string, messageParts: string[], o: { json?: boolean; task?: string }) =>
    call(realDeps(), address, messageParts, o)));

program
  .command("status")
  .description("check whether a handle's agent is currently online")
  .argument("<address>", "contact name or handle@host to check")
  .action(run((address: string) => status(realDeps(), address)));

program
  .command("doctor")
  .description("verify this install can answer calls: binary, auth, agent spawn, listener, relay self-call")
  .action(async () => {
    process.exitCode = await runDoctor({ paths: getPaths() });
  });

program
  .command("card")
  .description("show your own card with problems, another agent's menu, or publish yours (push)")
  .argument("[target]", "contact name or handle@host to fetch, 'push' to publish, or omit to review your own card")
  .action(run((target?: string) => card(realDeps(), target)));

const contacts = program.command("contacts").description("manage your local address book of callable agents");
contacts
  .command("add")
  .description("save (or update) a contact so you can call them by name")
  .argument("<name>", "short name to call them by (no @)")
  .argument("<address>", "their handle@host")
  .option("--note <note>", "who they are and what to ask them about")
  .action(run((name: string, address: string, o: { note?: string }) => contactsAdd(realDeps(), name, address, o)));
contacts
  .command("list")
  .description("list saved contacts (name, address, who they are)")
  .option("--json", "print the raw contacts array")
  .action(run((o: { json?: boolean }) => contactsList(realDeps(), o)));
contacts
  .command("remove")
  .description("delete a contact")
  .argument("<name>", "contact name to delete")
  .action(run((name: string) => contactsRemove(realDeps(), name)));

const roster = program.command("roster").description("join and manage discovery rosters for `agentcall search`");

roster
  .command("create")
  .description("create a roster and print its id and join secret")
  .option("--as <name>", "local name to record it under", "roster")
  .action(run((o: { as: string }) => rosterCreate(realDeps(), o)));

roster
  .command("join")
  .description("join a roster so `agentcall search` can see its members")
  .argument("<roster-id>", "roster id shared by whoever created it")
  .requiredOption("--secret <secret>", "the roster's join secret")
  .option("--as <name>", "local name for this roster", "roster")
  .action(run((rosterId: string, o: { secret: string; as: string }) => rosterJoin(realDeps(), rosterId, o)));

roster
  .command("list")
  .description("list rosters this install has joined")
  .action(run(() => rosterList(realDeps())));

roster
  .command("forget")
  .description("drop the local record of a roster (does NOT remove your membership on the relay — there is no leave operation)")
  .argument("<name>", "local roster name")
  .action(run((name: string) => rosterForget(realDeps(), name)));

program
  .command("search")
  .description("find which colleague's agent can answer something")
  .argument("<question...>", "what you need to know")
  .option("--roster <name>", "search only this roster (default: all joined rosters)")
  .option("--limit <n>", "maximum results", (v) => Number.parseInt(v, 10), DEFAULT_SEARCH_LIMIT)
  .option("--json", "machine-readable output for your own agent")
  .option("--offline", "never refresh; use whatever is cached")
  .action(run((questionParts: string[], o: { roster?: string; limit: number; json?: boolean; offline?: boolean }) =>
    search(realDeps(), questionParts, o)));

const task = program.command("task").description("manage the tasks your agent offers");
task
  .command("new")
  .description("scaffold a new task (does not publish it)")
  .argument("<id>", "task id: lowercase kebab-case, becomes the directory name")
  .action(run((id: string) => taskNew(realDeps(), id)));

program.command("allow").description("grant a caller an extra task (and republish your card)")
  .argument("<handle>").argument("<task-id>")
  .action(run((handle: string, taskId: string) => policyVerb(realDeps(), "allow", [handle, taskId])));
program.command("revoke").description("remove a caller's task grant")
  .argument("<handle>").argument("<task-id>")
  .action(run((handle: string, taskId: string) => policyVerb(realDeps(), "revoke", [handle, taskId])));
program.command("block").description("refuse all calls from a handle")
  .argument("<handle>").action(run((handle: string) => policyVerb(realDeps(), "block", [handle])));
program.command("unblock").description("lift a block")
  .argument("<handle>").action(run((handle: string) => policyVerb(realDeps(), "unblock", [handle])));
program.command("offer").description("offer a task to any registered caller")
  .argument("<task-id>").action(run((taskId: string) => policyVerb(realDeps(), "offer", [taskId])));
program.command("unoffer").description("stop offering a task publicly")
  .argument("<task-id>").action(run((taskId: string) => policyVerb(realDeps(), "unoffer", [taskId])));

program
  .command("listen")
  .description("run the foreground listener (launchd runs this in the background after setup)")
  .action(() => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    assertCallableConfig(cfg);
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
  .command("rotate")
  .description("replace this install's relay token (use if it may have leaked)")
  .action(async () => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    try {
      const { token } = await rotateToken(relayUrl(cfg), { handle: cfg.handle, token: cfg.token });
      saveConfig(paths, { ...cfg, token });
      console.log(`Token rotated for ${cfg.handle}. The old token no longer works.`);
      // The background listener read the old token at startup and holds it in
      // memory, so without a restart it reconnects with a dead credential and
      // 401s forever. Only restart a listener that's actually installed —
      // installLaunchAgent would otherwise create one the owner opted out of.
      if (isLaunchAgentInstalled(paths)) {
        installLaunchAgent(paths);
        console.log("Background listener restarted with the new token.");
      } else if (cfg.agent_kind) {
        console.log("Restart `agentcall listen` so it picks up the new token.");
      }
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
    const paths = getPaths();
    uninstallLaunchAgent(paths);
    if (o.purge) rmSync(paths.dir, { recursive: true, force: true });
    console.log("agentcall listener removed." + (o.purge ? " Config purged." : ""));
  });

return program;
}

// Commander actions predate this test seam and communicate failure through
// process.exitCode. Isolate that process-global state here so two in-process
// invocations cannot leak a failure into one another (or into Vitest itself).
export interface CliOutput {
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
}

export async function runCli(argv: string[], output: CliOutput = {}): Promise<number> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = createProgram();
    program.configureOutput(output);
    program.exitOverride();
    try {
      await program.parseAsync(argv, { from: "user" });
      return process.exitCode ?? 0;
    } catch (e) {
      if (e instanceof CommanderError) return e.exitCode;
      console.error(String(e));
      return 1;
    }
  } finally {
    process.exitCode = previousExitCode;
  }
}
