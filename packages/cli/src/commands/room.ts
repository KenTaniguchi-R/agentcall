import type { Command } from "commander";
import { normalizeRelay, relayUrl } from "../config.js";
import { runRoomHost } from "../room-host.js";
import { runRoomGuest } from "../room-guest.js";
import { formatCloseReason } from "../room-render.js";
import type { RoomConversationResult } from "../room-repl.js";

interface RoomHostFlags {
  relay?: string;
  name?: string;
}

interface RoomJoinFlags {
  relay?: string;
}

// The membership code is printed by the host/guest flows themselves, right
// before the conversation starts (#369 reports it, never gates on it). What
// reaches here is only how the Room ended.
function report(result: RoomConversationResult): void {
  if (result.outcome === "closed") {
    console.log(formatCloseReason(result.reason === "unknown" ? "relay_error" : result.reason));
    process.exitCode = 1;
    return;
  }
  if (result.outcome === "disconnected") {
    console.log("Lost the connection to the Room. A Room can't be rejoined — start a new one.");
    process.exitCode = 1;
    return;
  }
  console.log("You left the Room.");
}

export function register(program: Command): void {
  const room = program.command("room")
    .description("host a temporary, accountless group Room — no account, handle, or listener required")
    .option("--relay <url>", "relay URL")
    .option("--name <name>", "your display name in this Room")
    .action(async (opts: RoomHostFlags) => {
      const relay = normalizeRelay(opts.relay ?? relayUrl());
      report(await runRoomHost({ relay, displayName: opts.name }));
    });

  room.command("join")
    .description("join a Room using an invitation from its host")
    .option("--relay <url>", "relay URL")
    .action(async (opts: RoomJoinFlags) => {
      const relay = normalizeRelay(opts.relay ?? relayUrl());
      report(await runRoomGuest({ relay }));
    });
}
