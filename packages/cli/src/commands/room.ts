import type { Command } from "commander";
import { normalizeRelay, relayUrl } from "../config.js";
import { runRoomHost } from "../room-host.js";
import { runRoomGuest } from "../room-guest.js";
import { formatCloseReason } from "../room-render.js";

interface RoomHostFlags {
  relay?: string;
  name?: string;
}

interface RoomJoinFlags {
  relay?: string;
}

export function register(program: Command): void {
  const room = program.command("room")
    .description("host a temporary, accountless group Room — no account, handle, or listener required")
    .option("--relay <url>", "relay URL")
    .option("--name <name>", "your display name in this Room")
    .action(async (opts: RoomHostFlags) => {
      const relay = normalizeRelay(opts.relay ?? relayUrl());
      const result = await runRoomHost({ relay, displayName: opts.name });
      if (result.outcome === "closed") {
        console.log(formatCloseReason(result.reason === "unknown" ? "relay_error" : result.reason));
        process.exitCode = 1;
        return;
      }
      console.log(`Room active · ${result.snapshot.participants.length} people`);
    });

  room.command("join")
    .description("join a Room using an invitation from its host")
    .option("--relay <url>", "relay URL")
    .action(async (opts: RoomJoinFlags) => {
      const relay = normalizeRelay(opts.relay ?? relayUrl());
      const result = await runRoomGuest({ relay });
      if (result.outcome === "closed") {
        console.log(formatCloseReason(result.reason === "unknown" ? "relay_error" : result.reason));
        process.exitCode = 1;
        return;
      }
      console.log(`Room active · ${result.snapshot.participants.length} people`);
    });
}
