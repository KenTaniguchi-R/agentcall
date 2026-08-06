import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROOM_AGENT_TIMEOUT_MS, ROOM_MAX_CALLS_PER_PARTICIPANT, ROOM_MAX_PROMPT_BYTES,
  openRoomCallOutcome, openRoomCallRequest, roomCallCiphertextDigest,
  randomBase64Url, sealRoomCallOutcome, sealRoomCallRequest,
  type AgentKind, type RoomCallBindingType, type RoomCallFailureCode,
  type RoomMutationResponseType, type RoomPublicParticipantType,
  type RoomRelayCallErrorCodeType, type RoomSocketRelayFrameType,
} from "@benree/agentcall-shared";
import type { z } from "zod";
import { AgentRunError } from "./runner.js";
import { resolveRoomName } from "./room-directory.js";
import { runRoomSafeAgent } from "./room-safety.js";
import { openRoomSocket, type RoomSocket, type RoomSocketCloseReason } from "./room-socket.js";
import type { RoomKeyMaterial } from "./room-crypto.js";

type FailureCode = z.infer<typeof RoomCallFailureCode>;

export type RoomSessionEnd =
  | { kind: "left" }
  | { kind: "disconnected"; reason: RoomSocketCloseReason };

export interface RoomSessionOptions {
  relay: string;
  credential: string;
  ownParticipantId: string;
  keys: RoomKeyMaterial;
  snapshot: RoomMutationResponseType;
  agent: AgentKind;
  print: (line: string) => void;
  openSocket?: typeof openRoomSocket;
  runAgent?: typeof runRoomSafeAgent;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export interface RoomSession {
  ask(typedName: string, message: string): Promise<void>;
  members(): string;
  /** Snapshot updates arrive from the caller's existing poll loop. */
  update(snapshot: RoomMutationResponseType): void;
  close(): void;
  ended: Promise<RoomSessionEnd>;
}

const CALL_ERROR_COPY: Record<RoomRelayCallErrorCodeType, string> = {
  protocol_error: "The relay rejected that call.",
  busy: "They're already answering a question. Try again in a moment.",
  paused: "They've paused questions.",
  offline: "They're not connected right now.",
  unknown_target: "They've left the Room.",
  self_target: "You can't ask your own agent.",
  room_inactive: "The Room isn't active.",
  limit: `You've used all ${ROOM_MAX_CALLS_PER_PARTICIPANT} of your questions.`,
  cooldown: "Slow down — wait a few seconds between questions.",
  peer_left: "They left before answering.",
  room_expired: "The Room's time limit was reached.",
  canceled: "The call was canceled.",
};

const FAILURE_COPY: Record<FailureCode, string> = {
  agent_error: "their agent hit an error",
  agent_timeout: "their agent ran out of time",
  canceled: "the call was canceled",
  undeliverable: "the answer could not be read",
};

function newId(prefix: "rc"): string {
  return `${prefix}_${randomBase64Url(16)}`;
}

/**
 * `runRoomSafeAgent` asserts its workdir is an empty, non-symlink directory —
 * so each inbound call gets a fresh one, and it is removed whatever happens.
 * This is the "no project files" half of the safe-mode contract: the agent
 * answering a stranger's question starts in a directory containing nothing.
 */
function withEmptyWorkdir<T>(run: (workdir: string) => Promise<T>): Promise<T> {
  const workdir = mkdtempSync(join(tmpdir(), "agentcall-room-"));
  return run(workdir).finally(() => {
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}

export function startRoomSession(options: RoomSessionOptions): RoomSession {
  const {
    relay, credential, ownParticipantId, keys, agent, print,
    openSocket = openRoomSocket, runAgent = runRoomSafeAgent,
    now = () => Date.now(), env = process.env,
  } = options;

  let snapshot = options.snapshot;
  let socket: RoomSocket | undefined;
  let pending: {
    callId: string;
    binding: RoomCallBindingType;
    peer: RoomPublicParticipantType;
    resolve: () => void;
  } | undefined;
  const inbound = new Map<string, AbortController>();
  let asked = 0;

  let settle: (end: RoomSessionEnd) => void;
  const ended = new Promise<RoomSessionEnd>((resolve) => { settle = resolve; });

  const participants = (): readonly RoomPublicParticipantType[] => snapshot.participants;
  const self = (): RoomPublicParticipantType | undefined =>
    participants().find((p) => p.participant_id === ownParticipantId);

  function finishPending(line?: string): void {
    if (line) print(line);
    const settled = pending;
    pending = undefined;
    settled?.resolve();
  }

  async function answer(frame: Extract<RoomSocketRelayFrameType, { type: "room_incoming_call" }>): Promise<void> {
    const binding: RoomCallBindingType = {
      room_id: frame.room_id,
      membership_epoch: frame.membership_epoch,
      from_participant_id: frame.from_participant_id,
      to_participant_id: frame.to_participant_id,
      call_id: frame.call_id,
    };
    const peer = participants().find((p) => p.participant_id === frame.from_participant_id);

    const fail = async (code: FailureCode): Promise<void> => {
      // A failure still goes back sealed, so the relay cannot tell a failure
      // from a reply, or learn why one happened.
      if (!peer) {
        socket?.send({ type: "room_call_outcome", call_id: frame.call_id, terminal: "failed" });
        return;
      }
      socket?.send({
        type: "room_call_outcome", call_id: frame.call_id, terminal: "failed",
        encrypted_outcome: await sealRoomCallOutcome({
          binding, payload: { v: 1, issued_at: now(), outcome: { kind: "failure", code } },
          recipientEncryptionPublicKey: peer.encryption_public_key,
          senderSigningPrivateKey: keys.signing.privateKey,
        }),
      });
    };

    if (!peer) {
      // The sender is relay-attested but absent from our roster, so we hold no
      // key to seal an answer to. Report the failure without a body.
      socket?.send({ type: "room_call_accepted", call_id: frame.call_id });
      await fail("undeliverable");
      return;
    }

    const request = await openRoomCallRequest({
      envelope: frame.encrypted_request, binding,
      recipientEncryptionPrivateKey: keys.encryption.privateKey,
      senderSigningPublicKey: peer.signing_public_key,
    });
    socket?.send({ type: "room_call_accepted", call_id: frame.call_id });

    if (!request || request.expires_at <= now() || frame.expires_at <= now()) {
      await fail("undeliverable");
      return;
    }

    print(`\n${peer.display_name} asked: ${request.message}`);
    print("Answering in safe mode (no files, no tools)…");

    const controller = new AbortController();
    inbound.set(frame.call_id, controller);
    socket?.send({ type: "room_call_started", call_id: frame.call_id });

    try {
      const output = await withEmptyWorkdir((workdir) => runAgent({
        agent, prompt: request.message, workdir, env,
        // The relay's deadline wins when it is nearer than the agent budget:
        // work finishing after it would be discarded anyway.
        timeoutMs: Math.max(1, Math.min(ROOM_AGENT_TIMEOUT_MS, frame.expires_at - now())),
        signal: controller.signal,
      }));
      const text = output.text.trim();
      if (!text) {
        await fail("agent_error");
      } else {
        socket?.send({
          type: "room_call_outcome", call_id: frame.call_id, terminal: "completed",
          encrypted_outcome: await sealRoomCallOutcome({
            binding, payload: { v: 1, issued_at: now(), outcome: { kind: "reply", text } },
            recipientEncryptionPublicKey: peer.encryption_public_key,
            senderSigningPrivateKey: keys.signing.privateKey,
          }),
        });
        print(`Answered ${peer.display_name}.`);
      }
    } catch (error) {
      const code: FailureCode = error instanceof AgentRunError
        ? (error.code === "timeout" ? "agent_timeout" : error.code === "canceled" ? "canceled" : "agent_error")
        : "agent_error";
      await fail(code);
      print(`Could not answer ${peer.display_name}: ${FAILURE_COPY[code]}.`);
    } finally {
      inbound.delete(frame.call_id);
    }
  }

  async function onFrame(frame: RoomSocketRelayFrameType): Promise<void> {
    if (frame.type === "room_incoming_call") {
      if (frame.to_participant_id !== ownParticipantId) return;
      await answer(frame);
      return;
    }
    if (frame.type === "room_cancel_call") {
      inbound.get(frame.call_id)?.abort();
      inbound.delete(frame.call_id);
      socket?.send({ type: "room_call_canceled", call_id: frame.call_id });
      return;
    }
    if (frame.type === "room_call_error") {
      if (frame.call_id && frame.call_id !== pending?.callId) return;
      finishPending(CALL_ERROR_COPY[frame.code]);
      return;
    }
    if (frame.type === "room_call_status") {
      if (frame.call_id === pending?.callId && frame.state === "working") {
        print(`${pending.peer.display_name}'s agent is working…`);
      }
      return;
    }
    if (frame.type === "room_call_result") {
      const call = pending;
      if (!call || frame.call_id !== call.callId) return;
      if (frame.terminal !== "completed" || !frame.encrypted_outcome) {
        finishPending(frame.terminal === "expired"
          ? `${call.peer.display_name} did not answer in time.`
          : `No answer from ${call.peer.display_name} (${frame.terminal}).`);
        return;
      }
      const outcome = await openRoomCallOutcome({
        envelope: frame.encrypted_outcome, binding: call.binding,
        recipientEncryptionPrivateKey: keys.encryption.privateKey,
        senderSigningPublicKey: call.peer.signing_public_key,
      });
      if (!outcome) {
        // Either the relay altered the envelope or it was not sealed by the
        // participant we addressed. Both are the same finding to the user.
        finishPending(`The answer from ${call.peer.display_name} did not verify — discarding it.`);
        return;
      }
      finishPending(outcome.outcome.kind === "reply"
        ? `${call.peer.display_name}: ${outcome.outcome.text}`
        : `${call.peer.display_name} could not answer — ${FAILURE_COPY[outcome.outcome.code]}.`);
    }
  }

  socket = openSocket({
    relay, credential, onFrame,
    onClosed: (reason) => {
      for (const controller of inbound.values()) controller.abort();
      inbound.clear();
      finishPending(reason.kind === "local" ? undefined : "Lost the connection to the Room.");
      settle(reason.kind === "local" ? { kind: "left" } : { kind: "disconnected", reason });
    },
  });

  return {
    async ask(typedName: string, message: string): Promise<void> {
      if (pending) {
        print("Wait for the current answer before asking again.");
        return;
      }
      const trimmed = message.trim();
      if (!trimmed) {
        print("Ask them something: ask <name> \"<question>\"");
        return;
      }
      if (Buffer.byteLength(trimmed, "utf8") > ROOM_MAX_PROMPT_BYTES) {
        print(`That question is too long — the limit is ${ROOM_MAX_PROMPT_BYTES} bytes.`);
        return;
      }
      if (asked >= ROOM_MAX_CALLS_PER_PARTICIPANT) {
        print(CALL_ERROR_COPY.limit);
        return;
      }

      const resolution = resolveRoomName({ typed: typedName, participants: participants(), ownParticipantId });
      if (resolution.kind === "address") {
        print("In a Room, use the person's display name — for example: ask sota \"…\"");
        print("An address like @acme/sota is for `agentcall call`, which a Room can't reach.");
        return;
      }
      if (resolution.kind === "self") {
        print(CALL_ERROR_COPY.self_target);
        return;
      }
      if (resolution.kind === "unknown") {
        print(`No one here is called "${resolution.typed}". In the Room: ${
          participants().map((p) => p.display_name).join(", ")}`);
        return;
      }
      if (resolution.kind === "ambiguous") {
        print(`"${resolution.typed}" matches ${resolution.matches.length} people — not sending to either.`);
        return;
      }

      const peer = resolution.participant;
      const callId = newId("rc");
      const binding: RoomCallBindingType = {
        room_id: snapshot.room.room_id,
        membership_epoch: snapshot.room.membership_epoch,
        from_participant_id: ownParticipantId,
        to_participant_id: peer.participant_id,
        call_id: callId,
      };
      const issuedAt = now();
      const encrypted = await sealRoomCallRequest({
        binding,
        payload: {
          v: 1, issued_at: issuedAt, expires_at: issuedAt + ROOM_AGENT_TIMEOUT_MS, message: trimmed,
        },
        recipientEncryptionPublicKey: peer.encryption_public_key,
        senderSigningPrivateKey: keys.signing.privateKey,
      });

      asked += 1;
      const wait = new Promise<void>((resolve) => {
        pending = { callId, binding, peer, resolve };
      });
      socket?.send({
        type: "room_call_submit",
        call_id: callId as `rc_${string}`,
        idempotency_key: randomBase64Url(16),
        to_participant_id: peer.participant_id as `rp_${string}`,
        request_digest: await roomCallCiphertextDigest(encrypted),
        encrypted_request: encrypted,
      });
      print(`Asked ${peer.display_name}. ${
        ROOM_MAX_CALLS_PER_PARTICIPANT - asked} question${
        ROOM_MAX_CALLS_PER_PARTICIPANT - asked === 1 ? "" : "s"} left.`);
      await wait;
    },

    members(): string {
      const own = self();
      return participants().map((p) => {
        const you = p.participant_id === ownParticipantId ? " (you)" : "";
        const paused = p.state === "paused" ? " · paused" : p.state === "departed" ? " · left" : "";
        return `  ${p.display_name}${you}${paused}`;
      }).concat(own ? [] : ["  (you are no longer in this Room)"]).join("\n");
    },

    update(next: RoomMutationResponseType): void {
      snapshot = next;
    },

    close(): void {
      socket?.close();
    },

    ended,
  };
}
