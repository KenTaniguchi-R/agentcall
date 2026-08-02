import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";
import {
  AGENT_TIMEOUT_MS, RelayToListenerFrame, safeParseFrame,
} from "@benree/agentcall-shared";
import { resolveWorkdir, type CallableConfig } from "./config.js";
import type { Paths } from "./paths.js";
import { buildPrompt } from "./prompt.js";
import { AgentRunError, runAgent } from "./runner.js";
import { SerialQueue } from "./queue.js";
import { loadPolicy, resolveTask } from "./policy.js";
import { loadTasks } from "./tasks.js";

export interface ListenerDeps {
  relay: string;
  config: CallableConfig;
  paths: Paths;
  run?: typeof runAgent;
  maxPending?: number;
  backoffMs?: (attempt: number) => number;
}

export function startListener(deps: ListenerDeps): { stop(): void } {
  const run = deps.run ?? runAgent;
  // Resolved once, up front: a bad `workdir` in config.json should stop
  // `agentcall listen` with a clear message, not fail every inbound call
  // individually. Changing it therefore needs a listener restart.
  const workdir = resolveWorkdir(deps.config, deps.paths);
  const queue = new SerialQueue(deps.maxPending ?? 0);
  const backoff = deps.backoffMs ?? ((n) => Math.min(1000 * 2 ** n, 60_000) + Math.random() * 500);
  let stopped = false;
  let attempt = 0;
  let ws: WebSocket | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const audit = (entry: Record<string, unknown>) => {
    mkdirSync(dirname(deps.paths.callsLog), { recursive: true });
    appendFileSync(deps.paths.callsLog, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  };

  const connect = () => {
    if (stopped) return;
    const url = deps.relay.replace(/^http/, "ws") + "/v1/ws?role=listen";
    ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${deps.config.token}`, "X-AgentCall-Handle": deps.config.handle },
    });
    ws.on("open", () => {
      attempt = 0;
      pingTimer = setInterval(() => { try { ws?.send("ping"); } catch { /* dead */ } }, 30_000);
    });
    ws.on("message", (raw) => {
      const s = String(raw);
      if (s === "pong") return;
      const frame = safeParseFrame(RelayToListenerFrame, s);
      if (!frame) return;
      const send = (obj: unknown) => { try { ws?.send(JSON.stringify(obj)); } catch { /* dead */ } };

      if (frame.type === "cancel_call") {
        const outcome = queue.cancel(frame.call_id);
        // A pending job never spawned, so removal IS the confirmation. A
        // running job is only signalled here — its own catch path sends
        // call_cancelled once runAgent settles, which happens on the child's
        // exit event.
        if (outcome === "pending") {
          send({ type: "call_cancelled", call_id: frame.call_id, phase: "pending" });
        } else if (outcome === "unknown") {
          send({ type: "call_not_cancelled", call_id: frame.call_id, reason: "unknown" });
        }
        return;
      }

      const { call_id, from, message, task: requestedTask } = frame;
      const started = Date.now();

      // Resolve caller -> task -> envelope BEFORE the message is placed in any
      // prompt (see policy.ts). Refusals never enqueue and never spawn: no
      // tokens are burned by blocked callers or menu probing.
      let resolution: ReturnType<typeof resolveTask>;
      try {
        resolution = resolveTask(loadPolicy(deps.paths), loadTasks(deps.paths), from, requestedTask);
      } catch (e) {
        send({ type: "call_failed", call_id, code: "agent_error", detail: "A local policy error prevented this call from completing." });
        audit({ call_id, from, message: message.slice(0, 500), status: "policy_error", duration_ms: 0, error: String(e).slice(0, 2000) });
        return;
      }
      if (!resolution.ok) {
        send({ type: "call_failed", call_id, code: resolution.code, offered: resolution.offered });
        audit({ call_id, from, message: message.slice(0, 500), task: requestedTask, status: resolution.code, duration_ms: 0 });
        return;
      }
      const task = resolution.task;
      const timeoutMs = task.timeout_s !== undefined ? task.timeout_s * 1000 : AGENT_TIMEOUT_MS;

      // call_accepted is sent from *inside* the job, not after tryEnqueue
      // returns: tryEnqueue drains synchronously when the queue is idle, so
      // this closure's body (up to its first await) already ran by the time
      // tryEnqueue's return value is available out here. Sending it as this
      // closure's first statement is what actually guarantees call_accepted
      // precedes call_started on the wire.
      const accepted = queue.tryEnqueue(call_id, async (signal) => {
        // CAVEAT: this fires on the job's turn to run, not on admission —
        // only harmless today because maxPending: 0 makes the two coincide.
        // See "Deliberately NOT in this plan" in
        // docs/superpowers/plans/2026-08-01-a2a-listener-protocol.md before
        // raising maxPending.
        send({ type: "call_accepted", call_id });
        send({ type: "call_started", call_id });
        try {
          const out = await run(
            deps.config.agent_kind,
            buildPrompt(deps.config.handle, from, message, task, workdir),
            workdir.dir,
            timeoutMs,
            undefined,
            task.envelope,
            call_id,
            signal,
          );
          send({ type: "call_result", call_id, text: out.text, context_id: out.session_id, task: task.id });
          audit({ call_id, from, message: message.slice(0, 500), task: task.id, status: "ok", duration_ms: Date.now() - started });
        } catch (e) {
          const code = e instanceof AgentRunError ? e.code : "agent_error";
          // runAgent settles from the child's exit handler, so reaching here
          // with "canceled" means the process group is actually gone.
          if (code === "canceled") {
            send({ type: "call_cancelled", call_id, phase: "running" });
            audit({ call_id, from, message: message.slice(0, 500), task: task.id, status: "canceled", duration_ms: Date.now() - started });
            return;
          }
          send({ type: "call_failed", call_id, code, detail: "The agent hit an internal error while answering." });
          audit({
            call_id, from, message: message.slice(0, 500), task: task.id, status: code,
            duration_ms: Date.now() - started, error: String(e).slice(0, 2000),
          });
        }
      });
      if (!accepted) {
        send({ type: "call_failed", call_id, code: "busy" });
        audit({ call_id, from, message: message.slice(0, 500), task: task.id, status: "busy", duration_ms: 0 });
      }
    });
    const scheduleReconnect = () => {
      if (pingTimer) clearInterval(pingTimer);
      if (stopped) return;
      setTimeout(connect, backoff(attempt++)).unref?.();
    };
    ws.on("close", scheduleReconnect);
    ws.on("error", () => { /* close fires next */ });
  };

  connect();
  return {
    stop() {
      stopped = true;
      if (pingTimer) clearInterval(pingTimer);
      try { ws?.close(); } catch { /* fine */ }
    },
  };
}
