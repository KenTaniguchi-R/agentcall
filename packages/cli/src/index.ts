import { existsSync, rmSync } from "node:fs";
import { Command, CommanderError } from "commander";
import type { AgentKind, AuditCheckpointType, AuditExportEventType } from "@benree/agentcall-shared";
import { getMachinePaths, type LinePaths } from "./paths.js";
import { addressHost, assertCallableLine, relayUrl, resolveLineWorkdir, type LineConfig } from "./config.js";
import { callAgent, callStatusMessage, CallError } from "./callClient.js";
// No rotateToken here: `rotate` goes through commands/rotate.ts's rotateLine,
// which owns the per-line config write and calls the api helper itself.
import { getStatus, fetchCard, createInvite, listInvites, revokeInvite, createRoster, joinRoster, leaveRoster,
  expelRosterMember, issueRosterJoinKey, listRosterJoinKeys, revokeRosterJoinKey, deleteRoster,
  fetchAuditExportPage, ApiError } from "./api.js";
import { startAllListeners } from "./listenAll.js";
import { startListener } from "./listener.js";
import { runSetup } from "./setup.js";
import { uninstallListenerService } from "./listener-service.js";
import { publishCard } from "./card.js";
import { loadPolicy, loadUserPolicy, savePolicy, validatePolicy } from "./policy.js";
import { assertValidLineName, loadLineConfig, readyLines } from "./lines.js";
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
import { findOutbound, loadOutbound, rememberOutbound } from "./contextsOut.js";
import { deleteCached, forgetMembership, loadMemberships, saveMembership } from "./rosters.js";
import { allRostersFailed, DEFAULT_SEARCH_LIMIT, rank, renderResults, sanitize, toEntries, type RosterStatus, type SearchEntry } from "./search.js";
import { refreshRoster } from "./searchRefresh.js";
import { ask } from "./tty.js";
import { renderPolicyReport } from "./policy-report.js";
import { loadLocalHistory, renderLocalHistory } from "./history.js";
import { sanitizeTerminalOutput, stringifyTerminalSafeJson } from "@benree/agentcall-shared";
import { getTelemetry, shutdownTelemetry, telemetrySafely } from "./telemetry.js";

