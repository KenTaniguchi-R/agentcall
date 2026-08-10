import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { EncryptedCallRequest, MESSAGE_ID_RE, SHA256_HEX_RE } from "@benree/agentcall-shared";
import { withFileLock, type FileLockOptions } from "./file-lock.js";
import { assertPrivateFile, readJsonStore, writeJsonDurable } from "./json-store.js";
import type { Paths } from "./paths.js";

const MAX_OUTBOUND_JOBS = 1_000;

const OutboundJobSchema = z.object({
  message_id: z.string().regex(MESSAGE_ID_RE),
  relay: z.string().url(),
  address: z.string().min(1),
  frame: EncryptedCallRequest,
  request_id: z.string().regex(/^[0-9a-f]{32}$/),
  request_transcript_hash: z.string().regex(SHA256_HEX_RE),
  recipient_identity_pub: z.string().min(1),
  sender_epoch: z.number().int().positive(),
  created_at: z.number().int().nonnegative(),
  expires_at: z.number().int().positive(),
  state: z.enum(["pending", "queued"]).default("pending"),
  task_id: z.string().min(1).optional(),
  submitted_at: z.number().int().nonnegative().optional(),
}).strict().refine((job) => job.expires_at > job.created_at, {
  message: "outbound job must expire after creation",
});
export type OutboundJob = z.infer<typeof OutboundJobSchema>;

const OutboundJobsSchema = z.object({
  v: z.literal(1),
  jobs: z.array(OutboundJobSchema).max(MAX_OUTBOUND_JOBS),
}).strict().superRefine((store, ctx) => {
  const messages = new Set<string>();
  const tasks = new Set<string>();
  for (const job of store.jobs) {
    if (messages.has(job.message_id)) ctx.addIssue({ code: "custom", message: "duplicate message id" });
    messages.add(job.message_id);
    if (job.task_id) {
      if (tasks.has(job.task_id)) ctx.addIssue({ code: "custom", message: "duplicate task id" });
      tasks.add(job.task_id);
    }
  }
});

export function loadOutboundJobs(paths: Paths): OutboundJob[] {
  return readJsonStore(paths.outboundJobsFile, OutboundJobsSchema, {
    missing: () => ({ v: 1 as const, jobs: [] }),
    requirePrivate: { dir: paths.dir },
    corrupt: (detail) => { throw new Error(`Corrupt outbound job store at ${paths.outboundJobsFile}: ${detail}`); },
  }).jobs;
}

function prepareStore(paths: Paths): void {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  if (existsSync(paths.outboundJobsFile)) assertPrivateFile(paths.outboundJobsFile, { dir: paths.dir });
}

function save(paths: Paths, jobs: OutboundJob[]): void {
  writeJsonDurable(paths.outboundJobsFile, OutboundJobsSchema.parse({ v: 1, jobs }));
}

export async function rememberOutboundJob(
  paths: Paths,
  raw: Omit<OutboundJob, "state" | "task_id" | "submitted_at">,
  lockOptions: FileLockOptions = {},
): Promise<OutboundJob> {
  const candidate = OutboundJobSchema.parse({ ...raw, state: "pending" });
  prepareStore(paths);
  return withFileLock(paths.outboundJobsFile, "outbound job store", async () => {
    const jobs = loadOutboundJobs(paths).filter((job) => job.expires_at > candidate.created_at);
    const existing = jobs.find((job) => job.message_id === candidate.message_id);
    if (existing) {
      if (JSON.stringify(existing.frame) !== JSON.stringify(candidate.frame)) {
        throw new Error("Outbound message id is already bound to different ciphertext.");
      }
      return existing;
    }
    if (jobs.length >= MAX_OUTBOUND_JOBS) throw new Error("Outbound job store is full.");
    save(paths, [...jobs, candidate]);
    return candidate;
  }, lockOptions);
}

export async function acknowledgeOutboundJob(
  paths: Paths,
  messageId: string,
  receipt: { task_id: string; submitted_at: number; expires_at: number },
  lockOptions: FileLockOptions = {},
): Promise<OutboundJob> {
  prepareStore(paths);
  return withFileLock(paths.outboundJobsFile, "outbound job store", async () => {
    const jobs = loadOutboundJobs(paths);
    const index = jobs.findIndex((job) => job.message_id === messageId);
    if (index < 0) throw new Error("Durable receipt has no matching local outbound job.");
    const updated = OutboundJobSchema.parse({
      ...jobs[index], state: "queued", task_id: receipt.task_id,
      submitted_at: receipt.submitted_at, expires_at: receipt.expires_at,
    });
    jobs[index] = updated;
    save(paths, jobs);
    return updated;
  }, lockOptions);
}

export function findOutboundJob(paths: Paths, address: string, taskId: string): OutboundJob | undefined {
  return loadOutboundJobs(paths).find((job) => job.address === address && job.task_id === taskId);
}
