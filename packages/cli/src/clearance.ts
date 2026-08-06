// The clearance half of #372: who may receive what, independent of what any
// particular source contains. Sensitivity — how sensitive a source is — lives
// in sensitivity.ts.
//
// This replaces policy.ts's task-menu machinery (`default_offer`, per-caller
// `offer`, the derived menu). A task no longer has to be individually granted:
// it declares which sources it reads, and clearance decides whether the result
// may reach this caller. One question instead of two lists.
import { z } from "zod";
import { ROSTER_ID_RE } from "@benree/agentcall-shared";
import type { Sensitivity } from "./sensitivity.js";

const GROUP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// `secret` is deliberately absent. It means "never leaves this machine", so a
// grantable `secret` would turn the top of the lattice into a bypass any policy
// edit could hand out. sensitivity.ts's `permits` refuses secret content
// regardless; excluding it here makes the invariant structural rather than
// merely enforced downstream.
const GrantableClearance = z.enum(["public", "internal"]);

export const DEFAULT_CLEARANCE: Sensitivity = "public";

const CallerClearanceSchema = z.object({
  clearance: GrantableClearance.optional(),
  block: z.boolean().default(false),
}).strict();

const GroupClearanceSchema = z.object({
  roster_id: z.string().regex(ROSTER_ID_RE),
  clearance: GrantableClearance.optional(),
}).strict();

export const ClearancePolicySchema = z.object({
  description: z.string().max(500).default(""),
  default_clearance: GrantableClearance.default("public"),
  callers: z.record(z.string(), CallerClearanceSchema).default({}),
  groups: z.record(z.string().regex(GROUP_NAME_RE), GroupClearanceSchema).default({}),
}).strict();

export type ClearancePolicy = z.infer<typeof ClearancePolicySchema>;

const RANK: Record<Sensitivity, number> = { public: 0, internal: 1, secret: 2 };

// `policy.callers` comes from JSON.parse + z.record, whose output inherits
// Object.prototype — and a handle pattern happily accepts "constructor". A bare
// `callers[handle]` therefore resolves to the Object constructor for any policy
// that does not define that key, which reads as a caller entry that isn't
// there. Same trap policy.ts:161-171 records; every lookup goes through here.
function ownEntry<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Resolve what this caller may receive.
 *
 * Runs on the relay-verified `from` and local files only, BEFORE the caller's
 * message reaches any prompt — the CaMeL invariant `policy.ts:217-219` records.
 * The message cannot influence clearance.
 *
 * `attestedGroups` are roster ids the relay vouched for. A caller-supplied
 * claim must never reach this parameter.
 */
export function clearanceFor(
  policy: ClearancePolicy,
  from: string,
  attestedGroups: readonly string[] = [],
): Sensitivity | "blocked" {
  const entry = ownEntry(policy.callers, from);
  // Individual denial is the strongest rule. Group membership can expand a
  // clearance, never resurrect a caller the owner explicitly blocked.
  if (entry?.block) return "blocked";

  const grants: Sensitivity[] = [policy.default_clearance];
  if (entry?.clearance) grants.push(entry.clearance);

  const attested = new Set(attestedGroups);
  for (const group of Object.values(policy.groups)) {
    if (!attested.has(group.roster_id)) continue;
    if (group.clearance) grants.push(group.clearance);
  }

  // Most permissive applicable grant. Unlike sensitivity, which combines toward
  // the most restrictive, clearance is a union of what the owner has decided
  // this caller may see.
  return grants.reduce((acc, g) => (RANK[g] > RANK[acc] ? g : acc), "public" as Sensitivity);
}
