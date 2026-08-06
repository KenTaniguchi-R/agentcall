import type { AgentKind, RoomCloseReasonType, RoomMutationResponseType } from "@benree/agentcall-shared";
import { ROOM_MAX_CALLS_PER_PARTICIPANT } from "@benree/agentcall-shared";
import { mutateRoom } from "./room-api.js";
import { pollRoomState } from "./room-poll.js";
import { startRoomSession, type RoomSession, type RoomSessionEnd } from "./room-session.js";
import { createLineListener } from "./tty.js";
import type { RoomKeyMaterial } from "./room-crypto.js";

export type RoomCommand =
  | { kind: "ask"; name: string; message: string }
  | { kind: "members" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "help" }
  | { kind: "leave" }
  | { kind: "blank" }
  | { kind: "address"; typed: string }
  | { kind: "unknown"; typed: string };

const HELP = [
  `  ask <name> <question>   ask that person's agent (${ROOM_MAX_CALLS_PER_PARTICIPANT} questions each)`,
  "  /members                who's in the Room",
  "  /pause                  stop receiving questions",
  "  /resume                 start receiving them again",
  "  /leave                  leave the Room",
].join("\n");

/**
 * A Room takes a bare display name, never an address (#347). `formatAddress`
 * is `@${org}/${handle}`, so a leading `@` is unambiguously the durable path —
 * which is worth its own message rather than "unknown command", because
 * someone typing `@acme/sota` here knows exactly who they mean.
 */
export function parseRoomCommand(line: string): RoomCommand {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "blank" };

  if (trimmed.startsWith("/")) {
    const word = trimmed.slice(1).split(/\s+/, 1)[0]!.toLowerCase();
    if (word === "members" || word === "who") return { kind: "members" };
    if (word === "pause") return { kind: "pause" };
    if (word === "resume") return { kind: "resume" };
    if (word === "help" || word === "?") return { kind: "help" };
    if (word === "leave" || word === "quit" || word === "exit") return { kind: "leave" };
    return { kind: "unknown", typed: trimmed };
  }

  if (trimmed.startsWith("@")) return { kind: "address", typed: trimmed };

  const match = /^ask\s+(\S+)\s+([\s\S]+)$/i.exec(trimmed);
  if (!match) return { kind: "unknown", typed: trimmed };
  const message = match[2]!.trim();
  // Accept both `ask sota "why did CI fail?"` and the same line unquoted; a
  // shell-style quote is the reflex, and stripping it beats sending a question
  // that begins and ends with a stray quotation mark.
  const unquoted = /^"([\s\S]*)"$/.exec(message) ?? /^'([\s\S]*)'$/.exec(message);
  return { kind: "ask", name: match[1]!, message: (unquoted?.[1] ?? message).trim() };
}

export interface RoomConversationOptions {
  relay: string;
  credential: string;
  ownParticipantId: string;
  keys: RoomKeyMaterial;
  snapshot: RoomMutationResponseType;
  agent?: AgentKind;
  startSession?: typeof startRoomSession;
  poll?: typeof pollRoomState;
  mutate?: typeof mutateRoom;
  createListener?: typeof createLineListener;
}

export type RoomConversationResult =
  | { outcome: "left" }
  | { outcome: "disconnected" }
  | { outcome: "closed"; reason: RoomCloseReasonType | "unknown" };

/**
 * The foreground loop from "Room active" to the Room ending.
 *
 * The poll keeps running underneath it, and not only to refresh the roster:
 * `pollRoomState` heartbeats, and a participant that stops heartbeating is
 * marked departed after ROOM_HEARTBEAT_GRACE_MS. A session that only listened
 * on the socket would be evicted 15 seconds in.
 */
export function runRoomConversation(options: RoomConversationOptions): Promise<RoomConversationResult> {
  const {
    relay, credential, ownParticipantId, keys, agent = "claude",
    startSession = startRoomSession, poll = pollRoomState, mutate = mutateRoom,
    createListener = createLineListener,
  } = options;

  const listener = createListener();
  const print = (text: string): void => listener.print(`${text}\n`);

  let session: RoomSession | undefined;
  let handle: ReturnType<typeof poll> | undefined;
  let finished = false;
  let resolveResult: (result: RoomConversationResult) => void;
  const result = new Promise<RoomConversationResult>((resolve) => { resolveResult = resolve; });

  // Declared before the poll and the session it tears down: either can end the
  // conversation, and either may do so before the other has been assigned.
  const finish = (value: RoomConversationResult): void => {
    if (finished) return;
    finished = true;
    handle?.stop();
    listener.close();
    session?.close();
    resolveResult(value);
  };

  session = startSession({
    relay, credential, ownParticipantId, keys, snapshot: options.snapshot, agent, print,
  });

  handle = poll({
    relay, credential, ownParticipantId,
    onSnapshot: (snapshot) => {
      if (snapshot.room.state === "closed") {
        finish({ outcome: "closed", reason: snapshot.room.close_reason ?? "unknown" });
        return;
      }
      session?.update(snapshot);
    },
    onError: () => {},
  });

  void session.ended.then((end: RoomSessionEnd) => {
    finish(end.kind === "left" ? { outcome: "left" } : { outcome: "disconnected" });
  });

  print(`Ask anyone here a question. ${ROOM_MAX_CALLS_PER_PARTICIPANT} each. /help for commands.`);

  // Serialized: `ask` awaits its answer, and a line typed meanwhile would
  // otherwise interleave two calls the relay would reject as `busy` anyway.
  let queue: Promise<void> = Promise.resolve();
  listener.onLine((line) => {
    queue = queue.then(async () => {
      if (finished || !session) return;
      const command = parseRoomCommand(line);
      switch (command.kind) {
        case "blank":
          return;
        case "ask":
          await session.ask(command.name, command.message);
          return;
        case "members":
          print(session.members());
          return;
        case "pause":
          await mutate(relay, credential, "pause").then(
            () => print("Paused — you won't receive questions."),
            () => print("Could not pause."),
          );
          return;
        case "resume":
          await mutate(relay, credential, "resume").then(
            () => print("Resumed."),
            () => print("Could not resume."),
          );
          return;
        case "help":
          print(HELP);
          return;
        case "leave":
          await mutate(relay, credential, "leave").catch(() => {});
          finish({ outcome: "left" });
          return;
        case "address":
          print("In a Room, use the person's display name — for example: ask sota \"…\"");
          print("An address like @acme/sota is for `agentcall call`, which a Room can't reach.");
          return;
        case "unknown":
          print(`Not a command. Try: ask <name> <question>, or /help`);
      }
    }).catch(() => {});
  });

  return result;
}
