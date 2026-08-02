import WebSocket from "ws";
import {
  AGENT_TIMEOUT_MS, RelayToListenerFrame, safeParseFrame,
} from "@benree/agentcall-shared";
import { resolveWorkdir, type CallableConfig } from "./config.js";
import type { Paths } from "./paths.js";
import { buildPrompt } from "./prompt.js";
import { AgentRunError, codexThreadingEnabled, CODEX_THREADING_VERIFIED_VERSION, runAgent } from "./runner.js";
import {
  admitContext, loadContexts, mintContextId, pruneContexts, saveContexts, upsertContext,
  type ContextBinding,
} from "./contexts.js";
import { SerialQueue } from "./queue.js";
import { loadPolicy, resolveTask } from "./policy.js";
import { loadTasks } from "./tasks.js";
import { appendPrivateLogLine } from "./audit-log.js";

export interface ListenerDeps {
  relay: string;
  config: CallableConfig;
  paths: Paths;
  run?: typeof runAgent;
  saveContexts?: typeof saveContexts;
  maxPending?: number;
  backoffMs?: (attempt: number) => number;
  codexThreadingEnabled?: () => boolean;
}

export function startListener(deps: ListenerDeps): { stop(): void } {
  const run = deps.run ?? runAgent;
  const persistContexts = deps.saveContexts ?? saveContexts;
  // Resolved once, up front: a bad `workdir` in config.json should stop
  // `agentcall listen` with a clear message, not fail every inbound call
  // individually. Changing it therefore needs a listener restart.
  const workdir = resolveWorkdir(deps.config, deps.paths);
  // Validate before opening the socket. Hot edits are still loaded per call
  // below, but a listener must never advertise availability when its initial
  // effective policy is malformed or contradicts an assertion.
  loadPolicy(deps.paths);
  const queue = new SerialQueue(deps.maxPending ?? 0);
  const backoff = deps.backoffMs ?? ((n) => Math.min(1000 * 2 ** n, 60_000) + Math.random() * 500);
  const codexCanThread = deps.config.agent_kind === "codex"
    ? (deps.codexThreadingEnabled ?? codexThreadingEnabled)()
    : false;
  if (deps.config.agent_kind === "codex" && !codexCanThread) {
    console.error(
      `Warning: Codex conversation threading is disabled because this codex-cli release has not passed ` +
        `the resume sandbox probe (last verified: ${CODEX_THREADING_VERIFIED_VERSION}).`,
    );
  }
  let stopped = false;
  let attempt = 0;
  let ws: WebSocket | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const audit = (entry: Record<string, unknown>) => {
    try {
      appendPrivateLogLine(
        deps.paths.callsLog,
        JSON.stringify({ ts: new Date().toISOString(), ...entry }),
      );
    } catch (e) {
      // Audit persistence is observability, not call delivery. A full or
      // read-only disk must not turn a refusal, failure, or completed answer
      // into a second failure while trying to record the first outcome.
      console.error(`Warning: could not write the call audit log: ${String(e)}`);
    }
  };

  const connect = () => {
    if (stopped) return;
    const url = deps.relay.replace(/^http/, "ws") + "/v1/ws?role=listen";
    ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${deps.config.token}`,
        "X-AgentCall-Org": deps.config.org,
        "X-AgentCall-Handle": deps.config.handle,
      },
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

      const { call_id, from, groups, message, task: requestedTask, context_id } = frame;
      const started = Date.now();

      // Resolve caller -> task -> envelope BEFORE the message is placed in any
      // prompt (see policy.ts). Refusals never enqueue and never spawn: no
      // tokens are burned by blocked callers or menu probing.
      let resolution: ReturnType<typeof resolveTask>;
      try {
        resolution = resolveTask(loadPolicy(deps.paths), loadTasks(deps.paths), from, requestedTask, groups);
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
      const taskWorkdir = {
        dir: task.workdir ?? workdir.dir,
        // Claude's file-shaped tools are bounded by AGENTCALL_ALLOWED_ROOT.
        // Codex has no equivalent read boundary, so do not claim confinement.
        confined: deps.config.agent_kind === "claude",
      };

      // Task resolution above ran on the verified `from` and local files only
      // (see policy.ts's CaMeL invariant). context_id is caller-controlled, so
      // it is consulted only AFTER, and only to confirm the binding was made
      // under the SAME task. It can narrow a call, never select one. Inverting
      // this order reopens the hole the design exists to close.
      const now = Date.now();
      const threadingAvailable =
        task.threadable && (deps.config.agent_kind === "claude" || codexCanThread);
      const contexts = pruneContexts(loadContexts(deps.paths), now);
      // Explicitly typed: `let binding = undefined` infers the type `undefined`
      // and rejects the assignment below.
      let binding: ContextBinding | undefined;
      if (context_id !== undefined) {
        // `threadingAvailable` gates admission as well as minting. A binding
        // outlives the conditions it was minted under: the owner can add
        // `write`/`exec` to a task's SKILL.md (or set `threadable: false`) and
        // admitContext would still match on the unchanged task *id*, resuming a
        // conversation against an envelope the owner has just decided must not
        // carry one. Same for the codex gate — an old binding must not be able
        // to hand runAgent a resume id after codex threading becomes unavailable.
        binding = threadingAvailable
          ? admitContext(contexts, {
              context_id, caller: from, task: task.id,
              agent_kind: deps.config.agent_kind, workdir: taskWorkdir.dir, now,
            })
          : undefined;
        // One code for every failure — expired, not yours, wrong task, wrong
        // directory, threading withdrawn. Distinguishing them would tell an
        // attacker that a guessed token exists but belongs to someone else. And
        // this FAILS the call rather than quietly starting a fresh session,
        // because a silent almost-right answer is the #43/#51 failure mode.
        if (!binding) {
          send({ type: "call_failed", call_id, code: "context_unknown" });
          audit({ call_id, from, message: message.slice(0, 500), task: task.id,
                  status: "context_unknown", duration_ms: 0 });
          return;
        }
      }

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
            buildPrompt(deps.config.handle, from, message, task, taskWorkdir, binding !== undefined),
            taskWorkdir.dir,
            timeoutMs,
            undefined,
            task.envelope,
            call_id,
            signal,
            binding?.agent_session_id,
          );

          // Mint on a fresh threadable call; roll the existing binding forward
          // on a resumed one. The agent's session id can change between turns,
          // so it is re-read from the output rather than assumed stable — but
          // an ABSENT one must not stop an admitted resume from rolling
          // forward. parseCodexJsonl's non-JSON fallback yields no session id at
          // all, and gating this whole block on `out.session_id` left such a
          // turn at its old `turns` with its TTL sliding from the last
          // successful write — an unbounded conversation pinned below
          // MAX_CONTEXT_TURNS. On a resume the previously bound session id is
          // still the right one to resume next time, so it is kept. A FRESH
          // call with no session id still mints nothing: there is no session to
          // resume. `||`, not `??`: an empty session id is no session id, and
          // the binding schema requires a non-empty one.
          const sessionId = out.session_id || binding?.agent_session_id;
          let contextId: string | undefined;
          let contextPersistError: string | undefined;
          if (threadingAvailable && sessionId !== undefined) {
            const next = {
              context_id: binding?.context_id ?? mintContextId(),
              agent_session_id: sessionId,
              caller: from,
              task: task.id,
              agent_kind: deps.config.agent_kind,
              workdir: taskWorkdir.dir,
              turns: (binding?.turns ?? 0) + 1,
              created_at: binding?.created_at ?? now,
              last_used_at: now,
            };
            try {
              persistContexts(deps.paths, pruneContexts(upsertContext(contexts, next), now));
              contextId = next.context_id;
            } catch (e) {
              // The agent has already completed. Losing the optional resume
              // binding must cost only the follow-up, never the answer.
              contextPersistError = String(e).slice(0, 2000);
              console.error(`Warning: could not save the call context: ${contextPersistError}`);
            }
          }

          // context_id, never out.session_id: the minted handle is the only
          // thing that travels. The audit log gets the same treatment — it is
          // the owner's file, but it is also what gets pasted into a bug report.
          send({ type: "call_result", call_id, text: out.text, context_id: contextId, task: task.id });
          audit({
            call_id, from, message: message.slice(0, 500), reply: out.text.slice(0, 500),
            task: task.id, status: "ok",
            duration_ms: Date.now() - started,
            context_id: contextId, turn: (binding?.turns ?? 0) + 1,
            context_persist_error: contextPersistError,
          });
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
          // The agent's own error text can echo the session id back at us: a
          // stale binding makes `claude --resume <id>` print that id, and
          // runAgent folds the child's stderr/stdout into its message. Scrubbed
          // before the slice, because contexts.ts's invariant is that the real
          // agent_session_id never reaches an audit log — nothing leaves the
          // machine, but calls.log is what gets pasted into a bug report.
          const err = binding
            ? String(e).replaceAll(binding.agent_session_id, "<session>")
            : String(e);
          audit({
            call_id, from, message: message.slice(0, 500), task: task.id, status: code,
            duration_ms: Date.now() - started, error: err.slice(0, 2000),
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
