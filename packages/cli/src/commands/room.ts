import type { Command } from "commander";
import { normalizeRelay, relayUrl } from "../config.js";
import { runRoomHost } from "../room-host.js";
import { runRoomGuest } from "../room-guest.js";
import { formatCloseReason } from "../room-render.js";

interface RoomHostFlags {
  seats: string;
  relay?: string;
  name?: string;
}

interface RoomJoinFlags {
  relay?: string;
}

export function register(program: Command): void {
  const room = program.command("room")
    .description("host a temporary, accountless group Room — no account, handle, or listener required")
    .option("--seats <n>", "Room size including you (2-6)", "2")
    .option("--relay <url>", "relay URL")
    .option("--name <name>", "your display name in this Room")
    .action(async (opts: RoomHostFlags) => {
      const seats = Number.parseInt(opts.seats, 10);
      if (!Number.isInteger(seats) || seats < 2 || seats > 6) {
        console.error("--seats must be an integer between 2 and 6.");
        process.exitCode = 1;
        return;
      }
      const relay = normalizeRelay(opts.relay ?? relayUrl());
      const result = await runRoomHost({ seats, relay, displayName: opts.name });
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
