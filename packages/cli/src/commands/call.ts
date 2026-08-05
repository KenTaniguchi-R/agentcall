import type { Command } from "commander";
import { sanitizeTerminalOutput, stringifyTerminalSafeJson } from "@benree/agentcall-shared";
import { callAgent, callStatusMessage, CallError } from "../call-client.js";
import { getMachinePaths } from "../paths.js";
import { relayUrl } from "../config.js";
import { resolveAddress } from "../contacts.js";
import { pickOutboundLine } from "../outbound.js";
import { findOutbound, loadOutbound, rememberOutbound } from "../contexts-out.js";
import { getTelemetry, shutdownTelemetry, telemetrySafely } from "../telemetry.js";
import type { LineContext } from "../line-context.js";

export function register(program: Command): void {
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
      if (process.env.AGENTCALL_CALL_ID !== undefined) {
        console.error("Nested agentcall calls are disabled until relay-attested chains and secret-isolated per-run credentials exist.");
        process.exitCode = 1;
        return;
      }
      const machine = getMachinePaths();
      const firstPass = resolveAddress(machine, address);
      if (!firstPass.ok) {
        console.error(firstPass.error);
        process.exitCode = 1;
        return;
      }
      let ctx: LineContext;
      try {
        ctx = pickOutboundLine(machine, firstPass.org, { as: o.as });
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exitCode = 1;
        return;
      }
      const cfg = ctx.config;
      const parsed = resolveAddress(machine, address, relayUrl(cfg), cfg.org);
      if (!parsed.ok) {
        console.error(parsed.error);
        process.exitCode = 1;
        return;
      }
      const message = messageParts.join(" ");
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
          relay: relayUrl(cfg), org: cfg.org, from: cfg.handle, token: cfg.token,
          to: parsed.handle, message, paths: ctx.paths, task, contextId,
          correlationId: callerSpan?.correlationId, traceparent: callerSpan?.traceparent,
          onStatus: (s, frame) => {
            telemetrySafely(() => callerSpan?.setCallId(frame.call_id));
            console.error(callStatusMessage(s));
          },
        });
        telemetrySafely(() => callerSpan?.endSuccess(reply.call_id));
        if (reply.context_id && reply.task) {
          rememberOutbound(ctx.paths, { relay: relayUrl(cfg), from: cfg.handle, to: parsed.handle, task: reply.task, context_id: reply.context_id, at: Date.now() });
          console.error("conversation open — add --continue to follow up");
        }
        console.log(o.json ? stringifyTerminalSafeJson(reply) : sanitizeTerminalOutput(reply.text));
      } catch (e) {
        telemetrySafely(() => callerSpan?.endError(e instanceof CallError ? e.code : "agent_error", e instanceof CallError ? e.callId : undefined));
        console.error(e instanceof CallError ? `Call failed (${e.code}): ${e.message}` : String(e));
        process.exitCode = 1;
      } finally {
        await shutdownTelemetry();
      }
    });
}
