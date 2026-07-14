import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";
import {
  AGENT_TIMEOUT_MS, RelayToListenerFrame, safeParseFrame,
} from "@agentcall/shared";
import type { Config } from "./config.js";
import type { Paths } from "./paths.js";
import { buildPrompt } from "./prompt.js";
import { AgentRunError, runAgent } from "./runner.js";
import { SerialQueue } from "./queue.js";

export interface ListenerDeps {
  relay: string;
  config: Config;
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
      const { call_id, from, message } = frame;
      const started = Date.now();
      const send = (obj: unknown) => { try { ws?.send(JSON.stringify(obj)); } catch { /* dead */ } };
      const accepted = queue.tryEnqueue(async () => {
        send({ type: "call_answer", call_id });
        try {
          const out = await run(
            deps.config.agent_kind,
            buildPrompt(deps.config.handle, from, message),
            deps.paths,
            AGENT_TIMEOUT_MS,
          );
          send({ type: "call_result", call_id, text: out.text, session_id: out.session_id });
          audit({ call_id, from, message: message.slice(0, 500), status: "ok", duration_ms: Date.now() - started });
        } catch (e) {
          const code = e instanceof AgentRunError ? e.code : "agent_error";
          send({ type: "call_failed", call_id, code, detail: String(e).slice(0, 500) });
          audit({ call_id, from, message: message.slice(0, 500), status: code, duration_ms: Date.now() - started });
        }
      });
      if (!accepted) {
        send({ type: "call_failed", call_id, code: "busy" });
        audit({ call_id, from, message: message.slice(0, 500), status: "busy", duration_ms: 0 });
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
