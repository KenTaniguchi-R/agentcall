// Stages extracted from listener.ts's WebSocket message handler (issue #283).
// Each function corresponds to one admission stage and returns a decision
// rather than performing IO itself (send/audit stay in listener.ts, next to
// `admissionOutcome`) — that keeps the fail-closed ordering visible at the
// call site instead of buried inside a helper. See listener.ts's message
// handler for the sequencing: envelope opened and peer verified BEFORE
// policy resolution; policy resolved BEFORE any agent spawn.
import type { E2EEOutcomeType, E2EEResponsePayloadType, E2EERequestPayloadType } from "@benree/agentcall-shared";
import { formatAddress, keyIdFor } from "@benree/agentcall-shared";
import { relayHostOf } from "./config.js";
import { openE2EERequest, sealE2EEResponse } from "./e2ee.js";
import { authOf, fetchKeys } from "./api.js";
import { verifyAndPinPeer, type KnownPeer } from "./known-peers.js";
import { loadKeys, type StoredKeys } from "./keys.js";
import { reserveReplay } from "./replay-store.js";
import type { LinePaths, MachinePaths } from "./paths.js";
import { loadPolicy, resolveTask, type Policy, type TaskResolution } from "./policy.js";
import { loadSensitivityMap, withFloor, type SensitivityMap } from "./sensitivity.js";
import { loadTasks, type Task } from "./tasks.js";
import {
  admitContext, loadContexts, pruneContexts, type ContextBinding,
} from "./contexts.js";

// ---------------------------------------------------------------------------
// Stage 2: cancel_call — independent of the E2EE/admission path below, since
// a cancel targets a call that (if pending) never opened an envelope at all.
// ---------------------------------------------------------------------------

interface CancelCallFrame { call_id: string }
interface CancelHandle { cancel(callId: string): "pending" | "running" | "unknown" }

export function handleCancel(
  frame: CancelCallFrame, queue: CancelHandle, send: (obj: unknown) => void,
): void {
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
}

// ---------------------------------------------------------------------------
// Stage 4: open the inbound E2EE envelope — fetch the caller's published
// keys, verify/pin them against the local trust store, load this line's own
// keys, open (decrypt + verify) the envelope, and reserve the request id
// against replay. All four must succeed before anything else runs.
// ---------------------------------------------------------------------------

type CallerKeyBundle = Awaited<ReturnType<typeof fetchKeys>>;

interface OpenedEnvelope {
  request: E2EERequestPayloadType;
  callerBundle: CallerKeyBundle;
  callerPeer: KnownPeer;
  localKeys: StoredKeys;
  relayOrigin: string;
  fromAddress: string;
  toAddress: string;
}

type OpenEnvelopeResult =
  | { ok: true; envelope: OpenedEnvelope }
  | { ok: false; error: unknown };

interface OpenEnvelopeIo {
  fetchKeys: typeof fetchKeys;
  verifyAndPinPeer: typeof verifyAndPinPeer;
  loadKeys: typeof loadKeys;
  reserveReplay: typeof reserveReplay;
}

