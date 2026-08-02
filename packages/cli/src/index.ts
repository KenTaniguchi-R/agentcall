import { rmSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { getPaths } from "./paths.js";
import { addressHost, loadConfig, saveConfig, relayUrl, assertCallableConfig } from "./config.js";
import { callAgent, callStatusMessage, CallError } from "./callClient.js";
import { getStatus, fetchCard, rotateToken, createInvite, createRoster, joinRoster, leaveRoster, expelRosterMember, rotateRoster, deleteRoster, ApiError } from "./api.js";
import { startListener } from "./listener.js";
import { runSetup } from "./setup.js";
import { installLaunchAgent, isLaunchAgentInstalled, uninstallLaunchAgent } from "./launchd.js";
import { publishCard } from "./card.js";
import { loadPolicy, savePolicy } from "./policy.js";
import { loadTasks, scaffoldTask } from "./tasks.js";
import { execVerb, type Verb } from "./verbs.js";
import { buildCardReport } from "./lint.js";
import { runDoctor } from "./doctor.js";
import { loadContacts, addContact, removeContact, resolveAddress } from "./contacts.js";
import { findOutbound, loadOutbound, rememberOutbound } from "./contextsOut.js";
import { deleteCached, forgetMembership, loadMemberships, saveMembership } from "./rosters.js";
import { allRostersFailed, DEFAULT_SEARCH_LIMIT, rank, renderResults, sanitize, toEntries, type RosterStatus, type SearchEntry } from "./search.js";
import { refreshRoster } from "./searchRefresh.js";
import { ask } from "./tty.js";

export function createProgram(): Command {
const program = new Command();
program.name("agentcall").description("Call other people's coding agents").version("0.4.0");

program
  .command("setup")
  .description("enroll with an organization invite, configure your agent, and install the background listener")
  .option("--invite <token>", "one-time organization invite (required for first enrollment)")
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
      invite?: string;
      agent?: string;
      relay?: string;
      snippet?: boolean;
      skipLaunchd?: boolean;
      callerOnly?: boolean;
      verify?: boolean;
    }) => {
      const result = await runSetup({
        invite: o.invite,
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
  .command("invite")
  .description("create a one-time invite for your organization")
  .action(async () => {
    const cfg = loadConfig(getPaths());
    try {
      const created = await createInvite(relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token });
      console.log(created.invite);
      console.error(`Expires ${new Date(created.expires_at).toISOString()}`);
    } catch (e) {
      console.error(e instanceof ApiError ? e.message : String(e));
      process.exitCode = 1;
    }
  });

program
  .command("call")
  .description("call another handle's agent with a message and print its reply")
  .argument("<address>", "contact name or handle@host to call")
  .argument("<message...>", "message to send")
  .option("--json", "print the full reply envelope instead of just the text")
  .option("--task <id>", "task from the callee's card to perform (see: agentcall card <address>)")
  .option("--continue", "continue the last conversation with this address")
  .option("--context <id>", "continue a specific conversation by id")
  .action(async (address: string, messageParts: string[], o: { json?: boolean; task?: string; continue?: boolean; context?: string }) => {
    const paths = getPaths();
    // Config is loaded before resolution so the address can be checked against
    // the relay this call will actually dial (see resolveAddress).
    const cfg = loadConfig(paths);
    const parsed = resolveAddress(paths, address, relayUrl(cfg), cfg.org);
    if (!parsed.ok) {
      console.error(parsed.error);
      process.exitCode = 1;
      return;
    }
    const message = messageParts.join(" ");

    // --continue resolves against what the callee told us last time. The task
    // is re-sent explicitly: without it turn 2 would re-run policy resolution
    // and could land on a different task than the context was minted under,
    // which admission would then reject -- a self-inflicted context_unknown.
    let contextId = o.context;
    let task = o.task;
    if (o.continue) {
      if (contextId) {
        console.error("Use --continue or --context, not both.");
        process.exitCode = 1;
        return;
      }
      const prev = findOutbound(loadOutbound(paths), {
        relay: relayUrl(cfg), from: cfg.handle, to: parsed.handle,
      });
      if (!prev) {
        console.error(`No open conversation with ${address}. Call without --continue to start one.`);
        process.exitCode = 1;
        return;
      }
      if (task !== undefined && task !== prev.task) {
        console.error(`That conversation is on task "${prev.task}", not "${task}".`);
        process.exitCode = 1;
        return;
      }
      contextId = prev.context_id;
      task = prev.task;
    }

    try {
      const reply = await callAgent({
        relay: relayUrl(cfg),
        org: cfg.org,
        from: cfg.handle,
        token: cfg.token,
        to: parsed.handle,
        message,
        task,
        contextId,
        onStatus: (s) => console.error(callStatusMessage(s)),
      });
      if (reply.context_id && reply.task) {
        rememberOutbound(paths, {
          relay: relayUrl(cfg), from: cfg.handle, to: parsed.handle,
          task: reply.task, context_id: reply.context_id, at: Date.now(),
        });
        // stderr, never stdout: reply.text must stay pipeable, and this matches
        // the existing "ringing..." / "answered" convention.
        console.error("conversation open — add --continue to follow up");
      }
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
    const paths = getPaths();
    // Presence is caller-only on the relay, so status now needs credentials —
    // this used to fall back to the default relay with no config at all.
    const cfg = loadConfig(paths);
    const cfgRelay = relayUrl(cfg);
    const parsed = resolveAddress(paths, address, cfgRelay, cfg.org);
    if (!parsed.ok) {
      console.error(parsed.error);
      process.exitCode = 1;
      return;
    }
    try {
      const { online } = await getStatus(cfgRelay, parsed.handle, { org: cfg.org, handle: cfg.handle, token: cfg.token });
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
    process.exitCode = await runDoctor({ paths: getPaths() });
  });

program
  .command("card")
  .description("show your own card with problems, another agent's menu, or publish yours (push)")
  .argument("[target]", "contact name or handle@host to fetch, 'push' to publish, or omit to review your own card")
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
    const cfg = loadConfig(paths);
    const parsed = resolveAddress(paths, target, relayUrl(cfg), cfg.org);
    if (!parsed.ok) {
      console.error(`${parsed.error} (or 'push')`);
      process.exitCode = 1;
      return;
    }
    try {
      const card = await fetchCard(
        relayUrl(cfg),
        parsed.handle,
        { org: cfg.org, handle: cfg.handle, token: cfg.token },
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
      const result = addContact(getPaths(), name, address, o.note);
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
      const sorted = [...loadContacts(getPaths()).contacts].sort((a, b) => a.name.localeCompare(b.name));
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
      removeContact(getPaths(), name);
      console.log(`Removed ${name}.`);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
  });

const roster = program.command("roster").description("join and manage discovery rosters for `agentcall search`");

roster
  .command("create")
  .description("create a roster and print its id and join secret")
  .option("--as <name>", "local name to record it under", "roster")
  .action(async (o: { as: string }) => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    try {
      const { roster_id, join_secret, admin_secret } = await createRoster(relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token });
      console.log("Roster created.\n");
      console.log(`  id:     ${roster_id}`);
      console.log(`  join secret:  ${join_secret}`);
      console.log(`  admin secret: ${admin_secret}\n`);
      console.log("Both secrets are shown once and are not recoverable. Store the admin secret in a password manager.");
      console.log("Share only the id and join secret with colleagues:");
      console.log(`  agentcall roster join ${roster_id} --secret ${join_secret} --as ${o.as}`);
      try {
        saveMembership(paths, { name: o.as, relay: relayUrl(cfg), roster_id });
        console.log(`\nSaved locally as "${o.as}".`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          `${message}\nRoster was created but not saved locally. Save it with a different name:\n` +
          `  agentcall roster join ${roster_id} --secret ${join_secret} --as <name>`,
        );
        process.exitCode = 1;
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

roster
  .command("join")
  .description("join a roster so `agentcall search` can see its members")
  .argument("<roster-id>", "roster id shared by whoever created it")
  .requiredOption("--secret <secret>", "the roster's join secret")
  .option("--as <name>", "local name for this roster", "roster")
  .action(async (rosterId: string, o: { secret: string; as: string }) => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    try {
      await joinRoster(relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token }, rosterId, o.secret);
      // The secret is spent here and never written to disk: from now on the
      // handle token plus the relay-side membership row is what authorizes.
      try {
        saveMembership(paths, { name: o.as, relay: relayUrl(cfg), roster_id: rosterId });
        console.log(`Joined. Saved locally as "${o.as}".`);
        console.log(`Try: agentcall search "<what you need to know>"`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          `${message}\nYou joined roster ${rosterId}, but it was not saved locally. Re-run with a different name:\n` +
          `  agentcall roster join ${rosterId} --secret <same-secret> --as <name>`,
        );
        process.exitCode = 1;
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

roster
  .command("list")
  .description("list rosters this install has joined")
  .action(() => {
    const rosters = loadMemberships(getPaths());
    if (rosters.length === 0) {
      console.log("No rosters joined. Ask a colleague for a roster id and secret, then:\n  agentcall roster join <id> --secret <secret> --as <name>");
      return;
    }
    for (const r of rosters) console.log(`${r.name}\t${r.roster_id}\t${r.relay}`);
  });

roster
  .command("leave")
  .description("leave a roster on the relay and remove its local record")
  .argument("<name>", "local roster name")
  .action(async (name: string) => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    try {
      const membership = loadMemberships(paths).find((r) => r.name.toLowerCase() === name.toLowerCase());
      if (!membership) throw new Error(`No roster named "${name}" — run \`agentcall roster list\`.`);
      await leaveRoster(membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id);
      forgetMembership(paths, name);
      deleteCached(paths, name);
      console.log(`Left "${name}" and removed its local record.`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

async function adminSecret(flag?: string): Promise<string> {
  const value = flag ?? process.env.AGENTCALL_ADMIN_SECRET;
  if (value) return value;
  const prompted = (await ask("Admin secret: ")).trim();
  if (!prompted) throw new Error("An admin secret is required.");
  return prompted;
}

async function confirmRoster(name: string, consequence: string, yes?: boolean): Promise<void> {
  if (yes) return;
  const answer = (await ask(`${consequence} Type the roster name "${name}" to continue: `)).trim();
  if (answer !== name) throw new Error("Confirmation did not match; nothing was changed.");
}

function namedRoster(name: string) {
  const membership = loadMemberships(getPaths()).find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (!membership) throw new Error(`No roster named "${name}" — run \`agentcall roster list\`.`);
  return membership;
}

roster
  .command("expel")
  .description("remove a member using the roster admin secret")
  .argument("<name>", "local roster name")
  .argument("<handle>", "member handle to remove")
  .option("--admin-secret <secret>", "admin secret (prefer AGENTCALL_ADMIN_SECRET to avoid shell history)")
  .action(async (name: string, handle: string, o: { adminSecret?: string }) => {
    const cfg = loadConfig(getPaths());
    try {
      const membership = namedRoster(name);
      await expelRosterMember(membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id, handle, await adminSecret(o.adminSecret));
      console.log(`Expelled ${handle}. Rotate the join secret too if that member may still know it.`);
    } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
  });

roster
  .command("rotate")
  .description("replace a roster join secret; --evict also removes every member")
  .argument("<name>", "local roster name")
  .option("--admin-secret <secret>", "admin secret (prefer AGENTCALL_ADMIN_SECRET to avoid shell history)")
  .option("--evict", "remove every current member")
  .option("--yes", "confirm destructive eviction")
  .action(async (name: string, o: { adminSecret?: string; evict?: boolean; yes?: boolean }) => {
    const cfg = loadConfig(getPaths());
    try {
      const membership = namedRoster(name);
      if (o.evict) await confirmRoster(name, "This removes every current member.", o.yes);
      const out = await rotateRoster(membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id, await adminSecret(o.adminSecret), Boolean(o.evict));
      if (o.evict) deleteCached(getPaths(), name);
      console.log(`New join secret: ${out.join_secret}`);
    } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
  });

roster
  .command("delete")
  .description("permanently delete a roster while retaining its relay audit events")
  .argument("<name>", "local roster name")
  .option("--admin-secret <secret>", "admin secret (prefer AGENTCALL_ADMIN_SECRET to avoid shell history)")
  .option("--yes", "confirm deletion")
  .action(async (name: string, o: { adminSecret?: string; yes?: boolean }) => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    try {
      const membership = namedRoster(name);
      await confirmRoster(name, "Roster deletion cannot be undone.", o.yes);
      await deleteRoster(membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id, await adminSecret(o.adminSecret));
      forgetMembership(paths, name);
      deleteCached(paths, name);
      console.log(`Deleted "${name}"; relay audit events were retained.`);
    } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
  });

roster
  .command("forget")
  .description("drop only the local roster record; use `roster leave` to remove relay membership")
  .argument("<name>", "local roster name")
  .action((name: string) => {
    try {
      forgetMembership(getPaths(), name);
      console.log(`Forgot "${name}" locally. Your membership on the relay is unchanged; use \`roster leave\` for removal.`);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
  });

program
  .command("search")
  .description("find which colleague's agent can answer something")
  .argument("<question...>", "what you need to know")
  .option("--roster <name>", "search only this roster (default: all joined rosters)")
  .option("--limit <n>", "maximum results", (v) => Number.parseInt(v, 10), DEFAULT_SEARCH_LIMIT)
  .option("--json", "machine-readable output for your own agent")
  .option("--offline", "never refresh; use whatever is cached")
  .action(async (questionParts: string[], o: { roster?: string; limit: number; json?: boolean; offline?: boolean }) => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    const relay = relayUrl(cfg);
    const identity = { relay, caller: cfg.handle };
    const memberships = loadMemberships(paths)
      .filter((m) => m.relay === relay)
      .filter((m) => !o.roster || m.name.toLowerCase() === o.roster.toLowerCase());

    if (memberships.length === 0) {
      console.error(
        o.roster
          ? `No roster named "${o.roster}" on ${relay} — run \`agentcall roster list\`.`
          : `No rosters joined on ${relay}. Ask a colleague for a roster id and secret, then:\n  agentcall roster join <id> --secret <secret> --as <name>`,
      );
      process.exitCode = 1;
      return;
    }

    const host = addressHost(cfg);
    const entries: SearchEntry[] = [];
    const statuses: RosterStatus[] = [];
    for (const m of memberships) {
      try {
        // Each roster degrades on its own: one unreachable roster must not
        // take down a search across the others.
        const out = await refreshRoster(paths, m.name, m.roster_id, identity, { org: cfg.org, handle: cfg.handle, token: cfg.token }, { offline: o.offline });
        entries.push(...toEntries(m.name, host, out.entries));
        statuses.push({ name: m.name, ageSeconds: out.ageSeconds, stale: out.stale });
      } catch (e) {
        console.error(`${m.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Every roster attempted, every one failed: not a genuine no-results
    // run, so a script or calling agent gating on exit code must be able to
    // tell the difference. Partial failure stays exit 0 — see allRostersFailed.
    if (allRostersFailed(memberships.length, statuses.length)) {
      process.exitCode = 1;
    }

    const results = rank(questionParts.join(" "), entries, o.limit);
    if (o.json) {
      console.log(JSON.stringify({
        query: questionParts.join(" "),
        rosters: statuses.map((s) => ({ name: s.name, cache_age_seconds: s.ageSeconds, stale: s.stale })),
        results: results.map((r) => ({
          roster: r.roster, address: r.address, handle: r.handle, task: r.task,
          name: sanitize(r.name, 100), description: sanitize(r.description, 1000),
          score: r.score, matched: r.matched,
        })),
      }));
      return;
    }
    console.log(renderResults(results, statuses));
  });

function policyVerbAction(verb: Verb) {
  return async (a: string, b?: string) => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    if (!cfg.agent_kind) {
      console.error("This handle is caller-only (no agent configured) — there is no card or policy to manage.");
      process.exitCode = 1;
      return;
    }
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

const task = program.command("task").description("manage the tasks your agent offers");
task
  .command("new")
  .description("scaffold a new task (does not publish it)")
  .argument("<id>", "task id: lowercase kebab-case, becomes the directory name")
  .action((id: string) => {
    const paths = getPaths();
    try {
      const file = scaffoldTask(paths, id);
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
      const { token } = await rotateToken(relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token });
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