export function createProgram(): Command {
const program = new Command();
program.name("agentcall").description("Call other people's coding agents").version("0.4.0");

const parseAuditTime = (value: string | undefined, flag: string): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${flag} must be an epoch-millisecond or ISO timestamp`);
  return parsed;
};

const parseAuditFilter = (value: string | undefined, flag: string): string | undefined => {
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > 256) throw new Error(`${flag} must contain 1 to 256 characters`);
  return value;
};

const AUDIT_CSV_COLUMNS = [
  "ledger", "id", "event", "action_type", "roster_id", "actor", "actor_type",
  "target_type", "target_id", "target_role", "actor_ip", "actor_country", "description", "at",
] as const satisfies readonly (keyof AuditExportEventType)[];

const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  // Audit fields include peer-controlled handles and descriptions. Quoting is
  // not enough to stop spreadsheet software from evaluating formula prefixes.
  const text = /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const auditCsvRow = (event: AuditExportEventType): string =>
  AUDIT_CSV_COLUMNS.map((column) => csvCell(event[column])).join(",");

program
  .command("setup")
  .description("enroll with an organization invite, configure your agent, and install the background listener")
  .option("--invite <token>", "one-time organization invite (required for first enrollment)")
  .option("--handle <handle>", "handle to register (prompted if omitted)")
  .option("--agent <agent>", "agent kind: claude or codex (auto-detected if omitted)")
  .option("--relay <url>", "relay URL to register against")
  .option("--no-snippet", "skip appending the agentcall usage snippet to CLAUDE.md/AGENTS.md")
  .option("--skip-service", "skip installing the background listener service")
  .option("--caller-only", "register a handle to call others without making your own agent callable")
  .option("--no-verify", "skip verifying the agent can answer a test call")
  .action(
    async (o: {
      handle?: string;
      invite?: string;
      agent?: string;
      relay?: string;
      snippet?: boolean;
      skipService?: boolean;
      callerOnly?: boolean;
      verify?: boolean;
    }) => {
      const result = await runSetup({
        invite: o.invite,
        handle: o.handle,
        agent: o.agent as AgentKind | undefined,
        relay: o.relay,
        snippet: o.snippet,
        skipService: o.skipService,
        callerOnly: o.callerOnly,
        verify: o.verify,
      });
      if (!result.ready) process.exitCode = 1;
    },
  );

// An invite enrolls someone into ONE tenant, and the tenant is a property of
// the line (see config.ts) — so every subcommand here takes `--line`. A machine
// with lines in two orgs must be told which org it is acting in; defaulting to
// the primary silently would invite people into the wrong tenant.
const invite = program.command("invite").description("manage one-time organization invites");

invite
  .command("create")
  .description("create a one-time invite")
  .option("--description <text>", "purpose shown in the organization invite inventory", "")
  .option("--expires-in-days <days>", "expiry from 1 to 90 days", "7")
  .option("--role <role>", "enrolled organization role: member or admin")
  .option("--line <name>", "line whose organization to invite into (defaults to the primary line)")
  .action(async (o: { description: string; expiresInDays: string; role?: string; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      if (o.role !== undefined && o.role !== "admin" && o.role !== "member") {
        throw new Error("--role must be member or admin");
      }
      const created = await createInvite(
        relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token },
        {
          description: o.description, expires_in_days: Number(o.expiresInDays),
          ...(o.role ? { role: o.role } : {}),
        },
      );
      console.log(created.invite);
      console.error(`ID ${created.metadata.id}`);
      console.error(`Expires ${new Date(created.metadata.expires_at).toISOString()}`);
    } catch (e) {
      console.error(e instanceof ApiError ? e.message : String(e));
      process.exitCode = 1;
    }
  });

const audit = program.command("audit").description("export organization audit evidence");

audit
  .command("export")
  .description("stream an administrator-only snapshot as NDJSON or CSV")
  .option("--after <time>", "include events at or after this epoch-millisecond or ISO timestamp")
  .option("--before <time>", "include events before this epoch-millisecond or ISO timestamp")
  .option("--actor <actor>", "include events whose actor field exactly matches")
  .option("--event <event>", "include events whose event type exactly matches")
  .option("--ip <address>", "include events whose source IP exactly matches")
  .option("--format <format>", "output format: ndjson or csv", "ndjson")
  .option("--page-size <count>", "events fetched per relay page, from 1 to 500", "100")
  .option("--line <name>", "line whose organization to export (defaults to the primary line)")
  .action(async (o: {
    after?: string;
    before?: string;
    actor?: string;
    event?: string;
    ip?: string;
    format: string;
    pageSize: string;
    line?: string;
  }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const after = parseAuditTime(o.after, "--after");
      const before = parseAuditTime(o.before, "--before");
      const actor = parseAuditFilter(o.actor, "--actor");
      const event = parseAuditFilter(o.event, "--event");
      const actorIp = parseAuditFilter(o.ip, "--ip");
      const pageSize = Number(o.pageSize);
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
        throw new Error("--page-size must be an integer from 1 to 500");
      }
      if (o.format !== "ndjson" && o.format !== "csv") {
        throw new Error("--format must be ndjson or csv");
      }
      if (o.format === "csv") console.log(AUDIT_CSV_COLUMNS.join(","));
      let pageToken: string | undefined;
      let checkpoint: AuditCheckpointType | undefined;
      do {
        const page = await fetchAuditExportPage(
          relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token },
          {
            after, before, actor, event, actor_ip: actorIp,
            page_size: pageSize, page_token: pageToken,
          },
          { retryRateLimit: true },
        );
        for (const event of page.events) {
          console.log(o.format === "csv" ? auditCsvRow(event) : JSON.stringify(event));
        }
        checkpoint = page.checkpoint;
        pageToken = page.next_page_token || undefined;
      } while (pageToken);
      console.error(`Checkpoint org=${checkpoint?.org_event_id ?? 0} roster=${checkpoint?.roster_event_id ?? 0}`);
    } catch (e) {
      console.error(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

invite
  .command("list")
  .description("list organization invite lifecycle metadata")
  .option("--line <name>", "line whose organization to list (defaults to the primary line)")
  .action(async (o: { line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const invites = await listInvites(relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token });
      console.log(JSON.stringify(invites, null, 2));
    } catch (e) {
      console.error(e instanceof ApiError ? e.message : String(e));
      process.exitCode = 1;
    }
  });

invite
  .command("revoke")
  .description("revoke an unused organization invite")
  .argument("<id>", "64-character invite ID from `agentcall invite list`")
  .option("--line <name>", "line whose organization the invite belongs to (defaults to the primary line)")
  .action(async (id: string, o: { line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const revoked = await revokeInvite(
        relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token }, id,
      );
      console.log(`Revoked ${revoked.id} at ${new Date(revoked.revoked_at).toISOString()}`);
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
  .option("--as <line>", "line to call from (defaults to the primary line on the destination's relay)")
  .option("--continue", "continue the last conversation with this address")
  .option("--context <id>", "continue a specific conversation by id")
  .action(async (address: string, messageParts: string[], o: { json?: boolean; task?: string; as?: string; continue?: boolean; context?: string }) => {
    // Answering agents do not yet receive a relay-minted run credential or an
    // attested delegation chain. Letting the ordinary CLI silently reuse the
    // owner's line token here would erase the original caller and permit
    // accidental A -> B -> A loops. This environment check prevents the
    // supported CLI path, not a hostile process: an agent with shell/read
    // access can remove the variable and reuse config credentials. Structural
    // enforcement requires the brokered design recorded by issue #112.
    if (process.env.AGENTCALL_CALL_ID !== undefined) {
      console.error(
        "Nested agentcall calls are disabled until relay-attested chains and secret-isolated per-run credentials exist.",
      );
      process.exitCode = 1;
      return;
    }
    const machine = getMachinePaths();
    // The address is resolved BEFORE line selection now: which line places
    // this call depends on the destination's host (pickOutboundLine matches
    // it against each line's own relay), so the destination has to be known
    // first. No relay or org is passed on THIS pass — with several lines
    // possibly on several relays and in several tenants, "the configured
    // relay" isn't a single thing to compare against anymore; pickOutboundLine's
    // own error already names which relays this machine actually holds lines on
    // when none fit.
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
    // Second pass, now that the calling line — and therefore the tenant — is
    // known. This is what carries #66's cross-tenant refusal into the per-line
    // model: resolveAddress stays the single resolution path (see contacts.ts)
    // rather than growing a second, drifting copy of the org comparison here.
    const parsed = resolveAddress(machine, address, relayUrl(cfg), cfg.org);
    if (!parsed.ok) {
      console.error(parsed.error);
      process.exitCode = 1;
      return;
    }
    if (parsed.warning) console.error(parsed.warning);
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
      const prev = findOutbound(loadOutbound(ctx.paths), {
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

    const telemetry = getTelemetry();
    const callerSpan = telemetrySafely(() => telemetry?.startCaller({ task, relay: relayUrl(cfg) }));
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
        correlationId: callerSpan?.correlationId,
        traceparent: callerSpan?.traceparent,
        onStatus: (s, frame) => {
          telemetrySafely(() => callerSpan?.setCallId(frame.call_id));
          console.error(callStatusMessage(s));
        },
      });
      telemetrySafely(() => callerSpan?.endSuccess(reply.call_id));
      if (reply.context_id && reply.task) {
        rememberOutbound(ctx.paths, {
          relay: relayUrl(cfg), from: cfg.handle, to: parsed.handle,
          task: reply.task, context_id: reply.context_id, at: Date.now(),
        });
        // stderr, never stdout: reply.text must stay pipeable, and this matches
        // the existing "ringing..." / "answered" convention.
        console.error("conversation open — add --continue to follow up");
      }
      console.log(o.json ? stringifyTerminalSafeJson(reply) : sanitizeTerminalOutput(reply.text));
    } catch (e) {
      telemetrySafely(() => callerSpan?.endError(
        e instanceof CallError ? e.code : "agent_error",
        e instanceof CallError ? e.callId : undefined,
      ));
      console.error(e instanceof CallError ? `Call failed (${e.code}): ${e.message}` : String(e));
      process.exitCode = 1;
      return;
    } finally {
      await shutdownTelemetry();
    }
  });

program
  .command("status")
  .description("check whether a handle's agent is currently online")
  .argument("<address>", "contact name or handle@host to check")
  .option("--as <line>", "line to check from (defaults to the primary line on the destination's relay)")
  .action(async (address: string, o: { as?: string }) => {
    const machine = getMachinePaths();
    // Presence is self-or-shared-roster on the relay (#116), so status needs
    // the viewer's credentials — and WHICH line's credentials matters twice
    // over: it decides both which relay is asked and whether the viewer shares
    // a roster with the target. Same reasoning as `call` above for resolving
    // the address before the line: which line has credentials for this relay
    // depends on the destination's host. The second pass below re-checks the
    // address against the chosen line's tenant, exactly as `call` does.
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

program
  .command("doctor")
  .description("verify this install can answer calls: binary, auth, agent spawn, tool telemetry, listener, relay self-call")
  .action(async () => {
    process.exitCode = await runDoctor({ machine: getMachinePaths() });
  });

program
  .command("history")
  .description("show call activity stored locally on this machine")
  .option("--limit <count>", "maximum newest calls to show (1-100)", "20")
  .option("--json", "print machine-readable local history")
  // calls.log/tools.log are per line, so history is too.
  .option("--line <name>", "line whose history to show (defaults to the primary line)")
  .action((o: { limit: string; json?: boolean; line?: string }) => {
    const limit = Number(o.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      console.error("History limit must be an integer from 1 to 100.");
      process.exitCode = 1;
      return;
    }
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const history = loadLocalHistory(ctx.paths, limit);
    if (history.malformed > 0) {
      console.error(`Skipped ${history.malformed} malformed local history record${history.malformed === 1 ? "" : "s"}.`);
    }
    if (history.truncatedFiles.length > 0) {
      console.error(
        `History scan was limited to the newest 4 MiB of: ${history.truncatedFiles.join(", ")}. ` +
          "Tool counts may be partial.",
      );
    }
    const entries = history.entries;
    console.log(o.json
      ? stringifyTerminalSafeJson(entries)
      : sanitizeTerminalOutput(renderLocalHistory(entries)));
  });

// Shared by `lint` and a bare `card`. Per-line, like everything else that
// reads a policy or a card: `--line` picks which one, defaulting to primary.
const reviewOwnCard = (o: { line?: string }) => {
  let ctx: LineContext;
  try {
    ctx = resolveLine(getMachinePaths(), { line: o.line });
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
};

program
  .command("lint")
  .description("validate tasks, effective policy assertions, and the published card")
  .option("--line <name>", "line to lint (defaults to the primary line)")
  .action(reviewOwnCard);

program
  .command("policy")
  .description("show the effective per-caller and per-task capability policy")
  .option("--line <name>", "line to report on (defaults to the primary line)")
  .action((o: { line?: string }) => {
    let ctx: LineContext;
    try {
      ctx = resolveLine(getMachinePaths(), { line: o.line });
      assertCallableLine(ctx.config);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
      return;
    }
    const cfg = ctx.config;
    try {
      const report = renderPolicyReport(loadPolicy(ctx.paths), loadTasks(ctx.paths), {
        agentKind: cfg.agent_kind,
        // Machine-scoped, not line-scoped: the administrator ceiling applies
        // to every line on this machine (see paths.ts).
        managed: existsSync(ctx.paths.machine.managedPolicyFile),
        defaultWorkdir: resolveLineWorkdir(cfg, ctx.paths).dir,
      });
      console.log(report.trimEnd());
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
  });

program
  .command("card")
  .description("show your own card with problems, another agent's menu, or publish yours (push)")
  .argument("[target]", "contact name or handle@host to fetch, 'push' to publish, or omit to review your own card")
  .option("--line <name>", "line to use (defaults to the primary line)")
  .action(async (target: string | undefined, o: { line?: string }) => {
    const machine = getMachinePaths();
    if (target === undefined) {
      reviewOwnCard(o);
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
    // A resolvable line is now REQUIRED to fetch someone else's card: card
    // reads are authenticated on the relay (fetchCard takes a non-optional
    // Auth), so the old "resolve if you can, fetch anonymously otherwise"
    // fallback would only ever produce a 401. Failing here names the actual
    // problem instead.
    let ctx: LineContext;
    try {
      ctx = resolveLine(machine, { line: o.line });
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
      return;
    }
    const cfg = ctx.config;
    const parsed = resolveAddress(machine, target, relayUrl(cfg), cfg.org);
    if (!parsed.ok) {
      console.error(`${parsed.error} (or 'push')`);
      process.exitCode = 1;
      return;
    }
    if (parsed.warning) console.error(parsed.warning);
    try {
      const card = await fetchCard(
        relayUrl(cfg),
        parsed.handle,
        { org: cfg.org, handle: cfg.handle, token: cfg.token },
      );
      const description = sanitizeTerminalOutput(card.description);
      console.log(`${card.handle} (${card.agent_kind})${description ? ` — ${description}` : ""}`);
      for (const t of card.tasks) {
        console.log(`  ${t.id} — ${sanitizeTerminalOutput(t.description)}`);
        for (const ex of t.examples) console.log(`      e.g. ${sanitizeTerminalOutput(ex)}`);
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

// Rosters are LINE-scoped, not machine-scoped. A roster is membership held by
// a handle on a relay, and a line is exactly "a handle on a relay" — the
// bundle cache even validates (relay, caller, roster_id) on every read (see
// rosters.ts's readCached). Storing memberships per machine would let a line
// in one tenant read a bundle fetched by a line in another, which is the one
// thing that validation exists to prevent. Hence `--line` on every command
// here, and rostersFile/rosterCacheFile living under LinePaths.
const roster = program.command("roster").description("join and manage discovery rosters for `agentcall search`");

// Resolves the line a roster/search command acts as, or reports and exits.
// Returns undefined on failure, having already set process.exitCode.
function lineFor(line: string | undefined): LineContext | undefined {
  try {
    return resolveLine(getMachinePaths(), { line });
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exitCode = 1;
    return undefined;
  }
}

roster
  .command("create")
  .description("create a roster and print its initial reusable join key")
  .option("--as <name>", "local name to record it under", "roster")
  .option("--line <name>", "line to create it as (defaults to the primary line)")
  .action(async (o: { as: string; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const { roster_id, join_key, admin_secret } = await createRoster(relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token });
      console.log("Roster created.\n");
      console.log(`  id:     ${roster_id}`);
      console.log(`  join key:     ${join_key}`);
      console.log(`  admin secret: ${admin_secret}\n`);
      console.log("Both credentials are shown once and are not recoverable. Store the admin secret in a password manager.");
      console.log("Share only the id and join key with colleagues:");
      console.log(`  agentcall roster join ${roster_id} --key ${join_key} --as ${o.as}`);
      try {
        saveMembership(ctx.paths, { name: o.as, relay: relayUrl(cfg), roster_id });
        console.log(`\nSaved locally as "${o.as}".`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          `${message}\nRoster was created but not saved locally. Save it with a different name:\n` +
          `  agentcall roster join ${roster_id} --key ${join_key} --as <name>`,
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
  .requiredOption("--key <key>", "a roster join key")
  .option("--as <name>", "local name for this roster", "roster")
  .option("--line <name>", "line to join as (defaults to the primary line)")
  .action(async (rosterId: string, o: { key: string; as: string; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      await joinRoster(relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token }, rosterId, o.key);
      // The key is spent here and never written to disk: from now on the
      // handle token plus the relay-side membership row is what authorizes.
      try {
        saveMembership(ctx.paths, { name: o.as, relay: relayUrl(cfg), roster_id: rosterId });
        console.log(`Joined. Saved locally as "${o.as}".`);
        console.log(`Try: agentcall search "<what you need to know>"`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          `${message}\nYou joined roster ${rosterId}, but it was not saved locally. Re-run with a different name:\n` +
          `  agentcall roster join ${rosterId} --key <same-key> --as <name>`,
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
  .description("list rosters this line has joined")
  .option("--line <name>", "line to list for (defaults to the primary line)")
  .action((o: { line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const rosters = loadMemberships(ctx.paths);
    if (rosters.length === 0) {
      console.log("No rosters joined. Ask a colleague for a roster id and join key, then:\n  agentcall roster join <id> --key <key> --as <name>");
      return;
    }
    for (const r of rosters) console.log(`${r.name}\t${r.roster_id}\t${r.relay}`);
  });

roster
  .command("leave")
  .description("leave a roster on the relay and remove its local record")
  .argument("<name>", "local roster name")
  .option("--line <name>", "line to leave it for (defaults to the primary line)")
  .action(async (name: string, o: { line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const membership = namedRoster(ctx.paths, name);
      await leaveRoster(membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id);
      forgetMembership(ctx.paths, name);
      deleteCached(ctx.paths, name);
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

function namedRoster(paths: LinePaths, name: string) {
  const membership = loadMemberships(paths).find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (!membership) throw new Error(`No roster named "${name}" — run \`agentcall roster list\`.`);
  return membership;
}

