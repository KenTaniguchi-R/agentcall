import type { Command } from "commander";
import { sanitizeTerminalOutput, stringifyTerminalSafeJson } from "@benree/agentcall-shared";
import { callAgent, callStatusMessage, CallError } from "../call-client.js";
import { getPaths } from "../paths.js";
import { relayUrl } from "../config.js";
import { resolveAddress } from "../contacts.js";
import { outboundInstallation } from "../outbound.js";
import { forgetOutbound, matchOutbound, loadOutbound, rememberOutbound } from "../contexts-out.js";
import type { Installation } from "../config.js";
import { fail } from "../errors.js";

export function register(program: Command): void {
  program
    .command("call")
    .description("call another handle's agent with a message and print its reply")
    .argument("<address>", "contact name or @org/handle to call")
    .argument("<message...>", "message to send")
    .option("--json", "print the full reply envelope instead of just the text")
    .option("--task <id>", "task from the callee's card to perform (see: agentcall card <address>)")
    .option("--continue", "continue the open conversation with this address (add --task when several are open)")
    .option("--context <id>", "continue a specific conversation by id")
    .action(async (address: string, messageParts: string[], o: { json?: boolean; task?: string; continue?: boolean; context?: string }) => {
      if (process.env.AGENTCALL_CALL_ID !== undefined) {
        fail("Nested agentcall calls are disabled until relay-attested chains and secret-isolated per-run credentials exist.");
        return;
      }
      const machine = getPaths();
      const firstPass = resolveAddress(machine, address);
      if (!firstPass.ok) {
        fail(firstPass.error);
        return;
      }
      let ctx: Installation;
      try {
        ctx = outboundInstallation(machine, firstPass.org);
      } catch (e) {
        fail(e);
        return;
      }
      const cfg = ctx.config;
      const parsed = resolveAddress(machine, address, cfg.org);
      if (!parsed.ok) {
        fail(parsed.error);
        return;
      }
      const message = messageParts.join(" ");
      let contextId = o.context;
      let task = o.task;
      if (o.continue) {
        if (contextId) {
          fail("Use --continue or --context, not both.");
          return;
        }
        // The store keys by task, so a peer can have one open conversation per
        // task. `--continue` alone resumes only when that is unambiguous; it
        // asks rather than guessing, which is the property the single-entry
        // store used to get by silently discarding the older conversation.
        const withPeer = matchOutbound(loadOutbound(ctx.paths), {
          relay: relayUrl(cfg), from: cfg.handle, to: parsed.handle,
        });
        const open = task === undefined ? withPeer : withPeer.filter((e) => e.task === task);
        if (open.length === 0) {
          // Naming the tasks that ARE open keeps what the single-entry store's
          // "that conversation is on task X, not Y" told the user, and scales
          // to the several-conversations case it could not represent.
          fail(withPeer.length > 0
            ? `No open conversation with ${address} on task "${task}". Open: ${withPeer.map((e) => e.task).join(", ")}.`
            : `No open conversation with ${address}. Call without --continue to start one.`);
          return;
        }
        if (open.length > 1) {
          const tasks = open.map((e) => e.task).join(", ");
          fail(`Several open conversations with ${address} (${tasks}). Add --task <id> to pick one.`);
          return;
        }
        const prev = open[0]!;
        contextId = prev.context_id;
        task = prev.task;
      }
      try {
        const reply = await callAgent({
          relay: relayUrl(cfg), org: cfg.org, from: cfg.handle, token: cfg.token,
          to: parsed.handle, message, paths: ctx.paths, task, contextId,
          onStatus: (s) => {
            console.error(callStatusMessage(s));
          },
        });
        if (reply.context_id && reply.task) {
          rememberOutbound(ctx.paths, { relay: relayUrl(cfg), from: cfg.handle, to: parsed.handle, task: reply.task, context_id: reply.context_id, at: Date.now() });
          console.error("conversation open — add --continue to follow up");
        }
        console.log(o.json ? stringifyTerminalSafeJson(reply) : sanitizeTerminalOutput(reply.text));
      } catch (e) {
        // `context_unknown` is the callee's ONLY word for a conversation that
        // is no longer resumable — expired, past its turn cap, threading
        // withdrawn, or a session its agent CLI has dropped. It is deliberately
        // one code (see contexts.ts), so the callee cannot tell us which. We do
        // not need it to: we know we sent --continue, and every one of those
        // means the same thing here. Without clearing the entry the next
        // --continue re-sends the dead context_id and fails identically
        // forever, because rememberOutbound only runs on success.
        if (o.continue && e instanceof CallError && e.code === "context_unknown") {
          forgetOutbound(ctx.paths, { relay: relayUrl(cfg), from: cfg.handle, to: parsed.handle, task });
          fail(`That conversation with ${address} has ended. Call again without --continue to start a new one.`);
          return;
        }
        fail(e instanceof CallError ? `Call failed (${e.code}): ${e.message}` : String(e));
      } finally {
      }
    });
}
