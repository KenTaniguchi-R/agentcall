import { RoomInviteCapability, randomBase64Url, type RoomCloseReasonType } from "@benree/agentcall-shared";
import { checkRoomSafetyEligibility } from "./room-safety.js";
import { generateRoomKeys, signRoomJoinProof, type RoomJoinProofInput } from "./room-crypto.js";
import { joinRoom, RoomApiError } from "./room-api.js";
import { pollRoomState } from "./room-poll.js";
import { suggestAlternateDisplayName } from "./room-render.js";
import { runRoomVerification, type RoomVerificationResult } from "./room-verification.js";
import { ask, hiddenAsk } from "./tty.js";

const AGENT_ADAPTER_RE = /^(?:claude|codex)@(\d+\.\d+\.\d+):(\w+)\/(\w+)$/;
const MAX_NAME_RETRIES = 4;

function agentAdapterString(agent: "claude" | "codex", version: string): string {
  const adapter = `${agent}@${version}:${process.platform}/${process.arch}`;
  if (!AGENT_ADAPTER_RE.test(adapter)) throw new Error(`could not build a valid Room agent_adapter string from ${adapter}`);
  return adapter;
}

export interface RoomGuestOptions {
  relay: string;
  agent?: "claude" | "codex";
  log?: (line: string) => void;
  askInvite?: (question: string) => Promise<string>;
  askName?: (question: string) => Promise<string>;
  checkEligibility?: typeof checkRoomSafetyEligibility;
  join?: typeof joinRoom;
  poll?: typeof pollRoomState;
  runVerification?: typeof runRoomVerification;
  generateKeys?: typeof generateRoomKeys;
}

export async function runRoomGuest(options: RoomGuestOptions): Promise<RoomVerificationResult> {
  const {
    relay, agent = "claude", log = (line: string) => console.log(line),
    askInvite = hiddenAsk, askName = ask, checkEligibility = checkRoomSafetyEligibility,
    join = joinRoom, poll = pollRoomState, runVerification = runRoomVerification,
    generateKeys = generateRoomKeys,
  } = options;

  const eligibility = checkEligibility({ agent });
  if (!eligibility.supported) {
    throw new Error(`This machine can't join a Room yet: ${eligibility.reason}`);
  }
  log("AgentCall found Claude Code and verified the Room safety adapter.");

  const invite = (await askInvite("Invitation (hidden input): ")).trim();
  if (!RoomInviteCapability.safeParse(invite).success) {
    throw new Error("That doesn't look like a Room invitation (expected `acri....`).");
  }

  const keys = await generateKeys();
  const adapter = agentAdapterString(agent, eligibility.evidence.cliVersion);
  const secret = randomBase64Url(32);

  let displayName = (await askName("Name in this Room [Guest]: ")).trim() || "Guest";
  for (let attempt = 0; attempt <= MAX_NAME_RETRIES; attempt++) {
    const unsigned: RoomJoinProofInput = {
      invite, participant_secret: secret, display_name: displayName,
      signing_public_key: keys.signingPublicKey, encryption_public_key: keys.encryptionPublicKey,
      agent_adapter: adapter,
    };
    const signing_proof = await signRoomJoinProof(keys, unsigned);
    try {
      const joined = await join(relay, { ...unsigned, signing_proof });
      log(`${displayName} is asking to join. Waiting for the host to admit you…`);
      if (!joined.credential) {
        throw new Error("The relay accepted the join but did not return a Room credential.");
      }
      const admission = await new Promise<
        { admitted: true } | { closed: true; reason: RoomCloseReasonType | "unknown" }
      >((resolve) => {
        const handle = poll({
          relay, credential: joined.credential!, ownParticipantId: joined.participant.participant_id,
          onSnapshot: (snapshot) => {
            if (snapshot.room.state === "closed") {
              handle.stop();
              resolve({ closed: true, reason: snapshot.room.close_reason ?? "unknown" });
              return;
            }
            const self = snapshot.participant;
            if (self && self.state !== "pending") {
              handle.stop();
              resolve({ admitted: true });
            }
          },
          onError: () => {},
        });
      });
      if ("closed" in admission) {
        return { outcome: "closed", reason: admission.reason };
      }
      return runVerification({
        relay, credential: joined.credential, ownParticipantId: joined.participant.participant_id,
      });
    } catch (error) {
      if (error instanceof RoomApiError && error.code === "conflict" && attempt < MAX_NAME_RETRIES) {
        const suggestion = suggestAlternateDisplayName(displayName, attempt + 1);
        log(`That name's taken — try another (suggested: ${suggestion}):`);
        displayName = (await askName(`Name in this Room [${suggestion}]: `)).trim() || suggestion;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not find an unused display name for this Room.");
}
