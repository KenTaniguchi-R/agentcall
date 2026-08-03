import { z } from "zod";
import { AgentKindSchema, HANDLE_RE, TASK_ID_RE } from "./protocol.js";

export const MAX_CARD_TASKS = 50;
export const MAX_CARD_GROUPS = 50;
export const MAX_CARD_BLOCKED_CALLERS = 200;
export const MAX_TASK_KEYWORDS = 20;
export const MAX_KEYWORD_LENGTH = 40;

// A `tier` field ("T1" | "T2") used to ride along here, reserving T2 for
// approval-gated tasks. No code ever branched on it and the approval gate is
// not being built, so it's gone. Zod strips unknown keys, so cards already
// stored on the relay with a tier still parse.
export const CardTask = z.object({
  id: z.string().regex(TASK_ID_RE),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  examples: z.array(z.string().max(500)).max(10).default([]),
  // Bounded per-string like every neighbouring field. Unbounded keyword
  // strings amplify: 20 per task x 50 tasks x 200 roster members, re-sent on
  // every bundle refresh. These are the highest-weighted field in
  // `agentcall search`, so they are the callee's precision lever.
  keywords: z.array(z.string().min(1).max(MAX_KEYWORD_LENGTH)).max(MAX_TASK_KEYWORDS).default([]),
});

// What a callee pushes to the relay: full task list + visibility policy.
export const CardUpload = z.object({
  description: z.string().max(500).default(""),
  agent_kind: AgentKindSchema,
  tasks: z.array(CardTask).max(MAX_CARD_TASKS),
  default_offer: z.array(z.string().regex(TASK_ID_RE)).max(MAX_CARD_TASKS),
  grants: z.record(z.string().regex(HANDLE_RE), z.array(z.string().regex(TASK_ID_RE)).max(MAX_CARD_TASKS)).default({}),
  group_grants: z.record(
    // Same opaque relay-issued id shape as ROSTER_ID_RE. Kept inline to avoid
    // a card -> roster -> card runtime import cycle.
    z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), z.array(z.string().regex(TASK_ID_RE)).max(MAX_CARD_TASKS),
  ).refine((groups) => Object.keys(groups).length <= MAX_CARD_GROUPS, {
    message: `at most ${MAX_CARD_GROUPS} group grants`,
  }).default({}),
  blocked: z.array(z.string().regex(HANDLE_RE)).max(MAX_CARD_BLOCKED_CALLERS).default([]),
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

// The single visibility rule: a viewer sees default_offer plus their own
// grants, never the full ACL. Lives here rather than in the relay route
// because two endpoints now apply it — GET /v1/card/:handle and the roster
// bundle — and they must not drift.
//
// Own-property check, not a bare lookup: `grants` is a zod z.record object
// that inherits Object.prototype, and HANDLE_RE accepts "constructor" — so
// `grants[viewer]` would hand back the Object constructor (not iterable,
// 500s the endpoint) for a viewer with that handle, against every callee.
export function visibleTasks(
  upload: CardUploadType, viewer: string, attestedGroups: readonly string[] = [],
): CardTaskType[] {
  if (upload.blocked.includes(viewer)) return [];
  const granted = viewer && Object.hasOwn(upload.grants, viewer) ? upload.grants[viewer]! : [];
  const groupGranted = attestedGroups.flatMap(
    (group) => Object.hasOwn(upload.group_grants, group) ? upload.group_grants[group]! : [],
  );
  const visible = new Set([...upload.default_offer, ...granted, ...groupGranted]);
  return upload.tasks.filter((t) => visible.has(t.id));
}
