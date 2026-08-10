import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { MAILBOX_TOMBSTONE_TTL_MS, MAILBOX_TTL_MS, SHA256_HEX_RE } from "@benree/agentcall-shared";
import { withFileLock, type FileLockOptions } from "./file-lock.js";
import { assertPrivateFile, readJsonStore, writeJsonDurable } from "./json-store.js";
import type { Paths } from "./paths.js";

const MAX_EXECUTION_RECORDS = 1_000;

export function executionEnvelopeDigest(envelope: unknown): string {
  return createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
}
const ExecutionRecordSchema = z.object({
  call_id: z.string().min(1),
  request_envelope_sha256: z.string().regex(SHA256_HEX_RE),
  state: z.enum(["claimed", "started", "terminal"]),
  updated_at: z.number().int().nonnegative(),
  purge_after: z.number().int().positive(),
}).strict();
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

const ExecutionJournalSchema = z.object({
  v: z.literal(1), records: z.array(ExecutionRecordSchema).max(MAX_EXECUTION_RECORDS),
}).strict().superRefine((journal, ctx) => {
  const seen = new Set<string>();
  for (const record of journal.records) {
    if (seen.has(record.call_id)) ctx.addIssue({ code: "custom", message: "duplicate call id" });
    seen.add(record.call_id);
  }
});

export function loadExecutionJournal(paths: Paths): ExecutionRecord[] {
  return readJsonStore(paths.executionJournalFile, ExecutionJournalSchema, {
    missing: () => ({ v: 1 as const, records: [] }),
    requirePrivate: { dir: paths.dir },
    corrupt: (detail) => { throw new Error(`Corrupt execution journal at ${paths.executionJournalFile}: ${detail}`); },
  }).records;
}

function prepare(paths: Paths): void {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  if (existsSync(paths.executionJournalFile)) {
    assertPrivateFile(paths.executionJournalFile, { dir: paths.dir });
  }
}

function save(paths: Paths, records: ExecutionRecord[]): void {
  writeJsonDurable(paths.executionJournalFile, ExecutionJournalSchema.parse({ v: 1, records }));
}

type ClaimDecision = {
  decision: "execute" | "conflict" | "indeterminate" | "terminal";
  state: ExecutionRecord["state"];
};

export async function claimExecution(
  paths: Paths, callId: string, digest: string, now = Date.now(), lockOptions: FileLockOptions = {},
): Promise<ClaimDecision> {
  ExecutionRecordSchema.pick({ call_id: true, request_envelope_sha256: true }).parse({
    call_id: callId, request_envelope_sha256: digest,
  });
  prepare(paths);
  return withFileLock(paths.executionJournalFile, "execution journal", async () => {
    const records = loadExecutionJournal(paths).filter((record) => now < record.purge_after);
    const existing = records.find((record) => record.call_id === callId);
    if (existing) {
      if (existing.request_envelope_sha256 !== digest) return { decision: "conflict", state: existing.state };
      if (existing.state === "claimed") return { decision: "execute", state: "claimed" };
      if (existing.state === "started") return { decision: "indeterminate", state: "started" };
      return { decision: "terminal", state: "terminal" };
    }
    if (records.length >= MAX_EXECUTION_RECORDS) throw new Error("Execution journal is full.");
    records.push(ExecutionRecordSchema.parse({
      call_id: callId, request_envelope_sha256: digest, state: "claimed", updated_at: now,
      purge_after: now + MAILBOX_TTL_MS + MAILBOX_TOMBSTONE_TTL_MS,
    }));
    save(paths, records);
    return { decision: "execute", state: "claimed" };
  }, lockOptions);
}

async function transition(
  paths: Paths, callId: string, digest: string, target: "started" | "terminal", now: number,
  lockOptions: FileLockOptions,
): Promise<void> {
  prepare(paths);
  await withFileLock(paths.executionJournalFile, "execution journal", async () => {
    const records = loadExecutionJournal(paths);
    const index = records.findIndex((record) => record.call_id === callId);
    if (index < 0) throw new Error("Execution journal record is missing.");
    const record = records[index]!;
    if (record.request_envelope_sha256 !== digest) throw new Error("Execution journal ciphertext conflict.");
    if (target === "started" && record.state !== "claimed") {
      throw new Error(`Cannot mark ${record.state} execution as started.`);
    }
    if (target === "terminal" && record.state === "terminal") {
      throw new Error(`Cannot mark ${record.state} execution as terminal.`);
    }
    records[index] = { ...record, state: target, updated_at: now };
    save(paths, records);
  }, lockOptions);
}

export async function markExecutionStarted(
  paths: Paths, callId: string, digest: string, now = Date.now(), lockOptions: FileLockOptions = {},
): Promise<void> {
  await transition(paths, callId, digest, "started", now, lockOptions);
}

export async function markExecutionTerminal(
  paths: Paths, callId: string, digest: string, now = Date.now(), lockOptions: FileLockOptions = {},
): Promise<void> {
  await transition(paths, callId, digest, "terminal", now, lockOptions);
}