export async function openInboundEnvelope(
  input: {
    relay: string; org: string; handle: string; token: string;
    machine: MachinePaths; paths: LinePaths; from: string; envelope: unknown;
  },
  io: OpenEnvelopeIo,
): Promise<OpenEnvelopeResult> {
  const relayOrigin = relayHostOf(input.relay);
  const fromAddress = formatAddress(input.org, input.from);
  const toAddress = formatAddress(input.org, input.handle);
  try {
    const callerBundle = await io.fetchKeys(
      input.relay, authOf(input), input.from,
    );
    const callerPeer = await io.verifyAndPinPeer(input.machine, fromAddress, callerBundle);
    const localKeys = io.loadKeys(input.paths);
    const request = await openE2EERequest(
      input.envelope, localKeys.encryption_pkcs8, callerPeer.identity_pub,
      {
        relay_origin: relayOrigin, from: fromAddress, to: toAddress,
        key_id: await keyIdFor(localKeys.encryption_pub), epoch: localKeys.epoch,
      },
    );
    await io.reserveReplay(input.machine, {
      sender_fingerprint: callerPeer.fingerprint,
      request_id: request.request_id,
      expires_at: request.expires_at,
    });
    return {
      ok: true,
      envelope: { request, callerBundle, callerPeer, localKeys, relayOrigin, fromAddress, toAddress },
    };
  } catch (error) {
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// Stage 5: seal + send a response envelope. A factory rather than a bare
// function so the per-call binding (request, addresses, keys) is closed over
// once and every outcome (reply, busy, context_unknown, agent_error, ...)
// reuses the same sender.
// ---------------------------------------------------------------------------

interface OutcomeSenderInput {
  callId: string;
  relayOrigin: string;
  fromAddress: string;
  toAddress: string;
  request: E2EERequestPayloadType;
  requestHash: string;
  localKeys: StoredKeys;
  callerBundle: CallerKeyBundle;
  send: (obj: unknown) => void;
}

export function makeOutcomeSender(
  input: OutcomeSenderInput, seal: typeof sealE2EEResponse,
): (outcome: E2EEOutcomeType) => Promise<string | undefined> {
  return async (outcome) => {
    try {
      const issuedAt = Date.now();
      const payload: E2EEResponsePayloadType = {
        v: 1,
        direction: "response",
        relay_origin: input.relayOrigin,
        from: input.toAddress,
        to: input.fromAddress,
        request_id: input.request.request_id,
        sender_identity_key_id: await keyIdFor(input.localKeys.identity_pub),
        recipient_encryption_key_id: input.callerBundle.encryption.record.key_id,
        recipient_epoch: input.callerBundle.encryption.record.epoch,
        issued_at: issuedAt,
        expires_at: input.request.expires_at,
        request_transcript_hash: input.requestHash,
        outcome,
      };
      const envelope = await seal(payload, input.localKeys, {
        pub: input.callerBundle.encryption.record.pub,
        key_id: input.callerBundle.encryption.record.key_id,
        epoch: input.callerBundle.encryption.record.epoch,
      });
      input.send({
        type: "call_outcome", call_id: input.callId,
        terminal: outcome.kind === "reply" ? "completed" : "failed",
        envelope,
      });
      return undefined;
    } catch (error) {
      const detail = String(error).slice(0, 2_000);
      console.error(`Listener could not seal outcome for encrypted call ${input.callId}: ${detail}`);
      return detail;
    }
  };
}

// ---------------------------------------------------------------------------
// Stage 6: policy resolution — loadPolicy -> loadSensitivityMap -> resolveTask.
//
// CaMeL invariant, preserved from listener.ts: this runs on the verified
// `from` and local files only, BEFORE the caller's message is placed in any
// prompt (see policy.ts). Refusals never enqueue and never spawn: no tokens
// are burned by blocked callers or task probing.
//
// The loaded policy is RETURNED, not merely consumed. The caller needs the
// same table again to resolve clearance, and re-reading policy.json there
// would mean two loads of one file that can disagree if it changes in
// between — and would put the second load outside this function's
// policy_error path, which is the only reason a corrupt policy reports as a
// failure rather than as a rejection.
// ---------------------------------------------------------------------------

type AdmissionDecision =
  | { ok: true; task: Task; policy: Policy; map: SensitivityMap }
  | { ok: false; code: "policy_error"; error: unknown }
  | { ok: false; code: "blocked" | "task_unknown"; offered: string[] };

export function resolveAdmission(
  input: { paths: LinePaths; from: string; requestedTask?: string; groups: readonly string[] },
): AdmissionDecision {
  let policy: Policy;
  let map: SensitivityMap;
  let resolution: TaskResolution;
  try {
    policy = loadPolicy(input.paths);
    // Loaded here, inside the policy_error boundary, and returned like the
    // policy. #372 made this file decide where the agent runs and what it may
    // read, so it is now load-bearing for the CALL and not only for the guard
    // subprocess. Before, a corrupt sensitivity.json surfaced as every tool
    // call failing closed — an agent silently unable to read anything,
    // diagnosable only from the guard's own log. Reading it here turns that
    // into one clean call_failed carrying the parse error, which is the same
    // treatment a corrupt policy.json already gets.
    map = withFloor(loadSensitivityMap(input.paths), input.paths.machine.userHome);
    resolution = resolveTask(policy, loadTasks(input.paths), input.from, input.requestedTask, input.groups);
  } catch (error) {
    return { ok: false, code: "policy_error", error };
  }
  if (!resolution.ok) {
    return { ok: false, code: resolution.code, offered: resolution.offered };
  }
  // No workdir here any more. It depends on the caller's CLEARANCE, which is
  // resolved from `policy` by the caller of this function — deliberately after
  // admission, so a corrupt policy reports as policy_error rather than as a
  // rejection. Returning the map and the policy lets that happen without a
  // second read of either file.
  return { ok: true, task: resolution.task, policy, map };
}

// ---------------------------------------------------------------------------
// Stage 7: context-binding admission.
//
// Task resolution (stage 6) ran on the verified `from` and local files only
// (see policy.ts's CaMeL invariant). context_id is caller-controlled, so it
// is consulted only AFTER, and only to confirm the binding was made under
// the SAME task. It can narrow a call, never select one. Inverting this
// order reopens the hole the design exists to close.
// ---------------------------------------------------------------------------

type BindingDecision =
  | { ok: true; now: number; threadingAvailable: boolean; contexts: ContextBinding[]; binding: ContextBinding | undefined }
  | { ok: false; now: number; threadingAvailable: boolean; contexts: ContextBinding[] };

export function admitBinding(
  input: {
    paths: LinePaths; from: string; taskId: string; contextId: string | undefined;
    threadable: boolean; agentKind: "claude" | "codex"; codexCanThread: boolean;
    workdirDir: string; now?: number;
  },
): BindingDecision {
  const now = input.now ?? Date.now();
  const threadingAvailable = input.threadable && (input.agentKind === "claude" || input.codexCanThread);
  const contexts = pruneContexts(loadContexts(input.paths), now);
  if (input.contextId === undefined) {
    return { ok: true, now, threadingAvailable, contexts, binding: undefined };
  }
  // `threadingAvailable` gates admission as well as minting. A binding
  // outlives the conditions it was minted under: the owner can add
  // `write`/`exec` to a task's SKILL.md (or set `threadable: false`) and
  // admitContext would still match on the unchanged task *id*, resuming a
  // conversation against an envelope the owner has just decided must not
  // carry one. Same for the codex gate — an old binding must not be able
  // to hand runAgent a resume id after codex threading becomes unavailable.
  const binding = threadingAvailable
    ? admitContext(contexts, {
        context_id: input.contextId, caller: input.from, task: input.taskId,
        agent_kind: input.agentKind, workdir: input.workdirDir, now,
      })
    : undefined;
  // One code for every failure — expired, not yours, wrong task, wrong
  // directory, threading withdrawn. Distinguishing them would tell an
  // attacker that a guessed token exists but belongs to someone else. And
  // this FAILS the call rather than quietly starting a fresh session,
  // because a silent almost-right answer is the #43/#51 failure mode.
  if (!binding) return { ok: false, now, threadingAvailable, contexts };
  return { ok: true, now, threadingAvailable, contexts, binding };
}
