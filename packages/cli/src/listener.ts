import WebSocket, { type RawData } from "ws";
import {
  AGENT_TIMEOUT_MS, E2EERelayToListenerFrame, MAX_E2EE_WIRE_BYTES,
  requestTranscript, safeParseFrame, transcriptHash,
} from "@benree/agentcall-shared";
import { fetchKeys } from "./api.js";
import { resolveLineWorkdir, type CallableLineConfig } from "./config.js";
import type { LinePaths } from "./paths.js";
import { buildPrompt } from "./prompt.js";
import {
  AgentRunError, codexThreadingEnabled, codexToolTelemetryEnabled,
  CODEX_THREADING_VERIFIED_VERSION, runAgent,
} from "./runner.js";
import { mintContextId, pruneContexts, saveContexts, upsertContext } from "./contexts.js";
import { SerialQueue } from "./queue.js";
import { loadPolicy } from "./policy.js";
import { appendPrivateLogLine } from "./audit-log.js";
import {
  getTelemetry, shutdownTelemetry, telemetrySafely, type AgentCallTelemetry,
} from "./telemetry.js";
import { sealE2EEResponse } from "./e2ee.js";
import { loadKeys } from "./keys.js";
import { verifyAndPinPeer } from "./known-peers.js";
import { reserveReplay } from "./replay-store.js";
import { signalForInboundStatus } from "./abuse-signals.js";
import { createToolEventSpool, type ToolEventSpool } from "./tool-telemetry-spool.js";
import {
  admitBinding, handleCancel, makeOutcomeSender, openInboundEnvelope, resolveAdmission,
} from "./listener-stages.js";

export interface ListenerDeps {
  relay: string;
  paths: LinePaths;
  /** Called on every (re)connect — a rotated token takes effect without a restart. */
  loadConfig: () => CallableLineConfig;
  run?: typeof runAgent;
  saveContexts?: typeof saveContexts;
  maxPending?: number;
  backoffMs?: (attempt: number) => number;
  // Test seam so a test can assert on what each (re)connect sends — a
  // WebSocketServer round-trip works but makes asserting per-attempt
  // Authorization headers awkward. Production leaves this unset and gets a
  // real `ws` socket.
  socketFactory?: (
    url: string,
    opts: { headers: Record<string, string>; perMessageDeflate: false; maxPayload: number },
  ) => WebSocket;
  codexThreadingEnabled?: () => boolean;
  codexToolTelemetryEnabled?: () => boolean;
  telemetry?: AgentCallTelemetry;
  createToolEventSpool?: (
    callId: string, privateStateDir?: string, now?: () => number,
  ) => ToolEventSpool | undefined;
  fetchKeys?: typeof fetchKeys;
  verifyAndPinPeer?: typeof verifyAndPinPeer;
  loadKeys?: typeof loadKeys;
  reserveReplay?: typeof reserveReplay;
  sealE2EEResponse?: typeof sealE2EEResponse;
}

export function runtimeToolTelemetryEnabled(runtime: "claude" | "codex", codexVerified: boolean): boolean {
  return runtime !== "codex" || codexVerified;
}

function rawWireBytes(raw: RawData): number {
  return Array.isArray(raw)
    ? raw.reduce((total, chunk) => total + chunk.byteLength, 0)
    : raw.byteLength;
}