roster
  .command("expel")
  .description("remove a member using the roster admin secret")
  .argument("<name>", "local roster name")
  .argument("<handle>", "member handle to remove")
  .option("--admin-secret <secret>", "admin secret (prefer AGENTCALL_ADMIN_SECRET to avoid shell history)")
  .option("--line <name>", "line to act as (defaults to the primary line)")
  .action(async (name: string, handle: string, o: { adminSecret?: string; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const membership = namedRoster(ctx.paths, name);
      await expelRosterMember(membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id, handle, await adminSecret(o.adminSecret));
      console.log(`Expelled ${handle}. Revoke any join key they may still know.`);
    } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
  });

const rosterKey = roster.command("key").description("issue, list, and revoke scoped roster join keys");

rosterKey
  .command("issue")
  .description("issue a one-off join key (use --reusable for a shared key)")
  .argument("<name>", "local roster name")
  .option("--admin-secret <secret>", "admin secret (prefer AGENTCALL_ADMIN_SECRET to avoid shell history)")
  .option("--description <text>", "short label shown by `roster key list`", "")
  .option("--expires-in <days>", "expiry in days (1-90)", (v) => Number.parseInt(v, 10), 30)
  .option("--reusable", "allow more than one member to use this key")
  .option("--line <name>", "line to act as (defaults to the primary line)")
  .action(async (name: string, o: { adminSecret?: string; description: string; expiresIn: number; reusable?: boolean; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const membership = namedRoster(ctx.paths, name);
      if (!Number.isInteger(o.expiresIn) || o.expiresIn < 1 || o.expiresIn > 90) {
        throw new Error("--expires-in must be an integer from 1 to 90.");
      }
      const out = await issueRosterJoinKey(
        membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id,
        await adminSecret(o.adminSecret), {
          description: o.description, expiresInDays: o.expiresIn, reusable: Boolean(o.reusable),
        },
      );
      console.log(`Join key (shown once): ${out.join_key}`);
      console.log(`Prefix: ${out.key.prefix}  Expires: ${new Date(out.key.expires_at).toISOString()}`);
    } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
  });

