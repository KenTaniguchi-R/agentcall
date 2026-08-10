import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../src/json-store.js";
import { getPaths, type Paths } from "../src/paths.js";
import {
  MAX_REPLAY_RESERVATIONS, REPLAY_RETENTION_SKEW_MS, ReplayDetectedError,
  loadReplayReservations, reserveReplay,
} from "../src/replay-store.js";

const NOW = 1_800_000_000_000;
const FINGERPRINT = `SHA256:${"a".repeat(32)}`;
const REQUEST_ID = "1".repeat(32);
let root: string;
let machine: Paths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentcall-replay-"));
  machine = getPaths(root, root);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

const input = (over: Partial<{ sender_fingerprint: string; request_id: string; expires_at: number }> = {}) => ({
  sender_fingerprint: FINGERPRINT,
  request_id: REQUEST_ID,
  expires_at: NOW + 1_000,
  ...over,
});

describe("persistent E2EE replay reservations", () => {
  it("survives restart and rejects a duplicate without mutating the store", async () => {
    await reserveReplay(machine, input(), NOW);
    const before = readFileSync(machine.replayReservationsFile, "utf8");
    const restarted = getPaths(root, root);
    await expect(reserveReplay(restarted, input(), NOW)).rejects.toBeInstanceOf(ReplayDetectedError);
    expect(readFileSync(machine.replayReservationsFile, "utf8")).toBe(before);
    expect(statSync(machine.dir).mode & 0o777).toBe(0o700);
    expect(statSync(machine.replayReservationsFile).mode & 0o777).toBe(0o600);
  });

  it("gives concurrent processes exactly one winner", async () => {
    const replayModule = new URL("../dist/replay-store.js", import.meta.url).href;
    const pathsModule = new URL("../dist/paths.js", import.meta.url).href;
    const script = `
      const [{ reserveReplay }, { getPaths }] = await Promise.all([
        import(process.argv[1]), import(process.argv[2]),
      ]);
      try {
        await reserveReplay(getPaths(process.argv[3], process.argv[3]), {
          sender_fingerprint: process.argv[4], request_id: process.argv[5], expires_at: Number(process.argv[6]),
        }, Number(process.argv[7]));
        process.exit(0);
      } catch (error) {
        process.exit(error?.name === "ReplayDetectedError" ? 2 : 1);
      }
    `;
    const run = () => new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [
        "--input-type=module", "-e", script, replayModule, pathsModule, root,
        FINGERPRINT, REQUEST_ID, String(NOW + 1_000), String(NOW),
      ]);
      child.once("exit", resolve);
    });
    expect((await Promise.all([run(), run()])).sort()).toEqual([0, 2]);
    expect(loadReplayReservations(machine)).toHaveLength(1);
  });

  it("prunes only reservations past authenticated expiry plus skew", async () => {
    writeJsonAtomic(machine.replayReservationsFile, { v: 1, reservations: [
      input({ request_id: "2".repeat(32), expires_at: NOW - REPLAY_RETENTION_SKEW_MS }),
      input({ request_id: "3".repeat(32), expires_at: NOW - REPLAY_RETENTION_SKEW_MS + 1 }),
    ] });
    await reserveReplay(machine, input(), NOW);
    expect(loadReplayReservations(machine).map((entry) => entry.request_id).sort()).toEqual([
      REQUEST_ID, "3".repeat(32),
    ].sort());
  });

  it("fails closed instead of evicting a live reservation when full", async () => {
    writeJsonAtomic(machine.replayReservationsFile, { v: 1, reservations: Array.from(
      { length: MAX_REPLAY_RESERVATIONS }, (_, index) => input({ request_id: index.toString(16).padStart(32, "0") }),
    ) });
    const before = readFileSync(machine.replayReservationsFile, "utf8");
    await expect(reserveReplay(machine, input({ request_id: "f".repeat(32) }), NOW)).rejects.toThrow(/full/);
    expect(readFileSync(machine.replayReservationsFile, "utf8")).toBe(before);
  });

  it("fails closed on corrupt state, unsafe permissions, and invalid identifiers", async () => {
    writeJsonAtomic(machine.replayReservationsFile, { v: 1, reservations: [] });
    writeFileSync(machine.replayReservationsFile, "not json");
    await expect(reserveReplay(machine, input(), NOW)).rejects.toThrow(/Corrupt replay/);

    writeJsonAtomic(machine.replayReservationsFile, { v: 1, reservations: [] });
    chmodSync(machine.replayReservationsFile, 0o644);
    await expect(reserveReplay(machine, input(), NOW)).rejects.toThrow(/expected 600/);

    chmodSync(machine.replayReservationsFile, 0o600);
    await expect(reserveReplay(machine, input({ request_id: "not-an-id" }), NOW)).rejects.toThrow();
    await expect(reserveReplay(machine, input({ sender_fingerprint: "bad" }), NOW)).rejects.toThrow();
    await expect(reserveReplay(machine, input({ expires_at: NOW }), NOW)).rejects.toThrow(/future/);
  });

  it("times out on a contested lock without removing or mutating it", async () => {
    writeJsonAtomic(machine.replayReservationsFile, { v: 1, reservations: [] });
    const lockFile = `${machine.replayReservationsFile}.lock`;
    writeFileSync(lockFile, "other-owner", { mode: 0o600 });
    vi.useFakeTimers();
    const reservation = reserveReplay(machine, input(), NOW, { waitMs: 20, retryMs: 5 });
    const rejection = expect(reservation).rejects.toThrow(/Timed out waiting/);
    await vi.advanceTimersByTimeAsync(21);
    await rejection;
    expect(readFileSync(lockFile, "utf8")).toBe("other-owner");
    expect(loadReplayReservations(machine)).toEqual([]);
  });
});
