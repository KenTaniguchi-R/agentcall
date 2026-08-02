import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";
import {
  AGENT_TIMEOUT_MS, RelayToListenerFrame, safeParseFrame,
} from "@benree/agentcall-shared";
import { resolveLineWorkdir, type CallableLineConfig } from "./config.js";
import type { LinePaths } from "./paths.js";
import { buildPrompt } from "./prompt.js";
import { AgentRunError, runAgent } from "./runner.js";
import { SerialQueue } from "./queue.js";
import { loadPolicy, resolveTask } from "./policy.js";
import { loadTasks } from "./tasks.js";

export interface ListenerDeps {
  relay: string;
  paths: LinePaths;
  /** Called on every (re)connect — a rotated token takes effect without a restart. */
  loadConfig: () => CallableLineConfig;
  run?: typeof runAgent;
  maxPending?: number;
  backoffMs?: (attempt: number) => number;
  // Test seam so a test can assert on what each (re)connect sends — a
  // WebSocketServer round-trip works but makes asserting per-attempt
  // Authorization headers awkward. Production leaves this unset and gets a
  // real `ws` socket.
  socketFactory?: (url: string, opts: { headers: Record<string, string> }) => WebSocket;
}

export function startListener(deps: ListenerDeps): { stop(): void } {
  const run = deps.run ?? runAgent;
  const newSocket = deps.socketFactory ?? ((url: string, opts: { headers: Record<string, string> }) => new WebSocket(url, opts));
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

  // Config (and therefore workdir) is re-read on every (re)connect, not just
  // once at startup: a rotated token (`agentcall rotate`) or an edited
  // workdir then takes effect on the next reconnect instead of needing the
  // whole multi-line process restarted. A bad workdir/config still stops the
  // FIRST connect() (called synchronously below, not through
  // scheduleReconnect) with a thrown error — same "fail loudly at start"
  // contract `agentcall listen` had before lines existed. A config that goes
  // bad LATER, discovered on a scheduled reconnect, must NOT throw all the
  // way out: this one process holds every line's socket, and an uncaught
  // throw from inside a bare `setTimeout` callback would crash all of them,
  // not just the line whose config broke — see scheduleReconnect below,
  // which is what catches that case.
  const connect = () => {
    if (stopped) return;
    const config = deps.loadConfig();
    const workdir = resolveLineWorkdir(config, deps.paths);
    const url = deps.relay.replace(/^http/, "ws") + "/v1/ws?role=listen";
    ws = newSocket(url, {
      headers: { Authorization: `Bearer ${config.token}`, "X-AgentCall-Handle": config.handle },
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
            config.agent_kind,
            buildPrompt(config.handle, from, message, task, workdir),
            workdir.dir,
            timeoutMs,
            undefined,
            task.envelope,
            call_id,
            signal,
            // The line this call came in on — required (see runner.ts): the
            // PreToolUse guard needs it to know which line's calls.log and
            // task dirs it's policing, and fails closed without it.
            deps.paths.name,
          );
          send({ type: "call_result", call_id, text: out.text, session_id: out.session_id, task: task.id });
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
      setTimeout(() => {
        try {
          connect();
        } catch (e) {
          // loadConfig/resolveLineWorkdir threw on this reconnect attempt —
          // corrupt config.json, a workdir deleted out from under a running
          // listener, etc. See the comment above connect(): this must not
          // propagate, or one line's bad config takes down every other
          // line's socket in this same process — an unhandled throw here is
          // a multi-line outage, not a single-line one. console.error, not a
          // new log file: the launchd plist already routes stderr to
          // listenerLog, so this lands in the right place with no plumbing,
          // and it's visible in a foreground `agentcall listen` too. Named by
          // line, since with N lines in one process an error that doesn't
          // say which one is nearly useless. Keep retrying rather than
          // giving up: the owner may be mid-edit, or `rotate` may be
          // rewriting the file underneath this read, and a line that
          // permanently drops out on one bad read would need a full process
          // restart to come back — worse than a noisy retry loop. `doctor`
          // and `line list` are what surface a line stuck offline.
          console.error(`agentcall: line "${deps.paths.name}" reconnect failed, retrying: ${String(e)}`);
          scheduleReconnect();
        }
      }, backoff(attempt++)).unref?.();
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