export function startListener(deps: ListenerDeps): { stop(): Promise<void> } {
  const run = deps.run ?? runAgent;
  const newSocket = deps.socketFactory ?? ((
    url: string,
    opts: { headers: Record<string, string>; perMessageDeflate: false; maxPayload: number },
  ) => new WebSocket(url, opts));
  const persistContexts = deps.saveContexts ?? saveContexts;
  const telemetry = deps.telemetry ?? getTelemetry(process.env, {
    healthFile: deps.paths.machine.telemetryHealthFile,
  });
  const fetchPeerKeys = deps.fetchKeys ?? fetchKeys;
  const verifyPeer = deps.verifyAndPinPeer ?? verifyAndPinPeer;
  const loadLocalKeys = deps.loadKeys ?? loadKeys;
  const reserveRequest = deps.reserveReplay ?? reserveReplay;
  const sealResponse = deps.sealE2EEResponse ?? sealE2EEResponse;
  // Validate before opening the socket. Hot edits are still loaded per call
  // below, but a listener must never advertise availability when its initial
  // effective policy (user layer + the machine's managed ceiling) is malformed
  // or contradicts an assertion. Throwing here is contained to this one line:
  // startAllListeners catches per-line startup failures so the other lines'
  // sockets survive (listenAll.ts). The workdir gets the same up-front check,
  // but per-connect rather than here — see connect() below.
  loadPolicy(deps.paths);

  const queue = new SerialQueue(deps.maxPending ?? 0);
  const backoff = deps.backoffMs ?? ((n) => Math.min(1000 * 2 ** n, 60_000) + Math.random() * 500);
  // One startup read, purely to decide codex threading. Everything else reads
  // config per-connect (see connect() below), but agent_kind is what the
  // threading probe keys off and the probe shells out to `codex --version` —
  // re-running it on every reconnect would spawn a process per backoff tick,
  // and the warning below would repeat forever in listener.log. Editing
  // agent_kind therefore needs a listener restart, same as changing the relay.
  const startupKind = deps.loadConfig().agent_kind;
  const codexCanThread = startupKind === "codex"
    ? (deps.codexThreadingEnabled ?? codexThreadingEnabled)()
    : false;
  const startupCodexCanReportTools = startupKind === "codex"
    ? (deps.codexToolTelemetryEnabled ?? codexToolTelemetryEnabled)()
    : false;
  if (startupKind === "codex" && !codexCanThread) {
    console.error(
      `Warning: Codex conversation threading is disabled because this codex-cli release has not passed ` +
        `the resume sandbox probe (last verified: ${CODEX_THREADING_VERIFIED_VERSION}).`,
    );
  }
  if (startupKind === "codex" && telemetry && !startupCodexCanReportTools) {
    console.error(
      `Warning: Codex tool telemetry is disabled because no codex-cli release has passed ` +
        `the default-path lifecycle probe.`,
    );
  }
  let stopped = false;
  let attempt = 0;
  let ws: WebSocket | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  const activeToolSpools = new Set<ToolEventSpool>();

  const audit = (entry: Record<string, unknown>) => {
    try {
      const signal = signalForInboundStatus(entry.status);
      appendPrivateLogLine(
        deps.paths.callsLog,
        JSON.stringify({
          ts: new Date().toISOString(),
          ...entry,
          ...(signal.flags.length > 0 ? signal : {}),
        }),
      );
    } catch (e) {
      // Audit persistence is observability, not call delivery. A full or
      // read-only disk must not turn a refusal, failure, or completed answer
      // into a second failure while trying to record the first outcome.
      console.error(`Warning: could not write the call audit log: ${String(e)}`);
    }
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
    const runtimeCanReportTools = runtimeToolTelemetryEnabled(
      config.agent_kind,
      startupKind === "codex"
        ? startupCodexCanReportTools
        : (deps.codexToolTelemetryEnabled ?? codexToolTelemetryEnabled)(),
    );
    const workdir = resolveLineWorkdir(config, deps.paths);
    // `deps.relay`, not `config.relay`: the relay host is fixed at
    // `startListener()` entry (set by `startAllListeners` from the config it
    // read at process startup), so unlike the token/handle/workdir above,
    // a changed relay host in config.json does NOT take effect on
    // reconnect — only a full listener restart picks up a new relay. This is
    // spec-faithful, not an oversight: `ListenerDeps.relay` was never
    // re-derived from `loadConfig()`'s return value, only its other fields
    // were. Deliberate partial reload, documented here so it doesn't read as
    // a bug to the next person tracing a relay-host change that didn't take.
    const url = deps.relay.replace(/^http/, "ws") + "/v1/ws?role=listen";
    ws = newSocket(url, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        "X-AgentCall-Org": config.org,
        "X-AgentCall-Handle": config.handle,
      },
      perMessageDeflate: false,
      maxPayload: MAX_E2EE_WIRE_BYTES,
    });
    ws.on("open", () => {
      attempt = 0;
      pingTimer = setInterval(() => { try { ws?.send("ping"); } catch { /* dead */ } }, 30_000);
    });
    ws.on("message", async (raw) => {
      if (stopped) return;
      if (rawWireBytes(raw) > MAX_E2EE_WIRE_BYTES) {
        try { ws?.close(1009, "Encrypted relay frame exceeded the wire limit."); } catch { /* dead */ }
        return;
      }
      const s = String(raw);
      if (s === "pong") return;
      const frame = safeParseFrame(E2EERelayToListenerFrame, s);
      if (!frame) return;
      const send = (obj: unknown) => { try { ws?.send(JSON.stringify(obj)); } catch { /* dead */ } };

      if (frame.type === "cancel_call") {
        handleCancel(frame, queue, send);
        return;
      }

      const inboundSpan = telemetrySafely(() => telemetry?.startInbound(frame));
      let admissionOutcome = "agent_error";
      try {
      const {
        call_id, correlation_id, from, groups,
      } = frame;
      const correlation = { correlation_id };
      const started = Date.now();

      const opened = await openInboundEnvelope(
        {
          relay: deps.relay, org: config.org, handle: config.handle, token: config.token,
          machine: deps.paths.machine, paths: deps.paths, from, envelope: frame.envelope,
        },
        {
          fetchKeys: fetchPeerKeys, verifyAndPinPeer: verifyPeer,
          loadKeys: loadLocalKeys, reserveReplay: reserveRequest,
        },
      );
      if (!opened.ok) {
        admissionOutcome = "protocol_error";
        send({ type: "call_rejected", call_id, code: "protocol_error" });
        audit({
          call_id, ...correlation, from, status: "protocol_error", duration_ms: Date.now() - started,
          error: String(opened.error).slice(0, 2_000),
        });
        return;
      }
      const {
        request, callerBundle, localKeys, relayOrigin, fromAddress, toAddress,
      } = opened.envelope;

      const { message, task: requestedTask, context_id } = request;
      const requestHash = await transcriptHash(requestTranscript(request));
      const trySendOutcome = makeOutcomeSender(
        { callId: call_id, relayOrigin, fromAddress, toAddress, request, requestHash, localKeys, callerBundle, send },
        sealResponse,
      );

      // Resolve caller -> task -> envelope BEFORE the message is placed in any
      // prompt (see policy.ts). Refusals never enqueue and never spawn: no
      // tokens are burned by blocked callers or menu probing.
      const admission = resolveAdmission({
        paths: deps.paths, from, requestedTask, groups, workdir, agentKind: config.agent_kind,
      });
      if (!admission.ok) {
        if (admission.code === "policy_error") {
          admissionOutcome = "policy_error";
          const outcomeDeliveryError = await trySendOutcome({ kind: "failure", code: "agent_error", detail: "A local policy error prevented this call from completing." });
          audit({ call_id, ...correlation, from, message: message.slice(0, 500), status: "policy_error", duration_ms: 0, error: String(admission.error).slice(0, 2000), outcome_delivery_error: outcomeDeliveryError });
          return;
        }
        admissionOutcome = admission.code;
        const outcomeDeliveryError = await trySendOutcome({ kind: "failure", code: admission.code, offered: admission.offered });
        audit({ call_id, ...correlation, from, message: message.slice(0, 500), task: requestedTask, status: admission.code, duration_ms: 0, outcome_delivery_error: outcomeDeliveryError });
        return;
      }
      const { task, taskWorkdir } = admission;

      // Task resolution above ran on the verified `from` and local files only
      // (see policy.ts's CaMeL invariant). context_id is caller-controlled, so
      // it is consulted only AFTER, and only to confirm the binding was made
      // under the SAME task. It can narrow a call, never select one. Inverting
      // this order reopens the hole the design exists to close.
      const admitted = admitBinding({
        paths: deps.paths, from, taskId: task.id, contextId: context_id,
        threadable: task.threadable, agentKind: config.agent_kind, codexCanThread,
        workdirDir: taskWorkdir.dir,
      });
      if (!admitted.ok) {
        admissionOutcome = "context_unknown";
        const outcomeDeliveryError = await trySendOutcome({ kind: "failure", code: "context_unknown" });
        audit({ call_id, ...correlation, from, message: message.slice(0, 500), task: task.id,
                status: "context_unknown", duration_ms: 0, outcome_delivery_error: outcomeDeliveryError });
        return;
      }
      const { now, threadingAvailable, contexts, binding } = admitted;

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
        const invocationSpan = telemetrySafely(() => inboundSpan?.startInvocation({
          task: task.id,
          runtime: config.agent_kind,
          callId: call_id,
          correlationId: correlation_id,
          contextId: binding?.context_id,
        }));
        const toolSpool = telemetrySafely(() => invocationSpan && runtimeCanReportTools
          ? (deps.createToolEventSpool ?? createToolEventSpool)(call_id, deps.paths.dir)
          : undefined);
        if (toolSpool) activeToolSpools.add(toolSpool);
        let invocationFinished = false;
        const finishInvocation = (
          outcome: "success" | "timeout" | "canceled" | "agent_error",
          contextId?: string,
        ) => {
          if (invocationFinished) return;
          invocationFinished = true;
          const resolvedContextId = contextId ?? binding?.context_id;
          if (toolSpool) activeToolSpools.delete(toolSpool);
          for (const lifecycle of toolSpool?.collect() ?? []) {
            telemetrySafely(() => invocationSpan?.recordTool({
              ...lifecycle,
              ...(resolvedContextId ? { contextId: resolvedContextId } : {}),
            }));
          }
          telemetrySafely(() => invocationSpan?.end(outcome, contextId));
        };
        try {
          const out = await run(
            config.agent_kind,
            buildPrompt(config.handle, from, message, task, taskWorkdir, binding !== undefined),
            taskWorkdir.dir,
            timeoutMs,
            undefined,
            task.envelope,
            call_id,
            signal,
            // The line this call came in on — required (see runner.ts): the
            // PreToolUse guard needs it to know which line's calls.log and
            // task dirs it's policing, and fails closed without it.
            deps.paths.name,
            binding?.agent_session_id,
            correlation_id,
            toolSpool?.file,
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
              agent_kind: config.agent_kind,
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
          const outcomeDeliveryError = await trySendOutcome({
            kind: "reply", text: out.text, context_id: contextId, task: task.id,
          });
          if (outcomeDeliveryError) {
            finishInvocation("agent_error", contextId);
            audit({
              call_id, ...correlation, from, message: message.slice(0, 500), task: task.id,
              status: "outcome_delivery_error", duration_ms: Date.now() - started,
              outcome_delivery_error: outcomeDeliveryError,
              context_id: contextId, turn: (binding?.turns ?? 0) + 1,
              context_persist_error: contextPersistError,
            });
            return;
          }
          finishInvocation("success", contextId);
          audit({
            call_id, ...correlation, from, message: message.slice(0, 500), reply: out.text.slice(0, 500),
            task: task.id, status: "ok",
            duration_ms: Date.now() - started,
            context_id: contextId, turn: (binding?.turns ?? 0) + 1,
            context_persist_error: contextPersistError,
          });
        } catch (e) {
          const code = e instanceof AgentRunError ? e.code : "agent_error";
          finishInvocation(code);
          // runAgent settles from the child's exit handler, so reaching here
          // with "canceled" means the process group is actually gone.
          if (code === "canceled") {
            send({ type: "call_cancelled", call_id, phase: "running" });
            audit({ call_id, ...correlation, from, message: message.slice(0, 500), task: task.id, status: "canceled", duration_ms: Date.now() - started });
            return;
          }
          const outcomeDeliveryError = await trySendOutcome({ kind: "failure", code, detail: "The agent hit an internal error while answering." });
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
            call_id, ...correlation, from, message: message.slice(0, 500), task: task.id, status: code,
            duration_ms: Date.now() - started, error: err.slice(0, 2000),
            outcome_delivery_error: outcomeDeliveryError,
          });
        }
      });
      admissionOutcome = accepted ? "accepted" : "busy";
      if (!accepted) {
        const outcomeDeliveryError = await trySendOutcome({ kind: "failure", code: "busy" });
        audit({ call_id, ...correlation, from, message: message.slice(0, 500), task: task.id, status: "busy", duration_ms: 0, outcome_delivery_error: outcomeDeliveryError });
      }
      } catch (error) {
        // EventEmitter does not observe a rejected async message callback.
        // Contain unexpected key-store/sealing failures here so one malformed
        // or expired call cannot become an unhandled process rejection.
        admissionOutcome = "protocol_error";
        send({ type: "call_rejected", call_id: frame.call_id, code: "protocol_error" });
        console.error(
          `Listener could not finish encrypted call ${frame.call_id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        telemetrySafely(() => inboundSpan?.endAdmission(admissionOutcome));
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
    async stop() {
      stopped = true;
      if (pingTimer) clearInterval(pingTimer);
      try { ws?.close(); } catch { /* fine */ }
      for (const spool of activeToolSpools) spool.dispose();
      activeToolSpools.clear();
      await queue.stop();
      await shutdownTelemetry();
    },
  };
}
