import type { RoomCloseReasonType } from "@benree/agentcall-shared";
import { checkRoomSafetyEligibility } from "./room-safety.js";
import { generateRoomKeys, parseRoomCapability } from "./room-crypto.js";
import { createRoom, mutateRoom } from "./room-api.js";
import { pollRoomState } from "./room-poll.js";
import { formatInviteLines, resolveHostDisplayName } from "./room-render.js";
import { runRoomVerification, type RoomVerificationResult } from "./room-verification.js";
import { createLineListener } from "./tty.js";

const AGENT_ADAPTER_RE = /^(?:claude|codex)@(\d+\.\d+\.\d+):(\w+)\/(\w+)$/;

function agentAdapterString(agent: "claude" | "codex", version: string): string {
  const adapter = `${agent}@${version}:${process.platform}/${process.arch}`;
  if (!AGENT_ADAPTER_RE.test(adapter)) throw new Error(`could not build a valid Room agent_adapter string from ${adapter}`);
  return adapter;
}

export interface RoomHostOptions {
  seats: number;
  relay: string;
  displayName?: string;
  agent?: "claude" | "codex";
  log?: (line: string) => void;
  checkEligibility?: typeof checkRoomSafetyEligibility;
  createRoomFn?: typeof createRoom;
  poll?: typeof pollRoomState;
  mutate?: typeof mutateRoom;
  createListener?: typeof createLineListener;
  runVerification?: typeof runRoomVerification;
  generateKeys?: typeof generateRoomKeys;
}

export async function runRoomHost(options: RoomHostOptions): Promise<RoomVerificationResult> {
  const {
    seats, relay, displayName, agent = "claude", log = (line: string) => console.log(line),
    checkEligibility = checkRoomSafetyEligibility, createRoomFn = createRoom,
    poll = pollRoomState, mutate = mutateRoom, createListener = createLineListener,
    runVerification = runRoomVerification, generateKeys = generateRoomKeys,
  } = options;
  if (seats < 2 || seats > 6) throw new Error("Room seats must be between 2 and 6.");

  const eligibility = checkEligibility({ agent });
  if (!eligibility.supported) {
    throw new Error(`This machine can't host a Room yet: ${eligibility.reason}`);
  }
  log("AgentCall found Claude Code and verified the Room safety adapter.");

  const keys = await generateKeys();
  const name = resolveHostDisplayName(displayName);
  const created = await createRoomFn(relay, {
    expected_participants: seats as 2 | 3 | 4 | 5 | 6,
    display_name: name,
    signing_public_key: keys.signingPublicKey,
    encryption_public_key: keys.encryptionPublicKey,
    agent_adapter: agentAdapterString(agent, eligibility.evidence.cliVersion),
  });
  const own = parseRoomCapability(created.credential);
  if (!own) throw new Error("The relay returned a Room credential this CLI could not parse.");

  log("");
  log(`This creates a private ${seats}-person Room for up to 30 minutes.`);
  log("No account, Team, address, saved identity, or background listener will be created.");
  log("");
  log("Ask each person to run:");
  log("  agentcall room join");
  log("");
  for (const line of formatInviteLines(created.invite)) log(line);
  log(`Waiting for ${seats - 1} people…  Ctrl-C closes the Room.`);

  const listener = createListener();
  const seenPending = new Set<string>();
  let pendingAdmitResolve: ((line: string) => void) | undefined;
  let startRequested = false;
  listener.onLine((line) => {
    if (pendingAdmitResolve) {
      pendingAdmitResolve(line);
      pendingAdmitResolve = undefined;
      return;
    }
    if (line.trim() === "/start") startRequested = true;
  });

  const waitingResult = await new Promise<
    { locked: true } | { closed: true; reason: RoomCloseReasonType | "unknown" }
  >((resolve) => {
    let admitting = false;
    const handle = poll({
      relay, credential: created.credential, ownParticipantId: own.participantId,
      onSnapshot: async (snapshot) => {
        if (snapshot.room.state === "closed") {
          handle.stop();
          resolve({ closed: true, reason: snapshot.room.close_reason ?? "unknown" });
          return;
        }
        if (snapshot.room.state !== "waiting") {
          handle.stop();
          resolve({ locked: true });
          return;
        }
        if (admitting) return;
        const newlyPending = snapshot.participants.filter(
          (p) => p.state === "pending" && !seenPending.has(p.participant_id),
        );
        for (const guest of newlyPending) {
          seenPending.add(guest.participant_id);
          admitting = true;
          listener.print(`${guest.display_name} wants to join. Admit? [Y/n] `);
          const answer = await new Promise<string>((res) => { pendingAdmitResolve = res; });
          const admit = answer.trim() === "" || answer.trim().toLowerCase().startsWith("y");
          await mutate(relay, created.credential, admit ? "admit" : "deny", guest.participant_id).catch(() => {});
          admitting = false;
        }
        const admittedCount = snapshot.participants.filter((p) => p.state === "admitted").length + 1; // +1 = host
        if (startRequested) {
          startRequested = false;
          if (admittedCount < 2) {
            listener.print("Wait for at least one guest to be admitted before starting early.\n");
          } else {
            await mutate(relay, created.credential, "lock").catch(() => {});
          }
        }
      },
      onError: () => {},
    });
  });
  listener.close();

  if ("closed" in waitingResult) {
    return { outcome: "closed", reason: waitingResult.reason };
  }

  return runVerification({
    relay, credential: created.credential, ownParticipantId: own.participantId,
  });
}