rosterKey
  .command("list")
  .description("list join-key metadata without revealing secrets")
  .argument("<name>", "local roster name")
  .option("--admin-secret <secret>", "admin secret (prefer AGENTCALL_ADMIN_SECRET to avoid shell history)")
  .option("--line <name>", "line to act as (defaults to the primary line)")
  .action(async (name: string, o: { adminSecret?: string; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const membership = namedRoster(ctx.paths, name);
      const keys = await listRosterJoinKeys(
        membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id,
        await adminSecret(o.adminSecret),
      );
      if (keys.length === 0) { console.log("No join keys."); return; }
      const now = Date.now();
      for (const key of keys) {
        const state = key.revoked_at !== null ? "revoked" : key.expires_at <= now ? "expired" : key.used && !key.reusable ? "used" : "active";
        console.log(`${key.prefix}\t${state}\t${key.reusable ? "reusable" : "one-off"}\t${new Date(key.expires_at).toISOString()}\t${key.created_by}\t${key.description}`);
      }
    } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
  });

rosterKey
  .command("revoke")
  .description("revoke one join key; --evict removes only members admitted by it")
  .argument("<name>", "local roster name")
  .argument("<prefix>", "12-character public key prefix from `roster key list`")
  .option("--admin-secret <secret>", "admin secret (prefer AGENTCALL_ADMIN_SECRET to avoid shell history)")
  .option("--evict", "remove members admitted by this key")
  .option("--yes", "confirm targeted eviction")
  .option("--line <name>", "line to act as (defaults to the primary line)")
  .action(async (name: string, prefix: string, o: { adminSecret?: string; evict?: boolean; yes?: boolean; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const membership = namedRoster(ctx.paths, name);
      if (o.evict) await confirmRoster(name, `This removes members admitted by key ${prefix}.`, o.yes);
      const out = await revokeRosterJoinKey(
        membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id,
        prefix, await adminSecret(o.adminSecret), Boolean(o.evict),
      );
      if (o.evict) deleteCached(ctx.paths, name);
      console.log(`Revoked ${out.prefix}.${o.evict ? ` Evicted ${out.evicted} member(s).` : " Existing members were retained."}`);
    } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
  });

