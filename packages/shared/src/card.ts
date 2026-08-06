import { z } from "zod";
import { AgentKindSchema, HANDLE_RE, TASK_ID_RE } from "./protocol.js";

export const MAX_CARD_TASKS = 50;
// MAX_CARD_GROUPS went with #379: it bounded `group_grants`, and there are no
// per-group grants on a card any more.
export const MAX_CARD_BLOCKED_CALLERS = 200;
export const MAX_TASK_KEYWORDS = 20;
export const MAX_KEYWORD_LENGTH = 40;

export const CardTask = z.object({
  id: z.string().regex(TASK_ID_RE),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  examples: z.array(z.string().max(500)).max(10),
  // Bounded per-string like every neighbouring field. Unbounded keyword
  // strings amplify: 20 per task x 50 tasks x 200 roster members, re-sent on
  // every bundle refresh. These are the highest-weighted field in
  // `agentcall search`, so they are the callee's precision lever.
  keywords: z.array(z.string().min(1).max(MAX_KEYWORD_LENGTH)).max(MAX_TASK_KEYWORDS),
}).strict();

// What a callee pushes to the relay: the full task list, plus the callers who
// get none of it.
//
// #379 removed `default_offer`, `grants`, and `group_grants`. Together they
// encoded a per-caller task menu, and a task is no longer individually
// granted: the callee decides at reply time whether an answer may reach a
// caller, from that caller's clearance and the sensitivity of whatever the
// task read. That decision is made locally and is deliberately never
// published — a clearance table is the owner's assessment of their own
// callers, which is the last thing that should be readable by them.
//
// `blocked` stays, for the same reason it stays in the CLI's policy: it is the
// one rule clearance cannot express as a level, and it is now the only
// per-caller distinction a card makes.
export const CardUpload = z.object({
  description: z.string().max(500),
  agent_kind: AgentKindSchema,
  tasks: z.array(CardTask).max(MAX_CARD_TASKS),
  blocked: z.array(z.string().regex(HANDLE_RE)).max(MAX_CARD_BLOCKED_CALLERS),
}).strict();

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

// The single visibility rule, all that is left of it after #379: a blocked
// viewer sees nothing, everyone else sees the whole task list. Lives here
// rather than in the relay route because two endpoints apply it — GET
// /v1/card/:handle and the roster bundle — and they must not drift.
//
// This is a deliberate reduction, not an oversight. The old menu doubled as
// information-hiding: a caller with no grant could not see that a task
// existed. Clearance has no equivalent, so task names and descriptions — all
// of them owner-authored advertisement copy, none of it derived from a
// labelled source — are now visible org-wide. Hiding a task's existence again
// would need its own mechanism.
export function visibleTasks(upload: CardUploadType, viewer: string): CardTaskType[] {
  return upload.blocked.includes(viewer) ? [] : upload.tasks;
}
