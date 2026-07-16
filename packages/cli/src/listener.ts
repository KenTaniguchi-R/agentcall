import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";
import {
  AGENT_TIMEOUT_MS, RelayToListenerFrame, safeParseFrame,
} from "@benree/agentcall-shared";
import type { CallableConfig } from "./config.js";
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
  const queue = new SerialQueue(deps.maxPending ?? 5);
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
      const { call_id, from, message, task: requestedTask } = frame;
      const started = Date.now();
      const send = (obj: unknown) => { try { ws?.send(JSON.stringify(obj)); } catch { /* dead */ } };

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

      const accepted = queue.tryEnqueue(async () => {
        send({ type: "call_answer", call_id });
        try {
          const out = await run(
            deps.config.agent_kind,
            buildPrompt(deps.config.handle, from, message, task),
            deps.paths,
            timeoutMs,
            undefined,
            task.envelope,
          );
          send({ type: "call_result", call_id, text: out.text, session_id: out.session_id, task: task.id });
          audit({ call_id, from, message: message.slice(0, 500), task: task.id, status: "ok", duration_ms: Date.now() - started });
        } catch (e) {
          const code = e instanceof AgentRunError ? e.code : "agent_error";
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