roster
  .command("delete")
  .description("permanently delete a roster while retaining its relay audit events")
  .argument("<name>", "local roster name")
  .option("--admin-secret <secret>", "admin secret (prefer AGENTCALL_ADMIN_SECRET to avoid shell history)")
  .option("--yes", "confirm deletion")
  .option("--line <name>", "line to act as (defaults to the primary line)")
  .action(async (name: string, o: { adminSecret?: string; yes?: boolean; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const membership = namedRoster(ctx.paths, name);
      await confirmRoster(name, "Roster deletion cannot be undone.", o.yes);
      await deleteRoster(membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id, await adminSecret(o.adminSecret));
      forgetMembership(ctx.paths, name);
      deleteCached(ctx.paths, name);
      console.log(`Deleted "${name}"; relay audit events were retained.`);
    } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
  });

roster
  .command("forget")
  .description("drop only the local roster record; use `roster leave` to remove relay membership")
  .argument("<name>", "local roster name")
  .option("--line <name>", "line to forget it for (defaults to the primary line)")
  .action((name: string, o: { line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    try {
      forgetMembership(ctx.paths, name);
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
  .option("--line <name>", "line to search as (defaults to the primary line)")
  .action(async (questionParts: string[], o: { roster?: string; limit: number; json?: boolean; offline?: boolean; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    const relay = relayUrl(cfg);
    const identity = { relay, caller: cfg.handle };
    const memberships = loadMemberships(ctx.paths)
      .filter((m) => m.relay === relay)
      .filter((m) => !o.roster || m.name.toLowerCase() === o.roster.toLowerCase());

    if (memberships.length === 0) {
      console.error(
        o.roster
          ? `No roster named "${o.roster}" on ${relay} — run \`agentcall roster list\`.`
          : `No rosters joined on ${relay}. Ask a colleague for a roster id and join key, then:\n  agentcall roster join <id> --key <key> --as <name>`,
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
        const out = await refreshRoster(ctx.paths, m.name, m.roster_id, identity, { org: cfg.org, handle: cfg.handle, token: cfg.token }, { offline: o.offline });
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
    // Mutations edit user intent, never the administrator-filtered view.
    // Enforcement and card publication apply the machine's managed ceiling
    // separately. validatePolicy runs BEFORE the write so a change that would
    // break an assertion leaves the last known-good file (and the listener)
    // intact.
    const { policy, lines } = execVerb(loadUserPolicy(ctx.paths), loadTasks(ctx.paths), verb, a, b);
    validatePolicy(ctx.paths, policy);
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
  .option("--invite <token>", "one-time organization invite (required — each line enrolls in its own tenant)")
  .option("--agent <agent>", "agent kind: claude or codex (omit with --caller-only)")
  .option("--relay <url>", "relay URL to register against")
  .option("--caller-only", "register a handle to call others without making this line's agent callable")
  .option("--skip-service", "skip reinstalling the background listener service")
  .option("--no-verify", "skip verifying the agent can answer a test call")
  .action(
    async (
      name: string,
      o: { handle?: string; invite?: string; agent?: string; relay?: string; callerOnly?: boolean; skipService?: boolean; verify?: boolean },
    ) => {
      const machine = getMachinePaths();
      if (!o.callerOnly && o.agent !== "claude" && o.agent !== "codex") {
        console.error("Pass --agent claude or --agent codex, or --caller-only for a line that can only call out.");
        process.exitCode = 1;
        return;
      }
      // Validated here too, not just inside addLine: addLine's own check
      // never burns a handle (see its "Validate BEFORE the network call"
      // comment), but it runs AFTER the handle prompt below — so
      // `agentcall line add "Bad Name"` would ask the owner to choose a
      // handle and only then reject the name, wasting a prompt on a doomed
      // command. Failing fast here is a UX fix, not a safety one.
      try {
        assertValidLineName(name);
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exitCode = 1;
        return;
      }
      // Same reasoning as the line-name check above: addLine re-checks this
      // before it touches the network, but doing it here too avoids prompting
      // for a handle on a command that cannot possibly register.
      if (!o.invite?.trim()) {
        console.error(`An organization invite is required. Run \`agentcall line add ${name} --invite <token>\`.`);
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
          invite: o.invite,
          agent: o.callerOnly ? undefined : (o.agent as AgentKind),
          callerOnly: o.callerOnly,
          verify: o.verify,
          installListenerServiceFn: o.skipService ? () => {} : undefined,
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
  .option("--json", "print the full row data (name, address, relay, state, primary) as JSON")
  .action(async (o: { json?: boolean }) => {
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
          (await getStatus(relayUrl(l2.config), l2.config.handle, {
            org: l2.config.org, handle: l2.config.handle, token: l2.config.token,
          })).online,
        );
      } catch {
        online.set(l2.config.handle, false);
      }
    }
    const rows = listLinesReport(machine, (cfg: LineConfig) => online.get(cfg.handle) ?? false);
    if (o.json) {
      console.log(JSON.stringify(rows));
      return;
    }
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
  .description("run the foreground listener (the platform service runs this after setup)")
  .option("--line <name>", "run only this line instead of every callable line")
  .action((o: { line?: string }) => {
    const machine = getMachinePaths();
    let l: { stop(): Promise<void> };
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
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await l.stop();
      process.exit(0);
    };
    process.once("SIGTERM", () => { void stop(); });
    process.once("SIGINT", () => { void stop(); });
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
      // picks up the new token on its own; no restart needed here. This is
      // what replaced main's explicit installListenerService() restart: the
      // restart existed only because the old single listener read its token
      // once at startup.
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
    uninstallListenerService(machine);
    if (o.purge) rmSync(machine.dir, { recursive: true, force: true });
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
