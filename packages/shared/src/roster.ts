import { z } from "zod";
import { HANDLE_RE, TASK_ID_RE } from "./protocol.js";
import { MAX_TASK_KEYWORDS, MAX_KEYWORD_LENGTH } from "./card.js";

// A roster id is relay-generated and opaque. Deliberately NOT a memorable
// name: on a shared multi-tenant relay a global name like "acme" would be
// first-come-first-served squattable and would imply an affiliation that
// nothing verified. Display names are local-only, in the CLI's rosters.json.
//
// The id is unguessable but is NOT a secret — it travels in URL paths and
// will land in relay logs. The join key is a separate value, which is why
// sharing an id does not grant the ability to join.
export const ROSTER_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const ROSTER_JOIN_KEY_PREFIX_RE = /^[a-f0-9]{12}$/;
export const ROSTER_JOIN_KEY_RE = /^agjk_[a-f0-9]{12}_[A-Za-z0-9_-]{32,128}$/;

export const MAX_ROSTER_MEMBERS = 200;
export const MAX_ACTIVE_ROSTER_JOIN_KEYS = 100;
export const MAX_LISTED_ROSTER_JOIN_KEYS = 200;
export const MAX_ROSTER_JOIN_KEY_DESCRIPTION = 100;
export const DEFAULT_ROSTER_JOIN_KEY_EXPIRY_DAYS = 30;
export const MAX_ROSTER_JOIN_KEY_EXPIRY_DAYS = 90;
export const MAX_BUNDLE_TASKS_PER_CARD = 10;
// Design ceiling asserted by test (see test/roster.test.ts), NOT a runtime
// truncation. The caps that bind at runtime are MAX_ROSTER_MEMBERS (at join)
// and MAX_BUNDLE_TASKS_PER_CARD (at projection).
export const MAX_BUNDLE_BYTES = 4_500_000;

export const CreateRosterResponse = z.object({
  roster_id: z.string().regex(ROSTER_ID_RE),
  join_key: z.string().regex(ROSTER_JOIN_KEY_RE),
  admin_secret: z.string().min(1),
});

export const JoinRosterRequest = z.object({
  join_key: z.string().regex(ROSTER_JOIN_KEY_RE),
});

export const AdminSecretRequest = z.object({
  admin_secret: z.string().min(1).max(200),
});

export const ExpelRosterRequest = AdminSecretRequest.extend({
  handle: z.string().regex(HANDLE_RE),
});

export const IssueRosterJoinKeyRequest = AdminSecretRequest.extend({
  description: z.string().max(MAX_ROSTER_JOIN_KEY_DESCRIPTION).optional().default(""),
  expires_in_days: z.number().int().min(1).max(MAX_ROSTER_JOIN_KEY_EXPIRY_DAYS)
    .optional().default(DEFAULT_ROSTER_JOIN_KEY_EXPIRY_DAYS),
  reusable: z.boolean().optional().default(false),
});

export const RosterJoinKeyMetadata = z.object({
  prefix: z.string().regex(ROSTER_JOIN_KEY_PREFIX_RE),
  description: z.string().max(MAX_ROSTER_JOIN_KEY_DESCRIPTION),
  created_by: z.string().regex(HANDLE_RE),
  created_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  reusable: z.boolean(),
  used: z.boolean(),
  revoked_at: z.number().int().nonnegative().nullable(),
});

export const IssueRosterJoinKeyResponse = z.object({
  join_key: z.string().regex(ROSTER_JOIN_KEY_RE),
  key: RosterJoinKeyMetadata,
});

export const ListRosterJoinKeysResponse = z.object({
  keys: z.array(RosterJoinKeyMetadata).max(MAX_LISTED_ROSTER_JOIN_KEYS),
});

export const RevokeRosterJoinKeyRequest = AdminSecretRequest.extend({
  prefix: z.string().regex(ROSTER_JOIN_KEY_PREFIX_RE),
  evict: z.boolean().optional().default(false),
});

export const RevokeRosterJoinKeyResponse = z.object({
  prefix: z.string().regex(ROSTER_JOIN_KEY_PREFIX_RE),
  revoked_at: z.number().int().nonnegative(),
  evicted: z.number().int().nonnegative(),
});

// The search projection of a card task. `examples` are deliberately absent:
// at up to 5KB per task they are the largest thing a bundle would carry, and
// they are display detail available from `agentcall card <address>` once you
// know who to look up. If recall proves weak, the answer is `keywords` — a
// field the callee controls at 40 bytes a term — not re-shipping prose.
export const BundleTask = z.object({
  id: z.string().regex(TASK_ID_RE),
  name: z.string().max(100),
  description: z.string().max(1000),
  keywords: z.array(z.string().max(MAX_KEYWORD_LENGTH)).max(MAX_TASK_KEYWORDS),
}).strict();

export const BundleEntry = z.object({
  handle: z.string().regex(HANDLE_RE),
  agent_kind: z.enum(["claude", "codex"]),
  tasks: z.array(BundleTask).max(MAX_BUNDLE_TASKS_PER_CARD),
  updated_at: z.number(),
  // True when the member had more tasks than MAX_BUNDLE_TASKS_PER_CARD. The
  // bundle never truncates silently: search surfaces this to the user.
  truncated: z.boolean(),
}).strict();

export const RosterBundle = z.object({
  roster_id: z.string().regex(ROSTER_ID_RE),
  entries: z.array(BundleEntry).max(MAX_ROSTER_MEMBERS),
  // Count of member cards that failed to parse and were skipped.
  skipped: z.number().int().nonnegative(),
}).strict();

export type BundleEntryType = z.infer<typeof BundleEntry>;
export type RosterBundleType = z.infer<typeof RosterBundle>;
export type RosterJoinKeyMetadataType = z.infer<typeof RosterJoinKeyMetadata>;
