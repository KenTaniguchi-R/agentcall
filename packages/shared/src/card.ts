import { z } from "zod";
import { AgentKindSchema, HANDLE_RE, TASK_ID_RE } from "./protocol.js";

export const MAX_CARD_TASKS = 50;

// A `tier` field ("T1" | "T2") used to ride along here, reserving T2 for
// approval-gated tasks. No code ever branched on it and the approval gate is
// not being built, so it's gone. Zod strips unknown keys, so cards already
// stored on the relay with a tier still parse.
export const CardTask = z.object({
  id: z.string().regex(TASK_ID_RE),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  examples: z.array(z.string().max(500)).max(10).default([]),
});

// What a callee pushes to the relay: full task list + visibility policy.
export const CardUpload = z.object({
  description: z.string().max(500).default(""),
  agent_kind: AgentKindSchema,
  tasks: z.array(CardTask).max(MAX_CARD_TASKS),
  default_offer: z.array(z.string().regex(TASK_ID_RE)).max(MAX_CARD_TASKS),
  grants: z.record(z.string().regex(HANDLE_RE), z.array(z.string().regex(TASK_ID_RE)).max(MAX_CARD_TASKS)).default({}),
});

// What a caller gets back from GET /v1/card/:handle — already filtered to
// the tasks visible to that caller (public view or authenticated extended view).
export const AgentCard = z.object({
  handle: z.string().regex(HANDLE_RE),
  description: z.string(),
  agent_kind: AgentKindSchema,
  tasks: z.array(CardTask),
  updated_at: z.number(),
});

export type CardTaskType = z.infer<typeof CardTask>;
export type CardUploadType = z.infer<typeof CardUpload>;
export type AgentCardType = z.infer<typeof AgentCard>;
