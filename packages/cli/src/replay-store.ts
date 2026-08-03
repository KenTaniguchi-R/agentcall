import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { RELAY_CALL_TIMEOUT_MS } from "@benree/agentcall-shared";
import { withFileLock, type FileLockOptions } from "./file-lock.js";
import { writeJsonAtomic } from "./json-store.js";
import type { MachinePaths } from "./paths.js";

export const MAX_REPLAY_RESERVATIONS = 10_000;
export const REPLAY_RETENTION_SKEW_MS = 120_000;
const MAX_RESERVATION_FUTURE_MS = RELAY_CALL_TIMEOUT_MS + REPLAY_RETENTION_SKEW_MS;

const ReplayReservationSchema = z.object({
  sender_fingerprint: z.string().regex(/^SHA256:[0-9a-f]{32}$/),
  request_id: z.string().regex(/^[0-9a-f]{32}$/),
  expires_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - REPLAY_RETENTION_SKEW_MS),
}).strict();
export type ReplayReservation = z.infer<typeof ReplayReservationSchema>;

const ReplayStoreSchema = z.object({
  v: z.literal(1),
  reservations: z.array(ReplayReservationSchema).max(MAX_REPLAY_RESERVATIONS),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const reservation of value.reservations) {
    const key = `${reservation.sender_fingerprint}:${reservation.request_id}`;
    if (seen.has(key)) ctx.addIssue({ code: "custom", message: "duplicate replay reservation" });
    seen.add(key);
  }
});

export class ReplayDetectedError extends Error {
  constructor() {
    super("Encrypted request was already processed.");
    this.name = "ReplayDetectedError";
  }
}

function assertStorePermissions(machine: MachinePaths): void {
  if (!existsSync(machine.replayReservationsFile)) return;
  const dirMode = statSync(machine.dir).mode & 0o777;
  if (dirMode !== 0o700) {
    throw new Error(`${machine.dir} has permission ${dirMode.toString(8)}; expected 700. Run: chmod 700 ${machine.dir}`);
  }
  const mode = statSync(machine.replayReservationsFile).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`${machine.replayReservationsFile} has permission ${mode.toString(8)}; expected 600. Run: chmod 600 ${machine.replayReservationsFile}`);
  }
}

export function loadReplayReservations(machine: MachinePaths): ReplayReservation[] {
  if (!existsSync(machine.replayReservationsFile)) return [];
  assertStorePermissions(machine);
  try {
    return ReplayStoreSchema.parse(JSON.parse(readFileSync(machine.replayReservationsFile, "utf8"))).reservations;
  } catch (error) {
    throw new Error(
      `Corrupt replay-reservation store at ${machine.replayReservationsFile}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function saveReplayReservations(machine: MachinePaths, reservations: ReplayReservation[]): void {
  writeJsonAtomic(machine.replayReservationsFile, ReplayStoreSchema.parse({ v: 1, reservations }));
  chmodSync(machine.dir, 0o700);
}

export async function reserveReplay(
  machine: MachinePaths,
  rawReservation: ReplayReservation,
  now = Date.now(),
  lockOptions: FileLockOptions = {},
): Promise<ReplayReservation> {
  const reservation = ReplayReservationSchema.parse(rawReservation);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Replay reservation time must be a non-negative safe integer.");
  if (reservation.expires_at <= now || reservation.expires_at > now + MAX_RESERVATION_FUTURE_MS) {
    throw new Error("Replay reservation expiry must be in the bounded future.");
  }

  if (existsSync(machine.replayReservationsFile)) {
    assertStorePermissions(machine);
  } else {
    mkdirSync(machine.dir, { recursive: true, mode: 0o700 });
    chmodSync(machine.dir, 0o700);
  }

  return withFileLock(machine.replayReservationsFile, "replay-reservation store", async () => {
    const live = loadReplayReservations(machine)
      .filter((entry) => now < entry.expires_at + REPLAY_RETENTION_SKEW_MS);
    if (live.some((entry) => (
      entry.sender_fingerprint === reservation.sender_fingerprint && entry.request_id === reservation.request_id
    ))) throw new ReplayDetectedError();
    if (live.length >= MAX_REPLAY_RESERVATIONS) {
      throw new Error(`Replay-reservation store is full (${MAX_REPLAY_RESERVATIONS} live entries); refusing the request.`);
    }
    const next = [...live, reservation].sort((a, b) => (
      a.expires_at - b.expires_at || a.sender_fingerprint.localeCompare(b.sender_fingerprint) ||
      a.request_id.localeCompare(b.request_id)
    ));
    saveReplayReservations(machine, next);
    return reservation;
  }, lockOptions);
}
